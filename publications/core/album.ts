/**
 * Albums: a Metaplex Core `GroupV1` listing several Seedshot photo editions. The group's name and
 * URI are mutable, and membership grants no trust.
 */

import {
  address,
  AccountRole,
  type Address,
  type Instruction,
} from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { albumConformance } from "./albumRules";
import { hasUnsafeText } from "./details";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { Cluster } from "../types";
import {
  MPL_CORE,
  albumAddress,
  SYSTEM_PROGRAM,
  account,
  decodeGroup,
  explorerUrl,
  utf8,
  type CoreGroup,
} from "./protocol";

const concat = (...parts: readonly Uint8Array[]) =>
  new Uint8Array(parts.flatMap((b) => Array.from(b)));
const u32 = (n: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
};
const str = (s: string) => {
  const bytes = utf8(s);
  return concat(u32(bytes.length), bytes);
};

/** Album name rule, identical to the program's `validate_album` (`InvalidAlbum`, 6004). */
export function albumTerms(name: string): void {
  const problem = albumConformance({ name, uri: "" }).reason;
  if (problem) throw new Error(problem);
}

/** Album URI: empty or an Arweave document, as `validate_album` requires. */
function albumReference(uri: string): void {
  const problem = albumConformance({ name: "album", uri }).reason;
  if (problem) throw new Error(problem);
}

/**
 * A group name safe to render. Core imposes no length limit and the name is mutable, so a blank,
 * unsafe or over-long name becomes a plain label.
 */
export function albumLabel(album: { name: string; conforming: boolean }): string {
  const characters = [...album.name];
  if (!album.name.trim() || hasUnsafeText(album.name)) return "Album name unavailable";
  return characters.length > 48 ? characters.slice(0, 48).join("") + "\u2026" : album.name;
}

/**
 * `era_editions`' `create_album`. The program signs for the `["album", creator, nonce]` PDA, so
 * the wallet is the only signer and keeps the group's update authority.
 */
export async function createAlbumInstruction(input: {
  program: string;
  creator: string;
  /** 32 bytes of hex, the album's own identity. Never an edition's nonce. */
  nonce: string;
  name: string;
  uri?: string;
}): Promise<Instruction> {
  albumTerms(input.name);
  const uri = input.uri ?? "";
  albumReference(uri);
  const album = await albumAddress(input.program, input.creator, input.nonce);
  return {
    programAddress: address(input.program),
    accounts: [
      { address: address(input.creator), role: AccountRole.WRITABLE_SIGNER },
      { address: album, role: AccountRole.WRITABLE },
      { address: MPL_CORE, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: concat(
      sha256(utf8("global:create_album")).slice(0, 8),
      hexToBytes(input.nonce),
      str(input.name),
      str(uri),
    ),
  };
}

// ---------------------------------------------------------------------------
// Public link
// ---------------------------------------------------------------------------

/**
 * `/collect/?album=<group>`. Exactly the hygiene of the edition link: an address and a cluster,
 * never an RPC endpoint and never a program.
 */
export function albumUrl(group: string, cluster: Cluster, origin = "https://erashot.app") {
  address(group);
  return `${origin}/collect/?album=${group}${cluster === "devnet" ? "&cluster=devnet" : ""}`;
}

// ---------------------------------------------------------------------------
// Reading an album
// ---------------------------------------------------------------------------

const ALBUM_NOT_FOUND = "Album not found on this network";
const NOT_AN_ALBUM = "This Solana account is not a Seedshot album.";

export interface Album {
  group: Address;
  cluster: Cluster;
  /** Mutable, like the name and URI. Publication evidence binds the address above, not these. */
  authority: Address;
  name: string;
  uri: string;
  /** Why the album is not conforming: a bad name or URI, a nested group, an attached asset. */
  reason?: string;
  /** The group's own content conforms. Reported only; it changes nothing about its members. */
  conforming: boolean;
  publicUrl: string;
  explorerUrl: string;
}

/**
 * Decodes the group account. Throws only on structure; mutable content (name, URI, nesting,
 * plugins) is reported by `albumConformance`, never refused.
 */
export function verifyAlbumGroup(bytes: Uint8Array): CoreGroup {
  return decodeGroup(bytes);
}

/** Read an album's group account: its authority, name, URI and whether its content conforms. */
export async function readAlbum(
  endpoint: string,
  group: string,
  cluster: Cluster,
): Promise<Album> {
  const groupAddress = address(group);
  const raw = await account(endpoint, groupAddress);
  if (!raw) throw new Error(ALBUM_NOT_FOUND);
  if (raw.owner !== MPL_CORE || raw.executable !== false) throw new Error(NOT_AN_ALBUM);
  const decoded = verifyAlbumGroup(raw.bytes);
  // Content, never fatal. A renamed or re-parented group still lists real photographs.
  const content = albumConformance(decoded);
  return {
    group: groupAddress,
    cluster,
    authority: decoded.updateAuthority,
    name: decoded.name,
    uri: decoded.uri,
    conforming: content.conforming,
    reason: content.reason,
    publicUrl: albumUrl(groupAddress, cluster),
    explorerUrl: explorerUrl(groupAddress, cluster),
  };
}

