/**
 * The Seeker Genesis Token part of a published document (`seedshot-genesis/1`).
 *
 * At publish time the app looks up the publishing wallet's SGT on mainnet and writes its MINT
 * ADDRESS into the document under `properties.genesisToken`, beside a Metaplex `attributes` entry
 * a wallet or explorer shows as it is. The document's hash is on chain and the publishing wallet
 * signed the transaction that put it there, so the checks of Solana Mobile's recipe
 * (https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token) are all answerable by
 * a stranger, from the chain alone:
 *
 *   1. the wallet owns an SGT          — `verifyGenesisToken`, against mainnet, by every reader;
 *   2. the user proved wallet ownership — the wallet signed the publication that names the mint;
 *   3. the token is known by its mint   — it stays the same when the token moves, so it is the
 *                                         per-device identifier the recipe says to return.
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
 * (https://github.com/solana-program/token-2022, `extension/mod.rs`). `scripts/check-genesis.ts`
 * holds this decoder to the official `@solana-program/token-2022` encoder.
 */
const MINT_BASE_BYTES = 82;
const ACCOUNT_TYPE_OFFSET = 165;
/**
 * Token-2022's `Multisig::LEN`. No mint or token account is ever this long (Token-2022 pads them
 * past it), and a multisig's eleven signer keys are its creator's to choose, so 352 of its bytes
 * could be laid out as a mint that names Solana Mobile's group. Refused, as the program refuses it.
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

/** Solana Mobile's addresses, or the devnet acceptance's stand-ins (`publications/devnet/genesisFixture.ts`). */
export interface GenesisAddresses {
  metadataAddress: string;
  groupAddress: string;
}

const SOLANA_MOBILE: GenesisAddresses = { metadataAddress: SGT_METADATA_ADDRESS, groupAddress: SGT_GROUP_ADDRESS };

/**
 * The SGT's number in Solana Mobile's group, or `null` when the mint account at `mint` is not a
 * Seeker Genesis Token. Solana Mobile's recipe: the `MetadataPointer` names their metadata
 * address and the `TokenGroupMember` names their group.
 *
 * The membership is what cannot be forged: Token-2022 writes a `TokenGroupMember` only with the
 * signature of the group's update authority (`process_initialize_member` → `check_update_authority`),
 * which is Solana Mobile's key. A mint authority or a metadata pointer is anyone's to set on a mint
 * of their own. The member's `mint` must be `mint` itself, which is where Token-2022 writes it:
 * bytes that name another mint are not this account's, whoever sent them.
 *
 * The caller has checked the account is owned by Token-2022, the only program that can have
 * written these extensions. Anything unreadable is `null`, never a throw. `expected` is for the
 * devnet acceptance only; every real check uses the defaults.
 */
export function seekerGenesisMember(
  data: Uint8Array,
  mint: string,
  expected: GenesisAddresses = SOLANA_MOBILE,
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
      pointerOk = key(value + 32) === expected.metadataAddress;
    } else if (type === EXTENSION_TOKEN_GROUP_MEMBER) {
      // `mint`, `group`, then the `u64` member number.
      if (length !== 72 || member !== undefined) return null;
      member = key(value) === mint && key(value + 32) === expected.groupAddress
        ? view.getBigUint64(value + 64, true)
        : null;
    }
    at = value + length;
  }
  return pointerOk && member !== undefined ? member : null;
}

export const isSeekerGenesisMint = (data: Uint8Array, mint: string, expected?: GenesisAddresses): boolean =>
  seekerGenesisMember(data, mint, expected) !== null;

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

/**
 * The token account through which `holder` holds the Genesis Token `mint` right now, or `null`.
 * What `publish` takes beside the mint (`GenesisAccounts` in `protocol.ts`), read from the
 * cluster the edition is on immediately before the transaction is built. Throws on RPC failure.
 */
export async function findGenesisTokenAccount(
  endpoint: string,
  mint: string,
  holder: string,
): Promise<string | null> {
  const holding = await genesisHolding(endpoint, mint, holder);
  return holding.standing === "held" ? holding.tokenAccount : null;
}

async function genesisHolding(
  endpoint: string,
  mint: string,
  holder: string,
): Promise<{ standing: "held"; tokenAccount: string } | { standing: Exclude<GenesisStanding, "held"> }> {
  address(mint);
  address(holder);
  const [, { value: account }] = await Promise.all([
    assertMainnet(endpoint),
    request<{ value: unknown }>(endpoint, "getAccountInfo", [
      mint,
      { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: MINT_SLICE_BYTES } },
    ]),
  ]);
  if (account === null) return { standing: "no-account" };
  const info = object(account);
  if (!info || typeof info.owner !== "string") throw new Error(INVALID);
  // The owner first: only the Token-2022 program can have written these extensions, and an
  // account of any other program's is not an SGT, whatever its size.
  if (info.owner !== TOKEN_2022_PROGRAM) return { standing: "not-genesis" };
  const data = info.data;
  if (!Array.isArray(data) || data[1] !== "base64" || typeof data[0] !== "string") throw new Error(INVALID);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(getBase64Encoder().encode(data[0]));
  } catch {
    throw new Error(INVALID);
  }
  // The slice asked for, even from an endpoint that sent more.
  if (!isSeekerGenesisMint(bytes.subarray(0, MINT_SLICE_BYTES), mint)) return { standing: "not-genesis" };

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

// ---------------------------------------------------------------------------
// What a screen says
// ---------------------------------------------------------------------------

/** A claim's check as a screen holds it. `unavailable`: mainnet could not be asked. */
export type GenesisCheck = GenesisStanding | "checking" | "unavailable";

/** The row's line: a key of `proof.genesisStanding` in `src/ui/copy.ts` and of `GENESIS_LINE`. */
export type GenesisLine = "checking" | "held" | "not-held" | "not-held-now" | "not-genesis" | "unavailable";

/**
 * The Genesis Token row for a claim, the same on the Proof sheet and the collect page. `sealed` is
 * the edition's seal (`genesisSealed`). A seal counts on mainnet only: a devnet seal comes from
 * the acceptance build's stand-ins. A counted seal says the program verified the SGT at publish,
 * so "now" is only said of a sealed claim, and a sealed mint whose account is gone was burned, not
 * forged. The seal line shows only once mainnet has found the mint to be a real SGT.
 */
export function genesisDisplay(
  check: GenesisCheck,
  edition: { cluster: Cluster; sealed: boolean },
): { line: GenesisLine; sealed: boolean } {
  const sealed = edition.cluster === "mainnet-beta" && edition.sealed;
  switch (check) {
    case "held":
      return { line: "held", sealed };
    case "moved":
      return { line: sealed ? "not-held-now" : "not-held", sealed };
    case "no-account":
      return { line: sealed ? "not-held-now" : "not-genesis", sealed: false };
    default:
      return { line: check, sealed: false };
  }
}
