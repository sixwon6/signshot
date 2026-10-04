import { buildLut, clamp01, luma601, sCurve, saturate, shoulder, type Rgb } from "./lut";
import { neutralRecipe, type Recipe, type RecipeManifest } from "./model";

/**
 * The starters: built-in recipes, each named for a camera you could have owned. Ordinary recipe
 * data, never stored, renamed or deleted. Each colour grade is a LUT computed here, so it is
 * reviewable as maths, and `scripts/check-looks.mjs` holds each one to the numbers that define it.
 */

const LUT_SIZE = 17;

/**
 * One strength law for every starter: the dial is the mix. The LUT and every stage parameter ride
 * one straight line from neutral at 0 to the look's full value at 100, so 0 is exactly the phone's
 * own picture, the default is 60 % of the look, and the last forty points of travel are worth as
 * much as the first forty. Each grade below is therefore written as the look at 100.
 */
const ramp = (full: number, neutral = 0): [number, number][] => [[0, neutral], [100, full]];

const lutMix = (): [number, number][] => ramp(1);

/**
 * Bright, saturated blue: sky, and little else. Skin and foliage score zero, and so does a white
 * wall under cool window light — the key is how far blue leads in proportion, not in levels, which
 * is the difference between a blue subject and a blue cast.
 */
const blueMask = (R: number, B: number): number =>
  clamp01(((B - R) / Math.max(B, 1e-4)) * 5 - 1.1) * clamp01((B - 0.35) * 3);

// ---------------------------------------------------------------------------
// Digicam — an early-2000s CCD compact
// ---------------------------------------------------------------------------

/**
 * Neutral mids with a hair of cool; a hard S-curve with no shoulder, so whites hit the wall;
 * punchy primaries; deep skies that lean cyan; and the auto white balance's miss sitting green in
 * the shadows rather than tinting the whole frame.
 */
function digicam(r: number, g: number, b: number): Rgb {
  // 1. a touch hot, a hair cool
  let R = r * 1.028;
  let G = g * 1.028;
  let B = b * 1.05;

  // 2. hard contrast, no toe and no shoulder
  R = sCurve(clamp01(R), 0.64);
  G = sCurve(clamp01(G), 0.64);
  B = sCurve(clamp01(B), 0.64);

  // 3. punchy primaries, eased over skin and warm whites (R > G > B): the contrast curve already
  //    lifts their chroma, and at a flat 1.14 dark skin passes the family's cap at full strength
  const skin = clamp01((R - G) * 6) * clamp01((G - B) * 10);
  [R, G, B] = saturate([R, G, B], 1.142 - 0.28 * skin);

  // 4. CCD sky: deeper, leaning cyan
  const sky = blueMask(R, B);
  G += 0.085 * sky;
  R -= 0.05 * sky;
  B += 0.028 * sky;

  // 5. green in the shadows, fading to nothing at black so black stays black
  const y = luma601(R, G, B);
  const sh = clamp01(y * 9) * clamp01(1 - y * 2.6);
  G += 0.028 * sh;
  R -= 0.006 * sh;
  B -= 0.014 * sh;

  // 6. blue clips last: faint magenta just under the wall
  const hi = clamp01((y - 0.8) * 5);
  R += 0.017 * hi;
  B += 0.023 * hi;
  G -= 0.011 * hi;

  return [R, G, B];
}

const digicamManifest: RecipeManifest = {
  schema: 1,
  profileId: "rec.digicam",
  profileVersion: 1,
  rendererMin: "0.2.0",
  lut: { size: LUT_SIZE, space: "gamma" },
  stages: [
    // In-camera sharpening: a visible halo on hard edges. No softening; a digicam is crisp.
    {
      type: "sharpen",
      scaling: "reference-pixel",
      params: { amount: 0.0, radius: 2.2 },
      intensityCurve: { amount: ramp(0.92) },
    },
    {
      type: "chromaticAberration",
      scaling: "reference-pixel",
      params: { shift: 0.0 },
      intensityCurve: { shift: ramp(1.67) },
    },
    // Crushed blacks and an abrupt white clip: the tonal signature.
    {
      type: "levels",
      scaling: "invariant",
      params: { inBlack: 0.0, inWhite: 1.0, gamma: 1.0, outBlack: 0.0, outWhite: 1.0 },
      intensityCurve: { inBlack: ramp(0.04), inWhite: ramp(0.933, 1) },
    },
    {
      type: "vignette",
      scaling: "frame-relative",
      params: { radius: 0.85, softness: 0.5, strength: 0.0 },
      intensityCurve: { strength: ramp(0.167) },
    },
    // Fine sensor noise, living in the shadows.
    {
      type: "grain",
      scaling: "reference-pixel",
      params: { size: 1.0, opacity: 0.0, shadowBias: 0.6 },
      intensityCurve: { opacity: ramp(0.053) },
    },
  ],
  intensity: { lutMix: lutMix() },
};

// ---------------------------------------------------------------------------
// Disposable — a single-use 35 mm camera, printed at the lab
// ---------------------------------------------------------------------------

/**
 * A drugstore print off a one-time-use camera. The minilab balances every frame to grey, so the
 * room's cool cast goes and the stock's own warmth is what is left; the paper supplies the contrast
 * the negative does not have, with a crushed toe and a shoulder that keeps white creamy rather than
 * grey; consumer stock is saturated, and skin is the one thing it holds back on. No halation:
 * consumer colour negative carries an anti-halation layer.
 */
function disposable(r: number, g: number, b: number): Rgb {
  // 1. the lab's balance. A cast is what red trails both other channels by; a saturated blue is a
  //    subject, not a cast, and keeps its own. Then the stock's warmth goes on top.
  const blue = blueMask(r, b);
  const cool = clamp01(Math.min(b - r, g - r) * 9) * (1 - blue);
  const yIn = luma601(r, g, b);
  const grey = 1 - 0.95 * cool;
  let R = (yIn + (r - yIn) * grey) * 1.035;
  let G = yIn + (g - yIn) * grey;
  let B = (yIn + (b - yIn) * grey) * 0.955;

  // 2. paper contrast: a crushed toe, a steep middle, and a shoulder that never reaches the wall
  const print = (x: number): number => shoulder(sCurve(clamp01(x), 0.72), 0.82, 2.2);
  R = print(R);
  G = print(G);
  B = print(B);

  // 3. crossover where the paper runs out: consumer negative goes green-cyan in the toe. Luma-
  //    neutral, so it tints the shadows without lifting them.
  const y = luma601(R, G, B);
  const sh = clamp01(1 - y * 2.4);
  R -= 0.024 * sh;
  G += 0.014 * sh;
  B += 0.006 * sh;

  // 4. saturated stock; the toe loses colour with the paper, and skin (R > G > B) is eased
  const skin = clamp01((R - G) * 6) * clamp01((G - B) * 10);
  [R, G, B] = saturate([R, G, B], 1.34 - 0.34 * sh - 0.46 * skin);

  // 5. the paper base is cream: the highlights carry the stock's warmth, where the red channel has
  //    already run out of room and the gain in step 1 cannot show
  const hi = clamp01((y - 0.7) * 3.3);
  R += 0.009 * hi;
  B -= 0.032 * hi;

  // 6. step 1 leaves a saturated blue alone, so all the sky wants here is the stock's cyan lean
  G += 0.03 * blue;
  R -= 0.012 * blue;

  return [R, G, B];
}

const disposableManifest: RecipeManifest = {
  schema: 1,
  profileId: "rec.disposable",
  profileVersion: 1,
  rendererMin: "0.2.0",
  lut: { size: LUT_SIZE, space: "gamma" },
  stages: [
    // A plastic lens: soft everywhere.
    {
      type: "resolutionSoften",
      scaling: "reference-pixel",
      params: { amount: 0.0 },
      intensityCurve: { amount: ramp(2.67) },
    },
    {
      type: "chromaticAberration",
      scaling: "reference-pixel",
      params: { shift: 0.0 },
      intensityCurve: { shift: ramp(2.0) },
    },
    // The toe the paper cannot hold, and a black that is dense but not a digital zero. No ceiling:
    // white is creamy because the LUT's shoulder is warm, not because the top of the range is gone.
    {
      type: "levels",
      scaling: "invariant",
      params: { inBlack: 0.0, inWhite: 1.0, gamma: 1.0, outBlack: 0.0, outWhite: 1.0 },
      intensityCurve: { inBlack: ramp(0.035), gamma: ramp(0.93, 1), outBlack: ramp(0.016) },
    },
    // Flash falloff: exactly a stop in the corners at 100, and nothing at all before the edge
    // midpoints, so it never costs the picture its highlights.
    {
      type: "vignette",
      scaling: "frame-relative",
      params: { radius: 0.7, softness: 0.2, strength: 0.0 },
      intensityCurve: { strength: ramp(0.95) },
    },
    // ISO 400 grain. Cells above about 2 px read as mosaic on this grain stage's square lattice.
    {
      type: "grain",
      scaling: "reference-pixel",
      params: { size: 2.0, opacity: 0.0, shadowBias: 0.5 },
      intensityCurve: { opacity: ramp(0.125) },
    },
  ],
  intensity: { lutMix: lutMix() },
};

// ---------------------------------------------------------------------------
// Camcorder — a consumer tape camcorder
// ---------------------------------------------------------------------------

/**
 * Video tone, not faded colour: open mids at low contrast, then no knee, so highlights steepen and
 * hit the wall; chroma a little hot with the reds hotter still; a warm-leaning auto white balance;
 * blues leaning cyan. The pedestal is shared with the `levels` stage below.
 */
function camcorder(r: number, g: number, b: number): Rgb {
  // 1. warm-leaning auto white balance
  let R = r * 1.035;
  let G = g;
  let B = b * 0.936;

  // 2. video gamma at low contrast about mid-grey; above 0.72 the slope is 1.7 until it clips
  const tone = (x: number): number => {
    const v = 0.5 + (Math.pow(clamp01(x), 0.955) - 0.5) * 0.929;
    return v > 0.72 ? 0.72 + (v - 0.72) * 1.71 : v;
  };
  [R, G, B] = saturate([clamp01(tone(R)), clamp01(tone(G)), clamp01(tone(B))], 1.071);

  // 3. hot reds. The key starts above where skin sits, so a face does not ride the red circuit.
  const red = clamp01((R - Math.max(G, B)) * 3 - 0.45);
  const y = luma601(R, G, B);
  R += (R - y) * 0.31 * red;
  G += (G - y) * 0.31 * red;
  B += (B - y) * 0.31 * red;

  // 4. blues lean cyan
  const sky = blueMask(R, B);
  G += 0.028 * sky;
  B += 0.028 * sky;

  return [R, G, B];
}

const camcorderManifest: RecipeManifest = {
  schema: 1,
  profileId: "rec.camcorder",
  profileVersion: 1,
  // chromaSmear needs renderer 0.3.0.
  rendererMin: "0.3.0",
  lut: { size: LUT_SIZE, space: "gamma" },
  stages: [
    // Standard-definition softness.
    {
      type: "resolutionSoften",
      scaling: "reference-pixel",
      params: { amount: 0.0 },
      intensityCurve: { amount: ramp(4.0) },
    },
    // The detail circuit: wide sharpening over the soft picture, so edges ring.
    {
      type: "sharpen",
      scaling: "reference-pixel",
      params: { amount: 0.0, radius: 3.6 },
      intensityCurve: { amount: ramp(0.96) },
    },
    // Chroma bandwidth: colour bleeds along the scan line and lags it, luma stays sharp. The width
    // is the medium's and does not move with the dial; the dial mixes it in.
    {
      type: "chromaSmear",
      scaling: "reference-pixel",
      params: { amount: 0.0, width: 24.0, shift: 4.0 },
      intensityCurve: { amount: ramp(1.0) },
    },
    // The rest of the pedestal. Whites clip in the LUT, so clipping them does not brighten the mids.
    {
      type: "levels",
      scaling: "invariant",
      params: { inBlack: 0.0, inWhite: 1.0, gamma: 1.0, outBlack: 0.0, outWhite: 1.0 },
      intensityCurve: { outBlack: ramp(0.058) },
    },
    {
      type: "vignette",
      scaling: "frame-relative",
      params: { radius: 0.8, softness: 0.45, strength: 0.0 },
      intensityCurve: { strength: ramp(0.1) },
    },
    // Amplifier noise: fine and fairly even.
    {
      type: "grain",
      scaling: "reference-pixel",
      params: { size: 1.6, opacity: 0.0, shadowBias: 0.4 },
      intensityCurve: { opacity: ramp(0.07) },
    },
  ],
  intensity: { lutMix: lutMix() },
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** The empty recipe. Nothing is applied; the frame is still decoded and dithered. */
const CLEAN_RECIPE_ID = neutralRecipe().id;

/** The camera opens on the phone's own look until the photographer has chosen otherwise. */
export const DEFAULT_RECIPE_ID = CLEAN_RECIPE_ID;

/** Where the strength dial starts for a recipe that has never been used. */
export const DEFAULT_STRENGTH = 0.6;

/** In picker order: the phone's own look, then the cameras from the newest back. */
export const STARTERS: readonly Recipe[] = [
  neutralRecipe(),
  {
    id: "rec.digicam",
    name: "Digicam",
    manifest: digicamManifest,
    lut: buildLut(LUT_SIZE, digicam),
    builtIn: true,
  },
  {
    id: "rec.disposable",
    name: "Disposable",
    manifest: disposableManifest,
    lut: buildLut(LUT_SIZE, disposable),
    builtIn: true,
  },
  {
    id: "rec.camcorder",
    name: "Camcorder",
    manifest: camcorderManifest,
    lut: buildLut(LUT_SIZE, camcorder),
    builtIn: true,
  },
];

export function starterById(id: string | null): Recipe | null {
  return STARTERS.find((recipe) => recipe.id === id) ?? null;
}
