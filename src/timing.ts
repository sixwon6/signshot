import { useEffect, useRef } from "react";

/** Coalesces per-frame drag input: {@link debounce} for writes, {@link throttle} for live preview. */
interface Deferred {
  /** Replaces anything still waiting. */
  run(work: () => void): void;
  cancel(): void;
}

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

/** Leading edge plus trailing latest, at most one per `intervalMs`, so preview tracks the thumb. */
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

/** Component-scoped `Deferred`, cancelled on unmount. */
export function useDeferred(make: () => Deferred): Deferred {
  const held = useRef<Deferred | null>(null);
  if (held.current === null) held.current = make();
  const value = held.current;
  useEffect(() => () => value.cancel(), [value]);
  return value;
}
