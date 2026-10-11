import type { AppIdentity } from "@wallet-ui/react-native-kit";

/**
 * Shown on the wallet's authorization sheet; `uri` must be scheme-qualified. Module-level because
 * `MobileWalletProvider` keys its client on `identity` by reference.
 */
export const APP_IDENTITY = {
  name: "Signshot",
  uri: "https://erashot.app",
  // Relative to `uri` per the MWA spec, with no leading slash so naive joining can't yield `//`.
  icon: "icon.png",
} as const satisfies AppIdentity;
