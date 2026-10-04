/**
 * Sending a copy (a Metaplex Core asset) to another wallet with one `TransferV1`: copy 1 from its
 * photograph's page, or any copy the connected wallet holds from the Wallet screen. Through the
 * shared send path; the chain (the copy's owner) is the only record of where it is.
 */

import type { Address } from "@solana/kit";
import type { CaptureRecord } from "../../modules/seeker-camera";
import type { WalletSession } from "../solana/walletSession";
import { RPC_ENDPOINT, CLUSTER_NAME as cluster, assertEndpointCluster } from "../solana/cluster";
import type { PublicationDraft } from "./creator";
import { publicationLockKey } from "./coordinator";
import type { LibraryPhoto } from "../../publications/core/library";
import { transferInstruction, validateRecipient } from "../../publications/core/transfer";
import { fetchAccount, readHeldCopy } from "../../publications/editions";
import { SIGNATURE_FEE } from "../../publications/candy/edition";
import { SYSTEM_PROGRAM } from "../../publications/candy/programs";
import type { Budget, Draft } from "../../publications/candy/transactions";
import { FEE_ALLOWANCE_LAMPORTS } from "../../publications/rpc";
import type { CoreMetadata } from "../../publications/types";
import { safeErrorText } from "../ui/errorText";
import { exclusive, operationInProgress } from "./locks";
import type { Estimate } from "./price";
import { latestLifetime, prepareDraft, priorityLamports, seedAddress, sendAndConfirm, signWithWallet, withLifetime } from "./send";

/** The copy a send moves. */
export interface TransferTarget {
  edition: CoreMetadata;
  metadataId: string;
  number: number;
  /** The copy's Core address. */
  asset: string;
  photo?: { record: CaptureRecord; draft: PublicationDraft };
  /** The wallet the Wallet screen found holding it. */
  holder?: string;
}

/** Copy 1, sent from its photograph's page. */
export const photoTransfer = (record: CaptureRecord, draft: PublicationDraft): TransferTarget =>
  ({ edition: draft.edition, metadataId: draft.metadataId, number: 1, asset: seedAddress(draft.seeds.copy), photo: { record, draft } });

/** A Wallet screen copy as a send target, or null unless `wallet` holds it. */
export function heldCopy(item: LibraryPhoto, wallet: string | undefined): TransferTarget | null {
  if (!wallet || item.owner !== wallet || item.number === undefined) return null;
  return { edition: item.photo.edition, metadataId: item.photo.metadataId, number: item.number, asset: item.id, holder: wallet };
}

const photoLock = (r: CaptureRecord) => publicationLockKey(cluster, r.baseName);
const copyLock = (t: TransferTarget) => `transfer:${cluster}:${t.asset}`;
export const isTransferWorking = (r: CaptureRecord) => operationInProgress(photoLock(r));
const holding = <T>(t: TransferTarget, work: () => Promise<T>) =>
  t.photo ? exclusive(photoLock(t.photo.record), () => exclusive(copyLock(t), work)) : exclusive(copyLock(t), work);

/** Nothing is kept on disk any more; kept for the photo deletion path. */
export async function forgetTransferAttempt(_d: PublicationDraft) {}

/** Sends confirmed in this app session, so the sheet can say where the copy went. */
const sent = new Map<string, { recipient: string; signature: string }>();

type TransferEligibility = "review" | "wait" | "moved" | "burned" | "frozen" | "unavailable";
export interface TransferState {
  status: "none" | "pending" | "sent" | "unresolved" | "unavailable";
  attempt: { recipient: string; signature?: string } | null;
  eligibility?: TransferEligibility;
  reason?: string;
}

/** Where the copy is now, read off the chain. */
export async function getTransferState(t: TransferTarget): Promise<TransferState> {
  try {
    const copy = await readHeldCopy(RPC_ENDPOINT, t.asset, t.edition.collection as Address);
    const record = sent.get(t.asset) ?? null;
    if (!copy) return { status: "none", attempt: null, eligibility: "burned", reason: "This copy is not on chain (burned or not yet published)." };
    if (record && copy.owner === record.recipient) return { status: "sent", attempt: record, eligibility: "moved" };
    const holder = t.holder ?? t.edition.creator;
    if (copy.owner !== holder) return { status: "none", attempt: null, eligibility: "moved", reason: "This wallet no longer holds this copy." };
    return { status: "none", attempt: null, eligibility: "review" };
  } catch (error) {
    return { status: "unavailable", attempt: null, eligibility: "unavailable", reason: safeErrorText(error) };
  }
}

export interface TransferQuote {
  owner: Address;
  recipient: Address;
  asset: string;
  collection: string;
  draft: Draft;
  budgets: Budget[];
  prepared: Estimate;
}

/** Check the copy, the owner and the recipient, and simulate the transfer. Nothing is signed. */
export async function prepareTransfer(t: TransferTarget, input: string, owner: string): Promise<TransferQuote> {
  await assertEndpointCluster();
  const recipient = validateRecipient(input, owner);
  if (t.holder && owner !== t.holder) throw new Error("Use the wallet that holds this copy.");
  const [copy, recipientAccount] = await Promise.all([
    readHeldCopy(RPC_ENDPOINT, t.asset, t.edition.collection as Address),
    fetchAccount(RPC_ENDPOINT, recipient),
  ]);
  if (!copy) throw new Error("This copy is not available on this network.");
  if (copy.owner !== owner) throw new Error("This wallet does not hold this copy.");
  if (recipientAccount && (recipientAccount.owner !== SYSTEM_PROGRAM || recipientAccount.bytes.length))
    throw new Error("The recipient is not a personal wallet account. Check the address.");
  const draft: Draft = {
    feePayer: owner as Address,
    transactions: [{ instructions: [transferInstruction({ asset: t.asset, collection: t.edition.collection, owner, recipient })], localSigners: [] }],
  };
  const ready = await prepareDraft(draft);
  const networkFee = SIGNATURE_FEE + priorityLamports(ready.budgets);
  return {
    owner: owner as Address, recipient, asset: t.asset, collection: t.edition.collection, draft, budgets: ready.budgets,
    prepared: { estimatedLamports: networkFee + FEE_ALLOWANCE_LAMPORTS, estimateBreakdown: { networkFee, accountCost: networkFee, allowance: FEE_ALLOWANCE_LAMPORTS } },
  };
}

/** Sign, send, confirm. Returns the signature. */
export async function sendTransfer(
  t: TransferTarget, session: WalletSession, quote: TransferQuote,
  onProgress?: (stage: "wallet" | "confirming") => void,
): Promise<string> {
  return holding(t, async () => {
    if (quote.asset !== t.asset) throw new Error("The transfer review changed. Check the recipient again.");
    const lifetime = await latestLifetime();
    const ready = withLifetime(quote.draft, quote.budgets, lifetime);
    onProgress?.("wallet");
    const [tx] = (await signWithWallet(session, quote.owner, ready.prepared)).transactions;
    onProgress?.("confirming");
    const signature = await sendAndConfirm(tx, lifetime.lastValidBlockHeight);
    sent.set(t.asset, { recipient: quote.recipient, signature });
    return signature;
  });
}
