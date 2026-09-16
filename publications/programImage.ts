/**
 * What is deployed at a reviewed program address: does the ELF match the pinned digest, and is
 * it still upgradeable? Warning only: never throws or refuses, since an RPC endpoint must not be
 * able to take publishing offline. Unreadable cases return `available: false`.
 *
 * Upgradeable loader layouts (bincode):
 *   Program      u32 enum = 2, then the 32-byte program-data address.
 *   ProgramData  u32 enum = 3, u64 slot, u8 Option tag, 32-byte authority (always 45 bytes), ELF.
 * A `BPFLoader2` program holds its ELF directly and cannot be upgraded.
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
import { pinnedImage } from "./deployments";
import { request } from "./rpc";
import type { Cluster } from "./types";

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
/** The finalized (non-upgradeable) loader. Its programs hold their ELF in the account itself. */
const BPF_LOADER_2 = "BPFLoader2111111111111111111111111111111111";
/** 4-byte enum + 8-byte slot + 1-byte Option tag + 32-byte authority. */
const PROGRAM_DATA_HEADER = 45;

export type DeploymentStatus = {
  program: string;
  /** The program-data account, when the program is an upgradeable one. */
  programData: string | null;
  /** Were the deployed bytes readable? Everything below is null when they were not. */
  available: boolean;
  /** Can these bytes still be replaced? `true` means an upgrade authority exists. */
  upgradeable: boolean | null;
  authority: string | null;
  /** SHA-256 of the deployed ELF. */
  sha256: string | null;
  bytes: number | null;
  /** The reviewed digest, when this address has one written down. */
  pinned: string | null;
  /** null when there is no pin, or nothing to compare it against. */
  matchesPin: boolean | null;
  /** One sentence worth showing. Absent when there is nothing to say. */
  warning?: string;
};

const REPLACED =
  "The program deployed at this address is not the reviewed build. Its bytes were replaced after review.";
const UNREADABLE =
  "The deployed program could not be read on this connection, so it was not checked against the reviewed build.";

function unavailable(program: string, programData: string | null, warning: string): DeploymentStatus {
  return {
    program,
    programData,
    available: false,
    upgradeable: null,
    authority: null,
    sha256: null,
    bytes: null,
    pinned: null,
    matchesPin: null,
    warning,
  };
}

type RawAccount = {
  owner: string;
  executable: boolean;
  data: [string, string];
} | null;

async function read(
  endpoint: string,
  key: string,
): Promise<{ owner: string; bytes: Uint8Array } | null> {
  const { value } = await request<{ value: RawAccount }>(endpoint, "getAccountInfo", [
    key,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  if (!value) return null;
  if (
    typeof value.owner !== "string" ||
    !Array.isArray(value.data) ||
    value.data[1] !== "base64" ||
    typeof value.data[0] !== "string"
  )
    throw new Error("Invalid program account response");
  return { owner: value.owner, bytes: new Uint8Array(getBase64Encoder().encode(value.data[0])) };
}

/**
 * Read the deployed image of `program` and compare it with the reviewed one, if there is one.
 *
 * `cluster` only selects which pin table to look in; omit it to accept a pin recorded for the
 * address on any cluster. Never throws.
 */
export async function deploymentStatus(
  endpoint: string,
  program: string,
  cluster?: Cluster,
): Promise<DeploymentStatus> {
  let programData: string | null = null;
  try {
    address(program);
    const pin = pinnedImage(program, cluster);
    const account = await read(endpoint, program);
    if (!account) return unavailable(program, null, UNREADABLE);

    let elf: Uint8Array;
    let upgradeable: boolean;
    let authority: string | null = null;

    if (account.owner === BPF_LOADER_2) {
      // Finalized: the account IS the program, and nothing can replace it.
      elf = account.bytes;
      upgradeable = false;
    } else if (account.owner === UPGRADEABLE_LOADER) {
      if (account.bytes.length < 36 || readU32(account.bytes, 0) !== 2)
        return unavailable(program, null, UNREADABLE);
      programData = getAddressDecoder().decode(account.bytes.slice(4, 36));
      // The pointer is checked against the derivation, so a forged program account cannot send
      // this read at some other account's bytes.
      const [derived] = await getProgramDerivedAddress({
        programAddress: address(UPGRADEABLE_LOADER),
        seeds: [getAddressEncoder().encode(address(program))],
      });
      if (derived !== programData) return unavailable(program, programData, UNREADABLE);
      const held = await read(endpoint, programData);
      const data = held?.bytes;
      if (!held || held.owner !== UPGRADEABLE_LOADER || !data ||
          data.length < PROGRAM_DATA_HEADER || readU32(data, 0) !== 3)
        return unavailable(program, programData, UNREADABLE);
      upgradeable = data[12] === 1;
      if (upgradeable) authority = getAddressDecoder().decode(data.slice(13, 45));
      elf = data.slice(PROGRAM_DATA_HEADER);
    } else {
      return unavailable(program, null, UNREADABLE);
    }

    const digest = bytesToHex(sha256(elf));
    const matchesPin = pin ? digest === pin.sha256 && elf.length === pin.bytes : null;
    return {
      program,
      programData,
      available: true,
      upgradeable,
      authority,
      sha256: digest,
      bytes: elf.length,
      pinned: pin?.sha256 ?? null,
      matchesPin,
      ...(matchesPin === false ? { warning: REPLACED } : {}),
    };
  } catch {
    return unavailable(program, programData, UNREADABLE);
  }
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}
