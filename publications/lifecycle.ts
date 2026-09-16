import { describeProgramError, request, type PublicationOperation } from "./rpc";
import type { PublicationAttempt } from "./types";

export type TransactionAttempt = PublicationAttempt;

export function assertAttempt(attempt: TransactionAttempt) {
  if (!/^\d+$/.test(attempt.lastValidBlockHeight))
    throw new Error("Saved transaction lifetime is invalid. Do not retry this transaction.");
  if (attempt.signature && !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(attempt.signature))
    throw new Error("Saved wallet receipt is invalid. Do not retry this transaction.");
}

/**
 * Where a saved attempt stands. Anything but `retryable` means do not offer it again.
 * `operation` disambiguates `ExistingAsset`; without it the terminal reading is taken.
 */
export async function checkAttempt(
  endpoint: string,
  attempt: TransactionAttempt,
  options: { operation?: PublicationOperation } = {},
): Promise<"confirmed" | "pending" | "retryable" | "terminal"> {
  assertAttempt(attempt);
  if (attempt.signature) {
    const statuses = await request<{
      value: ({ err: unknown; confirmationStatus: string } | null)[];
    }>(endpoint, "getSignatureStatuses", [[attempt.signature], { searchTransactionHistory: true }]);
    const status = statuses.value[0];
    // A processed transaction can still be dropped. Only confirmed/finalized failure
    // is a safe retry signal; a lost RPC response is never one.
    if (status && ["confirmed", "finalized"].includes(status.confirmationStatus)) {
      if (!status.err) return "confirmed";
      // `describeProgramError` is the single mapping: known codes are terminal, unknown ones retry.
      return describeProgramError(status.err, null, options).retryable ? "retryable" : "terminal";
    }
  }
  const height = await request<number>(endpoint, "getBlockHeight", [{ commitment: "finalized" }]);
  if (!Number.isSafeInteger(height) || height < 0) throw new Error("Invalid Solana block height.");
  return BigInt(height) > BigInt(attempt.lastValidBlockHeight) + 32n ? "retryable" : "pending";
}

/** One operation per photo/asset. A second tap cannot race a durable pending write. */
const running = new Set<string>();
export const operationInProgress = (key: string) => running.has(key);
export async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  if (running.has(key)) throw new Error("This photo already has an operation in progress.");
  running.add(key);
  try { return await work(); } finally { running.delete(key); }
}
