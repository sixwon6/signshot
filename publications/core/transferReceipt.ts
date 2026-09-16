/**
 * Positive transfer receipt recovery; an absent or unsupported response never proves failure.
 * A receipt matches the saved attempt only if its message equals the reviewed one after removing
 * `SetComputeUnitPrice` and canonicalizing account order (wallets such as Seed Vault rewrite the
 * price and reorder accounts), its priority fee stays within the reviewed allowance, and its
 * first signature verifies over the message with the fee payer's key.
 */
import {
  address,
  getAddressComparator,
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  signature,
} from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hash } from "./protocol";
import { COMPUTE_UNIT_PRICE, FEE_ALLOWANCE_LAMPORTS, request } from "../rpc";

const TRANSFER_HISTORY_LIMIT = 20;
const TRANSFER_RECEIPT_LIMIT = 8;

/** The Compute Budget program, whose own instructions a signing wallet may rewrite. */
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
/** `SetComputeUnitLimit` (2), a `u32`: inside the fingerprint, so the multiplier is fixed. */
const SET_COMPUTE_UNIT_LIMIT = 2;
/** `SetComputeUnitPrice` (3), a `u64` of microlamports: removed, then bounded by its fee. */
const SET_COMPUTE_UNIT_PRICE = 3;
/**
 * The runtime's own default when no `SetComputeUnitLimit` is present: 200,000 CU per
 * instruction, capped at 1,400,000 CU per transaction. Only reachable for a message that never
 * carried a limit, since one that did carries it into the fingerprint.
 * https://solana.com/docs/core/fees/compute-budget
 */
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000n;
const MAX_TRANSACTION_UNITS = 1_400_000n;

interface TransferReceiptQuery {
  asset: string;
  quoteId: string;
  signature?: string;
}
type TransferReceipt =
  | { status: "confirmed"; signature: string; slot: number }
  | { status: "unknown"; reason: string };

const UNKNOWN = "The earlier transfer outcome could not be confirmed from this connection's transaction history.";
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Signatures are compared as bytes; two different base58 spellings cannot look equal. */
const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a.length === b.length && Array.from(a).every((byte, index) => byte === b[index]);

/** Kit hands back read-only views; only the indices and the length are read here. */
type Bytes = { readonly length: number; readonly [index: number]: number };
type CompiledInstruction = {
  readonly programAddressIndex: number;
  readonly accountIndices?: readonly number[];
  readonly data?: Bytes;
};

/** A compute-budget instruction of `kind` that carries no accounts, as the program's own do. */
const isBudget = (
  instruction: CompiledInstruction,
  budget: number,
  kind: number,
  length: number,
) =>
  instruction.programAddressIndex === budget && !instruction.accountIndices?.length &&
  instruction.data?.length === length && instruction.data[0] === kind;

/** A little-endian unsigned integer out of instruction data. */
const leUint = (data: Bytes, at: number, count: number) => {
  let value = 0n;
  for (let i = count - 1; i >= 0; i--) value = (value << 8n) | BigInt(data[at + i]);
  return value;
};

/**
 * The compute-unit limit and price a compiled message asks for. Absent means the runtime's own
 * default (limit) or no prioritization at all (price). Duplicates take the LARGEST value: the
 * runtime refuses such a transaction outright, and reading the expensive one fails closed.
 */
function computeBudget(decoded: {
  staticAccounts: readonly string[];
  instructions: readonly CompiledInstruction[];
}): { limit: bigint; price: bigint } {
  const budget = (decoded.staticAccounts as readonly string[]).indexOf(COMPUTE_BUDGET_PROGRAM);
  let limit: bigint | undefined;
  let price = 0n;
  for (const instruction of decoded.instructions) {
    if (isBudget(instruction, budget, SET_COMPUTE_UNIT_LIMIT, 5)) {
      const value = leUint(instruction.data!, 1, 4);
      if (limit === undefined || value > limit) limit = value;
    } else if (isBudget(instruction, budget, SET_COMPUTE_UNIT_PRICE, 9)) {
      const value = leUint(instruction.data!, 1, 8);
      if (value > price) price = value;
    }
  }
  const fallback = DEFAULT_UNITS_PER_INSTRUCTION * BigInt(decoded.instructions.length);
  return {
    limit: limit ?? (fallback > MAX_TRANSACTION_UNITS ? MAX_TRANSACTION_UNITS : fallback),
    price,
  };
}

/** The prioritization fee in lamports: `ceil(price × limit / 1_000_000)`. */
const priorityFee = ({ limit, price }: { limit: bigint; price: bigint }) =>
  (price * limit + 999_999n) / 1_000_000n;

/**
 * Is the priority fee at most the reviewed price at the message's (fingerprint-bound) limit, plus
 * the `FEE_ALLOWANCE_LAMPORTS` already shown in the estimate?
 */
function withinReviewedFee(messageBytes: Uint8Array): boolean {
  const decoded = getCompiledTransactionMessageDecoder().decode(messageBytes);
  if (decoded.version !== 0 && decoded.version !== "legacy") return false;
  const budget = computeBudget(decoded);
  const reviewed = priorityFee({ limit: budget.limit, price: COMPUTE_UNIT_PRICE });
  return priorityFee(budget) <= reviewed + FEE_ALLOWANCE_LAMPORTS;
}

/**
 * A message's reviewed content: without `SetComputeUnitPrice` (bounded by `withinReviewedFee`),
 * blockhash included. Removal is safe because the runtime rejects duplicate compute-budget
 * instructions and only successful receipts are accepted.
 */
function reviewedMessageBytes(messageBytes: Uint8Array): Uint8Array {
  const decoded = getCompiledTransactionMessageDecoder().decode(messageBytes);
  // Kit also decodes the config-mask message version, which has no instruction list at all.
  // Nothing this app reviews or accepts is one, so it is refused rather than fingerprinted.
  if (decoded.version !== 0 && decoded.version !== "legacy")
    throw new Error("Unsupported Solana transaction message version.");
  const budget = decoded.staticAccounts.indexOf(address(COMPUTE_BUDGET_PROGRAM));
  const instructions = decoded.instructions.filter(
    (instruction) => !isBudget(instruction, budget, SET_COMPUTE_UNIT_PRICE, 9));
  // Seed Vault recompiles accounts in encounter order; Kit sorts them. Canonicalize only
  // within identical signer/writable roles, retaining the fee payer at index zero. Remap
  // every instruction reference; lookup-table indices and lookup order stay unchanged.
  const { numSignerAccounts: signers, numReadonlySignerAccounts: readonlySigners,
    numReadonlyNonSignerAccounts: readonlyOthers } = decoded.header;
  const count = decoded.staticAccounts.length;
  if (signers < 1 || readonlySigners >= signers || signers > count ||
    readonlyOthers > count - signers || new Set(decoded.staticAccounts).size !== count)
    throw new Error("Invalid Solana account roles.");
  const boundaries = [0, 1, signers - readonlySigners, signers, count - readonlyOthers, count];
  const order: number[] = [];
  const compare = getAddressComparator();
  for (let i = 1; i < boundaries.length; i++) {
    const group = Array.from({ length: boundaries[i] - boundaries[i - 1] }, (_, j) => boundaries[i - 1] + j);
    group.sort((a, b) => compare(decoded.staticAccounts[a], decoded.staticAccounts[b]));
    order.push(...group);
  }
  const remap = new Map(order.map((old, index) => [old, index]));
  return new Uint8Array(getCompiledTransactionMessageEncoder().encode({
    ...decoded,
    staticAccounts: order.map(index => decoded.staticAccounts[index]),
    instructions: instructions.map(instruction => ({
      ...instruction,
      programAddressIndex: remap.get(instruction.programAddressIndex) ?? instruction.programAddressIndex,
      ...(instruction.accountIndices ? { accountIndices: instruction.accountIndices.map(index => remap.get(index) ?? index) } : {}),
    })),
  }));
}

/** The stored `quoteId`: a hash of reviewed content, stable across a wallet's fee rewrite. */
export const reviewedFingerprint = (messageBytes: Uint8Array): string =>
  hash(reviewedMessageBytes(messageBytes));

/** Does this message match the saved `quoteId` at a tolerated fee? */
export function matchesReviewedMessage(message: Uint8Array, quoteId: string): boolean {
  try {
    return reviewedFingerprint(message) === quoteId && withinReviewedFee(message);
  } catch {
    return false;
  }
}

/** Strict decoder for a getTransaction response requested at confirmed commitment. */
export function verifiedTransferReceipt(
  result: unknown,
  expectedSignature: string,
  quoteId: string,
  expectedSlot?: number,
): TransferReceipt | null {
  try {
    signature(expectedSignature);
    if (!/^[a-f0-9]{64}$/.test(quoteId) || !object(result) ||
      !Number.isSafeInteger(result.slot) || Number(result.slot) < 0 ||
      (expectedSlot !== undefined && result.slot !== expectedSlot) ||
      !object(result.meta) || result.meta.err !== null ||
      (result.version !== 0 && result.version !== "legacy") ||
      !Array.isArray(result.transaction) || result.transaction.length !== 2 ||
      result.transaction[1] !== "base64" || typeof result.transaction[0] !== "string") return null;
    const encoded = result.transaction[0];
    // A Solana wire transaction fits 1232 bytes. Reject oversized and noncanonical encodings
    // before allocating/decoding anything supplied by RPC.
    if (encoded.length > 1644 || encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
    const bytes = getBase64Encoder().encode(encoded);
    if (bytes.length > 1232 || getBase64Decoder().decode(bytes) !== encoded) return null;
    const transaction = getTransactionDecoder().decode(bytes);
    const message = new Uint8Array(transaction.messageBytes);
    const version = message[0] & 0x80 ? message[0] & 0x7f : "legacy";
    // The fee payer signs first, and its key is the message's own first static account, so
    // both halves of the check come out of the bytes RPC supplied rather than from its claims.
    const [feePayer] = Object.keys(transaction.signatures);
    const firstSignature = Object.values(transaction.signatures)[0];
    const expected = getBase58Encoder().encode(expectedSignature);
    if (version !== result.version || !feePayer || !firstSignature ||
      firstSignature.length !== 64 || expected.length !== 64 ||
      !sameBytes(firstSignature, expected) ||
      // Comparing the signature to the one we asked about says only that RPC echoed it back.
      // Verifying it over the message bytes with the fee payer's key is what makes a returned
      // body evidence of a real transaction rather than an assembled one.
      !ed25519.verify(new Uint8Array(firstSignature), message,
        new Uint8Array(getBase58Encoder().encode(feePayer))) ||
      !matchesReviewedMessage(message, quoteId)) return null;
    return { status: "confirmed", signature: expectedSignature, slot: Number(result.slot) };
  } catch {
    return null;
  }
}

export async function recoverTransferReceipt(
  endpoint: string,
  attempt: TransferReceiptQuery,
): Promise<TransferReceipt> {
  address(attempt.asset);
  if (!/^[a-f0-9]{64}$/.test(attempt.quoteId)) throw new Error("Invalid saved transfer message fingerprint.");
  const fetchReceipt = async (value: string, slot?: number) => {
    try {
      signature(value);
      const result = await request<unknown>(endpoint, "getTransaction", [value, {
        commitment: "confirmed", encoding: "base64", maxSupportedTransactionVersion: 0,
      }]);
      return verifiedTransferReceipt(result, value, attempt.quoteId, slot);
    } catch {
      return null;
    }
  };
  // A returned wallet receipt gets first priority, but is subject to the same reviewed-message
  // check as a recovered one. Signature status alone cannot establish which review it signed.
  if (attempt.signature) {
    const receipt = await fetchReceipt(attempt.signature);
    if (receipt) return receipt;
  }
  let history: unknown;
  try {
    history = await request<unknown>(endpoint, "getSignaturesForAddress", [attempt.asset, {
      commitment: "confirmed", limit: TRANSFER_HISTORY_LIMIT,
    }]);
  } catch {
    return { status: "unknown", reason: UNKNOWN };
  }
  if (!Array.isArray(history)) return { status: "unknown", reason: UNKNOWN };
  const candidates: { signature: string; slot: number }[] = [];
  const seen = new Set(attempt.signature ? [attempt.signature] : []);
  for (const entry of history.slice(0, TRANSFER_HISTORY_LIMIT)) {
    if (!object(entry) || typeof entry.signature !== "string" || seen.has(entry.signature) ||
      !Number.isSafeInteger(entry.slot) || Number(entry.slot) < 0 || entry.err !== null ||
      (entry.confirmationStatus !== "confirmed" && entry.confirmationStatus !== "finalized")) continue;
    try { signature(entry.signature); } catch { continue; }
    seen.add(entry.signature);
    candidates.push({ signature: entry.signature, slot: Number(entry.slot) });
    if (candidates.length >= TRANSFER_RECEIPT_LIMIT - (attempt.signature ? 1 : 0)) break;
  }
  // Independent reads run together, so one slow/pruned history entry cannot serially delay all
  // others. Neither a search limit nor an RPC failure is ever converted into a failed transfer.
  const receipts = await Promise.all(candidates.map((entry) => fetchReceipt(entry.signature, entry.slot)));
  return receipts.find((receipt) => receipt !== null) ?? { status: "unknown", reason: UNKNOWN };
}
