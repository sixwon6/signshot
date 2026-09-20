import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * `chromaSmear`, with no device: a 1-D scan-line simulator of the stage as `ShaderGen.kt` emits it.
 *
 *   1. the kernel: tap count and weights PARSED out of the Kotlin, so there is one source for them;
 *   2. what the stage is: luma untouched, an exact identity at amount 0, a chroma transition of
 *      about `width` that is far wider than luma's, delayed rightward by `shift`;
 *   3. resolution independence: the same transition, in reference pixels, at preview and still size;
 *   4. the decode constants duplicated from YUV_GLSL, and the scan-axis table in GlRenderer.kt;
 *   5. that a profile WITHOUT the stage emits none of it.
 *
 * Consumer analog video carries chroma at roughly a tenth of luma's bandwidth (VHS ~0.3-0.5 MHz
 * against ~3 MHz), so colour bleeds along the scan line while luma detail survives, with a slight
 * rightward chroma delay. That is what the numbers below are holding on to.
 *
 * The simulator is the shader: Y at W texels and U/V at W/2, LINEAR and CLAMP_TO_EDGE, sampled 1:1
 * at output texel centres, decoded with the constants read out of `ShaderGen.kt`. W is the scan
 * axis and the long edge, so uRefScale is W/4000.
 *
 * (5) is structural — node cannot run Kotlin. It was also checked directly, once, by compiling
 * ShaderGen.kt before and after this stage against a stub Profile on the JVM (kotlin-compiler-
 * embeddable from the gradle cache) and diffing `fragmentSrc` + `editedFragmentSrc` + the pipeline
 * digest for ten stage graphs, the three shipping looks among them: 61173 bytes, identical.
 */

if (!process.argv.includes("--worker")) {
  const result = spawnSync(process.execPath,
    ["--import", "tsx", "--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), "--worker"],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_ENV: "test" } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  process.stdout.write(result.stdout);
} else {
  const { STAGES } = await import("../src/recipes/model.ts");
  const { STARTERS } = await import("../src/recipes/starters.ts");

  const root = new URL("../", import.meta.url);
  const kt = (name) => readFileSync(
    new URL(`modules/seeker-camera/android/src/main/java/expo/modules/seekercamera/${name}`, root), "utf8");
  const SHADER_GEN = kt("ShaderGen.kt");
  const GL_RENDERER = kt("GlRenderer.kt");

  /** The body of a `""" ... """` raw string that follows `marker`. */
  function rawString(source, marker) {
    const open = source.indexOf(marker);
    assert.notEqual(open, -1, `ShaderGen.kt no longer has ${marker}`);
    const from = open + marker.length;
    const close = source.indexOf('"""', from);
    assert.notEqual(close, -1, `${marker} raw string is unterminated`);
    return source.slice(from, close);
  }
  const numbersIn = (text) => (text.match(/\d+\.\d+/g) ?? []).map(Number);

  // =====================================================================================
  // 1. The kernel, out of the Kotlin
  // =====================================================================================
  const listed = SHADER_GEN.match(/private val SMEAR_WEIGHTS = listOf\(([\s\S]*?)\)/);
  assert.ok(listed, "ShaderGen.kt no longer declares SMEAR_WEIGHTS");
  const W = [...listed[1].matchAll(/"([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(W.length >= 3, "the kernel needs a centre and at least two taps a side");
  const HALF = W.length - 1;
  const TAPS = 2 * HALF + 1;
  assert.ok(W.every((w) => Number.isFinite(w) && w > 0), "every weight is a positive number");

  const sum = W[0] + 2 * W.slice(1).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `the ${TAPS} weights sum to ${sum}, not 1`);
  // Gaussian, sigma = width/2.5, tap k at k*width/HALF reference pixels: k*2.5/HALF sigma.
  const raw = Array.from({ length: HALF + 1 }, (_, k) => Math.exp(-(((2.5 * k) / HALF) ** 2) / 2));
  const norm = raw[0] + 2 * raw.slice(1).reduce((a, b) => a + b, 0);
  W.forEach((w, k) => assert.ok(Math.abs(w - raw[k] / norm) < 1e-7,
    `weight ${k} is ${w}, not the Gaussian ${(raw[k] / norm).toFixed(8)}`));
  W.slice(1).forEach((w, k) => assert.ok(w < W[k], "the weights fall away from the centre"));
  // The wrapper, line by line, so the simulator below is running what the shader runs. The one
  // thing that cannot be re-derived — which way `shift` displaces the chroma — is read off here.
  for (const line of [
    "vec2 px = uScanAxis * uRefScale / uFrameSize;",
    "vec2 stp = px * (u_s${i}_width / ${SMEAR_HALF_TAPS}.0);",
    "vec3 d = c - dot(c, vec3(0.299, 0.587, 0.114));",
    "vec3 s = SMEAR_W[0] * sampleChroma(at);",
    "for (int k = 1; k <= $SMEAR_HALF_TAPS; k++) {",
    "s += SMEAR_W[k] * (sampleChroma(at + stp * float(k)) + sampleChroma(at - stp * float(k)));",
    "return c + u_s${i}_amount * (s - d);",
    "private val SMEAR_HALF_TAPS = SMEAR_WEIGHTS.size - 1",
  ]) assert.ok(SHADER_GEN.includes(line), `sampleSmear no longer reads '${line}'`);
  const delay = SHADER_GEN.match(/vec2 at = uv ([+-]) px \* u_s\$\{i\}_shift;/);
  assert.ok(delay, "sampleSmear no longer offsets the chroma read by shift");
  // Sampling `shift` to the LEFT is what carries the chroma to the right.
  const DIRECTION = delay[1] === "-" ? -1 : 1;

  // =====================================================================================
  // 2. The decode constants, duplicated from YUV_GLSL, and the scan-axis table
  // =====================================================================================
  const yuv = rawString(SHADER_GEN, "private const val YUV_GLSL = \"\"\"");
  const smearYuv = rawString(SHADER_GEN, "private const val SMEAR_CHROMA_YUV = \"\"\"");
  // 0.0 and 1.0 are YUV_GLSL's clamp, not colour science.
  const decode = numbersIn(yuv).filter((n) => n !== 0 && n !== 1);
  const offset = decode[0];
  assert.deepEqual(decode, [offset, offset, 1.402, 0.3441363, 0.7141363, 1.772],
    "YUV_GLSL is not the BT.601 full-range decode this stage was written against");
  assert.deepEqual(numbersIn(smearYuv), decode,
    "sampleChroma's constants must be YUV_GLSL's, in the same order");
  const [, , C_R, C_GU, C_GV, C_B] = decode;
  const W601 = numbersIn(rawString(SHADER_GEN, "private const val SMEAR_CHROMA_RGB = \"\"\""));
  assert.deepEqual(W601, [0.299, 0.587, 0.114], "the RGB form projects out BT.601 luma");

  // The upright picture's rightward direction in source uv, re-derived from VERTEX_SRC: uv is
  // (x right, y down) at rotation 0, and 90/180/270 rewrite it to (uv.y, 1-uv.x) / (1-uv.x, 1-uv.y)
  // / (1-uv.y, uv.x), whose derivative along rightward is (0,-1) / (-1,0) / (0,1).
  const vertex = rawString(SHADER_GEN, "const val VERTEX_SRC = \"\"\"");
  for (const [test, form] of [[90, "uv = vec2(uv.y, 1.0 - uv.x)"], [180, "uv = vec2(1.0 - uv.x, 1.0 - uv.y)"],
    [270, "uv = vec2(1.0 - uv.y, uv.x)"]]) {
    assert.ok(vertex.includes(form), `VERTEX_SRC's rotation ${test} is no longer ${form}`);
  }
  for (const [rotation, axis] of [["90", "0f, -1f"], ["180", "-1f, 0f"], ["270", "0f, 1f"], ["else", "1f, 0f"]]) {
    assert.ok(GL_RENDERER.includes(`${rotation} -> GLES30.glUniform2f(uni("uScanAxis"), ${axis})`),
      `GlRenderer's scan axis at rotation ${rotation} must be (${axis})`);
  }
  assert.ok(GL_RENDERER.includes("scanRotation = (rotationDegrees + deviceDegrees) % 360"),
    "the preview's scan axis must follow sensor + physical device rotation, not the sensor alone");

  // =====================================================================================
  // 3. A profile without the stage emits none of it
  // =====================================================================================
  {
    // Everything smear is inside the `if (smear != null)` append, the two SMEAR_CHROMA_* constants
    // and editedFragmentSrc's second replace. Cut those out; nothing may be left.
    const open = SHADER_GEN.indexOf("    if (smear != null) {");
    assert.notEqual(open, -1, "the smear emission is no longer a single guarded block");
    let depth = 0, end = open;
    for (let i = SHADER_GEN.indexOf("{", open); i < SHADER_GEN.length; i++) {
      if (SHADER_GEN[i] === "{") depth++;
      else if (SHADER_GEN[i] === "}" && --depth === 0) { end = i + 1; break; }
    }
    // And the wiring the guard turns on: the chain's top falls back to `src` when it is off.
    const TOP = 'val top = if (smear != null) "sampleSmear" else src';
    assert.ok(SHADER_GEN.includes(TOP),
      "the sample chain's top must fall back to src exactly when the stage is absent");
    const rest = (SHADER_GEN.slice(0, open) + SHADER_GEN.slice(end))
      .replace(/private const val SMEAR_CHROMA_(YUV|RGB) = """[\s\S]*?"""/g, "")
      .replace(/\.replace\(SMEAR_CHROMA_YUV, SMEAR_CHROMA_RGB\)/, "")
      .replace(TOP, "")
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    for (const token of ["sampleSmear", "sampleChroma", "uScanAxis", "SMEAR_W["]) {
      assert.ok(!rest.includes(token),
        `'${token}' is emitted outside the chromaSmear block: every existing shader would change`);
    }
    // Halation stays on the pre-smear source.
    assert.ok(SHADER_GEN.includes("vec3 hs = $src(vUv + vec2(cos(ha), sin(ha)) * ho);"),
      "halation must keep ringing the pre-smear source");
    assert.ok(SHADER_GEN.includes("rgb = vec3($top(vUv + off).r, $top(vUv).g, $top(vUv - off).b);"),
      "chromatic aberration must read through the smear");
  }

  // =====================================================================================
  // 4. The simulator
  // =====================================================================================
  const REF_LONG_EDGE = 4000;
  const luma = (c) => W601[0] * c[0] + W601[1] * c[1] + W601[2] * c[2];
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  /** A saturated red against a cyan of similar luma; both inside the 8-bit YUV gamut. */
  const LEFT = [0.9, 0.05, 0.05];
  const RIGHT = [0.05, 0.45, 0.62];

  /**
   * Y/U/V planes for an edge one luma texel wide, chroma at half that. The edge sits on a chroma
   * texel boundary, so luma and chroma cross 50 % at the same place and any delay measured below
   * is the stage's, not the sampling grid's.
   */
  function planes(width) {
    const at = width / 2;
    const mix = (x) => clamp01(x - at + 0.5);
    const encode = (t) => {
      const c = LEFT.map((v, k) => v + (RIGHT[k] - v) * t);
      const y = luma(c);
      return [y, (c[2] - y) / C_B + offset, (c[0] - y) / C_R + offset];
    };
    const Y = Array.from({ length: width }, (_, i) => encode(mix(i + 0.5))[0]);
    const U = Array.from({ length: width / 2 }, (_, j) => encode(mix(2 * j + 1))[1]);
    const V = Array.from({ length: width / 2 }, (_, j) => encode(mix(2 * j + 1))[2]);
    return { Y, U, V };
  }

  /** GL_LINEAR + GL_CLAMP_TO_EDGE at uv = x/width, for a plane of `n` texels. */
  function tap(plane, n, x, width) {
    const t = (x / width) * n - 0.5;
    const i = Math.floor(t), f = t - i;
    const at = (k) => plane[k < 0 ? 0 : k > n - 1 ? n - 1 : k];
    return at(i) + (at(i + 1) - at(i)) * f;
  }

  /** The stage exactly as `sampleSmear` runs it, on one scan line of `width` texels. */
  function scan(width, { amount, width: kernel, shift }) {
    const { Y, U, V } = planes(width);
    const refScale = width / REF_LONG_EDGE;
    const chroma = (x) => {
      const u = tap(U, width / 2, x, width) - offset;
      const v = tap(V, width / 2, x, width) - offset;
      return [C_R * v, -C_GU * u - C_GV * v, C_B * u];
    };
    const source = (x) => {
      const y = tap(Y, width, x, width);
      const u = tap(U, width / 2, x, width) - offset;
      const v = tap(V, width / 2, x, width) - offset;
      return [y + C_R * v, y - C_GU * u - C_GV * v, y + C_B * u].map(clamp01);
    };
    const out = [], src = [];
    for (let i = 0; i < width; i++) {
      const x = i + 0.5;
      const c = source(x);
      const yc = luma(c);
      const d = c.map((v) => v - yc);
      const at = x + DIRECTION * shift * refScale;
      const step = (kernel / HALF) * refScale;
      const s = chroma(at).map((v) => W[0] * v);
      for (let k = 1; k <= HALF; k++) {
        const p = chroma(at + step * k), m = chroma(at - step * k);
        for (let ch = 0; ch < 3; ch++) s[ch] += W[k] * (p[ch] + m[ch]);
      }
      src.push(c);
      out.push(c.map((v, ch) => v + amount * (s[ch] - d[ch])));
    }
    return { out, src, refScale };
  }

  /** Where a monotone profile crosses `level` of its plateau-to-plateau swing, in texels. */
  function crossing(values, level) {
    const lo = values[Math.round(values.length * 0.15)];
    const hi = values[Math.round(values.length * 0.85)];
    const target = lo + (hi - lo) * level;
    const rising = hi > lo;
    for (let i = 1; i < values.length; i++) {
      const a = values[i - 1], b = values[i];
      if ((rising && a <= target && target <= b) || (!rising && a >= target && target >= b)) {
        return a === b ? i - 0.5 : i - 0.5 + (target - a) / (b - a);
      }
    }
    return NaN;
  }
  /** 10-90 % rise and 50 % crossing, both in reference pixels. */
  function edge(values, refScale) {
    const rise = Math.abs(crossing(values, 0.9) - crossing(values, 0.1)) / refScale;
    return { rise, mid: crossing(values, 0.5) / refScale };
  }

  // ---- The Camcorder's curves, or the proposed ones until the look carries the stage.
  const PROPOSED = {
    type: "chromaSmear", scaling: "reference-pixel",
    params: { amount: 0, width: 24, shift: 4 },
    intensityCurve: { amount: [[0, 0], [60, 0.9], [100, 1]], width: [[0, 0], [60, 20], [100, 28]] },
  };
  const camcorder = STARTERS.find((r) => r.id === "rec.camcorder");
  const stage = camcorder?.manifest.stages.find((s) => s.type === "chromaSmear") ?? PROPOSED;
  const shipped = stage !== PROPOSED;
  function evalCurve(curve, fallback, at) {
    if (!curve || curve.length === 0) return fallback;
    if (at <= curve[0][0]) return curve[0][1];
    for (let i = 1; i < curve.length; i++) {
      const [x1, y1] = curve[i - 1], [x2, y2] = curve[i];
      if (at <= x2) return x2 === x1 ? y2 : y1 + (y2 - y1) * ((at - x1) / (x2 - x1));
    }
    return curve[curve.length - 1][1];
  }
  const at = (strength) => Object.fromEntries(["amount", "width", "shift"].map((p) =>
    [p, evalCurve(stage.intensityCurve?.[p], stage.params[p] ?? 0, strength)]));

  const spec = STAGES.find((s) => s.type === "chromaSmear");
  assert.ok(spec, "src/recipes/model.ts has no chromaSmear stage");
  assert.equal(spec.sampleTime, true);
  assert.equal(spec.scaling, "reference-pixel");
  for (const strength of [60, 100]) {
    const p = at(strength);
    for (const [name, value] of Object.entries(p)) {
      const s = spec.params.find((q) => q.param === name);
      assert.ok(value >= s.min && value <= s.max, `camcorder ${name} ${value} is outside ${s.min}..${s.max}`);
    }
    assert.ok(p.width >= 12 && p.width <= 36, `camcorder width at ${strength} is ${p.width}, outside 12..36`);
    assert.ok(p.shift >= 0, "the chroma delay is rightward only");
  }
  assert.ok(at(100).amount >= at(60).amount && at(100).width >= at(60).width,
    "amount and width grow with strength");

  // ---- What the stage is. The widths span the declared range, not just the look's.
  const PREVIEW = 1440, STILL = 3264;
  const report = [];
  const ceiling = spec.params.find((p) => p.param === "width").max;
  // The declared range, its ceiling, and the two the look actually asks for.
  const WIDTHS = [...new Set([12, 24, 36, ceiling, at(60).width, at(100).width])].sort((a, b) => a - b);
  for (const kernel of WIDTHS) {
    const shift = at(100).shift;
    const seen = {};
    for (const [label, frame] of [["preview", PREVIEW], ["still", STILL]]) {
      const { out, src, refScale } = scan(frame, { amount: 1, width: kernel, shift });

      // Luma is the chain's, untouched: sampleChroma carries no luma and d carries none either.
      const dY = Math.max(...out.map((c, i) => Math.abs(luma(c) - luma(src[i]))));
      assert.ok(dY < 1e-6, `${label} w${kernel}: the stage moved luma by ${dY}`);

      // Amount 0 is an exact identity: c + 0.0 * (s - d) is c.
      const off = scan(frame, { amount: 0, width: kernel, shift });
      off.out.forEach((c, i) => c.forEach((v, ch) =>
        assert.equal(v, off.src[i][ch], `${label} w${kernel}: amount 0 is not an identity`)));

      // R-Y against luma: the chroma transition against the one the picture keeps.
      const c = edge(out.map((v) => v[0] - luma(v)), refScale);
      const y = edge(src.map(luma), refScale);
      seen[label] = c.rise;
      report.push(`  w${String(kernel).padStart(4)} ${label.padEnd(7)} chroma rise ${c.rise.toFixed(1).padStart(5)} px`
        + `  luma rise ${y.rise.toFixed(1)} px  x${(c.rise / y.rise).toFixed(1)}`
        + `  delay ${(c.mid - y.mid).toFixed(2)} px  taps ${((kernel / HALF) * refScale / 2).toFixed(2)} chroma texels`);

      assert.ok(c.rise > kernel * 0.95 && c.rise < kernel * 1.25,
        `${label} w${kernel}: the chroma rise is ${c.rise.toFixed(1)} px, not about ${kernel}`);
      assert.ok(c.rise >= 3 * y.rise,
        `${label} w${kernel}: chroma rises ${(c.rise / y.rise).toFixed(1)}x luma, not 3x — luma is not staying sharp`);
      assert.ok(Math.abs(c.mid - y.mid - shift) <= 1,
        `${label} w${kernel}: chroma trails luma by ${(c.mid - y.mid).toFixed(2)} px, not ${shift}`);
      assert.ok(c.mid > y.mid, "the chroma delay must be rightward");
    }
    // Resolution independence: the same transition in reference pixels at both sizes.
    const drift = Math.abs(seen.preview - seen.still) / seen.still;
    assert.ok(drift < 0.12,
      `w${kernel}: preview and still disagree by ${(drift * 100).toFixed(1)} % (${seen.preview.toFixed(1)} vs ${seen.still.toFixed(1)} px)`);
  }

  // ---- Tap spacing. Gap-free sampling wants consecutive taps within 2 chroma texels, since a
  // LINEAR fetch reaches one texel each way and a chroma texel is two luma pixels. The shipping
  // look holds that at full size; the slider's ceiling is allowed a little past it, where the
  // chroma being sampled is already smooth. Fewer taps spaces them out, so both fail together.
  const texels = (kernel, frame) => (kernel / HALF) * (frame / REF_LONG_EDGE) / 2;
  const limit = (2 * 2 * HALF * REF_LONG_EDGE) / STILL;
  for (const strength of [60, 100]) {
    const w = at(strength).width;
    assert.ok(texels(w, STILL) <= 2,
      `the look's width at ${strength} (${w} px) samples every ${texels(w, STILL).toFixed(2)} chroma texels at ${STILL} px`);
  }
  assert.ok(texels(ceiling, STILL) <= 2.5,
    `width's ceiling (${ceiling} px) samples every ${texels(ceiling, STILL).toFixed(2)} chroma texels at ${STILL} px`
    + ` with ${TAPS} taps — lower the ceiling to ${(2.5 * 2 * HALF * REF_LONG_EDGE / STILL).toFixed(1)}`);

  // =====================================================================================
  console.log(`smear ok — ${TAPS} taps summing to 1; luma untouched and an exact identity at amount 0;`
    + ` a chroma transition of about width, over 3x luma's, delayed rightward by shift;`
    + ` preview and still agree within 12 %; the decode constants match YUV_GLSL;`
    + ` no shader without the stage names it`
    + (shipped ? "" : " (Camcorder does not carry the stage yet: the proposed curves were used)"));
  console.log(report.join("\n"));
  console.log(`  taps stay within 2 chroma texels at ${STILL} px up to width ${limit.toFixed(1)} px`
    + ` (${TAPS} taps); the slider stops at ${ceiling}, ${texels(ceiling, STILL).toFixed(2)} texels apart`);
}
