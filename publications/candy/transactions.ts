/**
 * Signing order for edition transactions, pure (no wallet or network calls here).
 *
 * The wallet (Seed Vault through Mobile Wallet Adapter) rewrites what it signs: it may replace the
 * compute-unit price and limit and reorder the message's accounts. A signature made before the wallet signs would no
 * longer verify, so:
 *   1. `prepareForWallet` compiles a draft into an unsigned transaction for `signTransactions`
 *      (sign only, not send);
 *   2. its `finish`, given the transaction the wallet returned, refuses it unless the message still
 *      carries a valid wallet signature and
 *      means the same thing (`sameMeaning`), then adds the local keypairs' signatures over the
 *      message as returned;
 *   3. for a Seeker-only claim the server then signs that same message (`partiallySignTransaction`);
 *   4. the app sends it.
 */

import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
  type TransactionMessageBytes,
} from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";

type MessageBytes = TransactionMessageBytes | Uint8Array;

export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111" as Address;

/** One transaction of an operation: its instructions and the app-held keypairs that must sign it. */
export interface DraftTransaction { instructions: Instruction[]; localSigners: KeyPairSigner[] }
/** An operation: the wallet that pays and signs first, and its transactions in order. */
export interface Draft { feePayer: Address; transactions: DraftTransaction[] }

export interface Lifetime { blockhash: Blockhash; lastValidBlockHeight: bigint }
export interface Budget { units: number; microLamports: bigint }

/**
 * What the wallet may add in priority fee: the reviewed price at the returned limit plus
 * `FEE_ALLOWANCE_LAMPORTS` (50,000 lamports, `publications/rpc.ts`), the allowance the app
 * already shows in its estimate.
 */
export const FEE_ALLOWANCE_LAMPORTS = 50_000n;
/** The runtime's ceiling per transaction, and its default per instruction when no limit is set. */
export const MAX_TRANSACTION_UNITS = 1_400_000n;
export const DEFAULT_UNITS_PER_INSTRUCTION = 200_000n;

/** `ceil(limit × price / 1,000,000)` lamports. */
export const priorityFee = (limit: bigint, microLamports: bigint) => (limit * microLamports + 999_999n) / 1_000_000n;

export interface Prepared {
  /** For the wallet's `signTransactions`: compiled, no signatures yet. */
  transaction: Transaction;
  /** The wallet's returned transaction, checked, with the local signatures added. */
  finish(signed: Transaction): Promise<Transaction>;
}

const keyBytes = (a: Address) => new Uint8Array(getAddressEncoder().encode(a));
const plain = (b: ArrayLike<number>) => Uint8Array.from(b as ArrayLike<number>);

/**
 * Compiles one draft transaction with SetComputeUnitLimit + SetComputeUnitPrice first, as the app
 * sends. `feeAllowanceLamports` is what the wallet may add on top of the reviewed priority fee
 * (the app passes `FEE_ALLOWANCE_LAMPORTS`).
 */
export function prepareForWallet(feePayer: Address, draft: DraftTransaction, lifetime: Lifetime, budget: Budget,
  feeAllowanceLamports: bigint = FEE_ALLOWANCE_LAMPORTS): Prepared {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: budget.units }),
      getSetComputeUnitPriceInstruction({ microLamports: budget.microLamports }),
      ...draft.instructions,
    ], m),
  );
  const transaction = compileTransaction(message);
  return {
    transaction,
    async finish(signed: Transaction) {
      const why = sameMeaning(transaction.messageBytes, signed.messageBytes, { reviewedMicroLamports: budget.microLamports, feeAllowanceLamports });
      if (why) throw new Error(`The wallet returned a different transaction (${why}). Nothing was sent.`);
      const signature = signed.signatures[feePayer];
      let valid = false;
      try { valid = !!signature && ed25519.verify(plain(signature), plain(signed.messageBytes), keyBytes(feePayer)); } catch { valid = false; }
      if (!valid) throw new Error("The wallet's signature does not verify. Nothing was sent.");
      return partiallySignTransaction(draft.localSigners.map((s) => s.keyPair), signed);
    },
  };
}

interface Resolved { program: Address; accounts: string[]; data: string }

/** A compiled message's instructions with every account resolved to `address:signer:writable`. */
function resolve(bytes: MessageBytes) {
  const m = getCompiledTransactionMessageDecoder().decode(bytes);
  if (m.version !== 0) throw new Error("not a v0 message");
  if ("addressTableLookups" in m && (m.addressTableLookups?.length ?? 0) > 0) throw new Error("address lookup tables");
  const keys = m.staticAccounts;
  const { numSignerAccounts: signers, numReadonlySignerAccounts: roSigners, numReadonlyNonSignerAccounts: roOthers } = m.header;
  const role = (i: number) => {
    const signer = i < signers;
    const writable = signer ? i < signers - roSigners : i < keys.length - roOthers;
    return `${keys[i]}:${signer ? "s" : "-"}:${writable ? "w" : "r"}`;
  };
  const instructions: Resolved[] = m.instructions.map((ix) => ({
    program: keys[ix.programAddressIndex],
    accounts: (ix.accountIndices ?? []).map(role),
    data: Array.from(ix.data ?? new Uint8Array(0), (x) => x.toString(16).padStart(2, "0")).join(""),
  }));
  return { feePayer: keys[0], lifetime: m.lifetimeToken, roles: keys.map((_, i) => role(i)).sort(), signers, instructions };
}

const leHex = (hex: string) => BigInt(`0x${(hex.match(/../g) ?? []).reverse().join("") || "0"}`);

/**
 * Null when `returned` means what `original` meant: the same fee payer, lifetime, accounts (each
 * with the same signer and writable role) and, apart from compute budget, the same instructions
 * in the same order with the same accounts and data. The wallet may only reorder accounts and set
 * at most one SetComputeUnitLimit (at most 1,400,000) and one SetComputeUnitPrice, and the
 * priority fee they make, `ceil(limit × price / 1,000,000)`, may not exceed the reviewed price at
 * that limit plus the allowance. With no limit instruction the runtime's default applies: 200,000
 * units per non-budget instruction, capped at 1,400,000. Otherwise a short reason.
 */
export function sameMeaning(original: MessageBytes, returned: MessageBytes,
  fee: { reviewedMicroLamports: bigint; feeAllowanceLamports: bigint }): string | null {
  let a: ReturnType<typeof resolve>, b: ReturnType<typeof resolve>;
  try { a = resolve(original); b = resolve(returned); } catch (error) { return (error as Error).message; }
  if (a.feePayer !== b.feePayer) return "fee payer";
  if (a.lifetime !== b.lifetime) return "lifetime";
  if (a.signers !== b.signers || a.roles.join() !== b.roles.join()) return "accounts or their roles";
  const budget = b.instructions.filter((ix) => ix.program === COMPUTE_BUDGET_PROGRAM);
  let limit: bigint | null = null;
  let price: bigint | null = null;
  for (const ix of budget) {
    const kind = ix.data.slice(0, 2);
    // SetComputeUnitLimit (2, u32) or SetComputeUnitPrice (3, u64), no accounts, once each.
    if (ix.accounts.length) return "compute budget";
    if (kind === "02" && ix.data.length === 10 && limit === null) limit = leHex(ix.data.slice(2));
    else if (kind === "03" && ix.data.length === 18 && price === null) price = leHex(ix.data.slice(2));
    else return "compute budget";
  }
  const rest = (list: Resolved[]) => list.filter((ix) => ix.program !== COMPUTE_BUDGET_PROGRAM).map((ix) => JSON.stringify(ix));
  const ra = rest(a.instructions), rb = rest(b.instructions);
  if (ra.length !== rb.length || ra.some((ix, i) => ix !== rb[i])) return "instructions";
  const defaultLimit = DEFAULT_UNITS_PER_INSTRUCTION * BigInt(rb.length);
  const units = limit ?? (defaultLimit > MAX_TRANSACTION_UNITS ? MAX_TRANSACTION_UNITS : defaultLimit);
  if (units > MAX_TRANSACTION_UNITS) return "compute unit limit";
  if (priorityFee(units, price ?? 0n) >priorityFee(units, fee.reviewedMicroLamports) + fee.feeAllowanceLamports) return "priority fee over the allowance";
  return null;
}
