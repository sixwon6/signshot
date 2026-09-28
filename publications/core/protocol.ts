/**
 * The Metaplex Core edition client (`metaplex-core-editions-v1`), on `@solana/kit` only. Core
 * layouts are decoded by hand, following the official SDK's own serializers. The reader fails
 * closed: any unexpected plugin, authority or length is an error.
 */

import {
  address,
  getAddressEncoder,
  getAddressDecoder,
  getProgramDerivedAddress,
  AccountRole,
  type Address,
  type Instruction,
} from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  EDITION_ACCOUNT_BYTES,
  LEGACY_EDITION_ACCOUNT_BYTES,
  PUBLISHED_AT_EDITION_ACCOUNT_BYTES,
  arweaveBytes,
  request,
} from "../rpc";
import { isTrustedDeployment, programFeatures } from "../deployments";
import { hasUnsafeText, readDescription } from "./details";
import { readPhotoMetadata } from "./metadataDocument";
import { attestationAttributes, readAttestationBundle, type AttestationBundle, type DeviceVerdict } from "./attestation";
import { genesisAttributes, genesisClaim, publishedGenesisClaim, type GenesisClaim } from "./genesisToken";
import { collectUrl } from "./links";
import { albumConformance } from "./albumRules";
import { safeErrorText } from "../../src/ui/errorText";
import {
  CORE_PROTOCOL,
  MAX_ROYALTY_BPS,
  type Cluster,
  type CoreDraft,
  type CoreMetadata,
  type PublicationView,
} from "../types";

/** Metaplex Core. The same address on devnet and mainnet. */
export const MPL_CORE = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const SYSTEM = SYSTEM_PROGRAM;
// The dot is escaped so only arweave.net matches, like the program's literal prefix comparison.
const ARWEAVE_URI = /^https:\/\/arweave\.net\/[A-Za-z0-9_-]{43}$/;
/** Exactly 32 bytes of lowercase hex: every nonce and every SHA-256 this protocol encodes. */
export const HEX32 = /^[a-f0-9]{64}$/;

export const utf8 = (s: string) => new TextEncoder().encode(s);
export const hash = (b: Uint8Array) => bytesToHex(sha256(b));

/** The single gate for a title and edition size, run before anything is uploaded. */
export function terms(title: string, supply: number) {
  if (
    !title.trim() ||
    // Refused, not trimmed: stricter than `validate_terms`, so the stored title is exactly the
    // reviewed one.
    title.trim() !== title ||
    utf8(title).length > 24 ||
    // At least as strict as the program's `char::is_control`; looser would fail in simulation
    // after the files are already on Arweave.
    hasUnsafeText(title) ||
    !Number.isInteger(supply) ||
    supply < 1 ||
    supply > 1000
  )
    throw new Error("Use a title up to 24 bytes and 1–1000 prints.");
}

/** One account, bounded and base64-decoded. Never called with a user-supplied endpoint. */
export async function account(endpoint: string, key: string) {
  address(key);
  const { value } = await request<{
    value: null | { owner: string; executable: boolean; data: [string, string] };
  }>(endpoint, "getAccountInfo", [key, { encoding: "base64", commitment: "confirmed" }]);
  if (value === null) return null;
  if (
    !value || typeof value.owner !== "string" || typeof value.executable !== "boolean" ||
    !Array.isArray(value.data) || value.data[1] !== "base64" ||
    typeof value.data[0] !== "string" || value.data[0].length > 200000
  )
    throw new Error("Invalid account data");
  const { getBase64Encoder } = await import("@solana/kit");
  return { ...value, bytes: new Uint8Array(getBase64Encoder().encode(value.data[0])) };
}

const NOT_A_JPEG = "The published file is not a JPEG photograph.";

/** The longest edge a published print may have, read from the JPEG frame header. */
export const MAX_PRINT_EDGE = 8192;

/**
 * Pixel dimensions from a JPEG's SOFn frame header (ITU-T T.81 marker walk; C4/C8/CC are not
 * frames). A small file can declare a huge frame, so this is bounded before any decoder sees it.
 * Throws for anything that is not a JPEG with a frame header.
 */
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(NOT_A_JPEG);
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error(NOT_A_JPEG);
    let cursor = offset + 1;
    while (cursor < bytes.length && bytes[cursor] === 0xff) cursor += 1;
    if (cursor >= bytes.length) throw new Error(NOT_A_JPEG);
    const marker = bytes[cursor];
    cursor += 1;
    // Standalone markers: TEM, RSTn and a repeated SOI carry no segment at all.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset = cursor;
      continue;
    }
    // EOI, or the start of scan, after which the bytes are entropy-coded and not markers.
    if (marker === 0xd9 || marker === 0xda) break;
    if (cursor + 1 >= bytes.length) throw new Error(NOT_A_JPEG);
    const length = (bytes[cursor] << 8) | bytes[cursor + 1];
    if (length < 2 || cursor + length > bytes.length) throw new Error(NOT_A_JPEG);
    if (
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
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

/** Core `Key`, the account-kind discriminator the SDK's `Key` enum defines. */
const KEY_ASSET = 1;
const KEY_PLUGIN_HEADER = 3;
const KEY_PLUGIN_REGISTRY = 4;
const KEY_COLLECTION = 5;
const KEY_GROUP = 6;
/** Core `Plugin` data-enum indices → `enums.Plugin`. They equal the `PluginType` indices. */
const PLUGIN_ROYALTIES = 0;
const PLUGIN_ATTRIBUTES = 6;
const PLUGIN_EDITION = 9;
const PLUGIN_MASTER_EDITION = 10;
const PLUGIN_IMMUTABLE_METADATA = 12;
const PLUGIN_GROUPS = 18;

/**
 * Plugin types an owner may add to their own print. Tolerated because they cannot change the
 * edition number, supply or metadata; a frozen print is valid, just not transferable.
 */
type OwnerManagedPlugin =
  | "FreezeDelegate"
  | "BurnDelegate"
  | "TransferDelegate"
  | "Autograph"
  | "FreezeExecute";
const OWNER_MANAGED: Readonly<Record<number, OwnerManagedPlugin>> = {
  1: "FreezeDelegate",
  2: "BurnDelegate",
  3: "TransferDelegate",
  14: "Autograph",
  16: "FreezeExecute",
};

const concat = (...parts: readonly Uint8Array[]) =>
  new Uint8Array(parts.flatMap((b) => Array.from(b)));
const u16 = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255]);
/** Borsh `u32`, little-endian. */
const u32 = (n: number) => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new Error("Invalid offer revision");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
};
/** Borsh `u64`, little-endian. Lamports are always integers, so the argument is a bigint. */
const u64 = (n: bigint) => {
  if (typeof n !== "bigint" || n < 0n || n > 0xffff_ffff_ffff_ffffn)
    throw new Error("Invalid price in lamports");
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
const disc = (s: string) => sha256(utf8(s)).slice(0, 8);
const addressBytes = (s: string) => new Uint8Array(getAddressEncoder().encode(address(s)));

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Every account a publication or a claim touches, derived. Nothing is generated: each is a PDA
 * of the `era_editions` program, so the wallet is the only signer a transaction ever needs.
 */
export async function addresses(
  program: string,
  creator: string,
  nonce: string,
  number = 1,
  collector = creator,
) {
  const programAddress = address(program);
  const pda = async (...seeds: Uint8Array[]) =>
    (await getProgramDerivedAddress({ programAddress, seeds }))[0];
  if (!HEX32.test(nonce)) throw new Error("Invalid edition identifier");
  if (!Number.isInteger(number) || number < 1 || number > 1000)
    throw new Error("Invalid print number");
  const edition = await pda(utf8("edition"), addressBytes(creator), hexToBytes(nonce));
  const collection = await pda(utf8("collection"), addressBytes(edition));
  const print = await pda(utf8("print"), addressBytes(edition), u16(number));
  const receipt = await pda(utf8("claim"), addressBytes(edition), addressBytes(collector));
  return { edition, collection, print, receipt };
}

/**
 * The offer PDA `["offer", edition]` (`struct SetOffer`/`Collect`/`Buy` in
 * `programs/editions/src/lib.rs`). One offer per edition, at an address anyone can derive: the
 * distribution price lives beside the publication rather than inside its sealed commitment, so a
 * creator can change it without republishing the photograph.
 */
export async function offerAddress(program: string, edition: string) {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(program),
    seeds: [utf8("offer"), addressBytes(edition)],
  });
  return pda;
}

/**
 * The album PDA `["album", creator, nonce]`. `CreateGroupV1` needs the group to sign, and a PDA
 * signed by `era_editions` avoids a generated keypair. The nonce is the album's own.
 */
export async function albumAddress(program: string, creator: string, nonce: string) {
  if (!HEX32.test(nonce)) throw new Error("Invalid album identifier");
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(program),
    seeds: [utf8("album"), addressBytes(creator), hexToBytes(nonce)],
  });
  return pda;
}

/**
 * The claim receipt PDA `["claim", edition, claimant]` (`receipt_bump` in `lib.rs`). The claimant
 * is the collecting wallet — which is what `addresses().receipt` derives — except on a Seeker-only
 * edition, where it is the collector's Seeker Genesis Token MINT, and for the publisher's copy 1
 * the mint sealed at publish: one claim per token, whichever wallet holds it now.
 */
export async function claimReceiptAddress(program: string, edition: string, claimant: string) {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(program),
    seeds: [utf8("claim"), addressBytes(edition), addressBytes(claimant)],
  });
  return pda;
}

/**
 * Who the publisher's copy-1 receipt is counted against: the Genesis Token sealed at publish on a
 * Seeker-only edition (`publisher_claimant` in `lib.rs`), the creator's wallet otherwise.
 */
export function publisherClaimant(creator: string, seekerOnly: boolean, sealedGenesis: string | null) {
  return seekerOnly && sealedGenesis ? sealedGenesis : creator;
}

// ---------------------------------------------------------------------------
// Metadata and links
// ---------------------------------------------------------------------------

/**
 * The permanent metadata document, in the Metaplex JSON standard
 * (https://metaplex.com/docs/token-metadata/token-standard): `name`, `description`, `image`, the
 * edition's collect link as `external_url`, `attributes`, and `properties` with the one image file
 * and its category, plus the evidence the publication carries — the keystore's attestation and the
 * publishing wallet's Seeker Genesis Token (`e.genesisMint`), each independent of the other.
 * `device` is the full device verdict on the attestation as the document is sealed
 * (`deviceVerdict`); the Device trait is written only when it is "verified". Canonicalized (RFC
 * 8785) by the caller; its sha256 is the on-chain `metadata_hash`.
 */
export function metadata(e: CoreMetadata, attestation?: AttestationBundle, device?: DeviceVerdict): PublishedDocument {
  // This throws only if the bundle fails the reader; `attestPublication` ran the identical
  // check on the identical input moments earlier, and `createDraft` falls back to no bundle.
  const summary = attestation ? readAttestationBundle(attestation, e).summary : null;
  return {
    name: e.title,
    description: e.description,
    image: e.image,
    external_url: collectUrl(e.edition, e.cluster),
    // Derived, and re-derived by `readPhotoMetadata`. The Genesis Token entry is always last,
    // which is how the reader tells the two apart.
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

/** Exactly what `metadata()` writes and `loadPublication` accepts. */
interface PublishedDocument {
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

export { collectUrl };

export function explorerUrl(key: string, cluster: Cluster) {
  address(key);
  return `https://explorer.solana.com/address/${key}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}

/**
 * The shared view a screen renders. Derives the addresses it shows rather than trusting the
 * draft's copies of them, and refuses a draft whose recorded PDAs do not round trip.
 */
export async function coreView(draft: CoreDraft): Promise<PublicationView> {
  if (draft.version !== 1 || draft.protocol !== CORE_PROTOCOL)
    throw new Error("This saved edition was written by a different publication protocol.");
  const e = draft.edition;
  terms(e.title, e.supply);
  readDescription(e.description);
  if (!ARWEAVE_URI.test(`https://arweave.net/${draft.metadataId}`))
    throw new Error("Saved edition metadata reference is invalid.");
  const keys = await addresses(e.program, e.creator, e.nonce);
  if (keys.edition !== e.edition || keys.collection !== e.collection)
    throw new Error("Saved edition addresses do not match this photograph.");
  return {
    protocol: CORE_PROTOCOL,
    cluster: e.cluster,
    program: e.program,
    edition: e.edition,
    container: e.collection,
    creatorAsset: keys.print,
    creator: e.creator,
    title: e.title,
    supply: e.supply,
    image: e.image,
    imageHash: e.imageHash,
    metadataId: draft.metadataId,
    metadataHash: hash(utf8(draft.metadata)),
    width: e.width,
    height: e.height,
    publicUrl: collectUrl(e.edition, e.cluster),
    explorerUrl: explorerUrl(e.edition, e.cluster),
  };
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

/**
 * The two accounts the program verifies and seals at publish: the creator's Seeker Genesis Token
 * mint and the token account through which they hold it (`findGenesisTokenAccount`). Both must
 * exist on the cluster the edition is on, which is mainnet: the token exists nowhere else.
 */
export interface GenesisAccounts {
  mint: string;
  token: string;
}

/** The locked collection attribute the program writes for a verified Genesis Token. */
export const GENESIS_ATTRIBUTE = "seeker_genesis_token";

/**
 * What `publish` seals beside the edition on a program with `royaltiesAndSeekerOnly`, from
 * `CoreDraft.royaltyBps` and `CoreDraft.seekerOnly`.
 */
export interface SealedTerms {
  royaltyBps: number;
  seekerOnly: boolean;
}

export const ROYALTY_RANGE = "Use a royalty from 0% to 10%.";
/** Said wherever a royalty or a Seeker-only edition is asked of a program that predates both. */
export const NO_ROYALTIES = "Royalties and Seeker-only editions are not available on this network's program yet.";
/** A Seeker-only publish without the publisher's Genesis Token, which the program refuses (6011). */
export const SEEKER_ONLY_NEEDS_GENESIS = "A Seeker-only edition needs this wallet's Seeker Genesis Token.";

/** The program's own `validate_royalty` (`InvalidRoyalty`, 6010), restated before any upload. */
export function checkSealedTerms(sealed: SealedTerms): void {
  if (
    !sealed || !Number.isInteger(sealed.royaltyBps) || sealed.royaltyBps < 0 ||
    sealed.royaltyBps > MAX_ROYALTY_BPS
  )
    throw new Error(ROYALTY_RANGE);
  if (typeof sealed.seekerOnly !== "boolean") throw new Error("Invalid edition creation");
}

/**
 * `publish`: creates the edition and print #1. With `album` it becomes `publish_in_album`: same
 * arguments, different discriminator, plus the group as a writable account. Every created account
 * is a PDA, so the wallet is the only signer.
 *
 * A deployment with `programFeatures().genesis` takes two more accounts at the end, both read
 * only: the Genesis Token accounts, or — Anchor's convention for an absent optional account — the
 * program's own id in each place. The instruction data is the same either way.
 *
 * A deployment with `programFeatures().royaltiesAndSeekerOnly` takes two more ARGUMENTS after
 * `supply`, `royalty_bps` (u16) and `seeker_only` (bool), which `sealed` must carry: the data grows
 * by 3 bytes and nothing before them moves. A Seeker-only edition is published only with the
 * creator's Genesis Token, which the program requires (`GenesisTokenRequired`), and the creator's
 * receipt is keyed on that mint (`publisherClaimant`). An older deployment is sent neither, and
 * refuses anything but `{ royaltyBps: 0, seekerOnly: false }`.
 */
export async function instruction(
  e: CoreMetadata,
  payer: string,
  number: number,
  uri?: string,
  metadataHash?: string,
  /** An existing Core `GroupV1`. */
  album?: string,
  /** The creator's Genesis Token, for the program to verify and seal. */
  genesis?: GenesisAccounts,
  /** The royalty and the Seeker-only setting; required by a program that takes them. */
  sealed?: SealedTerms,
): Promise<Instruction> {
  const k = await addresses(e.program, e.creator, e.nonce, number, payer);
  terms(e.title, e.supply);
  // Both hashes are fixed `[u8;32]` fields before `supply`; a wrong-length hex would shift
  // `supply` onto bytes nobody chose. Checked here because the files are already uploaded.
  if (!uri || payer !== e.creator || number !== 1 || !ARWEAVE_URI.test(uri) || !metadataHash ||
    !HEX32.test(metadataHash) || !HEX32.test(e.imageHash))
    throw new Error("Invalid edition creation");
  const program = address(e.program);
  const features = programFeatures(e.program);
  const takesGenesis = features.genesis;
  // Refused rather than dropped: the accounts would land in `remaining_accounts` and the
  // publication would go out unsealed while the caller believed otherwise.
  if (genesis && !takesGenesis) throw new Error("This network's program cannot seal a Genesis Token.");
  if (genesis && genesis.mint !== e.genesisMint)
    throw new Error("The Genesis Token to seal is not the one this edition names.");
  // Required, never defaulted: a missing choice must not publish as somebody else's.
  if (features.royaltiesAndSeekerOnly) {
    if (!sealed) throw new Error("Invalid edition creation");
    checkSealedTerms(sealed);
  } else if (sealed && (sealed.royaltyBps !== 0 || sealed.seekerOnly !== false))
    throw new Error(NO_ROYALTIES);
  const extended = features.royaltiesAndSeekerOnly && sealed ? sealed : null;
  // Refused before a wallet signs: the program would refuse it after the review.
  if (extended?.seekerOnly && !genesis) throw new Error(SEEKER_ONLY_NEEDS_GENESIS);
  const data = concat(
    disc(album ? "global:publish_in_album" : "global:publish"),
    hexToBytes(e.nonce),
    str(e.title),
    str(uri),
    hexToBytes(metadataHash),
    hexToBytes(e.imageHash),
    u16(e.supply),
    ...(extended ? [u16(extended.royaltyBps), new Uint8Array([extended.seekerOnly ? 1 : 0])] : []),
  );
  const receipt = extended
    ? await claimReceiptAddress(program, k.edition, publisherClaimant(e.creator, extended.seekerOnly, genesis?.mint ?? null))
    : k.receipt;
  return {
    programAddress: program,
    accounts: [
      { address: address(payer), role: AccountRole.WRITABLE_SIGNER },
      ...[k.edition, k.collection, k.print, receipt, ...(album ? [address(album)] : [])].map(
        (a) => ({ address: a, role: AccountRole.WRITABLE }),
      ),
      ...[MPL_CORE, SYSTEM].map((a) => ({ address: a, role: AccountRole.READONLY })),
      ...(takesGenesis
        ? (genesis ? [address(genesis.mint), address(genesis.token)] : [program, program]).map(
            (a) => ({ address: a, role: AccountRole.READONLY }),
          )
        : []),
    ],
    data,
  };
}

/**
 * `collect`: a later wallet claims the next numbered copy of a published edition. One instruction,
 * one wallet approval, no generated signers — the print and the receipt are both PDAs the program
 * signs for itself.
 *
 * WHY A SEPARATE FUNCTION FROM `instruction()`. The web client chose between the two by testing
 * whether a `uri` had been passed, so a caller that simply forgot the URI silently built a
 * DIFFERENT instruction instead of failing. Here `instruction()` keeps its fail-closed publish
 * check and neither instruction can be reached by accident; the bytes are unchanged either way.
 *
 * WHAT THIS COSTS THE COLLECTOR. There is no purchase price and nothing reaches the publisher, but
 * `collect` creates one Core asset and one `Receipt` account, so the collector pays rent, the
 * network fee AND Metaplex Core's flat 1,500,000-lamport protocol fee for creating an asset. The
 * review screen shows it: `prepareTransaction` derives the estimate from the wallet's own simulated
 * balance change rather than from a fee table, so all of it is already inside the approved number.
 *
 * ENCODING. Anchor's 8-byte instruction discriminator is sha256("global:<name>") truncated to 8
 * (https://www.anchor-lang.com/docs/basics/program-structure), here d02fc29b116252ec, followed by
 * `number` as a Borsh u16 little-endian.
 *
 * ACCOUNTS, in `struct Collect`'s order (`programs/editions/src/lib.rs`), also read back off the
 * confirmed devnet transaction
 * 2bca9Chg3bZv2T4KMgNENHFiwfAev6uUSjoc2pfDHvHZ4zHBUfQpPmhqoir4QDobe5BXhyiaGMSsTLKTREfX4aqm:
 * collector (writable signer), then edition, collection, print and receipt (writable), then Core
 * and System read-only.
 *
 * TWO ACCOUNT LISTS, ONE INSTRUCTION. The build that added paid sales also added a read-only
 * `offer` account between the receipt and Core, so that a free claim can be REFUSED for an edition
 * the creator has priced (`PaymentRequired`); without it the free instruction would be the bypass
 * a bypass. The instruction data is identical either way — only the account
 * list grew — so which list to send is decided by `programFeatures(e.program).offers`, and the
 * deployment that predates offers keeps its seven accounts exactly.
 *
 * SEEKER-ONLY EDITIONS. A deployment with `programFeatures().royaltiesAndSeekerOnly` takes the
 * collector's Genesis Token accounts last, as `publish` takes the creator's, or the program's id in
 * both places. `genesis` is exactly what a Seeker-only edition needs (`seekerOnly` on the read
 * publication) and what any other edition refuses: with it the receipt is
 * `claimReceiptAddress(program, edition, genesis.mint)`, one claim per token; without it
 * `["claim", edition, collector]` as before. The program answers `GenesisTokenRequired` (6011) or
 * `InvalidGenesisToken` (6008) for the wrong choice; nothing here guesses which one it is.
 */
export async function collectInstruction(
  e: CoreMetadata,
  collector: string,
  number: number,
  /** The collector's Seeker Genesis Token, on a Seeker-only edition only. */
  genesis?: GenesisAccounts,
): Promise<Instruction> {
  const k = await addresses(e.program, e.creator, e.nonce, number, collector);
  terms(e.title, e.supply);
  const features = programFeatures(e.program);
  if (genesis && !features.royaltiesAndSeekerOnly) throw new Error(NO_ROYALTIES);
  // The publisher can never collect: they hold copy 1 from publication, and the program refuses
  // `collector == edition.creator` on every edition, with or without a Genesis Token
  // (`AlreadyCollected`). Refused before any wallet opens.
  if (collector === e.creator)
    throw new Error("The publisher already holds copy 1 and cannot collect from this edition.");
  // `collect` requires `number == minted + 1` and `publish` leaves `minted = 1`, so a claim is
  // never copy 1; `minted < supply` bounds it above. Both are program rules, restated here so a
  // miscounted number fails locally instead of costing a simulation.
  if (!Number.isInteger(number) || number < 2 || number > e.supply)
    throw new Error("Invalid print number");
  // The caller's recorded addresses must be the ones these seeds produce, or the instruction would
  // name accounts belonging to a different publication.
  if (k.edition !== e.edition || k.collection !== e.collection)
    throw new Error("Invalid edition addresses");
  const offers = features.offers;
  return {
    programAddress: address(e.program),
    accounts: [
      { address: address(collector), role: AccountRole.WRITABLE_SIGNER },
      ...[k.edition, k.collection, k.print, await claimReceipt(e, k.receipt, genesis)].map((a) => ({
        address: a,
        role: AccountRole.WRITABLE,
      })),
      // Read only and usually not initialised at all: a free edition has no offer account, which
      // is why the program declares it `UncheckedAccount` at a seed-checked address.
      ...(offers
        ? [
            {
              address: await offerAddress(e.program, e.edition),
              role: AccountRole.READONLY,
            },
          ]
        : []),
      ...[MPL_CORE, SYSTEM].map((a) => ({ address: a, role: AccountRole.READONLY })),
      ...claimGenesisAccounts(e.program, genesis),
    ],
    data: concat(disc("global:collect"), u16(number)),
  };
}

/** The receipt a claim opens: the wallet's (`walletReceipt`), or on a Seeker-only claim the token's. */
async function claimReceipt(e: CoreMetadata, walletReceipt: Address, genesis?: GenesisAccounts) {
  return genesis ? claimReceiptAddress(e.program, e.edition, genesis.mint) : walletReceipt;
}

/**
 * The two trailing Genesis Token accounts of `collect` and `buy`, read only: the collector's, or the
 * program's id in both places. None at all on a deployment that predates them.
 */
function claimGenesisAccounts(program: string, genesis?: GenesisAccounts) {
  if (!programFeatures(program).royaltiesAndSeekerOnly) return [];
  const own = address(program);
  return (genesis ? [address(genesis.mint), address(genesis.token)] : [own, own]).map((a) => ({
    address: a,
    role: AccountRole.READONLY,
  }));
}

/** Said wherever a price is asked of a deployment that has no `Offer` account. */
export const NO_OFFERS = "Prices are not available on this network's program yet.";

/**
 * `set_offer`: the creator names the price of the remaining copies, in lamports. `0` means free,
 * which is also what having no offer account at all means.
 *
 * This instruction cannot reach the edition commitment. `struct SetOffer` takes the Edition account
 * READ-ONLY (only `has_one = creator` and the seeds are read off it), so supply, title, uri, the
 * hashes and the issuance counter are out of its reach by construction.
 *
 * ENCODING. Anchor's 8-byte discriminator, sha256("global:set_offer") truncated to 8
 * (https://www.anchor-lang.com/docs/basics/program-structure), here e6dc077128fedf8c, then
 * `price_lamports` as a Borsh u64 little-endian.
 *
 * ACCOUNTS, in `struct SetOffer`'s order: creator (writable signer, it pays the offer account's
 * rent on the first call), the edition read-only, the offer writable, System read-only. `Offer` is
 * `init_if_needed`, so the same instruction creates and updates it.
 */
export async function setOfferInstruction(
  e: CoreMetadata,
  priceLamports: bigint,
): Promise<Instruction> {
  terms(e.title, e.supply);
  if (!programFeatures(e.program).offers) throw new Error(NO_OFFERS);
  const k = await addresses(e.program, e.creator, e.nonce);
  if (k.edition !== e.edition || k.collection !== e.collection)
    throw new Error("Invalid edition addresses");
  return {
    programAddress: address(e.program),
    accounts: [
      { address: address(e.creator), role: AccountRole.WRITABLE_SIGNER },
      { address: k.edition, role: AccountRole.READONLY },
      { address: await offerAddress(e.program, e.edition), role: AccountRole.WRITABLE },
      { address: SYSTEM, role: AccountRole.READONLY },
    ],
    data: concat(disc("global:set_offer"), u64(priceLamports)),
  };
}

/**
 * `buy`: the paid claim. Exactly `collect`'s issuance with the price paid to the creator in the
 * same transaction, so payment failure creates no copy and issuance failure moves no money.
 *
 * WHY THE BUYER SIGNS THE PRICE AND THE REVISION. A System Program transfer carries neither
 * (https://docs.rs/solana-system-interface/latest/solana_system_interface/instruction/fn.transfer.html),
 * and the offer account is mutable, so an approval reviewed against one price could otherwise
 * settle at another. The program requires `offer.price_lamports == expected_price_lamports &&
 * offer.revision == expected_revision` and answers `OfferChanged` otherwise: a stale approval fails
 * safely instead of charging an amount nobody reviewed.
 *
 * WHAT THIS COSTS THE BUYER. The price, PLUS everything `collect` costs — rent for the new Core
 * print and the `Receipt`, the network fee and Metaplex Core's flat 1,500,000-lamport asset fee.
 * They are separate numbers and the screen shows them separately; the simulated balance delta in
 * `prepareTransaction` already contains both.
 *
 * ENCODING. sha256("global:buy") truncated to 8 — 66063d1201daebea — then `number` (u16),
 * `expected_price_lamports` (u64) and `expected_revision` (u32), all Borsh little-endian.
 *
 * ACCOUNTS, in `struct Buy`'s order: collector (writable signer), edition, collection, print and
 * receipt (writable), the offer read-only, the creator writable — pinned by
 * `address = edition.creator`, so no caller can redirect the money — then Core and System, then on
 * a deployment with `royaltiesAndSeekerOnly` the collector's Genesis Token accounts exactly as
 * `collectInstruction` sends them, with the same receipt rule.
 */
export async function buyInstruction(
  e: CoreMetadata,
  collector: string,
  number: number,
  expectedPriceLamports: bigint,
  expectedRevision: number,
  /** The collector's Seeker Genesis Token, on a Seeker-only edition only. */
  genesis?: GenesisAccounts,
): Promise<Instruction> {
  const k = await addresses(e.program, e.creator, e.nonce, number, collector);
  terms(e.title, e.supply);
  if (!programFeatures(e.program).offers) throw new Error(NO_OFFERS);
  if (genesis && !programFeatures(e.program).royaltiesAndSeekerOnly) throw new Error(NO_ROYALTIES);
  // The same three rules `collect` restates, for the same reason: they are program rules, and
  // failing them locally costs no simulation and opens no wallet.
  if (collector === e.creator)
    throw new Error("The publisher already holds copy 1 and cannot collect from this edition.");
  if (!Number.isInteger(number) || number < 2 || number > e.supply)
    throw new Error("Invalid print number");
  if (k.edition !== e.edition || k.collection !== e.collection)
    throw new Error("Invalid edition addresses");
  // `buy` answers `NotForSale` for a zero price, so a free edition is collected, never bought.
  const price = u64(expectedPriceLamports);
  if (expectedPriceLamports === 0n) throw new Error("This edition is free to collect.");
  // `revision` starts at 1 on the first `set_offer`, so 0 can never be the revision of a live offer.
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    throw new Error("Invalid offer revision");
  return {
    programAddress: address(e.program),
    accounts: [
      { address: address(collector), role: AccountRole.WRITABLE_SIGNER },
      ...[k.edition, k.collection, k.print, await claimReceipt(e, k.receipt, genesis)].map((a) => ({
        address: a,
        role: AccountRole.WRITABLE,
      })),
      { address: await offerAddress(e.program, e.edition), role: AccountRole.READONLY },
      // Writable because it receives the price. The program pins it to `edition.creator`.
      { address: address(e.creator), role: AccountRole.WRITABLE },
      ...[MPL_CORE, SYSTEM].map((a) => ({ address: a, role: AccountRole.READONLY })),
      ...claimGenesisAccounts(e.program, genesis),
    ],
    data: concat(disc("global:buy"), u16(number), price, u32(expectedRevision)),
  };
}

// ---------------------------------------------------------------------------
// era_editions account decoding
// ---------------------------------------------------------------------------

/** A bounds-checked cursor. Every read that could walk off the end is an error, not a zero. */
function reader(bytes: Uint8Array, start = 0) {
  let pos = start;
  const take = (n: number) => {
    if (n < 0 || pos + n > bytes.length) throw new Error("Truncated Solana account");
    const slice = new Uint8Array(bytes.slice(pos, pos + n));
    pos += n;
    return slice;
  };
  const view = (n: number) => new DataView(take(n).buffer);
  return {
    take,
    u8: () => take(1)[0],
    u16: () => view(2).getUint16(0, true),
    u32: () => view(4).getUint32(0, true),
    u64: () => view(8).getBigUint64(0, true),
    i64: () => view(8).getBigInt64(0, true),
    key: () => getAddressDecoder().decode(take(32)),
    hex: () => bytesToHex(take(32)),
    text: (max: number) => {
      const length = view(4).getUint32(0, true);
      if (length > max) throw new Error("Solana account text is too long");
      return new TextDecoder("utf-8", { fatal: true }).decode(take(length));
    },
    get offset() {
      return pos;
    },
    set offset(next: number) {
      if (!Number.isInteger(next) || next < 0 || next > bytes.length)
        throw new Error("Solana account offset is out of range");
      pos = next;
    },
  };
}

/**
 * The pinned lengths are the only layout version: `Edition` is 8 + 302 bytes (8 + 301 on the
 * deployments without `seeker_only` and 8 + 293 on those without `published_at` either, chosen by
 * program in `editionAccountBytes`) and `Receipt` 8 + 98, with no version byte. A layout change
 * must ship as a new program address, never an in-place upgrade. The discriminator alone does not
 * identify the program; length and owner checks do.
 */
const RECEIPT_BYTES = 106;

/** The `Edition` length `program` writes: the only thing that tells its three layouts apart. */
export function editionAccountBytes(program: string): number {
  const features = programFeatures(program);
  return features.royaltiesAndSeekerOnly
    ? EDITION_ACCOUNT_BYTES
    : features.publishedAt
      ? PUBLISHED_AT_EDITION_ACCOUNT_BYTES
      : LEGACY_EDITION_ACCOUNT_BYTES;
}

/**
 * `Offer` is 8 + 77 bytes: the Anchor discriminator, then `edition` (32), `creator` (32),
 * `price_lamports` (u64), `revision` (u32) and `bump` (u8). Like the other two it carries no
 * version byte, so this length IS the layout version. `publications/rpc.ts` repeats the number as
 * its own `OFFER_ACCOUNT_BYTES` for the rent floor; the two must stay equal.
 */
export const OFFER_ACCOUNT_BYTES = 85;

/** The last second a JavaScript `Date` can represent (8.64e15 ms). */
const MAX_UNIX_SECONDS = 8_640_000_000_000n;

/**
 * The `Edition` account: publication terms and issuance state. Anchor `account:Edition`, in the
 * layout of `program`, which owns it: `publishedAt` is the `published_at` it recorded at publish
 * (Unix seconds), or `null` on a deployment that predates the field, and `seekerOnly` its
 * `seeker_only`, `false` on a deployment that predates that one (every edition there is open to
 * any wallet). Any other length is refused.
 */
export function readEdition(bytes: Uint8Array, program: string) {
  const features = programFeatures(program);
  const recorded = features.publishedAt || features.royaltiesAndSeekerOnly;
  if (bytes.length !== editionAccountBytes(program) || hash(bytes.slice(0, 8)) !== hash(disc("account:Edition")))
    throw new Error("Unsupported edition account");
  const r = reader(bytes, 8);
  const creator = r.key();
  const nonce = r.hex();
  const collection = r.key();
  const metadataHash = r.hex();
  const imageHash = r.hex();
  const supply = r.u16();
  const minted = r.u16();
  r.u8(); // bump
  // Set from the Clock sysvar in the publishing transaction, so never zero, negative or past what
  // a `Date` can hold.
  const time = recorded ? r.i64() : null;
  if (time !== null && (time <= 0n || time > MAX_UNIX_SECONDS)) throw new Error("Invalid edition state");
  const publishedAt = time === null ? null : Number(time);
  // A Borsh `bool` is exactly 0 or 1.
  const flag = features.royaltiesAndSeekerOnly ? r.u8() : 0;
  if (flag > 1) throw new Error("Invalid edition state");
  const seekerOnly = flag === 1;
  const title = r.text(24);
  const uri = r.text(96);
  terms(title, supply);
  if (minted < 1 || minted > supply || !ARWEAVE_URI.test(uri))
    throw new Error("Invalid edition state");
  return { creator, nonce, collection, metadataHash, imageHash, supply, minted, title, uri, publishedAt, seekerOnly };
}

/** The permanent one-claim record. Anchor `account:Receipt`. */
export function readReceipt(bytes: Uint8Array) {
  if (bytes.length !== RECEIPT_BYTES || hash(bytes.slice(0, 8)) !== hash(disc("account:Receipt")))
    throw new Error("Unsupported collection receipt");
  const r = reader(bytes, 8);
  const edition = r.key();
  const collector = r.key();
  const asset = r.key();
  const number = r.u16();
  if (number < 1 || number > 1000) throw new Error("Invalid collection receipt");
  return { edition, collector, asset, number };
}

/**
 * The distribution offer, as callers hold it: an integer number of lamports and the revision that
 * amount belongs to. Never a float and never a SOL string — `src/prints/price.ts` is the only
 * place a decimal string becomes lamports, and it does so exactly.
 */
export interface EditionOffer {
  priceLamports: bigint;
  revision: number;
}

/**
 * The `Offer` account: the current price of the remaining copies. Anchor `account:Offer`.
 *
 * Strict, like the other two decoders: the pinned length, the discriminator, and then ranges. A
 * `revision` of 0 is impossible (the first `set_offer` writes 1 onto the zero-initialised account),
 * and `bump` is a PDA bump seed, so 0 is out of range there too.
 */
function readOffer(bytes: Uint8Array) {
  if (bytes.length !== OFFER_ACCOUNT_BYTES || hash(bytes.slice(0, 8)) !== hash(disc("account:Offer")))
    throw new Error("Unsupported edition offer");
  const r = reader(bytes, 8);
  const edition = r.key();
  const creator = r.key();
  const priceLamports = r.u64();
  const revision = r.u32();
  const bump = r.u8();
  if (revision < 1 || bump < 1) throw new Error("Invalid edition offer");
  return { edition, creator, priceLamports, revision, bump };
}

/**
 * The offer account for an edition, read from the chain, or `null`.
 *
 * `null` means exactly what it means to the program: `read_offer` in `lib.rs` returns `None` when
 * the account is not owned by `era_editions` or holds no data, and `collect` then proceeds as a
 * free claim. A deployment without the instruction has no offer either, so it answers `null`
 * without a request. A price of ZERO is returned as it is stored — see `pricedOffer` for the
 * normalisation callers act on.
 */
export async function readOfferAccount(
  endpoint: string,
  program: string,
  edition: string,
): Promise<(EditionOffer & { creator: Address }) | null> {
  if (!programFeatures(program).offers) return null;
  const key = await offerAddress(program, edition);
  const raw = await account(endpoint, key);
  if (!raw || raw.owner !== program || raw.bytes.length === 0) return null;
  if (raw.executable) throw new Error("Unsupported edition offer");
  const offer = readOffer(raw.bytes);
  // The seeds are ["offer", edition], so only this edition's offer can live here. Restated rather
  // than assumed: a decoder that trusted the address would report another edition's price.
  if (offer.edition !== edition) throw new Error("This offer belongs to another edition.");
  return { priceLamports: offer.priceLamports, revision: offer.revision, creator: offer.creator };
}

/**
 * The offer as every caller outside the creator's own price screen should read it: `null` unless
 * there is a price to pay. A zero-price offer is a free edition — the program's own reading, since
 * `collect` requires `price_lamports == 0` and `buy` refuses it with `NotForSale` — so it reads
 * as `null` here and nothing has to special-case "priced at nothing".
 */
export function pricedOffer(offer: EditionOffer | null): EditionOffer | null {
  return offer && offer.priceLamports > 0n
    ? { priceLamports: offer.priceLamports, revision: offer.revision }
    : null;
}

/**
 * This wallet's permanent claim on an edition, or `null`. The receipt PDA is
 * ["claim", edition, wallet] and is `init` in `publish`, `publish_in_album` and `collect` alike,
 * so it exists at most ONCE per wallet per edition and no transfer or burn of the print can clear
 * it: a wallet that has collected can never collect again, which is the rule the screen states.
 *
 * Fails closed. A receipt not owned by the edition's program, or naming another edition, another
 * collector, or an asset that is not the canonical print for its own number, is an error rather
 * than a quiet `false` — the alternative is offering a second claim the program would refuse
 * after the wallet has already been opened.
 *
 * On a Seeker-only edition the claim is the token's, so pass the collector's Genesis Token mint as
 * `claimant`: the answer is then that token's receipt, whichever wallet collected with it — the
 * token may have moved since, so its `collector` is not required to be `wallet`.
 */
export async function collectedCopy(endpoint: string, e: CoreMetadata, wallet: string, claimant = wallet) {
  const key = await claimReceiptAddress(e.program, e.edition, claimant);
  const raw = await account(endpoint, key);
  if (!raw) return null;
  if (raw.owner !== e.program || raw.executable) throw new Error("Invalid collection receipt");
  const receipt = readReceipt(raw.bytes);
  if (
    receipt.edition !== e.edition ||
    (claimant === wallet && receipt.collector !== wallet) ||
    receipt.number > e.supply ||
    // The print PDA carries no collector, so the number alone decides it.
    receipt.asset !== (await addresses(e.program, e.creator, e.nonce, receipt.number)).print
  )
    throw new Error("The collection receipt names an unexpected NFT.");
  return receipt;
}

/** Has this wallet (or on a Seeker-only edition, this `claimant` token) already claimed a copy? */
export async function hasCollected(endpoint: string, e: CoreMetadata, wallet: string, claimant = wallet) {
  return (await collectedCopy(endpoint, e, wallet, claimant)) !== null;
}

// ---------------------------------------------------------------------------
// Metaplex Core account decoding (narrow, validated)
// ---------------------------------------------------------------------------

type CorePluginAuthority =
  | { kind: "None" }
  | { kind: "Owner" }
  | { kind: "UpdateAuthority" }
  | { kind: "Address"; address: Address };

type CoreUpdateAuthority =
  | { kind: "None" }
  | { kind: "Address"; address: Address }
  | { kind: "Collection"; address: Address };

type CorePlugin =
  | {
      type: "Attributes";
      authority: CorePluginAuthority;
      attributes: readonly { key: string; value: string }[];
    }
  | { type: "Edition"; authority: CorePluginAuthority; number: number }
  | {
      type: "MasterEdition";
      authority: CorePluginAuthority;
      maxSupply: number | null;
      name: string | null;
      uri: string | null;
    }
  | { type: "ImmutableMetadata"; authority: CorePluginAuthority }
  /**
   * The creator's royalty on a collection (`Royalties`: basis points, creators with their shares,
   * and the rule set naming which programs may transfer). Read by `collectionRoyalty`.
   */
  | {
      type: "Royalties";
      authority: CorePluginAuthority;
      basisPoints: number;
      creators: readonly { address: Address; percentage: number }[];
      ruleSet: "None" | "ProgramAllowList" | "ProgramDenyList";
      programs: readonly Address[];
    }
  /**
   * The groups a collection claims to belong to. A claim, not evidence: `verifyEditionCollection`
   * requires the group's own list to include it. The authority is recorded, never acted on.
   */
  | { type: "Groups"; authority: CorePluginAuthority; groups: readonly Address[] }
  | {
      type: "OwnerManaged";
      plugin: OwnerManagedPlugin;
      authority: CorePluginAuthority;
      /** `FreezeDelegate` / `FreezeExecute` only; `null` for the types that carry no flag. */
      frozen: boolean | null;
    };

interface CoreAsset {
  owner: Address;
  updateAuthority: CoreUpdateAuthority;
  name: string;
  uri: string;
  seq: bigint | null;
  plugins: readonly CorePlugin[];
}

interface CoreCollection {
  updateAuthority: Address;
  name: string;
  uri: string;
  numMinted: number;
  currentSize: number;
  plugins: readonly CorePlugin[];
}

/**
 * Core `GroupV1` (an album): `key | update_authority | name | uri | collections | groups |
 * parent_groups | assets`, each list a u32 count of addresses, then the optional plugin area.
 */
export interface CoreGroup {
  updateAuthority: Address;
  name: string;
  uri: string;
  collections: readonly Address[];
  groups: readonly Address[];
  parentGroups: readonly Address[];
  assets: readonly Address[];
  plugins: readonly CorePlugin[];
  /** A plugin area this reader cannot decode; reported as content by `albumConformance`. */
  unknownPlugins: boolean;
}

/** Core's own cap on a group's direct collection list. */
const GROUP_MAX_COLLECTIONS = 256;

const NOT_CORE = "This Solana account is not the Metaplex Core object this edition names.";

function readPluginAuthority(r: ReturnType<typeof reader>): CorePluginAuthority {
  switch (r.u8()) {
    case 0:
      return { kind: "None" };
    case 1:
      return { kind: "Owner" };
    case 2:
      return { kind: "UpdateAuthority" };
    case 3:
      return { kind: "Address", address: r.key() };
    default:
      throw new Error(NOT_CORE);
  }
}

function readOption<T>(r: ReturnType<typeof reader>, value: () => T): T | null {
  const tag = r.u8();
  if (tag === 0) return null;
  if (tag !== 1) throw new Error(NOT_CORE);
  return value();
}

function readBool(r: ReturnType<typeof reader>): boolean {
  const value = r.u8();
  if (value > 1) throw new Error(NOT_CORE);
  return value === 1;
}

/**
 * One plugin's data at its registry offset. Only Signshot's types and the owner-managed ones
 * decode; anything else throws. The blob's own discriminator must match the `declared` type.
 */
function readPlugin(
  bytes: Uint8Array,
  offset: number,
  authority: CorePluginAuthority,
  declared: number,
): CorePlugin {
  const r = reader(bytes, offset);
  const kind = r.u8();
  if (kind !== declared) throw new Error(NOT_CORE);
  const ownerManaged = OWNER_MANAGED[kind];
  if (ownerManaged)
    return {
      type: "OwnerManaged",
      plugin: ownerManaged,
      authority,
      // Only the two freeze plugins carry a flag, and only `FreezeDelegate`'s blocks a send
      // (`isFrozen`). The rest are recorded by type; their bodies are never interpreted, so a
      // future field cannot change what we believe.
      frozen:
        ownerManaged === "FreezeDelegate" || ownerManaged === "FreezeExecute"
          ? readBool(r)
          : null,
    };
  switch (kind) {
    case PLUGIN_ATTRIBUTES: {
      const count = r.u32();
      if (count > 32) throw new Error(NOT_CORE);
      const attributes: { key: string; value: string }[] = [];
      for (let i = 0; i < count; i += 1)
        attributes.push({ key: r.text(128), value: r.text(256) });
      return { type: "Attributes", authority, attributes };
    }
    case PLUGIN_EDITION:
      return { type: "Edition", authority, number: r.u32() };
    case PLUGIN_MASTER_EDITION:
      return {
        type: "MasterEdition",
        authority,
        maxSupply: readOption(r, () => r.u32()),
        name: readOption(r, () => r.text(128)),
        uri: readOption(r, () => r.text(256)),
      };
    case PLUGIN_IMMUTABLE_METADATA:
      return { type: "ImmutableMetadata", authority };
    case PLUGIN_ROYALTIES: {
      // `Royalties { basis_points: u16, creators: Vec<Creator { address, percentage: u8 }>,
      // rule_set: RuleSet }`, `RuleSet` being `None`, or a `Vec<Pubkey>` allow or deny list.
      const basisPoints = r.u16();
      const count = r.u32();
      if (count > 16) throw new Error(NOT_CORE);
      const creators: { address: Address; percentage: number }[] = [];
      for (let i = 0; i < count; i += 1) creators.push({ address: r.key(), percentage: r.u8() });
      const tag = r.u8();
      if (tag > 2) throw new Error(NOT_CORE);
      const programs: Address[] = [];
      if (tag !== 0) {
        const listed = r.u32();
        if (listed > 64) throw new Error(NOT_CORE);
        for (let i = 0; i < listed; i += 1) programs.push(r.key());
      }
      const ruleSet = (["None", "ProgramAllowList", "ProgramDenyList"] as const)[tag];
      return { type: "Royalties", authority, basisPoints, creators, ruleSet, programs };
    }
    case PLUGIN_GROUPS: {
      const count = r.u32();
      if (count > GROUP_MAX_COLLECTIONS) throw new Error(NOT_CORE);
      const groups: Address[] = [];
      for (let i = 0; i < count; i += 1) groups.push(r.key());
      return { type: "Groups", authority, groups };
    }
    default:
      throw new Error(
        "This Core asset carries a plugin Signshot editions never use. It is not a Signshot print.",
      );
  }
}

/**
 * Is this print frozen against sending right now? Only `FreezeDelegate.frozen` blocks a transfer.
 * `FreezeExecute` validates the Execute lifecycle event alone and has no transfer check
 * (mpl-core `plugins/internal/owner_managed/freeze_execute.rs`;
 * https://metaplex.com/docs/smart-contracts/core/plugins/freeze-execute), so a print it freezes
 * still sends. A frozen print is valid; it just cannot be sent.
 */
export function isFrozen(asset: CoreAsset): boolean {
  return asset.plugins.some(
    (p) => p.type === "OwnerManaged" && p.plugin === "FreezeDelegate" && p.frozen === true,
  );
}

/**
 * `PluginHeaderV1` + `PluginRegistryV1`, and the plugins they point at.
 *
 * `base` is where the account's base struct ended. Core lays the account out as
 * `base | PluginHeaderV1 | plugin blobs | PluginRegistryV1`, and the registry is the last thing
 * in the account: anything after it is bytes we cannot account for, which is an error.
 */
function readPlugins(bytes: Uint8Array, base: number): readonly CorePlugin[] {
  if (bytes.length === base) return [];
  const header = reader(bytes, base);
  if (header.u8() !== KEY_PLUGIN_HEADER) throw new Error(NOT_CORE);
  const registryOffset = header.u64();
  if (registryOffset < BigInt(header.offset) || registryOffset > BigInt(bytes.length))
    throw new Error(NOT_CORE);
  const firstPlugin = header.offset;
  const r = reader(bytes, Number(registryOffset));
  if (r.u8() !== KEY_PLUGIN_REGISTRY) throw new Error(NOT_CORE);
  const count = r.u32();
  if (count > 16) throw new Error(NOT_CORE);
  const records: { type: number; authority: CorePluginAuthority; offset: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const type = r.u8();
    const authority = readPluginAuthority(r);
    const offset = r.u64();
    if (offset < BigInt(firstPlugin) || offset >= registryOffset) throw new Error(NOT_CORE);
    records.push({ type, authority, offset: Number(offset) });
  }
  // External plugin adapters — oracles, lifecycle hooks, app data — can gate or observe a
  // transfer. A Signshot edition has none, and a Core account that has one is not one of ours.
  if (r.u32() !== 0)
    throw new Error(
      "This Core asset carries an external plugin adapter. It is not a Signshot print.",
    );
  if (r.offset !== bytes.length) throw new Error(NOT_CORE);
  return records.map((record) =>
    readPlugin(bytes, record.offset, record.authority, record.type),
  );
}

/** Core `AssetV1`: one numbered print. */
export function decodeAsset(bytes: Uint8Array): CoreAsset {
  const r = reader(bytes);
  if (r.u8() !== KEY_ASSET) throw new Error(NOT_CORE);
  const owner = r.key();
  let updateAuthority: CoreUpdateAuthority;
  switch (r.u8()) {
    case 0:
      updateAuthority = { kind: "None" };
      break;
    case 1:
      updateAuthority = { kind: "Address", address: r.key() };
      break;
    case 2:
      updateAuthority = { kind: "Collection", address: r.key() };
      break;
    default:
      throw new Error(NOT_CORE);
  }
  const name = r.text(128);
  const uri = r.text(256);
  const seq = readOption(r, () => r.u64());
  return { owner, updateAuthority, name, uri, seq, plugins: readPlugins(bytes, r.offset) };
}

/** Core `CollectionV1`: one published photograph. */
export function decodeCollection(bytes: Uint8Array): CoreCollection {
  const r = reader(bytes);
  if (r.u8() !== KEY_COLLECTION) throw new Error(NOT_CORE);
  const updateAuthority = r.key();
  const name = r.text(128);
  const uri = r.text(256);
  const numMinted = r.u32();
  const currentSize = r.u32();
  return {
    updateAuthority,
    name,
    uri,
    numMinted,
    currentSize,
    plugins: readPlugins(bytes, r.offset),
  };
}

/** Core `GroupV1`: one album. Structural decoding only; the album rules live in `album.ts`. */
export function decodeGroup(bytes: Uint8Array): CoreGroup {
  const r = reader(bytes);
  if (r.u8() !== KEY_GROUP) throw new Error(NOT_CORE);
  const updateAuthority = r.key();
  // No length cap: Core has none and a rename must not make an edition unreadable. `albumLabel`
  // bounds what renders.
  const name = r.text(bytes.length);
  const uri = r.text(bytes.length);
  const list = () => {
    const count = r.u32();
    // A group larger than Core's own direct-list cap is not something this reader can present
    // honestly, so it is refused rather than silently truncated.
    if (count > GROUP_MAX_COLLECTIONS) throw new Error(NOT_CORE);
    const out: Address[] = [];
    for (let i = 0; i < count; i += 1) out.push(r.key());
    return out;
  };
  const collections = list();
  const groups = list();
  const parentGroups = list();
  const assets = list();
  // A group's plugin area is mutable content, not structure: an undecodable one is flagged rather
  // than making every member edition unreadable. Assets and collections stay strict.
  let plugins: readonly CorePlugin[] = [];
  let unknownPlugins = false;
  try {
    plugins = readPlugins(bytes, r.offset);
  } catch {
    unknownPlugins = true;
  }
  return {
    updateAuthority,
    name,
    uri,
    collections,
    groups,
    parentGroups,
    assets,
    plugins,
    unknownPlugins,
  };
}

/**
 * Exactly these plugin types, once each, all with `Authority::None`: the only authority nobody
 * can act under, so the number, supply and attributes can never change.
 */
function requirePlugins(
  plugins: readonly CorePlugin[],
  expected: readonly CorePlugin["type"][],
  message: string,
): void {
  if (plugins.length !== expected.length) throw new Error(message);
  for (const type of expected) {
    if (plugins.filter((p) => p.type === type).length !== 1) throw new Error(message);
  }
  if (plugins.some((p) => p.authority.kind !== "None")) throw new Error(message);
}

function pluginOfType<T extends CorePlugin["type"]>(
  plugins: readonly CorePlugin[],
  type: T,
  message: string,
): Extract<CorePlugin, { type: T }> {
  const found = plugins.find((p): p is Extract<CorePlugin, { type: T }> => p.type === type);
  if (!found) throw new Error(message);
  return found;
}

const PRINT_MESSAGE = "This NFT does not match the immutable Signshot edition format.";

/**
 * Accept only the print `era_editions` creates: `Edition{number}` and `ImmutableMetadata` with
 * `Authority::None`, owner-managed plugins tolerated, everything else refused. Returns the asset
 * so the caller can check its `uri` and `owner`.
 */
export function verifyPrintAsset(
  bytes: Uint8Array,
  e: Pick<CoreMetadata, "title" | "collection">,
  assetAddress: string,
  number = 1,
): CoreAsset {
  address(assetAddress);
  const asset = decodeAsset(bytes);
  const edition = pluginOfType(asset.plugins, "Edition", PRINT_MESSAGE);
  const immutable = pluginOfType(asset.plugins, "ImmutableMetadata", PRINT_MESSAGE);
  const required = asset.plugins.filter(
    (p) => p.type === "Edition" || p.type === "ImmutableMetadata",
  );
  if (
    required.length !== 2 ||
    edition.authority.kind !== "None" ||
    immutable.authority.kind !== "None" ||
    // `Attributes` and `MasterEdition` belong to the collection. On an asset they are somebody
    // else's object wearing our name.
    asset.plugins.some(
      (p) =>
        p.type !== "Edition" && p.type !== "ImmutableMetadata" && p.type !== "OwnerManaged",
    ) ||
    asset.updateAuthority.kind !== "Collection" ||
    asset.updateAuthority.address !== e.collection ||
    asset.name !== `${e.title} #${number}` ||
    edition.number !== number ||
    !ARWEAVE_URI.test(asset.uri)
  )
    throw new Error(PRINT_MESSAGE);
  return asset;
}

const COLLECTION_MESSAGE = "The Core collection does not match the published edition.";
const ALBUM_MESSAGE =
  "This photo edition names an album that does not list it. It is not a valid album member.";

/**
 * The membership evidence a `Groups` plugin needs before it may be tolerated: the Core
 * `GroupV1` account it names, read from the chain by the caller. The plugin says which album a
 * collection CLAIMS; only the group account says which collections it actually holds.
 */
interface AlbumMembership {
  group: Address;
  /** The group account's own collection list. Never the plugin's copy of anything. */
  collections: readonly Address[];
}

/**
 * The album a collection names, or `null`.
 *
 * Throws when the plugin is present but names anything other than exactly one group: an
 * edition belongs to at most one Signshot album, and a list of zero or several has no answer.
 * The plugin authority is returned so callers can record it; membership is never decided by it.
 */
function collectionAlbum(
  collection: CoreCollection,
): { group: Address; pluginAuthority: CorePluginAuthority } | null {
  const named = collection.plugins.filter((p) => p.type === "Groups");
  if (named.length === 0) return null;
  if (named.length !== 1 || named[0].groups.length !== 1) throw new Error(ALBUM_MESSAGE);
  return { group: named[0].groups[0], pluginAuthority: named[0].authority };
}

/** The creator's royalty as a published edition's collection seals it. */
export interface EditionRoyalty {
  /** 0–`MAX_ROYALTY_BPS`; 500 is 5%. */
  basisPoints: number;
  /** The one creator the plugin names, at 100%: the publisher. */
  creator: Address;
}

/**
 * The collection's `Royalties` plugin as `era_editions` writes it (`royalties` in `lib.rs`), or
 * `null` when it carries none — every collection of a deployment that predates it. Throws for any
 * other shape: a second one, a plugin authority other than `None`, a rule set, anything but one
 * creator at 100%, or more than the program allows.
 */
export function collectionRoyalty(collection: CoreCollection): EditionRoyalty | null {
  const found = collection.plugins.filter(
    (p): p is Extract<CorePlugin, { type: "Royalties" }> => p.type === "Royalties",
  );
  if (found.length === 0) return null;
  const [royalty] = found;
  if (
    found.length !== 1 ||
    royalty.authority.kind !== "None" ||
    royalty.ruleSet !== "None" ||
    royalty.creators.length !== 1 ||
    royalty.creators[0].percentage !== 100 ||
    royalty.basisPoints > MAX_ROYALTY_BPS
  )
    throw new Error(COLLECTION_MESSAGE);
  return { basisPoints: royalty.basisPoints, creator: royalty.creators[0].address };
}

/**
 * Accept only the collection `era_editions` creates. The tolerated extras are a `Groups` plugin
 * naming one album whose group account (`membership`) lists this collection, and the `Royalties`
 * plugin naming the publisher (`collectionRoyalty`); whether the edition's program writes one is
 * `verifyPublication`'s check, which knows the program.
 */
export function verifyEditionCollection(
  bytes: Uint8Array,
  // The terms the collection seals; the publication time and the Seeker-only setting are not.
  state: Omit<ReturnType<typeof readEdition>, "publishedAt" | "seekerOnly">,
  edition: string,
  membership?: AlbumMembership,
): CoreCollection {
  const collection = decodeCollection(bytes);
  const album = collectionAlbum(collection);
  if (album) {
    if (
      !membership ||
      membership.group !== album.group ||
      !membership.collections.includes(state.collection as Address)
    )
      throw new Error(ALBUM_MESSAGE);
  }
  requirePlugins(
    collection.plugins.filter((p) => p.type !== "Groups" && p.type !== "Royalties"),
    ["MasterEdition", "ImmutableMetadata", "Attributes"],
    COLLECTION_MESSAGE,
  );
  const royalty = collectionRoyalty(collection);
  if (royalty && royalty.creator !== state.creator) throw new Error(COLLECTION_MESSAGE);
  const master = pluginOfType(collection.plugins, "MasterEdition", COLLECTION_MESSAGE);
  const attributes = pluginOfType(collection.plugins, "Attributes", COLLECTION_MESSAGE);
  const expected: readonly { key: string; value: string }[] = [
    { key: "image_sha256", value: state.imageHash },
    { key: "metadata_sha256", value: state.metadataHash },
    { key: "edition_size", value: String(state.supply) },
    { key: "publisher", value: state.creator },
    { key: "protocol", value: "erashot-core/1" },
  ];
  // Exactly the five, or the five plus the one the program appends for a verified Genesis Token:
  // `seeker_genesis_token`, an address. `sealedGenesisMint` reads it; nothing else may follow.
  const extra = attributes.attributes.slice(expected.length);
  if (
    collection.updateAuthority !== edition ||
    collection.name !== state.title ||
    collection.uri !== state.uri ||
    // The Edition account is authoritative. Core's `num_minted` never decrements, so it is only a
    // floor; `current_size` drops on burn and is not compared.
    collection.numMinted < state.minted ||
    master.maxSupply !== state.supply ||
    master.name !== null ||
    master.uri !== null ||
    attributes.attributes.length < expected.length ||
    expected.some(
      (want, index) =>
        attributes.attributes[index].key !== want.key ||
        attributes.attributes[index].value !== want.value,
    ) ||
    extra.length > 1 ||
    (extra.length === 1 && (extra[0].key !== GENESIS_ATTRIBUTE || !isAddress(extra[0].value)))
  )
    throw new Error(COLLECTION_MESSAGE);
  return collection;
}

/** A base58 address of 32 bytes, or not. Never throws. */
function isAddress(value: string): boolean {
  try {
    address(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Genesis Token mint the program verified and sealed at publish, or `null` for a collection
 * `verifyEditionCollection` accepted without one. Only meaningful on a verified collection.
 */
export function sealedGenesisMint(collection: CoreCollection): string | null {
  const plugin = collection.plugins.find((p) => p.type === "Attributes");
  const sealed = plugin?.type === "Attributes" ? plugin.attributes[5] : undefined;
  return sealed?.key === GENESIS_ATTRIBUTE ? sealed.value : null;
}

// ---------------------------------------------------------------------------
// Reading a published edition
// ---------------------------------------------------------------------------

/**
 * The edition's album: the group account plus the claim that found it. `conforming` reflects the
 * group's mutable content and never invalidates the edition.
 */
type EditionAlbum = CoreGroup & {
  group: Address;
  /** Recorded, never used to decide membership. */
  pluginAuthority: CorePluginAuthority;
  conforming: boolean;
  /** Why not, when `conforming` is false. */
  reason?: string;
};

/** Permanent chain evidence, independent of whether any issued print is still live. */
type VerifiedPublication = {
  program: string;
  edition: string;
  state: ReturnType<typeof readEdition>;
  keys: Awaited<ReturnType<typeof addresses>>;
  collection: CoreCollection;
  creatorReceipt: ReturnType<typeof readReceipt>;
  /**
   * Where `creatorReceipt` lives: `keys.receipt`, except on a Seeker-only edition sealed with the
   * creator's Genesis Token, where copy 1 is that token's claim (`publisherClaimant`).
   */
  creatorReceiptAddress: Address;
  /** `null` when the collection carries no `Groups` plugin. */
  album: EditionAlbum | null;
  /** The Genesis Token mint the program sealed at publish; `null` when it sealed none. */
  sealedGenesis: string | null;
  /**
   * Only a wallet holding a Seeker Genesis Token can collect, one copy per token: pass the
   * collector's to `collectInstruction` / `buyInstruction`. `false` on every older deployment.
   */
  seekerOnly: boolean;
  /** The creator's sealed royalty; `null` on a deployment that predates it. */
  royalty: EditionRoyalty | null;
};

async function verifyPublication(
  endpoint: string,
  program: string,
  edition: string,
  raw: NonNullable<Awaited<ReturnType<typeof account>>>,
): Promise<VerifiedPublication> {
  if (raw.owner !== program || raw.executable !== false)
    throw new Error("Edition not found on this network");
  const state = readEdition(raw.bytes, program);
  const keys = await addresses(program, state.creator, state.nonce);
  if (keys.edition !== edition || keys.collection !== state.collection)
    throw new Error("Invalid edition addresses");

  const collectionRaw = await account(endpoint, keys.collection);
  if (!collectionRaw || collectionRaw.owner !== MPL_CORE || collectionRaw.executable !== false)
    throw new Error("Missing Metaplex Core collection");
  // A collection that names an album is only readable once that album account has been read:
  // the plugin is a claim, the group account is the evidence, and an unreachable or
  // non-conforming group makes the edition unreadable rather than quietly album-less.
  const named = collectionAlbum(decodeCollection(collectionRaw.bytes));
  let album: EditionAlbum | null = null;
  if (named) {
    const groupRaw = await account(endpoint, named.group);
    if (!groupRaw || groupRaw.owner !== MPL_CORE || groupRaw.executable !== false)
      throw new Error(ALBUM_MESSAGE);
    const group = decodeGroup(groupRaw.bytes);
    album = { ...named, ...group, ...albumConformance(group) };
  }
  const collection = verifyEditionCollection(
    collectionRaw.bytes,
    state,
    edition,
    album ? { group: album.group, collections: album.collections } : undefined,
  );
  // The program that seals a royalty seals one into every collection, at 0 too, and no other does.
  const royalty = collectionRoyalty(collection);
  if ((royalty !== null) !== programFeatures(program).royaltiesAndSeekerOnly)
    throw new Error(COLLECTION_MESSAGE);
  const sealedGenesis = sealedGenesisMint(collection);

  // Publish creates this receipt atomically with print #1; transferring or burning the print
  // does not change it.
  const creatorReceiptAddress = await claimReceiptAddress(
    program, edition, publisherClaimant(state.creator, state.seekerOnly, sealedGenesis));
  const receiptRaw = await account(endpoint, creatorReceiptAddress);
  if (!receiptRaw || receiptRaw.owner !== program || receiptRaw.executable !== false)
    throw new Error("Missing or invalid creator publication receipt");
  const creatorReceipt = readReceipt(receiptRaw.bytes);
  if (
    creatorReceipt.edition !== edition ||
    creatorReceipt.collector !== state.creator ||
    creatorReceipt.asset !== keys.print ||
    creatorReceipt.number !== 1
  )
    throw new Error("The creator publication receipt does not match this edition.");
  return {
    program, edition, state, keys, collection, creatorReceipt, creatorReceiptAddress, album,
    sealedGenesis, seekerOnly: state.seekerOnly, royalty,
  };
}

/**
 * Chain-only publication verification. The caller supplies a reviewed program (or an explicitly
 * configured devnet deployment). Only an absent Edition returns null; RPC and validation failures
 * throw. No image/metadata request, current ownership check or live print is required.
 */
export async function readPublication(
  endpoint: string,
  program: string,
  edition: string,
): Promise<VerifiedPublication | null> {
  address(program);
  const raw = await account(endpoint, edition);
  return raw ? verifyPublication(endpoint, program, edition, raw) : null;
}

/**
 * Core's burn tombstone, in both of its forms: exactly `Key::Uninitialized` (one zero byte). A
 * burn resizes the asset to it and keeps it Core-owned, holding the uncollected fees; Core's
 * permissionless `collect` later sweeps those fees and assigns the one-byte account to the System
 * program (mpl-core `processor/collect.rs`; https://metaplex.com/docs/smart-contracts/core/burn).
 * Nothing but that sweep can leave one zero byte in a System-owned account at a program's PDA.
 * An absent, empty or otherwise owned account is NOT burn evidence.
 * Call only for a canonical, already-issued print address; the byte alone proves nothing.
 */
export function isBurnedPrintAccount(raw: Awaited<ReturnType<typeof account>>): boolean {
  return Boolean(
    raw && (raw.owner === MPL_CORE || raw.owner === SYSTEM) && raw.executable === false &&
      raw.bytes.length === 1 && raw.bytes[0] === 0,
  );
}

type PrintState =
  | { status: "live"; address: Address; asset: CoreAsset }
  | { status: "burned"; address: Address }
  | { status: "unavailable"; address?: Address; reason: string };

/** Read an issued print's current state separately from its permanent publication evidence. */
export async function readPrintState(
  endpoint: string,
  publication: VerifiedPublication,
  number = 1,
): Promise<PrintState> {
  let print: Address | undefined;
  try {
    const { program, state } = publication;
    if (!Number.isInteger(number) || number < 1 || number > state.minted)
      throw new Error("This print number has not been issued by the edition.");
    print = (await addresses(program, state.creator, state.nonce, number)).print;
    const raw = await account(endpoint, print);
    if (isBurnedPrintAccount(raw)) return { status: "burned", address: print };
    if (!raw || raw.owner !== MPL_CORE || raw.executable !== false)
      throw new Error("The digital print's current state is unavailable.");
    const asset = verifyPrintAsset(raw.bytes, state, print, number);
    if (asset.uri !== state.uri) throw new Error(PRINT_MESSAGE);
    return { status: "live", address: print, asset };
  } catch (error) {
    return {
      status: "unavailable",
      address: print,
      reason: safeErrorText(error),
    };
  }
}

async function loadPublication(
  endpoint: string,
  publication: VerifiedPublication,
  cluster: Cluster,
) {
  const { program, edition, state } = publication;
  const bytes = await arweaveBytes(state.uri.split("/").pop()!, state.metadataHash);
  // Current and historical document formats are read against verified chain state.
  const text = new TextDecoder().decode(bytes);
  const json: unknown = JSON.parse(text);
  const { image, description, dimensions, attestation, attestationProblem, genesisMint: claimed } =
    readPhotoMetadata(json, { ...state, program, edition, cluster }, text);

  // Size comes from the JPEG header (which also rejects non-JPEGs) and is bounded before any
  // decoder allocates for it.
  const imageBytes = await arweaveBytes(image.split("/").pop()!, state.imageHash);
  const { width, height } = jpegDimensions(imageBytes);
  if (width > MAX_PRINT_EDGE || height > MAX_PRINT_EDGE)
    throw new Error("Published photo is larger than Signshot accepts");
  if (dimensions && (dimensions.width !== width || dimensions.height !== height))
    throw new Error("Photo dimensions do not match the published image");
  // The app writes the document's claim and the program's seal from one value, so a collection
  // that seals a mint the document does not name is not one of its publications.
  const sealed = publication.sealedGenesis;
  if (sealed !== null && sealed !== claimed)
    throw new Error("The sealed Genesis Token does not match the published document.");
  // On mainnet a claim the program did not seal reads as none.
  const genesisMint = publishedGenesisClaim(cluster, claimed, sealed);
  const e: CoreMetadata = {
    cluster,
    program,
    edition,
    collection: state.collection,
    creator: state.creator,
    nonce: state.nonce,
    title: state.title,
    supply: state.supply,
    image,
    imageHash: state.imageHash,
    width,
    height,
    description,
    ...(attestation ? { attestation } : {}),
    ...(attestationProblem ? { attestationProblem } : {}),
    ...(genesisMint ? { genesisMint } : {}),
    ...(sealed ? { genesisSealed: true } : {}),
  };
  return {
    edition: e,
    minted: state.minted,
    remaining: state.supply - state.minted,
    imageBytes,
    publication,
    /**
     * The current price of the remaining copies, or `null` for a free edition. THREE different
     * facts read as `null` and callers are meant to treat them identically, because the program
     * does: the deployment has no `Offer` account at all, no offer was ever set, or the offer says
     * zero. In every one of them `collect` succeeds and `buy` answers `NotForSale`.
     *
     * A quote is never built from this copy: it was read when the edition was loaded, and a price
     * can change at any moment, so `prepareCollect` re-reads the account immediately before
     * quoting. This is what a screen renders, not what a wallet approves.
     */
    offer: pricedOffer(await readOfferAccount(endpoint, program, edition)),
    /** `publication.seekerOnly`: a claim needs the collector's Seeker Genesis Token. */
    seekerOnly: publication.seekerOnly,
    /** `publication.royalty`: the creator's sealed royalty, or `null` on an older deployment. */
    royalty: publication.royalty,
  };
}

/**
 * Resolve the account owner through `TRUSTED[cluster]`, then fully validate. The link and
 * metadata cannot choose a program, and no live print is required (see readPrintState).
 */
export async function loadTrustedEdition(endpoint: string, edition: string, cluster: Cluster) {
  const raw = await account(endpoint, edition);
  if (!raw) throw new Error("Edition not found on this network");
  if (!isTrustedDeployment(cluster, raw.owner))
    throw new Error("This edition is not from a reviewed deployment on this network.");
  return loadPublication(
    endpoint,
    await verifyPublication(endpoint, raw.owner, edition, raw),
    cluster,
  );
}
