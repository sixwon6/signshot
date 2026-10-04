/**
 * Sign-in-with-Solana, as Solana Mobile's recipe does it
 * (https://docs.solanamobile.com/recipes/general/detecting-seeker-users): the server issues the
 * payload (domain, statement, uri, nonce, issuedAt, expirationTime), the wallet signs it over
 * Mobile Wallet Adapter, and the server checks that the nonce is one it issued, unexpired and
 * unused, that the signature is valid for the issued payload, and that the domain is its own.
 *
 * The recipe stores each issued payload keyed by its nonce. Here the nonce carries what is needed
 * to rebuild the issued payload exactly, under an HMAC, so the payload is still the server's own
 * and never the client's copy, and /challenge writes nothing. A nonce is consumed (a primary-key
 * insert) the first time a claim spends it.
 *
 *   nonce = hex(16 random bytes) ‖ hex(u32 issuedAt seconds) ‖ hex(HMAC-SHA256(...)[..16])
 *
 * 72 hex characters: alphanumeric, as the SIWS nonce must be.
 *
 * The message checks are `deriveSignInMessage` from `@solana/wallet-standard-util` — the code
 * the recipe's `verifySignIn` runs — and the ed25519 check is WebCrypto rather than the pure-JS
 * curve `verifySignIn` carries, which would spend most of the free plan's 10 ms CPU on its first
 * call in each isolate.
 */

import { getAddressDecoder, getBase64Encoder } from "@solana/kit";
import { deriveSignInMessage } from "@solana/wallet-standard-util";

type SolanaSignInInput = Parameters<typeof deriveSignInMessage>[0];

export const STATEMENT = "Sign in to claim a Seeker edition";
/** The recipe's 10 minutes. */
export const NONCE_TTL_SECONDS = 600;
/** How far ahead of this Worker's clock an issuedAt may sit (another isolate's clock). */
const CLOCK_SKEW_SECONDS = 60;

export interface SiwsConfig { domain: string; uri: string; hmacSecret: string }

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false,
    ["sign", "verify"]);
}

const macInput = (c: SiwsConfig, wallet: string, random: string, issuedAt: number) =>
  new TextEncoder().encode(`signshot-siws/1\n${c.domain}\n${c.uri}\n${wallet}\n${random}\n${issuedAt}`);

function payload(c: SiwsConfig, wallet: string, nonce: string, issuedAt: number): SolanaSignInInput {
  return {
    domain: c.domain,
    statement: STATEMENT,
    uri: c.uri,
    address: wallet,
    nonce,
    issuedAt: new Date(issuedAt * 1000).toISOString(),
    expirationTime: new Date((issuedAt + NONCE_TTL_SECONDS) * 1000).toISOString(),
  };
}

/** The sign-in payload for `wallet`, issued at `nowMs`. */
export async function issueChallenge(c: SiwsConfig, wallet: string, nowMs: number): Promise<SolanaSignInInput> {
  const random = hex(crypto.getRandomValues(new Uint8Array(16)));
  const issuedAt = Math.floor(nowMs / 1000);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(c.hmacSecret), macInput(c, wallet, random, issuedAt)));
  const nonce = random + issuedAt.toString(16).padStart(8, "0") + hex(mac.subarray(0, 16));
  return payload(c, wallet, nonce, issuedAt);
}

/** MWA's `sign_in_result`: base64 `address`, `signed_message`, `signature`. */
export interface SignInResult { address: string; signed_message: string; signature: string }

export type SignInFailure = "nonce-invalid" | "nonce-expired" | "signature-invalid";

/**
 * The issued payload's nonce and expiry when `result` is `wallet`'s valid signature of the
 * payload this Worker issued under `nonce`, or the reason it is not. Does not consume the nonce.
 */
export async function verifySignIn(
  c: SiwsConfig,
  wallet: string,
  nonce: string,
  result: SignInResult,
  nowMs: number,
): Promise<{ ok: true; expiresAt: number } | { ok: false; reason: SignInFailure }> {
  if (!/^[0-9a-f]{72}$/.test(nonce)) return { ok: false, reason: "nonce-invalid" };
  const random = nonce.slice(0, 32);
  const issuedAt = parseInt(nonce.slice(32, 40), 16);
  const mac = unhex(nonce.slice(40));
  const full = await crypto.subtle.sign("HMAC", await hmacKey(c.hmacSecret), macInput(c, wallet, random, issuedAt));
  if (!timingSafeEqual(new Uint8Array(full).subarray(0, 16), mac)) return { ok: false, reason: "nonce-invalid" };
  const now = nowMs / 1000;
  const expiresAt = issuedAt + NONCE_TTL_SECONDS;
  if (issuedAt > now + CLOCK_SKEW_SECONDS || now >= expiresAt) return { ok: false, reason: "nonce-expired" };

  // The recipe's conversion of MWA's base64 fields into `SolanaSignInOutput`.
  let publicKey: Uint8Array, signature: Uint8Array, signedMessage: Uint8Array;
  try {
    const b64 = getBase64Encoder();
    publicKey = new Uint8Array(b64.encode(result.address));
    signature = new Uint8Array(b64.encode(result.signature));
    signedMessage = new Uint8Array(b64.encode(result.signed_message));
  } catch {
    return { ok: false, reason: "signature-invalid" };
  }
  if (publicKey.length !== 32 || signature.length !== 64 || signedMessage.length > 2048)
    return { ok: false, reason: "signature-invalid" };
  const address = getAddressDecoder().decode(publicKey);
  if (address !== wallet) return { ok: false, reason: "signature-invalid" };

  const input = payload(c, wallet, nonce, issuedAt);
  const output = { account: { address, publicKey, chains: [], features: [] }, signature, signedMessage };
  const expected = deriveSignInMessage(input, output);
  if (!expected || !timingSafeEqual(expected, signedMessage)) return { ok: false, reason: "signature-invalid" };
  // The recipe's domain check is inside: `input` is rebuilt with this Worker's domain, and the
  // signed message's domain (and every other field) has just been required equal to it.

  let valid = false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, signedMessage);
  } catch {
    valid = false;
  }
  return valid ? { ok: true, expiresAt } : { ok: false, reason: "signature-invalid" };
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}
