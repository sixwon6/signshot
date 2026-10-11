import { useRef, useState } from "react";
import { safeErrorText } from "../ui/errorText";
import {
  isUserCancellation,
  isWalletResponseTimeout,
} from "../solana/walletErrors";

/**
 * Shared by the money sheets: one operation at a time, the dock's status and error lines, and the
 * quote on screen. Wording and re-reads stay with each sheet.
 */
export function useSheetOperation<Q>(initialStatus = "") {
  const running = useRef(false);
  // Request id tags async results so a slow earlier read never paints over a newer one.
  const request = useRef(0),
    currentQuote = useRef<Q | null>(null);
  const [quote, showQuote] = useState<Q | null>(null);
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

  /** No-op while another operation runs. */
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

  /** For checks that fail before signing: a closed or silent wallet is a status, not an error. */
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

/** `quiet`: the user backed out or the wallet never answered; shown as a status, not an error. */
export function walletOutcome(e: unknown) {
  const cancelled = isUserCancellation(e),
    timedOut = isWalletResponseTimeout(e);
  return { cancelled, timedOut, quiet: cancelled || timedOut };
}
