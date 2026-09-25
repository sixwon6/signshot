/**
 * Claiming a copy of a seeker-only edition. The claim is keyed on the collector's Seeker Genesis
 * Token instead of their wallet, one copy per token, and the edition program checks the token
 * itself: `collect` and `buy` take its mint and the token account holding it, and answer
 * `GenesisTokenRequired` without them. The app's Collect sheet and the collect page both come
 * through here, so they find the same token and read the same receipt.
 */

import { findHeldGenesisToken } from "./genesisToken";
import { account, addresses, claimReceiptAddress, collectedCopy, readReceipt, type GenesisAccounts } from "./protocol";
import type { CoreMetadata } from "../types";

/**
 * What a claim on `e` by `wallet` hands the program: nothing for an open edition (`undefined`),
 * the wallet's Genesis Token on the edition's cluster for a seeker-only one, or `null` when it
 * holds none. Throws when the cluster could not be asked.
 */
export async function claimGenesis(
  endpoint: string,
  e: CoreMetadata,
  wallet: string,
): Promise<GenesisAccounts | null | undefined> {
  if (!e.seekerOnly) return undefined;
  return findHeldGenesisToken(endpoint, wallet, e.cluster);
}

/**
 * The copy claimed on `e`, or `null`. An open edition's claim is the wallet's (`collectedCopy`); a
 * seeker-only edition's is the token's, at `["claim", edition, mint]`, whichever wallet made it,
 * so no token is ever offered a second copy. Fails closed like `collectedCopy`: a receipt that is
 * not the program's, or names another edition or an asset that is not the canonical print for its
 * number, is an error rather than a quiet `null`.
 */
export async function claimedCopy(
  endpoint: string,
  e: CoreMetadata,
  wallet: string,
  genesis: GenesisAccounts | null | undefined,
) {
  if (!e.seekerOnly) return collectedCopy(endpoint, e, wallet);
  if (!genesis) return null;
  const raw = await account(endpoint, await claimReceiptAddress(e.program, e.edition, genesis.mint));
  if (!raw) return null;
  if (raw.owner !== e.program || raw.executable) throw new Error("Invalid collection receipt");
  const receipt = readReceipt(raw.bytes);
  if (
    receipt.edition !== e.edition ||
    receipt.number > e.supply ||
    receipt.asset !== (await addresses(e.program, e.creator, e.nonce, receipt.number)).print
  )
    throw new Error("The collection receipt names an unexpected NFT.");
  return receipt;
}
