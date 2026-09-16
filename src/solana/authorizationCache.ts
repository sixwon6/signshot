import * as SecureStore from "expo-secure-store";
import { address } from "@solana/kit";
import type {
  WalletAuthorization,
  WalletAuthorizationCache,
} from "@wallet-ui/react-native-kit";

import { CHAIN } from "./cluster";

/**
 * The MWA authorization cache, chain-scoped and kept in `expo-secure-store`.
 *
 * wallet-ui's AsyncStorage cache is not usable: it is not chain-scoped (the Seeker wallet silently
 * closes the session when handed another chain's token), `@wallet-ui/react-native-kit` 4.3.0 does
 * not export it at runtime, and it stores the token in plaintext. This mirrors its JSON shape and
 * `address` reviver, so the provider's store reads and writes it unchanged.
 */

/**
 * The Keystore alias for this cache, separate from `es.uploadKey`: entries sharing a service share
 * an AES key, so this entry can never invalidate the upload seed's. No `requireAuthentication`:
 * the cache is read at cold start, outside any user gesture.
 */
const AUTHORIZATION_KEYCHAIN_SERVICE = "es.wallet";

/** SecureStore rejects `:` in keys (`/^[\w.-]+$/`), so the chain id's colon becomes a hyphen. */
const AUTHORIZATION_SECURE_PREFIX = "es.wallet.authorization.v1";

/** SecureStore's own key rule, mirrored so a bad spelling fails here rather than in native. */
const SECURE_STORE_KEY = /^[\w.-]+$/;

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: AUTHORIZATION_KEYCHAIN_SERVICE,
};

/** Where chain `chain`'s authorization is stored. */
function authorizationSecureStoreKey(chain: string): string {
  const key = `${AUTHORIZATION_SECURE_PREFIX}.${chain.replace(/:/g, "-")}`;
  if (!SECURE_STORE_KEY.test(key)) {
    throw new Error(`authorizationCache: "${key}" is not a valid SecureStore key`);
  }
  return key;
}

/** wallet-ui's reviver, verbatim in behaviour: `address` fields are kit `Address`es, not strings. */
function cacheReviver(key: string, value: unknown): unknown {
  if (key === "address" && typeof value === "string") {
    return address(value);
  }
  return value;
}

class ChainScopedAuthorizationCache implements WalletAuthorizationCache {
  private readonly secureKey: string;

  constructor(chain: string) {
    this.secureKey = authorizationSecureStoreKey(chain);
  }

  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(this.secureKey, SECURE_STORE_OPTIONS).catch(() => {});
  }

  async get(): Promise<WalletAuthorization | undefined> {
    let stored: string | null = null;
    try {
      stored = await SecureStore.getItemAsync(this.secureKey, SECURE_STORE_OPTIONS);
    } catch {
      // A value the Keystore can no longer decrypt (a restored device, a rotated key) rejects
      // rather than returning null. Losing the token costs exactly one authorization prompt, so
      // drop the unreadable entry instead of carrying it forever.
      await this.clear();
      return undefined;
    }
    if (stored === null) return undefined;
    try {
      return JSON.parse(stored, cacheReviver) as WalletAuthorization;
    } catch {
      // A corrupt cache means "not authorized"; delete it so it is not re-read on every connect.
      await this.clear();
      return undefined;
    }
  }

  async set(value: WalletAuthorization | undefined): Promise<void> {
    // The store routes "no authorization" to clear(), but the interface allows set(undefined),
    // and `JSON.stringify(undefined)` is not a string SecureStore accepts.
    if (value === undefined) {
      await this.clear();
      return;
    }
    await SecureStore.setItemAsync(this.secureKey, JSON.stringify(value), SECURE_STORE_OPTIONS);
  }
}

/**
 * The single cache instance passed to `MobileWalletProvider`. Module-level: the provider rebuilds
 * its authorization store whenever the `cache` prop changes identity.
 */
export const authorizationCache: WalletAuthorizationCache = new ChainScopedAuthorizationCache(CHAIN);
