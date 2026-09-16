import {
  LEGACY_UPLOAD_HOST,
  TURBO_UPLOAD_HOSTS,
} from "../../publications/turboHosts";

/**
 * Turbo uploads for Core publication. A bundler receipt means the bytes were accepted; the
 * publisher then reads them back and checks their hash. Each call makes one attempt; callers own
 * retry. Hosts come from `publications/turboHosts.ts`, primary first.
 */

/** Each host keeps the item path its own documentation gives: `/v1/tx` on the legacy host, `/tx` otherwise. */
const itemPath = (host: string) => (host === LEGACY_UPLOAD_HOST ? "/v1/tx" : "/tx");

/** POST a signed ANS-104 data item as application/octet-stream. Primary host first. */
const TURBO_UPLOAD_URLS: readonly string[] = TURBO_UPLOAD_HOSTS.map(
  (host) => `${host}${itemPath(host)}`,
);

/** GET <base>/<id>/status to check whether the bundler already holds the item. */
const TURBO_STATUS_BASES: readonly string[] = TURBO_UPLOAD_URLS;

/**
 * The provider's documented free-tier item size (`GET /info` reports
 * `freeTier.maxItemBytes = 107,520`). The app's own caps elsewhere are stricter, for headroom.
 */
export const TURBO_FREE_ITEM_BYTES = 107_520;

/** Bound each network request; recovery callers may make another attempt later. */
const REQUEST_TIMEOUT_MS = 15_000;

/** 32-byte Arweave data item id encoded as 43 base64url characters. */
const AR_TX_ID = /^[A-Za-z0-9_-]{43}$/;

/** Upload-service status values; lowercase new/pending/permanent belong to its info field. */
type TurboItemStatus = "CONFIRMED" | "FINALIZED";

/** An HTTP failure that carries enough of the response to be diagnosable from a bug report. */
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

/** Response bodies are read for the error message only; keep one from filling a log. */
async function readBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "<unreadable>";
  }
}

/**
 * Does the bundler already hold this item? `null` for anything but a definite yes (404, bad body,
 * 5xx, timeout), since the caller then simply POSTs. Every host is asked, primary first, so a host
 * that has gone away cannot turn a finished upload into a repeat.
 */
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
      // Unreachable, timed out, or an unparseable body: ask the next host.
    }
  }
  return null;
}

/** What `uploadDataItem` did, for logging. */
type UploadOutcome =
  | { id: string; posted: true; status: number }
  | { id: string; posted: false; held: TurboItemStatus };

/**
 * POST one signed data item, unless Turbo already holds it: the id is a pure function of the bytes,
 * and re-posting would spend free-tier allowance. `200` and `202` are both success; neither means
 * the gateway serves it yet. A returned id other than `expectedId` throws: that id is already in a
 * signed `uri`, so the mismatch means our serialization disagrees with the bundler's parse.
 *
 * @param bytes      the serialized data item
 * @param expectedId the id our own `buildDataItem` computed for exactly these bytes
 */
export async function uploadDataItem(
  bytes: Uint8Array,
  expectedId: string,
): Promise<UploadOutcome> {
  if (!AR_TX_ID.test(expectedId)) {
    throw new Error(`turbo: "${expectedId}" is not an Arweave transaction id`);
  }
  // At the limit is refused too: the provider does not say whether 107,520 is inclusive.
  if (bytes.length >= TURBO_FREE_ITEM_BYTES) {
    throw new Error(
      `turbo: ${bytes.length} bytes is at or over the ${TURBO_FREE_ITEM_BYTES}-byte free-tier ` +
        `limit for one item`,
    );
  }

  const held = await turboItemStatus(expectedId);
  if (held !== null) return { id: expectedId, posted: false, held };

  // A raw Uint8Array body works in both React Native's fetch and Node's undici. The cast covers
  // RN's narrower `BodyInit_` type; `RequestInit["body"]` is used because @types/node (the scripts
  // project) declares no standalone `BodyInit`.
  //
  // The next host is tried only on a transport failure or 5xx; a 4xx is an answer (402 allowance,
  // 413 size). Status is re-read first, so a timed-out POST that was accepted is not sent twice.
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
        body: bytes as unknown as RequestInit["body"],
      });
    } catch (error) {
      // Nothing answered at all, and no earlier host left a response worth reporting.
      if (res === undefined && url === TURBO_UPLOAD_URLS[TURBO_UPLOAD_URLS.length - 1]) throw error;
      continue;
    }
    res = answer;
    // A 5xx is the host failing to answer rather than refusing; anything else is its answer.
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
