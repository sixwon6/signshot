import { SeekerCamera, type PhotoEdit } from "../../modules/seeker-camera";
import { validateRecipe, type Recipe } from "./model";

/** Sole bridge from recipes to native, so viewfinder and Develop share one manifest per look. */

/** Global mix, 0..1. */
export const clampStrength = (value: number): number =>
  !Number.isFinite(value) ? 0 : value < 0 ? 0 : value > 1 ? 1 : value;

/** Resolves the `capture_pipeline_id`, a local fingerprint of the compiled shader; never published. */
export async function applyLive(recipe: Recipe): Promise<string> {
  validateRecipe(recipe);
  return SeekerCamera.applyProfile(JSON.stringify(recipe.manifest), recipe.lut);
}

/** 0..1. No shader recompile. */
export function setStrength(value: number): void {
  SeekerCamera.setIntensity(clampStrength(value));
}

/**
 * Re-develops a saved photo from its canonical frame into a new edit; originals are read-only.
 * `strength` is 0..1; native `editPhoto` requires an integer 0..100.
 */
export async function developPhoto(
  baseName: string,
  recipe: Recipe,
  strength: number,
): Promise<PhotoEdit> {
  validateRecipe(recipe);
  return SeekerCamera.editPhoto(
    baseName,
    JSON.stringify(recipe.manifest),
    recipe.lut,
    Math.round(clampStrength(strength) * 100),
  );
}
