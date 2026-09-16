import { SeekerCamera, type PhotoEdit } from "../../modules/seeker-camera";
import { validateRecipe, type Recipe } from "./model";

/**
 * The only place a recipe crosses into native (`applyProfile`, `editPhoto`, `setIntensity`), so the
 * viewfinder and Develop use one manifest per look. Recipes are validated first, so an invalid
 * manifest fails here with a message naming the parameter.
 */

/** 0..1, the global mix. */
export const clampStrength = (value: number): number =>
  !Number.isFinite(value) ? 0 : value < 0 ? 0 : value > 1 ? 1 : value;

/**
 * Puts `recipe` on the viewfinder, resolving the `capture_pipeline_id` now in force. Local: the
 * id is a fingerprint of the compiled shader and is not published anywhere.
 */
export async function applyLive(recipe: Recipe): Promise<string> {
  validateRecipe(recipe);
  return SeekerCamera.applyProfile(JSON.stringify(recipe.manifest), recipe.lut);
}

/** The strength dial, 0..1. Frame-tight: it does not recompile the shader. */
export function setStrength(value: number): void {
  SeekerCamera.setIntensity(clampStrength(value));
}

/**
 * Develops a saved photograph again, from its canonical frame, with `recipe` at `strength`.
 * Writes a new edit beside the capture and resolves it; the original frames are only read.
 *
 * `strength` is 0..1 here like everywhere in JS; native `editPhoto` takes an integer 0..100
 * and rejects anything else, so the unit is converted at this one boundary.
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
