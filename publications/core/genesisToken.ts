/**
 * The Seeker Genesis Token part of a published document (`seedshot-genesis/1`).
 *
 * At publish time the app looks up the publishing wallet's SGT on mainnet and writes its MINT
 * ADDRESS into the document under `properties.genesisToken`, beside a Metaplex `attributes` entry
 * a wallet or explorer shows as it is. The mint is what names the token: it stays the same when
 * the token moves, so it is the per-device identifier Solana Mobile's recipe says to use
 * (https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token).
 *
 * The document only CLAIMS a mint. Nothing here or on any screen treats the claim as checked until
 * `verifyGenesisToken` has read the mint account and the publisher's token account itself. The
 * SGT exists on mainnet only, so that check always reads mainnet, whatever cluster the edition is
 * on: the wallet address is the same keypair on every cluster.
 *
 * What it says: the publishing wallet holds the Genesis Token of a Seeker. What it does not say:
 * which device made the publication — that is `seedshot-attestation/1`, in `attestation.ts`.
 */

import { address, getAddressDecoder, getBase64Encoder } from "@solana/kit";
import { request } from "../rpc";
import type { Cluster } from "../types";
import { exactKeys, object } from "./attestation";

export const GENESIS_SCHEMA = "seedshot-genesis/1" as const;

/** Solana Mobile's metadata address and group. They are the same account. */
export const SGT_METADATA_ADDRESS = "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te";
export const SGT_GROUP_ADDRESS = SGT_METADATA_ADDRESS;

/** Mainnet's genesis hash: the one value that says which chain an endpoint is really on. */
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/**
 * Each cluster's genesis hash, read with `getGenesisHash` from the public endpoints, since the
 * Solana docs do not publish them. The app's endpoint check and the release gate share it.
 */
export const GENESIS_HASH: Record<Cluster, string> = {
  "mainnet-beta": MAINNET_GENESIS_HASH,
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** What the document carries. */
export interface GenesisClaim {
  schema: typeof GENESIS_SCHEMA;
  /** The SGT's mint address on mainnet. */
  mint: string;
}

export const genesisClaim = (mint: string): GenesisClaim => ({ schema: GENESIS_SCHEMA, mint });

/** The Metaplex-standard `attributes` entry, always the document's last. Re-derived on read. */
export function genesisAttributes(mint: string): { trait_type: string; value: string }[] {
  return [{ trait_type: "Seeker Genesis Token", value: mint }];
}

/** The claimed mint, or a throw for anything that is not exactly a `seedshot-genesis/1` claim. */
export function readGenesisClaim(value: unknown): string {
  const claim = object(value);
  if (!claim || !exactKeys(claim, ["schema", "mint"]) || claim.schema !== GENESIS_SCHEMA ||
      typeof claim.mint !== "string")
    throw new Error("genesis: bad claim");
  address(claim.mint);
  return claim.mint;
}

// ---------------------------------------------------------------------------
// The mint account, decoded by hand
// ---------------------------------------------------------------------------

/**
 * A Token-2022 mint is the 82-byte SPL `Mint`, zero padding to the 165-byte `Account` length, one
 * `AccountType` byte (1 = mint), then TLV extensions: `u16` type, `u16` length, value
 * (https://github.com/solana-program/token-2022, `extension/mod.rs`).
 */
const MINT_BASE_BYTES = 82;
const ACCOUNT_TYPE_OFFSET = 165;
/**
 * Token-2022's `Multisig::LEN`. No mint or token account is ever this long (Token-2022 pads them
 * past it), and a multisig's eleven signer keys are its creator's to choose, so 352 of its bytes
 * could be laid out as a mint that names Solana Mobile's group. Refused.
 */
const MULTISIG_BYTES = 355;
const ACCOUNT_TYPE_MINT = 1;
const EXTENSION_METADATA_POINTER = 18;
const EXTENSION_TOKEN_GROUP_MEMBER = 23;

/**
 * How much of a mint account any reader fetches. A real SGT mint is 450 bytes; anything that
 * needs more is not one, and a huge account costs no more to refuse than a small one.
 */
export const MINT_SLICE_BYTES = 4096;

/**
 * The SGT's number in Solana Mobile's group, or `null` when the mint account at `mint` is not a
 * Seeker Genesis Token. Solana Mobile's recipe: the `MetadataPointer` names their metadata
 * address and the `TokenGroupMember` names their group.
 *
 * The membership is what cannot be forged: Token-2022 writes a `TokenGroupMember` only with the
 * signature of the group's update authority (`process_initialize_member` → `check_update_authority`),
 * which is Solana Mobile's key. A mint authority or a metadata pointer is anyone's to set on a mint
 * of their own. The member's `mint` must be `mint` itself, so another mint's bytes never count.
 *
 * The caller has checked the account is owned by Token-2022. Anything unreadable is `null`, never
 * a throw.
 */
export function seekerGenesisMember(
  data: Uint8Array,
  mint: string,
): bigint | null {
  if (data.length <= ACCOUNT_TYPE_OFFSET || data.length === MULTISIG_BYTES || data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT)
    return null;
  // `is_initialized` is the byte at 45; the padding up to the account type is zero in every mint.
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
    if (type === 0) break; // `Uninitialized`: the rest of the account is unused.
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

// ---------------------------------------------------------------------------
// The check every reader runs
// ---------------------------------------------------------------------------

/**
 * `held`: the mint is a Seeker Genesis Token and `holder` holds it now. `moved`: it is one, and
 * `holder` does not hold it now (an SGT can move between a user's own Seed Vault accounts).
 * `no-account`: nothing exists at the mint address — never a mint, or one closed after its token
 * was burned. `not-genesis`: the account there is not a Seeker Genesis Token.
 */
export type GenesisStanding = "held" | "moved" | "no-account" | "not-genesis";

const INVALID = "Invalid Solana response";

const mainnetEndpoints = new Map<string, Promise<void>>();

/**
 * Refuse an endpoint that is not mainnet before any answer from it is believed: every other
 * cluster says "no such mint" for every real SGT. Asked once per endpoint per session; a failure
 * is not remembered, so a cold-start network error is retried.
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
 * Check a document's claim against mainnet. `endpoint` must be a MAINNET endpoint and is never
 * taken from a link or a document; one that is not throws. Throws on any RPC failure, so an
 * unreachable network is never mistaken for "not held".
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
    // Moving an SGT out leaves its old token account open at zero. Not ownership.
    if (amount !== "0") return { standing: "held", tokenAccount: address(row.pubkey) };
  }
  return { standing: "moved" };
}

/**
 * The first `MINT_SLICE_BYTES` of the account at `mint`: `null` when nothing is there, `"other"`
 * when it is not a Token-2022 account. The owner first: only the Token-2022 program can have
 * written the extensions, and an account of any other program's is not an SGT, whatever its size.
 */
async function mintSlice(endpoint: string, mint: string): Promise<Uint8Array | "other" | null> {
  const { value: account } = await request<{ value: unknown }>(endpoint, "getAccountInfo", [
    mint,
    { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: MINT_SLICE_BYTES } },
  ]);
  return sliceOf(account);
}

/** One account as either read answers it: `null` for none, `"other"` for another program's. */
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
  // The slice asked for, even from an endpoint that sent more.
  return bytes.subarray(0, MINT_SLICE_BYTES);
}

// ---------------------------------------------------------------------------
// Finding a wallet's token
// ---------------------------------------------------------------------------

/**
 * The mint of a parsed token account (`jsonParsed`'s `account.data.parsed.info`) that holds exactly
 * one unit of a 0-decimal mint, as a held SGT does, or `null`. Zero is a token account an SGT has
 * left; frozen is how a held SGT always is, and is accepted.
 */
export function singleUnitMint(info: unknown): string | null {
  const parsed = object(info);
  const amount = object(parsed?.tokenAmount);
  if (!parsed || !amount || amount.decimals !== 0 || amount.amount !== "1" || typeof parsed.mint !== "string")
    return null;
  return parsed.mint;
}

/**
 * Of a wallet's SGTs, the one it is known by: `preferred` (the one found last time) while it is
 * still among them, so the Seeker a wallet names stays the same; otherwise the lowest member number.
 */
export function chooseGenesis<T extends { mint: string; member: bigint }>(found: readonly T[], preferred?: string): T | null {
  if (found.length === 0) return null;
  return found.find(({ mint }) => mint === preferred) ?? found.reduce((a, b) => (b.member < a.member ? b : a));
}

// ---------------------------------------------------------------------------
// What a screen says
// ---------------------------------------------------------------------------

/** A claim's check as a screen holds it. `unavailable`: mainnet could not be asked. */
export type GenesisCheck = GenesisStanding | "checking" | "unavailable";

/** The row's line: a key of `proof.genesisStanding` in `src/ui/copy.ts`. */
export type GenesisLine = "checking" | "held" | "not-held" | "not-genesis" | "unavailable";

/** The Genesis Token row for a claim. */
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
