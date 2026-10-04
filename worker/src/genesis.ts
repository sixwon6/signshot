/**
 * Which Seeker Genesis Token a wallet holds on mainnet, by Solana Mobile's server-side recipe
 * (https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token):
 *
 *   - the wallet's Token-2022 accounts through Helius's `getTokenAccountsByOwnerV2`, paginated;
 *   - empty token accounts skipped (moving an SGT out leaves the old account open at zero);
 *   - each candidate mint's MetadataPointer and TokenGroupMember must name Solana Mobile's
 *     address `GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te`;
 *   - the MINT is returned, not a boolean: it is what uniqueness is recorded against.
 *
 * The mint rules are the app's (`publications/core/genesisToken.ts`, copied, not imported):
 * the account must be owned by Token-2022, be an initialized mint (not a multisig), and the
 * TokenGroupMember's `mint` must be the mint itself. The group membership is what cannot be
 * forged: Token-2022 writes it only with the group update authority's signature.
 *
 * The SGT exists on mainnet only, so this always reads mainnet, whatever cluster the edition is on.
 */

import { getAddressDecoder, getBase64Encoder, isAddress } from "@solana/kit";
import { assertCluster, object, rpc, RpcError, type Fetch } from "./rpc";

export const SGT_METADATA_ADDRESS = "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te";
export const SGT_GROUP_ADDRESS = SGT_METADATA_ADDRESS;
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const MINT_BASE_BYTES = 82;
const ACCOUNT_TYPE_OFFSET = 165;
/** Token-2022's `Multisig::LEN`: never a mint, and its signer keys are its creator's to choose. */
const MULTISIG_BYTES = 355;
const ACCOUNT_TYPE_MINT = 1;
const EXTENSION_METADATA_POINTER = 18;
const EXTENSION_TOKEN_GROUP_MEMBER = 23;
/** A real SGT mint is 450 bytes; anything needing more is not one. */
export const MINT_SLICE_BYTES = 4096;

/** The SGT's member number, or `null` when the mint account bytes are not a Seeker Genesis Token. */
export function seekerGenesisMember(data: Uint8Array, mint: string): bigint | null {
  if (data.length <= ACCOUNT_TYPE_OFFSET || data.length === MULTISIG_BYTES || data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT)
    return null;
  // `is_initialized` is the byte at 45; the padding up to the account type is zero in every mint.
  if (data[45] !== 1 || data.subarray(MINT_BASE_BYTES, ACCOUNT_TYPE_OFFSET).some((byte) => byte !== 0)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = getAddressDecoder();
  const key = (at: number) => decoder.decode(data.subarray(at, at + 32));

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
      // `authority`, then `metadata_address`.
      if (length !== 64 || pointerOk !== undefined) return null;
      pointerOk = key(value + 32) === SGT_METADATA_ADDRESS;
    } else if (type === EXTENSION_TOKEN_GROUP_MEMBER) {
      // `mint`, `group`, then the `u64` member number.
      if (length !== 72 || member !== undefined) return null;
      member = key(value) === mint && key(value + 32) === SGT_GROUP_ADDRESS ? view.getBigUint64(value + 64, true) : null;
    }
    at = value + length;
  }
  return pointerOk && member !== undefined ? member : null;
}

/** Pages of 1000 token accounts; a wallet with more is refused rather than half-checked. */
const PAGE_LIMIT = 1000;
const MAX_PAGES = 2;
/** `getMultipleAccounts` takes at most 100 keys. */
const MINT_BATCH = 100;
/** Candidate mints read at most; anyone can send a wallet single-unit tokens. */
export const MAX_GENESIS_CANDIDATES = 1000;

export class TooManyTokens extends Error {}

/**
 * Every Seeker Genesis Token mint the wallet holds on mainnet, lowest member number first (empty
 * when none). Throws `RpcError` on any RPC failure, so "unreachable" is never "none".
 */
export async function findSeekerGenesisTokens(fetchImpl: Fetch, mainnetUrl: string, wallet: string): Promise<string[]> {
  await assertCluster(fetchImpl, mainnetUrl, "mainnet-beta");

  const rows: unknown[] = [];
  let paginationKey: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page === MAX_PAGES) throw new TooManyTokens();
    const result = object(await rpc<unknown>(fetchImpl, mainnetUrl, "getTokenAccountsByOwnerV2", [
      wallet,
      { programId: TOKEN_2022_PROGRAM },
      { encoding: "jsonParsed", limit: PAGE_LIMIT, ...(paginationKey ? { paginationKey } : {}) },
    ]));
    // Without `withContext` the accounts are `result.value` and the key `result.paginationKey`;
    // with it, both sit under `result.value` (the recipe handles both).
    const shaped = Array.isArray(result?.value)
      ? { accounts: result.value, paginationKey: result.paginationKey }
      : object(result?.value);
    if (!shaped || !Array.isArray(shaped.accounts)) throw new RpcError("getTokenAccountsByOwnerV2");
    rows.push(...shaped.accounts);
    if (typeof shaped.paginationKey !== "string" || shaped.paginationKey === "") break;
    paginationKey = shaped.paginationKey;
  }

  // A held SGT is exactly one unit of a 0-decimal mint, in a token account the wallet owns.
  // Zero is an account an SGT has left. Frozen is how a held SGT always is, and is accepted.
  const candidates: string[] = [];
  for (const row of rows) {
    const account = object(object(row)?.account);
    const info = object(object(object(account?.data)?.parsed)?.info);
    const amount = object(info?.tokenAmount);
    if (!info || !amount || account?.owner !== TOKEN_2022_PROGRAM || info.owner !== wallet) continue;
    if (amount.amount !== "1" || amount.decimals !== 0) continue;
    const mint = info.mint;
    if (typeof mint !== "string" || !isAddress(mint) || candidates.includes(mint)) continue;
    candidates.push(mint);
  }
  if (candidates.length > MAX_GENESIS_CANDIDATES) throw new TooManyTokens();

  const found: { mint: string; member: bigint }[] = [];
  for (let i = 0; i < candidates.length; i += MINT_BATCH) {
    const batch = candidates.slice(i, i + MINT_BATCH);
    const result = object(await rpc<unknown>(fetchImpl, mainnetUrl, "getMultipleAccounts", [
      batch,
      { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: MINT_SLICE_BYTES } },
    ]));
    const accounts = result?.value;
    if (!Array.isArray(accounts) || accounts.length !== batch.length) throw new RpcError("getMultipleAccounts");
    accounts.forEach((entry, j) => {
      const bytes = mintBytes(entry);
      const member = bytes ? seekerGenesisMember(bytes, batch[j]) : null;
      if (member !== null) found.push({ mint: batch[j], member });
    });
  }
  return found.sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : 0)).map((f) => f.mint);
}

/** A Token-2022 account's bytes (at most `MINT_SLICE_BYTES`), or `null` for none or another program's. */
function mintBytes(entry: unknown): Uint8Array | null {
  if (entry === null) return null;
  const info = object(entry);
  if (!info || typeof info.owner !== "string") throw new RpcError("getMultipleAccounts");
  if (info.owner !== TOKEN_2022_PROGRAM) return null;
  const data = info.data;
  if (!Array.isArray(data) || data[1] !== "base64" || typeof data[0] !== "string") throw new RpcError("getMultipleAccounts");
  try {
    return new Uint8Array(getBase64Encoder().encode(data[0])).subarray(0, MINT_SLICE_BYTES);
  } catch {
    throw new RpcError("getMultipleAccounts");
  }
}
