/**
 * The `era_editions` program's interface: its PDAs, its three instructions, its `Edition` account
 * and its error codes (`programs/editions/src/lib.rs`, `programs/editions/README.md`). On
 * `@solana/kit` only, self-contained. The builders encode; they check only what the encoding
 * needs (key, hex and integer widths), never the program's product rules, which the program
 * itself answers with the codes in `EDITIONS_ERRORS`.
 */

import {
  AccountRole,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
} from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";

/** Metaplex Core. The same address on devnet and mainnet. */
export const MPL_CORE = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

/** `Edition` is 8 + 54 bytes, with no version byte: the length is the layout. */
export const EDITION_ACCOUNT_BYTES = 62;

const HEX32 = /^[a-f0-9]{64}$/;
const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const keyBytes = (key: string) => new Uint8Array(getAddressEncoder().encode(address(key)));
const hex32 = (hex: string, what: string) => {
  if (!HEX32.test(hex)) throw new Error(`Invalid ${what}`);
  return hexToBytes(hex);
};
const u16 = (n: number, what: string) => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error(`Invalid ${what}`);
  return new Uint8Array([n & 255, n >>> 8]);
};
const u64 = (n: bigint, what: string) => {
  if (typeof n !== "bigint" || n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new Error(`Invalid ${what}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
};
const str = (s: string) => {
  const bytes = utf8(s);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, true);
  return concat(length, bytes);
};
/** Anchor's discriminators: the first 8 bytes of sha256("global:<ix>") or sha256("account:<Name>"). */
const disc = (s: string) => sha256(utf8(s)).slice(0, 8);

const PUBLISH = disc("global:publish");
const CLAIM = disc("global:claim");
const SET_PRICE = disc("global:set_price");
const EDITION = disc("account:Edition");

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const pda = async (program: string, ...seeds: Uint8Array[]) =>
  (await getProgramDerivedAddress({ programAddress: address(program), seeds }))[0];

/** The Core collection, `["collection", creator, nonce]`; `nonce` is 32 bytes of lowercase hex. */
export const collectionAddress = (program: string, creator: string, nonce: string) =>
  pda(program, utf8("collection"), keyBytes(creator), hex32(nonce, "edition identifier"));

/** The `Edition` account, `["edition", collection]`. */
export const editionAddress = (program: string, collection: string) =>
  pda(program, utf8("edition"), keyBytes(collection));

/**
 * A copy's Core asset, `["print", edition, claimant]`. The claimant is the collecting wallet, or on
 * a Seeker-only edition the Seeker Genesis Token mint it claimed with (`claimantOf`). The address
 * is the claim record: one copy per claimant per edition, for good, burned or not.
 */
export const printAddress = (program: string, edition: string, claimant: string) =>
  pda(program, utf8("print"), keyBytes(edition), keyBytes(claimant));

/**
 * Who a copy is counted against: the Genesis Token mint on a Seeker-only edition, the wallet on
 * any other. The publisher's copy 1 follows the same rule with the token they published with.
 */
export const claimantOf = (wallet: string, seekerOnly: boolean, genesisMint?: string | null) =>
  seekerOnly && genesisMint ? address(genesisMint) : address(wallet);

/** Every address a publication creates. */
export async function publicationAddresses(program: string, creator: string, nonce: string, claimant = creator) {
  const collection = await collectionAddress(program, creator, nonce);
  const edition = await editionAddress(program, collection);
  const print = await printAddress(program, edition, claimant);
  return { collection, edition, print };
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

/** A Seeker Genesis Token: its Token-2022 mint and the signer's token account for it. */
export interface GenesisAccounts {
  mint: string;
  token: string;
}

/**
 * The two optional trailing accounts, read only: the Genesis Token's mint and token account, or,
 * Anchor's encoding of an absent optional account, the program's own id in both places.
 */
const genesisAccounts = (program: string, genesis?: GenesisAccounts) =>
  (genesis ? [address(genesis.mint), address(genesis.token)] : [address(program), address(program)]).map(
    (a) => ({ address: a, role: AccountRole.READONLY }),
  );

export interface PublishArgs {
  program: string;
  creator: string;
  /** 32 bytes of lowercase hex, chosen by the client; it fixes every address. */
  nonce: string;
  title: string;
  uri: string;
  /** SHA-256 of the metadata document and of the image, lowercase hex. */
  metadataHash: string;
  imageHash: string;
  supply: number;
  royaltyBps: number;
  seekerOnly: boolean;
  /** Lamports per copy after copy 1; 0 is free. */
  price: bigint;
  /** The creator's Seeker Genesis Token; required for a Seeker-only edition. */
  genesis?: GenesisAccounts;
}

/**
 * `publish`: the edition, its collection and copy 1 for the creator, in one instruction signed by
 * the creator alone. Copy 1 is at `printAddress(edition, claimantOf(creator, seekerOnly, genesis))`.
 *
 * Data: discriminator, nonce [u8;32], title String, uri String, metadata_hash [u8;32],
 * image_hash [u8;32], supply u16, royalty_bps u16, seeker_only bool, price u64 (Borsh, LE).
 * Accounts: creator (writable signer), edition, collection, print (writable), Metaplex Core,
 * System (read only), genesis_mint, genesis_token (read only, optional).
 */
export async function publishInstruction(a: PublishArgs): Promise<Instruction> {
  const k = await publicationAddresses(a.program, a.creator, a.nonce,
    claimantOf(a.creator, a.seekerOnly, a.genesis?.mint));
  if (typeof a.seekerOnly !== "boolean") throw new Error("Invalid edition creation");
  const data = concat(
    PUBLISH,
    hex32(a.nonce, "edition identifier"),
    str(a.title),
    str(a.uri),
    hex32(a.metadataHash, "metadata hash"),
    hex32(a.imageHash, "image hash"),
    u16(a.supply, "edition size"),
    u16(a.royaltyBps, "royalty"),
    new Uint8Array([a.seekerOnly ? 1 : 0]),
    u64(a.price, "price"),
  );
  return {
    programAddress: address(a.program),
    accounts: [
      { address: address(a.creator), role: AccountRole.WRITABLE_SIGNER },
      ...[k.edition, k.collection, k.print].map((x) => ({ address: x, role: AccountRole.WRITABLE })),
      ...[MPL_CORE, SYSTEM_PROGRAM].map((x) => ({ address: x, role: AccountRole.READONLY })),
      ...genesisAccounts(a.program, a.genesis),
    ],
    data,
  };
}

export interface ClaimArgs {
  program: string;
  collector: string;
  /** The edition's creator, from the `Edition` account: the only payee the program accepts. */
  creator: string;
  collection: string;
  /** The price the collector reviewed, in lamports; the program refuses any other (`PriceChanged`). */
  expectedPrice: bigint;
  /** The collector's Seeker Genesis Token, on a Seeker-only edition only. */
  genesis?: GenesisAccounts;
}

/**
 * `claim`: the next copy for the collector, free or for exactly `expectedPrice`, paid to the
 * creator in the same transaction. The copy is created at `printAddress(edition, claimant)`, where
 * the claimant is the collector, or `genesis.mint` when `genesis` is given.
 *
 * Data: discriminator, expected_price u64. Accounts: collector (writable signer), edition,
 * collection, print, creator (writable), Metaplex Core, System (read only), genesis_mint,
 * genesis_token (read only, optional).
 */
export async function claimInstruction(a: ClaimArgs): Promise<Instruction> {
  const edition = await editionAddress(a.program, a.collection);
  const print = await printAddress(a.program, edition, a.genesis ? a.genesis.mint : a.collector);
  return {
    programAddress: address(a.program),
    accounts: [
      { address: address(a.collector), role: AccountRole.WRITABLE_SIGNER },
      ...[edition, address(a.collection), print, address(a.creator)].map((x) => ({
        address: x,
        role: AccountRole.WRITABLE,
      })),
      ...[MPL_CORE, SYSTEM_PROGRAM].map((x) => ({ address: x, role: AccountRole.READONLY })),
      ...genesisAccounts(a.program, a.genesis),
    ],
    data: concat(CLAIM, u64(a.expectedPrice, "price")),
  };
}

/**
 * `set_price`: the creator sets, changes or removes (0) the price of the remaining copies.
 * Data: discriminator, price u64. Accounts: creator (signer), edition (writable).
 */
export function setPriceInstruction(a: { program: string; creator: string; edition: string; price: bigint }): Instruction {
  return {
    programAddress: address(a.program),
    accounts: [
      { address: address(a.creator), role: AccountRole.READONLY_SIGNER },
      { address: address(a.edition), role: AccountRole.WRITABLE },
    ],
    data: concat(SET_PRICE, u64(a.price, "price")),
  };
}

// ---------------------------------------------------------------------------
// The Edition account
// ---------------------------------------------------------------------------

export interface EditionAccount {
  creator: Address;
  supply: number;
  /** Copies issued, copy 1 included. */
  minted: number;
  /** Lamports per claimed copy; 0 is free. */
  price: bigint;
  seekerOnly: boolean;
  bump: number;
  /** The Clock sysvar's `unix_timestamp` in the publishing slot, in seconds. */
  publishedAt: number;
}

/**
 * `Edition`: discriminator, creator (0..32), supply u16 (32), minted u16 (34), price u64 (36),
 * seeker_only bool (44), bump u8 (45), published_at i64 (46), offsets after the discriminator.
 * Strict: the exact length, the discriminator, a Borsh bool and `1 <= minted <= supply`. The
 * discriminator does not identify the program; check the account's owner too.
 */
export function decodeEdition(bytes: Uint8Array): EditionAccount {
  if (bytes.length !== EDITION_ACCOUNT_BYTES || EDITION.some((b, i) => bytes[i] !== b))
    throw new Error("Unsupported edition account");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const creator = getAddressDecoder().decode(bytes.subarray(8, 40));
  const supply = view.getUint16(40, true);
  const minted = view.getUint16(42, true);
  const price = view.getBigUint64(44, true);
  const flag = bytes[52];
  const bump = bytes[53];
  const publishedAt = view.getBigInt64(54, true);
  if (flag > 1 || minted < 1 || minted > supply || publishedAt <= 0n || publishedAt > 8_640_000_000_000n)
    throw new Error("Invalid edition state");
  return { creator, supply, minted, price, seekerOnly: flag === 1, bump, publishedAt: Number(publishedAt) };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** `EditionError`, numbered from 6000 in declaration order. */
export const EDITIONS_ERRORS = {
  6000: { name: "InvalidTerms", message: "Use a title of 1–24 bytes, a URI of 1–96 bytes and 1–1000 prints." },
  6001: { name: "SoldOut", message: "All prints have been collected." },
  6002: { name: "ExistingAsset", message: "This publication account is already in use." },
  6003: { name: "PriceChanged", message: "The price changed. Review the new price before collecting." },
  6004: { name: "InvalidGenesisToken", message: "Use the Seeker Genesis Token this wallet holds, or publish without one." },
  6005: { name: "PriceTooLow", message: "This price is below the network minimum. Raise it or make the edition free." },
  6006: { name: "InvalidRoyalty", message: "Use a royalty from 0% to 10%." },
  6007: {
    name: "GenesisTokenRequired",
    message: "This edition is for Seeker holders. Collect with the wallet that holds a Seeker Genesis Token.",
  },
  6008: { name: "AlreadyCollected", message: "This wallet or Seeker Genesis Token has already collected this edition." },
} as const;

export type EditionsErrorName = (typeof EDITIONS_ERRORS)[keyof typeof EDITIONS_ERRORS]["name"];

/** The code of each error by name, e.g. `EDITIONS_ERROR_CODES.SoldOut === 6001`. */
export const EDITIONS_ERROR_CODES = Object.fromEntries(
  Object.entries(EDITIONS_ERRORS).map(([code, { name }]) => [name, Number(code)]),
) as Record<EditionsErrorName, number>;

/** The program's error for a custom code, or null for any code it does not define. */
export function editionsError(code: number): { name: EditionsErrorName; message: string } | null {
  return (EDITIONS_ERRORS as Record<number, { name: EditionsErrorName; message: string }>)[code] ?? null;
}
