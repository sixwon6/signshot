/**
 * Refreshing a reviewed transaction's blockhash at approval time. The wallet's own approval sheet
 * can outlast a blockhash, so the transaction is re-prepared from the same instructions and
 * accepted only if it is byte-identical to the reviewed one apart from its lifetime.
 */

import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  type Instruction,
} from "@solana/kit";
import { prepareTransaction, request } from "../../publications/rpc";

/** Exactly what `prepareTransaction` returns: the reviewed quote, and the refreshed one. */
export type PreparedQuote = Awaited<ReturnType<typeof prepareTransaction>>;

/** Blocks of headroom a lifetime must still have to be worth a wallet prompt. */
const GUARD_BLOCKS = 10n;

/** Appended to the caller's refusal when the refreshed transaction is not the reviewed one. */
const CHANGED_QUOTE = "The cost or contents changed since your review.";

/**
 * The reviewed quote cannot be handed to the wallet. `changed` tells a re-prepare that came back
 * different (cost, rent or simulation) from a lifetime that simply ran out; the message is the
 * caller's own refusal, with the changed clause appended. Classified by type, never by text.
 */
export class ExpiredQuoteError extends Error {
  readonly changed: boolean;
  constructor(expired: string, changed: boolean) {
    super(changed ? `${expired} ${CHANGED_QUOTE}` : expired);
    this.name = "ExpiredQuoteError";
    this.changed = changed;
  }
}

const messages = getCompiledTransactionMessageDecoder();
const messageBytes = getCompiledTransactionMessageEncoder();

/**
 * The compiled message with another blockhash written into it. Decode-then-encode is
 * byte-identical for an untouched message, so only the lifetime changes.
 */
function withLifetime(
  bytes: PreparedQuote["transaction"]["messageBytes"],
  lifetimeToken: string,
): Uint8Array {
  const message = messages.decode(bytes);
  return new Uint8Array(messageBytes.encode({ ...message, lifetimeToken }));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Is `fresh` the reviewed transaction with nothing changed but its lifetime? */
function sameReviewedTransaction(reviewed: PreparedQuote, fresh: PreparedQuote): boolean {
  // The number beside the approve button is part of what was reviewed.
  if (reviewed.estimatedLamports !== fresh.estimatedLamports) return false;
  const reviewedToken = messages.decode(reviewed.transaction.messageBytes).lifetimeToken;
  return sameBytes(
    withLifetime(reviewed.transaction.messageBytes, reviewedToken),
    withLifetime(fresh.transaction.messageBytes, reviewedToken),
  );
}

/**
 * The transaction to hand the wallet: the reviewed one, on a lifetime that has not run out.
 *
 * Call it immediately before `signAndSendTransactions` and persist the returned
 * `lastValidBlockHeight`: an attempt saved with the reviewed height could be judged retryable
 * while the signed transaction can still land. `expired` is the caller's own refusal message.
 */
export async function refreshedQuote(
  endpoint: string,
  payer: string,
  instructions: readonly Instruction[],
  reviewed: PreparedQuote,
  expired: string,
): Promise<PreparedQuote> {
  // A full re-prepare (not a blockhash swap) re-simulates and re-prices, so a changed cost or a
  // failing simulation surfaces here. Insufficient-funds errors pass through unwrapped.
  const fresh = await prepareTransaction(endpoint, payer, [...instructions], [],
    reviewed.estimateBreakdown.floor);
  if (!sameReviewedTransaction(reviewed, fresh)) throw new ExpiredQuoteError(expired, true);
  const height = await request<number>(endpoint, "getBlockHeight", [
    { commitment: "confirmed" },
  ]);
  if (BigInt(height) + GUARD_BLOCKS >= fresh.lastValidBlockHeight)
    throw new ExpiredQuoteError(expired, false);
  return fresh;
}
