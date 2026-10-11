import {
  AccountRole,
  address,
  type Instruction,
} from "@solana/kit";
import { utf8 } from "../src/arweave/codec";
import { turboItemStatus, TurboError, TURBO_FREE_ITEM_BYTES } from "../src/arweave/turbo";
import { TURBO_PAYMENT_HOSTS, TURBO_UPLOAD_HOSTS } from "./turboHosts";
import type { CoreDraft, PublicationStorageProblem } from "./types";

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
/** First host that answers, in `turboHosts.ts` order. */
async function firstAnswer(hosts: readonly string[], path: (host: string) => string) {
  let last: unknown;
  for (const host of hosts) {
    try { return await json(path(host)); } catch (error) { last = error; }
  }
  throw last ?? new Error("Storage provider is unavailable.");
}
/** Items the bundler does not hold yet. */
async function pendingItems(items: StorageItem[]) {
  const held = await Promise.all(items.map(item => turboItemStatus(item.id)));
  return items.filter((_, index) => !held[index]);
}
/** Advisory only: the shared-IP quota is enforced at upload time. */
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

// --- Paid storage ---

/**
 * Turbo's free tier is a lifetime budget per wallet and per /24 subnet, and exhaustion is
 * permanent; carrier NAT shares subnets. Mainnet tries free first, then a stand-alone payment.
 *
 * Follows turbo-sdk `SolanaToken.createAndSubmitTx`: System transfer to the `/info` address plus a
 * memo `turboCreditDestinationAddress=<upload key>`, then `POST /v1/account/balance/solana`. Items
 * signed by the ed25519 upload key bill to its base58 address.
 */
export const paidStorage = (cluster: string) => cluster === "mainnet-beta";

/** Pinned. If `/info` names a different address, publishing stops; never pay wherever `/info` points. */
export const TURBO_SOLANA_ADDRESS = "HepiT2k93CFQaSB7i3ZNXhybZKn5MeWiv3UkLsaJKk4i";
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
/** spl-memo v2, as turbo-sdk uses. */
const MEMO_PROGRAM = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Covers price moves before upload; the surplus stays on the upload key. */
const HEADROOM_PERCENT = 150n;
/** Hard cap regardless of quote; a real two-item payment is ~227,000 lamports. */
export const MAX_STORAGE_LAMPORTS = 10_000_000n;
/** Credit waits for finalization on Turbo's side; re-posting is idempotent. */
const CREDIT_POLLS = 12;
const CREDIT_POLL_MS = 4_000;
/** Re-posts of a refused or misdirected payment (backoff 1, 2, 4 polls) before the free tier. */
const REFUSED_REPOSTS = 3;
/**
 * Max time a payment may stay uncredited before falling back to the free tier. Finalization takes
 * ~13 s and a blockhash expires in 60–90 s, so this is generous. A late credit stays on the key.
 */
export const SETTLE_BOUND_MS = 10 * 60_000;

const PRICE_UNAVAILABLE: StorageProblem = { kind: "unavailable", retryable: true,
  message: "Storage price unavailable. Try again." };
const ADDRESS_CHANGED: StorageProblem = { kind: "unavailable", retryable: false,
  message: "Storage payment address changed. Update Signshot." };
const PAYMENT_REFUSED: StorageProblem = { kind: "quota", retryable: false,
  message: "The storage provider refused this publication's payment." };

export interface StoragePayment {
  /** Always `TURBO_SOLANA_ADDRESS`. */
  target: string;
  lamports: bigint;
  /** Upload key's address, named in the memo. */
  destination: string;
}

/** Winc arrives as a decimal string. */
function winc(body: unknown): bigint {
  const value = (body as { winc?: unknown } | null)?.winc;
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) throw new Error("Unsupported price.");
  return BigInt(value);
}

/** SOL price for pending items, before any approval; `null` if none are pending. */
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
  // Re-price the exact amount: the per-SOL rate can hide fees.
  let bought: bigint;
  try {
    bought = winc(await firstAnswer(TURBO_PAYMENT_HOSTS, (host) => `${host}/v1/price/solana/${lamports}`));
  } catch {
    throw new PublicationStorageError(PRICE_UNAVAILABLE);
  }
  if (bought < required) throw new PublicationStorageError(PRICE_UNAVAILABLE);
  return { target, lamports, destination: uploader };
}

/** Transfer plus credit-destination memo. */
export function storagePaymentInstructions(payer: string, payment: StoragePayment): Instruction[] {
  if (payment.lamports <= 0n || payment.lamports > MAX_STORAGE_LAMPORTS || payment.target !== TURBO_SOLANA_ADDRESS)
    throw new Error("Invalid storage payment.");
  // `SystemInstruction::Transfer`: u32 LE index 2, u64 LE lamports.
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
 * A confirmed publication may pay again only after a quota refusal and with no earlier payment
 * still to land or be credited, so nothing is paid twice.
 */
export function storageTopUpOffered(
  d: Pick<CoreDraft, "confirmedAt" | "storage" | "storageError" | "storageFunding" | "storageTopUp">,
): boolean {
  return d.confirmedAt !== undefined && d.storage !== "available" && d.storageError?.kind === "quota" &&
    (!d.storageTopUp || d.storageFunding === "credit");
}

/** Payment receipt lost; it may still land. */
export const storageTopUpPending = () => new PublicationStorageError({ kind: "unavailable", retryable: true,
  message: "The storage payment may still land. Check again shortly." });

type CreditAnswer =
  | { status: "credited"; destination: unknown }
  | { status: "pending" }
  | { status: "refused" }
  | { status: "unreachable" };

/** `POST /v1/account/balance/solana`, trying each host in order. */
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
      const body = (await response.json().catch(() => null)) as Partial<Record<
        "creditedTransaction" | "pendingTransaction" | "failedTransaction",
        { transactionId?: unknown; destinationAddress?: unknown }>> | null;
      const credited = body?.creditedTransaction;
      if (credited && credited.transactionId === txId)
        return { status: "credited", destination: credited.destinationAddress };
      if (body?.failedTransaction || response.status === 400) return { status: "refused" };
      // 202: pending record; 404: Turbo's RPC has not seen the transaction yet.
      if (body?.pendingTransaction || response.status === 202 || response.status === 404)
        return { status: "pending" };
    } catch {
      // Try the next host.
    } finally { clearTimeout(timer); }
  }
  return { status: "unreachable" };
}

/**
 * Whether the upload key holds Turbo credit. 404 "User Not Found" means none (as turbo-sdk reads
 * it); anything else unreadable throws so the caller keeps the key.
 */
export async function storageCreditHeld(owner: string): Promise<boolean> {
  address(owner);
  let last: unknown;
  for (const host of TURBO_PAYMENT_HOSTS) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${host}/v1/account/balance/solana?address=${encodeURIComponent(owner)}`,
        { signal: controller.signal });
      if (response.status === 404 && (await response.text()).trim() === "User Not Found") return false;
      if (!response.ok) throw new Error("Storage provider is unavailable.");
      return winc(await response.json()) > 0n;
    } catch (error) {
      last = error;
    } finally { clearTimeout(timer); }
  }
  throw last ?? new Error("Storage provider is unavailable.");
}

/** Recorded on the draft so a resumed upload takes the same path. */
export type StorageFunding = "credit" | "free";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Claim the confirmed payment's credit before uploading. Re-posting a credited `tx_id` is
 * idempotent (payment OpenAPI), so resuming never pays twice. `null` if nothing is pending.
 * A refusal or misdirected credit that survives `REFUSED_REPOSTS`, or a payment uncredited past
 * `SETTLE_BOUND_MS` from `since(txId)`, falls back to the free tier.
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
      // Unreachable: a later check re-posts the same transaction.
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
 * `free` when every item is under the free item size (advertised, else `TURBO_FREE_ITEM_BYTES`).
 * The upload has the final word: a 402/413 there becomes `PAYMENT_REFUSED`.
 */
async function freeTier(items: StorageItem[]): Promise<StorageFunding> {
  const info = await firstAnswer(TURBO_UPLOAD_HOSTS, (host) => `${host}/info`).catch(() => null);
  const advertised = info?.freeTier?.maxItemBytes ?? info?.freeUploadLimitBytes;
  const limit = Number.isSafeInteger(advertised) && advertised > 0
    ? Math.min(advertised, TURBO_FREE_ITEM_BYTES) : TURBO_FREE_ITEM_BYTES;
  if (items.some(item => item.bytes.length >= limit)) throw new PublicationStorageError(PAYMENT_REFUSED);
  return "free";
}

export function storageProblem(error: unknown, paid = false, funding?: StorageFunding): StorageProblem {
  if (error instanceof PublicationStorageError) return error.problem;
  // Payment refused, and the free tier refused too.
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
