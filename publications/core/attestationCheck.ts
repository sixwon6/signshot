/**
 * The network half of the device verdict (`deviceVerdict` in `attestation.ts`): Google's
 * attestation revocation list, and the edition's on-chain publication time the certificates'
 * validity is judged at. Shared by the app and `scripts/verify-attestation.ts`, so both reach the
 * same answer from the same inputs.
 *
 * Neither is ever guessed. A list that cannot be fetched or read, or a publication time that cannot
 * be read, leaves the verdict "unchecked" and the screen says "Couldn't check.".
 */

import { request } from "../rpc";
import { deviceVerdict, type AttestationSummary, type DeviceVerdict, type RevocationList } from "./attestation";
import { account, addresses, readEdition } from "./protocol";

/** Google's list, which the app and the verifier fetch directly. */
export const GOOGLE_STATUS_URL = "https://android.googleapis.com/attestation/status";

/** 179 KB with 1,755 entries as of 2026-09-24; the bound leaves room for years of growth. */
export const MAX_STATUS_BYTES = 4_000_000;
/** Held when the response names no max-age; Google sends `max-age=86400`, which is honoured. */
const STATUS_DEFAULT_TTL_MS = 60 * 60 * 1000;
const STATUS_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const STATUS_TIMEOUT_MS = 20_000;
/**
 * A key a serial can be looked up under: lowercase hex (the documented form) or decimal (what the
 * live list also uses), and decimal digits are hex digits. Its length is bounded only by the
 * list's (`MAX_STATUS_BYTES`), so no serial a certificate can carry is left out.
 */
const SERIAL_KEY = /^[0-9a-f]+$/;

/**
 * Parse the list's JSON, refusing anything that is not its documented shape: `{ entries: { <serial>:
 * { status, reason?, ... } } }`. A shape this does not recognise is an unreadable list, not an
 * empty one. A well-formed entry under a key that is neither lowercase hex nor decimal is skipped:
 * `revocationHits` never asks for one, so dropping it changes no answer, while refusing the list
 * for it would leave every device row "Couldn't check." until Google removed it.
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
 * When the edition at `edition` was published, from the chain.
 *
 * A deployment with `programFeatures(program).publishedAt` wrote the Clock sysvar's
 * `unix_timestamp` into the Edition account as `published_at` at publish and never writes it
 * again, so the answer is one read of an account only that program can write. Nothing anyone
 * sends afterwards, to the edition or to any address near it, can move it or hide it.
 *
 * The legacy deployments (`LEGACY_WITHOUT_PUBLISHED_AT`) recorded no time, so for them it is the
 * block time of the transaction that created the publisher's own claim receipt (`["claim",
 * edition, creator]`, made by `publish` with copy #1 and never written again, so its history is
 * normally that one transaction); see `receiptCreationTime`.
 *
 * Throws when the Edition is missing or unreadable in its program's layout, or, on a legacy
 * deployment, when the receipt's history is too long to walk or its creation is not found.
 */
export async function publicationTime(endpoint: string, program: string, edition: string): Promise<Date> {
  const key = `${endpoint}\n${program}\n${edition}`;
  const held = timeCache.get(key);
  if (held) return held;
  const raw = await account(endpoint, edition);
  if (!raw || raw.owner !== program || raw.executable) throw new Error("Edition not found on this network");
  const state = readEdition(raw.bytes, program);
  const time = state.publishedAt !== null
    ? new Date(state.publishedAt * 1000)
    : await receiptCreationTime(endpoint, program, edition, state);
  if (timeCache.size >= 256) timeCache.clear();
  timeCache.set(key, time);
  return time;
}

/**
 * A legacy edition's publication time: the block time of the transaction that created its
 * creator's claim receipt.
 *
 * Not simply the oldest signature: anyone who knows an address can mention it in a transaction,
 * and a publisher knows their PDAs before publishing, so an early mention could backdate the
 * edition into an expired certificate's lifetime. The creating transaction is the one where the
 * System program created (or assigned) the receipt to the edition program, which only the program
 * can sign for. The walk stops at `MAX_SIGNATURE_PAGES`, so on these deployments a history padded
 * past it leaves the time unknown; `published_at` is what closes that.
 */
async function receiptCreationTime(
  endpoint: string,
  program: string,
  edition: string,
  state: { creator: string; nonce: string },
): Promise<Date> {
  const keys = await addresses(program, state.creator, state.nonce);
  if (keys.edition !== edition) throw new Error("Invalid edition addresses");
  const receipt = keys.receipt;
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
    return new Date(tx.blockTime * 1000);
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
