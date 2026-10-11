package expo.modules.seekercamera

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

/**
 * A JSON manifest plus optional 3D LUT. Parsing is driven by ShaderGen's registry maps and is strict
 * (unknown stage, wrong scaling law, missing param, duplicate sample-time stage, LUT without payload,
 * unmet rendererMin all throw), so a pipeline id never names something other than what renders.
 */
class Profile(
  val profileId: String,
  val profileVersion: Int,
  val lutSize: Int,          // 0 = no LUT
  val lutRgba: ByteBuffer?,  // size^3 * 4 bytes, RGBA8
  val lutDigest: String,
  val lutMixCurve: List<Pair<Float, Float>>,
  val stages: List<Stage>,
) {
  class Stage(
    val type: String,
    val scaling: String,
    val params: MutableMap<String, Float>,
    val curves: Map<String, List<Pair<Float, Float>>>,
  )

  /** Piecewise-linear curve eval; domain x = intensity 0..100. */
  fun evalCurve(curve: List<Pair<Float, Float>>?, fallback: Float, intensity100: Float): Float {
    if (curve.isNullOrEmpty()) return fallback
    if (intensity100 <= curve.first().first) return curve.first().second
    if (intensity100 >= curve.last().first) return curve.last().second
    for (i in 1 until curve.size) {
      val (x1, y1) = curve[i - 1]; val (x2, y2) = curve[i]
      if (intensity100 <= x2) {
        val t = if (x2 == x1) 1f else (intensity100 - x1) / (x2 - x1)
        return y1 + (y2 - y1) * t
      }
    }
    return curve.last().second
  }

  /** Resolved param value for a stage at a given intensity (curve overrides base param). */
  fun resolved(stage: Stage, key: String, intensity100: Float): Float =
    evalCurve(stage.curves[key], stage.params[key] ?: 0f, intensity100)

  companion object {
    fun parse(manifestJson: String, lutBase64: String?): Profile {
      val m = JSONObject(manifestJson)
      requireRenderer(m.optString("rendererMin", "0.0.0"))
      val lutObj = m.optJSONObject("lut")
      var lutSize = 0
      var lutBuf: ByteBuffer? = null
      var lutDigest = "none"
      if (lutObj != null) {
        // Rendering without the LUT would produce a pipeline id that claims one.
        require(lutBase64 != null) { "manifest declares a lut but no lutBase64 payload was supplied" }
        lutSize = lutObj.getInt("size")
        val raw = Base64.decode(lutBase64, Base64.DEFAULT)
        require(raw.size == lutSize * lutSize * lutSize * 4) {
          "lut payload ${raw.size} != ${lutSize}^3*4"
        }
        lutBuf = ByteBuffer.allocateDirect(raw.size).order(ByteOrder.nativeOrder())
        lutBuf.put(raw).rewind()
        lutDigest = sha256Hex(raw).substring(0, 12)
      }
      val stages = mutableListOf<Stage>()
      val seenSampleTime = mutableSetOf<String>()
      val stagesArr = m.optJSONArray("stages") ?: JSONArray()
      for (i in 0 until stagesArr.length()) {
        val s = stagesArr.getJSONObject(i)
        val type = s.getString("type")
        val paramNames = ShaderGen.STAGE_PARAMS[type]
          ?: throw IllegalArgumentException(
            "stage '$type' is not in the renderer stage registry (renderer ${ShaderGen.RENDERER_VERSION}) — update required")
        // Scaling law is mandatory and fixed per type.
        require(s.has("scaling")) { "stage '$type': scaling law must be declared" }
        val scaling = s.getString("scaling")
        val expected = ShaderGen.STAGE_SCALING.getValue(type)
        require(scaling == expected) {
          "stage '$type': scaling law '$scaling' must be '$expected'"
        }
        if (type in ShaderGen.SAMPLE_TIME_STAGES) {
          require(seenSampleTime.add(type)) { "stage '$type': duplicate sample-time stage" }
        }
        val params = mutableMapOf<String, Float>()
        s.optJSONObject("params")?.let { p ->
          p.keys().forEach { k -> params[k] = p.getDouble(k).toFloat() }
        }
        val curves = mutableMapOf<String, List<Pair<Float, Float>>>()
        s.optJSONObject("intensityCurve")?.let { c ->
          c.keys().forEach { k -> curves[k] = parseCurve(c.getJSONArray(k)) }
        }
        paramNames.forEach { p ->
          require(params.containsKey(p) || curves.containsKey(p)) {
            "stage '$type': missing param '$p' (needs a static params entry or an intensityCurve)"
          }
        }
        stages.add(Stage(type, scaling, params, curves))
      }
      val lutMixCurve = m.optJSONObject("intensity")?.optJSONArray("lutMix")?.let { parseCurve(it) }
        ?: listOf(0f to 0f, 100f to 1f)
      return Profile(
        profileId = m.getString("profileId"),
        profileVersion = m.optInt("profileVersion", 1),
        lutSize = lutSize, lutRgba = lutBuf, lutDigest = lutDigest,
        lutMixCurve = lutMixCurve, stages = stages,
      )
    }

    /** Numeric per-component semver gate against ShaderGen.RENDERER_VERSION. */
    private fun requireRenderer(rendererMin: String) {
      fun parts(s: String, what: String) = s.split(".").map {
        it.toIntOrNull() ?: throw IllegalArgumentException("$what '$s' is not a numeric semver")
      }
      val min = parts(rendererMin, "rendererMin")
      val cur = parts(ShaderGen.RENDERER_VERSION, "rendererVersion")
      for (i in 0 until maxOf(min.size, cur.size)) {
        val a = min.getOrElse(i) { 0 }; val b = cur.getOrElse(i) { 0 }
        if (a == b) continue
        require(a < b) {
          "profile requires renderer $rendererMin, this build is ${ShaderGen.RENDERER_VERSION} — update required"
        }
        return
      }
    }

    private fun parseCurve(arr: JSONArray): List<Pair<Float, Float>> {
      val out = mutableListOf<Pair<Float, Float>>()
      for (i in 0 until arr.length()) {
        val pt = arr.getJSONArray(i)
        out.add(pt.getDouble(0).toFloat() to pt.getDouble(1).toFloat())
      }
      return out
    }

    fun sha256Hex(data: ByteArray): String =
      MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
  }
}
