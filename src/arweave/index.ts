/**
 * The Arweave upload module.
 *
 * Pure TypeScript: no React, no `@solana/kit`, no `cluster.ts`, no `Buffer`. `uploadKey.ts` is
 * the only module here that touches storage and `turbo.ts` the only one that touches the
 * network; `dataItem.ts` and `codec.ts` are pure and synchronous, which is what lets a data
 * item's id be computed inside a wallet session.
 */

export { buildDataItem } from "./dataItem";
export { getUploadKey } from "./uploadKey";
export { uploadDataItem } from "./turbo";
