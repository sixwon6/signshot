/**
 * The Worker against the app's real client (publications/candy): fixture editions pass the client's
 * `readEdition`, and claims from `claimDraft` + `prepareForWallet`, wallet-signed (optionally
 * reordered as Seed Vault does), pass the Worker's checks.
 */

import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, getProgramDerivedAddress, getTransactionEncoder, signBytes, type Address, type Blockhash } from "@solana/kit";
import { prepareForWallet } from "../../publications/candy/transactions";
import {
  claimCost, claimDraft, NO_AUTHORITY as CLIENT_NO_AUTHORITY, readEdition as clientReadEdition,
} from "../../publications/candy/edition";
import { candyGuardOf, checkClaimTransaction, SYSTEM_PROGRAM } from "../src/claimTransaction";
import { acceptEdition, checkAgainstEdition, NO_AUTHORITY } from "../src/edition";
import { candyGuardBytes, candyMachineBytes, collectionBytes, randomAddress, reorderAccounts, type TestPrice } from "./fixtures";

/** Solana's rent: (128 + bytes) * 3480 lamports/byte-year * 2 years. */
const rent = (bytes: number) => BigInt((128 + bytes) * 3480 * 2);

describe("the app's client", () => {
  it("names the same NO_AUTHORITY, which re-derives from System's [\"signshot\", \"no authority\"]", async () => {
    const utf8 = (s: string) => new TextEncoder().encode(s);
    const [derived] = await getProgramDerivedAddress({ programAddress: SYSTEM_PROGRAM as Address, seeds: [utf8("signshot"), utf8("no authority")] });
    expect(derived).toBe(NO_AUTHORITY);
    expect(CLIENT_NO_AUTHORITY).toBe(NO_AUTHORITY);
  });

  for (const [kind, rewrite] of [["free", false], ["sol", false], ["token", false], ["free", true], ["token", true]] as const) {
    it(`builds a ${kind} Seeker-only claim the Worker co-signs${rewrite ? ", after the wallet reorders it" : ""}`, async () => {
      const [wallet, asset, payer, tokenAccount, cosigner] = await Promise.all(Array.from({ length: 5 }, () => generateKeyPairSigner()));
      const edition = await randomAddress();
      const collection = await randomAddress();
      const publisher = await randomAddress();
      const price: TestPrice = kind === "free" ? { kind } : kind === "sol" ? { kind, lamports: 250_000_000n }
        : { kind, mint: await randomAddress(), amount: 42n };
      const guard = await candyGuardOf(edition);
      const accounts = {
        machine: { owner: "CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J", data: candyMachineBytes({ mintAuthority: guard, collection }) },
        guard: { owner: "CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ", data: await candyGuardBytes(edition, publisher, price, { cosigner: cosigner.address }) },
        collection: { owner: "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d", data: await collectionBytes({ edition, publisher }) },
      };

      const view = (address: string, a: { owner: string; data: Uint8Array }) =>
        ({ address: address as Address, owner: a.owner as Address, lamports: 1_000_000n, bytes: a.data });
      const verdict = await clientReadEdition({
        candyMachine: view(edition, accounts.machine), candyGuard: view(guard, accounts.guard), collection: view(collection, accounts.collection),
      });
      expect(verdict.ok ? "ok" : verdict.reason).toBe("ok");
      if (!verdict.ok) return;

      const cost = await claimCost(verdict, rent);
      const draft = await claimDraft({
        edition: verdict, counter: null, cost, collector: wallet.address, asset, payer,
        tokenAccount: kind === "token" ? tokenAccount : undefined,
      });
      expect(draft.feePayer).toBe(wallet.address);
      expect(draft.transactions).toHaveLength(1);
      const lifetime = { blockhash: (await randomAddress()) as unknown as Blockhash, lastValidBlockHeight: 1000n };
      const prepared = prepareForWallet(wallet.address, draft.transactions[0], lifetime, { units: 400_000, microLamports: 5_000n });
      // Wallet: optionally reorders, then signs.
      const returned: any = rewrite ? reorderAccounts(prepared.transaction as never) : prepared.transaction;
      const walletSignature = new Uint8Array(await signBytes(wallet.keyPair.privateKey, returned.messageBytes));
      const finished = await prepared.finish({ ...returned, signatures: { ...returned.signatures, [wallet.address]: walletSignature } });
      const wire = new Uint8Array(getTransactionEncoder().encode(finished));
      const tx = await checkClaimTransaction(wire, { wallet: wallet.address, edition, cosigner: cosigner.address });
      expect(tx.asset).toBe(asset.address);
      const terms = await acceptEdition(edition, tx.candyGuard, tx.collection, accounts, cosigner.address);
      expect(() => checkAgainstEdition(tx, terms)).not.toThrow();
      expect(tx.payment.kind).toBe(kind);
    });
  }
});
