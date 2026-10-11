import {
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
} from "@solana-mobile/mobile-wallet-adapter-protocol";
import type { KitMobileWallet } from "@solana-mobile/mobile-wallet-adapter-protocol-kit";
import { getAddressCodec, getBase64Decoder, getBase64Encoder, getUtf8Encoder } from "@solana/kit";
import { createSignInMessageText } from "@solana/wallet-standard-util";
import type { Account, AppIdentity } from "@wallet-ui/react-native-kit";

/**
 * wallet-ui's `authorizeMobileWalletSession`, but reading the auth token from the store at call
 * time: Seed Vault reissues and revokes the token on every authorize, so a token captured in a
 * React closure fails the next back-to-back session.
 */

interface LiveAuthorizationStore {
  $authToken: { get(): string | undefined };
  $selectedAccount: { get(): Account | undefined };
  persist(auth: LiveAuthorization | null): Promise<void>;
}

interface LiveAuthorization {
  accounts: Account[];
  authToken: string;
  selectedAccount: Account;
}

interface LiveAuthorizeConfig {
  store: LiveAuthorizationStore;
  chain: NonNullable<Parameters<KitMobileWallet["authorize"]>[0]["chain"]>;
  identity: AppIdentity;
}

const base64ToBytes = getBase64Encoder();
const addressCodec = getAddressCodec();

function ellipsify(str: string, len = 8, delimiter = ".."): string {
  const limit = len * 2 + delimiter.length;
  return str.length > limit ? str.slice(0, len) + delimiter + str.slice(-len) : str;
}

function toAccount(raw: { address: string; label?: string; icon?: string }): Account {
  const address = addressCodec.decode(base64ToBytes.encode(raw.address));
  return {
    address,
    addressBase64: raw.address,
    icon: raw.icon,
    label: raw.label ?? ellipsify(address.toString()),
  } as Account;
}

/** A rejected cached token is retried once without a token, as wallet-ui does. */
export async function liveAuthorize(
  config: LiveAuthorizeConfig,
  wallet: KitMobileWallet,
): Promise<Account> {
  return (await authorizeWith(config, wallet)).account;
}

/** MWA `sign_in_result`, base64 fields. */
export interface SignInResult { address: string; signed_message: string; signature: string }

/**
 * SIWS via `sign_messages` rather than authorize's `sign_in_payload`: Seed Vault reissues the token
 * on every authorize, and the new one must be persisted before anything else can fail.
 */
export async function signInWith(
  wallet: KitMobileWallet,
  account: { address: string; addressBase64: string },
  payload: Record<string, unknown>,
): Promise<SignInResult> {
  if (payload.address !== account.address) throw new Error("Sign-in is for another wallet. Try again.");
  const message = new Uint8Array(getUtf8Encoder().encode(createSignInMessageText(payload as never)));
  const [signed] = await wallet.signMessages({ addresses: [account.addressBase64], payloads: [message] });
  if (!(signed instanceof Uint8Array) || signed.length < 64)
    throw new Error("The wallet did not sign in. Try again, or use another wallet.");
  // Wallets return either the bare signature or message + signature.
  const body = signed.length === 64 ? message : signed.subarray(0, signed.length - 64);
  const base64 = getBase64Decoder();
  return {
    address: account.addressBase64,
    signed_message: base64.decode(body),
    signature: base64.decode(signed.subarray(signed.length - 64)),
  };
}

/**
 * ERROR_AUTHORIZATION_FAILED (-1). Inside a session it arrives as RN's raw rejection; it only
 * becomes a `SolanaMobileWalletAdapterProtocolError` after the session ends.
 */
function authorizationFailed(e: unknown): boolean {
  if (e instanceof SolanaMobileWalletAdapterProtocolError)
    return e.code === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED;
  const raw = e as { code?: unknown; userInfo?: { jsonRpcErrorCode?: unknown } } | null;
  return raw?.code === "JSON_RPC_ERROR" &&
    raw.userInfo?.jsonRpcErrorCode === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED;
}

async function authorizeWith(
  config: LiveAuthorizeConfig,
  wallet: KitMobileWallet,
): Promise<{ account: Account }> {
  const { store, chain, identity } = config;
  const authToken = store.$authToken.get();
  let result;
  try {
    result = await wallet.authorize({ auth_token: authToken, chain, identity });
  } catch (error) {
    if (!authorizationFailed(error)) throw error;
    try {
      result = await wallet.authorize({ chain, identity });
    } catch (retryError) {
      // MWA spec: a token rejected with ERROR_AUTHORIZATION_FAILED must be discarded, even if
      // the retry fails. Best effort so a storage error can't mask the wallet's.
      if (authToken !== undefined) await store.persist(null).catch(() => undefined);
      throw retryError;
    }
  }
  const accounts = result.accounts.map(toAccount);
  const first = accounts[0];
  if (first === undefined) throw new Error("wallet authorized no accounts");
  const previous = store.$selectedAccount.get();
  const selectedAccount =
    previous !== undefined && accounts.some((a) => a.addressBase64 === previous.addressBase64)
      ? previous
      : first;
  await store.persist({ accounts, authToken: result.auth_token, selectedAccount });
  return { account: selectedAccount };
}