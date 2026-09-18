/**
 * Pricing a published edition: the creator sets, changes or removes what a copy costs, with one
 * `set_offer` instruction and one wallet approval.
 *
 * WHY THIS IS KEYED BY EDITION AND NOT BY PHOTOGRAPH. `creator.ts` is keyed by `CaptureRecord`,
 * because a draft belongs to a photograph on this phone. A price does not: the Collection tab lists
 * editions read back off the chain, and a photograph published from another device — or from this
 * one before its local record was lost — has no `CaptureRecord` at all. The edition address is the
 * only identity both sides share, so the lock, the durable attempt and the storage key all use it.
 *
 * WHAT THE PROGRAM GUARANTEES, so that this file does not have to. `struct SetOffer` takes the
 * Edition account READ-ONLY with `has_one = creator`: only the publisher can call it, and the
 * instruction cannot touch supply, title, uri, the hashes or the issuance counter — not by a check,
 * but because it never writes that account. `Offer` is `init_if_needed`, so the same instruction
 * creates the account on the first call and rewrites it afterwards, carrying `revision` forward
 * with a saturating `+1` so an approval signed against an earlier price can never match again.
 *
 * WHAT PROVES IT WORKED. The `Offer` account, re-read after confirmation, never the signature: a
 * wallet can return a receipt for a transaction that failed, and a node can report a confirmation
 * it is behind on. The price must be the approved one AND the revision must have moved, so a
 * confirmation that is really a view of the state before this call is not mistaken for success.
 *
 * No UI lives here. The attempt is persisted before the wallet opens, the offer is re-read
 * immediately before it opens, and one in-process lock per edition stops two taps racing.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { address, getBase58Decoder } from "@solana/kit";
import { RPC_ENDPOINT, CLUSTER_NAME as cluster, assertEndpointCluster } from "../solana/cluster";
import type { WalletSession } from "../solana/walletSession";
import { refreshedQuote } from "./quoteRefresh";
import {
  readOfferAccount,
  readPublication,
  setOfferInstruction,
  type EditionOffer,
} from "../../publications/core/protocol";
import { reviewedFingerprint } from "../../publications/core/transferReceipt";
import { isTrustedDeployment, programFeatures } from "../../publications/deployments";
import { assertAttempt, checkAttempt, exclusive, operationInProgress } from "../../publications/lifecycle";
import {
  OPERATION_FLOOR_LAMPORTS,
  confirmTransaction,
  prepareTransaction,
} from "../../publications/rpc";
import { MAX_PRICE_LAMPORTS } from "./price";
import { CORE_PROTOCOL, type CoreMetadata, type PublicationAttempt } from "../../publications/types";

/** The one chain this build talks to. An edition on any other is refused, never retargeted. */

const UNREVIEWED =
  "This edition uses a program this app has not reviewed.";
const NO_OFFERS = "Prices are not available on this network yet.";
const NOT_THE_PUBLISHER = "Only the publisher can change the price.";
const CHANGED = "This edition changed since it was read. Open it again before setting a price.";
const EXPIRED = "The estimate expired. Review the price again.";

/**
 * One price change at a time per EDITION, in the style of `publicationLockKey` (`coordinator.ts`)
 * and `collect.ts`'s own lock. Two taps would otherwise send two `set_offer` calls, each advancing
 * `revision`, and the second would silently decide the price.
 */
const lock = (edition: string) => `offer:${cluster}:${edition}`;

/** Is a price change running for this edition right now? */
export const isOfferWorking = (edition: string) => operationInProgress(lock(edition));

// ---------------------------------------------------------------------------
// Reading the current offer
// ---------------------------------------------------------------------------

/**
 * What this edition currently asks for a copy.
 *
 * `supported` is about the DEPLOYMENT, not the edition: the program that owns this edition either
 * has the `Offer` account and its instructions or it does not, and where it does not there is no
 * price to show and nothing to set. `offer` is `null` for an edition that has never been priced and
 * for one priced at zero alike — both are free, which is exactly how the program reads them.
 */
export async function getOffer(
  e: CoreMetadata,
): Promise<{ supported: boolean; offer: EditionOffer | null }> {
  address(e.edition);
  if (e.cluster !== cluster || !isTrustedDeployment(cluster, e.program))
    throw new Error(UNREVIEWED);
  if (!programFeatures(e.program).offers) return { supported: false, offer: null };
  await assertEndpointCluster();
  const offer = await readOfferAccount(RPC_ENDPOINT, e.program, e.edition);
  // Reported as stored, zero included: the creator's own screen is the one place that has to tell
  // "never priced" from "priced at nothing", because one of them is a change they just made.
  return {
    supported: true,
    offer: offer ? { priceLamports: offer.priceLamports, revision: offer.revision } : null,
  };
}

// ---------------------------------------------------------------------------
// The durable attempt
// ---------------------------------------------------------------------------

/**
 * One price change on one edition, written BEFORE the wallet opens so a lost response is still
 * recoverable. Not keyed per wallet, unlike a collection: only the publisher can call `set_offer`
 * at all, so there is exactly one wallet this attempt could ever belong to.
 */
interface OfferAttempt extends PublicationAttempt {
  version: 1;
  protocol: typeof CORE_PROTOCOL;
  edition: string;
  creator: string;
  /** The approved price, in decimal lamports. A string for the reason `CoreDraft.price` is one. */
  price: string;
  /** The revision the offer had BEFORE this call, or 0 when there was no offer account. */
  fromRevision: number;
  /** `reviewedFingerprint` of the compiled message, ignoring the compute-budget instructions. */
  quoteId: string;
  confirmedAt?: number;
}

const attemptKey = (edition: string) => `es.core-offer.v1:${cluster}:${edition}`;

const BAD_ATTEMPT =
  "The saved price change does not match this edition. Check it before setting a price again.";

async function read(e: CoreMetadata): Promise<OfferAttempt | null> {
  const raw = await AsyncStorage.getItem(attemptKey(e.edition));
  if (!raw) return null;
  const attempt = JSON.parse(raw) as OfferAttempt;
  assertAttempt(attempt);
  address(attempt.edition);
  address(attempt.creator);
  if (
    attempt.version !== 1 ||
    attempt.protocol !== CORE_PROTOCOL ||
    attempt.edition !== e.edition ||
    attempt.creator !== e.creator ||
    !/^\d{1,20}$/.test(attempt.price) ||
    BigInt(attempt.price) > MAX_PRICE_LAMPORTS ||
    !Number.isInteger(attempt.fromRevision) ||
    attempt.fromRevision < 0 ||
    !/^[a-f0-9]{64}$/.test(attempt.quoteId) ||
    (attempt.confirmedAt !== undefined &&
      (!Number.isSafeInteger(attempt.confirmedAt) || attempt.confirmedAt <= 0))
  )
    throw new Error(BAD_ATTEMPT);
  return attempt;
}

const write = (attempt: OfferAttempt) =>
  AsyncStorage.setItem(attemptKey(attempt.edition), JSON.stringify(attempt));

/**
 * A previous attempt must be resolved before another price is sent. A `set_offer` that may still
 * land would advance `revision` after this one, so the last write would not be the reviewed one.
 * Anything but `retryable` stops the offer, which is `checkAttempt`'s contract.
 */
async function assertNoStandingAttempt(e: CoreMetadata): Promise<OfferAttempt | null> {
  const attempt = await read(e);
  if (!attempt || attempt.confirmedAt) return attempt;
  const standing = await checkAttempt(RPC_ENDPOINT, attempt, { operation: "set-offer" });
  if (standing === "retryable") return attempt;
  if (standing === "pending")
    throw new Error("The previous price change may still land. Wait a moment, then check again.");
  if (standing === "confirmed")
    throw new Error(
      "Price change confirmed, but not visible yet. Check again.",
    );
  throw new Error(
    "The previous price change failed. Open this edition again.",
  );
}

// ---------------------------------------------------------------------------
// Quoting and sending
// ---------------------------------------------------------------------------

/** The reviewed price change: which edition, what it will cost a buyer, and the exact transaction. */
export interface OfferQuote {
  edition: string;
  /** The price this quote sets, in lamports. `0n` makes the edition free again. */
  priceLamports: bigint;
  /** The revision the offer had when this was quoted; 0 when there was no offer yet. */
  fromRevision: number;
  /** `reviewedFingerprint` of the compiled message. */
  id: string;
  prepared: Awaited<ReturnType<typeof prepareTransaction>>;
}

/**
 * Everything checked before the review screen shows a cost, and the transaction that cost belongs
 * to. Nothing is signed.
 *
 * The edition is re-read from the chain first, and its on-chain `creator` — not the local record's
 * copy of it — is what must match: `has_one = creator` is the program's rule, and a local record
 * that disagrees would build a transaction the program refuses after a wallet had opened.
 */
export async function prepareOffer(
  e: CoreMetadata,
  priceLamports: bigint,
): Promise<OfferQuote> {
  if (typeof priceLamports !== "bigint" || priceLamports < 0n || priceLamports > MAX_PRICE_LAMPORTS)
    throw new Error("That price cannot be published.");
  address(e.edition);
  address(e.creator);
  // The estimate and the confirmation must be on the chain the wallet broadcasts to.
  await assertEndpointCluster();
  if (e.cluster !== cluster || !isTrustedDeployment(cluster, e.program)) throw new Error(UNREVIEWED);
  if (!programFeatures(e.program).offers) throw new Error(NO_OFFERS);
  if (operationInProgress(lock(e.edition)))
    throw new Error("This edition already has a price change in progress. Wait for it to finish.");

  const live = await readPublication(RPC_ENDPOINT, e.program, e.edition);
  if (!live) throw new Error("Edition not found on this network");
  // `set_offer` derives the Edition PDA from the account's own creator and nonce, so a local record
  // that disagrees with any of them names a different publication.
  if (
    live.state.creator !== e.creator ||
    live.state.nonce !== e.nonce ||
    live.state.title !== e.title ||
    live.state.supply !== e.supply
  )
    throw new Error(CHANGED);
  await assertNoStandingAttempt(e);
  // Read immediately before the estimate, so the revision recorded with the attempt is the one this
  // change actually follows and confirmation can tell "it moved" from "it was already there".
  const current = await readOfferAccount(RPC_ENDPOINT, e.program, e.edition);
  const fromRevision = current?.revision ?? 0;
  const ix = await setOfferInstruction(e, priceLamports);
  const prepared = await prepareTransaction(
    RPC_ENDPOINT,
    e.creator,
    [ix],
    [],
    // Rent for the `Offer` account. Stated, never enforced: a second call rewrites an account that
    // is already rent-exempt and costs only the network fee, which is below this floor.
    OPERATION_FLOOR_LAMPORTS["set-offer"],
  );
  return {
    edition: e.edition,
    priceLamports,
    fromRevision,
    id: reviewedFingerprint(new Uint8Array(prepared.transaction.messageBytes)),
    prepared,
  };
}

type OfferProgress = "wallet" | "confirming";

/**
 * Approve, confirm, and verify the price change. Returns the offer as it now stands on chain.
 *
 * The wallet that signs must be the edition's own creator: checked against the authorised session
 * rather than trusted from the argument, because `has_one = creator` is what the program enforces
 * and a mismatch is worth saying plainly instead of as a simulation failure.
 */
export async function sendOffer(
  e: CoreMetadata,
  quote: OfferQuote,
  session: WalletSession,
  onProgress?: (p: OfferProgress) => void,
): Promise<EditionOffer> {
  return exclusive(lock(e.edition), async () => {
    const reviewedBytes = new Uint8Array(quote.prepared.transaction.messageBytes);
    if (quote.edition !== e.edition || quote.id !== reviewedFingerprint(reviewedBytes))
      throw new Error("The price review changed. Check this edition again.");
    if (e.cluster !== cluster || !isTrustedDeployment(cluster, e.program)) throw new Error(UNREVIEWED);
    if (!programFeatures(e.program).offers) throw new Error(NO_OFFERS);
    await assertNoStandingAttempt(e);

    let attempt: OfferAttempt | undefined;
    onProgress?.("wallet");
    await session.connectAnd(async (wallet) => {
      const selected = await session.authorizeSession(wallet);
      if (selected.address !== e.creator) throw new Error(NOT_THE_PUBLISHER);
      // A wallet's approval sheet can outlast a blockhash, so the reviewed transaction is rebuilt
      // on a fresh lifetime; `refreshedQuote` refuses anything else that moved, the cost included.
      const prepared = await refreshedQuote(
        RPC_ENDPOINT,
        e.creator,
        [await setOfferInstruction(e, quote.priceLamports)],
        quote.prepared,
        EXPIRED,
      );
      // Persisted before the wallet opens, on the REFRESHED lifetime: an attempt saved with the
      // reviewed height could be judged retryable while the signed transaction can still land.
      attempt = {
        version: 1,
        protocol: CORE_PROTOCOL,
        edition: e.edition,
        creator: e.creator,
        price: quote.priceLamports.toString(),
        fromRevision: quote.fromRevision,
        quoteId: reviewedFingerprint(new Uint8Array(prepared.transaction.messageBytes)),
        lastValidBlockHeight: String(prepared.lastValidBlockHeight),
      };
      await write(attempt);
      const signatures = await wallet.signAndSendTransactions({
        transactions: [prepared.transaction],
        minContextSlot: Number(prepared.minContextSlot),
        skipPreflight: false,
      });
      // MWA can return null or short signatures; saving one would make the attempt unreadable.
      if (signatures.length !== 1 || signatures[0].length !== 64)
        throw new Error("No wallet receipt. Check the price before retrying.");
      attempt.signature = getBase58Decoder().decode(signatures[0]);
      await write(attempt);
    });
    if (!attempt?.signature)
      throw new Error("No wallet receipt. Check the price before retrying.");

    onProgress?.("confirming");
    await confirmTransaction(RPC_ENDPOINT, attempt.signature, BigInt(attempt.lastValidBlockHeight));
    // The account, not the signature. Both halves matter: the price must be the approved one, and
    // `revision` must have advanced past what was there before, so a read of the PREVIOUS state —
    // an endpoint a slot behind, or a confirmation belonging to some other transaction — cannot
    // pass as this change having landed.
    const offer = await readOfferAccount(RPC_ENDPOINT, e.program, e.edition);
    if (!offer)
      throw new Error(
        "The transaction confirmed, but the new price is not visible yet. Check this edition again.",
      );
    if (offer.priceLamports !== quote.priceLamports || offer.revision <= quote.fromRevision)
      throw new Error(
        "The transaction confirmed, but this edition's price is not the one reviewed. Check it again.",
      );
    attempt.confirmedAt = Date.now();
    await write(attempt);
    return { priceLamports: offer.priceLamports, revision: offer.revision };
  });
}
