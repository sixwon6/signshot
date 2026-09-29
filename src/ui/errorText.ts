/**
 * The filter every thrown value passes before a screen renders it: strips http(s)/ws(s) URLs (a
 * provider RPC URL may carry a key), collapses whitespace and caps the length. No translation, but
 * for @solana/kit's own errors, whose production message is only a decode hint.
 */

/** The longest an error line may be on any surface. */
const MAX_ERROR_CHARS = 240;

/**
 * `http`, `https`, `ws` and `wss` URLs. `\S+` runs to the next whitespace: the query string
 * carries the key, so half a URL is not safe to keep.
 */
const LINK = /(?:https?|wss?):\/\/\S+/gi;

/** What a URL becomes. Fixed words, so a reader can tell removal from a truncation. */
const REDACTED_LINK = "[link removed]";

/** `SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR`: the RPC answered with an HTTP error status. */
const RPC_HTTP_ERROR = 8100002;
const NETWORK_BUSY = "The network is busy. Try again in a moment.";
const NETWORK_DOWN = "The network did not answer. Try again.";
/** A kit production message ends in how to decode it, which means nothing on a phone. */
const DECODE_HINT = /;\s*Decode this error by running[\s\S]*$/;

/** The HTTP status of a kit RPC transport error, from the error's own context. */
function rpcHttpStatus(e: unknown): number | null {
  const context = e !== null && typeof e === "object" && "context" in e
    ? (e as { context?: { __code?: unknown; statusCode?: unknown } }).context : undefined;
  return context?.__code === RPC_HTTP_ERROR && typeof context.statusCode === "number" ? context.statusCode : null;
}

/** The message a thrown value carries, without judging it. Never `[object Object]`. */
function rawErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e !== null && typeof e === "object" && "message" in e)
    return String((e as { message: unknown }).message);
  if (typeof e === "string") return e;
  return "";
}

/** Strip links, collapse whitespace, trim and cap. Safe to apply to the app's own sentences. */
function sanitizeErrorText(raw: string): string {
  return raw
    .replace(LINK, REDACTED_LINK)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_CHARS);
}

/**
 * Display form of any thrown value: sanitised, and `fallback` when nothing readable was thrown.
 * The fallback is sanitised too, so a caller cannot route around the filter through it.
 */
export function safeErrorText(e: unknown, fallback = ""): string {
  const status = rpcHttpStatus(e);
  if (status !== null) return status === 429 ? NETWORK_BUSY : NETWORK_DOWN;
  const sanitized = sanitizeErrorText(rawErrorMessage(e).replace(DECODE_HINT, ""));
  return sanitized.length > 0 ? sanitized : sanitizeErrorText(fallback);
}
