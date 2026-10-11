/** Client for the co-signer Worker (`worker/README.md`): `/health`, `/challenge`, `/claim`. */

import { address, type Address, type Transaction } from "@solana/kit";
import { fromWire, toWire } from "../prints/send";
import type { SignInResult } from "../solana/liveAuthorize";
import type { Cluster } from "../../publications/types";

const BASE = (process.env.EXPO_PUBLIC_SEEKER_COSIGNER_URL ?? "").trim().replace(/\/+$/, "");

export const cosignerConfigured = () => /^https:\/\//.test(BASE);

async function call<T>(path: string, init?: { body: unknown }, timeoutMs = 20_000): Promise<{ status: number; body: T }> {
  if (!cosignerConfigured()) throw new Error("Seeker holders only is not available in this build.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method: init ? "POST" : "GET",
      headers: init ? { "Content-Type": "application/json" } : undefined,
      body: init ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as T;
    return { status: response.status, body };
  } catch {
    throw new Error("The Seeker co-signer cannot be reached. Check the connection and try again.");
  } finally {
    clearTimeout(timer);
  }
}

let cached: { active: Address; accepted: Address[] } | null = null;
async function cosignerKeys() {
  if (cached) return cached;
  if (!cosignerConfigured()) return null;
  try {
    const { status, body } = await call<{ signer?: unknown; accepted?: unknown }>("/health", undefined, 5_000);
    if (status !== 200 || typeof body?.signer !== "string") return null;
    const active = address(body.signer);
    const accepted = Array.isArray(body.accepted) ? body.accepted.filter((k): k is string => typeof k === "string").map((k) => address(k)) : [];
    cached = { active, accepted: accepted.includes(active) ? accepted : [active, ...accepted] };
    return cached;
  } catch {
    return null;
  }
}

/** Key new editions name; null when unconfigured or unreachable. */
export const cosignerKey = async (): Promise<Address | null> => (await cosignerKeys())?.active ?? null;

/** True for the active key or one retained across a rotation; null when unreachable. */
export const cosignerAccepts = async (key: Address): Promise<boolean | null> => (await cosignerKeys())?.accepted.includes(key) ?? null;

/** SIWS input for `wallet`; pass it to the wallet unmodified. */
export async function cosignerChallenge(wallet: string): Promise<Record<string, unknown>> {
  const { status, body } = await call<Record<string, unknown> & { error?: string }>("/challenge", { body: { wallet } });
  if (status !== 200 || !body || typeof body.nonce !== "string" || body.address !== wallet)
    throw new Error(refusal(body?.error));
  return body;
}

const REFUSALS: Record<string, string> = {
  "no-genesis-token": "This wallet holds no Seeker Genesis Token. Seeker holders only.",
  "genesis-used": "This wallet's Seeker Genesis Token has already collected this edition.",
  "genesis-pending": "A claim with this Seeker Genesis Token may still land. Wait a minute, then try again.",
  "nonce-invalid": "Sign-in failed. Try again.",
  "nonce-expired": "Sign-in expired. Try again.",
  "nonce-used": "Sign-in was already used. Try again.",
  "signature-invalid": "Sign-in failed. Try again.",
  "blockhash-invalid": "The claim expired before the co-signer saw it. Try again.",
  "rate-limited": "Too many requests. Wait a minute, then try again.",
  "rpc-unavailable": "The co-signer cannot reach Solana right now. Try again shortly.",
  "too-many-tokens": "This wallet holds too many tokens for the co-signer to check.",
};

function refusal(code?: string, reason?: string) {
  if (code === "transaction-refused") return `The co-signer refused this claim${reason ? ` (${reason})` : ""}.`;
  return (code && REFUSALS[code]) ?? `The co-signer refused this claim${code ? ` (${code})` : ""}.`;
}

/** Returns the co-signed claim after checking the Worker didn't alter the message. */
export async function cosignClaim(input: {
  wallet: string;
  nonce: string;
  signInResult: SignInResult;
  edition: string;
  cluster: Cluster;
  transaction: Transaction;
}): Promise<Transaction> {
  const { address: a, signed_message, signature } = input.signInResult;
  const { status, body } = await call<{ transaction?: unknown; error?: string; reason?: string }>("/claim", {
    body: {
      wallet: input.wallet,
      nonce: input.nonce,
      signInOutput: { address: a, signed_message, signature },
      edition: input.edition,
      cluster: input.cluster,
      transaction: toWire(input.transaction),
    },
  });
  if (status !== 200 || typeof body?.transaction !== "string") throw new Error(refusal(body?.error, body?.reason));
  const signed = fromWire(body.transaction);
  const same = signed.messageBytes.length === input.transaction.messageBytes.length &&
    signed.messageBytes.every((b, i) => b === input.transaction.messageBytes[i]);
  if (!same) throw new Error("The co-signer returned a different transaction. Nothing was sent.");
  return signed;
}
