import {
  address,
  getBase64Encoder,
  unwrapOption,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  getMintDecoder,
  isExtension,
} from "@solana-program/token-2022";

/**
 * Seeker Genesis Token (SGT) detection, per Solana Mobile's recipe
 * (https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token). A mint is an SGT only
 * when its mint authority, metadata pointer and group membership all match; any one alone can be forged.
 *
 * Zero-balance accounts are skipped (an SGT sent away leaves an open, empty ATA); frozen accounts
 * are accepted (a held SGT is always frozen). Client-side and mainnet only: fine for a cosmetic
 * unlock, never a guarantee of ownership.
 *
 * Import the package root only: its `confidential` entry point pulls in WASM that Hermes cannot load.
 */

const SGT_MINT_AUTHORITY = address("GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4");
/** Metadata address and group address are intentionally the same account. */
const SGT_METADATA_ADDRESS = address("GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te");
const SGT_GROUP_ADDRESS = SGT_METADATA_ADDRESS;

const MINT_BATCH = 100;

const base64Encoder = getBase64Encoder();
const mintDecoder = getMintDecoder();

/**
 * The mint address of an SGT currently held by `owner`, or null. Throws on RPC failure so a
 * network error is never mistaken for "does not hold one".
 */
export async function findSeekerGenesisToken(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address,
): Promise<Address | null> {
  const { value: tokenAccounts } = await rpc
    .getTokenAccountsByOwner(
      owner,
      { programId: TOKEN_2022_PROGRAM_ADDRESS },
      { encoding: "jsonParsed" },
    )
    .send();

  const mints: Address[] = [];
  const seen = new Set<string>();
  for (const { account } of tokenAccounts) {
    const info = account.data.parsed?.info;
    // Zero balance = a token account the SGT has left. Not ownership.
    if (!info || info.tokenAmount?.amount === "0") continue;
    const mint = info.mint;
    if (typeof mint !== "string" || seen.has(mint)) continue;
    seen.add(mint);
    mints.push(mint);
  }
  if (mints.length === 0) return null;

  for (let i = 0; i < mints.length; i += MINT_BATCH) {
    const batch = mints.slice(i, i + MINT_BATCH);
    const { value: infos } = await rpc
      .getMultipleAccounts(batch, { encoding: "base64" })
      .send();
    for (let j = 0; j < batch.length; j++) {
      const raw = infos[j];
      if (!raw) continue;
      if (isSeekerGenesisMint(raw.data[0])) return batch[j];
    }
  }
  return null;
}

/**
 * All three properties of the mint account, from its raw base64 data. A decode failure means
 * "not a Token-2022 mint we can read", which is certainly not an SGT — never a throw, so one
 * odd account in the wallet cannot make the whole lookup look like an RPC outage.
 */
function isSeekerGenesisMint(dataBase64: string): boolean {
  let mint: ReturnType<typeof mintDecoder.decode>;
  try {
    mint = mintDecoder.decode(base64Encoder.encode(dataBase64));
  } catch {
    return false;
  }

  if (unwrapOption(mint.mintAuthority) !== SGT_MINT_AUTHORITY) return false;

  const extensions = unwrapOption(mint.extensions);
  if (extensions === null) return false;

  let pointerOk = false;
  let memberOk = false;
  for (const ext of extensions) {
    if (isExtension("MetadataPointer", ext)) {
      pointerOk =
        unwrapOption(ext.authority) === SGT_MINT_AUTHORITY &&
        unwrapOption(ext.metadataAddress) === SGT_METADATA_ADDRESS;
    } else if (isExtension("TokenGroupMember", ext)) {
      memberOk = ext.group === SGT_GROUP_ADDRESS;
    }
  }
  return pointerOk && memberOk;
}
