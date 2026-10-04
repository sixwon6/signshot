/**
 * SOL amounts as text, and as the integer the chain actually stores.
 *
 * The rule: a price is an unsigned integer of lamports, never floating point. A decimal string is
 * parsed in the UI and preserved exactly through review, signing and recovery; unrepresentable
 * precision and overflow are refused. Zero is a free offer, and there is no product minimum. The
 * one floor is the network's: a price above zero must be at least the rent-exempt minimum of an
 * empty account, which `set_offer` reads on chain and refuses below (`PriceTooLow`), and which
 * the client reads from the cluster (`minimumPriceLamports`), never from a constant.
 */
import { request } from "../../publications/rpc";
/** An estimate as the review shows it: the total, and the rows it is made of. */
export interface Estimate {
  estimatedLamports: bigint;
  estimateBreakdown: { networkFee: bigint; accountCost: bigint; allowance: bigint };
}

/** 1 SOL = 1,000,000,000 lamports. https://solana.com/docs/references/terminology#lamport */
const LAMPORTS_PER_SOL = 1_000_000_000n;
/** SOL has nine decimal places; a tenth digit is a lamport fraction, which does not exist. */
const SOL_DECIMALS = 9;
/** `price_lamports` is a Borsh `u64`, so this is the largest price the program can hold. */
export const MAX_PRICE_LAMPORTS = 0xffff_ffff_ffff_ffffn;

const NOT_A_PRICE = "Enter a price in SOL, like 0.25.";
const TOO_PRECISE = "A price in SOL can have at most 9 decimal places.";
const TOO_LARGE = "That price is larger than this app can send.";

/** Digits, optionally split by one point. Nothing else: no sign, no exponent, no separators. */
const DECIMAL = /^(\d*)(?:\.(\d*))?$/;

/**
 * A typed SOL amount as lamports, exactly.
 *
 * Empty text and "0" both mean FREE and answer `0n` — an empty price field is how a creator says
 * "no price", and zero is how the program stores that same intent (`price_lamports == 0` is what
 * `collect` requires and what `buy` refuses with `NotForSale`). Everything else throws a sentence a
 * screen can render: a sign, an exponent, a thousands separator, a bare ".", more than nine
 * fraction digits, or a value past `u64`.
 */
export function parseSolPrice(text: string): bigint {
  if (typeof text !== "string") throw new Error(NOT_A_PRICE);
  const trimmed = text.trim();
  if (!trimmed) return 0n;
  const match = DECIMAL.exec(trimmed);
  // The regex can match "" and "." because both halves are optional, so at least one digit is
  // required separately. That also rejects "-1", "+1", "1e9", "0x10", "1,5" and "1.2.3".
  if (!match || !(match[1] || match[2])) throw new Error(NOT_A_PRICE);
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (fraction.length > SOL_DECIMALS) throw new Error(TOO_PRECISE);
  // A very long integer part is refused by the u64 bound below, not here: BigInt handles it, and
  // the honest refusal is "larger than this app can send", not "not a price".
  const lamports =
    BigInt(whole || "0") * LAMPORTS_PER_SOL + BigInt(fraction.padEnd(SOL_DECIMALS, "0") || "0");
  if (lamports > MAX_PRICE_LAMPORTS) throw new Error(TOO_LARGE);
  return lamports;
}

/**
 * Lamports as a SOL string: the exact value, with trailing zeros trimmed and always at least one
 * decimal place, so a price never renders as a bare integer that could be misread as lamports.
 * `0n` is "0.0", `1n` is "0.000000001", `1_500_000_000n` is "1.5".
 *
 * `parseSolPrice(formatSol(x)) === x` for every representable `x`; this is the display half of the
 * same exact conversion and allocates no float either.
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
 * The lowest price above zero, in lamports: `getMinimumBalanceForRentExemption(0)`, read-only.
 *
 * `buy` pays the price into the creator's wallet, and the runtime refuses to leave an empty wallet
 * holding less than this, so `set_offer` refuses any price between zero and it. Read from the
 * cluster on every quote rather than kept here: rent per byte is being lowered in steps
 * (SIMD-0437, https://solana.com/upgrades/reduced-rent), and the program reads the same rate
 * from the Rent sysvar.
 */
export async function minimumPriceLamports(endpoint: string): Promise<bigint> {
  const lamports = await request<unknown>(endpoint, "getMinimumBalanceForRentExemption", [0]);
  if (typeof lamports !== "number" || !Number.isSafeInteger(lamports) || lamports < 0)
    throw new Error("Invalid Solana response");
  return BigInt(lamports);
}

/**
 * `lamports` when the program will take it as a price against `minimum` (from
 * `minimumPriceLamports`): zero, or at least the minimum. Otherwise throws a sentence a screen can
 * render.
 */
export function checkPriceMinimum(lamports: bigint, minimum: bigint): bigint {
  if (lamports !== 0n && lamports < minimum)
    throw new Error(`The lowest price is ${formatSol(minimum)} SOL.`);
  return lamports;
}

/**
 * An estimate as rows that add up to it. `accountCost` is the payer's whole simulated balance
 * delta, so it already holds the network fee and `apart` — a price or a storage payment shown on a
 * row of its own — and both come out of the accounts row. Rows are clamped at zero.
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

/**
 * A typed token amount as base units, exactly, for a mint with `decimals` places; empty is 0n.
 * The same rules as `parseSolPrice`.
 */
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
