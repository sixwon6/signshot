import { install } from "react-native-quick-crypto";

/**
 * Web Crypto for `@solana/kit` and MWA. Its own module, imported first by `index.js`, so an import
 * sorter cannot move it behind code that needs `crypto` (the failure looks like a wallet error).
 * `install()` also sets `global.Buffer`; `src/` uses kit codecs instead.
 */
install();
