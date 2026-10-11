import * as SecureStore from "expo-secure-store";
import { address } from "@solana/kit";
import type {
  WalletAuthorization,
  WalletAuthorizationCache,
} from "@wallet-ui/react-native-kit";

import { CHAIN } from "./cluster";

/**
 * Chain-scoped MWA authorization cache in `expo-secure-store`. Replaces wallet-ui's AsyncStorage
 * cache, which is plaintext and not chain-scoped (Seed Vault silently closes the session when handed
 * another chain's token). Mirrors its JSON shape and `address` reviver.
 */

/**
 * Separate Keystore alias from `es.uploadKey` (entries in one service share an AES key). No
 * `requireAuthentication`: read at cold start, outside any user gesture.
 */
const AUTHORIZATION_KEYCHAIN_SERVICE = "es.wallet";

/** SecureStore rejects `:` in keys (`/^[\w.-]+$/`), so the chain id's colon becomes a hyphen. */
const AUTHORIZATION_SECURE_PREFIX = "es.wallet.authorization.v1";

/** Mirrors SecureStore's rule so a bad key fails here, not in native. */
const SECURE_STORE_KEY = /^[\w.-]+$/;

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: AUTHORIZATION_KEYCHAIN_SERVICE,
};

function authorizationSecureStoreKey(chain: string): string {
  const key = `${AUTHORIZATION_SECURE_PREFIX}.${chain.replace(/:/g, "-")}`;
  if (!SECURE_STORE_KEY.test(key)) {
    throw new Error(`authorizationCache: "${key}" is not a valid SecureStore key`);
  }
  return key;
}

/** Same as wallet-ui's reviver: `address` fields become kit `Address`es. */
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
      // SecureStore throws on decrypt failures other than an invalidated key or a reinstall (those
      // it deletes and reads as null). Dropping the entry costs one authorization prompt.
      await this.clear();
      return undefined;
    }
    if (stored === null) return undefined;
    try {
      return JSON.parse(stored, cacheReviver) as WalletAuthorization;
    } catch {
      await this.clear();
      return undefined;
    }
  }

  async set(value: WalletAuthorization | undefined): Promise<void> {
    // The interface allows set(undefined); `JSON.stringify(undefined)` isn't a string.
    if (value === undefined) {
      await this.clear();
      return;
    }
    await SecureStore.setItemAsync(this.secureKey, JSON.stringify(value), SECURE_STORE_OPTIONS);
  }
}

/** Module-level: the provider rebuilds its store whenever `cache` changes identity. */
export const authorizationCache: WalletAuthorizationCache = new ChainScopedAuthorizationCache(CHAIN);
