import { useCallback, useMemo } from "react";
import { useMobileWallet } from "@wallet-ui/react-native-kit";
import type { KitMobileWallet } from "@solana-mobile/mobile-wallet-adapter-protocol-kit";
import { liveAuthorize } from "./liveAuthorize";
import type { WalletSession } from "./walletSession";

/**
 * The one session object every sheet is handed, so publishing, sending, pricing and collecting all
 * open a wallet the same way (`liveAuthorize` re-reads the auth token at call time).
 */
export function useWalletSession(): WalletSession {
  const { chain, connectAnd, identity: appIdentity, store } = useMobileWallet();
  const authorizeSession = useCallback(
    (wallet: KitMobileWallet) =>
      liveAuthorize({ store, chain, identity: appIdentity }, wallet),
    [store, chain, appIdentity],
  );
  return useMemo<WalletSession>(
    () => ({
      connectAnd: connectAnd as unknown as WalletSession["connectAnd"],
      authorizeSession,
    }),
    [connectAnd, authorizeSession],
  );
}
