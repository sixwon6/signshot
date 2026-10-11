/**
 * The publisher's controls after publishing: a new price (`setPriceDraft`) and closing the sale
 * (`closeDraft`), each one transaction through the shared send path. Keyed by edition (the candy
 * machine), so an edition published from another phone can be priced here too. Success is the
 * re-read edition, never the signature.
 */

import { address, type Address } from "@solana/kit";
import { RPC_ENDPOINT, CLUSTER_NAME as cluster, assertEndpointCluster } from "../solana/cluster";
import type { WalletSession } from "../solana/walletSession";
import { closeDraft, setPriceDraft, SIGNATURE_FEE, type Edition, type Price } from "../../publications/candy/edition";
import { CANDY_GUARD_HEADER, TOKEN_ACCOUNT_BYTES, associatedTokenAddress, candyGuardAddress } from "../../publications/candy/programs";
import { loadPriceToken } from "./priceToken";
import { encodeGuardData } from "../../publications/candy/guards";
import { editionGuards } from "../../publications/candy/edition";
import type { Budget, Draft } from "../../publications/candy/transactions";
import { copiesLine, fetchAccount, loadEdition } from "../../publications/editions";
import { FEE_ALLOWANCE_LAMPORTS } from "../../publications/rpc";
import type { CoreMetadata } from "../../publications/types";
import { checkPriceMinimum, MAX_PRICE_LAMPORTS, minimumPriceLamports, type Estimate } from "./price";
import { exclusive, operationInProgress } from "./locks";
import { latestLifetime, prepareDraft, priorityLamports, rent, sendAndConfirm, signWithWallet, withLifetime } from "./send";

const NOT_THE_PUBLISHER = "Only the publisher can change the price.";

const lock = (edition: string) => `offer:${cluster}:${edition}`;
export const isOfferWorking = (edition: string) => operationInProgress(lock(edition));

/** The price of a copy (SOL or SKR); null is free. */
export type EditionOffer = Price;

const offerOf = (e: Edition): EditionOffer | null => (e.price.kind === "free" ? null : e.price);
const sameTerms = (a: Price | null, b: Price | null) => priceKey(a) === priceKey(b);
const priceKey = (p: Price | null) =>
  !p || p.kind === "free" ? "free" : p.kind === "sol" ? `sol:${p.lamports}` : `token:${p.mint}:${p.amount}`;

/**
 * What this edition asks for a copy now. `supported` is false for an edition this app cannot price
 * (closed or not accepted), with the reason.
 */
export async function getOffer(e: CoreMetadata): Promise<{
  supported: boolean; offer: EditionOffer | null; reason?: string;
  minted?: number; seekerOnly?: boolean; anomaly?: string | null;
}> {
  address(e.edition);
  await assertEndpointCluster();
  const verdict = await loadEdition(RPC_ENDPOINT, e.edition);
  if (!verdict.ok) return { supported: false, offer: null, reason: verdict.reason };
  const facts = {
    minted: verdict.minted,
    seekerOnly: verdict.cosigner !== null,
    anomaly: await copiesLine(RPC_ENDPOINT, verdict).catch(() => null),
  };
  await loadPriceToken().catch(() => null);
  return { supported: true, offer: offerOf(verdict), ...facts };
}

export interface OfferQuote {
  edition: string;
  action: "price" | "close";
  /** The price this quote sets (free for closing). */
  price: Price;
  publisher: Address;
  draft: Draft;
  budgets: Budget[];
  prepared: Estimate;
}

async function publisherEdition(e: CoreMetadata): Promise<Edition> {
  await assertEndpointCluster();
  if (operationInProgress(lock(e.edition))) throw new Error("This edition already has a price change in progress.");
  const verdict = await loadEdition(RPC_ENDPOINT, e.edition);
  if (!verdict.ok) throw new Error(verdict.reason);
  if (verdict.publisher !== e.creator) throw new Error(NOT_THE_PUBLISHER);
  return verdict;
}

async function quote(e: Edition, action: OfferQuote["action"], price: Price, draft: Draft, rentDelta: bigint): Promise<OfferQuote> {
  const ready = await prepareDraft(draft);
  const networkFee = SIGNATURE_FEE + priorityLamports(ready.budgets);
  const accountCost = networkFee + (rentDelta > 0n ? rentDelta : 0n);
  return {
    edition: e.candyMachine, action, price, publisher: e.publisher, draft, budgets: ready.budgets,
    prepared: { estimatedLamports: accountCost + FEE_ALLOWANCE_LAMPORTS, estimateBreakdown: { networkFee, accountCost, allowance: FEE_ALLOWANCE_LAMPORTS } },
  };
}

/** A new price (SOL, SKR or free), simulated and costed. Nothing is signed. */
export async function prepareOffer(e: CoreMetadata, price: Price): Promise<OfferQuote> {
  if (price.kind === "sol") {
    if (price.lamports > MAX_PRICE_LAMPORTS) throw new Error("That price cannot be published.");
    checkPriceMinimum(price.lamports, await minimumPriceLamports(RPC_ENDPOINT));
  }
  if (price.kind === "token" && price.mint !== (await loadPriceToken())?.mint)
    throw new Error("SKR prices are not available on this network.");
  const verdict = await publisherEdition(e);
  const draft = await setPriceDraft({ publisher: verdict.publisher, edition: verdict, price });
  // The guard grows or shrinks to fit its new set; the publisher pays or receives the difference.
  const size = CANDY_GUARD_HEADER + encodeGuardData(await editionGuards(verdict.publisher, price, verdict.cosigner)).length;
  const guard = await fetchAccount(RPC_ENDPOINT, await candyGuardAddress(verdict.candyMachine));
  let rentDelta = (await rent(size)) - (guard?.lamports ?? 0n);
  // A token price: the same transaction creates the publisher's token account, if missing.
  if (price.kind === "token" && !(await fetchAccount(RPC_ENDPOINT, await associatedTokenAddress(verdict.publisher, price.mint))))
    rentDelta += await rent(TOKEN_ACCOUNT_BYTES);
  return quote(verdict, "price", price, draft, rentDelta);
}

/** Closing the sale: the guard is withdrawn and its rent returns to the publisher. */
export async function prepareClose(e: CoreMetadata): Promise<OfferQuote> {
  const verdict = await publisherEdition(e);
  return quote(verdict, "close", { kind: "free" }, closeDraft({ publisher: verdict.publisher, candyGuard: verdict.candyGuard }), 0n);
}

type OfferProgress = "wallet" | "confirming";

export { sameTerms as samePrice };

/** Sign, send, confirm, then check the edition reads as approved. */
export async function sendOffer(
  e: CoreMetadata,
  q: OfferQuote,
  session: WalletSession,
  onProgress?: (p: OfferProgress) => void,
): Promise<EditionOffer | null> {
  return exclusive(lock(e.edition), async () => {
    if (q.edition !== e.edition) throw new Error("The price review changed. Check this edition again.");
    const lifetime = await latestLifetime();
    const ready = withLifetime(q.draft, q.budgets, lifetime);
    onProgress?.("wallet");
    const [tx] = (await signWithWallet(session, q.publisher, ready.prepared)).transactions;
    onProgress?.("confirming");
    await sendAndConfirm(tx, lifetime.lastValidBlockHeight);
    const after = await loadEdition(RPC_ENDPOINT, e.edition);
    if (q.action === "close") {
      if (after.ok) throw new Error("The transaction confirmed, but the edition still reads as open. Check again.");
      return null;
    }
    if (!after.ok) throw new Error(after.reason);
    const now = offerOf(after);
    if (!sameTerms(now, q.price))
      throw new Error("The transaction confirmed, but this edition's price is not the one reviewed. Check it again.");
    return now;
  });
}
