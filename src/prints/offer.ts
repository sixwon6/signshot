/**
 * Pricing a published edition: the creator sets, changes or removes what a copy costs, with one
 * `set_offer` instruction and one wallet approval.
 *
 * Keyed by edition, not photograph: the Collection tab lists editions read off the chain, and one
 * published from another device has no `CaptureRecord` here. The lock, the durable attempt and the
 * storage key all use the edition address.
 *
 * `struct SetOffer` takes the Edition account read-only with `has_one = creator`, so only the
 * publisher can call it and it cannot touch supply, title, uri, the hashes or the issuance counter.
 * `Offer` is `init_if_needed`, and every call advances `revision` (saturating `+1`), so an approval
 * signed against an earlier price never matches again.
 *
 * Success is the re-read `Offer` account, never the signature: the price must be the approved one
 * and the revision must have moved, so a view of the state before this call is not mistaken for it.
 * The attempt is persisted before the wallet opens, and one lock per edition stops two taps racing.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { address, getBase58Decoder } from "@solana/kit";
import { RPC_ENDPOINT, CLUSTER_NAME as cluster, assertEndpointCluster } from "../solana/cluster";
import type { WalletSession } from "../solana/walletSession";
import { forgetIfRefused } from "../solana/walletErrors";
import { refreshedQuote } from "./quoteRefresh";
import {
  readOfferAccount,
  readPublication,
  setOfferInstruction,
  type EditionOffer,
} from "../../publications/core/protocol";
import { reviewedFingerprint } from "../../publications/core/transferReceipt";
import { isTrustedDeployment, programFeatures } from "../../publications/deployments";
import { assertReviewedProgram } from "../../publications/programImage";
import { assertAttempt, checkAttempt, exclusive, operationInProgress } from "../../publications/lifecycle";
import {
  OPERATION_FLOOR_LAMPORTS,
  confirmTransaction,
  prepareTransaction,
} from "../../publications/rpc";
import { checkPriceMinimum, MAX_PRICE_LAMPORTS, minimumPriceLamports } from "./price";
import { CORE_PROTOCOL, type CoreMetadata, type PublicationAttempt } from "../../publications/types";

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
 * What this edition currently asks for a copy. `supported` is about the deployment: a program
 * without the `Offer` account has no price to show or set.
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
 * Everything checked before the review shows a cost, and the transaction that cost belongs to.
 * Nothing is signed. The edition is re-read first and must match the local record: `has_one =
 * creator` would otherwise refuse the transaction after the wallet had opened.
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
  // The creator signs, and a signer's privileges reach every program it calls: the deployed bytes
  // and upgrade authority must still be the reviewed ones.
  await assertReviewedProgram(RPC_ENDPOINT, e.program, cluster);
  // `set_offer` refuses a price between zero and the rent-exempt minimum; said here, with the number.
  checkPriceMinimum(priceLamports, await minimumPriceLamports(RPC_ENDPOINT));
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
 * Approve, confirm, and verify the price change. Returns the offer as it now stands on chain. The
 * authorised wallet must be the edition's creator (`has_one = creator`), refused plainly here
 * rather than as a simulation failure.
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
    const previous = await assertNoStandingAttempt(e);
    // Again right before the wallet opens: two header reads while the reviewed slot is cached.
    await assertReviewedProgram(RPC_ENDPOINT, e.program, cluster);

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
      // Declined in the wallet: the attempt before this one comes back, under the edition lock.
      const signatures = await forgetIfRefused(wallet.signAndSendTransactions({
        transactions: [prepared.transaction],
        minContextSlot: Number(prepared.minContextSlot),
        skipPreflight: false,
      }), () => (previous ? write(previous) : AsyncStorage.removeItem(attemptKey(e.edition))));
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
    // The account, not the signature: the approved price and an advanced `revision`, so a read of
    // the previous state (a lagging endpoint, another transaction's confirmation) cannot pass.
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
