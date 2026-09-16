/**
 * The filter every thrown value passes before a screen renders it: strips http(s)/ws(s) URLs (a
 * provider RPC URL may carry a key), collapses whitespace and caps the length. No translation.
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
  const sanitized = sanitizeErrorText(rawErrorMessage(e));
  return sanitized.length > 0 ? sanitized : sanitizeErrorText(fallback);
}
