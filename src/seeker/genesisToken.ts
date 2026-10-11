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
  chooseGenesis,
  seekerGenesisMember,
  singleUnitMint,
} from "../../publications/core/genesisToken";

/**
 * Seeker Genesis Token detection per
 * https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token: a Token-2022 mint whose
 * metadata pointer and group membership name Solana Mobile's group. Mainnet only. Readers re-check
 * the recorded mint, so nothing trusts this lookup.
 *
 * Import the token-2022 package root only: its `confidential` entry pulls in WASM Hermes can't load.
 */

/** `getMultipleAccounts` takes at most 100 keys. */
const MINT_BATCH = 100;

const base64Encoder = getBase64Encoder();

/** Per-client mainnet check; failures are retried. */
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
 * SGT mint held by `owner`, or null. With several, `preferred` if still held (keeps the named
 * Seeker stable), else the lowest member number. Throws on RPC failure or non-mainnet `rpc` so
 * neither reads as "holds none".
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
    // A sent-away SGT leaves an empty account; this also skips spam without extra mint reads.
    const mint = singleUnitMint(account.data.parsed?.info);
    if (mint === null || seen.has(mint)) continue;
    seen.add(mint);
    mints.push(mint as Address);
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
      // Check the owner: only Token-2022 can have written the extensions.
      if (!raw || raw.owner !== TOKEN_2022_PROGRAM_ADDRESS) continue;
      const member = seekerGenesisMember(new Uint8Array(base64Encoder.encode(raw.data[0])), batch[j]);
      if (member !== null) found.push({ mint: batch[j], member });
    }
  }
  return chooseGenesis(found, preferred)?.mint ?? null;
}
