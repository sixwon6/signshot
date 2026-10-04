/**
 * The edition's permanent metadata document and the small helpers around it. The document is the
 * one URI every copy carries (the candy machine's hidden settings); its address on Arweave is
 * known before publishing, so it names the edition (the candy machine) in `external_url`.
 */

import { address } from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { hasUnsafeText } from "./details";
import { attestationAttributes, readAttestationBundle, type AttestationBundle, type DeviceVerdict } from "./attestation";
import { genesisAttributes, genesisClaim, type GenesisClaim } from "./genesisToken";
import { collectUrl } from "./links";
import type { Cluster, CoreMetadata } from "../types";

export { collectUrl };

/** Exactly 32 bytes of lowercase hex. */
export const HEX32 = /^[a-f0-9]{64}$/;
export const utf8 = (s: string) => new TextEncoder().encode(s);
export const hash = (b: Uint8Array) => bytesToHex(sha256(b));

/** The single gate for a title and edition size, run before anything is uploaded. */
export function terms(title: string, supply: number) {
  if (
    !title.trim() ||
    title.trim() !== title ||
    utf8(title).length > 24 ||
    title.includes("$ID") ||
    hasUnsafeText(title) ||
    !Number.isInteger(supply) ||
    supply < 1 ||
    supply > 1000
  )
    throw new Error("Use a title up to 24 bytes and 1–1000 copies.");
}

export function explorerUrl(key: string, cluster: Cluster) {
  address(key);
  return `https://explorer.solana.com/address/${key}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}

const NOT_A_JPEG = "The published file is not a JPEG photograph.";
/** The longest edge a published print may have, read from the JPEG frame header. */
export const MAX_PRINT_EDGE = 8192;

/** Pixel dimensions from a JPEG's SOFn frame header. Throws for anything that is not a JPEG. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(NOT_A_JPEG);
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error(NOT_A_JPEG);
    let cursor = offset + 1;
    while (cursor < bytes.length && bytes[cursor] === 0xff) cursor += 1;
    if (cursor >= bytes.length) throw new Error(NOT_A_JPEG);
    const marker = bytes[cursor];
    cursor += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset = cursor;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (cursor + 1 >= bytes.length) throw new Error(NOT_A_JPEG);
    const length = (bytes[cursor] << 8) | bytes[cursor + 1];
    if (length < 2 || cursor + length > bytes.length) throw new Error(NOT_A_JPEG);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8) throw new Error(NOT_A_JPEG);
      const height = (bytes[cursor + 3] << 8) | bytes[cursor + 4];
      const width = (bytes[cursor + 5] << 8) | bytes[cursor + 6];
      if (width < 1 || height < 1) throw new Error(NOT_A_JPEG);
      return { width, height };
    }
    offset = cursor + length;
  }
  throw new Error(NOT_A_JPEG);
}

/** Exactly what `metadata()` writes and `readPhotoMetadata` accepts. */
export interface PublishedDocument {
  name: string;
  description: string;
  image: string;
  external_url: string;
  attributes: { trait_type: string; value: string }[];
  properties: {
    files: [{ uri: string; type: "image/jpeg" }];
    category: "image";
    seedshot?: AttestationBundle;
    genesisToken?: GenesisClaim;
  };
}

/**
 * The permanent metadata document, in the Metaplex JSON standard: `name`, `description`, `image`,
 * the edition's collect link as `external_url`, `attributes`, and `properties` with the one image
 * file, plus the keystore's attestation and the publishing wallet's Seeker Genesis Token claim.
 * Canonicalized (RFC 8785) by the caller.
 */
export function metadata(e: CoreMetadata, attestation?: AttestationBundle, device?: DeviceVerdict): PublishedDocument {
  const summary = attestation ? readAttestationBundle(attestation, e).summary : null;
  return {
    name: e.title,
    description: e.description,
    image: e.image,
    external_url: collectUrl(e.edition, e.cluster),
    attributes: [
      ...(summary ? attestationAttributes(summary, device?.status === "verified") : []),
      ...(e.genesisMint ? genesisAttributes(e.genesisMint) : []),
    ],
    properties: {
      files: [{ uri: e.image, type: "image/jpeg" }],
      category: "image",
      ...(attestation ? { seedshot: attestation } : {}),
      ...(e.genesisMint ? { genesisToken: genesisClaim(e.genesisMint) } : {}),
    },
  };
}
