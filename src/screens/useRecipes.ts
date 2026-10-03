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

/**
 * The camera's recipe state. A move is saved under the id it already has (`setOverride` for a
 * starter, `updateRecipe` for one's own), so a photo taken mid-edit records the right `profileId`.
 */

/** A moved slider is on the viewfinder within this; a drag cannot ask for more than one per. */
const APPLY_THROTTLE_MS = 60;
/** A moved slider is written to the store this long after the last move. */
const PERSIST_DEBOUNCE_MS = 300;
const LAST_USED_DEBOUNCE_MS = 400;
/** Only an apply still running after this says so: a tap must not flash the whole camera. */
const SLOW_APPLY_MS = 500;
/** A fresh camera view is not up yet on a cold start; the apply waits for it this many times. */
const APPLY_ATTEMPTS = 8;
const APPLY_RETRY_MS = 250;

interface RecipesInForce {
  /** The phone's own look, the starters as the photographer has set them, then their own: the row, in order. */
  choices: readonly Recipe[];
  /** The recipe on the viewfinder, moves included. Null until the store has been read. */
  recipe: Recipe | null;
  /** The saved recipe it is being kept in. */
  origin: Recipe | null;
  /** 0..1, the global mix. */
  strength: number;
  /** An apply is in flight. */
  applying: boolean;
  /** ...and has been long enough to say so. */
  slowApply: boolean;
  /** The phone's own look, untouched: the strength dial has nothing to mix. */
  isClean: boolean;
  /** Reset has somewhere to go. */
  canReset: boolean;
  /** A recipe that would not reach the viewfinder: the camera's own notice, or "". */
  applyError: string;
  /** The last write that was refused, for the sheet that asked for it, or "". */
  error: string;
  clearError(): void;
  /** Another chip. Returns the stage to open when it was the chip already in force. */
  choose(next: Recipe): StageType | null;
  changeStrength(value: number): void;
  changeParam(stage: StageType, param: string, value: number): void;
  /** Every action a sheet can ask for. Each resolves false with {@link error} set. */
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
  /** The camera is on screen and allowed to run: nothing is applied until it is. */
  live: boolean;
  /** Bumped to rebuild the camera view; the recipe goes back on the fresh one. */
  generation: number;
  /** The shutter or a sheet is working: moves are refused rather than queued. */
  busy: boolean;
}): RecipesInForce {
  /** The starters as set by the photographer (shipped until edited), then their own. */
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

  /** The strength in force, read by the apply effect without making it depend on the dial. */
  const strengthRef = useRef(strength);
  strengthRef.current = strength;
  /** True while the change being applied came from a thumb rather than from a tap. */
  const dragging = useRef(false);
  /** Puts a recipe on the viewfinder. `fromThumb` is the only thing the drag throttle reads. */
  const show = (next: Recipe, fromThumb = false) => {
    dragging.current = fromThumb;
    setRecipe(next);
  };

  const clearError = useCallback(() => setError(""), []);

  const applySoon = useDeferred(() => throttle(APPLY_THROTTLE_MS));
  const persistSoon = useDeferred(() => debounce(PERSIST_DEBOUNCE_MS));
  const rememberSoon = useDeferred(() => debounce(LAST_USED_DEBOUNCE_MS));

  // Restore the last-used recipe and strength; a deleted recipe falls back to the phone's own look (`lastUsed`).
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

  // A rebuilt camera view has no recipe yet, hence the retry on "no active camera view". A tap
  // applies at once; a drag is throttled (each apply crosses the bridge) and its last sample lands.
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

  // Where the camera was left, written back once the dial has rested — not on every drag sample.
  useEffect(() => {
    if (recipe === null) return;
    rememberSoon.run(() => {
      void setLastUsed(recipe.id, strength).catch(() => {});
    });
  }, [recipe, strength, rememberSoon]);

  /** Every recipe in force, re-read after a write, so the chips show what is saved. */
  const refresh = useCallback(async () => {
    const all = await allRecipes();
    setInForce(all.filter((one) => one.builtIn));
    setMine(all.filter((one) => !one.builtIn));
  }, []);

  // Develop saves recipes too: the chips are re-read when the camera comes back on screen.
  useEffect(() => {
    if (live) void refresh().catch(() => {});
  }, [live, refresh]);

  /** Runs a write, reports its message on failure, and says whether it went through. */
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
    // The chip already in force names its first moved stage; any other chip switches to it.
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

  /** A starter goes back to how it shipped; one's own recipe to how it was when chosen. */
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

  /** `+`: the recipe exists under its name, neutral, before any slider moves. */
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
