import { buildLut, clamp01, luma601, sCurve, saturate, shoulder, type Rgb } from "./lut";
import type { Recipe, RecipeManifest } from "./model";

/**
 * Starters that no longer ship. Photographs taken with them still name them by `profileId`, so
 * they stay resolvable by id: for a photograph's label, and to develop it again with the look it
 * was taken with. They are never a choice: absent from `STARTERS` and from every picker.
 *
 * Grades and manifests are exactly as they shipped. Their ids are never reused.
 */

const LUT_SIZE = 17;

/** Cold, faintly magenta white balance; a hard contrast curve; crunchy primaries. */
function softDigital(r: number, g: number, b: number): Rgb {
  let R = r * 1.02;
  let G = g * 0.985;
  let B = b * 1.06;

  R = sCurve(R, 0.5);
  G = sCurve(G, 0.5);
  B = sCurve(B, 0.5);

  const rgb = saturate([R, G, B], 1.18);
  R = rgb[0];
  G = rgb[1];
  B = rgb[2];

  const sky = clamp01((B - R) * 2.2) * clamp01((B - 0.35) * 2.5);
  G += 0.06 * sky;
  B -= 0.035 * sky;

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
    {
      type: "resolutionSoften",
      scaling: "reference-pixel",
      params: { amount: 0.0 },
      intensityCurve: { amount: [[0, 0], [100, 1.3]] },
    },
    {
      type: "chromaticAberration",
      scaling: "reference-pixel",
      params: { shift: 0.0 },
      intensityCurve: { shift: [[0, 0], [50, 0.5], [100, 1.2]] },
    },
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
    {
      type: "vignette",
      scaling: "frame-relative",
      params: { radius: 0.85, softness: 0.5, strength: 0.0 },
      intensityCurve: { strength: [[0, 0], [100, 0.12]] },
    },
    {
      type: "grain",
      scaling: "reference-pixel",
      params: { size: 1.2, opacity: 0.0, shadowBias: 0.25 },
      intensityCurve: { opacity: [[0, 0], [50, 0.024], [100, 0.045]] },
    },
  ],
  intensity: { lutMix: [[0, 0], [100, 1]] },
};

/** A warm print; highlights that go creamy; green-cyan shadows under warm midtones. */
function warmFilm(r: number, g: number, b: number): Rgb {
  let R = r * 1.07;
  let G = g * 1.005;
  let B = b * 0.925;

  R = shoulder(R, 0.72, 4.2);
  G = shoulder(G, 0.72, 4.2);
  B = shoulder(B, 0.72, 4.2);

  const y = luma601(R, G, B);
  const sh = clamp01(1 - y * 2.2);
  R -= 0.012 * sh;
  G += 0.024 * sh;
  B += 0.008 * sh;

  return saturate([R, G, B], 1.06 - 0.28 * sh);
}

const warmFilmManifest: RecipeManifest = {
  schema: 1,
  profileId: "rec.warm-film",
  profileVersion: 1,
  rendererMin: "0.2.0",
  lut: { size: LUT_SIZE, space: "gamma" },
  stages: [
    {
      type: "resolutionSoften",
      scaling: "reference-pixel",
      params: { amount: 0.0 },
      intensityCurve: { amount: [[0, 0], [100, 1.1]] },
    },
    {
      type: "chromaticAberration",
      scaling: "reference-pixel",
      params: { shift: 0.0 },
      intensityCurve: { shift: [[0, 0], [100, 1.4]] },
    },
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
    {
      type: "vignette",
      scaling: "frame-relative",
      params: { radius: 0.6, softness: 0.4, strength: 0.0 },
      intensityCurve: { strength: [[0, 0], [60, 0.32], [100, 0.5]] },
    },
    {
      type: "grain",
      scaling: "reference-pixel",
      params: { size: 3.2, opacity: 0.0, shadowBias: 0.65 },
      intensityCurve: { opacity: [[0, 0], [50, 0.07], [100, 0.12]] },
    },
  ],
  intensity: { lutMix: [[0, 0], [100, 1]] },
};

/** Desaturated colour, lifted blacks, a flat white clip and a warm lean. */
function videoTape(r: number, g: number, b: number): Rgb {
  const rgb = saturate([r, g, b], 0.72);
  let R = rgb[0];
  let G = rgb[1];
  let B = rgb[2];

  R *= 1.045;
  B *= 0.94;

  const y = luma601(R, G, B);
  const mid = clamp01(1 - Math.abs(y - 0.45) * 2.6);
  G += 0.028 * mid;
  const hi = clamp01((y - 0.65) * 3);
  R += 0.022 * hi;
  B += 0.028 * hi;
  G -= 0.018 * hi;

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
    {
      type: "resolutionSoften",
      scaling: "reference-pixel",
      params: { amount: 0.0 },
      intensityCurve: { amount: [[0, 0], [50, 2.2], [100, 4.2]] },
    },
    {
      type: "chromaticAberration",
      scaling: "reference-pixel",
      params: { shift: 0.0 },
      intensityCurve: { shift: [[0, 0], [50, 1.5], [100, 3.0]] },
    },
    {
      type: "levels",
      scaling: "invariant",
      params: { inBlack: 0.0, inWhite: 1.0, gamma: 1.0, outBlack: 0.0, outWhite: 1.0 },
      intensityCurve: {
        inWhite: [[0, 1], [100, 0.87]],
        outBlack: [[0, 0], [50, 0.04], [100, 0.075]],
      },
    },
    {
      type: "vignette",
      scaling: "frame-relative",
      params: { radius: 0.75, softness: 0.45, strength: 0.0 },
      intensityCurve: { strength: [[0, 0], [100, 0.18]] },
    },
    {
      type: "grain",
      scaling: "reference-pixel",
      params: { size: 1.8, opacity: 0.0, shadowBias: 0.1 },
      intensityCurve: { opacity: [[0, 0], [50, 0.04], [100, 0.075]] },
    },
  ],
  intensity: { lutMix: [[0, 0], [60, 0.5], [100, 1]] },
};

/** Each retired id, and the starter that took its place. */
export const RETIRED_SUCCESSOR: Readonly<Record<string, string>> = {
  "rec.soft-digital": "rec.digicam",
  "rec.warm-film": "rec.disposable",
  "rec.video-tape": "rec.camcorder",
};

/** The name a photograph taken with a retired starter keeps. Needs no LUT, so it costs nothing. */
export const RETIRED_NAMES: Readonly<Record<string, string>> = {
  "rec.soft-digital": "Soft digital",
  "rec.warm-film": "Warm film",
  "rec.video-tape": "Video tape",
};

export const isRetired = (id: string): boolean =>
  Object.prototype.hasOwnProperty.call(RETIRED_SUCCESSOR, id);

let built: readonly Recipe[] | null = null;

/** The retired recipes, whole. Built on first use: the camera never needs them to open. */
function retiredRecipes(): readonly Recipe[] {
  built ??= [
    { manifest: softDigitalManifest, grade: softDigital },
    { manifest: warmFilmManifest, grade: warmFilm },
    { manifest: videoTapeManifest, grade: videoTape },
  ].map(({ manifest, grade }) => ({
    id: manifest.profileId,
    name: RETIRED_NAMES[manifest.profileId],
    manifest,
    lut: buildLut(LUT_SIZE, grade),
    // Not a starter any more: Develop shows it the way it shows any recipe that is off the row.
    builtIn: false,
  }));
  return built;
}

/** A retired starter exactly as it shipped, or null. */
export function retiredById(id: string | null): Recipe | null {
  if (id === null || !isRetired(id)) return null;
  return retiredRecipes().find((recipe) => recipe.id === id) ?? null;
}
