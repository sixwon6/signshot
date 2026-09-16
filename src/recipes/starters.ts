import { buildLut, clamp01, luma601, sCurve, saturate, type Rgb } from "./lut";
import { neutralRecipe, type Recipe, type RecipeManifest } from "./model";

/**
 * The starters: built-in recipes named for how they look. Ordinary recipe data, never stored,
 * renamed or deleted. Each colour grade is a LUT computed here, so it is reviewable as maths.
 */

const LUT_SIZE = 17;

// ---------------------------------------------------------------------------
// Soft digital — cool, crisp, small-sensor colour
// ---------------------------------------------------------------------------

/**
 * Cold, faintly magenta white balance; a hard contrast curve with no toe and no shoulder;
 * crunchy primaries; skies that go teal; and a magenta lean as the highlights hit the wall.
 */
function softDigital(r: number, g: number, b: number): Rgb {
  // 1. cool / slightly magenta white balance
  let R = r * 1.02;
  let G = g * 0.985;
  let B = b * 1.06;

  // 2. punchy contrast, no toe and no shoulder
  R = sCurve(R, 0.5);
  G = sCurve(G, 0.5);
  B = sCurve(B, 0.5);

  // 3. crunchy primaries
  // (kept just under the point where mid-luma reds clip on their own — the `levels` stage below
  // lowers inWhite, so the LUT must leave it some headroom to clip into)
  const rgb = saturate([R, G, B], 1.18);
  R = rgb[0];
  G = rgb[1];
  B = rgb[2];

  // 4. teal sky: only in bright, blue-dominant pixels, so skin and foliage stay put
  const sky = clamp01((B - R) * 2.2) * clamp01((B - 0.35) * 2.5);
  G += 0.06 * sky;
  B -= 0.035 * sky;

  // 5. magenta cast as the highlights approach clip (blue saturates before green)
  const hi = clamp01((luma601(R, G, B) - 0.75) * 4);
  R += 0.02 * hi;
  B += 0.025 * hi;
  G -= 0.012 * hi;

  return [R, G, B];
}

const softDigitalManifest: RecipeManifest = {
  schema: 1,
  profileId: "rec.soft-digital",
  profileVersion: 1,
  rendererMin: "0.2.0",
  lut: { size: LUT_SIZE, space: "gamma" },
  stages: [
    // A small, cheap lens: a touch of softness before anything spatial is stacked on top.
    {
      type: "resolutionSoften",
      scaling: "reference-pixel",
      params: { amount: 0.0 },
      intensityCurve: { amount: [[0, 0], [100, 1.3]] },
    },
    // Light fringing — visible at the frame edges only.
    {
      type: "chromaticAberration",
      scaling: "reference-pixel",
      params: { shift: 0.0 },
      intensityCurve: { shift: [[0, 0], [50, 0.5], [100, 1.2]] },
    },
    // Hard clip and slightly crushed blacks: the tonal signature of the look.
    {
      type: "levels",
      scaling: "invariant",
      params: { inBlack: 0.0, inWhite: 1.0, gamma: 1.0, outBlack: 0.0, outWhite: 1.0 },
      intensityCurve: {
        inBlack: [[0, 0], [100, 0.03]],
        inWhite: [[0, 1], [100, 0.93]],
        gamma: [[0, 1], [100, 0.97]],
      },
    },
    // Barely there — just enough to stop the corners reading as flat.
    {
      type: "vignette",
      scaling: "frame-relative",
      params: { radius: 0.85, softness: 0.5, strength: 0.0 },
      intensityCurve: { strength: [[0, 0], [100, 0.12]] },
    },
    // Fine speckle, low opacity, mildly shadow-weighted.
    {
      type: "grain",
      scaling: "reference-pixel",
      params: { size: 1.2, opacity: 0.0, shadowBias: 0.25 },
      intensityCurve: { opacity: [[0, 0], [50, 0.024], [100, 0.045]] },
    },
  ],
  intensity: { lutMix: [[0, 0], [100, 1]] },
};

// ---------------------------------------------------------------------------
// Warm film — amber print colour, faded blacks, heavy corners
// ---------------------------------------------------------------------------

/**
 * Soft exponential shoulder — the film characteristic curve's upper roll.
 *
 * Above the knee: knee + (1 - e^(-rate·(x-knee))) / rate. The coefficient is 1/rate, which makes
 * the slope at the knee exactly 1 — continuous with the identity below it, so the curve only
 * ever compresses highlights. (Any larger coefficient would kink upward into expansion at the
 * knee, which is not what a shoulder does.) It is monotonic and asymptotic to
 * knee + 1/rate ≈ 0.958, so nothing driven through it can reach paper white.
 */
function shoulder(x: number): number {
  const knee = 0.72;
  const rate = 4.2;
  if (x <= knee) return x;
  return knee + (1 - Math.exp(-(x - knee) * rate)) / rate;
}

/**
 * A warm, red-forward print; highlights that go creamy instead of white; green-cyan shadows
 * under warm midtones, which is the split that reads as film rather than as a warm filter.
 */
function warmFilm(r: number, g: number, b: number): Rgb {
  // 1. warm amber print cast
  let R = r * 1.07;
  let G = g * 1.005;
  let B = b * 0.925;

  // 2. highlight rolloff (whites land near 0.9, never 1.0)
  R = shoulder(R);
  G = shoulder(G);
  B = shoulder(B);

  // 3. green-cyan shadow crossover, mids untouched
  const y = luma601(R, G, B);
  const sh = clamp01(1 - y * 2.2);
  R -= 0.012 * sh;
  G += 0.024 * sh;
  B += 0.008 * sh;

  // 4. gentle overall saturation lift, then pull the shadows back down — dye density falls off
  //    in the toe, so faded shadows should not be colourful
  return saturate([R, G, B], 1.06 - 0.28 * sh);
}

const warmFilmManifest: RecipeManifest = {
  schema: 1,
  profileId: "rec.warm-film",
  profileVersion: 1,
  rendererMin: "0.2.0",
  lut: { size: LUT_SIZE, space: "gamma" },
  stages: [
    // A single cheap lens element — slightly soft everywhere.
    {
      type: "resolutionSoften",
      scaling: "reference-pixel",
      params: { amount: 0.0 },
      intensityCurve: { amount: [[0, 0], [100, 1.1]] },
    },
    // Fringing: mild, but present.
    {
      type: "chromaticAberration",
      scaling: "reference-pixel",
      params: { shift: 0.0 },
      intensityCurve: { shift: [[0, 0], [100, 1.4]] },
    },
    // The fade lives here: lifted black point, whites held just under paper white.
    {
      type: "levels",
      scaling: "invariant",
      params: { inBlack: 0.0, inWhite: 1.0, gamma: 1.0, outBlack: 0.0, outWhite: 1.0 },
      intensityCurve: {
        inWhite: [[0, 1], [100, 0.98]],
        gamma: [[0, 1], [100, 1.06]],
        outBlack: [[0, 0], [50, 0.03], [100, 0.055]],
        outWhite: [[0, 1], [100, 0.97]],
      },
    },
    // Strong natural vignette — the defining tell of this look.
    {
      type: "vignette",
      scaling: "frame-relative",
      params: { radius: 0.6, softness: 0.4, strength: 0.0 },
      intensityCurve: { strength: [[0, 0], [60, 0.32], [100, 0.5]] },
    },
    // Coarse, heavy, shadow-weighted grain.
    {
      type: "grain",
      scaling: "reference-pixel",
      params: { size: 3.2, opacity: 0.0, shadowBias: 0.65 },
      intensityCurve: { opacity: [[0, 0], [50, 0.07], [100, 0.12]] },
    },
  ],
  intensity: { lutMix: [[0, 0], [100, 1]] },
};

// ---------------------------------------------------------------------------
// Video tape — smeared colour, milky blacks, flat clip
// ---------------------------------------------------------------------------

/**
 * Low-information colour: broadcast chroma carries far less detail than luma, so the colour is
 * smeared while edges survive. There is no chroma-only blur stage, so the smear is approximated
 * with a strong soften plus heavy desaturation — mushy, low-information colour either way.
 * Blacks sit lifted off zero, whites stop flat with no shoulder, the white balance leans warm,
 * and decoding leaves green midtones under magenta highlights.
 */
function videoTape(r: number, g: number, b: number): Rgb {
  // 1. low-information colour
  const rgb = saturate([r, g, b], 0.72);
  let R = rgb[0];
  let G = rgb[1];
  let B = rgb[2];

  // 2. warm-biased white balance
  R *= 1.045;
  B *= 0.94;

  // 3. decode imbalance: green mids, magenta highs
  const y = luma601(R, G, B);
  const mid = clamp01(1 - Math.abs(y - 0.45) * 2.6);
  G += 0.028 * mid;
  const hi = clamp01((y - 0.65) * 3);
  R += 0.022 * hi;
  B += 0.028 * hi;
  G -= 0.018 * hi;

  // 4. soft gamma — mids sit brighter and flatter than a stills curve
  R = Math.pow(clamp01(R), 0.94);
  G = Math.pow(clamp01(G), 0.94);
  B = Math.pow(clamp01(B), 0.94);

  return [R, G, B];
}

const videoTapeManifest: RecipeManifest = {
  schema: 1,
  profileId: "rec.video-tape",
  profileVersion: 1,
  rendererMin: "0.2.0",
  lut: { size: LUT_SIZE, space: "gamma" },
  stages: [
    // Stands in for chroma bandwidth limiting — the strongest soften of the three.
    {
      type: "resolutionSoften",
      scaling: "reference-pixel",
      params: { amount: 0.0 },
      intensityCurve: { amount: [[0, 0], [50, 2.2], [100, 4.2]] },
    },
    // Strong fringing on high-contrast edges.
    {
      type: "chromaticAberration",
      scaling: "reference-pixel",
      params: { shift: 0.0 },
      intensityCurve: { shift: [[0, 0], [50, 1.5], [100, 3.0]] },
    },
    // Lifted pedestal black and a flat white clip.
    {
      type: "levels",
      scaling: "invariant",
      params: { inBlack: 0.0, inWhite: 1.0, gamma: 1.0, outBlack: 0.0, outWhite: 1.0 },
      intensityCurve: {
        inWhite: [[0, 1], [100, 0.87]],
        outBlack: [[0, 0], [50, 0.04], [100, 0.075]],
      },
    },
    // Wide-end lens falloff — subtle; this look is not carried by the corners.
    {
      type: "vignette",
      scaling: "frame-relative",
      params: { radius: 0.75, softness: 0.45, strength: 0.0 },
      intensityCurve: { strength: [[0, 0], [100, 0.18]] },
    },
    // Amplifier noise: medium, even across the tonal range.
    {
      type: "grain",
      scaling: "reference-pixel",
      params: { size: 1.8, opacity: 0.0, shadowBias: 0.1 },
      intensityCurve: { opacity: [[0, 0], [50, 0.04], [100, 0.075]] },
    },
  ],
  // Gentler ramp: this is the most aggressive starter, so the first half of the dial stays usable.
  intensity: { lutMix: [[0, 0], [60, 0.5], [100, 1]] },
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** The empty recipe. Nothing is applied; the frame is still decoded and dithered. */
const CLEAN_RECIPE_ID = neutralRecipe().id;

/** The camera opens on Clean until the photographer has chosen otherwise. */
export const DEFAULT_RECIPE_ID = CLEAN_RECIPE_ID;

/** Where the strength dial starts for a recipe that has never been used. */
export const DEFAULT_STRENGTH = 0.6;

export const STARTERS: readonly Recipe[] = [
  neutralRecipe(),
  {
    id: "rec.soft-digital",
    name: "Soft digital",
    manifest: softDigitalManifest,
    lut: buildLut(LUT_SIZE, softDigital),
    builtIn: true,
  },
  {
    id: "rec.warm-film",
    name: "Warm film",
    manifest: warmFilmManifest,
    lut: buildLut(LUT_SIZE, warmFilm),
    builtIn: true,
  },
  {
    id: "rec.video-tape",
    name: "Video tape",
    manifest: videoTapeManifest,
    lut: buildLut(LUT_SIZE, videoTape),
    builtIn: true,
  },
];

export function starterById(id: string | null): Recipe | null {
  return STARTERS.find((recipe) => recipe.id === id) ?? null;
}
