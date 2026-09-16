package expo.modules.seekercamera

/**
 * Generates the fragment shader from a profile's stage graph (stage i param p -> uniform u_s{i}_p).
 * Stage GLSL is emitted only when present and is an exact identity at neutral values, so adding a
 * stage type never changes existing shaders or pipeline ids. Mirrored by `src/recipes/model.ts`.
 */
object ShaderGen {
  // Bump when output for the same graph changes; it is part of every pipeline id (see ShaderPinTest).
  const val RENDERER_VERSION = "0.2.1"

  // The one place YUV->RGB math exists. BT.601 limited range.
  private const val YUV_GLSL = """
      uniform sampler2D uTexY;
      uniform sampler2D uTexU;
      uniform sampler2D uTexV;
      vec3 sampleYuvRgb(vec2 uv) {
        float y = (texture(uTexY, uv).r - 0.0627451) * 1.1643835;
        float u = texture(uTexU, uv).r - 0.5;
        float v = texture(uTexV, uv).r - 0.5;
        return clamp(vec3(
          y + 1.5960267 * v,
          y - 0.3917623 * u - 0.8129676 * v,
          y + 2.0172321 * u
        ), 0.0, 1.0);
      }
  """

  const val VERTEX_SRC = """#version 300 es
      layout(location = 0) in vec2 aPos;
      uniform int uRotation;
      out vec2 vUv;
      void main() {
        gl_Position = vec4(aPos, 0.0, 1.0);
        vec2 uv = aPos * 0.5 + 0.5;
        uv.y = 1.0 - uv.y;
        if (uRotation == 90)  uv = vec2(uv.y, 1.0 - uv.x);
        else if (uRotation == 180) uv = vec2(1.0 - uv.x, 1.0 - uv.y);
        else if (uRotation == 270) uv = vec2(1.0 - uv.y, uv.x);
        vUv = uv;
      }
  """

  /** Stage registry: the params (uniforms) each stage type exposes; also Profile.parse's type whitelist. */
  val STAGE_PARAMS: Map<String, List<String>> = mapOf(
    "vignette" to listOf("radius", "softness", "strength"),
    "grain" to listOf("size", "opacity", "shadowBias"),
    "chromaticAberration" to listOf("shift"),
    "levels" to listOf("inBlack", "inWhite", "gamma", "outBlack", "outWhite"),
    "resolutionSoften" to listOf("amount"),
    "temperatureTint" to listOf("temperature", "tint"),
    "saturation" to listOf("amount"),
    "contrast" to listOf("amount", "pivot"),
    "sharpen" to listOf("amount", "radius"),
    "halation" to listOf("threshold", "radius", "strength"),
    "border" to listOf("width", "red", "green", "blue"),
  )

  /** The one scaling law each stage type may declare; anything else fails validation. */
  val STAGE_SCALING: Map<String, String> = mapOf(
    "vignette" to "frame-relative",
    "grain" to "reference-pixel",
    "chromaticAberration" to "reference-pixel",
    "levels" to "invariant",
    "resolutionSoften" to "reference-pixel",
    "temperatureTint" to "invariant",
    "saturation" to "invariant",
    "contrast" to "invariant",
    "sharpen" to "reference-pixel",
    "halation" to "reference-pixel",
    "border" to "frame-relative",
  )

  /** Stages applied at SOURCE-SAMPLE time regardless of manifest position; at most one of each. */
  val SAMPLE_TIME_STAGES: Set<String> = setOf("chromaticAberration", "resolutionSoften", "sharpen")

  // Standard recursive 8x8 ordered Bayer thresholds, 0..63.
  private const val BAYER_GLSL = """
      const float BAYER8[64] = float[64](
         0.0, 32.0,  8.0, 40.0,  2.0, 34.0, 10.0, 42.0,
        48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
        12.0, 44.0,  4.0, 36.0, 14.0, 46.0,  6.0, 38.0,
        60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
         3.0, 35.0, 11.0, 43.0,  1.0, 33.0,  9.0, 41.0,
        51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
        15.0, 47.0,  7.0, 39.0, 13.0, 45.0,  5.0, 37.0,
        63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0
      );
  """

  fun fragmentSrc(profile: Profile): String {
    val sb = StringBuilder()
    sb.append("#version 300 es\nprecision highp float;\n")
    sb.append(YUV_GLSL)
    sb.append(
      """
      uniform vec2 uFrameSize;
      uniform float uRefScale;
      uniform int uStyled;
      uniform highp sampler3D uLut;
      uniform float uLutMix;
      uniform float uLutSize;
      in vec2 vUv;
      out vec4 fragColor;
      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      """
    )
    sb.append(BAYER_GLSL)
    profile.stages.forEachIndexed { i, st ->
      val params = STAGE_PARAMS[st.type]
        ?: throw IllegalArgumentException("unknown stage type '${st.type}' (renderer $RENDERER_VERSION)")
      params.forEach { p -> sb.append("uniform float u_s${i}_$p;\n") }
    }

    // Sample-time stages wrap sampleYuvRgb and apply regardless of manifest position; Profile.parse
    // rejects duplicates, so firstOrNull never drops one.
    val soften = profile.stages.withIndex().firstOrNull { it.value.type == "resolutionSoften" }
    if (soften != null) {
      val i = soften.index
      sb.append(
        """
        vec3 sampleSoft(vec2 uv) {
          vec2 o = (u_s${i}_amount * uRefScale) / uFrameSize;
          return (sampleYuvRgb(uv)
                + sampleYuvRgb(uv + vec2(-o.x, -o.y))
                + sampleYuvRgb(uv + vec2( o.x, -o.y))
                + sampleYuvRgb(uv + vec2(-o.x,  o.y))
                + sampleYuvRgb(uv + vec2( o.x,  o.y))) * 0.2;
        }
        """
      )
    }
    // sharpen is an unsharp mask wrapping soften's output; at amount 0, c + 0.0 * (c - b) is exactly c.
    val softSrc = if (soften != null) "sampleSoft" else "sampleYuvRgb"
    val sharpen = profile.stages.withIndex().firstOrNull { it.value.type == "sharpen" }
    if (sharpen != null) {
      val i = sharpen.index
      sb.append(
        """
        vec3 sampleSharp(vec2 uv) {
          vec2 o = (u_s${i}_radius * uRefScale) / uFrameSize;
          vec3 c = $softSrc(uv);
          vec3 b = ($softSrc(uv + vec2(-o.x, 0.0))
                  + $softSrc(uv + vec2( o.x, 0.0))
                  + $softSrc(uv + vec2( 0.0, -o.y))
                  + $softSrc(uv + vec2( 0.0,  o.y))) * 0.25;
          return c + u_s${i}_amount * (c - b);
        }
        """
      )
    }
    // Styled source sampler; the clean output always uses the single un-softened tap.
    val src = if (sharpen != null) "sampleSharp" else softSrc
    sb.append("void main() {\n  vec3 rgb;\n")

    // chromaticAberration must resample the source, so it wraps the initial sample.
    val ca = profile.stages.withIndex().firstOrNull { it.value.type == "chromaticAberration" }
    if (ca != null) {
      val i = ca.index
      sb.append(
        """
        {
          vec2 dir = vUv - 0.5;
          vec2 off = dir * (u_s${i}_shift * uRefScale) / uFrameSize;
          if (uStyled == 1) {
            rgb = vec3($src(vUv + off).r, $src(vUv).g, $src(vUv - off).b);
          } else {
            rgb = sampleYuvRgb(vUv);
          }
        }
        """
      )
    } else if (src != "sampleYuvRgb") {
      sb.append("  if (uStyled == 1) { rgb = $src(vUv); } else { rgb = sampleYuvRgb(vUv); }\n")
    } else {
      sb.append("  rgb = sampleYuvRgb(vUv);\n")
    }

    sb.append("  if (uStyled == 1) {\n")
    // LUT applies to gamma-encoded display-referred RGB.
    if (profile.lutSize > 0) {
      sb.append(
        """
        {
          vec3 lc = rgb * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
          rgb = mix(rgb, texture(uLut, lc).rgb, uLutMix);
        }
        """
      )
    }
    profile.stages.forEachIndexed { i, st ->
      when (st.type) {
        "vignette" -> sb.append(
          """
          {
            vec2 d = vUv - 0.5;
            // edge0 < edge1 is required: smoothstep with reversed edges is undefined (GLSL ES 3.00 §8.3).
            float vig = 1.0 - smoothstep(
              u_s${i}_radius - u_s${i}_softness,
              u_s${i}_radius + max(u_s${i}_softness, 1e-4),
              length(d));
            rgb *= mix(1.0 - u_s${i}_strength, 1.0, vig);
          }
          """
        )
        "grain" -> sb.append(
          """
          {
            vec2 gUv = floor(vUv * uFrameSize / (u_s${i}_size * uRefScale));
            float g = hash12(gUv) - 0.5;
            float shadow = 1.0 - smoothstep(0.0, 0.6, dot(rgb, vec3(0.333)));
            rgb += g * u_s${i}_opacity * (1.0 - u_s${i}_shadowBias + u_s${i}_shadowBias * shadow);
          }
          """
        )
        "levels" -> sb.append(
          """
          {
            rgb = clamp((rgb - u_s${i}_inBlack) / max(u_s${i}_inWhite - u_s${i}_inBlack, 1e-4), 0.0, 1.0);
            rgb = pow(rgb, vec3(1.0 / max(u_s${i}_gamma, 1e-3)));
            rgb = mix(vec3(u_s${i}_outBlack), vec3(u_s${i}_outWhite), rgb);
          }
          """
        )
        // Warmth/tint as channel gains, so temperature 0 and tint 0 are multiplies by exactly 1.0.
        "temperatureTint" -> sb.append(
          """
          {
            rgb.r *= 1.0 + 0.25 * u_s${i}_temperature;
            rgb.b *= 1.0 - 0.25 * u_s${i}_temperature;
            rgb.g *= 1.0 - 0.15 * u_s${i}_tint;
            rgb.r *= 1.0 + 0.07 * u_s${i}_tint;
            rgb.b *= 1.0 + 0.07 * u_s${i}_tint;
          }
          """
        )
        // Around BT.601 luma — the same basis the YUV decode and every LUT here use.
        "saturation" -> sb.append(
          """
          {
            float sy = dot(rgb, vec3(0.299, 0.587, 0.114));
            rgb = mix(vec3(sy), rgb, u_s${i}_amount);
          }
          """
        )
        // mix(pivot, rgb, amount), not (rgb - pivot) * amount + pivot: only the first is an
        // EXACT identity at amount 1.0.
        "contrast" -> sb.append(
          """
          {
            rgb = mix(vec3(u_s${i}_pivot), rgb, u_s${i}_amount);
          }
          """
        )
        // Highlight bloom with a warm cast. It rings the SOURCE (through the same sample chain),
        // because a fragment shader cannot read its neighbours' graded values in one pass.
        "halation" -> sb.append(
          """
          {
            vec2 ho = (u_s${i}_radius * uRefScale) / uFrameSize;
            vec3 glow = vec3(0.0);
            for (int k = 0; k < 8; k++) {
              float ha = float(k) * 0.7853981634;
              vec3 hs = $src(vUv + vec2(cos(ha), sin(ha)) * ho);
              glow += max(hs - u_s${i}_threshold, 0.0);
            }
            glow *= 0.125 / max(1.0 - u_s${i}_threshold, 1e-3);
            rgb += u_s${i}_strength * glow * vec3(1.0, 0.55, 0.35);
          }
          """
        )
        // Width is a fraction of the SHORT edge, so all four sides are equally thick. At width 0
        // every fragment centre is strictly inside the frame, so both steps are 0 and the mix is
        // an exact identity.
        "border" -> sb.append(
          """
          {
            vec2 bpx = abs(vUv - 0.5) * uFrameSize;
            vec2 bedge = uFrameSize * 0.5 - u_s${i}_width * min(uFrameSize.x, uFrameSize.y);
            float onBorder = max(step(bedge.x, bpx.x), step(bedge.y, bpx.y));
            rgb = mix(rgb, vec3(u_s${i}_red, u_s${i}_green, u_s${i}_blue), onBorder);
          }
          """
        )
        "chromaticAberration", "resolutionSoften", "sharpen" -> { /* handled at sample time above */ }
      }
    }
    sb.append("  }\n")
    // Ordered 8x8 Bayer dither, +/-0.5 LSB, final op for BOTH outputs.
    sb.append(
      """
      int bx = int(mod(gl_FragCoord.x, 8.0));
      int by = int(mod(gl_FragCoord.y, 8.0));
      float bayer = (BAYER8[by * 8 + bx] + 0.5) / 64.0 - 0.5;
      rgb += bayer / 255.0;
      fragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
    }
    """
    )
    return sb.toString()
  }

  /** For saved JPEGs (already RGB and upright): the same look stages with an RGB sampler in place
   * of the YUV one. Capture shaders are unaffected. */
  fun editedFragmentSrc(profile: Profile): String = fragmentSrc(profile).replace(YUV_GLSL, """
      uniform sampler2D uTexRgb;
      vec3 sampleYuvRgb(vec2 uv) { return texture(uTexRgb, uv).rgb; }
  """)

  /**
   * The shader-dependent half of a capture_pipeline_id, split out so the renderer can reuse it
   * while only parameter values change.
   */
  fun shaderGraphDigest(fragmentSource: String, lutDigest: String): String =
    Profile.sha256Hex(
      (fragmentSource + "|vs:" + VERTEX_SRC + "|lut:" + lutDigest).toByteArray(),
    ).substring(0, 12)

  /** capture_pipeline_id = sp/<rendererVersion>/<shaderGraphSha12>/<profileId>@<ver>/<calibrationId> */
  fun pipelineId(profile: Profile, graphDigest: String): String =
    "sp/$RENDERER_VERSION/$graphDigest/${profile.profileId}@${profile.profileVersion}/cal-none"

  fun capturePipelineId(profile: Profile, fragmentSource: String): String =
    pipelineId(profile, shaderGraphDigest(fragmentSource, profile.lutDigest))
}
