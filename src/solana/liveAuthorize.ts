import {
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
} from "@solana-mobile/mobile-wallet-adapter-protocol";
import type { KitMobileWallet } from "@solana-mobile/mobile-wallet-adapter-protocol-kit";
import { getAddressCodec, getBase64Encoder } from "@solana/kit";
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

/** MWA's `sign_in_result`, base64 fields, passed on unchanged. */
export interface SignInResult { address: string; signed_message: string; signature: string; signature_type?: string }

/**
 * Sign-in-with-Solana inside an open session: `authorize` with `sign_in_payload` (MWA 2.0). A
 * wallet that skips the sign-in when it reuses a token is asked once more without the token.
 */
export async function liveSignIn(
  config: LiveAuthorizeConfig,
  wallet: KitMobileWallet,
  payload: Record<string, unknown>,
): Promise<{ account: Account; signInResult: SignInResult }> {
  let result = await authorizeWith(config, wallet, payload);
  if (!result.signInResult) result = await authorizeWith(config, wallet, payload, true);
  if (!result.signInResult) throw new Error("The wallet did not sign in. Try again, or use another wallet.");
  return { account: result.account, signInResult: result.signInResult };
}

async function authorizeWith(
  config: LiveAuthorizeConfig,
  wallet: KitMobileWallet,
  signIn?: Record<string, unknown>,
  withoutToken = false,
): Promise<{ account: Account; signInResult?: SignInResult }> {
  const { store, chain, identity } = config;
  const authToken = withoutToken ? undefined : store.$authToken.get();
  const extra = signIn ? { sign_in_payload: signIn as never } : {};
  let result;
  try {
    result = await wallet.authorize({ auth_token: authToken, chain, identity, ...extra });
  } catch (error) {
    if (
      error instanceof SolanaMobileWalletAdapterProtocolError &&
      error.code === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED
    ) {
      try {
        result = await wallet.authorize({ chain, identity, ...extra });
      } catch (retryError) {
        // MWA spec: a token rejected with ERROR_AUTHORIZATION_FAILED must be discarded. Drop it
        // even when the no-token retry fails too, or every later operation re-prompts. Best
        // effort: a storage failure must not replace the wallet's own error.
        if (authToken !== undefined) await store.persist(null).catch(() => undefined);
        throw retryError;
      }
    } else {
      throw error;
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
  return { account: selectedAccount, signInResult: result.sign_in_result as SignInResult | undefined };
}