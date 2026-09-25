import {
  getBase64Encoder,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { isSeekerGenesisMint } from "../../publications/core/genesisToken";

/**
 * Seeker Genesis Token (SGT) detection, per Solana Mobile's recipe
 * (https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token). A mint is an SGT only
 * when its mint authority, metadata pointer and group membership all match; any one alone can be
 * forged. That check is `isSeekerGenesisMint`, the same one every reader of a published document
 * runs (`publications/core/genesisToken.ts`).
 *
 * Zero-balance accounts are skipped (an SGT sent away leaves an open, empty ATA); frozen accounts
 * are accepted (a held SGT is always frozen). Mainnet only. The mint found here is what a
 * publication records; whoever reads it checks it again, so nothing trusts this lookup.
 *
 * Import the package root only: its `confidential` entry point pulls in WASM that Hermes cannot load.
 */

const MINT_BATCH = 100;

const base64Encoder = getBase64Encoder();

/**
 * The mint address of an SGT currently held by `owner`, or null. Throws on RPC failure so a
 * network error is never mistaken for "does not hold one". `rpc` must be a mainnet client;
 * `abortSignal` bounds every request made here.
 */
export async function findSeekerGenesisToken(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address,
  abortSignal?: AbortSignal,
): Promise<Address | null> {
  const { value: tokenAccounts } = await rpc
    .getTokenAccountsByOwner(
      owner,
      { programId: TOKEN_2022_PROGRAM_ADDRESS },
      { encoding: "jsonParsed" },
    )
    .send({ abortSignal });

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
      .send({ abortSignal });
    for (let j = 0; j < batch.length; j++) {
      const raw = infos[j];
      // The owner as well as the data: only the Token-2022 program can have written the extensions.
      if (!raw || raw.owner !== TOKEN_2022_PROGRAM_ADDRESS) continue;
      if (isSeekerGenesisMint(new Uint8Array(base64Encoder.encode(raw.data[0])))) return batch[j];
    }
  }
  return null;
}
