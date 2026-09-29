import AsyncStorage from "@react-native-async-storage/async-storage";
import { createSerialQueue } from "../serial";
import {
  normalizeRecipeName,
  sameLook,
  validateRecipe,
  type Recipe,
  RECIPE_NAME_LIMIT,
} from "./model";
import { RETIRED_SUCCESSOR, isRetired, retiredById } from "./retired";
import { DEFAULT_RECIPE_ID, DEFAULT_STRENGTH, STARTERS } from "./starters";

/**
 * The photographer's saved recipes, starter overrides and last-used recipe, on this phone under one
 * key (`recipes.v1`). Starters themselves are never stored. Reads fail soft: an entry that no longer
 * validates is dropped so a corrupt recipe cannot take the camera down. Writes are validated first.
 *
 * What was stored against a starter that has since been retired is carried forward once, before
 * anything else touches the store (`migrateRetiredRecipes`).
 */

const RECIPE_STORE_KEY = "recipes.v1";

/** Where the camera was left. */
interface LastUsed {
  recipeId: string;
  /** 0..1, the global mix the renderer already applies. */
  strength: number;
}

/** A starter as the photographer has set it. Reset removes it and the shipped values return. */
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

/** An id a saved recipe may never take: a starter's, or one a starter used to have. */
const isReserved = (id: string): boolean => isBuiltIn(id) || isRetired(id);

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
      if (!isReserved(recipe.id) && !recipes.some((r) => r.id === recipe.id)) recipes.push(recipe);
    } catch {
      // Dropped: an entry the parameter table no longer recognises.
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
      // Dropped: an override the parameter table no longer recognises.
    }
  }
  const last = state.lastUsed;
  const lastUsed =
    last && typeof last.recipeId === "string" && Number.isFinite(last.strength)
      ? { recipeId: last.recipeId, strength: clamp01(last.strength) }
      : undefined;
  return { v: 1, recipes, overrides, lastUsed };
}

/** The starters as they are in force: shipped values, or the photographer's own settings. */
function startersInForce(state: StoredState): Recipe[] {
  return STARTERS.map((starter) => {
    const o = state.overrides?.[starter.id];
    return o ? { ...starter, manifest: o.manifest, lut: o.lut } : starter;
  });
}

async function write(state: StoredState): Promise<void> {
  await AsyncStorage.setItem(RECIPE_STORE_KEY, JSON.stringify(state));
}

/**
 * Every read-modify-write goes through one queue, so two saves in flight cannot each read the
 * same state and the second silently drop the first's recipe.
 */
const serial = createSerialQueue();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What the photographer had set over a retired starter, as a recipe of their own under the old
 * look's name, or null when there is nothing of theirs to keep: the override no longer validates,
 * or it is the retired starter exactly as it shipped.
 */
function ownedFromRetiredOverride(
  retiredId: string,
  candidate: unknown,
  taken: readonly { id: string }[],
): Recipe | null {
  const shipped = retiredById(retiredId);
  if (!shipped || !isRecord(candidate)) return null;
  try {
    const o = candidate as unknown as Override;
    const id = freshId(taken);
    const owned: Recipe = {
      id,
      name: shipped.name,
      manifest: { ...o.manifest, profileId: id },
      lut: o.lut ?? null,
      builtIn: false,
    };
    validateRecipe(owned);
    return sameLook(owned, shipped) ? null : owned;
  } catch {
    return null;
  }
}

/**
 * Carries forward what was stored against a retired starter: an override becomes a recipe of the
 * photographer's own, and a last-used retired starter becomes that recipe, or, where nothing of
 * theirs was set over it, its successor, at the same strength: the camera reopens on the look
 * that was in use, not on a stranger under a new name.
 * Works on the stored JSON as it is, because `read` would already have dropped a retired override.
 * A store with nothing retired in it is not written. Never rejects: a store it cannot read or
 * write is left for the next launch.
 */
async function carryRetiredForward(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(RECIPE_STORE_KEY);
    if (!raw) return;
    const state: unknown = JSON.parse(raw);
    if (!isRecord(state)) return;
    let changed = false;

    const recipes: unknown[] = Array.isArray(state.recipes) ? [...state.recipes] : [];
    const overrides = isRecord(state.overrides) ? { ...state.overrides } : undefined;
    /** Retired starter id to the recipe that now holds what was set over it. */
    const carried: Record<string, string> = {};
    for (const id of Object.keys(overrides ?? {})) {
      if (!isRetired(id)) continue;
      const taken = recipes.filter(
        (entry): entry is { id: string } => isRecord(entry) && typeof entry.id === "string",
      );
      const owned = ownedFromRetiredOverride(id, overrides![id], taken);
      if (owned) {
        recipes.push(owned);
        carried[id] = owned.id;
      }
      delete overrides![id];
      changed = true;
    }

    let lastUsed = state.lastUsed;
    if (isRecord(lastUsed) && typeof lastUsed.recipeId === "string" && isRetired(lastUsed.recipeId)) {
      lastUsed = { ...lastUsed, recipeId: carried[lastUsed.recipeId] ?? RETIRED_SUCCESSOR[lastUsed.recipeId] };
      changed = true;
    }

    if (!changed) return;
    const next: Record<string, unknown> = { ...state, recipes };
    if (overrides) next.overrides = overrides;
    if (lastUsed !== undefined) next.lastUsed = lastUsed;
    await AsyncStorage.setItem(RECIPE_STORE_KEY, JSON.stringify(next));
  } catch {
    // Left as it was. `lastUsed` still maps a retired id on read.
  }
}

/** Runs the carry-forward now, in the store's queue. Safe to run again: the second run finds nothing. */
export function migrateRetiredRecipes(): Promise<void> {
  return serial(carryRetiredForward);
}

let migration: Promise<void> | null = null;

/**
 * Once per launch, ahead of the store's first read or write. Writers only need it queued before
 * their own turn (the queue is first in, first out); readers wait for it.
 */
function ensureMigrated(): Promise<void> {
  migration ??= migrateRetiredRecipes();
  return migration;
}

/** Writes the photographer's settings over a starter. It stays a starter; Reset brings it back. */
export function setOverride(id: string, recipe: Recipe): Promise<Recipe> {
  void ensureMigrated();
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

/** Removes the photographer's settings from a starter and returns it as shipped. */
export function clearOverride(id: string): Promise<Recipe> {
  void ensureMigrated();
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
  await ensureMigrated();
  const state = await read();
  return [...startersInForce(state), ...state.recipes];
}

/** One recipe by id, starter or saved, or null. */
async function findRecipe(id: string): Promise<Recipe | null> {
  return (await allRecipes()).find((recipe) => recipe.id === id) ?? null;
}

function freshId(taken: readonly { id: string }[]): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const id = `rec.u.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.some((recipe) => recipe.id === id) && !isReserved(id)) return id;
  }
  throw new Error("Could not name a new recipe.");
}

/**
 * Saves `recipe` as a NEW recipe of the photographer's own, under `name`, and returns it with
 * the id it was given. Editing a starter and saving it therefore never touches the starter.
 */
export function saveRecipe(recipe: Recipe, name?: string): Promise<Recipe> {
  void ensureMigrated();
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

/** Writes new stage values into one of the photographer's own recipes. Starters are refused. */
export function updateRecipe(id: string, recipe: Recipe): Promise<Recipe> {
  void ensureMigrated();
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
  void ensureMigrated();
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

/** A name for a copy that still fits the bound. */
function copyName(name: string): string {
  const suffix = " copy";
  const points = [...name];
  const room = RECIPE_NAME_LIMIT - suffix.length;
  return `${points.length > room ? points.slice(0, room).join("").trimEnd() : name}${suffix}`;
}

/** Copies any recipe — starter or saved — into a new recipe of the photographer's own. */
export async function duplicateRecipe(id: string, name?: string): Promise<Recipe> {
  const source = await findRecipe(id);
  if (!source) throw new Error("That recipe is gone.");
  return saveRecipe(source, name ?? copyName(source.name));
}

/** Removes a saved recipe. Returns whether it was there. Starters are refused. */
export function deleteRecipe(id: string): Promise<boolean> {
  void ensureMigrated();
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

/**
 * Where the camera was left: the recipe it was on and the strength dial. Falls back to the phone's
 * own look at the default strength, including when the remembered recipe has been deleted.
 */
export async function lastUsed(): Promise<LastUsed> {
  await ensureMigrated();
  const state = await read();
  const fallback: LastUsed = { recipeId: DEFAULT_RECIPE_ID, strength: DEFAULT_STRENGTH };
  if (!state.lastUsed) return fallback;
  // The migration rewrites this on disk; mapped here too, so a write that failed loses nothing.
  const stored = state.lastUsed.recipeId;
  const recipeId = isRetired(stored) ? RETIRED_SUCCESSOR[stored] : stored;
  const known = isBuiltIn(recipeId) || state.recipes.some((recipe) => recipe.id === recipeId);
  return known ? { recipeId, strength: state.lastUsed.strength } : fallback;
}

export function setLastUsed(recipeId: string, strength: number): Promise<void> {
  void ensureMigrated();
  return serial(async () => {
    const state = await read();
    await write({
      ...state,
      lastUsed: { recipeId, strength: clamp01(Number.isFinite(strength) ? strength : 0) },
    });
  });
}
