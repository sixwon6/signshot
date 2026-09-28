import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
  type Instruction,
} from "@solana/kit";
import { utf8 } from "../src/arweave/codec";
import { turboItemStatus, TurboError, TURBO_FREE_ITEM_BYTES } from "../src/arweave/turbo";
import { matchesReviewedMessage, verifiedMessage } from "./core/transferReceipt";
import { NEEDS_SOL, request } from "./rpc";
import { TURBO_PAYMENT_HOSTS, TURBO_UPLOAD_HOSTS } from "./turboHosts";
import type { CoreDraft, PublicationStorageProblem, StorageTopUp } from "./types";

type StorageProblem = PublicationStorageProblem;
type StorageItem = { id: string; bytes: Uint8Array };
class PublicationStorageError extends Error {
  constructor(readonly problem: StorageProblem) { super(problem.message); }
}
/** `any`: each caller validates the fields it reads. */
async function json(url: string): Promise<any> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("Storage provider is unavailable.");
    return await response.json();
  } finally { clearTimeout(timer); }
}
/** The first host that answers, in `turboHosts.ts` order, so one dead host cannot stop a publication. */
async function firstAnswer(hosts: readonly string[], path: (host: string) => string) {
  let last: unknown;
  for (const host of hosts) {
    try { return await json(path(host)); } catch (error) { last = error; }
  }
  throw last ?? new Error("Storage provider is unavailable.");
}
/** The items the bundler does not hold yet; only these are checked, priced or funded. */
async function pendingItems(items: StorageItem[]) {
  const held = await Promise.all(items.map(item => turboItemStatus(item.id)));
  return items.filter((_, index) => !held[index]);
}
/** Advisory allowance only: the provider's shared-IP quota is checked at upload time. */
export async function checkStorageCapacity(uploader: string, items: StorageItem[]) {
  const pending = await pendingItems(items);
  if (!pending.length) return { requiredBytes: 0, remainingBytes: null };
  let info, allowance;
  try {
    [info, allowance] = await Promise.all([
      firstAnswer(TURBO_UPLOAD_HOSTS, (host) => `${host}/info`),
      firstAnswer(
        TURBO_PAYMENT_HOSTS,
        (host) => `${host}/v1/account/free?address=${encodeURIComponent(uploader)}`,
      ),
    ]);
  } catch {
    throw new PublicationStorageError({ kind: "unavailable", retryable: true,
      message: "Could not check image storage. Try again before approving a wallet transaction." });
  }
  const limit = info?.freeTier?.maxItemBytes ?? info?.freeUploadLimitBytes;
  const remaining = allowance?.bytesRemaining;
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(remaining) || remaining < 0)
    throw new PublicationStorageError({ kind: "unavailable", retryable: true,
      message: "The storage provider returned an unsupported allowance. Publishing is paused until it can be checked." });
  if (pending.some(item => item.bytes.length >= limit))
    throw new PublicationStorageError({ kind: "size", retryable: false,
      message: "This published copy exceeds the provider's free image size. It cannot be uploaded by this build." });
  const requiredBytes = pending.reduce((sum, item) => sum + item.bytes.length, 0);
  if (requiredBytes > remaining)
    throw new PublicationStorageError({ kind: "quota", retryable: false,
      message: "The free image-storage allowance is used up. Publishing needs paid storage support before you can continue; no wallet approval is needed now." });
  return { requiredBytes, remainingBytes: remaining };
}

/**
 * PAID STORAGE. Turbo's free tier is a lifetime budget per wallet AND per /24 subnet (`GET /info`
 * `freeTier`), and its 402 `FREE_TIER_EXHAUSTED` "is a PERMANENT condition" (upload OpenAPI). A
 * carrier NAT shares a subnet, and the edition is on chain before the upload, so a mainnet build
 * does not rely on it: the publication transaction itself buys the credit. The free tier is only
 * the fallback for a confirmed payment the service will not credit (`settleStoragePayment`), and a
 * stand-alone payment (`storageTopUpTransaction`) buys storage again when that is refused too.
 *
 * The recipe is turbo-sdk's `SolanaToken.createAndSubmitTx`: a System transfer to the Solana address
 * the payment service advertises at `GET /info`, plus an spl-memo instruction
 * `turboCreditDestinationAddress=<address>`, then `POST /v1/account/balance/solana` with the
 * transaction id. The service "credits the sender (or the address named in the payment's
 * credit-destination memo/tag)" (payment OpenAPI), so the credit lands on the upload key, and a
 * data item signed by an ed25519 key is billed to that key's base58 address (turbo-sdk `signer.ts`).
 * One approval, no server, and a transfer that lands only if the edition does.
 */
export const paidStorage = (cluster: string) => cluster === "mainnet-beta";

/**
 * Turbo's Solana payment address, pinned: `/info` is read on every quote, but only this answer is
 * paid. payment.ardrive.io/v1/info, turbo.ardrive.io/info and upload.ardrive.io/info all named it
 * on 2026-09-25. A different one means a new release, never a transfer to wherever `/info` points.
 */
export const TURBO_SOLANA_ADDRESS = "HepiT2k93CFQaSB7i3ZNXhybZKn5MeWiv3UkLsaJKk4i";
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
/** spl-memo v2, the program turbo-sdk writes the credit destination with (`memoProgramId`). */
const MEMO_PROGRAM = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** The payment service's price for one SOL is read in lamports, its `solana` token's base unit. */
const LAMPORTS_PER_SOL = 1_000_000_000n;
/**
 * Paid above the quote, so a price move before the upload cannot leave the credit short. What is
 * left stays on the upload key, a buffer for that wallet's later uploads.
 */
const HEADROOM_PERCENT = 150n;
/**
 * Refused above this whatever the provider quotes. Two items at the item cap priced at ~227,000
 * lamports with headroom in September 2026, so this leaves room for ~40× without a release.
 */
export const MAX_STORAGE_LAMPORTS = 10_000_000n;
/** Credit waits for the transfer to finalize on the service's side; re-posting is idempotent. */
const CREDIT_POLLS = 12;
const CREDIT_POLL_MS = 4_000;
/** Re-posts of a refused or misdirected payment, waiting 1, 2 then 4 polls, before the free tier. */
const REFUSED_REPOSTS = 3;
/**
 * How long a payment may stay uncredited (pending, not found, failing or unreachable), from the
 * service's first answer, before the free tier is tried as for a refusal. turbo-sdk posts a payment
 * once it is `finalized`; finalized trails confirmed by about 32 slots (~13 s), and a blockhash
 * expires in 60–90 s (solana.com/developers/guides/advanced/confirmation). Ten minutes is far past
 * both. A credit that posts later stays on the upload key.
 */
export const SETTLE_BOUND_MS = 10 * 60_000;

const PRICE_UNAVAILABLE: StorageProblem = { kind: "unavailable", retryable: true,
  message: "Storage price unavailable. Try again." };
const ADDRESS_CHANGED: StorageProblem = { kind: "unavailable", retryable: false,
  message: "Storage payment address changed. Update Signshot." };
const PAYMENT_REFUSED: StorageProblem = { kind: "quota", retryable: false,
  message: "The storage provider refused this publication's payment." };

/** What the publication transaction pays for its own uploads. */
export interface StoragePayment {
  /** `TURBO_SOLANA_ADDRESS`, once the payment service's `/info` has named it. */
  target: string;
  lamports: bigint;
  /** The upload key's base58 address, named in the credit-destination memo. */
  destination: string;
}

/** A winc amount as the payment service writes it: a decimal string. */
function winc(body: unknown): bigint {
  const value = (body as { winc?: unknown } | null)?.winc;
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) throw new Error("Unsupported price.");
  return BigInt(value);
}

/**
 * Price the pending items in SOL, before any approval. `null` when the bundler already holds both.
 * Any failure, and a payment address other than the pinned one, stops publishing here.
 */
export async function quoteStoragePayment(uploader: string, items: StorageItem[]): Promise<StoragePayment | null> {
  const pending = await pendingItems(items);
  if (!pending.length) return null;
  let target: string, required: bigint, lamports: bigint;
  try {
    const [info, perSol, ...prices] = await Promise.all([
      firstAnswer(TURBO_PAYMENT_HOSTS, (host) => `${host}/v1/info`),
      firstAnswer(TURBO_PAYMENT_HOSTS, (host) => `${host}/v1/price/solana/${LAMPORTS_PER_SOL}`),
      ...pending.map(item =>
        firstAnswer(TURBO_PAYMENT_HOSTS, (host) => `${host}/v1/price/bytes/${item.bytes.length}`)),
    ]);
    target = address(String(info?.addresses?.solana));
    address(uploader);
    const wincPerSol = winc(perSol);
    required = prices.reduce((sum: bigint, price) => sum + winc(price), 0n);
    if (wincPerSol <= 0n || required <= 0n) throw new Error("Unsupported price.");
    const scaled = required * HEADROOM_PERCENT * LAMPORTS_PER_SOL, per = 100n * wincPerSol;
    lamports = (scaled + per - 1n) / per;
  } catch {
    throw new PublicationStorageError(PRICE_UNAVAILABLE);
  }
  if (target !== TURBO_SOLANA_ADDRESS) throw new PublicationStorageError(ADDRESS_CHANGED);
  if (lamports > MAX_STORAGE_LAMPORTS)
    throw new PublicationStorageError({ kind: "unavailable", retryable: true,
      message: "Storage price out of range. Try again later." });
  // The exact amount priced as a payment, so fees the per-SOL rate hides still leave enough.
  let bought: bigint;
  try {
    bought = winc(await firstAnswer(TURBO_PAYMENT_HOSTS, (host) => `${host}/v1/price/solana/${lamports}`));
  } catch {
    throw new PublicationStorageError(PRICE_UNAVAILABLE);
  }
  if (bought < required) throw new PublicationStorageError(PRICE_UNAVAILABLE);
  return { target, lamports, destination: uploader };
}

/** The transfer and the credit-destination memo, appended to the publication's instructions. */
export function storagePaymentInstructions(payer: string, payment: StoragePayment): Instruction[] {
  if (payment.lamports <= 0n || payment.lamports > MAX_STORAGE_LAMPORTS || payment.target !== TURBO_SOLANA_ADDRESS)
    throw new Error("Invalid storage payment.");
  // `SystemInstruction::Transfer`: u32 index 2, then the lamports as a u64, both little-endian.
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, payment.lamports, true);
  return [
    {
      programAddress: SYSTEM_PROGRAM,
      accounts: [
        { address: address(payer), role: AccountRole.WRITABLE_SIGNER },
        { address: address(payment.target), role: AccountRole.WRITABLE },
      ],
      data,
    },
    {
      programAddress: MEMO_PROGRAM,
      accounts: [],
      data: utf8(`turboCreditDestinationAddress=${address(payment.destination)}`),
    },
  ];
}

/**
 * The stand-alone storage payment, as turbo-sdk's `SolanaToken.createAndSubmitTx` builds it: a
 * legacy message holding the transfer and the credit-destination memo and nothing else, not even a
 * compute budget, which two System and Memo instructions do not need. Refused before a wallet opens
 * when the payer cannot cover it and the network fee.
 */
export async function storageTopUpTransaction(endpoint: string, payer: string, payment: StoragePayment) {
  const instructions = storagePaymentInstructions(payer, payment);
  const latest = await request<{ context?: { slot?: unknown }; value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } }>(
    endpoint, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const slot = latest?.context?.slot, height = latest?.value?.lastValidBlockHeight;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0 ||
    typeof height !== "number" || !Number.isSafeInteger(height) || height < 0)
    throw new Error("Invalid Solana response");
  const lifetime = { blockhash: blockhash(String(latest.value?.blockhash)), lastValidBlockHeight: BigInt(height) };
  const transaction = compileTransaction(appendTransactionMessageInstructions(instructions,
    setTransactionMessageLifetimeUsingBlockhash(lifetime,
      setTransactionMessageFeePayer(address(payer), createTransactionMessage({ version: "legacy" })))));
  const [fee, balance] = await Promise.all([
    request<{ value?: unknown }>(endpoint, "getFeeForMessage",
      [getBase64Decoder().decode(transaction.messageBytes), { commitment: "confirmed" }]),
    request<{ value?: unknown }>(endpoint, "getBalance", [payer, { commitment: "confirmed" }]),
  ]);
  if (fee?.value === null) throw new Error("Transaction expired. Try again.");
  if (typeof fee?.value !== "number" || !Number.isSafeInteger(fee.value) ||
    typeof balance?.value !== "number" || !Number.isSafeInteger(balance.value))
    throw new Error("Invalid Solana response");
  if (BigInt(balance.value) < payment.lamports + BigInt(fee.value)) throw new Error(NEEDS_SOL);
  return { transaction, blockhash: lifetime.blockhash as string, lastValidBlockHeight: lifetime.lastValidBlockHeight, slot };
}

/**
 * Whether a confirmed publication may buy storage again: the provider refused its upload (the free
 * tier's refusal included) or found its credit short, and no stand-alone payment is still to land
 * or to be credited. A check re-posts that one instead, so nothing is paid twice.
 */
export function storageTopUpOffered(
  d: Pick<CoreDraft, "confirmedAt" | "storage" | "storageError" | "storageFunding" | "storageTopUp">,
): boolean {
  return d.confirmedAt !== undefined && d.storage !== "available" && d.storageError?.kind === "quota" &&
    (!d.storageTopUp || d.storageFunding === "credit");
}

/** A stand-alone payment whose receipt is lost and which may still land. */
export const storageTopUpPending = () => new PublicationStorageError({ kind: "unavailable", retryable: true,
  message: "The storage payment may still land. Check again shortly." });

type CreditAnswer =
  | { status: "credited"; destination: unknown }
  | { status: "pending" }
  | { status: "refused" }
  | { status: "unreachable" };

/** One `POST /v1/account/balance/solana`, primary host first; an unreachable or failing host passes. */
async function submitPayment(txId: string): Promise<CreditAnswer> {
  for (const host of TURBO_PAYMENT_HOSTS) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${host}/v1/account/balance/solana`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tx_id: txId }),
        signal: controller.signal,
      });
      // A body that is not JSON leaves the status alone to decide.
      const body = (await response.json().catch(() => null)) as Partial<Record<
        "creditedTransaction" | "pendingTransaction" | "failedTransaction",
        { transactionId?: unknown; destinationAddress?: unknown }>> | null;
      const credited = body?.creditedTransaction;
      if (credited && credited.transactionId === txId)
        return { status: "credited", destination: credited.destinationAddress };
      if (body?.failedTransaction || response.status === 400) return { status: "refused" };
      // 202 is the service's own pending record; 404 is a transaction its RPC has not seen yet.
      if (body?.pendingTransaction || response.status === 202 || response.status === 404)
        return { status: "pending" };
    } catch {
      // Unreachable or timed out: ask the next host.
    } finally { clearTimeout(timer); }
  }
  return { status: "unreachable" };
}

/**
 * How a confirmed publication's uploads are paid for, recorded on its draft so a resumed upload
 * takes the same path: `credit`, the credit its payment bought; `free`, Turbo's free tier, because
 * the payment service refused that payment for good.
 */
export type StorageFunding = "credit" | "free";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Claim the credit the confirmed publication transaction bought, before anything is uploaded.
 * "Re-posting a `tx_id` that is already credited returns `200` with the existing record rather than
 * crediting twice" (payment OpenAPI), so an interrupted upload resumes here without paying again;
 * nothing on this path builds a payment. `receipt` is asked for only when an item is pending, and
 * `null` is returned when none is.
 *
 * A refusal (400) or a credit to another account is re-posted `REFUSED_REPOSTS` times with backoff.
 * If it stands, the edition is already on chain and paid for, so the free tier is tried rather than
 * stranding it: `free` when every pending item is within Turbo's free item size. So is a payment
 * left uncredited `SETTLE_BOUND_MS` after `since(txId)`, the first uncredited answer the caller
 * keeps for that transaction across checks.
 */
export async function settleStoragePayment(
  receipt: () => Promise<string>,
  destination: string,
  items: StorageItem[],
  pollMs = CREDIT_POLL_MS,
  since: (txId: string) => Promise<number> = async () => Date.now(),
): Promise<StorageFunding | null> {
  const pending = await pendingItems(items);
  if (!pending.length) return null;
  const txId = await receipt();
  let polls = 0, refusals = 0, first: number | undefined;
  while (true) {
    const answer = await submitPayment(txId);
    if (answer.status === "credited" && answer.destination === destination) return "credit";
    if (answer.status === "unreachable" || answer.status === "pending") {
      first ??= await since(txId);
      if (Date.now() - first >= SETTLE_BOUND_MS) return freeTier(pending);
      // No host answered at all; a later check re-posts the same transaction.
      if (answer.status === "unreachable" || ++polls >= CREDIT_POLLS) break;
      await wait(pollMs);
      continue;
    }
    if (refusals === REFUSED_REPOSTS) return freeTier(pending);
    await wait(pollMs * 2 ** refusals);
    refusals += 1;
  }
  throw new PublicationStorageError({ kind: "unavailable", retryable: true,
    message: "Storage payment is settling. Check again shortly." });
}

/**
 * `free` when every item is under the upload service's advertised free item size, or under the
 * documented one (`TURBO_FREE_ITEM_BYTES`) when `/info` does not answer: the upload itself is the
 * final word, and a 402 or 413 there ends in `PAYMENT_REFUSED` (`storageProblem`).
 */
async function freeTier(items: StorageItem[]): Promise<StorageFunding> {
  const info = await firstAnswer(TURBO_UPLOAD_HOSTS, (host) => `${host}/info`).catch(() => null);
  const advertised = info?.freeTier?.maxItemBytes ?? info?.freeUploadLimitBytes;
  const limit = Number.isSafeInteger(advertised) && advertised > 0
    ? Math.min(advertised, TURBO_FREE_ITEM_BYTES) : TURBO_FREE_ITEM_BYTES;
  if (items.some(item => item.bytes.length >= limit)) throw new PublicationStorageError(PAYMENT_REFUSED);
  return "free";
}

/**
 * Does this message pay Turbo for `destination`'s credit, however a wallet dressed it: a top-level
 * System transfer from `payer`, its fee payer, to `TURBO_SOLANA_ADDRESS`, and the spl-memo naming
 * `destination`. Accounts are read from the static list only; a lookup-table index matches nothing.
 * `blockhash`, when given, must be the message's own.
 */
export function paysStorage(message: Uint8Array, payer: string, destination: string, blockhash?: string): boolean {
  try {
    const decoded = getCompiledTransactionMessageDecoder().decode(message);
    if (decoded.version !== 0 && decoded.version !== "legacy") return false;
    if (blockhash !== undefined && decoded.lifetimeToken !== blockhash) return false;
    const accounts = decoded.staticAccounts as readonly string[];
    const memo = utf8(`turboCreditDestinationAddress=${destination}`);
    let transfer = false, credited = false;
    for (const { programAddressIndex, accountIndices = [], data = new Uint8Array(0) } of decoded.instructions) {
      const program = accounts[programAddressIndex];
      if (program === SYSTEM_PROGRAM && data.length === 12 && accountIndices.length === 2 &&
        data[0] === 2 && data[1] === 0 && data[2] === 0 && data[3] === 0 && data.slice(4).some(byte => byte !== 0) &&
        accounts[accountIndices[0]] === payer && accounts[accountIndices[1]] === TURBO_SOLANA_ADDRESS)
        transfer = true;
      if (program === MEMO_PROGRAM && data.length === memo.length && memo.every((byte, i) => data[i] === byte))
        credited = true;
    }
    return accounts[0] === payer && transfer && credited;
  } catch {
    return false;
  }
}

/** How far back each address's history is walked, and how many of its oldest transactions are read. */
const HISTORY_PAGES = 5, HISTORY_PAGE = 1000, OLDEST_READ = 20;
/** How a read transaction answers a search: the reviewed message, a storage payment, or neither. */
type Verdict = "reviewed" | "payment" | null;

/**
 * The publication transaction when the wallet never returned its receipt: the oldest successful
 * transaction whose message matches the fingerprint saved before the wallet opened, checked as
 * `recoverTransferReceipt` checks a transfer's. The creator's claim receipt is searched first:
 * `publish` creates it and nothing else normally touches it, while every collect writes the edition.
 * The edition is searched after. Pre-funding either address can put transfers ahead of the
 * publication, so several of the oldest are read. A wallet that added its own instructions (compute
 * budget, Lighthouse) changes the fingerprint, so failing that, the oldest that `paysStorage` is taken.
 */
export async function findStoragePayment(
  endpoint: string,
  publication: { receipt: string; edition: string },
  quoteId: string,
  payment: { payer: string; destination: string },
): Promise<string> {
  const judge = (message: Uint8Array): Verdict =>
    matchesReviewedMessage(message, quoteId) ? "reviewed"
      : paysStorage(message, payment.payer, payment.destination) ? "payment" : null;
  for (const account of [publication.receipt, publication.edition]) {
    const found = await oldestMatching(endpoint, account, judge);
    if (found) return found;
  }
  throw new PublicationStorageError({ kind: "unavailable", retryable: true,
    message: "The publication's payment was not found. Check again shortly." });
}

/**
 * The stand-alone payment when the wallet never returned its receipt: among the payer's transactions
 * from the slot its blockhash was read at, the reviewed message, or one the wallet rewrote that
 * `paysStorage` on that same blockhash. Every draft of a wallet names the same upload key, so the
 * blockhash is what tells this payment from the publication's or another draft's. `null` if absent.
 */
export async function findStorageTopUp(
  endpoint: string,
  topUp: Pick<StorageTopUp, "quoteId" | "blockhash" | "slot">,
  payment: { payer: string; destination: string },
): Promise<string | null> {
  return oldestMatching(endpoint, payment.payer, (message) =>
    matchesReviewedMessage(message, topUp.quoteId) ? "reviewed"
      : paysStorage(message, payment.payer, payment.destination, topUp.blockhash) ? "payment" : null,
  topUp.slot);
}

/**
 * The oldest judged transaction at `account` from `fromSlot` on: a reviewed match before a payment.
 * Only a transaction whose signature verifies over its message (`verifiedMessage`) is judged.
 */
async function oldestMatching(
  endpoint: string,
  account: string,
  judge: (message: Uint8Array) => Verdict,
  fromSlot = 0,
): Promise<string | null> {
  const landed: { signature: string; slot: number }[] = [];
  let before: string | undefined;
  for (let page = 0; page < HISTORY_PAGES; page += 1) {
    const batch = await request<unknown>(endpoint, "getSignaturesForAddress",
      [account, { limit: HISTORY_PAGE, commitment: "confirmed", ...(before ? { before } : {}) }]);
    if (!Array.isArray(batch)) throw new Error("Invalid Solana response");
    for (const entry of batch) {
      if (typeof entry?.signature !== "string" || entry.err !== null ||
        !Number.isSafeInteger(entry.slot) || entry.slot < fromSlot ||
        (entry.confirmationStatus !== "confirmed" && entry.confirmationStatus !== "finalized")) continue;
      try { signature(entry.signature); } catch { continue; }
      landed.push({ signature: entry.signature, slot: entry.slot });
    }
    const last = batch[batch.length - 1];
    if (batch.length < HISTORY_PAGE || typeof last?.signature !== "string" || !(last.slot >= fromSlot)) break;
    before = last.signature;
  }
  // RPC lists newest first; the publication created both accounts, so it is among the oldest. A
  // read that fails is a candidate not confirmed, never an error.
  const oldest = landed.reverse().slice(0, OLDEST_READ);
  const verdicts = await Promise.all(oldest.map(async (entry): Promise<Verdict> => {
    try {
      const result = await request<unknown>(endpoint, "getTransaction", [entry.signature,
        { commitment: "confirmed", encoding: "base64", maxSupportedTransactionVersion: 0 }]);
      const message = verifiedMessage(result, entry.signature, entry.slot);
      return message ? judge(message) : null;
    } catch {
      return null;
    }
  }));
  const first = (verdict: Verdict) => oldest.find((_, index) => verdicts[index] === verdict)?.signature;
  return first("reviewed") ?? first("payment") ?? null;
}

export function storageProblem(error: unknown, paid = false, funding?: StorageFunding): StorageProblem {
  if (error instanceof PublicationStorageError) return error.problem;
  // The payment was refused and the free tier refuses the upload too.
  if (funding === "free" && error instanceof TurboError && (error.status === 402 || error.status === 413))
    return PAYMENT_REFUSED;
  if (error instanceof TurboError && error.status === 402)
    return paid
      ? { kind: "quota", retryable: false, message: "Storage credit ran short for this upload." }
      : { kind: "quota", retryable: false, message: "The storage provider refused the free upload allowance. Your wallet record remains published, but completing the image upload needs restored provider capacity or paid storage support." };
  if (error instanceof TurboError && error.status === 413)
    return { kind: "size", retryable: false, message: "The storage provider refused this image's size. Your wallet record remains published; this build cannot complete its upload." };
  const message = error instanceof Error ? error.message : String(error);
  if (/fingerprint|identifiers changed|Saved print changed|not retryable|does not match its onchain/i.test(message))
    return { kind: "integrity", retryable: false, message: "The image or metadata no longer matches its published fingerprint. Upload stopped. This app's storage and its upload key hold the only copy of the published image and details; export the publication bundle from this photograph to keep them." };
  return { kind: "unavailable", retryable: true, message: "The wallet record is published. Its image is still uploading or becoming available; you can check and complete the upload again." };
}
