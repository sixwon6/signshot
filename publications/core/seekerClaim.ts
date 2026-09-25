/**
 * Claiming a copy of a Seeker-only edition. The claim is keyed on the collector's Seeker Genesis
 * Token instead of their wallet, one copy per token, and the edition program checks the token
 * itself: `collect` and `buy` take its mint and the token account holding it, and answer
 * `GenesisTokenRequired` without them. The app's Collect sheet and the collect page both come
 * through here, so they find the same token and read the same receipt.
 */

import { findHeldGenesisToken } from "./genesisToken";
import { collectedCopy, type GenesisAccounts } from "./protocol";
import type { Cluster, CoreMetadata } from "../types";

/**
 * What a claim by `wallet` hands the program: nothing for an open edition (`undefined`), the
 * wallet's Genesis Token on the edition's cluster for a Seeker-only one (`seekerOnly`, read off
 * the edition), or `null` when it holds none. Throws when the cluster could not be asked.
 */
export async function claimGenesis(
  endpoint: string,
  cluster: Cluster,
  seekerOnly: boolean,
  wallet: string,
): Promise<GenesisAccounts | null | undefined> {
  if (!seekerOnly) return undefined;
  return findHeldGenesisToken(endpoint, wallet, cluster);
}

/**
 * The copy claimed on `e` by what `claimGenesis` answered, or `null`: the wallet's receipt for an
 * open edition, the token's for a Seeker-only one — whichever wallet made it, so no token is ever
 * offered a second copy — and none without a token. Fails closed, like `collectedCopy`.
 */
export async function claimedCopy(
  endpoint: string,
  e: CoreMetadata,
  wallet: string,
  genesis: GenesisAccounts | null | undefined,
) {
  if (genesis === undefined) return collectedCopy(endpoint, e, wallet);
  return genesis ? collectedCopy(endpoint, e, wallet, genesis.mint) : null;
}
