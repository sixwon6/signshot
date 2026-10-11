import * as SecureStore from "expo-secure-store";
import { ed25519 } from "@noble/curves/ed25519.js";

import { base58Encode, fromHex, toHex } from "./codec";
import { OWNER_LENGTH, SIGNATURE_LENGTH, type DataItemSigner } from "./dataItem";

/**
 * Per-wallet ed25519 key that signs Turbo uploads, in SecureStore. Per wallet, not per install, so a
 * public `owner` never links two wallets. Holds Turbo credit, never SOL (`publications/storage.ts`).
 * The secret never leaves this module.
 */

/** SecureStore rejects `:` in keys, so this namespace uses a `.` separator. */
const UPLOAD_KEY_SECURE_PREFIX = "es.uploadKey.v1";

/**
 * Own service so an entry using `requireAuthentication` can't invalidate this key. Changing it
 * makes existing seeds unreadable.
 */
const UPLOAD_KEY_KEYCHAIN_SERVICE = "es.uploadKey";

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: UPLOAD_KEY_KEYCHAIN_SERVICE,
};

/** 32-byte ed25519 seed, lowercase hex. */
const SECRET_HEX = /^[0-9a-f]{64}$/;

const WALLET_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function assertWallet(wallet: string): void {
  if (!WALLET_ADDRESS.test(wallet)) {
    throw new Error(`uploadKey: "${wallet}" is not a base58 wallet address`);
  }
}

/** Base58 always satisfies SecureStore's `/^[\w.-]+$/`. */
function uploadKeySecureStoreKey(wallet: string): string {
  assertWallet(wallet);
  return `${UPLOAD_KEY_SECURE_PREFIX}.${wallet}`;
}

interface UploadKey extends DataItemSigner {
  /** A data item's `owner`. */
  publicKey: Uint8Array;
  /** Detached 64-byte signature. */
  sign(message: Uint8Array): Uint8Array;
  ownerBase58: string;
}

/** One load per wallet, so concurrent callers can't each generate a different key. */
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

/** Never silently replace a corrupt seed: items it signed may already be referenced on chain. */
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
  // Let rejections propagate: SecureStore reads an invalidated or pre-reinstall entry as null and
  // throws on any other failure, where a new key would silently swap identity.
  const stored = await SecureStore.getItemAsync(secureKey, SECURE_STORE_OPTIONS);
  if (stored !== null) {
    return makeKey(parseSeed(stored, `SecureStore ${secureKey}`));
  }

  const secret = Uint8Array.from(ed25519.utils.randomSecretKey());
  if (secret.length !== 32) throw new Error(`uploadKey: generated a ${secret.length}-byte seed`);
  await SecureStore.setItemAsync(secureKey, toHex(secret), SECURE_STORE_OPTIONS);
  return makeKey(secret);
}

/** Created on first use. Cached: each read is a Keystore decrypt inside a wallet session. */
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

/** Never creates a key. */
export async function uploadKeyAddress(wallet: string): Promise<string | null> {
  const secureKey = uploadKeySecureStoreKey(wallet);
  const hit = cached.get(secureKey);
  if (hit !== undefined) return hit.ownerBase58;
  const stored = await SecureStore.getItemAsync(secureKey, SECURE_STORE_OPTIONS);
  return stored === null ? null : makeKey(parseSeed(stored, `SecureStore ${secureKey}`)).ownerBase58;
}

/**
 * The Android preference key names the wallet in cleartext, so forgetting a wallet must delete it.
 * Only safe with no upload owed (a new key can't reproduce on-chain item ids) and no unspent
 * credit, which would be stranded (`storageCreditHeld`).
 */
export async function deleteUploadKey(wallet: string): Promise<void> {
  const secureKey = uploadKeySecureStoreKey(wallet);
  cached.delete(secureKey);
  await SecureStore.deleteItemAsync(secureKey, SECURE_STORE_OPTIONS);
}
