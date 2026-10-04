import { describe, expect, it } from "vitest";
import { seekerGenesisMember } from "../src/genesis";
import { plainToken2022MintBytes, randomAddress, sgtMintBytes } from "./fixtures";

describe("seekerGenesisMember (the app's rules)", () => {
  it("reads the member number of a Solana Mobile group member that names itself", async () => {
    const mint = await randomAddress();
    expect(seekerGenesisMember(sgtMintBytes(mint, 12345n), mint)).toBe(12345n);
  });

  it("refuses another group, another metadata address, another mint's membership, no membership", async () => {
    const mint = await randomAddress();
    const other = await randomAddress();
    expect(seekerGenesisMember(sgtMintBytes(mint, 1n, { group: other }), mint)).toBeNull();
    expect(seekerGenesisMember(sgtMintBytes(mint, 1n, { metadata: other }), mint)).toBeNull();
    expect(seekerGenesisMember(sgtMintBytes(mint, 1n, { memberMint: other }), mint)).toBeNull();
    expect(seekerGenesisMember(plainToken2022MintBytes(), mint)).toBeNull();
  });

  it("refuses an uninitialized mint, a non-mint account type, a multisig-sized account, a truncated extension", async () => {
    const mint = await randomAddress();
    const good = sgtMintBytes(mint, 1n);
    const uninitialized = good.slice(); uninitialized[45] = 0;
    const account = good.slice(); account[165] = 2;
    const multisig = new Uint8Array(355); multisig.set(good.subarray(0, 355));
    expect(seekerGenesisMember(uninitialized, mint)).toBeNull();
    expect(seekerGenesisMember(account, mint)).toBeNull();
    expect(seekerGenesisMember(multisig, mint)).toBeNull();
    expect(seekerGenesisMember(good.subarray(0, good.length - 1), mint)).toBeNull();
  });
});
