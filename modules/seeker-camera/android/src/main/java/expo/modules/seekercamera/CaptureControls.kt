package expo.modules.seekercamera

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.ColorSpaceTransform
import android.hardware.camera2.params.RggbChannelVector
import java.nio.ByteBuffer
import kotlin.math.pow
import org.json.JSONArray
import org.json.JSONObject

/**
 * Manual capture controls, applied identically to preview and still. Everything except
 * {@link CaptureCaps.read} and {@link applyTo} is pure, so `CaptureControlsTest` runs on the JVM.
 * Out-of-range values are clamped; only a control the camera lacks is refused.
 */

private const val AUTO_JSON = "auto"
private const val UNAVAILABLE = "unavailable"

/** The photographic band the kelvin dial offers. The approximation below is anchored at 6500 K. */
const val KELVIN_MIN = 2000
const val KELVIN_MAX = 10000

/** Substitutes for the half of a manual exposure pair that is still "auto", before any AE result. */
private const val FALLBACK_ISO = 400
private const val FALLBACK_SHUTTER_NS = 16_666_667L

/** `CONTROL_AWB_MODE_*` by the name the JS side uses. */
val AWB_MODE_NAMES: Map<Int, String> = mapOf(
  CameraMetadata.CONTROL_AWB_MODE_OFF to "off",
  CameraMetadata.CONTROL_AWB_MODE_AUTO to "auto",
  CameraMetadata.CONTROL_AWB_MODE_INCANDESCENT to "incandescent",
  CameraMetadata.CONTROL_AWB_MODE_FLUORESCENT to "fluorescent",
  CameraMetadata.CONTROL_AWB_MODE_WARM_FLUORESCENT to "warm-fluorescent",
  CameraMetadata.CONTROL_AWB_MODE_DAYLIGHT to "daylight",
  CameraMetadata.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT to "cloudy-daylight",
  CameraMetadata.CONTROL_AWB_MODE_TWILIGHT to "twilight",
  CameraMetadata.CONTROL_AWB_MODE_SHADE to "shade",
)

val AF_MODE_NAMES: Map<Int, String> = mapOf(
  CameraMetadata.CONTROL_AF_MODE_OFF to "off",
  CameraMetadata.CONTROL_AF_MODE_AUTO to "auto",
  CameraMetadata.CONTROL_AF_MODE_MACRO to "macro",
  CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO to "continuous-video",
  CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE to "continuous-picture",
  CameraMetadata.CONTROL_AF_MODE_EDOF to "edof",
)

val AE_STATE_NAMES: Map<Int, String> = mapOf(
  CameraMetadata.CONTROL_AE_STATE_INACTIVE to "inactive",
  CameraMetadata.CONTROL_AE_STATE_SEARCHING to "searching",
  CameraMetadata.CONTROL_AE_STATE_CONVERGED to "converged",
  CameraMetadata.CONTROL_AE_STATE_LOCKED to "locked",
  CameraMetadata.CONTROL_AE_STATE_FLASH_REQUIRED to "flash-required",
  CameraMetadata.CONTROL_AE_STATE_PRECAPTURE to "precapture",
)

val AF_STATE_NAMES: Map<Int, String> = mapOf(
  CameraMetadata.CONTROL_AF_STATE_INACTIVE to "inactive",
  CameraMetadata.CONTROL_AF_STATE_PASSIVE_SCAN to "passive-scan",
  CameraMetadata.CONTROL_AF_STATE_PASSIVE_FOCUSED to "passive-focused",
  CameraMetadata.CONTROL_AF_STATE_ACTIVE_SCAN to "active-scan",
  CameraMetadata.CONTROL_AF_STATE_FOCUSED_LOCKED to "focused-locked",
  CameraMetadata.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED to "not-focused-locked",
  CameraMetadata.CONTROL_AF_STATE_PASSIVE_UNFOCUSED to "passive-unfocused",
)

/** White balance: the camera's own mode, or a temperature we compute gains for. */
sealed class WhiteBalance {
  object Auto : WhiteBalance()
  /** A `CONTROL_AWB_MODE_*` the device lists, by name. */
  data class Mode(val name: String) : WhiteBalance()
  /** `CONTROL_AWB_MODE_OFF` plus gains; MANUAL_POST_PROCESSING only. */
  data class Kelvin(val kelvin: Int) : WhiteBalance()
}

/**
 * What camera "0" can do, read from `CameraCharacteristics`. A missing range is a missing control
 * and reaches JS as `"unavailable"`.
 */
data class CaptureCaps(
  val manualSensor: Boolean,
  val manualPostProcessing: Boolean,
  val isoMin: Int?,
  val isoMax: Int?,
  val shutterMinNs: Long?,
  val shutterMaxNs: Long?,
  val evMin: Int?,
  val evMax: Int?,
  /** EV per compensation STEP, e.g. 1/3. `ev` is counted in steps everywhere. */
  val evStep: Double?,
  val aeLockAvailable: Boolean,
  val awbLockAvailable: Boolean,
  val awbModes: List<String>,
  /** `LENS_INFO_MINIMUM_FOCUS_DISTANCE`, in DIOPTRES: the largest focus value, 0 being infinity. */
  val minFocusDiopters: Float?,
  /** `uncalibrated` | `approximate` | `calibrated` | `unavailable`. */
  val focusCalibration: String,
  val afModes: List<String>,
) {
  val manualFocus: Boolean
    get() = minFocusDiopters != null && minFocusDiopters > 0f && afModes.contains("off")

  fun toJson(): JSONObject = JSONObject().apply {
    put("manualSensor", manualSensor)
    put("manualPostProcessing", manualPostProcessing)
    put("iso", range(isoMin, isoMax))
    put("shutterNs", range(shutterMinNs, shutterMaxNs))
    put(
      "ev",
      if (evMin == null || evMax == null || evStep == null) UNAVAILABLE
      else JSONObject().put("min", evMin).put("max", evMax).put("step", evStep),
    )
    put("aeLock", aeLockAvailable)
    put("awbLock", awbLockAvailable)
    put("awbModes", JSONArray(awbModes))
    put("afModes", JSONArray(afModes))
    put(
      "focus",
      if (!manualFocus) UNAVAILABLE
      else JSONObject()
        .put("minDiopters", 0)
        .put("maxDiopters", minFocusDiopters!!.toDouble())
        .put("calibration", focusCalibration),
    )
    put(
      "kelvin",
      if (!manualPostProcessing) UNAVAILABLE
      else JSONObject().put("min", KELVIN_MIN).put("max", KELVIN_MAX),
    )
  }

  private fun range(min: Number?, max: Number?): Any =
    if (min == null || max == null) UNAVAILABLE else JSONObject().put("min", min).put("max", max)

  companion object {
    /** Never throws: a characteristics read that fails is a camera with no manual controls. */
    fun read(context: Context, cameraId: String): CaptureCaps = try {
      val mgr = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
      read(mgr.getCameraCharacteristics(cameraId))
    } catch (_: Throwable) {
      NONE
    }

    fun read(chars: CameraCharacteristics): CaptureCaps {
      val caps = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)?.toList().orEmpty()
      val iso = chars.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)
      val shutter = chars.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)
      val ev = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE)
      val step = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP)
      val minFocus = chars.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE)
      val calibration = when (chars.get(CameraCharacteristics.LENS_INFO_FOCUS_DISTANCE_CALIBRATION)) {
        CameraMetadata.LENS_INFO_FOCUS_DISTANCE_CALIBRATION_UNCALIBRATED -> "uncalibrated"
        CameraMetadata.LENS_INFO_FOCUS_DISTANCE_CALIBRATION_APPROXIMATE -> "approximate"
        CameraMetadata.LENS_INFO_FOCUS_DISTANCE_CALIBRATION_CALIBRATED -> "calibrated"
        else -> UNAVAILABLE
      }
      return CaptureCaps(
        manualSensor = caps.contains(
          CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR,
        ),
        manualPostProcessing = caps.contains(
          CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_POST_PROCESSING,
        ),
        isoMin = iso?.lower,
        isoMax = iso?.upper,
        shutterMinNs = shutter?.lower,
        shutterMaxNs = shutter?.upper,
        evMin = ev?.lower,
        evMax = ev?.upper,
        evStep = step?.let { it.numerator.toDouble() / it.denominator.toDouble() },
        aeLockAvailable = chars.get(CameraCharacteristics.CONTROL_AE_LOCK_AVAILABLE) == true,
        awbLockAvailable = chars.get(CameraCharacteristics.CONTROL_AWB_LOCK_AVAILABLE) == true,
        awbModes = chars.get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES)
          ?.toList()?.mapNotNull { AWB_MODE_NAMES[it] }.orEmpty(),
        minFocusDiopters = minFocus,
        focusCalibration = calibration,
        afModes = chars.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)
          ?.toList()?.mapNotNull { AF_MODE_NAMES[it] }.orEmpty(),
      )
    }

    /** A camera that reports nothing: every control auto, every range absent. */
    val NONE = CaptureCaps(
      manualSensor = false, manualPostProcessing = false,
      isoMin = null, isoMax = null, shutterMinNs = null, shutterMaxNs = null,
      evMin = null, evMax = null, evStep = null,
      aeLockAvailable = false, awbLockAvailable = false, awbModes = emptyList(),
      minFocusDiopters = null, focusCalibration = UNAVAILABLE, afModes = emptyList(),
    )
  }
}

/**
 * What the photographer asked for; `null` means auto. ISO and shutter are manual together:
 * `resolve` fills the other from the live AE result.
 */
data class CaptureSettings(
  val iso: Int?,
  val shutterNs: Long?,
  /** Exposure compensation in device STEPS, not stops. AE on only. */
  val ev: Int,
  val aeLock: Boolean,
  val whiteBalance: WhiteBalance,
  val awbLock: Boolean,
  val focusDiopters: Float?,
) {
  companion object {
    val AUTO = CaptureSettings(null, null, 0, false, WhiteBalance.Auto, false, null)

    /** Throws `IllegalArgumentException` naming the field; never returns a partial object. */
    fun parse(json: String): CaptureSettings {
      val o = try {
        JSONObject(json)
      } catch (_: Throwable) {
        throw IllegalArgumentException("capture settings: not a JSON object")
      }
      val iso = number(o, "iso")?.let { whole("iso", it).toInt() }
      val shutter = number(o, "shutterNs")?.let { whole("shutterNs", it) }
      val focus = number(o, "focus")?.toFloat()
      val ev = o.opt("ev").let { v ->
        when (v) {
          null, JSONObject.NULL -> 0
          is Number -> whole("ev", v.toDouble()).toInt()
          else -> throw IllegalArgumentException("capture settings: ev must be a number of steps")
        }
      }
      return CaptureSettings(
        iso = iso,
        shutterNs = shutter,
        ev = ev,
        aeLock = bool(o, "aeLock"),
        whiteBalance = whiteBalance(o.opt("whiteBalance")),
        awbLock = bool(o, "awbLock"),
        focusDiopters = focus,
      )
    }

    /** `null` for absent or the literal `"auto"`; a finite number otherwise. */
    private fun number(o: JSONObject, key: String): Double? = when (val v = o.opt(key)) {
      null, JSONObject.NULL -> null
      AUTO_JSON -> null
      is Number -> v.toDouble().also {
        if (!it.isFinite()) throw IllegalArgumentException("capture settings: $key is not finite")
      }
      else -> throw IllegalArgumentException("capture settings: $key must be \"auto\" or a number")
    }

    private fun whole(key: String, value: Double): Long {
      if (value != Math.floor(value)) {
        throw IllegalArgumentException("capture settings: $key must be a whole number")
      }
      return value.toLong()
    }

    private fun bool(o: JSONObject, key: String): Boolean = when (val v = o.opt(key)) {
      null, JSONObject.NULL -> false
      is Boolean -> v
      else -> throw IllegalArgumentException("capture settings: $key must be true or false")
    }

    private fun whiteBalance(v: Any?): WhiteBalance = when {
      v == null || v == JSONObject.NULL || v == AUTO_JSON -> WhiteBalance.Auto
      v is String -> WhiteBalance.Mode(v)
      v is JSONObject -> {
        val k = v.opt("kelvin")
        if (k !is Number || !k.toDouble().isFinite()) {
          throw IllegalArgumentException("capture settings: whiteBalance object needs a kelvin number")
        }
        WhiteBalance.Kelvin(k.toInt())
      }
      else -> throw IllegalArgumentException(
        "capture settings: whiteBalance must be \"auto\", a mode name or { kelvin }",
      )
    }
  }

  /**
   * The values the camera will be given: numbers clamped, unsupported locks dropped, and a manual
   * ISO/shutter pair completed from the last AE result (or a fallback). Refuses only a missing control.
   */
  fun resolve(caps: CaptureCaps, lastIso: Int?, lastShutterNs: Long?): EffectiveCapture {
    val manual = iso != null || shutterNs != null
    if (manual && !caps.manualSensor) {
      throw IllegalArgumentException(
        "manual ISO and shutter need MANUAL_SENSOR, which this camera does not report",
      )
    }
    val effIso = if (!manual) null else clampInt(iso ?: lastIso ?: FALLBACK_ISO, caps.isoMin, caps.isoMax)
    val effShutter = if (!manual) null else {
      clampLong(shutterNs ?: lastShutterNs ?: FALLBACK_SHUTTER_NS, caps.shutterMinNs, caps.shutterMaxNs)
    }
    val wb = when (whiteBalance) {
      is WhiteBalance.Auto -> WhiteBalance.Auto
      is WhiteBalance.Mode -> {
        if (!caps.awbModes.contains(whiteBalance.name)) {
          throw IllegalArgumentException("white balance mode \"${whiteBalance.name}\" is not on this camera")
        }
        whiteBalance
      }
      is WhiteBalance.Kelvin -> {
        if (!caps.manualPostProcessing) {
          throw IllegalArgumentException(
            "white balance in kelvin needs MANUAL_POST_PROCESSING, which this camera does not report",
          )
        }
        WhiteBalance.Kelvin(whiteBalance.kelvin.coerceIn(KELVIN_MIN, KELVIN_MAX))
      }
    }
    val focus = when {
      focusDiopters == null -> null
      !caps.manualFocus -> throw IllegalArgumentException(
        "manual focus needs a focus range and CONTROL_AF_MODE_OFF, which this camera does not report",
      )
      else -> focusDiopters.coerceIn(0f, caps.minFocusDiopters!!)
    }
    return EffectiveCapture(
      manualExposure = manual,
      iso = effIso,
      shutterNs = effShutter,
      // Compensation is an AE control: with AE off it means nothing, so it reads back as 0.
      ev = if (manual) 0 else clampInt(ev, caps.evMin, caps.evMax),
      aeLock = aeLock && caps.aeLockAvailable && !manual,
      whiteBalance = wb,
      awbLock = awbLock && caps.awbLockAvailable && wb !is WhiteBalance.Kelvin,
      focusDiopters = focus,
    )
  }

  private fun clampInt(v: Int, min: Int?, max: Int?): Int {
    var out = v
    if (min != null && out < min) out = min
    if (max != null && out > max) out = max
    return out
  }

  private fun clampLong(v: Long, min: Long?, max: Long?): Long {
    var out = v
    if (min != null && out < min) out = min
    if (max != null && out > max) out = max
    return out
  }
}

/** What was applied, in the same shape the settings arrived in, so JS can store it verbatim. */
data class EffectiveCapture(
  val manualExposure: Boolean,
  val iso: Int?,
  val shutterNs: Long?,
  val ev: Int,
  val aeLock: Boolean,
  val whiteBalance: WhiteBalance,
  val awbLock: Boolean,
  val focusDiopters: Float?,
) {
  fun toJson(): JSONObject = JSONObject().apply {
    put("iso", iso ?: AUTO_JSON)
    put("shutterNs", shutterNs ?: AUTO_JSON)
    put("ev", ev)
    put("aeLock", aeLock)
    put(
      "whiteBalance",
      when (whiteBalance) {
        is WhiteBalance.Auto -> AUTO_JSON
        is WhiteBalance.Mode -> whiteBalance.name
        is WhiteBalance.Kelvin -> JSONObject().put("kelvin", whiteBalance.kelvin)
      },
    )
    put("awbLock", awbLock)
    put("focus", focusDiopters?.toDouble() ?: AUTO_JSON)
    put("manualExposure", manualExposure)
  }

  companion object {
    val AUTO_EFFECTIVE = EffectiveCapture(false, null, null, 0, false, WhiteBalance.Auto, false, null)
  }
}

/**
 * Builds both the preview and still requests, so viewfinder and file match. Sets only what deviates
 * from the template's auto behaviour; image processing retains the device's template defaults.
 */
fun applyTo(req: CaptureRequest.Builder, eff: EffectiveCapture) {
  // One request, one frame, one result: ZSL would hand back a buffered frame whose exposure is
  // not the one this request asked for.
  req.set(CaptureRequest.CONTROL_ENABLE_ZSL, false)
  if (eff.manualExposure) {
    req.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF)
    eff.iso?.let { req.set(CaptureRequest.SENSOR_SENSITIVITY, it) }
    eff.shutterNs?.let {
      req.set(CaptureRequest.SENSOR_EXPOSURE_TIME, it)
      // A frame cannot be shorter than its exposure; without this a long shutter is silently
      // cut short by the template's frame duration.
      req.set(CaptureRequest.SENSOR_FRAME_DURATION, it)
    }
  } else {
    if (eff.ev != 0) req.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, eff.ev)
    if (eff.aeLock) req.set(CaptureRequest.CONTROL_AE_LOCK, true)
  }
  when (val wb = eff.whiteBalance) {
    is WhiteBalance.Auto -> Unit
    is WhiteBalance.Mode -> {
      AWB_MODE_NAMES.entries.firstOrNull { it.value == wb.name }?.let {
        req.set(CaptureRequest.CONTROL_AWB_MODE, it.key)
      }
    }
    is WhiteBalance.Kelvin -> {
      val g = kelvinGains(wb.kelvin)
      req.set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_OFF)
      req.set(
        CaptureRequest.COLOR_CORRECTION_MODE,
        CaptureRequest.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX,
      )
      req.set(CaptureRequest.COLOR_CORRECTION_GAINS, RggbChannelVector(g[0], g[1], g[2], g[3]))
      req.set(CaptureRequest.COLOR_CORRECTION_TRANSFORM, IDENTITY_TRANSFORM)
    }
  }
  if (eff.awbLock) req.set(CaptureRequest.CONTROL_AWB_LOCK, true)
  eff.focusDiopters?.let {
    req.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF)
    req.set(CaptureRequest.LENS_FOCUS_DISTANCE, it)
  }
}

/** COLOR_CORRECTION_MODE_TRANSFORM_MATRIX needs a matrix as well as gains; this is the identity. */
private val IDENTITY_TRANSFORM = ColorSpaceTransform(
  intArrayOf(1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1),
)

/**
 * Kelvin → `[R, Geven, Godd, B]` gains: an uncalibrated look, not a sensor calibration. Neutral at
 * 6500 K, a power law in the temperature ratio either side (warm compensated with blue, cool with
 * red). Every gain is >= 1.0, which Camera2 requires.
 */
fun kelvinGains(kelvin: Int): FloatArray {
  val t = kelvin.coerceIn(KELVIN_MIN, KELVIN_MAX).toDouble()
  val neutral = 6500.0
  return if (t <= neutral) {
    val w = neutral / t
    val g = w.pow(0.25)
    floatArrayOf(1f, g.toFloat(), g.toFloat(), w.pow(0.90).toFloat())
  } else {
    val w = t / neutral
    val g = w.pow(0.25)
    floatArrayOf(w.pow(0.90).toFloat(), g.toFloat(), g.toFloat(), 1f)
  }
}

/** One histogram pass's counters. Reused across frames; the routine allocates nothing. */
class LumaStats {
  @JvmField var sampled: Int = 0
  @JvmField var clippedBlack: Int = 0
  @JvmField var clippedWhite: Int = 0
}

/**
 * 64-bin luma histogram and clipping counts from the preview Y plane, as full-range BT.601
 * (0 = black, 255 = white) to match the renderer. Allocation-free; absolute `get(index)` leaves the
 * buffer position untouched for the renderer's upload. Samples every `step`-th pixel.
 */
fun lumaHistogram(
  y: ByteBuffer,
  rowStride: Int,
  pixelStride: Int,
  width: Int,
  height: Int,
  step: Int,
  bins: IntArray,
  out: LumaStats,
) {
  require(bins.size == HISTOGRAM_BINS) { "histogram needs $HISTOGRAM_BINS bins" }
  java.util.Arrays.fill(bins, 0)
  out.sampled = 0
  out.clippedBlack = 0
  out.clippedWhite = 0
  if (width <= 0 || height <= 0 || step <= 0 || rowStride <= 0 || pixelStride <= 0) return
  val limit = y.limit()
  var row = 0
  while (row < height) {
    val rowBase = row * rowStride
    if (rowBase >= limit) break
    var col = 0
    while (col < width) {
      val at = rowBase + col * pixelStride
      if (at >= limit) break
      val v = y.get(at).toInt() and 0xFF
      bins[v shr HISTOGRAM_SHIFT]++
      if (v <= CLIP_BLACK) out.clippedBlack++ else if (v >= CLIP_WHITE) out.clippedWhite++
      out.sampled++
      col += step
    }
    row += step
  }
}

const val HISTOGRAM_BINS = 64
private const val HISTOGRAM_SHIFT = 2 // 256 codes / 64 bins
private const val CLIP_BLACK = 0
private const val CLIP_WHITE = 255
