/**
 * Third Party Signer keys: 64-byte solana-keygen arrays (32-byte seed, then public key), imported
 * once per isolate as non-extractable Ed25519 keys. `createKeyPairFromBytes` rejects mismatched halves.
 *
 *   COSIGNER_SECRET_KEY    the ACTIVE key, named by /health for new editions.
 *   COSIGNER_SECRET_KEYS   optional JSON array of further ACCEPTED keys.
 *
 * A claim is co-signed with whichever accepted key its edition's guard names. To rotate: add the
 * new key, make it active, keep the old one accepted until no open edition names it.
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
