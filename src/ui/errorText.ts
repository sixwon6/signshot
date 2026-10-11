/**
 * Every thrown value passes through here before rendering: strips URLs (an RPC URL may carry an
 * API key), collapses whitespace, caps length.
 */

const MAX_ERROR_CHARS = 240;

/** Runs to the next whitespace: the key is in the query string. */
const LINK = /(?:https?|wss?):\/\/\S+/gi;

const REDACTED_LINK = "[link removed]";

/** `SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR`: the RPC answered with an HTTP error status. */
const RPC_HTTP_ERROR = 8100002;
const NETWORK_BUSY = "The network is busy. Try again in a moment.";
const NETWORK_DOWN = "The network did not answer. Try again.";
/** Kit production messages end in a CLI decode hint. */
const DECODE_HINT = /;\s*Decode this error by running[\s\S]*$/;

function rpcHttpStatus(e: unknown): number | null {
  const context = e !== null && typeof e === "object" && "context" in e
    ? (e as { context?: { __code?: unknown; statusCode?: unknown } }).context : undefined;
  return context?.__code === RPC_HTTP_ERROR && typeof context.statusCode === "number" ? context.statusCode : null;
}

/** Never `[object Object]`. */
function rawErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e !== null && typeof e === "object" && "message" in e)
    return String((e as { message: unknown }).message);
  if (typeof e === "string") return e;
  return "";
}

function sanitizeErrorText(raw: string): string {
  return raw
    .replace(LINK, REDACTED_LINK)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_CHARS);
}

/** `fallback` is sanitised too, so it can't bypass the filter. */
export function safeErrorText(e: unknown, fallback = ""): string {
  const status = rpcHttpStatus(e);
  if (status !== null) return status === 429 ? NETWORK_BUSY : NETWORK_DOWN;
  const sanitized = sanitizeErrorText(rawErrorMessage(e).replace(DECODE_HINT, ""));
  return sanitized.length > 0 ? sanitized : sanitizeErrorText(fallback);
}
