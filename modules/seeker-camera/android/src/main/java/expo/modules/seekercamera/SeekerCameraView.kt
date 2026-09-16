package expo.modules.seekercamera

import android.content.Context
import android.view.OrientationEventListener
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.io.IOException
import kotlin.math.roundToInt
import org.json.JSONObject

class SeekerCameraView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // Replaceable: view detach tears the engine down completely and re-attach builds a fresh pair.
  // Public reads (module) stay stable.
  var renderer = GlRenderer()
    private set
  var camera = CameraController(context, renderer)
    private set

  private val surfaceView = SurfaceView(context)
  // ExpoView is a LinearLayout, not a FrameLayout: two direct MATCH_PARENT children lay out
  // side-by-side (the second gets zero width). Anything over the picture stacks in here.
  private val content = FrameLayout(context)
  private var engineAlive = true
  private var started = false
  private var surfaceAttached = false
  private val captureOrientation = CaptureOrientation()
  private val orientationListener = object : OrientationEventListener(context) {
    override fun onOrientationChanged(orientation: Int) { captureOrientation.update(orientation) }
  }

  private val onSessionError by EventDispatcher()
  private val onMeter by EventDispatcher<Map<String, Any?>>()

  init {
    addView(content, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    content.addView(surfaceView, matchParent())
    wireEngine()
    surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
      override fun surfaceCreated(holder: SurfaceHolder) {
        // Dimensions arrive in surfaceChanged, which always follows; attach happens there.
      }
      override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        if (!engineAlive) return
        if (!started) {
          started = true
          surfaceAttached = true
          renderer.start(holder.surface, width, height)
          camera.open()
        } else if (!surfaceAttached) {
          surfaceAttached = true
          renderer.attachWindowSurface(holder.surface, width, height)
        } else {
          renderer.resize(width, height)
        }
      }
      override fun surfaceDestroyed(holder: SurfaceHolder) {
        // Blocking by contract: the GL thread must not touch the surface after we return.
        // Context/textures/programs survive; only the EGL window surface goes away.
        surfaceAttached = false
        if (engineAlive) renderer.detachWindowSurface()
      }
    })
    SeekerCameraModule.activeView = this
  }

  private fun matchParent() = FrameLayout.LayoutParams(
    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)

  /**
   * Restores the look a rebuilt engine must come up with: the module companion holds the last
   * parsed profile and intensity, so a tab switch cannot diverge native state from JS state.
   */
  private fun wireEngine() {
    renderer.onGlError = { msg -> post { onSessionError(mapOf("message" to msg)) } }
    camera.onError = { msg -> post { onSessionError(mapOf("message" to msg)) } }
    // Camera thread → main thread. Already throttled to <=10 Hz where it is produced.
    camera.onMeter = { reading -> post { onMeter(reading) } }
    renderer.intensity = SeekerCameraModule.lastIntensity
    // Queued while !glReady; start() applies it and resolves with the fresh id.
    SeekerCameraModule.lastProfile?.let { p -> renderer.applyProfile(p) { _, _ -> } }
    // The manual controls come up on the same settings the rebuilt view went down on: the first
    // repeating request is built after the session configures, so this only has to be set before
    // then. A stored string the current caps reject is dropped rather than thrown at the camera.
    SeekerCameraModule.lastCaptureSettings?.let { json ->
      try { camera.setSettings(json) } catch (_: Throwable) {}
    }
  }

  /** The strength dial, set from JS. The renderer reads it per frame. */
  fun setIntensity(value: Float) {
    renderer.intensity = value.coerceIn(0f, 1f)
  }

  fun captureToFiles(onDone: (Result<CaptureOutput>) -> Unit) {
    val dir = File(context.filesDir, "captures").apply { mkdirs() }
    val capturedAtMs = System.currentTimeMillis()
    val base = "cap-$capturedAtMs"
    val t0 = System.nanoTime()
    // One shutter snapshot drives BOTH the sidecar record and the still render.
    val intensitySnapshot = renderer.intensity.coerceIn(0f, 1f)
    val rotationSnapshot = captureOrientation.rotation(renderer.rotationDegrees)
    val intensity100 = (intensitySnapshot * 100f).roundToInt().coerceIn(0, 100)
    camera.capture({ image, totalResult ->
      val keys = camera.bundleKeys(totalResult)
      keys.put("imageRotationDegrees", rotationSnapshot)
      renderer.renderStill(image, dir, base, intensitySnapshot, rotationSnapshot) { r ->
        r.fold({ files ->
          try {
            writeSidecar(dir, base, capturedAtMs, intensity100, keys, files)
          } catch (e: Throwable) {
            onDone(Result.failure(e)); return@fold
          }
          onDone(Result.success(CaptureOutput(
            base, files.cleanPath, files.cleanSha256, files.styledPath, files.styledSha256,
            keys.toString(), (System.nanoTime() - t0) / 1_000_000)))
        }, { e -> onDone(Result.failure(e)) })
      }
    }, { msg -> onDone(Result.failure(RuntimeException(msg))) })
  }

  /** Pending-queue substrate for the capture record. Written atomically via .tmp + rename. */
  private fun writeSidecar(
    dir: File, base: String, capturedAtMs: Long, intensity100: Int,
    keys: JSONObject, files: GlRenderer.StillFiles,
  ) {
    val o = JSONObject()
      // Readers must not invent capture-result fields missing from lower sidecar versions.
      .put("v", 2)
      .put("baseName", base)
      .put("capturedAtMs", capturedAtMs)
      .put("sensorTimestamp", keys.opt("sensorTimestamp") ?: JSONObject.NULL)
      .put("profileId", renderer.profileId)
      .put("profileVersion", renderer.profileVersion)
      .put("capturePipelineId", renderer.capturePipelineId)
      .put("intensity", intensity100)
      .put("captureResult", keys)
      .put("clean", JSONObject().put("path", files.cleanPath).put("sha256", files.cleanSha256))
      .put("styled", JSONObject().put("path", files.styledPath).put("sha256", files.styledSha256))
    val tmp = File(dir, "$base.json.tmp")
    tmp.writeText(o.toString())
    if (!tmp.renameTo(File(dir, "$base.json"))) {
      tmp.delete()
      throw IOException("sidecar rename failed for $base")
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    orientationListener.enable()
    if (!engineAlive) {
      renderer = GlRenderer()
      camera = CameraController(context, renderer)
      engineAlive = true
      wireEngine()
      // started/surfaceAttached were reset at detach; the next surfaceChanged starts the pair.
    }
    SeekerCameraModule.activeView = this
  }

  override fun onDetachedFromWindow() {
    orientationListener.disable()
    super.onDetachedFromWindow()
    if (SeekerCameraModule.activeView === this) SeekerCameraModule.activeView = null
    camera.onError = null
    camera.onMeter = null
    renderer.onGlError = null
    camera.close()
    renderer.release()
    engineAlive = false
    started = false
    surfaceAttached = false
  }

  data class CaptureOutput(
    val baseName: String,
    val cleanPath: String,
    val cleanSha256: String,
    val styledPath: String,
    val styledSha256: String,
    val captureResultJson: String,
    val totalMs: Long,
  )
}
