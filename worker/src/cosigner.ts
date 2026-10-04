/**
 * The Third Party Signer keys. Each is a 64-byte solana-keygen key (a JSON array: the 32-byte
 * seed, then the public key), imported once per isolate as a non-extractable WebCrypto Ed25519
 * key; `createKeyPairFromBytes` refuses a secret whose two halves do not belong together.
 *
 *   COSIGNER_SECRET_KEY    the ACTIVE key: the one /health names for new editions.
 *   COSIGNER_SECRET_KEYS   optional: a JSON array of further ACCEPTED keys.
 *
 * A guard names exactly one key, and a claim is co-signed with whichever accepted key the
 * edition's guard names. Rotation therefore overlaps: add the new key, make it active, and keep
 * the old one accepted until no open edition names it (the app's `setPriceDraft` re-encodes an
 * edition's current co-signer, so existing editions keep their key until they close).
 */

import { createKeyPairFromBytes, getAddressFromPublicKey, signBytes } from "@solana/kit";

export interface Cosigner { address: string; sign(message: Uint8Array): Promise<Uint8Array> }
export interface Cosigners { active: Cosigner; accepted: Map<string, Cosigner> }

let cached: { secrets: string; cosigners: Promise<Cosigners> } | undefined;

export function loadCosigners(active: string, others: string | undefined): Promise<Cosigners> {
  const secrets = `${active}\n${others ?? ""}`;
  if (cached?.secrets !== secrets) cached = { secrets, cosigners: importAll(active, others) };
  const mine = cached;
  mine.cosigners.catch(() => { if (cached === mine) cached = undefined; });
  return mine.cosigners;
}

async function importAll(active: string, others: string | undefined): Promise<Cosigners> {
  const first = await importCosigner(parseKey(active));
  const accepted = new Map([[first.address, first]]);
  if (others) {
    let list: unknown;
    try {
      list = JSON.parse(others);
    } catch {
      throw new Error("COSIGNER_SECRET_KEYS is not a JSON array of keys");
    }
    if (!Array.isArray(list)) throw new Error("COSIGNER_SECRET_KEYS is not a JSON array of keys");
    for (const entry of list) {
      const c = await importCosigner(parseKey(entry));
      accepted.set(c.address, c);
    }
  }
  return { active: first, accepted };
}

function parseKey(value: unknown): Uint8Array {
  let parsed = value;
  try {
    if (typeof value === "string") parsed = JSON.parse(value);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255))
    throw new Error("A co-signer key is not a 64-byte solana-keygen key");
  return new Uint8Array(parsed);
}

async function importCosigner(bytes: Uint8Array): Promise<Cosigner> {
  const pair = await createKeyPairFromBytes(bytes, false);
  bytes.fill(0);
  const address = await getAddressFromPublicKey(pair.publicKey);
  return { address, sign: async (message) => new Uint8Array(await signBytes(pair.privateKey, message)) };
}
