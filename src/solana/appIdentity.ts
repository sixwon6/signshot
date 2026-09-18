import type { AppIdentity } from "@wallet-ui/react-native-kit";

/**
 * The identity shown on the wallet's authorization sheet, so `uri` must be the app's real,
 * scheme-qualified home. Module-level because `MobileWalletProvider` keys its client on `identity`
 * by reference; an inline literal would rebuild the client on every render.
 */
export const APP_IDENTITY = {
  name: "Signshot",
  uri: "https://erashot.app",
  // Relative to `uri` per the MWA spec, with no leading slash so naive joining can't yield `//`.
  icon: "icon.png",
} as const satisfies AppIdentity;
