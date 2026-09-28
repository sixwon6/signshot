import * as SecureStore from "expo-secure-store";
import { ed25519 } from "@noble/curves/ed25519.js";

import { base58Encode, fromHex, toHex } from "./codec";
import { OWNER_LENGTH, SIGNATURE_LENGTH, type DataItemSigner } from "./dataItem";

/**
 * Per-wallet ed25519 key that signs Turbo uploads, kept in SecureStore (Keystore-encrypted). One
 * key per wallet, not per install, so a public `owner` never links two wallets. It holds no SOL: on
 * mainnet its base58 address holds the Turbo credit each publication transaction buys for it
 * (`publications/storage.ts`), and devnet uploads ride the free tier. The secret bytes never leave
 * this module.
 */

/** SecureStore rejects `:` in keys, so this namespace uses a `.` separator. */
const UPLOAD_KEY_SECURE_PREFIX = "es.uploadKey.v1";

/**
 * The Keystore alias for this seed. Its own service so another SecureStore entry that uses
 * `requireAuthentication` cannot invalidate this key; changing it would make the seed unreadable.
 */
const UPLOAD_KEY_KEYCHAIN_SERVICE = "es.uploadKey";

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: UPLOAD_KEY_KEYCHAIN_SERVICE,
};

/** 32-byte ed25519 seed, lowercase hex. 64 characters — far under any SecureStore size limit. */
const SECRET_HEX = /^[0-9a-f]{64}$/;

/** A base58 Solana address: 32 bytes, so 32..44 characters of the Bitcoin alphabet. */
const WALLET_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function assertWallet(wallet: string): void {
  if (!WALLET_ADDRESS.test(wallet)) {
    throw new Error(`uploadKey: "${wallet}" is not a base58 wallet address`);
  }
}

/** The SecureStore key for `wallet`; base58 always satisfies SecureStore's `/^[\w.-]+$/`. */
function uploadKeySecureStoreKey(wallet: string): string {
  assertWallet(wallet);
  return `${UPLOAD_KEY_SECURE_PREFIX}.${wallet}`;
}

interface UploadKey extends DataItemSigner {
  /** The 32-byte ed25519 public key — a data item's `owner`. */
  publicKey: Uint8Array;
  /** Detached 64-byte signature over `message`. Synchronous, like the rest of this module. */
  sign(message: Uint8Array): Uint8Array;
  /** base58 of `publicKey`. */
  ownerBase58: string;
}

/**
 * One in-flight load per wallet, so concurrent callers cannot each generate and store a different
 * key. Keyed by wallet so a wallet switch never returns the other wallet's key.
 */
const inFlight = new Map<string, Promise<UploadKey>>();
const cached = new Map<string, UploadKey>();

function makeKey(secret: Uint8Array): UploadKey {
  const publicKey = Uint8Array.from(ed25519.getPublicKey(secret));
  if (publicKey.length !== OWNER_LENGTH) {
    throw new Error(`uploadKey: derived a ${publicKey.length}-byte public key`);
  }
  const ownerBase58 = base58Encode(publicKey);

  return {
    publicKey,
    ownerBase58,
    sign(message: Uint8Array): Uint8Array {
      const signature = Uint8Array.from(ed25519.sign(message, secret));
      if (signature.length !== SIGNATURE_LENGTH) {
        throw new Error(`uploadKey: produced a ${signature.length}-byte signature`);
      }
      return signature;
    },
  };
}

/**
 * A stored string turned into seed bytes, or a refusal. A corrupt seed is never silently replaced:
 * items signed by it may already be referenced on chain.
 */
function parseSeed(stored: string, where: string): Uint8Array {
  const hex = stored.trim();
  if (!SECRET_HEX.test(hex)) {
    throw new Error(
      `uploadKey: ${where} holds ${hex.length} characters that are not a 64-character hex ` +
        `seed. Refusing to replace it — clear the key deliberately if that is what you mean to do.`,
    );
  }
  return fromHex(hex);
}

async function load(secureKey: string): Promise<UploadKey> {
  // A rejection propagates: `getItemAsync` already returns null for undecryptable entries, so a
  // throw means the store itself is broken, and generating a new key would silently swap identity.
  const stored = await SecureStore.getItemAsync(secureKey, SECURE_STORE_OPTIONS);
  if (stored !== null) {
    return makeKey(parseSeed(stored, `SecureStore ${secureKey}`));
  }

  const secret = Uint8Array.from(ed25519.utils.randomSecretKey());
  if (secret.length !== 32) throw new Error(`uploadKey: generated a ${secret.length}-byte seed`);
  await SecureStore.setItemAsync(secureKey, toHex(secret), SECURE_STORE_OPTIONS);
  return makeKey(secret);
}

/**
 * `wallet`'s upload key, created on first use. Cached in memory per wallet, since each SecureStore
 * read is a Keystore decrypt inside a wallet session.
 */
export async function getUploadKey(wallet: string): Promise<UploadKey> {
  const secureKey = uploadKeySecureStoreKey(wallet);

  const hit = cached.get(secureKey);
  if (hit !== undefined) return hit;

  const pending = inFlight.get(secureKey);
  if (pending !== undefined) return pending;

  const started = load(secureKey)
    .then((key) => {
      cached.set(secureKey, key);
      return key;
    })
    .finally(() => {
      inFlight.delete(secureKey);
    });
  inFlight.set(secureKey, started);
  return started;
}

/** The base58 address of `wallet`'s upload key, or `null` when none is stored. Never creates one. */
export async function uploadKeyAddress(wallet: string): Promise<string | null> {
  const secureKey = uploadKeySecureStoreKey(wallet);
  const hit = cached.get(secureKey);
  if (hit !== undefined) return hit.ownerBase58;
  const stored = await SecureStore.getItemAsync(secureKey, SECURE_STORE_OPTIONS);
  return stored === null ? null : makeKey(parseSeed(stored, `SecureStore ${secureKey}`)).ownerBase58;
}

/**
 * Remove this wallet's upload seed. SecureStore's Android preference key names the wallet in
 * cleartext, so forgetting a wallet must delete it. Only safe when no upload is still owed: a
 * regenerated key cannot reproduce item ids already referenced on chain. Unspent storage credit
 * (the headroom above each quote) would stay with the deleted key's address, so Settings keeps a
 * key that holds any (`storageCreditHeld`).
 */
export async function deleteUploadKey(wallet: string): Promise<void> {
  const secureKey = uploadKeySecureStoreKey(wallet);
  cached.delete(secureKey);
  await SecureStore.deleteItemAsync(secureKey, SECURE_STORE_OPTIONS);
}
