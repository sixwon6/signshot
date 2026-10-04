/**
 * The one way an edition transaction leaves this phone, for every flow (publish, claim, price,
 * close, send, storage):
 *
 *   draft (`publications/candy`) → `prepareForWallet` → the wallet's `signTransactions` (sign only;
 *   it may rewrite the compute-unit price and reorder accounts) → each transaction's `finish`
 *   (checks the rewrite, adds this phone's keypair signatures) → [the co-signer, Seeker-only claims]
 *   → simulate the signed bytes → `sendTransaction` → poll until confirmed or the blockhash expires.
 *
 * Signing does not broadcast, so a wallet that is closed or never answers has sent nothing, and the
 * signature is known before anything is sent.
 */

import {
  createKeyPairSignerFromBytes,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Address,
  type Blockhash,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  prepareForWallet,
  type Budget,
  type Draft,
  type DraftTransaction,
  type Lifetime,
  type Prepared,
} from "../../publications/candy/transactions";
import { classifyClaimFailure, type ClaimFailure } from "../../publications/candy/edition";
import { NEEDS_SOL, request } from "../../publications/rpc";
import { RPC_ENDPOINT } from "../solana/cluster";
import type { WalletSession } from "../solana/walletSession";
import type { SignInResult } from "../solana/liveAuthorize";

// ---------------------------------------------------------------------------------------------
// This phone's keypairs
// ---------------------------------------------------------------------------------------------

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16));

export const isSeed = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
/** 32 random bytes, hex: an ed25519 seed a draft can keep across restarts. */
export const newSeed = () => hex(randomBytes(32));
export const seedAddress = (seed: string): Address => getAddressDecoder().decode(ed25519.getPublicKey(unhex(seed)));
/** A kit signer for a stored seed (seed ‖ public key, which kit checks by signing once). */
export async function seedSigner(seed: string): Promise<KeyPairSigner> {
  const secret = unhex(seed);
  const bytes = new Uint8Array(64);
  bytes.set(secret);
  bytes.set(ed25519.getPublicKey(secret), 32);
  return createKeyPairSignerFromBytes(bytes);
}

// ---------------------------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------------------------

const rents = new Map<number, Promise<bigint>>();
/** `getMinimumBalanceForRentExemption`, memoised for the session. */
export function rent(bytes: number): Promise<bigint> {
  let known = rents.get(bytes);
  if (!known) {
    known = request<unknown>(RPC_ENDPOINT, "getMinimumBalanceForRentExemption", [bytes]).then((value) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Solana response");
      return BigInt(value);
    });
    known.catch(() => rents.delete(bytes));
    rents.set(bytes, known);
  }
  return known;
}

export async function balance(wallet: string): Promise<bigint> {
  const { value } = await request<{ value: number }>(RPC_ENDPOINT, "getBalance", [wallet, { commitment: "confirmed" }]);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("The network did not report this wallet's balance.");
  return BigInt(value);
}

export async function latestLifetime(): Promise<Lifetime> {
  const { value } = await request<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
    RPC_ENDPOINT, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  if (typeof value?.blockhash !== "string" || !Number.isSafeInteger(value.lastValidBlockHeight))
    throw new Error("Invalid Solana response");
  return { blockhash: value.blockhash as Blockhash, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) };
}

async function blockHeight(): Promise<bigint> {
  const height = await request<number>(RPC_ENDPOINT, "getBlockHeight", [{ commitment: "confirmed" }]);
  if (!Number.isSafeInteger(height) || height < 0) throw new Error("Invalid Solana block height.");
  return BigInt(height);
}

/** Whether a transaction on this lifetime can still be sent, with a few blocks to spare. */
export async function lifetimeLive(lastValidBlockHeight: bigint, spare = 10n): Promise<boolean> {
  return (await blockHeight()) + spare < lastValidBlockHeight;
}

// ---------------------------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------------------------

const jsonText = (value: unknown) => {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ?? String(value);
  } catch {
    return String(value);
  }
};

/** The runtime's error as the text the client's classifier reads (Rust's own spelling for rent). */
function errText(err: unknown): string {
  const rentError = (err as { InsufficientFundsForRent?: { account_index?: unknown } } | null)?.InsufficientFundsForRent;
  if (rentError && typeof rentError.account_index === "number")
    return `InsufficientFundsForRent { account_index: ${rentError.account_index} }`;
  return typeof err === "string" ? err : jsonText(err);
}

function customCode(err: unknown): { code: number } | null {
  const tuple = (err as { InstructionError?: unknown } | null)?.InstructionError;
  if (!Array.isArray(tuple)) return null;
  const custom = (tuple[1] as { Custom?: unknown } | null)?.Custom;
  return typeof custom === "number" ? { code: custom } : null;
}

function describe(err: unknown, logs: readonly string[]): string {
  const text = errText(err);
  if (/BlockhashNotFound/.test(text)) return "The transaction expired before it was sent. Nothing changed. Try again.";
  if (/InsufficientFundsFor|insufficient lamports|insufficient funds/i.test(`${text}\n${logs.join("\n")}`)) return NEEDS_SOL;
  const said = logs.filter((line) => /Error|failed/i.test(line)).slice(-2).join(" ");
  return `Solana refused the transaction: ${text}${said ? `. ${said}` : ""}`;
}

/** A transaction the network refused (in simulation, or on chain), with what the classifier needs. */
export class TransactionFailure extends Error {
  constructor(readonly err: unknown, readonly logs: string[], readonly accountKeys: Address[]) {
    super(describe(err, logs));
    this.name = "TransactionFailure";
  }
}

/** The client's reason for a failed claim. */
export function claimFailure(e: TransactionFailure, wallet: Address, payer: Address): ClaimFailure {
  return classifyClaimFailure(
    { err: errText(e.err), custom: customCode(e.err), logs: e.logs },
    { accountKeys: e.accountKeys, wallet, payer },
  );
}

const keysOf = (tx: Transaction): Address[] =>
  [...getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts];

// ---------------------------------------------------------------------------------------------
// Preparing
// ---------------------------------------------------------------------------------------------

/** A wallet's packet limit for one transaction. */
const MAX_WIRE_BYTES = 1232;
/** The most a reviewed priority fee may be; the wallet's allowance comes on top (co-signer cap 100,000). */
const MAX_REVIEWED_PRIORITY_LAMPORTS = 50_000n;
const MIN_UNIT_PRICE = 5_000n;
const MAX_UNITS = 1_400_000;

async function unitPrice(units: number): Promise<bigint> {
  const fees = await request<unknown>(RPC_ENDPOINT, "getRecentPrioritizationFees", [[]]).catch(() => null);
  const values = (Array.isArray(fees) ? fees : [])
    .map((entry) => (entry as { prioritizationFee?: unknown } | null)?.prioritizationFee)
    .filter((fee): fee is number => typeof fee === "number" && Number.isSafeInteger(fee) && fee >= 0)
    .map(BigInt)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const median = values.length ? values[(values.length - 1) >> 1] : 0n;
  const cap = (MAX_REVIEWED_PRIORITY_LAMPORTS * 1_000_000n) / BigInt(units);
  const price = median > MIN_UNIT_PRICE ? median : MIN_UNIT_PRICE;
  return price > cap ? cap : price;
}

const wireLength = (tx: Transaction) => getBase64Encoder().encode(getBase64EncodedWireTransaction(tx)).length;

async function simulate(tx: Transaction, signed: boolean) {
  const result = await request<{ value: { err: unknown; logs?: string[] | null; unitsConsumed?: number | null } }>(
    RPC_ENDPOINT, "simulateTransaction", [getBase64EncodedWireTransaction(tx), {
      encoding: "base64", commitment: "confirmed", sigVerify: signed, replaceRecentBlockhash: !signed,
    }]);
  const value = result?.value;
  if (!value || typeof value !== "object") throw new Error("Invalid Solana response");
  return { err: value.err ?? null, logs: Array.isArray(value.logs) ? value.logs : [], units: value.unitsConsumed ?? null };
}

export interface Ready {
  feePayer: Address;
  prepared: Prepared[];
  budgets: Budget[];
  lifetime: Lifetime;
}

/**
 * Compile a draft for the wallet. Each transaction is simulated first (unsigned) to size its
 * compute budget, unless `units[i]` is given: a transaction that depends on an earlier one in the
 * same draft cannot be simulated before that one lands. A refused simulation throws
 * `TransactionFailure` before any wallet opens.
 */
export async function prepareDraft(draft: Draft, units: (number | null)[] = []): Promise<Ready> {
  const lifetime = await latestLifetime();
  const budgets: Budget[] = [];
  for (const [index, tx] of draft.transactions.entries()) {
    let limit = units[index] ?? null;
    if (limit === null) {
      const probe = prepareForWallet(draft.feePayer, tx, lifetime, { units: MAX_UNITS, microLamports: 0n });
      const sim = await simulate(probe.transaction, false);
      if (sim.err) throw new TransactionFailure(sim.err, sim.logs, keysOf(probe.transaction));
      const used = typeof sim.units === "number" && sim.units > 0 ? sim.units : 200_000;
      limit = Math.min(MAX_UNITS, Math.max(50_000, Math.ceil((used * 1.3) / 10_000) * 10_000));
    }
    budgets.push({ units: limit, microLamports: await unitPrice(limit) });
  }
  return withLifetime(draft, budgets, lifetime);
}

/** The same draft and budgets on `lifetime` (a fresh one just before the wallet opens). */
export function withLifetime(draft: Draft, budgets: Budget[], lifetime: Lifetime): Ready {
  const prepared = draft.transactions.map((tx: DraftTransaction, i) => prepareForWallet(draft.feePayer, tx, lifetime, budgets[i]));
  for (const p of prepared)
    if (wireLength(p.transaction) > MAX_WIRE_BYTES) throw new Error("This transaction is too large for a wallet. Use a shorter title.");
  return { feePayer: draft.feePayer, prepared, budgets, lifetime };
}

/** The priority fee each reviewed transaction carries, in lamports. */
export const priorityLamports = (budgets: Budget[]) =>
  budgets.reduce((sum, b) => sum + (BigInt(b.units) * b.microLamports + 999_999n) / 1_000_000n, 0n);

// ---------------------------------------------------------------------------------------------
// The wallet
// ---------------------------------------------------------------------------------------------

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/**
 * One wallet session: authorize (or sign in with `signIn`), check it is `expected`, have the wallet
 * sign every transaction in ONE request, then `finish` each. Nothing is sent here.
 */
export async function signWithWallet(
  session: WalletSession,
  expected: Address,
  prepared: Prepared[],
  signIn?: Record<string, unknown>,
): Promise<{ transactions: Transaction[]; signInResult?: SignInResult }> {
  return session.connectAnd(async (wallet) => {
    let signInResult: SignInResult | undefined;
    let account: { address: string };
    if (signIn) {
      const result = await session.signIn(wallet, signIn);
      account = result.account;
      signInResult = result.signInResult;
    } else account = await session.authorizeSession(wallet);
    if (account.address !== expected) throw new Error(`Choose the wallet ${short(expected)} in your wallet app.`);
    const signed = await wallet.signTransactions({ transactions: prepared.map((p) => p.transaction) });
    if (!Array.isArray(signed) || signed.length !== prepared.length)
      throw new Error("The wallet did not return every transaction. Nothing was sent.");
    const transactions: Transaction[] = [];
    for (const [i, p] of prepared.entries()) transactions.push(await p.finish(signed[i]));
    return { transactions, signInResult };
  });
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

export const toWire = (tx: Transaction) => getBase64EncodedWireTransaction(tx) as string;
export const fromWire = (wire: string): Transaction => getTransactionDecoder().decode(getBase64Encoder().encode(wire));
export const signatureOf = (tx: Transaction) => getSignatureFromTransaction(tx) as string;

type Status = { err: unknown; confirmationStatus?: string } | null;
async function status(signature: string): Promise<Status> {
  const r = await request<{ value: Status[] }>(RPC_ENDPOINT, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
  return r?.value?.[0] ?? null;
}
const settled = (s: Status) => !!s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");

async function landedFailure(signature: string, err: unknown, tx: Transaction): Promise<TransactionFailure> {
  const found = await request<{ meta?: { logMessages?: string[] } } | null>(RPC_ENDPOINT, "getTransaction",
    [signature, { commitment: "confirmed", encoding: "base64", maxSupportedTransactionVersion: 0 }]).catch(() => null);
  return new TransactionFailure(err, found?.meta?.logMessages ?? [], keysOf(tx));
}

/** Where a signed transaction stands: landed, failed on chain, may still land, or cannot any more. */
export async function signatureStanding(signature: string, lastValidBlockHeight: bigint):
  Promise<"confirmed" | "failed" | "pending" | "expired"> {
  const s = await status(signature);
  if (settled(s)) return s!.err ? "failed" : "confirmed";
  return (await blockHeight()) > lastValidBlockHeight ? "expired" : "pending";
}

const POLL_MS = 1_500;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send one fully signed transaction and wait for it. Already landed: returns at once. The signed
 * bytes are simulated first, so a refusal comes back with its logs (`TransactionFailure`) and
 * nothing is sent. Resent every few polls until confirmed or its blockhash expires.
 */
export async function sendAndConfirm(tx: Transaction, lastValidBlockHeight: bigint): Promise<string> {
  const signature = signatureOf(tx);
  const before = await status(signature);
  if (settled(before)) {
    if (before!.err) throw await landedFailure(signature, before!.err, tx);
    return signature;
  }
  const sim = await simulate(tx, true);
  if (sim.err) {
    // The same transaction may have landed between the two reads.
    const again = await status(signature);
    if (settled(again) && !again!.err) return signature;
    throw new TransactionFailure(sim.err, sim.logs, keysOf(tx));
  }
  const wire = toWire(tx);
  const send = (skipPreflight: boolean) => request<string>(RPC_ENDPOINT, "sendTransaction",
    [wire, { encoding: "base64", skipPreflight, preflightCommitment: "confirmed", maxRetries: 5 }]);
  await send(false);
  const deadline = Date.now() + 120_000;
  for (let poll = 1; Date.now() < deadline; poll += 1) {
    await wait(POLL_MS);
    const s = await status(signature).catch(() => null);
    if (settled(s)) {
      if (s!.err) throw await landedFailure(signature, s!.err, tx);
      return signature;
    }
    if ((await blockHeight().catch(() => 0n)) > lastValidBlockHeight) {
      const last = await status(signature).catch(() => null);
      if (settled(last) && !last!.err) return signature;
      throw new Error("The transaction expired without landing. Nothing changed. Try again.");
    }
    if (poll % 3 === 0) await send(true).catch(() => undefined);
  }
  throw new Error("Solana has not confirmed the transaction yet. Check again in a moment.");
}
