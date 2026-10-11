/**
 * Terms, reports, blocks and the moderation list. No React or storage; see `store.ts`.
 * Publications are permanent on chain, so moderation only controls what the app shows. The list
 * FAILS OPEN: one bad deploy must not blank every photo.
 */

export const SUPPORT_EMAIL = "support@erashot.app";

/** Source: `site/public/terms/index.html`. */
export const TERMS_URL = "https://erashot.app/terms/";
/** Bump to require re-agreement; any other stored version reads as none. */
export const TERMS_VERSION = 1;
export const termsAgreed = (stored: string | null | undefined): boolean =>
  stored === String(TERMS_VERSION);

/** Source: `site/public/moderation.json`. */
export const MODERATION_URL = "https://erashot.app/moderation.json";
export const MODERATION_MAX_BYTES = 256 * 1024;
/** Per array. */
export const MODERATION_MAX_ENTRIES = 4096;
/** Matches the file's max-age=300. */
export const MODERATION_TTL_MS = 5 * 60_000;
const MODERATION_TIMEOUT_MS = 5_000;

/** Base58 Solana address shape. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Caps storage growth from a runaway write. */
export const MAX_BLOCKED = 1000;

export interface ModerationList {
  hiddenEditions: ReadonlySet<string>;
  hiddenCreators: ReadonlySet<string>;
}

/** Exactly `{"version":1,"hiddenEditions":[...],"hiddenCreators":[...]}` of addresses; anything else throws. */
export function parseModerationList(text: string): ModerationList {
  if (text.length > MODERATION_MAX_BYTES) throw new Error("Moderation list too large.");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Moderation list is not an object.");
  const keys = Object.keys(value).sort().join();
  if (keys !== "hiddenCreators,hiddenEditions,version")
    throw new Error("Moderation list has unexpected keys.");
  const list = value as Record<string, unknown>;
  if (list.version !== 1) throw new Error("Unknown moderation list version.");
  const addresses = (field: unknown): ReadonlySet<string> => {
    if (!Array.isArray(field) || field.length > MODERATION_MAX_ENTRIES)
      throw new Error("Moderation list entry is not a list of addresses.");
    for (const item of field)
      if (typeof item !== "string" || !ADDRESS.test(item))
        throw new Error("Moderation list names something that is not an address.");
    return new Set(field as string[]);
  };
  return {
    hiddenEditions: addresses(list.hiddenEditions),
    hiddenCreators: addresses(list.hiddenCreators),
  };
}

/** Null on any failure; never throws. Size-checked by `Content-Length` before reading and by length after. */
export async function fetchModerationList(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = MODERATION_TIMEOUT_MS,
): Promise<ModerationList | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, credentials: "omit" });
    if (!res.ok) return null;
    const declared = res.headers?.get?.("content-length");
    if (declared && !(Number(declared) >= 0 && Number(declared) <= MODERATION_MAX_BYTES))
      return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MODERATION_MAX_BYTES) return null;
    return parseModerationList(new TextDecoder().decode(bytes));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Never throws. */
export function readBlockList(raw: string | null | undefined): string[] {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((v): v is string => typeof v === "string" && ADDRESS.test(v)))]
      .slice(0, MAX_BLOCKED);
  } catch {
    return [];
  }
}

export function withBlocked(list: Iterable<string>, creator: string, blocked: boolean): string[] {
  const next = new Set(list);
  if (blocked && ADDRESS.test(creator)) next.add(creator);
  else next.delete(creator);
  return [...next].slice(0, MAX_BLOCKED);
}

/** `hidden` (moderation list) wins over `blocked` (viewer): Unblock can't reveal what the list hides. */
export type Veil = "hidden" | "blocked" | null;
export function veilOf(
  edition: string,
  creator: string,
  list: ModerationList | null,
  blocked: ReadonlySet<string>,
): Veil {
  if (list && (list.hiddenEditions.has(edition) || list.hiddenCreators.has(creator)))
    return "hidden";
  return blocked.has(creator) ? "blocked" : null;
}

export function reportMailto(edition: string, collectLink: string): string {
  return (
    `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Report ${edition}`)}` +
    `&body=${encodeURIComponent(collectLink)}`
  );
}
