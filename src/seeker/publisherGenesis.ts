/**
 * The publish-time side of `signshot-genesis/1`: the Seeker Genesis Token mint a publication by
 * `wallet` records. Read from mainnet whatever cluster this build publishes on, since the wallet
 * is the same keypair on every cluster. Never throws and never waits forever.
 *
 * `null`: the wallet holds none. `undefined`: mainnet could not be asked; the document names none
 * and the review says so. A document only ever names a mint this lookup has just found on
 * mainnet, never a remembered one.
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
    // Through the filter: an RPC failure quotes the endpoint URL.
    console.warn(`genesis token lookup unavailable: ${safeErrorText(error)}`);
    return undefined;
  }
  if (mint === null) return null;
  // Read back as a stranger would: a claim the reader refuses would make the document unreadable.
  try {
    return readGenesisClaim(genesisClaim(mint));
  } catch {
    return undefined;
  }
}
