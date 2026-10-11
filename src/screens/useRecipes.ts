import { useCallback, useEffect, useRef, useState } from "react";
import {
  isNeutralStage,
  neutralRecipe,
  normalizeRecipeName,
  sameLook,
  setParam,
  STAGES,
  type Recipe,
  type StageType,
} from "../recipes/model";
import { DEFAULT_STRENGTH, STARTERS, starterById } from "../recipes/starters";
import {
  allRecipes,
  clearOverride,
  deleteRecipe,
  duplicateRecipe,
  lastUsed,
  renameRecipe,
  saveRecipe,
  setLastUsed,
  setOverride,
  updateRecipe,
} from "../recipes/store";
import { applyLive, clampStrength, setStrength } from "../recipes/apply";
import { isCameraViewNotReady } from "../capture/apply";
import { safeErrorText } from "../ui/errorText";
import { camera as cameraCopy } from "../ui/copy";
import { debounce, throttle, useDeferred } from "../timing";

// Recipe state for the camera. Edits save under the existing id (`setOverride` for starters,
// `updateRecipe` for user recipes) so a photo taken mid-edit records the right `profileId`.

/** At most one live apply per this interval while dragging. */
const APPLY_THROTTLE_MS = 60;
/** Persist this long after the last slider move. */
const PERSIST_DEBOUNCE_MS = 300;
const LAST_USED_DEBOUNCE_MS = 400;
/** Show the loading state only past this, so quick taps don't flash it. */
const SLOW_APPLY_MS = 500;
/** Retries while a fresh camera view isn't ready (cold start). */
const APPLY_ATTEMPTS = 8;
const APPLY_RETRY_MS = 250;

interface RecipesInForce {
  /** Built-ins (with overrides), then user recipes, in display order. */
  choices: readonly Recipe[];
  /** Live recipe including unsaved edits; null until loaded. */
  recipe: Recipe | null;
  /** The saved recipe being edited. */
  origin: Recipe | null;
  /** Global mix, 0..1. */
  strength: number;
  applying: boolean;
  /** `applying` for longer than SLOW_APPLY_MS. */
  slowApply: boolean;
  /** Unedited neutral look: strength has nothing to mix. */
  isClean: boolean;
  canReset: boolean;
  /** Live apply failure, or "". */
  applyError: string;
  /** Last failed store write, or "". */
  error: string;
  clearError(): void;
  /** Returns the stage to open when `next` is already selected; otherwise switches and returns null. */
  choose(next: Recipe): StageType | null;
  changeStrength(value: number): void;
  changeParam(stage: StageType, param: string, value: number): void;
  /** Each resolves false with {@link error} set on failure. */
  create(name: string): Promise<boolean>;
  rename(target: Recipe, name: string): Promise<boolean>;
  duplicate(target: Recipe): Promise<boolean>;
  remove(target: Recipe): Promise<boolean>;
  reset(): Promise<boolean>;
}

export function useRecipes({
  live,
  generation,
  busy,
}: {
  /** Nothing is applied until true. */
  live: boolean;
  /** Bumped on camera view rebuild; triggers a re-apply. */
  generation: number;
  /** While true, changes are refused rather than queued. */
  busy: boolean;
}): RecipesInForce {
  const [inForce, setInForce] = useState<readonly Recipe[]>(STARTERS);
  const [mine, setMine] = useState<readonly Recipe[]>([]);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [origin, setOrigin] = useState<Recipe | null>(null);
  const [dirty, setDirty] = useState(false);
  const [strength, setStrengthValue] = useState(DEFAULT_STRENGTH);
  const [applying, setApplying] = useState(true);
  const [slowApply, setSlowApply] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [error, setError] = useState("");

  /** Lets the apply effect read strength without depending on it. */
  const strengthRef = useRef(strength);
  strengthRef.current = strength;
  /** True when the pending change came from a drag; only drags are throttled. */
  const dragging = useRef(false);
  const show = (next: Recipe, fromThumb = false) => {
    dragging.current = fromThumb;
    setRecipe(next);
  };

  const clearError = useCallback(() => setError(""), []);

  const applySoon = useDeferred(() => throttle(APPLY_THROTTLE_MS));
  const persistSoon = useDeferred(() => debounce(PERSIST_DEBOUNCE_MS));
  const rememberSoon = useDeferred(() => debounce(LAST_USED_DEBOUNCE_MS));

  // Restore last-used recipe and strength; a deleted recipe falls back to the first (`lastUsed`).
  useEffect(() => {
    let alive = true;
    Promise.all([allRecipes(), lastUsed()])
      .then(([all, last]) => {
        if (!alive) return;
        setInForce(all.filter((one) => one.builtIn));
        setMine(all.filter((one) => !one.builtIn));
        const found = all.find((one) => one.id === last.recipeId) ?? all[0];
        setOrigin(found);
        show(found);
        setStrengthValue(clampStrength(last.strength));
      })
      .catch(() => {
        if (!alive) return;
        setOrigin(STARTERS[0]);
        show(STARTERS[0]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // A rebuilt view may not be ready yet, hence the retry. Taps apply immediately; drags are
  // throttled (each apply crosses the bridge) and the last sample always lands.
  useEffect(() => {
    if (!live || recipe === null) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    setApplying(true);
    setApplyError("");
    const apply = () => {
      attempts++;
      applyLive(recipe)
        .then(() => {
          if (cancelled) return;
          setStrength(strengthRef.current);
          setApplying(false);
        })
        .catch((cause) => {
          if (cancelled) return;
          if (isCameraViewNotReady(cause) && attempts < APPLY_ATTEMPTS) {
            retry = setTimeout(apply, APPLY_RETRY_MS);
            return;
          }
          setApplyError(cameraCopy.recipeLoadError);
          setApplying(false);
          if (__DEV__) console.warn("Recipe failed to apply", cause);
        });
    };
    if (dragging.current) {
      applySoon.run(apply);
    } else {
      applySoon.cancel();
      apply();
    }
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [live, recipe, generation, applySoon]);

  // Preserve the throttle window across recipe changes, but never apply to a closed camera.
  useEffect(() => {
    if (!live) applySoon.cancel();
  }, [live, applySoon]);

  useEffect(() => {
    if (!applying) {
      setSlowApply(false);
      return;
    }
    const timer = setTimeout(() => setSlowApply(true), SLOW_APPLY_MS);
    return () => clearTimeout(timer);
  }, [applying]);

  // Debounced so drags don't write on every sample.
  useEffect(() => {
    if (recipe === null) return;
    rememberSoon.run(() => {
      void setLastUsed(recipe.id, strength).catch(() => {});
    });
  }, [recipe, strength, rememberSoon]);

  const refresh = useCallback(async () => {
    const all = await allRecipes();
    setInForce(all.filter((one) => one.builtIn));
    setMine(all.filter((one) => !one.builtIn));
  }, []);

  // Develop can save recipes too, so re-read when the camera returns.
  useEffect(() => {
    if (live) void refresh().catch(() => {});
  }, [live, refresh]);

  const attempt = useCallback(async (work: () => Promise<void>): Promise<boolean> => {
    setError("");
    try {
      await work();
      return true;
    } catch (cause) {
      setError(safeErrorText(cause, cameraCopy.recipeSaveError));
      return false;
    }
  }, []);

  const isClean = recipe !== null && recipe.id === STARTERS[0].id && !dirty;
  const shipped = origin !== null && origin.builtIn ? starterById(origin.id) : null;
  const canReset =
    recipe !== null &&
    origin !== null &&
    (shipped === null ? dirty : !sameLook(recipe, shipped));

  const choose = (next: Recipe): StageType | null => {
    if (busy) return null;
    if (origin?.id === next.id) {
      const first = (recipe ?? next).manifest.stages.find((s) => !isNeutralStage(s));
      return first ? first.type : STAGES[0].type;
    }
    persistSoon.cancel();
    setDirty(false);
    setOrigin(next);
    show(next);
    return null;
  };

  const changeStrength = (value: number) => {
    if (recipe === null || busy || applying || isClean) return;
    const next = clampStrength(Math.round(value * 100) / 100);
    setStrengthValue(next);
    setStrength(next);
  };

  const changeParam = (stage: StageType, param: string, value: number) => {
    if (recipe === null || origin === null) return;
    setError("");
    const next = setParam(recipe, stage, param, value);
    show(next, true);
    setDirty(true);
    persistSoon.run(() => {
      void attempt(async () => {
        if (origin.builtIn) await setOverride(origin.id, next);
        else await updateRecipe(origin.id, next);
        await refresh();
      });
    });
  };

  /** Starters revert to shipped; user recipes to their state when chosen. */
  const reset = () => {
    persistSoon.cancel();
    return attempt(async () => {
      if (origin === null) return;
      const back = origin.builtIn
        ? await clearOverride(origin.id)
        : await updateRecipe(origin.id, origin);
      await refresh();
      setOrigin(back);
      show(back);
      setDirty(false);
    });
  };

  /** Saves a named neutral recipe before any slider moves. */
  const create = (name: string) =>
    attempt(async () => {
      const saved = await saveRecipe(neutralRecipe(), normalizeRecipeName(name));
      await refresh();
      setOrigin(saved);
      show(saved);
      setDirty(false);
    });

  const rename = (target: Recipe, name: string) =>
    attempt(async () => {
      const renamed = await renameRecipe(target.id, name);
      await refresh();
      if (origin?.id === renamed.id) {
        setOrigin(renamed);
        if (!dirty) show(renamed);
      }
    });

  const duplicate = (target: Recipe) =>
    attempt(async () => {
      const copied = await duplicateRecipe(target.id);
      await refresh();
      setDirty(false);
      setOrigin(copied);
      show(copied);
    });

  const remove = (target: Recipe) =>
    attempt(async () => {
      await deleteRecipe(target.id);
      await refresh();
      if (origin?.id === target.id) {
        persistSoon.cancel();
        setDirty(false);
        setOrigin(STARTERS[0]);
        show(STARTERS[0]);
      }
    });

  return {
    choices: [...inForce, ...mine],
    recipe,
    origin,
    strength,
    applying,
    slowApply,
    isClean,
    canReset,
    applyError,
    error,
    clearError,
    choose,
    changeStrength,
    changeParam,
    create,
    rename,
    duplicate,
    remove,
    reset,
  };
}
