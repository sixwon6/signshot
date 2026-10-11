package expo.modules.seekercamera

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.graphics.Rect
import android.hardware.camera2.*
import android.hardware.camera2.params.MeteringRectangle
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import org.json.JSONObject

/**
 * Camera2 session: supported 4:3 dual YUV streams, no hardware JPEG, no ZSL, and
 * device-recommended still processing before the app's optional recipe.
 */
class CameraController(private val context: Context, private val renderer: GlRenderer) {
  companion object {
    private const val TAG = "SeekerCamCtl"
    private const val CAPTURE_TIMEOUT_MS = 15_000L
    /** Seeker main sensor (probe: physical BACK, FULL, YUV max 4000x3000). */
    private const val CAMERA_ID = "0"
    /** Meter events at most 10 Hz. */
    private const val METER_INTERVAL_MS = 100L
    /** Every 8th pixel both ways: ~30k samples of a 1600×1200 preview frame. */
    private const val METER_PIXEL_STEP = 8
  }

  private val thread = HandlerThread("signshot").apply { start() }
  private val handler = Handler(thread.looper)

  // Manual controls (CaptureControls.kt). `effective` is the last accepted settings, applied to
  // preview and still alike.
  @Volatile private var caps: CaptureCaps? = null
  @Volatile private var effective: EffectiveCapture = EffectiveCapture.AUTO_EFFECTIVE
  // The live AE result, so a half-manual pair can borrow the half the camera is still choosing.
  @Volatile private var lastAeIso: Int? = null
  @Volatile private var lastAeShutterNs: Long? = null
  // Tap to focus. `meteringRegion` is camera-thread only and rides on every request until a
  // still, releaseFocusPoint(), or manual focus.
  @Volatile private var activeArray: Rect? = null
  @Volatile private var sensorOrientation = 0
  @Volatile private var maxAfRegions = 0
  @Volatile private var maxAeRegions = 0
  private var meteringRegion: MeteringRectangle? = null
  // Metering, camera-thread only: the newest repeating result, read by the preview listener.
  private var meterEv: Int? = null
  private var meterFocus: Float? = null
  private var meterAwb: String? = null
  private var meterAeState: String = "unavailable"
  private var meterAfState: String = "unavailable"
  private var meterAtMs: Long = 0
  private val histogramBins = IntArray(HISTOGRAM_BINS)
  private val histogramStats = LumaStats()

  /** Throttled preview readout for the UI. Called on the camera thread. */
  var onMeter: ((Map<String, Any?>) -> Unit)? = null

  private var device: CameraDevice? = null
  private var session: CameraCaptureSession? = null
  private var previewReader: ImageReader? = null
  private var stillReader: ImageReader? = null
  @Volatile private var closed = false
  // openCamera's StateCallback has not fired. The looper must outlive it: a device delivered to
  // nobody leaks and blocks the camera app-wide. Handler thread only.
  private var awaitingOpen = false

  var onError: ((String) -> Unit)? = null

  /** SENSOR_INFO_TIMESTAMP_SOURCE (0 = unknown epoch, 1 = boot-realtime); SENSOR_TIMESTAMP needs it. */
  @Volatile var timestampSource: Int? = null
    private set

  private data class PendingCapture(
    val onImageAndResult: (android.media.Image, TotalCaptureResult) -> Unit,
    val onFail: (String) -> Unit,
    var image: android.media.Image? = null,
    var result: TotalCaptureResult? = null,
    var timeout: Runnable? = null,
  )
  private var pending: PendingCapture? = null

  @SuppressLint("MissingPermission")
  fun open() {
    handler.post {
      if (closed) return@post
      try {
        val mgr = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val chars = mgr.getCameraCharacteristics(CAMERA_ID)
        renderer.rotationDegrees = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
        sensorOrientation = renderer.rotationDegrees
        activeArray = chars.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
        maxAfRegions = chars.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF) ?: 0
        maxAeRegions = chars.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AE) ?: 0
        timestampSource = chars.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE)
        caps = CaptureCaps.read(chars)
        val streams = CaptureStreams.read(chars)

        previewReader = ImageReader.newInstance(streams.preview.width, streams.preview.height, ImageFormat.YUV_420_888, 3).apply {
          setOnImageAvailableListener({ r ->
            val img = r.acquireLatestImage() ?: return@setOnImageAvailableListener
            // Metering reads the Y plane by absolute index and hands the image on untouched.
            meter(img)
            renderer.submitPreview(img)
          }, handler)
        }
        stillReader = ImageReader.newInstance(streams.still.width, streams.still.height, ImageFormat.YUV_420_888, 2).apply {
          setOnImageAvailableListener({ r ->
            val img = r.acquireNextImage() ?: return@setOnImageAvailableListener
            val p = pending
            if (p == null) { img.close(); return@setOnImageAvailableListener }
            p.image?.close()
            p.image = img
            maybeCompleteCapture()
          }, handler)
        }

        awaitingOpen = true
        mgr.openCamera(CAMERA_ID, object : CameraDevice.StateCallback() {
          override fun onOpened(d: CameraDevice) {
            awaitingOpen = false
            // close() already ran: this device would otherwise leak.
            if (closed) { d.close(); finishCloseIfPending(); return }
            device = d
            createSession(d)
          }
          override fun onDisconnected(d: CameraDevice) {
            awaitingOpen = false
            d.close(); device = null
            failPendingCapture("camera disconnected")
            if (!closed) onError?.invoke("camera disconnected")
            finishCloseIfPending()
          }
          override fun onError(d: CameraDevice, e: Int) {
            awaitingOpen = false
            d.close(); device = null
            failPendingCapture("camera error $e")
            if (closed) { finishCloseIfPending(); return }
            onError?.invoke("camera error $e")
          }
        }, handler)
      } catch (e: Throwable) {
        awaitingOpen = false
        Log.e(TAG, "open failed", e)
        if (closed) { finishCloseIfPending(); return@post }
        onError?.invoke(e.message ?: "open failed")
      }
    }
  }

  private fun createSession(d: CameraDevice) {
    d.createCaptureSession(listOf(previewReader!!.surface, stillReader!!.surface),
      object : CameraCaptureSession.StateCallback() {
        override fun onConfigured(s: CameraCaptureSession) {
          if (closed) { s.close(); return }
          session = s
          startPreview()
        }
        override fun onConfigureFailed(s: CameraCaptureSession) {
          onError?.invoke("session configure failed")
        }
      }, handler)
  }

  /**
   * The repeating preview request, rebuilt from the template on every settings change so an auto
   * control is expressed by not setting it.
   */
  private fun startPreview(afTrigger: Int? = null) {
    val d = device ?: return
    val s = session ?: return
    val req = d.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
    req.addTarget(previewReader!!.surface)
    req.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
    applyTo(req, effective)
    applyRegions(req)
    // Triggers go out once; left on the repeating request, every frame would restart the scan.
    if (afTrigger != null) {
      req.set(CaptureRequest.CONTROL_AF_TRIGGER, afTrigger)
      try { s.capture(req.build(), meterCallback, handler) } catch (e: Throwable) { Log.w(TAG, "af trigger", e) }
      req.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_IDLE)
    }
    s.setRepeatingRequest(req.build(), meterCallback, handler)
  }

  /** The tap's region on a request, for focus and for exposure, whenever the camera is choosing those. */
  private fun applyRegions(req: CaptureRequest.Builder) {
    val region = meteringRegion ?: return
    val regions = arrayOf(region)
    if (maxAfRegions > 0 && effective.focusDiopters == null) req.set(CaptureRequest.CONTROL_AF_REGIONS, regions)
    if (maxAeRegions > 0 && !effective.manualExposure) req.set(CaptureRequest.CONTROL_AE_REGIONS, regions)
  }

  /**
   * `u`,`v` are 0..1 across the picture as displayed, mapped through the sensor orientation onto
   * the active array. AF and AE meter on a square 1/8 of the array wide, then AF_TRIGGER_START locks.
   */
  fun focusAt(u: Double, v: Double) {
    handler.post {
      if (closed) return@post
      val array = activeArray ?: return@post
      if (maxAfRegions == 0 && maxAeRegions == 0) return@post
      val cu = u.coerceIn(0.0, 1.0); val cv = v.coerceIn(0.0, 1.0)
      // Undo the clockwise sensor-to-display rotation.
      val (fx, fy) = when (sensorOrientation) {
        90 -> cv to (1.0 - cu)
        180 -> (1.0 - cu) to (1.0 - cv)
        270 -> (1.0 - cv) to cu
        else -> cu to cv
      }
      val size = maxOf(1, array.width() / 8)
      val cx = array.left + (fx * array.width()).toInt()
      val cy = array.top + (fy * array.height()).toInt()
      val left = (cx - size / 2).coerceIn(array.left, maxOf(array.left, array.right - size))
      val top = (cy - size / 2).coerceIn(array.top, maxOf(array.top, array.bottom - size))
      meteringRegion = MeteringRectangle(left, top, size, size, MeteringRectangle.METERING_WEIGHT_MAX)
      startPreview(afTrigger = CaptureRequest.CONTROL_AF_TRIGGER_START)
    }
  }

  /** Back to continuous focus and frame-wide metering. A no-op when nothing was tapped. */
  fun releaseFocusPoint() {
    handler.post {
      if (closed || meteringRegion == null) return@post
      meteringRegion = null
      startPreview(afTrigger = CaptureRequest.CONTROL_AF_TRIGGER_CANCEL)
    }
  }

  /**
   * Stores the newest 3A result each frame (allocation-free), so AE values borrowed by a half-manual
   * pair are at most a frame old. The meter event is emitted from the preview listener.
   */
  private val meterCallback = object : CameraCaptureSession.CaptureCallback() {
    override fun onCaptureCompleted(cs: CameraCaptureSession, r: CaptureRequest, tr: TotalCaptureResult) {
      lastAeIso = tr.get(CaptureResult.SENSOR_SENSITIVITY)
      lastAeShutterNs = tr.get(CaptureResult.SENSOR_EXPOSURE_TIME)
      meterEv = tr.get(CaptureResult.CONTROL_AE_EXPOSURE_COMPENSATION)
      meterFocus = tr.get(CaptureResult.LENS_FOCUS_DISTANCE)
      meterAwb = AWB_MODE_NAMES[tr.get(CaptureResult.CONTROL_AWB_MODE)]
      meterAeState = AE_STATE_NAMES[tr.get(CaptureResult.CONTROL_AE_STATE)] ?: "unavailable"
      meterAfState = AF_STATE_NAMES[tr.get(CaptureResult.CONTROL_AF_STATE)] ?: "unavailable"
    }
  }

  /**
   * One metering event: 3A readout plus a 64-bin luma histogram. Gated by time rather than frame
   * count, so a preview slowed by a long manual shutter still meters.
   */
  private fun meter(image: android.media.Image) {
    val listener = onMeter ?: return
    val now = android.os.SystemClock.elapsedRealtime()
    if (now - meterAtMs < METER_INTERVAL_MS) return
    meterAtMs = now
    try {
      val plane = image.planes[0]
      lumaHistogram(
        plane.buffer, plane.rowStride, plane.pixelStride, image.width, image.height,
        METER_PIXEL_STEP, histogramBins, histogramStats,
      )
    } catch (e: Throwable) {
      Log.e(TAG, "meter histogram", e)
      return
    }
    val sampled = histogramStats.sampled
    listener(mapOf(
      "iso" to lastAeIso,
      "shutterNs" to lastAeShutterNs,
      "ev" to meterEv,
      "focusDistance" to meterFocus,
      "awbMode" to meterAwb,
      "aeState" to meterAeState,
      "afState" to meterAfState,
      "manualExposure" to effective.manualExposure,
      "histogram" to histogramBins.toList(),
      "sampled" to sampled,
      "clippedBlack" to if (sampled == 0) 0.0 else histogramStats.clippedBlack.toDouble() / sampled,
      "clippedWhite" to if (sampled == 0) 0.0 else histogramStats.clippedWhite.toDouble() / sampled,
    ))
  }

  /** The capabilities of camera "0", whether or not a session is open. */
  fun capabilities(): CaptureCaps = caps ?: CaptureCaps.read(context, CAMERA_ID).also { caps = it }

  /**
   * Parses, clamps and applies `json`, returning the values in force; throws
   * `IllegalArgumentException` for a control this camera lacks. Each still reads the same `effective`.
   */
  fun setSettings(json: String): EffectiveCapture {
    val parsed = CaptureSettings.parse(json)
    val eff = parsed.resolve(capabilities(), lastAeIso, lastAeShutterNs)
    effective = eff
    handler.post { if (!closed) startPreview() }
    return eff
  }

  /** One still capture using the device's quality defaults and the chosen camera controls. */
  fun capture(onImageAndResult: (android.media.Image, TotalCaptureResult) -> Unit, onFail: (String) -> Unit) {
    val posted = handler.post {
      val d = device; val s = session
      if (d == null || s == null) { onFail("camera not ready"); return@post }
      if (pending != null) { onFail("capture in flight"); return@post }
      val operation = PendingCapture(onImageAndResult, onFail)
      pending = operation
      operation.timeout = Runnable {
        if (pending === operation) failPendingCapture("capture timed out")
      }.also { handler.postDelayed(it, CAPTURE_TIMEOUT_MS) }
      try {
        val req = d.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE)
        req.addTarget(stillReader!!.surface)
        // Device still-processing defaults stay on (forcing them OFF adds noise); recipes run on
        // the processed image.
        applyTo(req, effective)
        applyRegions(req)
        s.capture(req.build(), object : CameraCaptureSession.CaptureCallback() {
          override fun onCaptureCompleted(cs: CameraCaptureSession, r: CaptureRequest, tr: TotalCaptureResult) {
            if (pending !== operation) return
            operation.result = tr
            maybeCompleteCapture()
            // A tapped point holds for one photograph.
            releaseFocusPoint()
          }
          override fun onCaptureFailed(cs: CameraCaptureSession, r: CaptureRequest, f: CaptureFailure) {
            if (pending === operation) failPendingCapture("capture failed reason=${f.reason}")
          }
        }, handler)
      } catch (error: Throwable) {
        failPendingCapture(error.message ?: "capture failed")
      }
    }
    if (!posted) onFail("camera thread unavailable")
  }

  private fun maybeCompleteCapture() {
    val p = pending ?: return
    val img = p.image ?: return
    val res = p.result ?: return
    // A late image from a timed-out request must never pair with the next capture's metadata.
    val sensorTimestamp = res.get(CaptureResult.SENSOR_TIMESTAMP)
    if (sensorTimestamp != null && img.timestamp != sensorTimestamp) {
      img.close()
      p.image = null
      return
    }
    p.timeout?.let { handler.removeCallbacks(it) }
    pending = null
    p.onImageAndResult(img, res)
  }

  private fun failPendingCapture(message: String) {
    val p = pending ?: return
    pending = null
    p.timeout?.let { handler.removeCallbacks(it) }
    p.image?.close()
    p.onFail(message)
  }

  /**
   * The recorded CaptureResult subset. Every key is always present (unknown values are null).
   * SENSOR_TIMESTAMP is a string because boot-realtime ns exceed 2^53 after ~104 days of uptime.
   */
  fun bundleKeys(tr: TotalCaptureResult): JSONObject = JSONObject().apply {
    put("sensorTimestamp", tr.get(CaptureResult.SENSOR_TIMESTAMP)?.toString() ?: JSONObject.NULL)
    // From CameraCharacteristics, not this result.
    put("timestampSource", timestampSource ?: JSONObject.NULL)
    put("sensorSensitivity", tr.get(CaptureResult.SENSOR_SENSITIVITY) ?: JSONObject.NULL)
    put("exposureTimeNs", tr.get(CaptureResult.SENSOR_EXPOSURE_TIME) ?: JSONObject.NULL)
    put("frameDurationNs", tr.get(CaptureResult.SENSOR_FRAME_DURATION) ?: JSONObject.NULL)
    put("lensFocusDistance", JSONObject.NULL) // LENS_INFO_FOCUS_DISTANCE_CALIBRATION == UNCALIBRATED (probe)
    put("flashState", tr.get(CaptureResult.FLASH_STATE) ?: JSONObject.NULL)
    put("aeAntibandingMode", tr.get(CaptureResult.CONTROL_AE_ANTIBANDING_MODE) ?: JSONObject.NULL)
    put("sceneFlicker", tr.get(CaptureResult.STATISTICS_SCENE_FLICKER) ?: JSONObject.NULL)
    // As reported by the device, not assumed from the request template.
    put("noiseReductionMode", tr.get(CaptureResult.NOISE_REDUCTION_MODE) ?: JSONObject.NULL)
    put("edgeMode", tr.get(CaptureResult.EDGE_MODE) ?: JSONObject.NULL)
  }

  /**
   * Session/device/readers are closed on the handler thread; the looper is quit LAST so a device
   * still in flight can be delivered and closed. If openCamera has not called back yet, the
   * StateCallback path quits instead.
   */
  fun close() {
    if (closed) return
    closed = true
    handler.post {
      closeResourcesOnThread()
      if (awaitingOpen) return@post
      thread.quitSafely()
    }
  }

  /** Handler-thread only; idempotent — both close() and the StateCallback path may call it. */
  private fun closeResourcesOnThread() {
    failPendingCapture("camera closed before capture completed")
    try { session?.close() } catch (_: Throwable) {}
    try { device?.close() } catch (_: Throwable) {}
    try { previewReader?.close() } catch (_: Throwable) {}
    try { stillReader?.close() } catch (_: Throwable) {}
    session = null; device = null; previewReader = null; stillReader = null
  }

  private fun finishCloseIfPending() {
    if (!closed) return
    closeResourcesOnThread()
    thread.quitSafely()
  }
}
