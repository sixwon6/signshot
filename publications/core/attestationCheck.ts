/**
 * Network half of `deviceVerdict`: Google's revocation list and the edition's on-chain publication
 * time. Shared by the app and `scripts/verify-attestation.ts`. Either failing leaves "unchecked".
 */

import { request } from "../rpc";
import { deviceVerdict, type AttestationSummary, type DeviceVerdict, type RevocationList } from "./attestation";

export const GOOGLE_STATUS_URL = "https://android.googleapis.com/attestation/status";

/** The live list is ~180 KB. */
export const MAX_STATUS_BYTES = 4_000_000;
/** Used when the response has no max-age (Google sends `max-age=86400`). */
const STATUS_DEFAULT_TTL_MS = 60 * 60 * 1000;
const STATUS_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const STATUS_TIMEOUT_MS = 20_000;
/** Lowercase hex or decimal (a subset of hex). Length is bounded only by `MAX_STATUS_BYTES`. */
const SERIAL_KEY = /^[0-9a-f]+$/;

/**
 * Parse `{ entries: { <serial>: { status, reason?, ... } } }`; any other shape throws (unreadable,
 * not empty). Entries under non-hex keys are skipped since `revocationHits` never looks them up.
 */
export function parseRevocationList(json: unknown): RevocationList {
  const entries = (json as { entries?: unknown } | null)?.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("revocation list: no entries");
  const list = new Map<string, { status: string; reason?: string }>();
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    const entry = value as { status?: unknown; reason?: unknown } | null;
    if (!entry || typeof entry !== "object" || typeof entry.status !== "string")
      throw new Error("revocation list: bad entry");
    if (!SERIAL_KEY.test(key)) continue;
    list.set(key, typeof entry.reason === "string" ? { status: entry.status, reason: entry.reason } : { status: entry.status });
  }
  return list;
}

const statusCache = new Map<string, { until: number; list: Promise<RevocationList> }>();

/** Cached per `Cache-Control` max-age (capped at a day), as Google specifies. Failures are not cached. */
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
    // React Native's fetch has no body stream, so content-length is the only pre-read bound.
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

// --- Publication time ---

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const SIGNATURE_PAGE = 1000;
/** Beyond this much history the time is left unknown. */
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

/** On-chain publication time of a candy machine edition; throws if not found. See `creationTime`. */
export async function publicationTime(endpoint: string, program: string, edition: string): Promise<Date> {
  const key = `${endpoint}\n${program}\n${edition}`;
  const held = timeCache.get(key);
  if (held) return held;
  const time = await creationTime(endpoint, program, edition);
  if (timeCache.size >= 256) timeCache.clear();
  timeCache.set(key, time);
  return time;
}

/**
 * Block time of the transaction that created (or assigned) `edition` to `program`. Not the oldest
 * signature: anyone can mention an address early and backdate it into an expired certificate's
 * lifetime.
 */
async function creationTime(
  endpoint: string,
  program: string,
  edition: string,
): Promise<Date> {
  const history: SignatureEntry[] = [];
  let before: string | undefined;
  for (let page = 1; ; page += 1) {
    const batch = await request<SignatureEntry[]>(endpoint, "getSignaturesForAddress", [
      edition,
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
    if (!tx || tx.meta?.err !== null || !creates(tx, edition, program)) continue;
    if (typeof tx.blockTime !== "number" || !Number.isSafeInteger(tx.blockTime) || tx.blockTime <= 0)
      throw new Error("The publication transaction has no block time.");
    return new Date(tx.blockTime * 1000);
  }
  throw new Error("The publication transaction was not found.");
}

/** Offline rules first, so a refusal needs no fetch; then list and time in parallel. */
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
