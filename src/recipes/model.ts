/**
 * The recipe model: a native stage manifest (schema 1) plus an optional colour LUT, handed to
 * `SeekerCamera` verbatim through `src/recipes/apply.ts`. Recipes stay on the phone.
 *
 * {@link STAGES} mirrors native `ShaderGen.STAGE_PARAMS` / `STAGE_SCALING` so the UI only asks for
 * parameters and ranges native accepts.
 */
import { hasUnsafeText } from "../../publications/core/details";

/** [strength 0..100, parameter value] — the renderer's own curve domain (`Profile.kt#evalCurve`). */
type CurvePoint = [number, number];

/** The one scaling law each stage type may declare; anything else fails native validation. */
type ScalingLaw = "invariant" | "frame-relative" | "reference-pixel";

/** Every stage type in the native registry. The colour LUT is not a stage; it is `Recipe.lut`. */
export type StageType =
  | "resolutionSoften"
  | "sharpen"
  | "chromaticAberration"
  | "chromaSmear"
  | "temperatureTint"
  | "saturation"
  | "contrast"
  | "levels"
  | "halation"
  | "vignette"
  | "grain"
  | "border";

interface RecipeStage {
  type: StageType;
  scaling: ScalingLaw;
  /** Static values. A parameter also named in intensityCurve is driven by the curve instead. */
  params: Record<string, number>;
  intensityCurve?: Record<string, CurvePoint[]>;
}

/** The native manifest, unchanged. `profileId` is the recipe's id; it is never published. */
export interface RecipeManifest {
  schema: 1;
  profileId: string;
  profileVersion: number;
  rendererMin: string;
  lut?: { size: number; space: "gamma" | "linear" };
  stages: RecipeStage[];
  intensity?: { lutMix: CurvePoint[] };
}

export interface Recipe {
  /** Always equal to `manifest.profileId`. Starters are `rec.*`; Clean keeps `prof.neutral`. */
  id: string;
  name: string;
  manifest: RecipeManifest;
  /** base64 RGBA8 3D LUT, or null. Present exactly when `manifest.lut` is declared. */
  lut: string | null;
  /** A shipped starter: never stored, never renamed, never deleted. */
  builtIn: boolean;
}

/** What a slider is counting, so the editor can format a value without knowing the stage. */
type ParamUnit =
  /** 0..1-ish, shown as a percentage. */
  | "unit"
  /** -1..1, zero in the middle. */
  | "signed"
  /** A multiplier around 1. */
  | "factor"
  /** Pixels at the 4000 px reference long edge (`GlRenderer.REF_LONG_EDGE`). */
  | "refPixels"
  /** A fraction of the frame's short edge. */
  | "frame";

export interface ParamSpec {
  stage: StageType;
  param: string;
  /** One word. */
  label: string;
  unit: ParamUnit;
  min: number;
  max: number;
  step: number;
  /** The value at which this parameter does nothing. */
  neutral: number;
}

interface StageSpec {
  type: StageType;
  /** One word. */
  label: string;
  scaling: ScalingLaw;
  /** True when the renderer applies this stage at source-sample time, wherever it sits. */
  sampleTime: boolean;
  params: readonly ParamSpec[];
}

const spec = (
  stage: StageType,
  param: string,
  label: string,
  unit: ParamUnit,
  min: number,
  max: number,
  step: number,
  neutral: number,
): ParamSpec => ({ stage, param, label, unit, min, max, step, neutral });

/**
 * The parameter table, in the order a recipe's stages are held and shown. Sample-time stages come
 * first because the renderer applies them while sampling the source wherever they sit; vignette
 * precedes grain so noise lies on top of darkened corners. The LUT runs before every stage.
 */
export const STAGES: readonly StageSpec[] = [
  {
    type: "resolutionSoften",
    label: "Softness",
    scaling: "reference-pixel",
    sampleTime: true,
    params: [spec("resolutionSoften", "amount", "Amount", "refPixels", 0, 6, 0.1, 0)],
  },
  {
    type: "sharpen",
    label: "Sharpness",
    scaling: "reference-pixel",
    sampleTime: true,
    params: [
      spec("sharpen", "amount", "Amount", "unit", 0, 1, 0.01, 0),
      spec("sharpen", "radius", "Radius", "refPixels", 0.5, 4, 0.1, 1),
    ],
  },
  {
    type: "chromaticAberration",
    label: "Fringing",
    scaling: "reference-pixel",
    sampleTime: true,
    params: [spec("chromaticAberration", "shift", "Shift", "refPixels", 0, 6, 0.1, 0)],
  },
  {
    type: "chromaSmear",
    label: "Smear",
    scaling: "reference-pixel",
    sampleTime: true,
    params: [
      spec("chromaSmear", "amount", "Amount", "unit", 0, 1, 0.01, 0),
      // The 10-90 % chroma transition. The ceiling sits just under where a 3264 px still's
      // half-resolution chroma planes are sampled more than two texels apart (29.4 at 13 taps):
      // past that the still shows a ribbed trail the preview does not.
      // `scripts/check-smear.mjs` measures both and reports where the taps stop overlapping.
      spec("chromaSmear", "width", "Width", "refPixels", 0, 28, 0.5, 24),
      // Chroma delay: rightward in the upright picture, never leftward.
      spec("chromaSmear", "shift", "Shift", "refPixels", 0, 12, 0.5, 0),
    ],
  },
  {
    type: "temperatureTint",
    label: "Warmth",
    scaling: "invariant",
    sampleTime: false,
    params: [
      spec("temperatureTint", "temperature", "Warmth", "signed", -1, 1, 0.01, 0),
      spec("temperatureTint", "tint", "Tint", "signed", -1, 1, 0.01, 0),
    ],
  },
  {
    type: "saturation",
    label: "Saturation",
    scaling: "invariant",
    sampleTime: false,
    params: [spec("saturation", "amount", "Amount", "factor", 0, 2, 0.01, 1)],
  },
  {
    type: "contrast",
    label: "Contrast",
    scaling: "invariant",
    sampleTime: false,
    params: [
      spec("contrast", "amount", "Amount", "factor", 0, 2, 0.01, 1),
      spec("contrast", "pivot", "Pivot", "unit", 0, 1, 0.01, 0.5),
    ],
  },
  {
    type: "levels",
    label: "Levels",
    scaling: "invariant",
    sampleTime: false,
    params: [
      spec("levels", "inBlack", "Black", "unit", 0, 1, 0.005, 0),
      spec("levels", "inWhite", "White", "unit", 0, 1, 0.005, 1),
      spec("levels", "gamma", "Gamma", "factor", 0.2, 3, 0.01, 1),
      spec("levels", "outBlack", "Lift", "unit", 0, 1, 0.005, 0),
      spec("levels", "outWhite", "Ceiling", "unit", 0, 1, 0.005, 1),
    ],
  },
  {
    type: "halation",
    label: "Halation",
    scaling: "reference-pixel",
    sampleTime: false,
    params: [
      spec("halation", "threshold", "Threshold", "unit", 0, 1, 0.01, 0.75),
      spec("halation", "radius", "Radius", "refPixels", 1, 16, 0.5, 6),
      spec("halation", "strength", "Strength", "unit", 0, 1, 0.01, 0),
    ],
  },
  {
    type: "vignette",
    label: "Vignette",
    scaling: "frame-relative",
    sampleTime: false,
    params: [
      spec("vignette", "radius", "Radius", "unit", 0.1, 1, 0.01, 0.85),
      spec("vignette", "softness", "Softness", "unit", 0.01, 1, 0.01, 0.5),
      spec("vignette", "strength", "Strength", "unit", 0, 1, 0.01, 0),
    ],
  },
  {
    type: "grain",
    label: "Grain",
    scaling: "reference-pixel",
    sampleTime: false,
    params: [
      spec("grain", "size", "Size", "refPixels", 0.5, 6, 0.1, 1.5),
      spec("grain", "opacity", "Opacity", "unit", 0, 0.3, 0.005, 0),
      spec("grain", "shadowBias", "Shadows", "unit", 0, 1, 0.01, 0),
    ],
  },
  {
    type: "border",
    label: "Border",
    scaling: "frame-relative",
    sampleTime: false,
    params: [
      spec("border", "width", "Width", "frame", 0, 0.1, 0.002, 0),
      spec("border", "red", "Red", "unit", 0, 1, 0.01, 0),
      spec("border", "green", "Green", "unit", 0, 1, 0.01, 0),
      spec("border", "blue", "Blue", "unit", 0, 1, 0.01, 0),
    ],
  },
];

/** Stage types in graph order. */
const STAGE_ORDER: readonly StageType[] = STAGES.map((s) => s.type);

const SPEC_OF = new Map<StageType, StageSpec>(STAGES.map((s) => [s.type, s]));

function stageSpec(type: StageType): StageSpec {
  const found = SPEC_OF.get(type);
  if (!found) throw new Error(`unknown stage '${type}'`);
  return found;
}

function paramSpec(type: StageType, param: string): ParamSpec {
  const found = stageSpec(type).params.find((p) => p.param === param);
  if (!found) throw new Error(`stage '${type}' has no parameter '${param}'`);
  return found;
}

const rank = (type: StageType) => STAGE_ORDER.indexOf(type);

/** Every parameter at its neutral value: the stage present but doing nothing. */
function neutralStage(type: StageType): RecipeStage {
  const s = stageSpec(type);
  const params: Record<string, number> = {};
  for (const p of s.params) params[p.param] = p.neutral;
  return { type: s.type, scaling: s.scaling, params };
}

/** "Clean": no stages, no LUT. The manifest is pinned byte for byte so its `capture_pipeline_id` is stable. */
export function neutralRecipe(): Recipe {
  return {
    id: "prof.neutral",
    name: "Clean",
    manifest: {
      schema: 1,
      profileId: "prof.neutral",
      profileVersion: 1,
      rendererMin: "0.2.0",
      stages: [],
    },
    lut: null,
    builtIn: true,
  };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * `recipe` with one parameter set directly, keeping its id. A missing stage is inserted in graph
 * order; this parameter's intensityCurve is dropped so strength cannot rewrite the chosen value.
 * The camera uses this, so a photo taken mid-edit records the same `profileId` the store saves.
 */
export function setParam(
  recipe: Recipe,
  stage: StageType,
  param: string,
  value: number,
): Recipe {
  const p = paramSpec(stage, param);
  if (!Number.isFinite(value)) throw new Error(`${stage}.${param} must be a number`);
  if (value < p.min || value > p.max)
    throw new Error(`${stage}.${param} must be between ${p.min} and ${p.max}`);
  const next = clone(recipe);
  let target = next.manifest.stages.find((s) => s.type === stage);
  if (!target) {
    target = neutralStage(stage);
    const at = next.manifest.stages.findIndex((s) => rank(s.type) > rank(stage));
    next.manifest.stages.splice(at < 0 ? next.manifest.stages.length : at, 0, target);
  }
  target.params[param] = value;
  if (target.intensityCurve) {
    delete target.intensityCurve[param];
    if (Object.keys(target.intensityCurve).length === 0) delete target.intensityCurve;
  }
  return next;
}

/**
 * The same move as an unsaved recipe with a content-hash id (`rec.unsaved.<hash>`), so a starter's
 * id is never recorded against a manifest that is not the starter's. Develop uses this.
 */
export function withParam(
  recipe: Recipe,
  stage: StageType,
  param: string,
  value: number,
): Recipe {
  const next = setParam(recipe, stage, param, value);
  next.builtIn = false;
  next.id = unsavedId(next);
  next.manifest.profileId = next.id;
  return next;
}

/** FNV-1a over the recipe's content: two identical edits share an id, two different never do. */
function unsavedId(recipe: Pick<Recipe, "manifest" | "lut">): string {
  const text = JSON.stringify(recipe.manifest.stages) + "|" + (recipe.lut ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `rec.unsaved.${h.toString(16).padStart(8, "0")}`;
}

/** Piecewise-linear read of an intensityCurve at `at` (0..100), or `fallback` without one. */
function evalCurve(curve: CurvePoint[] | undefined, fallback: number, at: number): number {
  if (!curve || curve.length === 0) return fallback;
  if (at <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i - 1];
    const [x2, y2] = curve[i];
    if (at <= x2) return x2 === x1 ? y2 : y1 + (y2 - y1) * ((at - x1) / (x2 - x1));
  }
  return curve[curve.length - 1][1];
}

/**
 * The value a parameter actually has at `strength` (0..1): its curve read at that strength the
 * way the renderer reads it, else its static value, else neutral. This is what a slider shows;
 * moving the slider then bakes the number through `withParam`.
 */
export function effectiveParam(recipe: Recipe, spec: ParamSpec, strength: number): number {
  const stage = recipe.manifest.stages.find((s) => s.type === spec.stage);
  if (!stage) return spec.neutral;
  const held = stage.params[spec.param];
  const at = Math.max(0, Math.min(1, strength)) * 100;
  return evalCurve(stage.intensityCurve?.[spec.param], typeof held === "number" ? held : spec.neutral, at);
}

/** True when two recipes develop a photograph identically (same stages and LUT); names and ids are ignored. */
export function sameLook(a: Recipe, b: Recipe): boolean {
  return (
    a.lut === b.lut &&
    JSON.stringify(a.manifest.stages) === JSON.stringify(b.manifest.stages)
  );
}

/** True when nothing in this stage moves the picture, at any strength. */
export function isNeutralStage(stage: RecipeStage): boolean {
  return stageSpec(stage.type).params.every((p) => {
    const curve = stage.intensityCurve?.[p.param];
    if (curve && curve.length > 0) return curve.every(([, y]) => y === p.neutral);
    return (stage.params[p.param] ?? p.neutral) === p.neutral;
  });
}

/** The bound on a recipe name, in Unicode code points. */
export const RECIPE_NAME_LIMIT = 32;

/** A recipe name as it may be stored: trimmed, present, bounded, printable. */
export function normalizeRecipeName(input: unknown): string {
  if (typeof input !== "string") throw new Error("A recipe needs a name.");
  const name = input.trim();
  if (name.length === 0) throw new Error("A recipe needs a name.");
  if ([...name].length > RECIPE_NAME_LIMIT || hasUnsafeText(name))
    throw new Error(`Use a name of up to ${RECIPE_NAME_LIMIT} characters, on one line.`);
  return name;
}

/**
 * Refuses anything the renderer would refuse, and anything outside the parameter table, BEFORE
 * it reaches the GL thread or the store. Throws the first problem, naming it.
 */
export function validateRecipe(recipe: Recipe): void {
  const m = recipe.manifest;
  if (m.schema !== 1) throw new Error("recipe: manifest schema must be 1");
  normalizeRecipeName(recipe.name);
  if (recipe.id.length === 0) throw new Error("recipe: id must not be empty");
  if (recipe.id !== m.profileId) throw new Error("recipe: id must equal manifest.profileId");
  if (!Number.isInteger(m.profileVersion) || m.profileVersion < 1)
    throw new Error("recipe: profileVersion must be a positive integer");
  if (!!m.lut !== (recipe.lut !== null))
    throw new Error("recipe: a declared lut needs a payload, and a payload needs a declaration");
  const seen = new Set<StageType>();
  for (const stage of m.stages) {
    const s = stageSpec(stage.type);
    if (seen.has(stage.type)) throw new Error(`recipe: duplicate stage '${stage.type}'`);
    seen.add(stage.type);
    if (stage.scaling !== s.scaling)
      throw new Error(`recipe: stage '${stage.type}' scaling must be '${s.scaling}'`);
    const known = new Set(s.params.map((p) => p.param));
    for (const name of Object.keys(stage.params))
      if (!known.has(name)) throw new Error(`recipe: stage '${stage.type}' has no '${name}'`);
    for (const name of Object.keys(stage.intensityCurve ?? {}))
      if (!known.has(name)) throw new Error(`recipe: stage '${stage.type}' has no '${name}'`);
    for (const p of s.params) {
      const curve = stage.intensityCurve?.[p.param];
      if (stage.params[p.param] === undefined && !curve)
        throw new Error(`recipe: stage '${stage.type}' is missing '${p.param}'`);
      const values: number[] = [];
      if (stage.params[p.param] !== undefined) values.push(stage.params[p.param]);
      for (const point of curve ?? []) {
        if (point.length !== 2 || !Number.isFinite(point[0]) || point[0] < 0 || point[0] > 100)
          throw new Error(`recipe: stage '${stage.type}' curve '${p.param}' is not 0..100`);
        values.push(point[1]);
      }
      for (const value of values)
        if (!Number.isFinite(value) || value < p.min || value > p.max)
          throw new Error(
            `recipe: ${stage.type}.${p.param} must be between ${p.min} and ${p.max}`,
          );
    }
  }
}
