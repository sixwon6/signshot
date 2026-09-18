/**
 * Collecting: a wallet claims the next numbered copy of a published edition with one instruction.
 *
 * FREE OR PAID, DECIDED BY THE CHAIN AND NOT BY THE SCREEN. `collect` claims a free copy; `buy`
 * claims the same copy and pays the publisher in the same transaction. Which one this flow builds
 * comes from the edition's `Offer` account, re-read immediately before the estimate — an edition
 * with a price can only be claimed by paying it (the program refuses `collect` with
 * `PaymentRequired`), and a free one can only be collected (`buy` answers `NotForSale`).
 *
 * Even a free claim is not free of costs: the collector pays rent for the new Core print and the
 * `Receipt`, the network fee, and Metaplex Core's flat 1,500,000-lamport protocol fee for creating
 * an asset. A purchase pays all of that AND the price. The two are shown apart — `priceLamports` is
 * what reaches the publisher, `prepared.estimatedLamports` is what leaves the wallet — and both
 * come from simulating the collector's own transaction rather than from a fee table.
 *
 * THE THREE RULES THIS FLOW EXISTS TO RESPECT, all from `programs/editions/src/lib.rs`:
 *   1. `require!(e.minted < e.supply, SoldOut)` — an edition runs out, permanently.
 *   2. `require!(number == e.minted + 1, StaleNumber)` — the copy number is part of the
 *      instruction data, so it must be read from the chain immediately before the estimate, and a
 *      competing collector invalidates a quote rather than a wallet.
 *   3. the receipt PDA `["claim", edition, collector]` is `init` — one claim per wallet, ever,
 *      surviving any later transfer or burn of the print. That account, not a signature, is what
 *      proves a claim, and it is also why this flow needs none of `transfer.ts`'s replay
 *      bookkeeping: the program itself refuses a second claim by the same wallet.
 *
 * No UI lives here. The attempt is persisted before the wallet opens, the edition is re-read
 * immediately before it opens, and one in-process lock per edition stops two taps racing.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  address,
  getBase58Decoder,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { RPC_ENDPOINT, CLUSTER_NAME as cluster, assertEndpointCluster } from "../solana/cluster";
import type { WalletSession } from "../solana/walletSession";
import { isSigningRefused } from "../solana/walletErrors";
import { refreshedQuote } from "./quoteRefresh";
import {
  addresses,
  buyInstruction,
  collectInstruction,
  collectedCopy,
  loadTrustedEdition,
  pricedOffer,
  readOfferAccount,
  readPublication,
  type EditionOffer,
} from "../../publications/core/protocol";
import { reviewedFingerprint } from "../../publications/core/transferReceipt";
import { isTrustedDeployment } from "../../publications/deployments";
import { assertAttempt, checkAttempt, exclusive, operationInProgress } from "../../publications/lifecycle";
import { safeErrorText } from "../ui/errorText";
import {
  NEEDS_SOL,
  OPERATION_FLOOR_LAMPORTS,
  confirmTransaction,
  prepareTransaction,
  request,
} from "../../publications/rpc";
import {
  CORE_PROTOCOL,
  type Cluster,
  type CoreMetadata,
  type PublicationAttempt,
} from "../../publications/types";

/** The one chain this build talks to. A link for any other is refused, never silently retargeted. */

const UNREVIEWED =
  "This edition uses a program this app has not reviewed.";

/**
 * One collection at a time per EDITION, in the style of `publicationLockKey` (`coordinator.ts`).
 * Keyed on the edition rather than on a photograph because a collector has no local photograph:
 * the thing two taps could race for is the edition's next copy number.
 */
const lock = (edition: string) => `collect:${cluster}:${edition}`;

/** Is a collection running for this edition right now? */
export const isCollectWorking = (edition: string) => operationInProgress(lock(edition));

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** An edition to collect, on the cluster the link named (always this build's own). */
export interface CollectTarget {
  edition: string;
  cluster: Cluster;
}

/** Longest text this scans: a pasted message or a scanned QR payload, not a document. */
const MAX_LINK_CHARS = 4096;
/** A URL, stopping at whitespace and the characters that usually wrap one in prose. */
const URL_TOKEN = /https?:\/\/[^\s"'<>()[\]{}]+/gi;
/** Base58 as Solana writes it (no 0, O, I or l). Length is re-checked by `address()`. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const ALBUM_LINK = "That is an album link. Open a photograph's link.";
const NOT_AN_ADDRESS = "This link does not name a Solana address.";
const networkName = (c: Cluster) => (c === "devnet" ? "devnet" : "mainnet");

/**
 * A query string, parsed by hand. React Native's `URL`/`URLSearchParams` are minimal shims whose
 * accessors are not all implemented, and this input arrives from outside the app, so the parse is
 * local, bounded and total: an undecodable escape makes the whole link unreadable rather than
 * silently dropping a parameter.
 */
function query(text: string): Map<string, string> | null {
  const out = new Map<string, string>();
  try {
    for (const pair of text.split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const name = decodeURIComponent((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, " "));
      const value = eq < 0 ? "" : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
      // First wins, so a repeated parameter cannot be used to show one value and send another.
      if (!out.has(name)) out.set(name, value);
    }
  } catch {
    return null;
  }
  return out;
}

/** One URL token, if it is a collect link. Throws when it IS one but cannot be collected here. */
function fromUrl(token: string): CollectTarget | null {
  // Punctuation a sentence put after the link, not part of it.
  const trimmed = token.replace(/[.,;:!?)\]]+$/, "");
  const fragment = trimmed.indexOf("#");
  const withoutFragment = fragment < 0 ? trimmed : trimmed.slice(0, fragment);
  const mark = withoutFragment.indexOf("?");
  if (mark < 0) return null;
  // The route only, at any origin. A link chooses neither a program nor an RPC endpoint — the
  // edition account's own owner is what decides trust (`loadTrustedEdition`) — so the host is
  // presentation, and being strict about it would only break a shortened or proxied share link.
  if (!/\/collect\/?$/i.test(withoutFragment.slice(0, mark))) return null;
  const params = query(withoutFragment.slice(mark + 1));
  if (params === null) return null;
  // An album is a Core `GroupV1`: there is no supply, no numbering and no `collect` instruction
  // for one. Said plainly rather than answered with "nothing to collect here".
  if (params.has("album")) throw new Error(ALBUM_LINK);
  const core = params.get("core");
  if (core === undefined) return null;
  if (!BASE58_ADDRESS.test(core)) throw new Error(NOT_AN_ADDRESS);
  try {
    address(core);
  } catch {
    throw new Error(NOT_AN_ADDRESS);
  }
  // `collectUrl()` appends `&cluster=devnet` and nothing at all for mainnet.
  const named = params.get("cluster");
  let linkCluster: Cluster;
  if (named === undefined || named === "" || named === "mainnet-beta" || named === "mainnet")
    linkCluster = "mainnet-beta";
  else if (named === "devnet") linkCluster = "devnet";
  else throw new Error("This link names a Solana network this app does not use.");
  if (linkCluster !== cluster)
    throw new Error(
      `This link is for ${networkName(linkCluster)}. This app is on ${networkName(cluster)}.`,
    );
  return { edition: core, cluster: linkCluster };
}

/**
 * A collect link, a bare edition address, or either one inside other text (a shared message, a
 * scanned QR payload). `null` when there is nothing usable; an Error when the text DOES name
 * something that cannot be collected on this build, because "nothing here" would be a lie.
 *
 * A bare address is only accepted as a whole whitespace-delimited token. Scanning for a base58 run
 * anywhere would happily cut a 44-character prefix out of an 88-character signature.
 */
export function parseCollectLink(input: string): CollectTarget | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text || text.length > MAX_LINK_CHARS) return null;
  for (const match of text.matchAll(URL_TOKEN)) {
    const target = fromUrl(match[0]);
    if (target) return target;
  }
  for (const token of text.split(/[\s,]+/)) {
    if (!BASE58_ADDRESS.test(token)) continue;
    try {
      address(token);
    } catch {
      continue;
    }
    // A bare address carries no cluster, so it means "this build's chain" and nothing else.
    return { edition: token, cluster };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading an edition
// ---------------------------------------------------------------------------

/**
 * A verified, readable edition. `imageUri` is the data URI of exactly the bytes whose sha256
 * matched the on-chain `image_hash`, built the same way `publications/core/library.ts` builds it,
 * so nothing is re-fetched to display what was already verified.
 */
export interface Collectable {
  edition: CoreMetadata;
  minted: number;
  remaining: number;
  imageUri: string;
  /**
   * What this edition asks for a copy right now, or `null` for a free one.
   *
   * `null` covers all three ways an edition is free and a screen must not tell them apart: the
   * deployment predates offers, no offer was ever set, or the offer says zero. A price of `0n` is
   * never reported here — `pricedOffer` normalises it away — so `offer !== null` is exactly the
   * condition under which a claim becomes a purchase.
   *
   * It is a snapshot for RENDERING. The creator can change the price at any moment, so nothing is
   * quoted from this copy: `prepareCollect` re-reads the account immediately before it builds a
   * transaction, and the buyer's approval carries the price and revision it saw.
   */
  offer: EditionOffer | null;
  /** The permanent chain evidence, including the publisher's own receipt for copy 1. */
  publication: Awaited<ReturnType<typeof loadTrustedEdition>>["publication"];
}

/**
 * Read an edition to collect. The program is resolved from the account's OWNER and checked against
 * this build's reviewed deployments, so neither the link nor the metadata can choose one. Throws a
 * sentence a screen can render for every failure: not on the network, not a reviewed deployment, or
 * a document that does not match what was published.
 */
export async function loadCollectable(edition: string): Promise<Collectable> {
  let key: string;
  try {
    key = address(edition);
  } catch {
    throw new Error(NOT_AN_ADDRESS);
  }
  // Everything below reads the chain the wallet will broadcast to, so the endpoint is pinned first.
  await assertEndpointCluster();
  const result = await loadTrustedEdition(RPC_ENDPOINT, key, cluster);
  // `loadTrustedEdition` already applied this rule; restated because it is the whole of the trust
  // decision and a refactor there must not quietly remove it here.
  if (!isTrustedDeployment(cluster, result.edition.program)) throw new Error(UNREVIEWED);
  return {
    edition: result.edition,
    minted: result.minted,
    remaining: result.remaining,
    imageUri: `data:image/jpeg;base64,${getBase64Decoder().decode(result.imageBytes)}`,
    offer: result.offer,
    publication: result.publication,
  };
}

// ---------------------------------------------------------------------------
// The durable attempt
// ---------------------------------------------------------------------------

/**
 * One wallet's collection attempt on one edition, written BEFORE the wallet opens so a lost
 * response is still recoverable. Keyed per wallet as well as per edition: a phone can be used with
 * more than one wallet, and one wallet's outcome says nothing about another's.
 */
interface CollectAttempt extends PublicationAttempt {
  version: 1;
  protocol: typeof CORE_PROTOCOL;
  collector: string;
  edition: string;
  /** The print PDA this claim creates: `["print", edition, u16 le number]`. */
  asset: string;
  number: number;
  /**
   * `reviewedFingerprint` of the compiled message, ignoring the compute-budget instructions a
   * wallet may rewrite. Recorded so the attempt names a specific reviewed transaction.
   */
  quoteId: string;
  confirmedAt?: number;
}

const attemptKey = (edition: string, wallet: string) =>
  `es.core-collect.v1:${cluster}:${edition}:${wallet}`;

const BAD_ATTEMPT =
  "The saved collection does not match this edition. Check it before collecting again.";

async function read(e: CoreMetadata, wallet: string): Promise<CollectAttempt | null> {
  const raw = await AsyncStorage.getItem(attemptKey(e.edition, wallet));
  if (!raw) return null;
  const attempt = JSON.parse(raw) as CollectAttempt;
  assertAttempt(attempt);
  address(attempt.collector);
  address(attempt.asset);
  address(attempt.edition);
  if (
    attempt.version !== 1 ||
    attempt.protocol !== CORE_PROTOCOL ||
    attempt.collector !== wallet ||
    attempt.edition !== e.edition ||
    // Copy 1 is the publisher's, created by `publish`; a claim is never for it.
    !Number.isInteger(attempt.number) ||
    attempt.number < 2 ||
    attempt.number > e.supply ||
    !/^[a-f0-9]{64}$/.test(attempt.quoteId) ||
    (attempt.confirmedAt !== undefined &&
      (!Number.isSafeInteger(attempt.confirmedAt) || attempt.confirmedAt <= 0))
  )
    throw new Error(BAD_ATTEMPT);
  // The recorded asset must be the print PDA those seeds actually produce, so a rewritten record
  // cannot make a later check ask about somebody else's NFT.
  const expected = await addresses(e.program, e.creator, e.nonce, attempt.number, wallet);
  if (expected.print !== attempt.asset) throw new Error(BAD_ATTEMPT);
  return attempt;
}

const write = (attempt: CollectAttempt) =>
  AsyncStorage.setItem(attemptKey(attempt.edition, attempt.collector), JSON.stringify(attempt));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type CollectEligibility = "collect" | "already" | "soldOut" | "wait" | "unavailable";

export interface CollectState {
  eligibility: CollectEligibility;
  attempt: CollectAttempt | null;
  /** The copy this wallet holds, when `already`. */
  number?: number;
  reason?: string;
}

const SOLD_OUT = "Sold out.";
const ALREADY =
  "Already collected by this wallet.";
const MAY_LAND = "A collection may still land. Wait a moment, then check again.";
const CONFIRMED_UNSEEN =
  "Collection confirmed, but its receipt is not visible yet. Check again.";
const CANNOT_REPEAT =
  "The previous collection failed. Reopen the link.";

/**
 * May this wallet collect, and what is standing in the way? Never throws: every failure is an
 * `unavailable` with the sentence that explains it, because this is a screen state.
 *
 * The order is deliberate. The permanent receipt is asked about FIRST, because a wallet that has
 * already claimed can never claim again whatever else is true. This wallet's own saved attempt
 * comes next, since money that may still be in flight is the more urgent fact than a supply count
 * read a moment ago. Anything about that attempt other than `retryable` stops the offer:
 * `checkAttempt`'s contract is that only `retryable` means "offer this again", so a classification
 * added to it later lands on the safe side by default.
 */
export async function getCollectState(c: Collectable, wallet: string): Promise<CollectState> {
  let attempt: CollectAttempt | null = null;
  try {
    const e = c.edition;
    address(wallet);
    if (e.cluster !== cluster || !isTrustedDeployment(cluster, e.program))
      throw new Error(UNREVIEWED);
    await assertEndpointCluster();
    attempt = await read(e, wallet);

    // The publisher's receipt was created by `publish` atomically with print #1 and is already
    // verified inside `c.publication`, so it costs no request to answer for them.
    const mine =
      wallet === e.creator
        ? c.publication.creatorReceipt
        : await collectedCopy(RPC_ENDPOINT, e, wallet);
    if (mine) return { eligibility: "already", attempt, number: mine.number, reason: ALREADY };

    if (attempt) {
      const standing = await checkAttempt(RPC_ENDPOINT, attempt, { operation: "collect" });
      if (standing === "pending") return { eligibility: "wait", attempt, reason: MAY_LAND };
      // Confirmed without error, yet no receipt exists: this connection is behind, or the
      // signature confirmed on a transaction that was not this claim. Neither is a reason to pay
      // again right now.
      if (standing === "confirmed")
        return { eligibility: "unavailable", attempt, reason: CONFIRMED_UNSEEN };
      if (standing !== "retryable")
        return { eligibility: "unavailable", attempt, reason: CANNOT_REPEAT };
    }

    if (c.remaining <= 0) return { eligibility: "soldOut", attempt, reason: SOLD_OUT };
    return { eligibility: "collect", attempt };
  } catch (error) {
    return {
      eligibility: "unavailable",
      attempt,
      reason: safeErrorText(error),
    };
  }
}

/** The refusal for a state that is not `collect`, preferring the state's own explanation. */
function refusal(state: CollectState): Error {
  return new Error(
    state.reason ??
      { already: ALREADY, soldOut: SOLD_OUT, wait: MAY_LAND, unavailable: CANNOT_REPEAT, collect: "" }[
        state.eligibility
      ],
  );
}

// ---------------------------------------------------------------------------
// Quoting and collecting
// ---------------------------------------------------------------------------

/** The reviewed claim: which copy, which print account, and the exact transaction quoted for it. */
export interface CollectQuote {
  edition: string;
  number: number;
  asset: string;
  id: string;
  /**
   * Which instruction this quote was built for. `"buy"` exactly when the offer read a moment before
   * the estimate carried a price; `"collect"` otherwise. The two are different instructions with
   * different account lists, so this is not a display flag — `sendCollect` rebuilds the same one.
   */
  kind: "collect" | "buy";
  /**
   * What reaches the publisher, in lamports. `0n` for a `collect`, and for a `buy` the exact amount
   * signed into the instruction data, which the program compares against the live offer.
   *
   * This is NOT the total. `prepared.estimatedLamports` is what leaves the wallet, and for a
   * purchase it already contains this price, because it comes from the payer's own simulated
   * balance delta. Show the two apart — price, then costs — and never add them together.
   */
  priceLamports: bigint;
  /**
   * The offer revision the price belongs to, signed into a `buy` alongside it, and `0` for a
   * `collect`. `revision` rises by one on every `set_offer`, so it is what makes a stale approval
   * fail (`OfferChanged`) instead of settling at a price nobody reviewed.
   */
  revision: number;
  prepared: Awaited<ReturnType<typeof prepareTransaction>>;
}

/**
 * The transaction for a quote: `buy` when the offer is priced, `collect` when it is free. One
 * function so the review and the approval cannot drift into different instructions.
 */
const claimInstruction = (c: Collectable, collector: string, quote: Pick<CollectQuote, "kind" | "number" | "priceLamports" | "revision">) =>
  quote.kind === "buy"
    ? buyInstruction(c.edition, collector, quote.number, quote.priceLamports, quote.revision)
    : collectInstruction(c.edition, collector, quote.number);

/**
 * The wallet's balance in lamports, at confirmed commitment. Read only to refuse a purchase the
 * wallet plainly cannot cover, before a simulation is spent on it.
 */
async function balanceLamports(wallet: string): Promise<bigint> {
  const { value } = await request<{ value: number }>(RPC_ENDPOINT, "getBalance", [
    wallet,
    { commitment: "confirmed" },
  ]);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("The network did not report this wallet's balance.");
  return BigInt(value);
}

const PUBLISHER =
  "You published this edition and hold copy 1.";
const EXPIRED = "The estimate expired. Review the collection again.";

/** The fee payer of a compiled v0 message: its first static account. */
const feePayerOf = (messageBytes: Uint8Array) =>
  getCompiledTransactionMessageDecoder().decode(messageBytes).staticAccounts[0];

/**
 * Everything checked before the review screen shows a cost, and the transaction that cost belongs
 * to. The copy number is read from the chain here and nowhere else: `collect` requires
 * `number == minted + 1` exactly, so quoting against a `minted` from an earlier read buys a
 * guaranteed `StaleNumber` after the wallet has already been opened.
 *
 * THE PRICE IS READ HERE TOO, AND FOR THE SAME REASON. An offer is a separate, mutable account:
 * whatever `c.offer` said when the link was opened may already be wrong, and quoting from it would
 * mean showing one price and — since `buy` signs the amount — asking the wallet to approve it. So
 * the offer account is re-read immediately before the estimate, and its price and revision go
 * straight into the instruction the wallet will see. If the creator changes the price between this
 * read and the block, the program answers `OfferChanged` and nothing is charged.
 */
export async function prepareCollect(c: Collectable, wallet: string): Promise<CollectQuote> {
  const e = c.edition;
  address(wallet);
  // The estimate, the receipt and the confirmation all have to be on the chain the wallet
  // broadcasts to.
  await assertEndpointCluster();
  if (e.cluster !== cluster || !isTrustedDeployment(cluster, e.program)) throw new Error(UNREVIEWED);
  // `publish` initialised the creator's receipt at ["claim", edition, creator] and `struct Collect`
  // declares that same account `init`, so the program would reject this before it did anything
  // else. Refused here, with the reason, rather than as a simulation failure.
  if (wallet === e.creator) throw new Error(PUBLISHER);
  if (operationInProgress(lock(e.edition)))
    throw new Error("This edition already has a collection in progress. Wait for it to finish.");
  const state = await getCollectState(c, wallet);
  if (state.eligibility !== "collect") throw refusal(state);

  const live = await readPublication(RPC_ENDPOINT, e.program, e.edition);
  if (!live) throw new Error("Edition not found on this network");
  // The terms the instruction is built from must still be the terms on chain. Nothing in the
  // program can change them, so a difference means the loaded edition is not this account.
  if (
    live.state.supply !== e.supply ||
    live.state.creator !== e.creator ||
    live.state.nonce !== e.nonce ||
    live.state.title !== e.title
  )
    throw new Error("This edition changed since it was read. Open the link again.");
  if (live.state.minted >= live.state.supply) throw new Error(SOLD_OUT);
  const number = live.state.minted + 1;

  // The live offer, not the one loaded with the edition. `pricedOffer` collapses "no offer",
  // "no offers on this program" and "priced at zero" into the one answer they all mean: free.
  const offer = pricedOffer(await readOfferAccount(RPC_ENDPOINT, e.program, e.edition));
  const shape = offer
    ? { kind: "buy" as const, number, priceLamports: offer.priceLamports, revision: offer.revision }
    : { kind: "collect" as const, number, priceLamports: 0n, revision: 0 };
  if (offer) {
    // The price is known here; current account rent and fees come from the simulation below.
    // The historical rent table can exceed today's rent and must not reject a funded buyer.
    const balance = await balanceLamports(wallet);
    if (balance < offer.priceLamports) throw new Error(NEEDS_SOL);
  }
  const instruction = await claimInstruction(c, wallet, shape);
  const keys = await addresses(e.program, e.creator, e.nonce, number, wallet);
  const prepared = await prepareTransaction(
    RPC_ENDPOINT,
    wallet,
    [instruction],
    [],
    // Historical reference only. `prepareTransaction` checks the full price, current account
    // costs and network fees from the simulated payer balance delta before wallet approval.
    OPERATION_FLOOR_LAMPORTS[shape.kind],
  );
  const id = reviewedFingerprint(new Uint8Array(prepared.transaction.messageBytes));
  if (state.attempt?.quoteId === id)
    throw new Error(
      "This estimate repeats a collection message already sent. Wait for a new estimate and review again.",
    );
  return { edition: e.edition, asset: keys.print, id, prepared, ...shape };
}

type CollectProgress = "wallet" | "confirming";

/**
 * Approve, confirm, and verify the claim. Returns the copy number this wallet now holds.
 *
 * The claim is proved by the permanent `Receipt` account, never by the signature: a wallet can
 * return a receipt for a transaction that failed, and a confirmation can be reported by a node that
 * is behind. There is deliberately none of `transfer.ts`'s previous-message bookkeeping, because
 * a replay cannot succeed here — the receipt PDA is `init`, so the program refuses a second claim
 * by the same wallet however many times the message is submitted. That holds for a purchase too:
 * the same `["claim", edition, collector]` account is `init` in `struct Buy`, so a resubmitted
 * message cannot charge the buyer twice.
 *
 * A PURCHASE IS NOT RE-PRICED HERE. `refreshedQuote` rebuilds the SAME instruction — same kind,
 * same price, same revision — and refuses anything whose bytes or cost differ from the reviewed
 * transaction. If the creator moved the price in the meantime, the rebuilt `buy` still carries the
 * approved amount and the program refuses it with `OfferChanged`; the screen then re-reads and
 * quotes again. At no point is an amount the collector did not review handed to a wallet.
 */
export async function sendCollect(
  c: Collectable,
  quote: CollectQuote,
  session: WalletSession,
  onProgress?: (p: CollectProgress) => void,
): Promise<{ number: number }> {
  const e = c.edition;
  return exclusive(lock(e.edition), async () => {
    const reviewedBytes = new Uint8Array(quote.prepared.transaction.messageBytes);
    if (quote.edition !== e.edition || quote.id !== reviewedFingerprint(reviewedBytes))
      throw new Error("The collection review changed. Check this edition again.");
    if (e.cluster !== cluster || !isTrustedDeployment(cluster, e.program)) throw new Error(UNREVIEWED);
    // The collector is read OUT of the reviewed message rather than passed in beside it: the first
    // static account of a compiled message is its fee payer
    // (https://solana.com/docs/core/transactions), so this is exactly the wallet that was quoted
    // and no separate argument can point the attempt at a different one.
    const collector = feePayerOf(reviewedBytes);
    if (collector === e.creator) throw new Error(PUBLISHER);
    const keys = await addresses(e.program, e.creator, e.nonce, quote.number, collector);
    if (keys.print !== quote.asset)
      throw new Error("The collection review names an unexpected print. Review it again.");

    const state = await getCollectState(c, collector);
    if (state.eligibility !== "collect") throw refusal(state);

    let attempt: CollectAttempt | undefined;
    onProgress?.("wallet");
    await session.connectAnd(async (wallet) => {
      const selected = await session.authorizeSession(wallet);
      if (selected.address !== collector)
        throw new Error("Use the wallet shown in the collection review.");
      // A wallet's own approval sheet can outlast a blockhash, so the reviewed transaction is
      // rebuilt on a fresh lifetime; `refreshedQuote` refuses anything else that moved, including
      // the cost.
      const prepared = await refreshedQuote(
        RPC_ENDPOINT,
        collector,
        [await claimInstruction(c, collector, quote)],
        quote.prepared,
        EXPIRED,
      );
      // Persisted before the wallet opens, on the REFRESHED lifetime: an attempt saved with the
      // reviewed height could be judged retryable while the signed transaction can still land.
      attempt = {
        version: 1,
        protocol: CORE_PROTOCOL,
        collector,
        edition: e.edition,
        asset: quote.asset,
        number: quote.number,
        quoteId: reviewedFingerprint(new Uint8Array(prepared.transaction.messageBytes)),
        lastValidBlockHeight: String(prepared.lastValidBlockHeight),
      };
      await write(attempt);
      const signatures = await wallet.signAndSendTransactions({
        transactions: [prepared.transaction],
        minContextSlot: Number(prepared.minContextSlot),
        skipPreflight: false,
      }).catch(async (error: unknown) => {
        // This single-payload request was explicitly not signed. A closed association or
        // timeout proves no such thing: retain those attempts until the chain resolves them.
        // The edition lock still covers this removal, so another send cannot replace it.
        if (isSigningRefused(error)) await AsyncStorage.removeItem(attemptKey(e.edition, collector));
        throw error;
      });
      // MWA can return null or short signatures; saving one would make the attempt unreadable.
      if (signatures.length !== 1 || signatures[0].length !== 64)
        throw new Error("No wallet receipt. Check the collection before retrying.");
      attempt.signature = getBase58Decoder().decode(signatures[0]);
      await write(attempt);
    });
    if (!attempt?.signature)
      throw new Error("No wallet receipt. Check the collection before retrying.");

    onProgress?.("confirming");
    await confirmTransaction(RPC_ENDPOINT, attempt.signature, BigInt(attempt.lastValidBlockHeight));
    const receipt = await collectedCopy(RPC_ENDPOINT, e, collector);
    if (!receipt)
      throw new Error(
        "The transaction confirmed, but the collection receipt is not visible yet. Check again before collecting.",
      );
    if (receipt.asset !== quote.asset || receipt.number !== quote.number)
      throw new Error("A copy was collected, but not the one reviewed. Check this edition.");
    attempt.confirmedAt = Date.now();
    await write(attempt);
    return { number: receipt.number };
  });
}
