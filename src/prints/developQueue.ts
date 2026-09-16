import type { PhotoEdit } from "../../modules/seeker-camera";
import type { Recipe } from "../recipes/model";
import { safeErrorText } from "../ui/errorText";

/** One develop asked for: a recipe and the global mix, 0..1. */
interface DevelopRequest {
  recipe: Recipe;
  strength: number;
}

export interface DevelopOutcome {
  request: DevelopRequest;
  edit?: PhotoEdit;
  error?: string;
}

interface DevelopQueue {
  /** Asks for a develop. Replaces any request still waiting behind the one in flight. */
  request(next: DevelopRequest, delayMs?: number): void;
  cancel(): void;
}

/**
 * One develop in flight, latest wins. A full-size render is expensive, so at most one request
 * waits; a newer one replaces it, and an overtaken render's result is dropped.
 */
export function createDevelopQueue(
  render: (request: DevelopRequest) => Promise<PhotoEdit>,
  deliver: (outcome: DevelopOutcome) => void,
): DevelopQueue {
  let inFlight = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queued: DevelopRequest | null = null;
  const pump = () => {
    if (inFlight || !queued || timer !== undefined) return;
    const request = queued;
    const current = generation;
    queued = null;
    inFlight = true;
    void render(request)
      .then(
        (edit) => {
          if (current === generation && !queued) deliver({ request, edit });
        },
        (error: unknown) => {
          if (current === generation && !queued)
            deliver({ request, error: safeErrorText(error, "Unable to develop this photo.") });
        },
      )
      .finally(() => {
        inFlight = false;
        pump();
      });
  };
  return {
    cancel() {
      generation++;
      queued = null;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    request(next: DevelopRequest, delayMs = 0) {
      // Invalidate the old result now, not after the debounce window has elapsed.
      generation++;
      queued = next;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (delayMs > 0) {
        timer = setTimeout(() => {
          timer = undefined;
          pump();
        }, delayMs);
      } else pump();
    },
  };
}
