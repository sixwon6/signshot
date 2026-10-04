/**
 * Collecting: a wallet claims the next numbered copy of an edition through Metaplex's Core Candy
 * Guard (`claimDraft` in `publications/candy/edition.ts`). The edition is re-read immediately before
 * the review and before the wallet opens; the amounts shown are the client's own (`claimCost`), and
 * the claim moves exactly those, so a price changed since review fails on chain and charges nothing.
 * A Seeker-only edition is co-signed by the Worker after Sign-in-with-Solana.
 */

import {
  address,
  generateKeyPairSigner,
  getBase64Decoder,
  type Address,
} from "@solana/kit";
import { RPC_ENDPOINT, CLUSTER_NAME as cluster, assertEndpointCluster } from "../solana/cluster";
import type { WalletSession } from "../solana/walletSession";
import {
  canAfford,
  claimCost,
  claimDraft,
  claimStatus,
  counterAddress,
  type ClaimCost,
  type Edition,
  type Price,
} from "../../publications/candy/edition";
import type { Draft, Budget } from "../../publications/candy/transactions";
import {
  copiesHeld,
  copiesLine,
  editionDisplay,
  fetchAccount,
  loadEdition,
  readHeldCopy,
  type EditionDisplay,
} from "../../publications/editions";
import { FEE_ALLOWANCE_LAMPORTS, NEEDS_SOL } from "../../publications/rpc";
import type { Cluster, CoreMetadata } from "../../publications/types";
import { collect as words } from "../ui/copy";
import { safeErrorText } from "../ui/errorText";
import { exclusive, operationInProgress } from "./locks";
import {
  TransactionFailure,
  balance,
  claimFailure,
  latestLifetime,
  prepareDraft,
  priorityLamports,
  rent,
  sendAndConfirm,
  signWithWallet,
  withLifetime,
} from "./send";
import { cosignClaim, cosignerChallenge, cosignerKey } from "../seeker/cosigner";
import { associatedTokenAddress, TOKEN_PROGRAM } from "../../publications/candy/programs";
import { loadPriceToken, tokenValue } from "./priceToken";
import { publisherGenesisMint } from "../seeker/publisherGenesis";

/** One collection at a time per edition, in this process. */
const lock = (edition: string) => `collect:${cluster}:${edition}`;
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

/** An edition `readEdition` accepted, with its verified picture as a data URI. */
export interface Collectable {
  edition: CoreMetadata;
  chain: Edition;
  minted: number;
  remaining: number;
  imageUri: string;
  /** The price of a copy (SOL or SKR), or null when free. */
  offer: Price | null;
  seekerOnly: boolean;
  /** One line when the edition's copies on chain do not add up (`copyAnomalies`), else null. */
  anomaly: string | null;
}

const asCollectable = (d: EditionDisplay, anomaly: string | null): Collectable => ({
  edition: d.edition,
  chain: d.chain,
  minted: d.minted,
  remaining: d.remaining,
  imageUri: `data:image/jpeg;base64,${getBase64Decoder().decode(d.imageBytes)}`,
  offer: d.offer,
  seekerOnly: d.seekerOnly,
  anomaly,
});

/** Read an edition by its candy machine. Throws a sentence for anything `readEdition` refuses. */
export async function loadCollectable(edition: string): Promise<Collectable> {
  let key: string;
  try {
    key = address(edition);
  } catch {
    throw new Error(NOT_AN_ADDRESS);
  }
  await assertEndpointCluster();
  await loadPriceToken().catch(() => null);
  const verdict = await loadEdition(RPC_ENDPOINT, key);
  if (!verdict.ok) throw new Error(verdict.reason);
  const [display, anomaly] = await Promise.all([
    editionDisplay(cluster, verdict),
    copiesLine(RPC_ENDPOINT, verdict).catch(() => null),
  ]);
  return asCollectable(display, anomaly);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type CollectEligibility = "collect" | "already" | "soldOut" | "needsGenesis" | "unavailable";

export interface CollectState {
  eligibility: CollectEligibility;
  /** The copy this wallet holds, when it holds one. */
  number?: number;
  reason?: string;
}

const PUBLISHER = "You published this edition and hold copy 1.";
const BLOCKED = "This wallet cannot claim this edition: its claim record's address is taken.";

/** May this wallet claim, and what is in the way? Never throws. */
export async function getCollectState(c: Collectable, wallet: string): Promise<CollectState> {
  try {
    address(wallet);
    const e = c.chain;
    const held = await copiesHeld(RPC_ENDPOINT, e.collection, wallet).catch(() => []);
    const number = held.find((copy) => copy.edition !== null)?.edition ?? undefined;
    const mine = number !== undefined ? { number } : {};
    if (wallet === e.publisher) return { eligibility: "already", ...mine, reason: PUBLISHER };
    if (e.onePerWallet) {
      const status = claimStatus(e, await fetchAccount(RPC_ENDPOINT, await counterAddress(e, address(wallet))));
      if (status === "claimed") return { eligibility: "already", ...mine, reason: words.already };
      if (status === "blocked") return { eligibility: "unavailable", reason: BLOCKED };
    } else {
      // The co-signer decides; this only spares a wallet with no token the sign-in.
      const key = await cosignerKey();
      if (!key) return { eligibility: "unavailable", reason: "The Seeker co-signer cannot be reached. Try again shortly." };
      if (key !== e.cosigner) return { eligibility: "unavailable", reason: "This edition names a co-signer this app does not use." };
      if ((await publisherGenesisMint(wallet)) === null) return { eligibility: "needsGenesis", ...mine, reason: words.needsGenesis };
    }
    if (e.soldOut) return { eligibility: "soldOut", ...mine, reason: words.soldOut };
    return { eligibility: "collect", ...mine };
  } catch (error) {
    return { eligibility: "unavailable", reason: safeErrorText(error) };
  }
}

// ---------------------------------------------------------------------------
// Quoting and collecting
// ---------------------------------------------------------------------------

/** What the review shows, in the shape `CostEstimate` reads. */
export interface CollectEstimate {
  estimatedLamports: bigint;
  estimateBreakdown: { networkFee: bigint; accountCost: bigint; allowance: bigint };
}

export interface CollectQuote {
  edition: string;
  collector: Address;
  /** The edition as read for this review; the claim is built from exactly this. */
  chain: Edition;
  cost: ClaimCost;
  draft: Draft;
  budgets: Budget[];
  asset: Address;
  payer: Address;
  /** "buy" when a price is paid (SOL or SKR), "collect" when free. */
  kind: "collect" | "buy";
  /** The SOL price; 0n when free or priced in a token. */
  priceLamports: bigint;
  /** The price as the edition states it. */
  price: Price;
  /** Token units the claim moves (token price), else 0n. */
  tokens: bigint;
  prepared: CollectEstimate;
}

/** Thrown when the edition's terms moved since it was read: the sheet re-reads and shows them. */
export class TermsChangedError extends Error {}

const sameTerms = (a: Edition, b: Edition) =>
  JSON.stringify(a.price, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ===
    JSON.stringify(b.price, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) &&
  a.cosigner === b.cosigner && a.publisher === b.publisher;

const FAILURES: Record<string, string> = {
  "sold-out": words.soldOut,
  "already-claimed": words.already,
  "not-enough-sol": NEEDS_SOL,
  "not-enough-tokens": "This wallet does not hold enough of the token this edition asks for.",
  "tokens-frozen": "This wallet's token account is frozen.",
  "needs-cosigner": "This edition is for Seeker holders.",
  closed: "This edition is closed.",
  "publisher-cannot-receive": "The publisher's account cannot receive this payment right now.",
};

/** A claim failure as the sentence a screen shows; terms that moved become `TermsChangedError`. */
function claimError(error: unknown, collector: Address, payer: Address): Error {
  if (!(error instanceof TransactionFailure)) return error instanceof Error ? error : new Error(String(error));
  const reason = claimFailure(error, collector, payer);
  if (reason === "terms-changed") return new TermsChangedError("The price changed. Review the new price.");
  return new Error(FAILURES[reason] ?? error.message);
}

/**
 * Everything checked before the review shows a cost: the edition re-read (and the same terms as
 * shown), this wallet's state, its balance against the client's amounts, and a simulation.
 */
/** The collector's balance of `mint` in its associated token account (0n when it has none). */
async function tokenBalance(owner: Address, mint: Address): Promise<bigint> {
  const account = await fetchAccount(RPC_ENDPOINT, await associatedTokenAddress(owner, mint));
  // SPL Token account: mint (32), owner (32), amount u64 at 64.
  if (!account || account.owner !== TOKEN_PROGRAM || account.bytes.length < 72) return 0n;
  return new DataView(account.bytes.buffer, account.bytes.byteOffset, account.bytes.byteLength).getBigUint64(64, true);
}

export async function prepareCollect(c: Collectable, wallet: string): Promise<CollectQuote> {
  const collector = address(wallet);
  await assertEndpointCluster();
  if (operationInProgress(lock(c.edition.edition)))
    throw new Error("This edition already has a collection in progress. Wait for it to finish.");
  const verdict = await loadEdition(RPC_ENDPOINT, c.edition.edition);
  if (!verdict.ok) throw new Error(verdict.reason);
  if (!sameTerms(verdict, c.chain)) throw new TermsChangedError("The price changed. Review the new price.");
  const state = await getCollectState({ ...c, chain: verdict }, wallet);
  if (state.eligibility !== "collect") throw new Error(state.reason ?? words.unavailable);
  const counter = verdict.onePerWallet ? await fetchAccount(RPC_ENDPOINT, await counterAddress(verdict, collector)) : null;
  const cost = await claimCost(verdict, rent);
  if (!canAfford(await balance(wallet), cost, await rent(0))) throw new Error(NEEDS_SOL);
  if (verdict.price.kind === "token") {
    await loadPriceToken().catch(() => null);
    const held = await tokenBalance(collector, verdict.price.mint);
    if (held < cost.tokens) throw new Error(`This wallet holds ${tokenValue(held)}. A copy costs ${tokenValue(cost.tokens)}.`);
  }
  const [asset, payer, tokenAccount] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  const draft = await claimDraft({
    edition: verdict, counter, cost, collector, asset, payer,
    ...(verdict.price.kind === "token" ? { tokenAccount } : {}),
  });
  let ready;
  try {
    ready = await prepareDraft(draft);
  } catch (error) {
    throw claimError(error, collector, payer.address);
  }
  const networkFee = cost.fees + priorityLamports(ready.budgets);
  const accountCost = cost.payerFunding + networkFee;
  return {
    edition: c.edition.edition,
    collector,
    chain: verdict,
    cost,
    draft,
    budgets: ready.budgets,
    asset: asset.address,
    payer: payer.address,
    kind: verdict.price.kind === "free" ? "collect" : "buy",
    priceLamports: cost.price,
    price: verdict.price,
    tokens: cost.tokens,
    prepared: {
      estimatedLamports: accountCost + FEE_ALLOWANCE_LAMPORTS,
      estimateBreakdown: { networkFee, accountCost, allowance: FEE_ALLOWANCE_LAMPORTS },
    },
  };
}

type CollectProgress = "wallet" | "cosigner" | "confirming";

/**
 * Sign (after Sign-in-with-Solana on a Seeker-only edition), co-sign when needed, send, confirm.
 * Returns the copy number now in this wallet, read off the new copy itself.
 */
export async function sendCollect(
  c: Collectable,
  quote: CollectQuote,
  session: WalletSession,
  onProgress?: (p: CollectProgress) => void,
): Promise<{ number: number }> {
  return exclusive(lock(c.edition.edition), async () => {
    if (quote.edition !== c.edition.edition) throw new Error("The collection review changed. Check this edition again.");
    // The same transaction as reviewed, on a fresh blockhash: the review can outlast one.
    const lifetime = await latestLifetime();
    const ready = withLifetime(quote.draft, quote.budgets, lifetime);
    const seekerOnly = quote.chain.cosigner !== null;
    const challenge = seekerOnly ? await cosignerChallenge(quote.collector) : undefined;
    onProgress?.("wallet");
    const signed = await signWithWallet(session, quote.collector, ready.prepared, challenge);
    let tx = signed.transactions[0];
    if (seekerOnly) {
      onProgress?.("cosigner");
      tx = await cosignClaim({
        wallet: quote.collector,
        nonce: String(challenge!.nonce),
        signInResult: signed.signInResult!,
        edition: quote.edition,
        cluster,
        transaction: tx,
      });
    }
    onProgress?.("confirming");
    try {
      await sendAndConfirm(tx, lifetime.lastValidBlockHeight);
    } catch (error) {
      throw claimError(error, quote.collector, quote.payer);
    }
    const copy = await readHeldCopy(RPC_ENDPOINT, quote.asset, quote.chain.collection);
    if (!copy || copy.edition === null)
      throw new Error("The claim confirmed, but the copy is not visible yet. Check again.");
    return { number: copy.edition };
  });
}