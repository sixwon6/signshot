/**
 * The Develop screen's labels, and the function that turns a parameter into a readout. Stage and
 * parameter names come from the engine's table (`STAGES` in `src/recipes/model.ts`), not from here.
 */
import type { ParamSpec } from "../recipes/model";

export const develop = {
  heading: "Develop",
  close: "Close",
  recipe: "Recipe",
  /** Shown as the selected chip once a parameter has been moved off the chosen recipe. */
  custom: "Custom",
  strength: "Strength",
  adjustments: "More adjustments",
  hideAdjustments: "Hide adjustments",
  /** Press and hold the photograph to see the canonical frame with no recipe on it. */
  original: "Original",
  use: "Use",
  developing: "Developing…",
  saving: "Saving…",
  saveRecipe: "Save recipe",
  name: "Name",
  keep: "Keep",
  cancel: "Cancel",
  /** The photo page's own pill, which opens this screen. */
  develop: "Develop",
  /** A photograph with no published title and no recipe to name it by. */
  untitled: "Photograph",
} as const;

export const strengthValue = (value: number) => `${Math.round(value * 100)}%`;

/** One parameter's value, in the unit the parameter table declares it in. */
export function paramValue(spec: ParamSpec, value: number): string {
  switch (spec.unit) {
    case "unit":
    case "frame":
      return strengthValue(value);
    case "signed":
      return `${value > 0 ? "+" : ""}${Math.round(value * 100)}%`;
    case "factor":
      return `${value.toFixed(2)}×`;
    case "refPixels":
      return `${value.toFixed(1)} px`;
  }
}

/** The pixel size of the version being made. */
export function pixelValue(width: number, height: number): string {
  return `${width} × ${height}`;
}
