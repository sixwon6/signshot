/**
 * Prices are u64 lamports, never floats. Decimal text is parsed exactly; excess precision and
 * overflow are refused. Zero is free; any other price must be at least the cluster's rent-exempt
 * minimum (`minimumPriceLamports`).
 */
import { request } from "../../publications/rpc";
/** A review's total and the rows it is made of. */
export interface Estimate {
  estimatedLamports: bigint;
  estimateBreakdown: { networkFee: bigint; accountCost: bigint; allowance: bigint };
}

/** 1 SOL = 1,000,000,000 lamports. https://solana.com/docs/references/terminology#lamport */
const LAMPORTS_PER_SOL = 1_000_000_000n;
/** SOL has nine decimal places. */
const SOL_DECIMALS = 9;
/** u64 max. */
export const MAX_PRICE_LAMPORTS = 0xffff_ffff_ffff_ffffn;

const NOT_A_PRICE = "Enter a price in SOL, like 0.25.";
const TOO_PRECISE = "A price in SOL can have at most 9 decimal places.";
const TOO_LARGE = "That price is larger than this app can send.";

/** Digits with at most one point: no sign, exponent or separators. */
const DECIMAL = /^(\d*)(?:\.(\d*))?$/;

/**
 * A typed SOL amount as exact lamports. Empty and "0" are free (`0n`). Throws a displayable
 * sentence for anything else that is not a plain decimal of at most 9 places within u64.
 */
export function parseSolPrice(text: string): bigint {
  if (typeof text !== "string") throw new Error(NOT_A_PRICE);
  const trimmed = text.trim();
  if (!trimmed) return 0n;
  const match = DECIMAL.exec(trimmed);
  // The regex matches "" and "." (both halves optional), so require a digit separately.
  if (!match || !(match[1] || match[2])) throw new Error(NOT_A_PRICE);
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (fraction.length > SOL_DECIMALS) throw new Error(TOO_PRECISE);
  // Huge integer parts fall to the u64 check below, so the error says "too large", not "not a price".
  const lamports =
    BigInt(whole || "0") * LAMPORTS_PER_SOL + BigInt(fraction.padEnd(SOL_DECIMALS, "0") || "0");
  if (lamports > MAX_PRICE_LAMPORTS) throw new Error(TOO_LARGE);
  return lamports;
}

/**
 * Exact SOL string, trailing zeros trimmed, always one decimal place so it can't be misread as
 * lamports: `0n` is "0.0", `1n` is "0.000000001". Inverse of `parseSolPrice`.
 */
export function formatSol(lamports: bigint): string {
  if (typeof lamports !== "bigint" || lamports < 0n || lamports > MAX_PRICE_LAMPORTS)
    throw new Error(TOO_LARGE);
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(SOL_DECIMALS, "0");
  const trimmed = fraction.replace(/0+$/, "");
  return `${whole}.${trimmed || "0"}`;
}

/**
 * The lowest non-zero price: `getMinimumBalanceForRentExemption(0)`. The runtime refuses to leave
 * an empty creator wallet below it. Read per quote, not hardcoded: rent is being lowered in steps
 * (SIMD-0437, https://solana.com/upgrades/reduced-rent).
 */
export async function minimumPriceLamports(endpoint: string): Promise<bigint> {
  const lamports = await request<unknown>(endpoint, "getMinimumBalanceForRentExemption", [0]);
  if (typeof lamports !== "number" || !Number.isSafeInteger(lamports) || lamports < 0)
    throw new Error("Invalid Solana response");
  return BigInt(lamports);
}

/** Returns `lamports` if zero or at least `minimum`; otherwise throws a displayable sentence. */
export function checkPriceMinimum(lamports: bigint, minimum: bigint): bigint {
  if (lamports !== 0n && lamports < minimum)
    throw new Error(`The lowest price is ${formatSol(minimum)} SOL.`);
  return lamports;
}

/**
 * Rows that add up to the estimate. `accountCost` is the payer's whole balance delta, so the
 * network fee and `apart` (a price on its own row) are subtracted from it. Clamped at zero.
 */
export function costRows(
  prepared: Estimate,
  apart = 0n,
) {
  const { networkFee, accountCost, allowance } = prepared.estimateBreakdown;
  const less = (from: bigint, by: bigint) => (from > by ? from - by : 0n);
  return {
    /** What leaves the wallet, `apart` included. */
    total: prepared.estimatedLamports,
    /** Everything but `apart`. */
    cost: less(prepared.estimatedLamports, apart),
    networkFee,
    accounts: less(accountCost, networkFee + apart),
    allowance,
  };
}

/** `parseSolPrice` for a mint with `decimals` places; empty is 0n. */
export function parseUnits(text: string, decimals: number): bigint {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return 0n;
  const match = DECIMAL.exec(trimmed);
  if (!match || !(match[1] || match[2])) throw new Error("Enter an amount, like 100.");
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) throw new Error(`This token has at most ${decimals} decimal places.`);
  const units = BigInt(match[1] || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units > MAX_PRICE_LAMPORTS) throw new Error(TOO_LARGE);
  return units;
}

/** Base units as a decimal string for a mint with `decimals` places, trailing zeros trimmed. */
export function formatUnits(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString();
  const scale = 10n ** BigInt(decimals);
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${units / scale}.${fraction}` : `${units / scale}`;
}
