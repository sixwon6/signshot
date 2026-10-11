/**
 * Collect links open `Chain`, which validates the query params. Android routing is in app.json
 * intentFilters. https://reactnavigation.org/docs/configuring-links
 */

import type { LinkingOptions } from "@react-navigation/native";
import type { HomeTabs } from "./HomeNavigator";

/** Verified by /.well-known/assetlinks.json on this host. */
export const COLLECT_ORIGIN = "https://erashot.app";

export const COLLECT_PATH = "collect";

export const linking: LinkingOptions<HomeTabs> = {
  prefixes: [COLLECT_ORIGIN],
  config: {
    // Allowlist: unlisted screens are unreachable by URL.
    screens: {
      Chain: COLLECT_PATH,
    },
  },
};
