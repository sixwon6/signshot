/**
 * Sending a published print (a Metaplex Core asset) to another wallet with one `TransferV1`.
 * Uses the photograph's publication lock from `coordinator.ts`, so a send and a publish can never
 * race for one wallet. The attempt is persisted before the wallet opens. Sending is not a sale.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { address, getBase58Decoder } from "@solana/kit";
import type { CaptureRecord } from "../../modules/seeker-camera";
import type { WalletSession } from "../solana/walletSession";
import { RPC_ENDPOINT, CLUSTER_NAME as cluster, assertEndpointCluster } from "../solana/cluster";
import { isSigned, type PublicationDraft } from "./creator";
import { publicationLockKey } from "./coordinator";
import { refreshedQuote } from "./quoteRefresh";
import { addresses, isFrozen, readPublication, readPrintState } from "../../publications/core/protocol";
import { recoverTransferReceipt, reviewedFingerprint } from "../../publications/core/transferReceipt";
import {
  inspectTransfer,
  transferInstructions,
  type TransferDetails,
} from "../../publications/core/transfer";
import { isTrustedDeployment } from "../../publications/deployments";
import { CORE_PROTOCOL, type PublicationAttempt } from "../../publications/types";
import { assertAttempt, exclusive, operationInProgress } from "../../publications/lifecycle";
import { safeErrorText } from "../ui/errorText";
import {
  confirmTransaction,
  OPERATION_FLOOR_LAMPORTS,
  prepareTransaction,
  request,
} from "../../publications/rpc";

const lock = (r: CaptureRecord) => publicationLockKey(cluster, r.baseName);

/**
 * What the review screen shows and what `sendTransfer` re-checks. `asset` is print #1's Core
 * address; `collection` is needed by `TransferV1`. Core has no destination account to create.
 */
export interface TransferQuote extends TransferDetails {
  edition: string;
  metadataId: string;
  id: string;
  prepared: Awaited<ReturnType<typeof prepareTransaction>>;
}

/** The durable attempt, under `es.core-transfer.v1:${cluster}:${edition}`. */
interface TransferAttempt extends PublicationAttempt {
  version: 1;
  protocol: typeof CORE_PROTOCOL;
  owner: string;
  recipient: string;
  asset: string;
  /**
   * `reviewedFingerprint` of the compiled message, ignoring the compute-budget instructions a
   * wallet may rewrite. A recovered receipt must match it, so one review's receipt cannot prove
   * another's.
   */
  quoteId: string;
  confirmedAt?: number;
  /** Still-live earlier message IDs prevent an old receipt from proving a different attempt. */
  previousMessages?: { quoteId: string; lastValidBlockHeight: string }[];
}
type TransferEligibility = "review" | "wait" | "moved" | "burned" | "frozen" | "unavailable";
export interface TransferState {
  status: "none" | "pending" | "sent" | "unresolved" | "unavailable";
  attempt: TransferAttempt | null;
  /** A previous transaction outcome and permission to REVIEW a new send are separate facts. */
  eligibility?: TransferEligibility;
  reason?: string;
}
const MAX_PREVIOUS_MESSAGES = 64;

/** The durable key is per EDITION; the in-process lock is per PHOTOGRAPH. Both are needed. */
const key = (d: PublicationDraft) =>
  `es.core-transfer.v1:${d.edition.cluster}:${d.edition.edition}`;
export const isTransferWorking = (r: CaptureRecord) => operationInProgress(lock(r));

async function read(d: PublicationDraft): Promise<TransferAttempt | null> {
  const raw = await AsyncStorage.getItem(key(d));
  if (!raw) return null;
  const attempt = JSON.parse(raw) as TransferAttempt;
  assertAttempt(attempt);
  address(attempt.owner);
  address(attempt.recipient);
  const expectedAsset = (await addresses(d.edition.program, d.edition.creator, d.edition.nonce)).print;
  if (attempt.version !== 1 || attempt.protocol !== CORE_PROTOCOL ||
    attempt.asset !== expectedAsset || attempt.owner === attempt.recipient ||
    !/^[a-f0-9]{64}$/.test(attempt.quoteId) ||
    (attempt.confirmedAt !== undefined && (!Number.isSafeInteger(attempt.confirmedAt) || attempt.confirmedAt <= 0)) ||
    (attempt.previousMessages !== undefined && (!Array.isArray(attempt.previousMessages) ||
      attempt.previousMessages.length > MAX_PREVIOUS_MESSAGES || attempt.previousMessages.some(message =>
        !message || typeof message.quoteId !== "string" || !/^[a-f0-9]{64}$/.test(message.quoteId) ||
        typeof message.lastValidBlockHeight !== "string" || !/^\d+$/.test(message.lastValidBlockHeight)))))
    throw new Error("The saved transfer does not match this photograph. Do not send again until it can be checked.");
  return attempt;
}
async function write(d: PublicationDraft, attempt: TransferAttempt) {
  await AsyncStorage.setItem(key(d), JSON.stringify(attempt));
}

/** Forget this edition's transfer attempt. Called from the photo deletion path only. */
export async function forgetTransferAttempt(d: PublicationDraft) {
  await AsyncStorage.removeItem(key(d));
}

const sameAttempt = (left: TransferAttempt | null, right: TransferAttempt) =>
  left !== null && left.quoteId === right.quoteId && left.signature === right.signature &&
  left.owner === right.owner && left.recipient === right.recipient && left.asset === right.asset &&
  left.lastValidBlockHeight === right.lastValidBlockHeight && left.confirmedAt === right.confirmedAt &&
  JSON.stringify(left.previousMessages) === JSON.stringify(right.previousMessages);

/**
 * Current on-chain state, read as `inspectTransfer` reads it. `delivered` means the asset is now
 * owned by this attempt's recipient; it says nothing about which transaction moved it.
 */
async function eligibility(d: PublicationDraft, attempt: TransferAttempt): Promise<{
  eligibility: TransferEligibility; reason?: string; delivered?: boolean;
}> {
  try {
    // Neither check requires print #1 to be live; asset availability is checked afterwards.
    if (!await isSigned(d)) throw new Error("The photo's publication could not be verified.");
    const publication = await readPublication(RPC_ENDPOINT, d.edition.program, d.edition.edition);
    if (!publication) throw new Error("The photo's publication could not be verified.");
    const current = await readPrintState(RPC_ENDPOINT, publication);
    if (current.status === "unavailable") return { eligibility: "unavailable", reason: current.reason };
    if (current.status === "burned") return { eligibility: "burned", reason: "This digital print has been burned and cannot be sent." };
    if (current.asset.owner !== attempt.owner)
      return { eligibility: "moved", delivered: current.asset.owner === attempt.recipient,
        reason: "The sending wallet no longer owns this digital print." };
    if (isFrozen(current.asset))
      return { eligibility: "frozen", reason: "This digital print is frozen and cannot be sent until the freeze is removed." };
    return { eligibility: "review" };
  } catch (error) {
    return { eligibility: "unavailable", reason: safeErrorText(error) };
  }
}

export async function getTransferState(
  r: CaptureRecord,
  d: PublicationDraft,
): Promise<TransferState> {
  let attempt: TransferAttempt | null = null;
  try {
    attempt = await read(d);
    if (!attempt) return { status: "none", attempt, eligibility: "review" };
    if (d.edition.cluster !== cluster || !isTrustedDeployment(cluster, d.edition.program))
      throw new Error("This photo's edition names a publication program this build has not reviewed.");
    const receipt = await recoverTransferReceipt(RPC_ENDPOINT, attempt);
    let result: TransferState;
    if (receipt.status === "confirmed") {
      const { delivered: _delivered, ...outcome } = await eligibility(d, attempt);
      result = { status: "sent", attempt: { ...attempt, signature: receipt.signature,
        confirmedAt: attempt.confirmedAt ?? Date.now() }, ...outcome };
    } else {
      const { delivered, ...outcome } = await eligibility(d, attempt);
      if (delivered) {
        // The recipient holds the print, so it arrived even without a matched receipt.
        // `confirmedAt` stays unset so a later matched receipt can still record itself.
        result = { status: "sent", attempt, eligibility: outcome.eligibility,
          reason: attempt.signature
            ? "This copy is now held by the wallet it was sent to. The transaction the wallet reported could not be matched on this connection."
            : "This copy is now held by the wallet it was sent to. The transaction that moved it could not be found on this connection." };
      } else if (attempt.confirmedAt) {
        result = { status: "unavailable", attempt, eligibility: "unavailable",
          reason: "The previously confirmed transfer is not visible on this connection." };
      } else {
        const height = await request<number>(RPC_ENDPOINT, "getBlockHeight", [{ commitment: "finalized" }]);
        if (!Number.isSafeInteger(height) || height < 0) throw new Error("Invalid Solana block height.");
        // Expiry proves only that this message cannot land later, not that it never landed, so
        // a finalized +32-block margin applies before any fresh review.
        result = BigInt(height) <= BigInt(attempt.lastValidBlockHeight) + 32n
          ? { status: "pending", attempt, eligibility: "wait", reason: "A transfer may still land. Check its status before sending again." }
          : { status: "unresolved", attempt, reason: receipt.reason, ...outcome };
      }
    }
    // Anything written while checking is newer than this answer.
    const latestAttempt = await read(d);
    if (!sameAttempt(latestAttempt, attempt))
      return { status: "unavailable", attempt: latestAttempt, eligibility: "unavailable",
        reason: "The transfer changed while its status was being checked. Check again before another action." };
    if (result.status === "sent") {
      // Skipped while the lock is held, so a status read never queues behind or overwrites live work.
      if (!operationInProgress(lock(r))) {
        const checkedAttempt = attempt;
        await exclusive(lock(r), async () => {
          const latest = await read(d);
          if (!sameAttempt(latest, checkedAttempt)) {
            result = { status: "unavailable", attempt: latest, eligibility: "unavailable",
              reason: "The transfer changed while its status was being checked. Check again before another action." };
          } else {
            result.attempt = { ...latest!, signature: result.attempt!.signature,
              confirmedAt: latest!.confirmedAt ?? result.attempt!.confirmedAt };
            await write(d, result.attempt!);
          }
        });
      }
    }
    return result;
  } catch (error) {
    return { status: "unavailable", attempt, eligibility: "unavailable", reason: safeErrorText(error) };
  }
}

function assertNewReview(state: TransferState) {
  if (state.eligibility !== "review")
    throw new Error(state.reason ?? "Check this digital print's current state before reviewing another transfer.");
}

/** Is `quoteId` this attempt's reviewed message, or one of its still-recorded earlier ones? */
function wasReviewed(attempt: TransferAttempt | null, quoteId: string) {
  return attempt?.quoteId === quoteId ||
    Boolean(attempt?.previousMessages?.some(message => message.quoteId === quoteId));
}

export async function prepareTransfer(
  r: CaptureRecord,
  d: PublicationDraft,
  recipient: string,
  owner: string,
): Promise<TransferQuote> {
  // The estimate and receipt must be read from the chain the wallet will broadcast to.
  await assertEndpointCluster();
  // Checked against the trusted list, not the currently configured deployment.
  if (!isTrustedDeployment(cluster, d.edition.program))
    throw new Error("This photo's edition names a publication program this build has not reviewed.");
  if (operationInProgress(lock(r)))
    throw new Error("This photo already has an operation in progress. Wait for it to finish.");
  if (!await isSigned(d)) throw new Error("Publish the photograph before sending its digital print.");
  const state = await getTransferState(r, d);
  assertNewReview(state);
  const details = await inspectTransfer(RPC_ENDPOINT, d.edition, d.metadataId, recipient, owner);
  const prepared = await prepareTransaction(RPC_ENDPOINT, owner, transferInstructions(details), [],
    OPERATION_FLOOR_LAMPORTS.transfer);
  const messageBytes = new Uint8Array(prepared.transaction.messageBytes);
  const id = reviewedFingerprint(messageBytes);
  if (wasReviewed(state.attempt, id))
    throw new Error("This estimate repeats an earlier transfer message. Wait for a new estimate and review again.");
  return { ...details, prepared, edition: d.edition.edition, metadataId: d.metadataId, id };
}

const EXPIRED = "The estimate expired. Review the transfer again.";

/**
 * The reviewed transfer on a fresh blockhash (see `refreshedQuote`), rebuilt from the quote's own
 * fields. A changed message gets a new ID, so the old one is kept in `previousMessages`; if there
 * is no room for it, the refresh is refused rather than evicting a live ID.
 */
async function refreshed(
  quote: TransferQuote,
  previousMessages: { quoteId: string; lastValidBlockHeight: string }[],
): Promise<{ prepared: TransferQuote["prepared"]; quoteId: string }> {
  const next = await refreshedQuote(RPC_ENDPOINT, quote.owner, transferInstructions({
    owner: quote.owner, recipient: quote.recipient, asset: quote.asset, collection: quote.collection,
  }), quote.prepared, EXPIRED);
  const quoteId = reviewedFingerprint(new Uint8Array(next.transaction.messageBytes));
  // Same fingerprint: the blockhash did not move, so there is nothing to record.
  if (quoteId === quote.id) return { prepared: next, quoteId };
  if (previousMessages.length + 1 > MAX_PREVIOUS_MESSAGES ||
    previousMessages.some(message => message.quoteId === quoteId)) throw new Error(EXPIRED);
  previousMessages.push({ quoteId: quote.id,
    lastValidBlockHeight: String(quote.prepared.lastValidBlockHeight) });
  return { prepared: next, quoteId };
}

export async function sendTransfer(
  r: CaptureRecord, d: PublicationDraft, session: WalletSession, quote: TransferQuote,
  onProgress?: (stage: "wallet" | "confirming") => void,
): Promise<string> {
  return exclusive(lock(r), async () => {
    const reviewedBytes = new Uint8Array(quote.prepared.transaction.messageBytes);
    if (quote.edition !== d.edition.edition || quote.metadataId !== d.metadataId ||
      quote.id !== reviewedFingerprint(reviewedBytes))
      throw new Error("The transfer review changed. Check the recipient again.");
    if (!isTrustedDeployment(cluster, d.edition.program) || !await isSigned(d))
      throw new Error("This publication cannot be confirmed on the selected network.");
    const state = await getTransferState(r, d);
    if (wasReviewed(state.attempt, quote.id))
      throw new Error("This transfer has already been submitted. Check its status.");
    assertNewReview(state);
    // Keep every still-live prior message ID, and resolve capacity before opening a wallet.
    const finalizedHeight = await request<number>(RPC_ENDPOINT, "getBlockHeight", [{ commitment: "finalized" }]);
    if (!Number.isSafeInteger(finalizedHeight) || finalizedHeight < 0) throw new Error("Invalid Solana block height.");
    const previousMessages = (state.attempt
      ? [...(state.attempt.previousMessages ?? []), { quoteId: state.attempt.quoteId,
        lastValidBlockHeight: state.attempt.lastValidBlockHeight }]
      : []).filter(message => BigInt(finalizedHeight) <= BigInt(message.lastValidBlockHeight) + 32n);
    if (previousMessages.length > MAX_PREVIOUS_MESSAGES)
      throw new Error("Earlier transfer messages are still live. Wait before reviewing another transfer.");
    // Re-read ownership and the asset right before the wallet opens.
    const live = await inspectTransfer(RPC_ENDPOINT, d.edition, d.metadataId, quote.recipient, quote.owner);
    if (live.owner !== quote.owner || live.recipient !== quote.recipient ||
      live.asset !== quote.asset || live.collection !== quote.collection)
      throw new Error("NFT ownership changed. Refresh the transfer review.");
    let attempt: TransferAttempt | undefined;
    onProgress?.("wallet");
    await session.connectAnd(async wallet => {
      const selected = await session.authorizeSession(wallet);
      if (selected.address !== quote.owner) throw new Error("Use the wallet shown in the transfer review.");
      // Refreshed on every approval: the wallet's sheet can outlast a blockhash.
      const { prepared, quoteId } = await refreshed(quote, previousMessages);
      attempt = { version: 1, protocol: CORE_PROTOCOL, owner: quote.owner, recipient: quote.recipient,
        asset: quote.asset, quoteId,
        lastValidBlockHeight: String(prepared.lastValidBlockHeight), previousMessages };
      await write(d, attempt);
      const signatures = await wallet.signAndSendTransactions({ transactions: [prepared.transaction],
        minContextSlot: Number(prepared.minContextSlot), skipPreflight: false });
      if (signatures.length !== 1 || signatures[0].length !== 64) throw new Error("No wallet receipt. Check the transfer before retrying.");
      attempt.signature = getBase58Decoder().decode(signatures[0]);
      await write(d, attempt);
    });
    if (!attempt?.signature) throw new Error("No wallet receipt. Check the transfer before retrying.");
    onProgress?.("confirming");
    try {
      await confirmTransaction(RPC_ENDPOINT, attempt.signature, BigInt(attempt.lastValidBlockHeight));
    } catch {
      // A confirmation polling error can still leave a usable exact receipt in history.
    }
    const receipt = await recoverTransferReceipt(RPC_ENDPOINT, attempt);
    if (receipt.status !== "confirmed")
      throw new Error("The transfer receipt could not be matched to this review. Check its status before another action.");
    attempt.signature = receipt.signature;
    attempt.confirmedAt = Date.now();
    await write(d, attempt);
    return attempt.signature;
  });
}
