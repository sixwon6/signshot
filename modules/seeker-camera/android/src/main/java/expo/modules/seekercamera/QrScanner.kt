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
 * QR scanning with the bundled ML Kit model on CameraX, not the Play services code scanner: the
 * Seeker is not documented to ship Play services. Binds the back camera itself, so `scanQrCode`
 * refuses while a `SeekerCameraView` owns camera "0". Requests CAMERA itself if not yet granted.
 */
internal object QrScanner {
  /** `startActivityForResult` request code; 16-bit, as the framework requires. */
  const val REQUEST_CODE = 0x5EED

  const val EXTRA_VALUE = "expo.modules.seekercamera.QR_VALUE"
  const val EXTRA_ERROR = "expo.modules.seekercamera.QR_ERROR"

  /** Scan impossible (no camera, no grant, model failed); carries `EXTRA_ERROR`. */
  const val RESULT_UNAVAILABLE = android.app.Activity.RESULT_FIRST_USER

  /** QR alphanumeric capacity; bounds what a hostile symbol can hand JS. */
  const val MAX_VALUE_CHARS = 4296

  fun intent(context: Context): Intent = Intent(context, QrScannerActivity::class.java)

  /** A QR code (no other format) with a non-blank value within MAX_VALUE_CHARS, else null. */
  fun acceptedQrValue(format: Int, rawValue: String?): String? {
    if (format != Barcode.FORMAT_QR_CODE) return null
    val value = rawValue ?: return null
    if (value.isBlank()) return null
    if (value.length > MAX_VALUE_CHARS) return null
    return value
  }
}

/**
 * Full-screen scanner. Results: `RESULT_OK` + `EXTRA_VALUE`, `RESULT_CANCELED`, or
 * `QrScanner.RESULT_UNAVAILABLE` + `EXTRA_ERROR`. Not exported.
 */
class QrScannerActivity : AppCompatActivity() {
  companion object {
    private const val TAG = "SeekerCamQr"
    private const val PERMISSION_REQUEST = 0x5EEE
    /**
     * 1280x720 reads a QR on another phone's screen at arm's length; the default 640x480 often does not.
     * https://developer.android.com/media/camera/camerax/analyze
     */
    private val ANALYSIS_SIZE = Size(1280, 720)
  }

  private lateinit var previewView: PreviewView
  private lateinit var analysisExecutor: ExecutorService
  private var scanner: BarcodeScanner? = null
  private var cameraProvider: ProcessCameraProvider? = null

  /** Every finish path checks this, so a late frame cannot finish twice. */
  private val settled = AtomicBoolean(false)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(buildUi())

    // One frame at a time; STRATEGY_KEEP_ONLY_LATEST drops the rest while a decode runs.
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

  /** Built in code: the module ships no layout resources. */
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
      finishUnavailable("Signshot needs camera access to scan a QR code.")
    }
  }

  private fun startCamera() {
    // Use cases must be bound on the main thread.
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
      // Safe re-entry.
      provider.unbindAll()
      provider.bindToLifecycle(this, selector, preview, analysis)
    } catch (e: Throwable) {
      Log.e(TAG, "bindToLifecycle failed", e)
      finishUnavailable("The camera could not be opened for scanning.")
    }
  }

  /**
   * `ImageProxy.getImage` is experimental opt-in, as in the ML Kit sample.
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
        // A decoder that cannot run fails every frame; end on the first.
        Log.e(TAG, "barcode pass failed", e)
        finishUnavailable("QR scanning is unavailable on this device.")
      }
      // CameraX requires exactly one close(), after ML Kit is done with the frame.
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
    // Release camera "0" before JS settles, so a capture screen mounted next finds it free.
    runCatching { cameraProvider?.unbindAll() }
    cameraProvider = null
    runCatching { scanner?.close() }
    scanner = null
    if (this::analysisExecutor.isInitialized) analysisExecutor.shutdown()
  }
}
