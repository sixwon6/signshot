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
 * The devnet acceptance's group mint (`DEVNET_GENESIS_GROUP` in `publications/devnet/genesisFixture.ts`,
 * which `scripts/check-genesis.ts` holds this equal to). It is its own metadata address, as Solana
 * Mobile's is, and the devnet program build accepts its members in place of real SGTs.
 */
export const DEVNET_GENESIS_GROUP = "CmJzRVDQjrj8NjAcN4qKuLNKwhWJVcPKsngfAWfu88WB";

/**
 * Whose Genesis Tokens the edition program on `cluster` accepts: Solana Mobile's on mainnet, the
 * acceptance's stand-in on devnet, where no real SGT exists. A stand-in never reads as an SGT.
 */
export function genesisAddresses(cluster: Cluster): GenesisAddresses {
  return cluster === "mainnet-beta"
    ? SOLANA_MOBILE
    : { metadataAddress: DEVNET_GENESIS_GROUP, groupAddress: DEVNET_GENESIS_GROUP };
}

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

/** Mint reads one lookup may make: a wallet with more single-unit Token-2022 holdings is not checked. */
export const MAX_GENESIS_CANDIDATES = 32;

/**
 * The Genesis Token `holder` holds on `cluster` now, and the token account it sits in: what a
 * seeker-only claim hands the edition program, which keys the claim on the mint (one copy per
 * token) and checks both accounts itself. Mainnet reads Solana Mobile's SGTs and first confirms
 * the endpoint is mainnet; devnet reads the acceptance's stand-ins (`genesisAddresses`), the only
 * members the devnet program build accepts. `null` when it holds none. Throws on RPC failure and
 * past `MAX_GENESIS_CANDIDATES`, so neither is mistaken for "holds none".
 */
export async function findHeldGenesisToken(
  endpoint: string,
  holder: string,
  cluster: Cluster,
  preferred?: string,
): Promise<{ mint: string; token: string } | null> {
  address(holder);
  const [, { value: rows }] = await Promise.all([
    cluster === "mainnet-beta" ? assertMainnet(endpoint) : undefined,
    request<{ value: unknown }>(endpoint, "getTokenAccountsByOwner", [
      holder,
      { programId: TOKEN_2022_PROGRAM },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]),
  ]);
  if (!Array.isArray(rows)) throw new Error(INVALID);
  const held = new Map<string, string>();
  for (const entry of rows) {
    const row = object(entry);
    const info = object(object(object(row?.account)?.data)?.parsed)?.info;
    const mint = singleUnitMint(info);
    // The account must be the holder's own, and an address: it goes into the claim as it is.
    if (!mint || held.has(mint) || typeof row?.pubkey !== "string" || object(info)?.owner !== holder) continue;
    try {
      held.set(address(mint), address(row.pubkey));
    } catch {
      continue;
    }
  }
  if (held.size > MAX_GENESIS_CANDIDATES) throw new Error("This wallet holds too many tokens to check.");
  const expected = genesisAddresses(cluster);
  const found = (
    await Promise.all(
      [...held].map(async ([mint, token]) => {
        const bytes = await mintSlice(endpoint, mint);
        const member = bytes && bytes !== "other" ? seekerGenesisMember(bytes, mint, expected) : null;
        return member === null ? null : { mint, token, member };
      }),
    )
  ).filter((entry) => entry !== null);
  const chosen = chooseGenesis(found, preferred);
  return chosen && { mint: chosen.mint, token: chosen.token };
}

// ---------------------------------------------------------------------------
// What a screen says
// ---------------------------------------------------------------------------

/**
 * The claim a published edition carries: the document's mint (already required to equal any
 * seal). On mainnet every publication the app makes with a Genesis Token has the program verify
 * and seal it, so there a claim the program did not seal is no claim: nobody checked it at publish.
 */
export function publishedGenesisClaim(cluster: Cluster, claimed: string | undefined, sealed: string | null): string | undefined {
  return cluster === "mainnet-beta" && sealed === null ? undefined : claimed;
}

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
