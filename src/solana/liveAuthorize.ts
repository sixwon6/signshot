import {
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
} from "@solana-mobile/mobile-wallet-adapter-protocol";
import type { KitMobileWallet } from "@solana-mobile/mobile-wallet-adapter-protocol-kit";
import { getAddressCodec, getBase64Decoder, getBase64Encoder, getUtf8Encoder } from "@solana/kit";
import { createSignInMessageText } from "@solana/wallet-standard-util";
import type { Account, AppIdentity } from "@wallet-ui/react-native-kit";

/**
 * `authorize` that reads the auth token from wallet-ui's store at call time, not from a React
 * closure: Seed Vault reissues the token on every authorize and revokes the old one, so a captured
 * token fails a second back-to-back session. Otherwise the same as wallet-ui's
 * `authorizeMobileWalletSession`. Every wallet session this app opens goes through it.
 */

/** The three things this needs from wallet-ui's authorization store. */
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
  /** Whatever the wallet accepts — the provider hands the same value to wallet-ui itself. */
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

/**
 * Authorize inside an open session and return the selected account. Throws what the wallet
 * throws, except a rejected cached token, which is retried once without a token exactly as
 * wallet-ui does.
 */
export async function liveAuthorize(
  config: LiveAuthorizeConfig,
  wallet: KitMobileWallet,
): Promise<Account> {
  return (await authorizeWith(config, wallet)).account;
}

/** MWA's `sign_in_result` shape, base64 fields: what the co-signer verifies. */
export interface SignInResult { address: string; signed_message: string; signature: string }

/**
 * Sign-in-with-Solana for an account this session has already authorized: the wallet signs the
 * payload's message with `sign_messages`. It is kept apart from `authorize` (no
 * `sign_in_payload`) because Seed Vault Wallet reissues the token on every authorize: the new
 * token has to be stored before anything else in the session can fail.
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
  // The signature alone, or the message with the signature after it.
  const body = signed.length === 64 ? message : signed.subarray(0, signed.length - 64);
  const base64 = getBase64Decoder();
  return {
    address: account.addressBase64,
    signed_message: base64.decode(body),
    signature: base64.decode(signed.subarray(signed.length - 64)),
  };
}

/**
 * The wallet's `authorization request failed` (-1). Inside a session the adapter library hands
 * its native promise back un-awaited, so the error arrives as React Native's raw rejection and
 * only becomes a `SolanaMobileWalletAdapterProtocolError` once the session has ended.
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
      // MWA spec: a token rejected with ERROR_AUTHORIZATION_FAILED must be discarded. Drop it
      // even when the no-token retry fails too, or every later operation re-prompts. Best
      // effort: a storage failure must not replace the wallet's own error.
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