/**
 * `create_album`, which the app no longer sends. Kept only because `scripts/check-program-svm.ts`
 * still drives the deployed program's album instructions; it goes with that script's albums.
 */

import {
  address,
  AccountRole,
  type Instruction,
} from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { albumConformance } from "./albumRules";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  MPL_CORE,
  albumAddress,
  SYSTEM_PROGRAM,
  utf8,
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
function albumTerms(name: string): void {
  const problem = albumConformance({ name, uri: "" }).reason;
  if (problem) throw new Error(problem);
}

/** Album URI: empty or an Arweave document, as `validate_album` requires. */
function albumReference(uri: string): void {
  const problem = albumConformance({ name: "album", uri }).reason;
  if (problem) throw new Error(problem);
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
