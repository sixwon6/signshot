import type { KitMobileWallet } from "@solana-mobile/mobile-wallet-adapter-protocol-kit";
import type { SignInResult } from "./liveAuthorize";

/** What a publishing or transfer flow needs from React, without importing React. */
export interface WalletSession {
  connectAnd<T>(cb: (wallet: KitMobileWallet) => Promise<T>): Promise<T>;
  authorizeSession(wallet: KitMobileWallet): Promise<{ address: string; addressBase64: string }>;
  /** Sign-in-with-Solana with a server-issued payload, inside the open session. */
  signIn(
    wallet: KitMobileWallet,
    payload: Record<string, unknown>,
  ): Promise<{ account: { address: string; addressBase64: string }; signInResult: SignInResult }>;
}
