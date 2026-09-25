/**
 * The network half of the device verdict (`deviceVerdict` in `attestation.ts`): Google's
 * attestation revocation list, and the edition's on-chain publication time the certificates'
 * validity is judged at. Shared by the app, the collect page and `scripts/verify-attestation.ts`,
 * so all three reach the same answer from the same inputs.
 *
 * Neither is ever guessed. A list that cannot be fetched or read, or a publication whose creating
 * transaction cannot be found, leaves the verdict "unchecked" and the screen says "Couldn't check.".
 */

import { request } from "../rpc";
import { deviceVerdict, type AttestationSummary, type DeviceVerdict, type RevocationList } from "./attestation";

/**
 * Google's list. The app and the verifier fetch it directly; the collect page through its own
 * `/api/attestation-status`, since Google sends no CORS header (so this is never its default).
 */
export const GOOGLE_STATUS_URL = "https://android.googleapis.com/attestation/status";

/** 179 KB with 1,755 entries on 2026-09-24; the bound leaves room for years of growth. */
export const MAX_STATUS_BYTES = 4_000_000;
/** Held when the response names no max-age; Google sends `max-age=86400`, which is honoured. */
const STATUS_DEFAULT_TTL_MS = 60 * 60 * 1000;
const STATUS_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const STATUS_TIMEOUT_MS = 20_000;
/** A dictionary key: hex (the documented form) or decimal (what the live list also uses). */
const SERIAL_KEY = /^[0-9a-f]{1,80}$/;

/**
 * Parse the list's JSON, refusing anything that is not its documented shape: `{ entries: { <serial>:
 * { status, reason?, ... } } }`. A shape this does not recognise is an unreadable list, not an
 * empty one.
 */
export function parseRevocationList(json: unknown): RevocationList {
  const entries = (json as { entries?: unknown } | null)?.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("revocation list: no entries");
  const list = new Map<string, { status: string; reason?: string }>();
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    const entry = value as { status?: unknown; reason?: unknown } | null;
    if (!SERIAL_KEY.test(key) || !entry || typeof entry !== "object" || typeof entry.status !== "string")
      throw new Error("revocation list: bad entry");
    list.set(key, typeof entry.reason === "string" ? { status: entry.status, reason: entry.reason } : { status: entry.status });
  }
  return list;
}

const statusCache = new Map<string, { until: number; list: Promise<RevocationList> }>();

/**
 * The revocation list at `url`, held for as long as its `Cache-Control` says (capped at a day).
 * Google: "The Cache-Control header in the HTTP response determines how often to check for
 * updates". A failure is not held, so the next screen asks again.
 */
export function readRevocationList(url: string): Promise<RevocationList> {
  const held = statusCache.get(url);
  if (held && held.until > Date.now()) return held.list;
  const entry = { until: Number.POSITIVE_INFINITY, list: fetchRevocationList(url, (ttl) => { entry.until = Date.now() + ttl; }) };
  statusCache.set(url, entry);
  entry.list.catch(() => { if (statusCache.get(url) === entry) statusCache.delete(url); });
  return entry.list;
}

async function fetchRevocationList(url: string, held: (ttl: number) => void): Promise<RevocationList> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (!res.ok) throw new Error(`revocation list: HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_STATUS_BYTES) throw new Error("revocation list: too large");
    // React Native's fetch has no body stream; the declared length above is the pre-read bound.
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_STATUS_BYTES) throw new Error("revocation list: too large");
    const list = parseRevocationList(JSON.parse(new TextDecoder().decode(bytes)));
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(res.headers.get("cache-control") ?? "")?.[1];
    held(maxAge ? Math.min(Number(maxAge) * 1000, STATUS_MAX_TTL_MS) : STATUS_DEFAULT_TTL_MS);
    return list;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// Publication time

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const SIGNATURE_PAGE = 1000;
/** Past this much history the creating transaction is not looked for; the answer is "unchecked". */
const MAX_SIGNATURE_PAGES = 3;
/** Successful transactions tried, oldest first, before giving up. */
const MAX_CANDIDATES = 4;

type SignatureEntry = { signature: string; err: unknown };
type ParsedInstruction = { programId?: string; parsed?: { type?: string; info?: Record<string, unknown> } };
type ParsedTransaction = {
  blockTime?: number | null;
  meta?: { err: unknown; innerInstructions?: { instructions?: ParsedInstruction[] }[] | null } | null;
  transaction?: { message?: { instructions?: ParsedInstruction[] } };
};

/** Did this transaction create `account` as an account of `owner` (System create or assign)? */
function creates(tx: ParsedTransaction, account: string, owner: string): boolean {
  const all = [
    ...(tx.transaction?.message?.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions ?? []),
  ];
  return all.some((ix) => {
    if (ix.programId !== SYSTEM_PROGRAM || !ix.parsed?.info) return false;
    const { type, info } = ix.parsed;
    return info.owner === owner &&
      ((type === "createAccount" && info.newAccount === account) || (type === "assign" && info.account === account));
  });
}

const timeCache = new Map<string, Date>();

/**
 * When the edition was published, from the chain: the block time of the transaction that created
 * the publisher's own claim receipt (`["claim", edition, creator]`, made by `publish` with copy
 * #1 and never written again, so its history is normally that one transaction).
 *
 * Not simply the oldest signature: anyone who knows an address can mention it in a transaction,
 * and a publisher knows their PDAs before publishing, so an early mention could backdate the
 * edition into an expired certificate's lifetime. The creating transaction is the one where the
 * System program created (or assigned) the receipt to the edition program, which only the program
 * can sign for. Throws when the history is too long to walk or that transaction is not found.
 */
export async function publicationTime(endpoint: string, program: string, receipt: string): Promise<Date> {
  const key = `${endpoint}\n${program}\n${receipt}`;
  const held = timeCache.get(key);
  if (held) return held;
  const history: SignatureEntry[] = [];
  let before: string | undefined;
  for (let page = 1; ; page += 1) {
    const batch = await request<SignatureEntry[]>(endpoint, "getSignaturesForAddress", [
      receipt,
      { limit: SIGNATURE_PAGE, commitment: "confirmed", ...(before ? { before } : {}) },
    ]);
    if (!Array.isArray(batch)) throw new Error("Invalid Solana response");
    history.push(...batch);
    if (batch.length < SIGNATURE_PAGE) break;
    if (page >= MAX_SIGNATURE_PAGES) throw new Error("The publication's history is too long to check here.");
    before = batch[batch.length - 1].signature;
  }
  const candidates = history.filter((entry) => entry.err === null).reverse().slice(0, MAX_CANDIDATES);
  for (const { signature } of candidates) {
    const tx = await request<ParsedTransaction | null>(endpoint, "getTransaction", [
      signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    ]);
    if (!tx || tx.meta?.err !== null || !creates(tx, receipt, program)) continue;
    if (typeof tx.blockTime !== "number" || !Number.isSafeInteger(tx.blockTime) || tx.blockTime <= 0)
      throw new Error("The publication transaction has no block time.");
    const time = new Date(tx.blockTime * 1000);
    if (timeCache.size >= 256) timeCache.clear();
    timeCache.set(key, time);
    return time;
  }
  throw new Error("The publication transaction was not found.");
}

/**
 * The verdict for one accepted summary. The rules that need no network run first, so another
 * app or an unlocked bootloader is refused without fetching anything; the list and the time are
 * then fetched together, and a failure of either leaves only the rules that could run.
 */
export async function checkDevice(
  summary: AttestationSummary,
  sources: { revocationList(): Promise<RevocationList>; publishedAt(): Promise<Date> },
): Promise<DeviceVerdict> {
  const offline = deviceVerdict(summary, null, null);
  if (offline.status === "refused") return offline;
  const [list, at] = await Promise.allSettled([sources.revocationList(), sources.publishedAt()]);
  return deviceVerdict(
    summary,
    at.status === "fulfilled" ? at.value : null,
    list.status === "fulfilled" ? list.value : null,
  );
}
