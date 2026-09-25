/**
 * Is the program at a reviewed address still the reviewed build? Publish, collect and buy call
 * `assertReviewedProgram` before a wallet is asked to sign, and refuse when the deployed ELF does
 * not hash to the digest in `deployments.ts` or its upgrade authority is not the recorded one. A
 * signer's privileges extend through every CPI the program makes, so a replaced program could
 * move the signer's balance.
 *
 * Cheap on every call: the program account and the ProgramData header are read with `dataSlice`
 * (36 and 45 bytes). The ELF is fetched and hashed only for a deployment slot this session has not
 * verified; `Upgrade` and `ExtendProgram` both stamp the current slot into the header (Agave
 * `programs/bpf_loader`), so one `(program, slot)` names one set of bytes.
 *
 * Upgradeable loader layouts (bincode):
 *   Program      u32 enum = 2, then the 32-byte program-data address.
 *   ProgramData  u32 enum = 3, u64 slot, u8 Option tag, 32-byte authority (always 45 bytes), ELF.
 * Any other owner or layout is refused: every reviewed deployment is an upgradeable-loader one.
 */

import {
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  address,
} from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { pinnedImage, type ProgramImage } from "./deployments";
import { request } from "./rpc";
import type { Cluster } from "./types";

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
/** 4-byte enum + 32-byte program-data address. */
const PROGRAM_ACCOUNT_BYTES = 36;
/** 4-byte enum + 8-byte slot + 1-byte Option tag + 32-byte authority. */
const PROGRAM_DATA_HEADER = 45;
/**
 * Bytes per ELF read. Base64 grows a slice by a third, so each answer stays well under the site
 * proxy's 1 MB upstream cap (`site/functions/api/solana.ts`) whatever size a later build reaches.
 */
const CHUNK_BYTES = 262_144;

/** The one line a refusal says, on the phone and on the collect page. */
export const PROGRAM_CHANGED = "Program changed. Update Signshot.";

type Header = {
  programData: string;
  slot: bigint;
  authority: string | null;
  /** The ProgramData account's full data length, when the endpoint reports it. */
  space: number | null;
};

type Slice = { owner: string; executable: boolean; bytes: Uint8Array; space: number | null };

/** One account, or `null` when there is none. `dataSlice` bounds what the endpoint sends. */
async function read(
  endpoint: string,
  key: string,
  offset: number,
  length: number,
): Promise<Slice | null> {
  const { value } = await request<{
    value: null | { owner: string; executable: boolean; data: [string, string]; space?: number };
  }>(endpoint, "getAccountInfo", [
    key,
    { encoding: "base64", commitment: "confirmed", dataSlice: { offset, length } },
  ]);
  if (value === null) return null;
  if (
    !value || typeof value.owner !== "string" || typeof value.executable !== "boolean" ||
    !Array.isArray(value.data) || value.data[1] !== "base64" || typeof value.data[0] !== "string"
  )
    throw new Error("Invalid program account response");
  const bytes = new Uint8Array(getBase64Encoder().encode(value.data[0]));
  if (bytes.length > length) throw new Error("Invalid program account response");
  const space = Number.isSafeInteger(value.space) ? (value.space as number) : null;
  return { owner: value.owner, executable: value.executable, bytes, space };
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

/** The ProgramData header fields, or null when `bytes` is not one. */
function programDataHeader(bytes: Uint8Array): Omit<Header, "programData" | "space"> | null {
  if (bytes.length < PROGRAM_DATA_HEADER || readU32(bytes, 0) !== 3 || bytes[12] > 1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, PROGRAM_DATA_HEADER);
  return {
    slot: view.getBigUint64(4, true),
    authority: bytes[12] === 1 ? getAddressDecoder().decode(bytes.slice(13, PROGRAM_DATA_HEADER)) : null,
  };
}

/**
 * The program account and its ProgramData header, both as slices. The program's pointer must be
 * the derived address, so a forged program account cannot send this read to other bytes.
 */
async function readHeader(endpoint: string, program: string): Promise<Header> {
  const [programData] = await getProgramDerivedAddress({
    programAddress: address(UPGRADEABLE_LOADER),
    seeds: [getAddressEncoder().encode(address(program))],
  });
  const [programAccount, held] = await Promise.all([
    read(endpoint, program, 0, PROGRAM_ACCOUNT_BYTES),
    read(endpoint, programData, 0, PROGRAM_DATA_HEADER),
  ]);
  if (
    !programAccount || programAccount.owner !== UPGRADEABLE_LOADER ||
    programAccount.bytes.length !== PROGRAM_ACCOUNT_BYTES || readU32(programAccount.bytes, 0) !== 2 ||
    getAddressDecoder().decode(programAccount.bytes.slice(4)) !== programData
  )
    throw new Error(PROGRAM_CHANGED);
  const header = held && held.owner === UPGRADEABLE_LOADER ? programDataHeader(held.bytes) : null;
  if (!held || !header) throw new Error(PROGRAM_CHANGED);
  return { programData, ...header, space: held.space };
}

/** The whole ProgramData account, header included, read in bounded slices. */
async function readProgramData(endpoint: string, programData: string, length: number) {
  const out = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += CHUNK_BYTES) {
    const size = Math.min(CHUNK_BYTES, length - offset);
    const slice = await read(endpoint, programData, offset, size);
    // A short slice means the account is shorter than the reviewed image: not the reviewed bytes.
    if (!slice || slice.owner !== UPGRADEABLE_LOADER || slice.bytes.length !== size)
      throw new Error(PROGRAM_CHANGED);
    out.set(slice.bytes, offset);
  }
  return out;
}

/** Deployment slots already hashed to their pin this session, per cluster and program. */
const verified = new Map<string, Promise<void>>();

/**
 * Refuse unless `program` runs `image`: the ProgramData bytes hash to `image.sha256` at exactly
 * `image.bytes`, and the upgrade authority is `image.upgradeAuthority` or none at all (an
 * immutable program can never be replaced, so removing the authority is the one change that
 * needs no new record). `scope` keeps one network's cache from answering for another.
 *
 * Throws `PROGRAM_CHANGED` for a changed program; transport failures throw as they are, since a
 * network that did not answer has not said the program changed.
 */
export async function assertProgramImage(
  endpoint: string,
  program: string,
  image: ProgramImage,
  scope: string,
): Promise<void> {
  const header = await readHeader(endpoint, program);
  if (header.authority !== null && header.authority !== image.upgradeAuthority)
    throw new Error(PROGRAM_CHANGED);
  const length = PROGRAM_DATA_HEADER + image.bytes;
  // A reported length that differs settles it without downloading anything.
  if (header.space !== null && header.space !== length) throw new Error(PROGRAM_CHANGED);
  const key = `${scope}:${program}:${header.slot}`;
  let check = verified.get(key);
  if (!check) {
    check = (async () => {
      const data = await readProgramData(endpoint, header.programData, length);
      // The slot and authority must be the ones the header answered with, so the bytes hashed
      // are the bytes of the deployment this cache entry names.
      const stamped = programDataHeader(data);
      if (!stamped || stamped.slot !== header.slot || stamped.authority !== header.authority)
        throw new Error(PROGRAM_CHANGED);
      if (bytesToHex(sha256(data.subarray(PROGRAM_DATA_HEADER))) !== image.sha256)
        throw new Error(PROGRAM_CHANGED);
    })();
    verified.set(key, check);
    // Only a proven match is remembered: a failure is asked again next time.
    check.catch(() => verified.delete(key));
  }
  await check;
}

/**
 * The deployed-program check for `cluster`'s reviewed record of `program`. A program with no
 * record is refused: nothing says which bytes it should run.
 */
export async function assertReviewedProgram(
  endpoint: string,
  program: string,
  cluster: Cluster,
): Promise<void> {
  address(program);
  const image = pinnedImage(program, cluster);
  if (!image) throw new Error(PROGRAM_CHANGED);
  await assertProgramImage(endpoint, program, image, cluster);
}
