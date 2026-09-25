/**
 * The publish-time side of `seedshot-genesis/1`: the Seeker Genesis Token mint a publication by
 * `wallet` records. Read from mainnet whatever cluster this build publishes on, since the wallet
 * is the same keypair on every cluster. Never throws and never waits forever: a wallet with no
 * SGT, or a mainnet that does not answer and no earlier answer to fall back on, publishes without
 * the claim, exactly as before.
 */

import type { Address } from "@solana/kit";
import { rpcWithTimeout } from "../../publications/rpc";
import { genesisClaim, readGenesisClaim } from "../../publications/core/genesisToken";
import { getMainnetReadRpc } from "../solana/cluster";
import { findSeekerGenesisToken } from "./genesisToken";
import { lastKnownGenesisMint } from "./useSeekerIdentity";
import { safeErrorText } from "../ui/errorText";

export async function publisherGenesisMint(wallet: string): Promise<string | null> {
  let mint: string | null;
  try {
    mint = await rpcWithTimeout((signal) =>
      findSeekerGenesisToken(getMainnetReadRpc(), wallet as Address, signal),
    );
  } catch (error) {
    // Through the filter: an RPC failure quotes the endpoint URL.
    console.warn(`genesis token lookup unavailable: ${safeErrorText(error)}`);
    mint = (await lastKnownGenesisMint(wallet).catch(() => undefined)) ?? null;
  }
  if (mint === null) return null;
  // Read back as a stranger would: a claim the reader refuses would make the document unreadable.
  try {
    return readGenesisClaim(genesisClaim(mint));
  } catch {
    return null;
  }
}
