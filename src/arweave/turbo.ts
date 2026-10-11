import {
  LEGACY_UPLOAD_HOST,
  TURBO_UPLOAD_HOSTS,
} from "../../publications/turboHosts";

/** Turbo uploads. One attempt per call; callers own retry and read-back verification. */

/** Per each host's docs. */
const itemPath = (host: string) => (host === LEGACY_UPLOAD_HOST ? "/v1/tx" : "/tx");

/** Primary first. */
const TURBO_UPLOAD_URLS: readonly string[] = TURBO_UPLOAD_HOSTS.map(
  (host) => `${host}${itemPath(host)}`,
);

/** GET <base>/<id>/status. */
const TURBO_STATUS_BASES: readonly string[] = TURBO_UPLOAD_URLS;

/** `GET /info` → `freeTier.maxItemBytes`. */
export const TURBO_FREE_ITEM_BYTES = 107_520;

const REQUEST_TIMEOUT_MS = 15_000;

const AR_TX_ID = /^[A-Za-z0-9_-]{43}$/;

/** Lowercase new/pending/permanent belong to the `info` field, not `status`. */
type TurboItemStatus = "CONFIRMED" | "FINALIZED";

export class TurboError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = "TurboError";
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Truncated: used only in error messages. */
async function readBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "<unreadable>";
  }
}

/** `null` unless definitely held. Asks every host so a dead primary can't cause a repeat upload. */
export async function turboItemStatus(id: string): Promise<TurboItemStatus | null> {
  if (!AR_TX_ID.test(id)) throw new Error(`turbo: "${id}" is not an Arweave transaction id`);
  for (const base of TURBO_STATUS_BASES) {
    try {
      const res = await fetchWithTimeout(`${base}/${id}/status`, { method: "GET" });
      if (!res.ok) continue;
      const body = await res.text();
      const status = (JSON.parse(body) as { status?: unknown }).status;
      if (status === "CONFIRMED" || status === "FINALIZED") return status;
    } catch {
    }
  }
  return null;
}

type UploadOutcome =
  | { id: string; posted: true; status: number }
  | { id: string; posted: false; held: TurboItemStatus };

/**
 * Skips the POST if Turbo already holds the id (re-posting spends allowance or credit). The signer's
 * balance pays beyond the free tier. 200 and 202 are success; neither means the gateway serves it
 * yet. A different returned id is fatal: `expectedId` is already in a signed `uri`.
 */
export async function uploadDataItem(
  bytes: Uint8Array,
  expectedId: string,
): Promise<UploadOutcome> {
  if (!AR_TX_ID.test(expectedId)) {
    throw new Error(`turbo: "${expectedId}" is not an Arweave transaction id`);
  }
  // `>=`: the provider doesn't say whether the limit is inclusive.
  if (bytes.length >= TURBO_FREE_ITEM_BYTES) {
    throw new Error(
      `turbo: ${bytes.length} bytes is at or over the ${TURBO_FREE_ITEM_BYTES}-byte free-tier ` +
        `limit for one item`,
    );
  }

  const held = await turboItemStatus(expectedId);
  if (held !== null) return { id: expectedId, posted: false, held };

  // Fall through to the next host only on transport failure or 5xx; 4xx is an answer. Re-check
  // status first so an accepted-but-timed-out POST isn't sent twice.
  let res: Response | undefined;
  let attempted = false;
  for (const url of TURBO_UPLOAD_URLS) {
    if (attempted) {
      const landed = await turboItemStatus(expectedId);
      if (landed !== null) return { id: expectedId, posted: false, held: landed };
    }
    attempted = true;
    let answer: Response;
    try {
      answer = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        // Works in RN fetch and undici; the cast covers RN's narrower `BodyInit_`.
        body: bytes as unknown as RequestInit["body"],
      });
    } catch (error) {
      if (res === undefined && url === TURBO_UPLOAD_URLS[TURBO_UPLOAD_URLS.length - 1]) throw error;
      continue;
    }
    res = answer;
    if (answer.status < 500) break;
  }
  if (res === undefined) throw new Error("turbo: no upload host could be reached");

  if (res.status !== 200 && res.status !== 202) {
    const detail = await readBody(res);
    throw new TurboError(
      res.status,
      detail,
      `turbo: upload refused with HTTP ${res.status}${detail === "" ? "" : `: ${detail}`}`,
    );
  }

  const body = await res.text();
  let id: unknown;
  try {
    id = (JSON.parse(body) as { id?: unknown }).id;
  } catch {
    throw new TurboError(res.status, body, `turbo: HTTP ${res.status} but the body is not JSON`);
  }

  if (typeof id !== "string" || !AR_TX_ID.test(id)) {
    throw new TurboError(res.status, body, `turbo: HTTP ${res.status} with a malformed id`);
  }

  if (id !== expectedId) {
    throw new TurboError(
      res.status,
      body,
      `turbo: the bundler stored this item as ${id}, not ${expectedId}. Our ANS-104 ` +
        `serialization disagrees with the bundler's parse of it; the id already recorded — and ` +
        `already inside a signed mint uri — will never resolve. This is not retryable.`,
    );
  }

  return { id, posted: true, status: res.status };
}
