/**
 * Mobile Wallet Adapter on the collect page, registered the way Solana Mobile's recipe does it
 * (https://docs.solanamobile.com/recipes/mobile-wallet-adapter/migrating-to-wallet-standard):
 * `@solana-mobile/wallet-standard-mobile` registers a Wallet Standard wallet on Android Chrome, and
 * `page.ts` connects and signs through it like any other wallet. Version 0.5 and later ask for
 * Chrome's Local Network Access permission first; without it "MWA wallet signing requests will
 * silently fail" (https://docs.solanamobile.com/recipes/mobile-wallet-adapter/local-network-access).
 *
 * Its dialogs are the only markup this page lets into the DOM. The library builds its permission,
 * connect, spinner and wallet-not-found dialogs by assigning its own templates to `innerHTML`, and
 * the page's CSP requires Trusted Types, under which a plain string reaches a sink only through a
 * policy named `default`. This file installs one that admits exactly those templates by SHA-256;
 * any other string, including the library's one dynamic error line, throws. Its Google Fonts
 * `<link>` template is admitted as an empty string, so no third-party font request is made.
 * `scripts/check-site.ts` recomputes every digest below from the installed package.
 */
import {
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
  registerMwa,
  type AuthorizationCache,
} from "@solana-mobile/wallet-standard-mobile";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export { SolanaMobileWalletAdapterWalletName } from "@solana-mobile/wallet-standard-mobile";

/**
 * SHA-256 of every template `@solana-mobile/wallet-standard-mobile@0.6.0` assigns to `innerHTML`
 * for the local (Android) wallet: the modal frame, the loading spinner, the error, connect,
 * permission and blocked-permission dialogs (the last in both of its instruction wordings), and
 * the two wallet-not-found sentences.
 */
export const MWA_MARKUP: readonly string[] = [
  // modalHtml$1, the dialog frame
  "3fe51f15cfd13feb5bd345aa7fcd9e4d803ae9a35b4ea353d804958609032c1c",
  // modalHtml, the loading spinner
  "6d45644ef49e96e71ce4fc9fe86ccf0ad66788fa6d3c5857c31dcecd0516c381",
  // ErrorDialogHtml$3, "We can't find a wallet."
  "19110eb30b5a287c2b7add32c8b04fa20e1b379ebd64e629f1f5da1550cb04cc",
  // ErrorDialogHtml$2, "Ready to connect!"
  "ea36f2db807e5c2598f1ab8a37db282043d9e576274b7b83653344a2ec9635a0",
  // ErrorDialogHtml$1, "Your wallet connection is blocked", installed-app wording
  "3ab8f9aab5fa7e7062e101562eb70b654a7f2851ac05af34eb99a79eba25614e",
  // ErrorDialogHtml$1, browser wording
  "66077f860c5b5b56b6c4c225fad64ec5bbe9958992d8ef42847e359be1486541",
  // ErrorDialogHtml, "Allow connections to your wallet"
  "00c7b2b5e5d6eae9fbdc1fb6afca03217dfefba7947ad3aa85f1e54ed9f0f443",
  // WALLET_NOT_FOUND_ERROR_MESSAGE
  "ddfdde793c0dfafb6c3f59b09cadc37682b057123b8ad761c6898c54c7a4d620",
  // BROWSER_NOT_SUPPORTED_ERROR_MESSAGE
  "30286d0bb6a357d18c761a8292533e2e5cc332f8517d7fac5d8efe281aa4166b",
];

/** The Google Fonts `<link>` template: admitted, as nothing. */
export const MWA_FONTS: readonly string[] = [
  "1227b343d3d03c47e6e2a92ba4f5c5d43d5f6434501988cd660b24938547d688",
];

const digest = (text: string) => bytesToHex(sha256(new TextEncoder().encode(text)));

/** What the `default` policy turns `input` into: itself, `""` for the fonts, or `null` (refused). */
export function admitMwaMarkup(input: string): string | null {
  const hash = digest(input);
  if (MWA_FONTS.includes(hash)) return "";
  return MWA_MARKUP.includes(hash) ? input : null;
}

type PolicyFactory = {
  createPolicy(name: string, rules: { createHTML(input: string): string | null }): unknown;
};

/**
 * Install the `default` Trusted Types policy. A browser without Trusted Types enforces none. A
 * refusal (a CSP that allows no `default` policy) leaves the dialogs unable to open, never the
 * photograph unable to load.
 */
function installMarkupPolicy() {
  const factory = (globalThis as { trustedTypes?: PolicyFactory }).trustedTypes;
  try {
    factory?.createPolicy("default", { createHTML: admitMwaMarkup });
  } catch (error) {
    console.error(error);
  }
}

/**
 * The wallet's cached authorization, but only for `chain`: the default cache is one key per
 * origin, and an authorization kept from a devnet link would otherwise answer a mainnet one.
 */
function cacheFor(chain: string): AuthorizationCache {
  const cache = createDefaultAuthorizationCache();
  return {
    clear: () => cache.clear(),
    get: async () => {
      const cached = await cache.get();
      return cached?.chain === chain ? cached : undefined;
    },
    set: (authorization) => cache.set(authorization),
  };
}

let registered = false;

/**
 * Register Mobile Wallet Adapter for this page's one chain. Only that chain, so the wallet is
 * never asked to authorize a network the link is not on. Does nothing off Android: the library
 * registers a local wallet only there, and no remote association is configured. `origin` is the
 * page's own, the identity the wallet shows; the icon is relative to it, as the MWA spec asks.
 */
export function registerMobileWallet(chain: `solana:${string}`, origin: string) {
  if (registered) return;
  registered = true;
  installMarkupPolicy();
  registerMwa({
    appIdentity: { name: "Signshot", uri: origin, icon: "icon.png" },
    authorizationCache: cacheFor(chain),
    chains: [chain],
    chainSelector: createDefaultChainSelector(),
    onWalletNotFound: createDefaultWalletNotFoundHandler(),
  });
}
