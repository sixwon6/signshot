import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mock } from "node:test";

/**
 * The built-in looks, with no device.
 *
 *   1. what ships: ids, names, picker order, and Clean pinned byte for byte;
 *   2. what each look IS: reference colours pushed through the real LUT and `levels` stage at the
 *      default strength and at full, held to the numbers that define that camera, and to one
 *      strength law shared by all of them;
 *   3. what was retired: still resolvable by id, exactly as it shipped;
 *   4. the store's carry-forward of what was saved against a retired starter.
 *
 * The renderer here is the centre of the frame with no noise: the LUT sampled trilinearly the way
 * `ShaderGen.kt` samples it, mixed by `intensity.lutMix`, then the pointwise stages in manifest
 * order. Vignette, grain, softening and sharpening do not move a flat patch at the centre.
 *
 * AsyncStorage is replaced by a Map. `mock.module` needs --experimental-test-module-mocks, so the
 * checks run in a worker started with it (the pattern `check-capture-hook.mjs` uses).
 */

if (!process.argv.includes("--worker")) {
  const result = spawnSync(process.execPath,
    ["--experimental-test-module-mocks", "--disable-warning=ExperimentalWarning", "--import", "tsx",
      fileURLToPath(import.meta.url), "--worker"],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_ENV: "test" } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  process.stdout.write(result.stdout);
} else {
  const require = createRequire(import.meta.url);

  // ---- Storage: a Map that counts its writes and can be made to fail.
  const storage = { items: new Map(), writes: 0, failReads: false, failWrites: false };
  const AsyncStorage = {
    getItem: async (key) => {
      if (storage.failReads) throw new Error("storage unavailable");
      return storage.items.has(key) ? storage.items.get(key) : null;
    },
    setItem: async (key, value) => {
      if (storage.failWrites) throw new Error("storage full");
      storage.writes++;
      storage.items.set(key, value);
    },
  };
  mock.module(pathToFileURL(require.resolve("@react-native-async-storage/async-storage")).href,
    { defaultExport: AsyncStorage });

  const { STARTERS, DEFAULT_RECIPE_ID, DEFAULT_STRENGTH, starterById } = await import("../src/recipes/starters.ts");
  const { RETIRED_NAMES, RETIRED_SUCCESSOR, isRetired, retiredById } = await import("../src/recipes/retired.ts");
  const { validateRecipe, sameLook, setParam } = await import("../src/recipes/model.ts");
  const store = await import("../src/recipes/store.ts");

  const sha256 = (text) => createHash("sha256").update(text).digest("hex");

  // =====================================================================================
  // 1. What ships
  // =====================================================================================
  assert.deepEqual(STARTERS.map((r) => [r.id, r.name]), [
    ["prof.neutral", "Clean"],
    ["rec.digicam", "Digicam"],
    ["rec.disposable", "Disposable"],
    ["rec.camcorder", "Camcorder"],
  ], "the built-ins, in picker order");
  assert.equal(DEFAULT_RECIPE_ID, "prof.neutral");
  assert.equal(DEFAULT_STRENGTH, 0.6, "the default strength stays 60");
  for (const recipe of STARTERS) {
    validateRecipe(recipe);
    assert.equal(recipe.builtIn, true);
    assert.equal(recipe.id, recipe.manifest.profileId);
    assert.equal(recipe.manifest.profileVersion, 1, `${recipe.id} is a new id at version 1`);
    assert.equal(isRetired(recipe.id), false, `${recipe.id} must not reuse a retired id`);
    assert.ok(!/\s/.test(recipe.name), `${recipe.name}: one word, so a chip never breaks it`);
    assert.equal(starterById(recipe.id), recipe);
  }
  // Clean's capture_pipeline_id hangs on these bytes. This is the manifest as it was at HEAD 99f7d34.
  assert.equal(JSON.stringify(STARTERS[0].manifest),
    '{"schema":1,"profileId":"prof.neutral","profileVersion":1,"rendererMin":"0.2.0","stages":[]}',
    "Clean's manifest is pinned byte for byte");
  assert.equal(STARTERS[0].lut, null);

  // =====================================================================================
  // 2. What each look is
  // =====================================================================================
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const lutBytes = new Map();
  const decoded = (recipe) => {
    if (!lutBytes.has(recipe.lut)) lutBytes.set(recipe.lut, new Uint8Array(Buffer.from(recipe.lut, "base64")));
    return lutBytes.get(recipe.lut);
  };
  /** texture(uLut, rgb*((N-1)/N) + 0.5/N) with GL_LINEAR: trilinear between texel centres. */
  function sampleLut(lut, size, c) {
    const p = c.map((v) => clamp01(v) * (size - 1));
    const i0 = p.map((v) => Math.min(size - 2, Math.floor(v)));
    const f = p.map((v, k) => v - i0[k]);
    const at = (r, g, b, ch) => lut[((b * size + g) * size + r) * 4 + ch] / 255;
    return [0, 1, 2].map((ch) => {
      let sum = 0;
      for (let db = 0; db < 2; db++) for (let dg = 0; dg < 2; dg++) for (let dr = 0; dr < 2; dr++)
        sum += (dr ? f[0] : 1 - f[0]) * (dg ? f[1] : 1 - f[1]) * (db ? f[2] : 1 - f[2])
          * at(i0[0] + dr, i0[1] + dg, i0[2] + db, ch);
      return sum;
    });
  }
  /** `Profile.kt#evalCurve`. */
  function evalCurve(curve, fallback, at) {
    if (!curve || curve.length === 0) return fallback;
    if (at <= curve[0][0]) return curve[0][1];
    for (let i = 1; i < curve.length; i++) {
      const [x1, y1] = curve[i - 1], [x2, y2] = curve[i];
      if (at <= x2) return x2 === x1 ? y2 : y1 + (y2 - y1) * ((at - x1) / (x2 - x1));
    }
    return curve[curve.length - 1][1];
  }
  const POINTWISE = new Set(["levels", "temperatureTint", "saturation", "contrast"]);
  const SPATIAL = new Set(["resolutionSoften", "sharpen", "chromaticAberration", "chromaSmear", "halation", "vignette", "grain", "border"]);
  function render(recipe, strength, rgb8) {
    let rgb = rgb8.map((v) => v / 255);
    const m = recipe.manifest;
    if (recipe.lut) {
      const mix = evalCurve(m.intensity?.lutMix, 1, strength);
      const graded = sampleLut(decoded(recipe), m.lut.size, rgb);
      rgb = rgb.map((v, k) => v + (graded[k] - v) * mix);
    }
    for (const stage of m.stages) {
      const P = (name) => evalCurve(stage.intensityCurve?.[name], stage.params[name] ?? 0, strength);
      if (stage.type === "levels") {
        rgb = rgb.map((v) => {
          const x = clamp01((v - P("inBlack")) / Math.max(P("inWhite") - P("inBlack"), 1e-4));
          return P("outBlack") + (P("outWhite") - P("outBlack")) * Math.pow(x, 1 / Math.max(P("gamma"), 1e-3));
        });
      } else {
        // A pointwise stage this check cannot render would make every number below a lie.
        assert.ok(!POINTWISE.has(stage.type), `${recipe.id}: teach this check the '${stage.type}' stage`);
        assert.ok(SPATIAL.has(stage.type), `${recipe.id}: unknown stage '${stage.type}'`);
      }
    }
    return rgb.map(clamp01);
  }
  const linear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  function lab(c) {
    const [r, g, b] = c.map(linear);
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const a = 500 * (f(X) - f(Y)), bb = 200 * (f(Y) - f(Z));
    return { L: 116 * f(Y) - 16, a, b: bb, C: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
  }
  const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

  const PATCH = {
    lightSkin: [194, 150, 130], darkSkin: [115, 82, 68], chartSky: [98, 122, 157], deepSky: [70, 130, 200],
    foliage: [87, 108, 67], grass: [110, 160, 60], chartRed: [175, 54, 60], satRed: [225, 30, 35],
  };
  /**
   * Three colours off the room the looks were measured in on 2026-09-20, as the fixed camera read
   * them with no look on: a white wall in cool window light, a navy throw in shadow, a mustard
   * cushion. A look's own claim about contrast, cast and colour is a claim about these.
   */
  const SCENE = { wall: [159, 186, 202], navy: [56, 66, 73], mustard: [123, 96, 62] };
  const sat = (c) => { const mx = Math.max(...c), mn = Math.min(...c); return mx > 0 ? (mx - mn) / mx : 0; };
  /** wall/navy/mustard after the look, and each one's move away from the camera's own reading. */
  function scene(recipe, strength) {
    const out = {};
    for (const [name, rgb8] of Object.entries(SCENE)) {
      const before = rgb8.map((v) => v / 255), after = render(recipe, strength, rgb8);
      out[name] = {
        rgb: after.map((v) => v * 255),
        dLuma: (luma(after) - luma(before)) * 255,
        dBlueRed: (after[2] - after[0] - (before[2] - before[0])) * 255,
        satRatio: sat(after) / sat(before),
      };
    }
    return out;
  }
  /** Everything the targets are written in, for one look at one strength. */
  function measure(recipe, strength) {
    const grey = (v) => render(recipe, strength, [v, v, v]);
    const Y = (v) => luma(grey(v)) * 255;
    const chroma = {}, hue = {};
    for (const [name, rgb8] of Object.entries(PATCH)) {
      const before = lab(rgb8.map((v) => v / 255)), after = lab(render(recipe, strength, rgb8));
      chroma[name] = after.C / before.C;
      hue[name] = ((after.h - before.h + 540) % 360) - 180;
    }
    let clipFrom = 256;
    for (let v = 255; v >= 0 && Y(v) > 254; v--) clipFrom = v;
    return {
      black: Y(0), white: Y(255), mid: Y(128),
      midLab: lab(grey(128)), toeLab: lab(grey(32)), whiteLab: lab(grey(255)),
      midSlope: (Y(140) - Y(115)) / 25, clipFrom, chroma, hue,
      meanChroma: Object.values(chroma).reduce((a, b) => a + b, 0) / Object.keys(chroma).length,
    };
  }
  const within = (value, low, high, what) =>
    assert.ok(value >= low && value <= high, `${what}: ${value.toFixed(3)} is outside ${low}..${high}`);

  const LOOKS = STARTERS.slice(1);
  const report = [];
  for (const recipe of LOOKS) {
    for (const strength of [60, 100]) {
      const m = measure(recipe, strength);
      const tag = `${recipe.name} @${strength}`;
      report.push(`  ${tag.padEnd(16)} black ${m.black.toFixed(1).padStart(5)}  mid ${m.mid.toFixed(1)}  white ${m.white.toFixed(1)}`
        + `  slope ${m.midSlope.toFixed(2)}  clip<${m.clipFrom}  mid a*${m.midLab.a.toFixed(1)} b*${m.midLab.b.toFixed(1)}`
        + `  C x${m.meanChroma.toFixed(2)} (skin ${m.chroma.lightSkin.toFixed(2)}/${m.chroma.darkSkin.toFixed(2)}`
        + ` sky ${m.chroma.chartSky.toFixed(2)} red ${m.chroma.chartRed.toFixed(2)}/${m.chroma.satRed.toFixed(2)})`);

      // ---- The family's caps. Full strength is meant to be heavier than the default, so the caps
      //      open up at 100; nothing may be overcooked at either.
      const full = strength === 100;
      within(m.black / 255, 0, full ? 0.1 : 0.07, `${tag} black lift`);
      within(m.white / 255, 0.92, 1, `${tag} white ceiling`);
      within(m.meanChroma, 0.85, full ? 1.55 : 1.32, `${tag} mean chroma`);
      within(m.mid - 128, -12, full ? 14 : 10, `${tag} mid-grey shift in levels`);
      within(m.chroma.darkSkin, 0.8, full ? 1.5 : 1.35, `${tag} dark skin chroma`);
      within(m.chroma.lightSkin, 0.8, full ? 1.5 : 1.35, `${tag} light skin chroma`);
      within(Math.abs(m.hue.lightSkin), 0, 8, `${tag} light skin hue shift`);
      within(Math.abs(m.hue.foliage), 0, 12, `${tag} foliage hue shift`);

      if (recipe.id === "rec.digicam") {
        within(Math.abs(m.midLab.b), 0, full ? 3 : 2.5, `${tag} neutral mids, not a tint (|b*|)`);
        within(Math.abs(m.midLab.a), 0, 1.5, `${tag} neutral mids, not a tint (|a*|)`);
        within(m.midSlope, full ? 1.3 : 1.2, full ? 1.7 : 1.5, `${tag} hard contrast`);
        within(m.clipFrom, 200, 244, `${tag} whites hit the wall early`);
        within(m.black, 0, 0.5, `${tag} blacks are black`);
        within(m.toeLab.a, -6, -1.5, `${tag} the white-balance miss is green and lives in the shadows`);
        within(m.meanChroma, 1.15, full ? 1.55 : 1.4, `${tag} punchy`);
        within(m.hue.chartSky, full ? -19 : -14, -4, `${tag} sky leans cyan`);
        within(m.chroma.chartSky, 1.15, full ? 1.8 : 1.6, `${tag} sky goes deeper`);
      }
      if (recipe.id === "rec.disposable") {
        // A drugstore print is contrasty, warm and saturated, and its blacks are dense. Measured on
        // the phone on 2026-09-20 the look was flatter than Clean and passed anyway, because the
        // targets here asked for a lifted black, a pulled-down white and a midtone slope of 1.0.
        within(m.black, 1.5, 6, `${tag} print black: paper, not a digital zero, and not a lift`);
        within(m.white, 244, 253, `${tag} paper white is creamy, not clipped and not pulled down`);
        within(m.whiteLab.b, 2, 9, `${tag} and it is warm`);
        within(m.midLab.b, 4, 12, `${tag} warm mids`);
        within(m.toeLab.a, -6, -1.5, `${tag} green-cyan toe`);
        within(m.meanChroma, full ? 1.2 : 1.1, full ? 1.55 : 1.32, `${tag} consumer stock is rich, not faded`);
        within(m.chroma.deepSky, 1.0, full ? 1.75 : 1.5, `${tag} the sky keeps its blue`);
        within(m.chroma.grass, 1.05, full ? 1.7 : 1.45, `${tag} rich greens`);
        within(m.midSlope, full ? 1.25 : 1.12, full ? 1.55 : 1.3, `${tag} print contrast`);
        within(m.clipFrom, 250, 256, `${tag} the shoulder means nothing clips`);

        // ---- The scene it missed on. Each of these is the look's claim about the room.
        const s = scene(recipe, strength);
        const floor = full ? 1 : 0.6;
        assert.ok(s.wall.dBlueRed <= -25 * floor,
          `${tag} the lab balances the cool wall: blue-minus-red moves ${s.wall.dBlueRed.toFixed(1)}, wanted <= ${(-25 * floor).toFixed(1)}`);
        assert.ok(s.wall.dLuma >= 0,
          `${tag} print contrast does not pull the wall down: luma moves ${s.wall.dLuma.toFixed(1)}`);
        assert.ok(s.navy.dLuma <= -6 * floor,
          `${tag} the toe takes the navy throw down, never up: luma moves ${s.navy.dLuma.toFixed(1)}`);
        assert.ok(s.mustard.satRatio >= 1 + 0.2 * floor,
          `${tag} the mustard cushion gains colour: saturation x${s.mustard.satRatio.toFixed(2)}`);
      }
      if (recipe.id === "rec.camcorder") {
        within(m.black, full ? 19 : 12, full ? 26 : 19, `${tag} pedestal (7.5 IRE is 19)`);
        within(m.white, 254, 255, `${tag} whites reach the wall`);
        within(m.meanChroma, 1.0, full ? 1.25 : 1.2, `${tag} video colour is hot, not faded`);
        within(m.chroma.chartRed, 1.1, full ? 1.5 : 1.35, `${tag} hot reds`);
        // The red circuit runs out on a red that is already saturated: it clips instead of getting hotter.
        assert.ok(m.chroma.chartRed > m.chroma.satRed && m.chroma.satRed > 1.02,
          `${tag} a saturated red clips rather than going hotter (${m.chroma.chartRed.toFixed(2)} vs ${m.chroma.satRed.toFixed(2)})`);
        within(m.midSlope, 0.85, 1.0, `${tag} low contrast mids`);
        within(m.midLab.b, 2, full ? 6 : 5, `${tag} warm-leaning white balance`);
        const highlight = (luma(render(recipe, strength, [225, 225, 225])) - luma(render(recipe, strength, [195, 195, 195]))) * 255 / 30;
        within(highlight, 1.15, full ? 2 : 1.6, `${tag} no knee: highlights steepen into the clip`);
      }
    }
    // ---- At the default every look is plainly itself: some reference colour moves a long way.
    const at60 = measure(recipe, 60);
    const moved = Math.max(...Object.values(at60.chroma).map((c) => Math.abs(c - 1)), Math.abs(at60.mid - 128) / 40, at60.black / 40);
    within(moved, 0.15, 1, `${recipe.name} is recognisable at the default strength`);

    // ---- One strength law: the dial IS the mix. Every curve is a straight line from neutral at 0
    //      to the look's full value at 100, so 0 is exactly Clean and the dial's travel is even.
    assert.deepEqual(recipe.manifest.intensity.lutMix, [[0, 0], [100, 1]], `${recipe.name}: the shared colour ramp`);
    const NEUTRAL = { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 };
    for (const stage of recipe.manifest.stages) {
      for (const [param, curve] of Object.entries(stage.intensityCurve ?? {})) {
        const neutral = stage.type === "levels" ? NEUTRAL[param] : 0;
        assert.deepEqual(curve, [[0, neutral], [100, curve[1]?.[1]]],
          `${recipe.name} ${stage.type}.${param}: two points, neutral at 0 and full at 100`);
        assert.notEqual(curve[1][1], neutral, `${recipe.name} ${stage.type}.${param} does nothing`);
      }
    }
    // Strength 0 is Clean exactly, not nearly: the LUT is mixed out and every stage is neutral.
    for (const rgb8 of [[0, 0, 0], [128, 128, 128], [255, 255, 255], ...Object.values(PATCH), ...Object.values(SCENE)])
      assert.deepEqual(render(recipe, 0, rgb8), rgb8.map((v) => v / 255), `${recipe.name} at strength 0 is Clean`);

    // ---- 100 is a heavier picture, by as much again as the step into the default. The old law put
    //      85 % of the colour in by 60, so 60 and 100 were the same photograph; this is the guard.
    const swatches = [...Object.values(PATCH), ...Object.values(SCENE), [32, 32, 32], [64, 64, 64], [160, 160, 160], [220, 220, 220]];
    /** The furthest any reference colour moves between two strengths, in levels. */
    const apart = (a, b) => Math.max(...swatches.map((rgb8) => {
      const x = render(recipe, a, rgb8), y = render(recipe, b, rgb8);
      return [0, 1, 2].reduce((s, k) => s + Math.abs(x[k] - y[k]) * 255, 0) / 3;
    }));
    const step = apart(60, 100), before = apart(30, 60);
    assert.ok(step >= 8, `${recipe.name}: 60 -> 100 must be a visible step, not ${step.toFixed(1)} levels`);
    assert.ok(step >= before * 0.9,
      `${recipe.name}: the dial's travel is even — 60 -> 100 moves ${step.toFixed(1)} levels, 30 -> 60 moves ${before.toFixed(1)}`);
    report.push(`  ${recipe.name.padEnd(16)} dial 0->30 ${apart(0, 30).toFixed(1)}  30->60 ${before.toFixed(1)}  60->100 ${step.toFixed(1)} levels`);
    // ---- Film that carries an anti-halation layer does not glow; a camcorder's chroma error is not radial.
    const types = recipe.manifest.stages.map((s) => s.type);
    if (recipe.id === "rec.disposable") assert.ok(!types.includes("halation"), "consumer colour negative does not halate");
    if (recipe.id === "rec.digicam") assert.ok(!types.includes("resolutionSoften") && types.includes("sharpen"), "a digicam is over-sharpened, never soft");
    if (recipe.id === "rec.camcorder") assert.ok(!types.includes("chromaticAberration") && types.includes("resolutionSoften"), "a camcorder is soft, and does not fringe radially");
  }
  // The three must not be three tints of one thing: they differ where it shows.
  const [dig, dis, cam] = LOOKS.map((r) => measure(r, 60));
  assert.ok(dig.midSlope > cam.midSlope + 0.25 && dis.midSlope > cam.midSlope + 0.15, "contrast: the tape is the flat one");
  assert.ok(dig.clipFrom < dis.clipFrom - 10, "the digicam clips where the print's shoulder never does");
  assert.ok(cam.black > dis.black + 5 && dis.black > dig.black, "black: camcorder pedestal > print black > digicam crush");
  assert.ok(dis.midLab.b - dig.midLab.b > 4, "the print is warm where the digicam is neutral");
  assert.ok(dis.meanChroma > cam.meanChroma && dis.meanChroma > 1.1, "the print is the saturated one");

  // =====================================================================================
  // 3. What was retired
  // =====================================================================================
  const SHIPPED = {
    "rec.soft-digital": { name: "Soft digital", successor: "rec.digicam",
      manifest: "a62ab348846e11b113c3ac2ba3ee5375b03dbea49134ee48b2015ad2597ddccd",
      lut: "752e2d4c77db793e72cd605ce3efbd1c1d1ad69d8bbc24cbe38a1edff7e8f43e" },
    "rec.warm-film": { name: "Warm film", successor: "rec.disposable",
      manifest: "89a149e8b1af51aac698d9dc94e945c57fb7a9d18777964874ed022be1e94316",
      lut: "6336e00fc5921ea3b3b70aaaa108b8b4346fcb51e4631716805dc122d7da4120" },
    "rec.video-tape": { name: "Video tape", successor: "rec.camcorder",
      manifest: "e57ac85ef7e6eb3af5db6407195a6fafcfd31fe1bf0f7c30cd226d9d1a6f6b42",
      lut: "7c35b05e44526b505e7b29bc9513a0dbbc41c707cc7f92850ab673c5f6591e9a" },
  };
  assert.deepEqual(Object.keys(RETIRED_SUCCESSOR).sort(), Object.keys(SHIPPED).sort());
  assert.deepEqual(Object.keys(RETIRED_NAMES).sort(), Object.keys(SHIPPED).sort());
  for (const [id, was] of Object.entries(SHIPPED)) {
    const recipe = retiredById(id);
    assert.ok(recipe, `${id} still resolves`);
    validateRecipe(recipe);
    assert.equal(recipe.id, id);
    assert.equal(recipe.name, was.name);
    assert.equal(RETIRED_NAMES[id], was.name, "a photograph taken with it keeps its name");
    assert.equal(recipe.builtIn, false, "retired: Develop shows it as any recipe that is off the row");
    // sha-256 of JSON.stringify(manifest) and of the base64 LUT, taken from the starters at HEAD 99f7d34.
    assert.equal(sha256(JSON.stringify(recipe.manifest)), was.manifest, `${id}: the manifest is exactly as it shipped`);
    assert.equal(sha256(recipe.lut), was.lut, `${id}: the LUT is exactly as it shipped`);
    assert.equal(RETIRED_SUCCESSOR[id], was.successor);
    assert.ok(starterById(was.successor), `${id}'s successor ships`);
    assert.equal(starterById(id), null, `${id} is not a starter`);
  }
  assert.equal(retiredById("rec.digicam"), null);
  assert.equal(retiredById("constructor"), null, "an inherited property is not a retired id");
  assert.equal(isRetired("toString"), false);
  assert.equal(retiredById(null), null);

  // =====================================================================================
  // 4. The store carries forward what was saved against a retired starter
  // =====================================================================================
  const KEY = "recipes.v1";
  const stored = () => JSON.parse(storage.items.get(KEY) ?? "null");
  const seed = (state) => { storage.items.clear(); storage.writes = 0; if (state) storage.items.set(KEY, JSON.stringify(state)); };
  const overrideOf = (recipe) => ({ manifest: recipe.manifest, lut: recipe.lut });
  const warm = retiredById("rec.warm-film");
  const editedWarm = setParam(warm, "temperatureTint", "temperature", 0.35);
  const ownRecipe = { ...setParam(STARTERS[1], "grain", "size", 2), id: "rec.u.mine01", name: "Mine", builtIn: false };
  ownRecipe.manifest.profileId = ownRecipe.id;
  validateRecipe(ownRecipe);

  // (a) The camera's own first read, on a store from the previous build. This is the implicit run.
  seed({
    v: 1,
    recipes: [ownRecipe],
    overrides: {
      "rec.warm-film": overrideOf(editedWarm),                       // edited: must survive
      "rec.soft-digital": overrideOf(retiredById("rec.soft-digital")), // untouched: nothing of theirs to keep
      "rec.video-tape": { manifest: { schema: 99 }, lut: null },       // no longer valid: was already unusable
    },
    lastUsed: { recipeId: "rec.warm-film", strength: 0.65 },
  });
  const [all, last] = await Promise.all([store.allRecipes(), store.lastUsed()]);
  assert.deepEqual(all.slice(0, 4).map((r) => r.id), STARTERS.map((r) => r.id), "the picker opens on the new starters, in order");
  assert.ok(all.slice(0, 4).every((r, i) => sameLook(r, STARTERS[i])), "a retired override never lands on a new starter");
  assert.ok(all.every((r) => !isRetired(r.id)), "a retired starter is never a choice");
  const mine = all.filter((r) => !r.builtIn);
  assert.equal(mine.length, 2, "their own recipe, and the one edited look carried forward");
  assert.deepEqual(mine[0], ownRecipe, "their own recipe is untouched");
  const carried = mine[1];
  assert.match(carried.id, /^rec\.u\./);
  assert.equal(carried.name, "Warm film", "under the old look's name");
  assert.equal(carried.manifest.profileId, carried.id);
  assert.ok(sameLook(carried, editedWarm), "with exactly the look they had set");
  // The look that was in use was theirs, edited: the camera reopens on it, carried forward, and
  // not on the successor, which they have never seen. (Scenario (d) is the unedited case.)
  assert.deepEqual(last, { recipeId: carried.id, strength: 0.65 }, "last used follows the carried-forward look at the same strength");
  assert.deepEqual(Object.keys(stored().overrides), [], "no retired override is left behind");
  assert.deepEqual(stored().lastUsed, { recipeId: carried.id, strength: 0.65 });
  assert.equal(storage.writes, 1, "one write");

  // (b) Idempotent: a second run finds nothing and writes nothing.
  const afterFirst = storage.items.get(KEY);
  await store.migrateRetiredRecipes();
  await store.migrateRetiredRecipes();
  assert.equal(storage.items.get(KEY), afterFirst, "a second run changes nothing");
  assert.equal(storage.writes, 1, "and does not write");
  assert.equal((await store.allRecipes()).filter((r) => r.name === "Warm film").length, 1, "the look is carried forward once");

  // (c) A store with nothing retired in it is left exactly as it was, byte for byte.
  const digicamOverride = setParam(STARTERS[1], "vignette", "strength", 0.3);
  seed({ v: 1, recipes: [ownRecipe], overrides: { "rec.digicam": overrideOf(digicamOverride) },
    lastUsed: { recipeId: "rec.u.mine01", strength: 0.4 }, somethingNewer: { kept: true } });
  const untouched = storage.items.get(KEY);
  await store.migrateRetiredRecipes();
  assert.equal(storage.items.get(KEY), untouched);
  assert.equal(storage.writes, 0, "nothing retired, nothing written");
  assert.ok(sameLook((await store.allRecipes())[1], digicamOverride), "a current starter's override still applies");
  assert.deepEqual(await store.lastUsed(), { recipeId: "rec.u.mine01", strength: 0.4 });

  // (d) Only lastUsed is retired: mapped, and everything else in the store is kept as it was.
  seed({ v: 1, recipes: [ownRecipe], lastUsed: { recipeId: "rec.video-tape", strength: 1 }, somethingNewer: { kept: true } });
  await store.migrateRetiredRecipes();
  assert.deepEqual(stored(), { v: 1, recipes: [ownRecipe], lastUsed: { recipeId: "rec.camcorder", strength: 1 }, somethingNewer: { kept: true } });
  assert.deepEqual(await store.lastUsed(), { recipeId: "rec.camcorder", strength: 1 });

  // (e) Fail soft. Nothing here may reject: the camera's first read goes through it.
  seed(null);
  await store.migrateRetiredRecipes();
  assert.equal(storage.writes, 0, "an empty store is not written");
  for (const junk of ["not json", "[]", "null", "7", '{"overrides":[],"recipes":"x","lastUsed":"rec.warm-film"}',
    '{"overrides":{"rec.warm-film":null,"rec.video-tape":7}}']) {
    storage.items.clear(); storage.items.set(KEY, junk);
    await store.migrateRetiredRecipes();
    assert.deepEqual((await store.allRecipes()).map((r) => r.id), STARTERS.map((r) => r.id), `survives ${junk}`);
  }
  storage.failReads = true;
  await store.migrateRetiredRecipes();
  storage.failReads = false;
  // A write that fails loses nothing: the stored override is still there for the next launch, and
  // the camera still opens on the successor.
  seed({ v: 1, recipes: [], overrides: { "rec.warm-film": overrideOf(editedWarm) }, lastUsed: { recipeId: "rec.soft-digital", strength: 0.5 } });
  const beforeFailure = storage.items.get(KEY);
  storage.failWrites = true;
  await store.migrateRetiredRecipes();
  storage.failWrites = false;
  assert.equal(storage.items.get(KEY), beforeFailure, "a failed write leaves the store as it was");
  assert.deepEqual(await store.lastUsed(), { recipeId: "rec.digicam", strength: 0.5 }, "and a retired last-used still opens on its successor");
  await store.migrateRetiredRecipes();
  assert.equal((await store.allRecipes()).filter((r) => r.name === "Warm film").length, 1, "the next run carries it forward");

  // (f) A saved recipe may never take a starter's id, current or retired.
  seed({ v: 1, recipes: [{ ...ownRecipe, id: "rec.warm-film", manifest: { ...ownRecipe.manifest, profileId: "rec.warm-film" } }] });
  assert.deepEqual((await store.allRecipes()).map((r) => r.id), STARTERS.map((r) => r.id));

  console.log("looks ok — Clean pinned; Digicam, Disposable and Camcorder hold their numbers at 60 and 100; "
    + "one strength law; retired starters resolve as shipped; the store carries retired data forward once");
  console.log(report.join("\n"));
}
