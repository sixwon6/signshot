/**
 * The one token a copy can be priced in besides SOL, per cluster:
 *   mainnet-beta  Solana Mobile's SKR, classic SPL Token, 6 decimals (read from the mint);
 *   devnet        an optional stand-in mint, `EXPO_PUBLIC_PRICE_TOKEN_MINT`; unset, no token price.
 * Shown as "SKR" either way; the devnet badge beside every price says which chain it is on.
 */

import { address, type Address } from "@solana/kit";
import type { Price } from "../../publications/candy/edition";
import { TOKEN_PROGRAM } from "../../publications/candy/programs";
import { fetchAccount } from "../../publications/editions";
import { CLUSTER_NAME as cluster, RPC_ENDPOINT } from "../solana/cluster";
import { price as priceCopy } from "../ui/copy";
import { formatSol, formatUnits } from "./price";

export const SKR_MINT = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";
export const TOKEN_LABEL = "SKR";
const SKR_DECIMALS = 6;

function configuredMint(): Address | null {
  if (cluster === "mainnet-beta") return address(SKR_MINT);
  const standIn = (process.env.EXPO_PUBLIC_PRICE_TOKEN_MINT ?? "").trim();
  try {
    return standIn ? address(standIn) : null;
  } catch {
    return null;
  }
}

const MINT = configuredMint();
let decimals: number | null = cluster === "mainnet-beta" ? SKR_DECIMALS : null;
let loaded: Promise<PriceToken | null> | null = null;

export interface PriceToken { mint: Address; decimals: number; label: string }

/** This build's price token, if any (sync; decimals known once `loadPriceToken` has run on devnet). */
export function priceToken(): PriceToken | null {
  return MINT && decimals !== null ? { mint: MINT, decimals, label: TOKEN_LABEL } : null;
}

/** Read the mint once: a classic SPL Token mint, initialized, with the expected decimals on mainnet. */
export function loadPriceToken(): Promise<PriceToken | null> {
  if (!MINT) return Promise.resolve(null);
  loaded ??= (async () => {
    const mint = await fetchAccount(RPC_ENDPOINT, MINT);
    // SPL Mint: mint authority (36), supply (8), decimals at 44, is_initialized at 45; 82 bytes.
    if (!mint || mint.owner !== TOKEN_PROGRAM || mint.bytes.length !== 82 || mint.bytes[45] !== 1)
      throw new Error("The price token's mint is not a classic SPL Token mint on this network.");
    const read = mint.bytes[44];
    if (cluster === "mainnet-beta" && read !== SKR_DECIMALS) throw new Error("SKR's mint does not have 6 decimals.");
    decimals = read;
    return priceToken();
  })();
  loaded.catch(() => { loaded = null; });
  return loaded;
}

/** A price as a screen shows it: "0.25 SOL", "100 SKR", or "Free". */
export function priceValue(price: Price | null | undefined): string {
  if (!price || price.kind === "free") return priceCopy.free;
  if (price.kind === "sol") return priceCopy.value(formatSol(price.lamports));
  const token = priceToken();
  if (token && price.mint === token.mint) return `${formatUnits(price.amount, token.decimals)} ${token.label}`;
  return `${price.amount} units of ${price.mint.slice(0, 4)}…${price.mint.slice(-4)}`;
}

/** A token amount of this build's price token as text ("100 SKR"). */
export function tokenValue(amount: bigint): string {
  const token = priceToken();
  return token ? `${formatUnits(amount, token.decimals)} ${token.label}` : `${amount} units`;
}

/** The price for an amount typed in `unit`, or free when zero. */
export function priceOf(unit: "sol" | "token", amount: bigint): Price {
  if (amount === 0n) return { kind: "free" };
  if (unit === "sol") return { kind: "sol", lamports: amount };
  const token = priceToken();
  if (!token) throw new Error("SKR prices are not available on this network.");
  return { kind: "token", mint: token.mint, amount, tokenProgram: TOKEN_PROGRAM };
}
