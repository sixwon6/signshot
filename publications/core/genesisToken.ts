/**
 * Seeker Genesis Token claim in a published document (`signshot-genesis/1`, under
 * `properties.genesisToken`). Carries the SGT's mint address, the per-device identifier
 * (https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token).
 *
 * The document only claims a mint; `verifyGenesisToken` checks it. SGTs exist only on mainnet, so
 * the check always reads mainnet whatever the edition's cluster. It says the publishing wallet
 * holds an SGT, not which device made the photo (that is `attestation.ts`).
 */

import { address, getAddressDecoder, getBase64Encoder } from "@solana/kit";
import { request } from "../rpc";
import type { Cluster } from "../types";
import { exactKeys, object } from "./attestation";

export const GENESIS_SCHEMA = "signshot-genesis/1" as const;

/** Solana Mobile's SGT metadata address, which is also the group. */
export const SGT_METADATA_ADDRESS = "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te";
export const SGT_GROUP_ADDRESS = SGT_METADATA_ADDRESS;

export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** From `getGenesisHash` on the public endpoints; the Solana docs do not publish them. */
export const GENESIS_HASH: Record<Cluster, string> = {
  "mainnet-beta": MAINNET_GENESIS_HASH,
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export interface GenesisClaim {
  schema: typeof GENESIS_SCHEMA;
  /** Mainnet mint address. */
  mint: string;
}

export const genesisClaim = (mint: string): GenesisClaim => ({ schema: GENESIS_SCHEMA, mint });

/** Always the document's last `attributes` entry. Re-derived on read. */
export function genesisAttributes(mint: string): { trait_type: string; value: string }[] {
  return [{ trait_type: "Seeker Genesis Token", value: mint }];
}

/** The claimed mint; throws unless exactly a `signshot-genesis/1` claim. */
export function readGenesisClaim(value: unknown): string {
  const claim = object(value);
  if (!claim || !exactKeys(claim, ["schema", "mint"]) || claim.schema !== GENESIS_SCHEMA ||
      typeof claim.mint !== "string")
    throw new Error("genesis: bad claim");
  address(claim.mint);
  return claim.mint;
}

// --- Mint account decoding ---

/**
 * Token-2022 mint: 82-byte SPL `Mint`, zero padding to 165, one `AccountType` byte (1 = mint),
 * then TLV extensions (`u16` type, `u16` length, value). See token-2022 `extension/mod.rs`.
 */
const MINT_BASE_BYTES = 82;
const ACCOUNT_TYPE_OFFSET = 165;
/**
 * `Multisig::LEN`. No mint is this long, and a multisig's signer keys are attacker-chosen bytes
 * that could be laid out as a fake SGT mint. Refused.
 */
const MULTISIG_BYTES = 355;
const ACCOUNT_TYPE_MINT = 1;
const EXTENSION_METADATA_POINTER = 18;
const EXTENSION_TOKEN_GROUP_MEMBER = 23;

/** Bytes of a mint account fetched. A real SGT mint is 450 bytes. */
export const MINT_SLICE_BYTES = 4096;

/**
 * The SGT's member number in Solana Mobile's group, or `null` if `mint` is not an SGT. Requires
 * the `MetadataPointer` to their metadata and a `TokenGroupMember` of their group naming `mint`.
 * The membership is the unforgeable part: Token-2022 writes it only with the group update
 * authority's signature. Caller has checked the Token-2022 owner. Never throws.
 */
export function seekerGenesisMember(
  data: Uint8Array,
  mint: string,
): bigint | null {
  if (data.length <= ACCOUNT_TYPE_OFFSET || data.length === MULTISIG_BYTES || data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT)
    return null;
  // Byte 45 is `is_initialized`; padding up to the account type must be zero.
  if (data[45] !== 1 || data.subarray(MINT_BASE_BYTES, ACCOUNT_TYPE_OFFSET).some((byte) => byte !== 0)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (at: number) => getAddressDecoder().decode(data.subarray(at, at + 32));

  let pointerOk: boolean | undefined;
  let member: bigint | null | undefined;
  let at = ACCOUNT_TYPE_OFFSET + 1;
  while (at + 4 <= data.length) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    const value = at + 4;
    if (type === 0) break; // `Uninitialized`: end of extensions.
    if (value + length > data.length) return null;
    if (type === EXTENSION_METADATA_POINTER) {
      // `authority`, then `metadata_address`, each an `OptionalNonZeroPubkey`.
      if (length !== 64 || pointerOk !== undefined) return null;
      pointerOk = key(value + 32) === SGT_METADATA_ADDRESS;
    } else if (type === EXTENSION_TOKEN_GROUP_MEMBER) {
      // `mint`, `group`, then the `u64` member number.
      if (length !== 72 || member !== undefined) return null;
      member = key(value) === mint && key(value + 32) === SGT_GROUP_ADDRESS
        ? view.getBigUint64(value + 64, true)
        : null;
    }
    at = value + length;
  }
  return pointerOk && member !== undefined ? member : null;
}

export const isSeekerGenesisMint = (data: Uint8Array, mint: string): boolean =>
  seekerGenesisMember(data, mint) !== null;

// --- Verification ---

/**
 * `moved`: a real SGT that `holder` no longer holds (SGTs can move between Seed Vault accounts).
 * `no-account`: nothing at the address (never a mint, or closed after a burn).
 */
export type GenesisStanding = "held" | "moved" | "no-account" | "not-genesis";

const INVALID = "Invalid Solana response";

const mainnetEndpoints = new Map<string, Promise<void>>();

/**
 * Throws unless `endpoint` is mainnet; any other cluster reports every real SGT as missing.
 * Cached per endpoint; failures are not cached.
 */
export function assertMainnet(endpoint: string): Promise<void> {
  let checked = mainnetEndpoints.get(endpoint);
  if (!checked) {
    const asking = request<unknown>(endpoint, "getGenesisHash", []).then((hash) => {
      if (hash !== MAINNET_GENESIS_HASH) throw new Error("This Solana connection is not mainnet.");
    });
    asking.catch(() => {
      if (mainnetEndpoints.get(endpoint) === asking) mainnetEndpoints.delete(endpoint);
    });
    mainnetEndpoints.set(endpoint, asking);
    checked = asking;
  }
  return checked;
}

/**
 * Check a claim against mainnet. `endpoint` must never come from a link or document. Throws on
 * RPC failure so an unreachable network never reads as "not held".
 */
export async function verifyGenesisToken(
  endpoint: string,
  mint: string,
  holder: string,
): Promise<GenesisStanding> {
  return (await genesisHolding(endpoint, mint, holder)).standing;
}

async function genesisHolding(
  endpoint: string,
  mint: string,
  holder: string,
): Promise<{ standing: "held"; tokenAccount: string } | { standing: Exclude<GenesisStanding, "held"> }> {
  address(mint);
  address(holder);
  const [, bytes] = await Promise.all([assertMainnet(endpoint), mintSlice(endpoint, mint)]);
  if (bytes === null) return { standing: "no-account" };
  if (bytes === "other" || !isSeekerGenesisMint(bytes, mint)) return { standing: "not-genesis" };

  const { value: accounts } = await request<{ value: unknown }>(endpoint, "getTokenAccountsByOwner", [
    holder,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  if (!Array.isArray(accounts)) throw new Error(INVALID);
  for (const entry of accounts) {
    const row = object(entry);
    const parsed = object(object(object(object(row?.account)?.data)?.parsed)?.info);
    const amount = object(parsed?.tokenAmount)?.amount;
    if (!row || typeof row.pubkey !== "string" || !parsed || parsed.mint !== mint || parsed.owner !== holder ||
        typeof amount !== "string" || !/^\d+$/.test(amount))
      throw new Error(INVALID);
    // Moving an SGT out leaves the old token account open at zero.
    if (amount !== "0") return { standing: "held", tokenAccount: address(row.pubkey) };
  }
  return { standing: "moved" };
}

/** First `MINT_SLICE_BYTES` of `mint`; `null` if absent, `"other"` if not owned by Token-2022. */
async function mintSlice(endpoint: string, mint: string): Promise<Uint8Array | "other" | null> {
  const { value: account } = await request<{ value: unknown }>(endpoint, "getAccountInfo", [
    mint,
    { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: MINT_SLICE_BYTES } },
  ]);
  return sliceOf(account);
}

function sliceOf(account: unknown): Uint8Array | "other" | null {
  if (account === null) return null;
  const info = object(account);
  if (!info || typeof info.owner !== "string") throw new Error(INVALID);
  if (info.owner !== TOKEN_2022_PROGRAM) return "other";
  const data = info.data;
  if (!Array.isArray(data) || data[1] !== "base64" || typeof data[0] !== "string") throw new Error(INVALID);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(getBase64Encoder().encode(data[0]));
  } catch {
    throw new Error(INVALID);
  }
  // Endpoints may ignore dataSlice.
  return bytes.subarray(0, MINT_SLICE_BYTES);
}

// --- Finding a wallet's SGT ---

/**
 * Mint of a `jsonParsed` token account holding exactly 1 of a 0-decimal mint, else `null`.
 * Frozen is accepted: held SGTs are always frozen.
 */
export function singleUnitMint(info: unknown): string | null {
  const parsed = object(info);
  const amount = object(parsed?.tokenAmount);
  if (!parsed || !amount || amount.decimals !== 0 || amount.amount !== "1" || typeof parsed.mint !== "string")
    return null;
  return parsed.mint;
}

/** `preferred` (last time's pick) if still present, so the choice is stable; else the lowest member. */
export function chooseGenesis<T extends { mint: string; member: bigint }>(found: readonly T[], preferred?: string): T | null {
  if (found.length === 0) return null;
  return found.find(({ mint }) => mint === preferred) ?? found.reduce((a, b) => (b.member < a.member ? b : a));
}

// --- Display ---

/** `unavailable`: mainnet could not be reached. */
export type GenesisCheck = GenesisStanding | "checking" | "unavailable";

/** Keys of `proof.genesisStanding` in `src/ui/copy.ts`. */
export type GenesisLine = "checking" | "held" | "not-held" | "not-genesis" | "unavailable";

export function genesisDisplay(check: GenesisCheck): { line: GenesisLine } {
  switch (check) {
    case "held":
      return { line: "held" };
    case "moved":
      return { line: "not-held" };
    case "no-account":
      return { line: "not-genesis" };
    default:
      return { line: check };
  }
}
