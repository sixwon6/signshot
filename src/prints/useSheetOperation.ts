import { useRef, useState } from "react";
import { safeErrorText } from "../ui/errorText";
import {
  isChangedQuote,
  isExpiredQuote,
  isUserCancellation,
  isWalletResponseTimeout,
} from "../solana/walletErrors";

/**
 * The plumbing the money sheets share: one operation at a time, the status and error lines in the
 * dock, and the estimate on screen with the ref that says it is still the one shown. What each
 * outcome says, and what it re-reads, stays with the sheet.
 */
export function useSheetOperation<Q>(initialStatus = "") {
  const running = useRef(false);
  // Every async result is tagged with the request that asked for it, so a slow read for an
  // earlier target can never paint over a newer one.
  const request = useRef(0),
    currentQuote = useRef<Q | null>(null);
  const [quote, showQuote] = useState<Q | null>(null);
  // The itemised estimate, one tap away from the single cost line.
  const [showCost, setShowCost] = useState(false);
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState(initialStatus),
    [error, setError] = useState("");

  /** The estimate on screen. Only the one `currentQuote` still holds can be approved. */
  function setQuote(next: Q | null) {
    currentQuote.current = next;
    showQuote(next);
  }
  function clearQuote() {
    setQuote(null);
  }

  /** Runs `work` unless an operation is already running, and holds the sheet busy until it ends. */
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  /**
   * A check that failed before anything was signed: a closed wallet or one that never answered is
   * a status, never an error.
   */
  function showCheckFailure(
    e: unknown,
    words: { timedOut: string; cancelled: string; fallback?: string },
  ) {
    const timedOut = isWalletResponseTimeout(e);
    setError(isUserCancellation(e) || timedOut ? "" : safeErrorText(e, words.fallback));
    setStatus(timedOut ? words.timedOut : isUserCancellation(e) ? words.cancelled : "");
  }

  return {
    running,
    request,
    busy,
    status,
    setStatus,
    error,
    setError,
    quote,
    currentQuote,
    setQuote,
    clearQuote,
    showCost,
    setShowCost,
    run,
    showCheckFailure,
  };
}

/**
 * How a signing request failed. `quiet` is every outcome a sheet words as a status rather than an
 * error: the user backed out, the wallet never answered, or the quote expired or changed.
 */
export function walletOutcome(e: unknown) {
  const cancelled = isUserCancellation(e),
    timedOut = isWalletResponseTimeout(e),
    expired = isExpiredQuote(e),
    changed = isChangedQuote(e);
  return { cancelled, timedOut, expired, changed, quiet: cancelled || timedOut || expired || changed };
}
