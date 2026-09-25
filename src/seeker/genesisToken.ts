import {
  getBase64Encoder,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import {
  MAINNET_GENESIS_HASH,
  MINT_SLICE_BYTES,
  seekerGenesisMember,
} from "../../publications/core/genesisToken";

/**
 * Seeker Genesis Token (SGT) detection, per Solana Mobile's recipe
 * (https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token): a Token-2022 mint whose
 * metadata pointer and group membership name Solana Mobile's group. That check is
 * `seekerGenesisMember`, the same one every reader of a published document runs
 * (`publications/core/genesisToken.ts`).
 *
 * Only accounts holding exactly one unit of a 0-decimal mint are looked at, as a held SGT does: an
 * SGT sent away leaves an open, empty account, and a wallet full of spam tokens costs no extra
 * mint reads. Frozen accounts are accepted (a held SGT is always frozen). Mainnet only. The mint
 * found here is what a publication records; whoever reads it checks it again, so nothing trusts
 * this lookup.
 *
 * Import the package root only: its `confidential` entry point pulls in WASM that Hermes cannot load.
 */

/** `getMultipleAccounts` takes at most 100 keys. */
const MINT_BATCH = 100;

const base64Encoder = getBase64Encoder();

/** Per client, for the session: the answer to "is this mainnet?". A failure is asked again. */
const mainnetClients = new WeakMap<object, Promise<void>>();

function assertMainnetClient(rpc: Rpc<SolanaRpcApi>, abortSignal?: AbortSignal): Promise<void> {
  let checked = mainnetClients.get(rpc);
  if (!checked) {
    const asking = rpc.getGenesisHash().send({ abortSignal }).then((hash) => {
      if (hash !== MAINNET_GENESIS_HASH) throw new Error("This Solana connection is not mainnet.");
    });
    asking.catch(() => {
      if (mainnetClients.get(rpc) === asking) mainnetClients.delete(rpc);
    });
    mainnetClients.set(rpc, asking);
    checked = asking;
  }
  return checked;
}

/**
 * The mint address of an SGT held by `owner` now, or null. A wallet can hold several: `preferred`
 * (the one found last time) when it is still among them, so the Seeker a wallet names stays the
 * same; otherwise the lowest member number. Throws on RPC failure, or when `rpc` is not mainnet,
 * so neither is mistaken for "does not hold one". `abortSignal` bounds every request made here.
 */
export async function findSeekerGenesisToken(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address,
  abortSignal?: AbortSignal,
  preferred?: string,
): Promise<Address | null> {
  const [, { value: tokenAccounts }] = await Promise.all([
    assertMainnetClient(rpc, abortSignal),
    rpc
      .getTokenAccountsByOwner(
        owner,
        { programId: TOKEN_2022_PROGRAM_ADDRESS },
        { encoding: "jsonParsed" },
      )
      .send({ abortSignal }),
  ]);

  const mints: Address[] = [];
  const seen = new Set<string>();
  for (const { account } of tokenAccounts) {
    const info = account.data.parsed?.info;
    // One unit of a 0-decimal mint, as a held SGT is. Zero = a token account the SGT has left.
    if (!info || info.tokenAmount?.decimals !== 0 || info.tokenAmount.amount !== "1") continue;
    const mint = info.mint;
    if (typeof mint !== "string" || seen.has(mint)) continue;
    seen.add(mint);
    mints.push(mint);
  }

  const found: { mint: Address; member: bigint }[] = [];
  for (let i = 0; i < mints.length; i += MINT_BATCH) {
    const batch = mints.slice(i, i + MINT_BATCH);
    const { value: infos } = await rpc
      .getMultipleAccounts(batch, {
        encoding: "base64",
        dataSlice: { offset: 0, length: MINT_SLICE_BYTES },
      })
      .send({ abortSignal });
    for (let j = 0; j < batch.length; j++) {
      const raw = infos[j];
      // The owner as well as the data: only the Token-2022 program can have written the extensions.
      if (!raw || raw.owner !== TOKEN_2022_PROGRAM_ADDRESS) continue;
      const member = seekerGenesisMember(new Uint8Array(base64Encoder.encode(raw.data[0])), batch[j]);
      if (member !== null) found.push({ mint: batch[j], member });
    }
  }
  if (found.length === 0) return null;
  const kept = found.find(({ mint }) => mint === preferred);
  if (kept) return kept.mint;
  return found.reduce((a, b) => (b.member < a.member ? b : a)).mint;
}
