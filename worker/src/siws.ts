/**
 * Sign-in-with-Solana per Solana Mobile's recipe
 * (https://docs.solanamobile.com/recipes/general/detecting-seeker-users): server-issued payload,
 * signed over MWA; nonce must be issued here, unexpired and unused; domain must be this Worker's.
 *
 * Instead of storing payloads, the nonce carries enough to rebuild the issued payload under an
 * HMAC, so /challenge is stateless and the client's copy is never trusted. Spent on first claim.
 *
 *   nonce = hex(16 random bytes) ‖ hex(u32 issuedAt seconds) ‖ hex(HMAC-SHA256(...)[..16])
 *
 * 72 hex chars (SIWS nonces must be alphanumeric). Message check: `deriveSignInMessage`
 * (@solana/wallet-standard-util), as the recipe's `verifySignIn`. Ed25519 via WebCrypto: the
 * pure-JS curve would burn most of the free plan's 10 ms CPU on first call per isolate.
 */

import { getAddressDecoder, getBase64Encoder } from "@solana/kit";
import { deriveSignInMessage } from "@solana/wallet-standard-util";

type SolanaSignInInput = Parameters<typeof deriveSignInMessage>[0];

export const STATEMENT = "Sign in to claim a Seeker edition";
/** The recipe's 10 minutes. */
export const NONCE_TTL_SECONDS = 600;
/** Allowed issuedAt lead over this isolate's clock. */
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

/** Verifies `wallet`'s signature of the payload issued under `nonce`. Does not consume the nonce. */
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
  // Covers the recipe's domain check: `input` carries this Worker's domain.

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
