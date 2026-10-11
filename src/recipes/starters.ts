import { buildLut, clamp01, luma601, sCurve, saturate, shoulder, type Rgb } from "./lut";
import { neutralRecipe, type Recipe, type RecipeManifest } from "./model";

/** Built-in recipes. Grades are computed LUTs; `scripts/check-looks.mjs` checks each against its targets. */

const LUT_SIZE = 17;

/** Linear from neutral at 0 to full at 100 for the LUT and every parameter; grades are written at 100. */
const ramp = (full: number, neutral = 0): [number, number][] => [[0, neutral], [100, full]];

const lutMix = (): [number, number][] => ramp(1);

/** Sky mask. Keys on blue's proportional lead, not level, so a cool cast on white scores zero. */
const blueMask = (R: number, B: number): number =>
  clamp01(((B - R) / Math.max(B, 1e-4)) * 5 - 1.1) * clamp01((B - 0.35) * 3);

// Digicam: early-2000s CCD compact

function digicam(r: number, g: number, b: number): Rgb {
  // 1. a touch hot, a hair cool
  let R = r * 1.028;
  let G = g * 1.028;
  let B = b * 1.05;

  // 2. hard contrast, no toe and no shoulder
  R = sCurve(clamp01(R), 0.64);
  G = sCurve(clamp01(G), 0.64);
  B = sCurve(clamp01(B), 0.64);

  // 3. punchy primaries, eased over skin (R > G > B), which the S-curve already saturates
  const skin = clamp01((R - G) * 6) * clamp01((G - B) * 10);
  [R, G, B] = saturate([R, G, B], 1.142 - 0.28 * skin);

  // 4. CCD sky: deeper, leaning cyan
  const sky = blueMask(R, B);
  G += 0.085 * sky;
  R -= 0.05 * sky;
  B += 0.028 * sky;

  // 5. green shadows, zero at black
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
    // In-camera sharpening halo.
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
    // Crushed blacks, abrupt white clip.
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
    // Fine shadow noise.
    {
      type: "grain",
      scaling: "reference-pixel",
      params: { size: 1.0, opacity: 0.0, shadowBias: 0.6 },
      intensityCurve: { opacity: ramp(0.053) },
    },
  ],
  intensity: { lutMix: lutMix() },
};

// Disposable: single-use 35 mm, minilab print. No halation (consumer negative has an anti-halation layer).

function disposable(r: number, g: number, b: number): Rgb {
  // 1. lab grey balance removes cool casts (red trailing both channels) but spares blue
  //    subjects; then stock warmth
  const blue = blueMask(r, b);
  const cool = clamp01(Math.min(b - r, g - r) * 9) * (1 - blue);
  const yIn = luma601(r, g, b);
  const grey = 1 - 0.95 * cool;
  let R = (yIn + (r - yIn) * grey) * 1.035;
  let G = yIn + (g - yIn) * grey;
  let B = (yIn + (b - yIn) * grey) * 0.955;

  // 2. paper contrast: crushed toe, steep mids, shoulder below clip
  const print = (x: number): number => shoulder(sCurve(clamp01(x), 0.72), 0.82, 2.2);
  R = print(R);
  G = print(G);
  B = print(B);

  // 3. green-cyan toe crossover, luma-neutral
  const y = luma601(R, G, B);
  const sh = clamp01(1 - y * 2.4);
  R -= 0.024 * sh;
  G += 0.014 * sh;
  B += 0.006 * sh;

  // 4. saturated stock, less in the toe and on skin (R > G > B)
  const skin = clamp01((R - G) * 6) * clamp01((G - B) * 10);
  [R, G, B] = saturate([R, G, B], 1.34 - 0.34 * sh - 0.46 * skin);

  // 5. cream paper base: warm highlights where step 1's red gain has clipped
  const hi = clamp01((y - 0.7) * 3.3);
  R += 0.009 * hi;
  B -= 0.032 * hi;

  // 6. cyan lean on sky (step 1 spared it)
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
    // Plastic lens.
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
    // Crushed toe, lifted black. No white ceiling: the LUT's shoulder handles highlights.
    {
      type: "levels",
      scaling: "invariant",
      params: { inBlack: 0.0, inWhite: 1.0, gamma: 1.0, outBlack: 0.0, outWhite: 1.0 },
      intensityCurve: { inBlack: ramp(0.035), gamma: ramp(0.93, 1), outBlack: ramp(0.016) },
    },
    // Flash falloff: one stop in the corners at 100, none inside the edge midpoints.
    {
      type: "vignette",
      scaling: "frame-relative",
      params: { radius: 0.7, softness: 0.2, strength: 0.0 },
      intensityCurve: { strength: ramp(0.95) },
    },
    // ISO 400. Above ~2 px the square grain lattice reads as mosaic.
    {
      type: "grain",
      scaling: "reference-pixel",
      params: { size: 2.0, opacity: 0.0, shadowBias: 0.5 },
      intensityCurve: { opacity: ramp(0.125) },
    },
  ],
  intensity: { lutMix: lutMix() },
};

// Camcorder: consumer tape. Pedestal is split between the LUT and the `levels` stage.

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

  // 3. hot reds, keyed above skin
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
    // SD softness.
    {
      type: "resolutionSoften",
      scaling: "reference-pixel",
      params: { amount: 0.0 },
      intensityCurve: { amount: ramp(4.0) },
    },
    // Detail circuit: wide sharpening so edges ring.
    {
      type: "sharpen",
      scaling: "reference-pixel",
      params: { amount: 0.0, radius: 3.6 },
      intensityCurve: { amount: ramp(0.96) },
    },
    // Chroma bleeds and lags along the scan line. Width is fixed; strength only mixes it in.
    {
      type: "chromaSmear",
      scaling: "reference-pixel",
      params: { amount: 0.0, width: 24.0, shift: 4.0 },
      intensityCurve: { amount: ramp(1.0) },
    },
    // Rest of the pedestal; whites already clip in the LUT.
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
    // Amplifier noise.
    {
      type: "grain",
      scaling: "reference-pixel",
      params: { size: 1.6, opacity: 0.0, shadowBias: 0.4 },
      intensityCurve: { opacity: ramp(0.07) },
    },
  ],
  intensity: { lutMix: lutMix() },
};

// Registry

/** No stages; the frame is still decoded and dithered. */
const CLEAN_RECIPE_ID = neutralRecipe().id;

export const DEFAULT_RECIPE_ID = CLEAN_RECIPE_ID;

/** For a recipe never used before. */
export const DEFAULT_STRENGTH = 0.6;

/** Picker order: neutral, then newest camera first. */
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
