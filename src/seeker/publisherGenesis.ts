/**
 * SGT mint to record in a `signshot-genesis/1` claim. Always read from mainnet: the wallet is the
 * same keypair on every cluster. Never throws, never hangs.
 * `null`: holds none. `undefined`: mainnet unreachable. Only ever a mint just found on chain.
 */

import type { Address } from "@solana/kit";
import { rpcWithTimeout } from "../../publications/rpc";
import { genesisClaim, readGenesisClaim } from "../../publications/core/genesisToken";
import { getMainnetReadRpc } from "../solana/cluster";
import { findSeekerGenesisToken } from "./genesisToken";
import { lastKnownGenesisMint } from "./useSeekerIdentity";
import { safeErrorText } from "../ui/errorText";

export async function publisherGenesisMint(wallet: string): Promise<string | null | undefined> {
  let mint: string | null;
  try {
    // Which of several SGTs to name, never whether to name one.
    const preferred = await lastKnownGenesisMint(wallet).catch(() => undefined);
    mint = await rpcWithTimeout((signal) =>
      findSeekerGenesisToken(getMainnetReadRpc(), wallet as Address, signal, preferred),
    );
  } catch (error) {
    // RPC errors quote the endpoint URL.
    console.warn(`genesis token lookup unavailable: ${safeErrorText(error)}`);
    return undefined;
  }
  if (mint === null) return null;
  // Round-trip through the reader: a claim it refuses would make the document unreadable.
  try {
    return readGenesisClaim(genesisClaim(mint));
  } catch {
    return undefined;
  }
}
