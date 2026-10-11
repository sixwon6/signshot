import AsyncStorage from "@react-native-async-storage/async-storage";
import { createSerialQueue } from "../serial";
import {
  normalizeRecipeName,
  validateRecipe,
  type Recipe,
  RECIPE_NAME_LIMIT,
} from "./model";
import { DEFAULT_RECIPE_ID, DEFAULT_STRENGTH, STARTERS } from "./starters";

/**
 * Saved recipes, starter overrides and last-used, under one key. Starters are never stored. Entries
 * that no longer validate are dropped on read so a corrupt recipe can't take the camera down.
 */

const RECIPE_STORE_KEY = "recipes.v1";

interface LastUsed {
  recipeId: string;
  /** Global mix, 0..1. */
  strength: number;
}

/** User edits to a starter; Reset deletes it. */
interface Override {
  manifest: Recipe["manifest"];
  lut: string | null;
}

interface StoredState {
  v: 1;
  recipes: Recipe[];
  overrides?: Record<string, Override>;
  lastUsed?: LastUsed;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

const isBuiltIn = (id: string): boolean => STARTERS.some((recipe) => recipe.id === id);

async function read(): Promise<StoredState> {
  const empty: StoredState = { v: 1, recipes: [] };
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(RECIPE_STORE_KEY);
  } catch {
    return empty;
  }
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const state = parsed as Partial<StoredState>;
  const recipes: Recipe[] = [];
  for (const candidate of Array.isArray(state.recipes) ? state.recipes : []) {
    try {
      const recipe = { ...(candidate as Recipe), builtIn: false };
      validateRecipe(recipe);
      if (!isBuiltIn(recipe.id) && !recipes.some((r) => r.id === recipe.id)) recipes.push(recipe);
    } catch {
      // No longer valid against the parameter table.
    }
  }
  const overrides: Record<string, Override> = {};
  for (const [id, candidate] of Object.entries(state.overrides ?? {})) {
    const starter = STARTERS.find((r) => r.id === id);
    if (!starter || typeof candidate !== "object" || candidate === null) continue;
    try {
      const o = candidate as Override;
      const recipe: Recipe = { ...starter, manifest: { ...o.manifest, profileId: id }, lut: o.lut ?? null };
      validateRecipe(recipe);
      overrides[id] = { manifest: recipe.manifest, lut: recipe.lut };
    } catch {
      // No longer valid against the parameter table.
    }
  }
  const last = state.lastUsed;
  const lastUsed =
    last && typeof last.recipeId === "string" && Number.isFinite(last.strength)
      ? { recipeId: last.recipeId, strength: clamp01(last.strength) }
      : undefined;
  return { v: 1, recipes, overrides, lastUsed };
}

function startersInForce(state: StoredState): Recipe[] {
  return STARTERS.map((starter) => {
    const o = state.overrides?.[starter.id];
    return o ? { ...starter, manifest: o.manifest, lut: o.lut } : starter;
  });
}

async function write(state: StoredState): Promise<void> {
  await AsyncStorage.setItem(RECIPE_STORE_KEY, JSON.stringify(state));
}

/** Serialises read-modify-write so concurrent saves can't drop each other. */
const serial = createSerialQueue();

export function setOverride(id: string, recipe: Recipe): Promise<Recipe> {
  return serial(async () => {
    const starter = STARTERS.find((r) => r.id === id);
    if (!starter) throw new Error("Only a starter can be set this way.");
    const next: Recipe = { ...starter, manifest: { ...recipe.manifest, profileId: id }, lut: recipe.lut };
    validateRecipe(next);
    const state = await read();
    await write({
      ...state,
      overrides: { ...(state.overrides ?? {}), [id]: { manifest: next.manifest, lut: next.lut } },
    });
    return next;
  });
}

export function clearOverride(id: string): Promise<Recipe> {
  return serial(async () => {
    const starter = STARTERS.find((r) => r.id === id);
    if (!starter) throw new Error("Only a starter can be reset this way.");
    const state = await read();
    const overrides = { ...(state.overrides ?? {}) };
    delete overrides[id];
    await write({ ...state, overrides });
    return starter;
  });
}

export async function allRecipes(): Promise<Recipe[]> {
  const state = await read();
  return [...startersInForce(state), ...state.recipes];
}

async function findRecipe(id: string): Promise<Recipe | null> {
  return (await allRecipes()).find((recipe) => recipe.id === id) ?? null;
}

function freshId(taken: readonly { id: string }[]): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const id = `rec.u.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.some((recipe) => recipe.id === id) && !isBuiltIn(id)) return id;
  }
  throw new Error("Could not name a new recipe.");
}

/** Always saves under a fresh id, so saving an edited starter never touches the starter. */
export function saveRecipe(recipe: Recipe, name?: string): Promise<Recipe> {
  return serial(async () => {
    const state = await read();
    const id = freshId(state.recipes);
    const saved: Recipe = {
      ...recipe,
      id,
      name: normalizeRecipeName(name ?? recipe.name),
      manifest: { ...recipe.manifest, profileId: id },
      builtIn: false,
    };
    validateRecipe(saved);
    await write({ ...state, recipes: [...state.recipes, saved] });
    return saved;
  });
}

export function updateRecipe(id: string, recipe: Recipe): Promise<Recipe> {
  return serial(async () => {
    if (isBuiltIn(id)) throw new Error("A starter cannot be changed. Save a copy.");
    const state = await read();
    const found = state.recipes.find((r) => r.id === id);
    if (!found) throw new Error("That recipe is gone.");
    const updated: Recipe = {
      ...found,
      manifest: { ...recipe.manifest, profileId: id },
      lut: recipe.lut,
    };
    validateRecipe(updated);
    await write({ ...state, recipes: state.recipes.map((r) => (r.id === id ? updated : r)) });
    return updated;
  });
}

export function renameRecipe(id: string, name: string): Promise<Recipe> {
  return serial(async () => {
    const next = normalizeRecipeName(name);
    if (isBuiltIn(id)) throw new Error("A starter cannot be renamed.");
    const state = await read();
    const found = state.recipes.find((recipe) => recipe.id === id);
    if (!found) throw new Error("That recipe is gone.");
    const renamed = { ...found, name: next };
    await write({
      ...state,
      recipes: state.recipes.map((recipe) => (recipe.id === id ? renamed : recipe)),
    });
    return renamed;
  });
}

function copyName(name: string): string {
  const suffix = " copy";
  const points = [...name];
  const room = RECIPE_NAME_LIMIT - suffix.length;
  return `${points.length > room ? points.slice(0, room).join("").trimEnd() : name}${suffix}`;
}

export async function duplicateRecipe(id: string, name?: string): Promise<Recipe> {
  const source = await findRecipe(id);
  if (!source) throw new Error("That recipe is gone.");
  return saveRecipe(source, name ?? copyName(source.name));
}

/** Returns whether it existed. */
export function deleteRecipe(id: string): Promise<boolean> {
  return serial(async () => {
    if (isBuiltIn(id)) throw new Error("A starter cannot be deleted.");
    const state = await read();
    const kept = state.recipes.filter((recipe) => recipe.id !== id);
    if (kept.length === state.recipes.length) return false;
    const lastUsed = state.lastUsed?.recipeId === id ? undefined : state.lastUsed;
    await write({ ...state, recipes: kept, lastUsed });
    return true;
  });
}

/** Falls back to the default recipe and strength, including when the remembered one was deleted. */
export async function lastUsed(): Promise<LastUsed> {
  const state = await read();
  const fallback: LastUsed = { recipeId: DEFAULT_RECIPE_ID, strength: DEFAULT_STRENGTH };
  if (!state.lastUsed) return fallback;
  const { recipeId } = state.lastUsed;
  const known = isBuiltIn(recipeId) || state.recipes.some((recipe) => recipe.id === recipeId);
  return known ? { recipeId, strength: state.lastUsed.strength } : fallback;
}

export function setLastUsed(recipeId: string, strength: number): Promise<void> {
  return serial(async () => {
    const state = await read();
    await write({
      ...state,
      lastUsed: { recipeId, strength: clamp01(Number.isFinite(strength) ? strength : 0) },
    });
  });
}
