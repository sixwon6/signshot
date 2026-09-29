/**
 * Terms, reports, blocks and the moderation list, as data. No React, no storage, no DOM: the app
 * (`src/moderation/store.ts`), the collect page (`site/collect/page.ts`) and `scripts/check-site.ts`
 * all read these same rules.
 *
 * A publication is permanent on Arweave and Solana and nobody can delete it. What Signshot can do
 * is decide what its own views show: Signshot's list at `MODERATION_URL` hides editions and
 * creators for everyone, and a viewer's block list hides creators for that viewer alone. The list
 * FAILS OPEN — unreadable, oversized, late or malformed means nothing is hidden — because a list
 * that failed closed would let one bad deploy blank every photograph in the app.
 */

export const SUPPORT_EMAIL = "support@erashot.app";

/** The terms people agree to before a first publish or collect (`site/public/terms/index.html`). */
export const TERMS_URL = "https://erashot.app/terms/";
/**
 * The terms' version. Raise it when the terms change in a way people must agree to again: a
 * stored agreement to any other version reads as none, so the next publish or collect asks.
 */
export const TERMS_VERSION = 1;
/** Whether a stored agreement is to the current terms. */
export const termsAgreed = (stored: string | null | undefined): boolean =>
  stored === String(TERMS_VERSION);

/**
 * Signshot's moderation list (`site/public/moderation.json`). The collect page reads the same path
 * on its own origin, so a preview deployment reads its own copy.
 */
export const MODERATION_URL = "https://erashot.app/moderation.json";
/** Far above any real list, far below anything that could hurt to allocate. */
export const MODERATION_MAX_BYTES = 256 * 1024;
/** Per array. */
export const MODERATION_MAX_ENTRIES = 4096;
/** How long a read list is used before it is read again. The file itself is served max-age=300. */
export const MODERATION_TTL_MS = 5 * 60_000;
const MODERATION_TIMEOUT_MS = 5_000;

/** Base58, 32..44 characters: the shape of a Solana address, and nothing else is stored or listed. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** A viewer's own block list, capped so a runaway write cannot grow storage without bound. */
export const MAX_BLOCKED = 1000;

export interface ModerationList {
  hiddenEditions: ReadonlySet<string>;
  hiddenCreators: ReadonlySet<string>;
}

/**
 * `{"version":1,"hiddenEditions":[...],"hiddenCreators":[...]}` and nothing else: exactly those
 * three keys, version 1, and arrays of addresses. Anything else throws, and the caller shows
 * everything.
 */
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

/**
 * The list at `url`, or `null` when it cannot be had for any reason. Never throws. The body is
 * bounded twice: by a declared `Content-Length` before it is read, and by its length after.
 */
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

/** A stored block list: well-shaped addresses only, duplicates dropped, capped. Never throws. */
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

/** The block list with `creator` added or removed, ready to store. */
export function withBlocked(list: Iterable<string>, creator: string, blocked: boolean): string[] {
  const next = new Set(list);
  if (blocked && ADDRESS.test(creator)) next.add(creator);
  else next.delete(creator);
  return [...next].slice(0, MAX_BLOCKED);
}

/**
 * What stands in for a publication's picture, title and caption: `hidden` by the moderation list,
 * `blocked` by this viewer, or `null` to show it. The moderation list wins, since Unblock cannot
 * bring back what the list hides.
 */
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

/** Report: an email to support naming the edition, with its collect link in the body. */
export function reportMailto(edition: string, collectLink: string): string {
  return (
    `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Report ${edition}`)}` +
    `&body=${encodeURIComponent(collectLink)}`
  );
}
