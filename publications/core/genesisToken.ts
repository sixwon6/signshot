/**
 * The Seeker Genesis Token part of a published document (`seedshot-genesis/1`).
 *
 * At publish time the app looks up the publishing wallet's SGT on mainnet and writes its MINT
 * ADDRESS into the document under `properties.genesisToken`, beside a Metaplex `attributes` entry
 * a wallet or explorer shows as it is. The document's hash is on chain and the publishing wallet
 * signed the transaction that put it there, so the three checks of Solana Mobile's recipe
 * (https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token) are all answerable by
 * a stranger, from the chain alone:
 *
 *   1. the wallet owns an SGT          — `verifyGenesisToken`, against mainnet, by every reader;
 *   2. the user proved wallet ownership — the wallet signed the publication that names the mint;
 *   3. the mint address is recorded     — it stays the same when the token moves, so it is the
 *                                         per-device identifier the recipe says to keep.
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
import { exactKeys, object } from "./attestation";

export const GENESIS_SCHEMA = "seedshot-genesis/1" as const;

/** The three addresses of Solana Mobile's recipe. Metadata and group are the same account. */
export const SGT_MINT_AUTHORITY = "GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4";
export const SGT_METADATA_ADDRESS = "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te";
export const SGT_GROUP_ADDRESS = SGT_METADATA_ADDRESS;

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
const ACCOUNT_TYPE_MINT = 1;
const EXTENSION_METADATA_POINTER = 18;
const EXTENSION_TOKEN_GROUP_MEMBER = 23;

/** Solana Mobile's addresses, or the devnet acceptance's stand-ins (`publications/devnet/genesisFixture.ts`). */
export interface GenesisAddresses {
  mintAuthority: string;
  metadataAddress: string;
}

/**
 * All three properties of the recipe, from the mint account's raw data: the mint authority, the
 * metadata pointer (its authority and its address) and the group membership. Any one alone can be
 * forged; together they need Solana Mobile's own key. Anything unreadable is "not an SGT", never
 * a throw. `expected` is for the devnet acceptance only; every real check uses the defaults.
 */
export function isSeekerGenesisMint(
  data: Uint8Array,
  expected: GenesisAddresses = { mintAuthority: SGT_MINT_AUTHORITY, metadataAddress: SGT_METADATA_ADDRESS },
): boolean {
  if (data.length <= ACCOUNT_TYPE_OFFSET || data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (at: number) => getAddressDecoder().decode(data.subarray(at, at + 32));
  // `COption<Pubkey>`: a u32 tag, then the key. `is_initialized` is the byte at 45.
  if (view.getUint32(0, true) !== 1 || key(4) !== expected.mintAuthority || data[45] !== 1) return false;
  if (data.subarray(MINT_BASE_BYTES, ACCOUNT_TYPE_OFFSET).some((byte) => byte !== 0)) return false;

  let pointerOk = false;
  let memberOk = false;
  let at = ACCOUNT_TYPE_OFFSET + 1;
  while (at + 4 <= data.length) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    const value = at + 4;
    if (type === 0) break; // `Uninitialized`: the rest of the account is unused.
    if (value + length > data.length) return false;
    if (type === EXTENSION_METADATA_POINTER) {
      // `authority`, then `metadata_address`, each an `OptionalNonZeroPubkey`.
      if (length !== 64) return false;
      pointerOk = key(value) === expected.mintAuthority && key(value + 32) === expected.metadataAddress;
    } else if (type === EXTENSION_TOKEN_GROUP_MEMBER) {
      // `mint`, `group`, then the `u64` member number. The group is the metadata account.
      if (length !== 72) return false;
      memberOk = key(value + 32) === expected.metadataAddress;
    }
    at = value + length;
  }
  return pointerOk && memberOk;
}

// ---------------------------------------------------------------------------
// The check every reader runs
// ---------------------------------------------------------------------------

/**
 * `held`: the mint is a Seeker Genesis Token and `holder` holds it now. `moved`: it is one, and
 * `holder` does not hold it now (an SGT can move between a user's own Seed Vault accounts).
 * `not-genesis`: the claimed mint is not a Seeker Genesis Token at all.
 */
export type GenesisStanding = "held" | "moved" | "not-genesis";

const INVALID = "Invalid Solana response";

/**
 * Check a document's claim against mainnet. `endpoint` must be a MAINNET endpoint and is never
 * taken from a link or a document. Throws on any RPC failure, so an unreachable network is never
 * mistaken for "not held".
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
): Promise<{ standing: "held"; tokenAccount: string } | { standing: "moved" | "not-genesis" }> {
  address(mint);
  address(holder);
  const { value: account } = await request<{
    value: null | { owner: string; data: [string, string] };
  }>(endpoint, "getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }]);
  if (account === null) return { standing: "not-genesis" };
  if (!account || typeof account.owner !== "string" || !Array.isArray(account.data) ||
      account.data[1] !== "base64" || typeof account.data[0] !== "string" || account.data[0].length > 20000)
    throw new Error(INVALID);
  // The owner first: only the Token-2022 program can have written these extensions.
  if (account.owner !== TOKEN_2022_PROGRAM ||
      !isSeekerGenesisMint(new Uint8Array(getBase64Encoder().encode(account.data[0]))))
    return { standing: "not-genesis" };

  const { value: accounts } = await request<{ value: unknown }>(endpoint, "getTokenAccountsByOwner", [
    holder,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  if (!Array.isArray(accounts)) throw new Error(INVALID);
  for (const entry of accounts) {
    const row = object(entry);
    const info = object(object(object(object(row?.account)?.data)?.parsed)?.info);
    const amount = object(info?.tokenAmount)?.amount;
    if (!row || typeof row.pubkey !== "string" || !info || info.mint !== mint || info.owner !== holder ||
        typeof amount !== "string" || !/^\d+$/.test(amount))
      throw new Error(INVALID);
    // Moving an SGT out leaves its old token account open at zero. Not ownership.
    if (amount !== "0") return { standing: "held", tokenAccount: address(row.pubkey) };
  }
  return { standing: "moved" };
}
