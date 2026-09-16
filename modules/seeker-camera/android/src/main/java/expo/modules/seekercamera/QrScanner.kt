package expo.modules.seekercamera

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.util.Size
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * QR scanning for the Collection tab: read a collect link off another phone's screen or a card.
 *
 * Route: the BUNDLED ML Kit barcode model (`com.google.mlkit:barcode-scanning`), driven by CameraX,
 * inside this dedicated Activity — not the Google code scanner
 * (`com.google.android.gms:play-services-code-scanner`), which is a system UI served by Google Play
 * services. No Solana Mobile document says the Seeker ships Play services, so the scanner carries
 * its own model and its own camera.
 *
 * Camera confinement: this Activity binds the back camera itself, and `CameraController` owns camera
 * "0" for as long as a `SeekerCameraView` is mounted. Two owners cannot share it, so `scanQrCode`
 * refuses while a camera view is up (see `SeekerCameraModule`). The Collection tab, the only caller,
 * has none mounted.
 *
 * Permission: `android.permission.CAMERA`, already declared in app.json for the capture screen.
 * The scanner may run before the person has ever opened the camera, so it asks for the grant itself
 * and ends with a readable message if it is refused. Neither the CameraX nor the ML Kit AARs declare
 * a permission of their own, so app.json and `scripts/check-prebuild.ts` are untouched, and ML Kit
 * ships its own consumer ProGuard rules, so `extraProguardRules` needs nothing either.
 */
internal object QrScanner {
  /** `startActivityForResult` request code; 16-bit, as the framework requires. */
  const val REQUEST_CODE = 0x5EED

  const val EXTRA_VALUE = "expo.modules.seekercamera.QR_VALUE"
  const val EXTRA_ERROR = "expo.modules.seekercamera.QR_ERROR"

  /**
   * Result code for "the scan could not happen at all" — no camera, no grant, model refused. The
   * promise rejects with `EXTRA_ERROR`; `RESULT_CANCELED` stays the person's own back-out.
   */
  const val RESULT_UNAVAILABLE = android.app.Activity.RESULT_FIRST_USER

  /**
   * A local sanity bound, not a format claim: a QR symbol tops out near this many characters, and
   * a decoded value longer than it is not a collect link. Keeps a hostile symbol from handing JS an
   * unbounded string.
   */
  const val MAX_VALUE_CHARS = 4296

  fun intent(context: Context): Intent = Intent(context, QrScannerActivity::class.java)

  /**
   * The one result worth returning from a frame: a QR code (never one of the other twelve formats
   * ML Kit can decode) carrying a non-blank value of workable length. Pure — unit-tested by
   * `QrScannerValueTest`.
   */
  fun acceptedQrValue(format: Int, rawValue: String?): String? {
    if (format != Barcode.FORMAT_QR_CODE) return null
    val value = rawValue ?: return null
    if (value.isBlank()) return null
    if (value.length > MAX_VALUE_CHARS) return null
    return value
  }
}

/**
 * Full-screen scanner. Resolves through `setResult`: `RESULT_OK` + `EXTRA_VALUE` for a code,
 * `RESULT_CANCELED` for a back-out, `QrScanner.RESULT_UNAVAILABLE` + `EXTRA_ERROR` for a sentence
 * the UI can show. Declared in the module's `AndroidManifest.xml`, never exported.
 */
class QrScannerActivity : AppCompatActivity() {
  companion object {
    private const val TAG = "SeekerCamQr"
    private const val PERMISSION_REQUEST = 0x5EEE
    /**
     * Analysis frame size asked of CameraX. 1280x720 reads a QR shown on another phone's screen at
     * arm's length; the default analysis size (640x480) often does not.
     * https://developer.android.com/media/camera/camerax/analyze
     */
    private val ANALYSIS_SIZE = Size(1280, 720)
  }

  private lateinit var previewView: PreviewView
  private lateinit var analysisExecutor: ExecutorService
  private var scanner: BarcodeScanner? = null
  private var cameraProvider: ProcessCameraProvider? = null

  /** One result only: every finish path goes through this, so a late frame cannot re-finish. */
  private val settled = AtomicBoolean(false)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(buildUi())

    // Single thread: ML Kit is handed one frame at a time and STRATEGY_KEEP_ONLY_LATEST drops the
    // rest, so a slow decode cannot queue frames up behind it.
    analysisExecutor = Executors.newSingleThreadExecutor { r ->
      Thread(r, "SeekerCamQrAnalysis").apply { isDaemon = true }
    }

    // QR only. https://developers.google.com/ml-kit/vision/barcode-scanning/android
    scanner = try {
      BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build(),
      )
    } catch (e: Throwable) {
      Log.e(TAG, "ML Kit barcode client refused", e)
      finishUnavailable("QR scanning is unavailable on this device.")
      return
    }

    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
      startCamera()
    } else {
      requestPermissions(arrayOf(Manifest.permission.CAMERA), PERMISSION_REQUEST)
    }
  }

  /** Built in code: the module ships no layout resources, and this screen is a preview and two labels. */
  private fun buildUi(): ViewGroup {
    val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

    previewView = PreviewView(this).apply {
      scaleType = PreviewView.ScaleType.FILL_CENTER
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      )
    }
    root.addView(previewView)

    val hint = TextView(this).apply {
      text = "Point the camera at the QR code"
      setTextColor(Color.WHITE)
      setShadowLayer(6f, 0f, 0f, Color.BLACK)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
      setPadding(dp(24), dp(48), dp(24), dp(24))
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        Gravity.TOP or Gravity.CENTER_HORIZONTAL,
      )
      gravity = Gravity.CENTER_HORIZONTAL
    }
    root.addView(hint)

    val cancel = Button(this).apply {
      text = "Cancel"
      setOnClickListener { finishCancelled() }
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL,
      ).apply { bottomMargin = dp(48) }
    }
    root.addView(cancel)

    return root
  }

  private fun dp(value: Int): Int =
    (value * resources.displayMetrics.density).toInt()

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != PERMISSION_REQUEST) return
    if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
      startCamera()
    } else {
      finishUnavailable("Seedshot needs camera access to scan a QR code.")
    }
  }

  private fun startCamera() {
    // ProcessCameraProvider.getInstance is async; the listener runs on the main thread because the
    // use cases below must be bound there.
    val future = ProcessCameraProvider.getInstance(this)
    future.addListener({
      val provider = try {
        future.get()
      } catch (e: Throwable) {
        Log.e(TAG, "no camera provider", e)
        finishUnavailable("The camera could not be opened for scanning.")
        return@addListener
      }
      cameraProvider = provider
      bind(provider)
    }, ContextCompat.getMainExecutor(this))
  }

  private fun bind(provider: ProcessCameraProvider) {
    if (settled.get()) return

    val selector = CameraSelector.DEFAULT_BACK_CAMERA
    val hasBack = try {
      provider.hasCamera(selector)
    } catch (e: Throwable) {
      Log.e(TAG, "camera query failed", e)
      false
    }
    if (!hasBack) {
      finishUnavailable("This device has no back camera to scan with.")
      return
    }

    val preview = Preview.Builder().build()
    preview.setSurfaceProvider(previewView.surfaceProvider)

    val analysis = ImageAnalysis.Builder()
      .setResolutionSelector(
        ResolutionSelector.Builder()
          .setResolutionStrategy(
            ResolutionStrategy(ANALYSIS_SIZE, ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER),
          )
          .build(),
      )
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .build()
    analysis.setAnalyzer(analysisExecutor, ImageAnalysis.Analyzer { proxy -> analyze(proxy) })

    try {
      // Nothing else in this process binds CameraX, but unbindAll makes a re-entered scanner safe.
      provider.unbindAll()
      provider.bindToLifecycle(this, selector, preview, analysis)
    } catch (e: Throwable) {
      Log.e(TAG, "bindToLifecycle failed", e)
      finishUnavailable("The camera could not be opened for scanning.")
    }
  }

  /**
   * One analysis frame. `ImageProxy.getImage` is opt-in experimental in CameraX; the ML Kit guide's
   * own sample takes the same opt-in to build an `InputImage` from it.
   * https://developers.google.com/ml-kit/vision/barcode-scanning/android
   */
  @ExperimentalGetImage
  private fun analyze(proxy: ImageProxy) {
    val client = scanner
    val media = proxy.image
    if (client == null || media == null || settled.get()) {
      proxy.close()
      return
    }
    client.process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
      .addOnSuccessListener { barcodes ->
        val hit = barcodes.firstNotNullOfOrNull { QrScanner.acceptedQrValue(it.format, it.rawValue) }
        if (hit != null) finishWithValue(hit)
      }
      .addOnFailureListener { e ->
        // A decode that cannot run at all (no model, no native library) fails every frame, so end
        // on the first one rather than leaving a dead preview up.
        Log.e(TAG, "barcode pass failed", e)
        finishUnavailable("QR scanning is unavailable on this device.")
      }
      // The frame is held until ML Kit is done with it; CameraX requires exactly one close().
      .addOnCompleteListener { proxy.close() }
  }

  private fun finishWithValue(value: String) {
    if (!settled.compareAndSet(false, true)) return
    setResult(RESULT_OK, Intent().putExtra(QrScanner.EXTRA_VALUE, value))
    finish()
  }

  private fun finishCancelled() {
    if (!settled.compareAndSet(false, true)) return
    setResult(RESULT_CANCELED)
    finish()
  }

  private fun finishUnavailable(message: String) {
    if (!settled.compareAndSet(false, true)) return
    setResult(QrScanner.RESULT_UNAVAILABLE, Intent().putExtra(QrScanner.EXTRA_ERROR, message))
    finish()
  }

  override fun onDestroy() {
    super.onDestroy()
    // Give the camera back before the promise is settled on the JS side, so a capture screen
    // mounted right after the scan finds camera "0" free.
    runCatching { cameraProvider?.unbindAll() }
    cameraProvider = null
    runCatching { scanner?.close() }
    scanner = null
    if (this::analysisExecutor.isInitialized) analysisExecutor.shutdown()
  }
}
