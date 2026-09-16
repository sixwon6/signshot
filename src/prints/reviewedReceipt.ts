/**
 * Did the transaction that landed say what the user approved? A wallet can add or rewrite
 * instructions while the resulting account still looks right, so the confirmed transaction is
 * fetched and compared with the reviewed fingerprint.
 */
import { request } from "../../publications/rpc";
import {
  reviewedFingerprint,
  verifiedTransferReceipt,
} from "../../publications/core/transferReceipt";
import { HEX32 } from "../../publications/core/protocol";
import type { PublicationAttempt } from "../../publications/types";

/** A saved attempt plus the fingerprint of the message the user reviewed. */
export type ReviewedAttempt = PublicationAttempt & { quoteId: string };

/**
 * `matched` and `unchecked` both mean carry on; only `mismatched` is said out loud. The
 * transaction is already confirmed, so an endpoint that cannot answer must not strand it.
 */
export type ReviewedReceipt = "matched" | "unchecked" | "mismatched";

/** The fingerprint to record before the wallet opens, so a saved attempt can be checked later. */
export function reviewedQuoteId(messageBytes: ArrayLike<number>): string {
  return reviewedFingerprint(new Uint8Array(messageBytes));
}

/** Fetch the confirmed transaction and compare it with the reviewed message. */
export async function checkReviewedReceipt(
  endpoint: string,
  signature: string | undefined,
  quoteId: string | undefined,
): Promise<ReviewedReceipt> {
  if (!signature || !quoteId || !HEX32.test(quoteId)) return "unchecked";
  let result: unknown;
  try {
    result = await request<unknown>(endpoint, "getTransaction", [
      signature,
      { commitment: "confirmed", encoding: "base64", maxSupportedTransactionVersion: 0 },
    ]);
  } catch {
    // An endpoint that cannot answer says nothing about the transaction.
    return "unchecked";
  }
  if (result === null || result === undefined) return "unchecked";
  return verifiedTransferReceipt(result, signature, quoteId) ? "matched" : "mismatched";
}
