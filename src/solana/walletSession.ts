import type { KitMobileWallet } from "@solana-mobile/mobile-wallet-adapter-protocol-kit";

/** What a publishing or transfer flow needs from React, without importing React. */
export interface WalletSession {
  connectAnd<T>(cb: (wallet: KitMobileWallet) => Promise<T>): Promise<T>;
  authorizeSession(wallet: KitMobileWallet): Promise<{ address: string; addressBase64: string }>;
}
