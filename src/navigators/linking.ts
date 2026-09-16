/**
 * Collect links open the Collection tab; core/cluster query parameters are validated there.
 * React Navigation normalizes trailing slashes. Android routing lives in app.json intentFilters.
 * https://reactnavigation.org/docs/configuring-links
 */

import type { LinkingOptions } from "@react-navigation/native";
import type { HomeTabs } from "./HomeNavigator";

/** The one origin this app answers for. Verified by /.well-known/assetlinks.json on that host. */
export const COLLECT_ORIGIN = "https://erashot.app";

/** The path under that origin, without slashes: what `config.screens.Chain` matches. */
export const COLLECT_PATH = "collect";

export const linking: LinkingOptions<HomeTabs> = {
  prefixes: [COLLECT_ORIGIN],
  config: {
    // Only the routes a link may open are listed. An unlisted screen is unreachable by URL,
    // which is the point: nothing but the Collect entry is addressable from outside the app.
    screens: {
      Chain: COLLECT_PATH,
    },
  },
};
