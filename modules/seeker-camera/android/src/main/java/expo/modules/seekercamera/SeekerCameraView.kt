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
  // Detach tears the engine down; re-attach builds a fresh pair.
  var renderer = GlRenderer()
    private set
  var camera = CameraController(context, renderer)
    private set

  private val surfaceView = SurfaceView(context)
  // ExpoView is a LinearLayout: overlapping children must go in this FrameLayout.
  private val content = FrameLayout(context)
  private var engineAlive = true
  private var started = false
  private var surfaceAttached = false
  private val captureOrientation = CaptureOrientation()
  private val orientationListener = object : OrientationEventListener(context) {
    override fun onOrientationChanged(orientation: Int) {
      captureOrientation.update(orientation)
      // Live for the preview's anisotropic stages; the still snapshots it at the shutter.
      renderer.deviceDegrees = captureOrientation.rotation(0)
    }
  }

  private val onSessionError by EventDispatcher()
  private val onMeter by EventDispatcher<Map<String, Any?>>()

  init {
    addView(content, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    content.addView(surfaceView, matchParent())
    wireEngine()
    surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
      override fun surfaceCreated(holder: SurfaceHolder) {
        // Attach happens in surfaceChanged, which always follows with dimensions.
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
        // Must block: the GL thread may not touch the surface after this returns.
        surfaceAttached = false
        if (engineAlive) renderer.detachWindowSurface()
      }
    })
    SeekerCameraModule.activeView = this
  }

  private fun matchParent() = FrameLayout.LayoutParams(
    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)

  /** Brings a rebuilt engine up on the last profile, intensity and settings held by the module. */
  private fun wireEngine() {
    renderer.onGlError = { msg -> post { onSessionError(mapOf("message" to msg)) } }
    camera.onError = { msg -> post { onSessionError(mapOf("message" to msg)) } }
    // Camera thread → main thread; already throttled to <=10 Hz.
    camera.onMeter = { reading -> post { onMeter(reading) } }
    renderer.intensity = SeekerCameraModule.lastIntensity
    renderer.deviceDegrees = captureOrientation.rotation(0)
    // Queued while !glReady; start() applies it and resolves with the fresh id.
    SeekerCameraModule.lastProfile?.let { p -> renderer.applyProfile(p) { _, _ -> } }
    // Takes effect at the first repeating request. Settings the caps now reject are dropped.
    SeekerCameraModule.lastCaptureSettings?.let { json ->
      try { camera.setSettings(json) } catch (_: Throwable) {}
    }
  }

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

  /** Capture sidecar, written atomically via .tmp + rename. */
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
