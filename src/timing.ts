import { useEffect, useRef } from "react";

/**
 * Coalesces per-frame drag input so only the latest work runs: {@link debounce} once moves stop
 * (for writes), {@link throttle} at most once per interval with the last call landing (live preview).
 */
interface Deferred {
  /** Puts `work` off, replacing anything still waiting. */
  run(work: () => void): void;
  /** Drops anything still waiting. */
  cancel(): void;
}

/** The latest work, `delayMs` after the last call: nothing runs until the moves stop. */
export function debounce(delayMs: number): Deferred {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting: (() => void) | null = null;
  return {
    run(work) {
      waiting = work;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        const due = waiting;
        waiting = null;
        due?.();
      }, delayMs);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      waiting = null;
    },
  };
}

/**
 * The FIRST call at once, then the latest of any that follow, at most one every `intervalMs`.
 * The leading edge is the point: a look or an exposure must move under the thumb, not after it.
 */
export function throttle(intervalMs: number): Deferred {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting: (() => void) | null = null;
  const close = () => {
    timer = undefined;
    const due = waiting;
    waiting = null;
    if (due) {
      open();
      due();
    }
  };
  const open = () => {
    timer = setTimeout(close, intervalMs);
  };
  return {
    run(work) {
      if (timer === undefined) {
        open();
        work();
      } else {
        waiting = work;
      }
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      waiting = null;
    },
  };
}

/**
 * The same, held for the life of a component and cancelled on unmount, so no caller has to clear
 * its own timers.
 */
export function useDeferred(make: () => Deferred): Deferred {
  const held = useRef<Deferred | null>(null);
  if (held.current === null) held.current = make();
  const value = held.current;
  useEffect(() => () => value.cancel(), [value]);
  return value;
}
