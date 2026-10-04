import { describe, expect, it } from "vitest";
import { type AccountMeta, type Address, type Instruction } from "@solana/kit";
import {
  associatedTokenOf, checkClaimTransaction, COMPUTE_BUDGET_PROGRAM, LIGHTHOUSE_PROGRAM, MAX_PRIORITY_FEE_LAMPORTS, parseTransaction, Refused,
  SYSVAR_SLOT_HASHES,
} from "../src/claimTransaction";
import {
  advanceNonce, buildTransaction, claimInstructions, concat, u32, u64, closeAccount, createAccount, initializeAccount3, MINT_V1_DATA,
  mintInstruction, newKey, randomAddress, ro, rs, tokenTransfer, transferSol, w, ws, type ClaimParts, type TestPrice,
} from "./fixtures";

async function parts(): Promise<ClaimParts & { publisher: Address; tokenMint: Address }> {
  const a = () => randomAddress();
  const walletKey = await newKey();
  return {
    wallet: walletKey.address, walletKey, edition: await a(), collection: await a(), asset: await a(), payer: await a(), cosigner: await a(),
    temp: await a(), blockhash: await a(), publisher: await a(), tokenMint: await a(),
  };
}

type P = Awaited<ReturnType<typeof parts>>;
const expectOf = (p: P) => ({ wallet: p.wallet, edition: p.edition, cosigner: p.cosigner });
const prices = (p: P): Record<string, TestPrice> => ({
  free: { kind: "free" }, sol: { kind: "sol", lamports: 250_000_000n }, token: { kind: "token", mint: p.tokenMint, amount: 42n },
});

async function refusal(wire: Uint8Array, p: P, expected = expectOf(p), allowed?: string[]) {
  try {
    await checkClaimTransaction(wire, expected, allowed);
  } catch (e) {
    if (e instanceof Refused) return e.reason;
    throw e;
  }
  return "accepted";
}

/** The claim for `price` with `edit` applied to its instruction list. */
async function variant(p: P, price: TestPrice, edit: (ixs: Instruction[]) => void | Promise<void>) {
  const ixs = await claimInstructions(p, price, p.publisher);
  await edit(ixs);
  return await buildTransaction(p, ixs);
}

const unitLimit = (units: number): Instruction => ({ programAddress: COMPUTE_BUDGET_PROGRAM as Address, data: concat(new Uint8Array([2]), u32(units)) });
const unitPrice = (micro: bigint): Instruction => ({ programAddress: COMPUTE_BUDGET_PROGRAM as Address, data: concat(new Uint8Array([3]), u64(micro)) });
const lighthouse = (accounts: AccountMeta[] = []): Instruction => ({ programAddress: LIGHTHOUSE_PROGRAM as Address, accounts, data: new Uint8Array([9, 1]) });

const mintIndex = (price: TestPrice) => (price.kind === "token" ? 4 : 1);
const withMintAccounts = async (p: P, price: TestPrice, change: (a: AccountMeta[]) => void) =>
  variant(p, price, (ixs) => {
    const accounts = [...ixs[mintIndex(price)].accounts!];
    change(accounts);
    ixs[mintIndex(price)] = mintInstruction(accounts, ixs[mintIndex(price)].data as Uint8Array);
  });

describe("the three accepted shapes", () => {
  for (const kind of ["free", "sol", "token"] as const) {
    it(`accepts a ${kind} claim, as built and with its accounts reordered, and returns the exact message bytes`, async () => {
      const p = await parts();
      for (const reorder of [false, true]) {
        const wire = await buildTransaction(p, await claimInstructions(p, prices(p)[kind], p.publisher), { reorder });
        const claim = await checkClaimTransaction(wire, expectOf(p));
        expect(claim.asset).toBe(p.asset);
        expect(claim.collection).toBe(p.collection);
        expect(claim.blockhash).toBe(p.blockhash);
        expect(claim.payment.kind).toBe(kind);
        const signers = kind === "token" ? 5 : 4;
        expect([...claim.message]).toEqual([...wire.subarray(1 + 64 * signers)]);
      }
    });
  }

  it("reports the payment terms the chain must match", async () => {
    const p = await parts();
    const sol = await checkClaimTransaction(await buildTransaction(p, await claimInstructions(p, prices(p).sol, p.publisher)), expectOf(p));
    expect(sol.payment).toEqual({ kind: "sol", destination: p.publisher });
    const token = await checkClaimTransaction(await buildTransaction(p, await claimInstructions(p, prices(p).token, p.publisher)), expectOf(p));
    expect(token.payment).toEqual({ kind: "token", mint: p.tokenMint, amount: 42n, destinationAta: await associatedTokenOf(p.publisher, p.tokenMint) });
  });
});

describe("signed by the wallet first", () => {
  it("refuses a transaction the wallet has not signed, signed by another key, or changed after signing", async () => {
    const p = await parts();
    const ixs = await claimInstructions(p, prices(p).free, p.publisher);
    expect(await refusal(await buildTransaction(p, ixs, { signers: [] }), p)).toBe("wallet-signature");
    expect(await refusal(await buildTransaction(p, ixs, { signers: [{ address: p.wallet, privateKey: (await newKey()).privateKey }] }), p))
      .toBe("wallet-signature");
    const wire = await buildTransaction(p, ixs);
    const changed = wire.slice();
    changed[changed.length - 2] ^= 1; // the allocated space's top byte (the last byte is the lookup-table count)
    expect(await refusal(changed, p)).toBe("wallet-signature");
    expect(await refusal(wire, p)).toBe("accepted");
  });

  it("refuses a legacy message: the app sends v0 only", async () => {
    const p = await parts();
    expect(await refusal(await buildTransaction(p, await claimInstructions(p, prices(p).free, p.publisher), { version: "legacy" }), p))
      .toBe("version");
  });
});

describe("compute budget", () => {
  it("accepts a limit and a price anywhere, at any value under the cap", async () => {
    const p = await parts();
    expect(await refusal(await variant(p, prices(p).token, (ixs) => { ixs.unshift(unitLimit(400_000), unitPrice(5_000n)); }), p)).toBe("accepted");
    expect(await refusal(await variant(p, prices(p).sol, (ixs) => { ixs.splice(1, 0, unitPrice(123n)); ixs.push(unitLimit(1)); }), p)).toBe("accepted");
    // Exactly the cap: 1,400,000 units at the price that makes MAX_PRIORITY_FEE_LAMPORTS.
    const atCap = (MAX_PRIORITY_FEE_LAMPORTS * 1_000_000n) / 1_400_000n;
    expect(await refusal(await variant(p, prices(p).free, (ixs) => { ixs.unshift(unitLimit(1_400_000), unitPrice(atCap)); }), p)).toBe("accepted");
  });

  it("refuses a priority fee over the cap, with or without a limit, and a malformed or repeated instruction", async () => {
    const p = await parts();
    const free = prices(p).free;
    expect(await refusal(await variant(p, free, (ixs) => { ixs.unshift(unitLimit(1_400_000), unitPrice(1_000_000n)); }), p)).toBe("priority-fee-cap");
    // No limit: the runtime's 200k units per instruction (3 here) is what the price multiplies.
    expect(await refusal(await variant(p, free, (ixs) => { ixs.unshift(unitPrice(200_000n)); }), p)).toBe("priority-fee-cap");
    expect(await refusal(await variant(p, free, (ixs) => { ixs.unshift(unitPrice(150_000n)); }), p)).toBe("accepted");
    expect(await refusal(await variant(p, free, (ixs) => { ixs.unshift(unitLimit(1_400_001)); }), p)).toBe("compute-budget");
    expect(await refusal(await variant(p, free, (ixs) => { ixs.unshift(unitPrice(1n), unitPrice(2n)); }), p)).toBe("compute-budget");
    expect(await refusal(await variant(p, free, (ixs) => {
      ixs.unshift({ programAddress: COMPUTE_BUDGET_PROGRAM as Address, data: concat(new Uint8Array([4]), u32(1)) });
    }), p)).toBe("compute-budget");
    expect(await refusal(await variant(p, free, (ixs) => {
      ixs.unshift({ ...unitLimit(1), accounts: [w(p.publisher)] });
    }), p)).toBe("compute-budget");
  });
});

describe("wallet-added programs", () => {
  it("refuses Lighthouse by default; with it allowed, sets it aside unless it names the co-signer or the payer", async () => {
    const p = await parts();
    const withLighthouse = await variant(p, prices(p).free, (ixs) => { ixs.push(lighthouse([ro(p.wallet)])); });
    expect(await refusal(withLighthouse, p)).toBe("wrong-program");
    expect(await refusal(withLighthouse, p, expectOf(p), [LIGHTHOUSE_PROGRAM])).toBe("accepted");
    expect(await refusal(await variant(p, prices(p).free, (ixs) => { ixs.push(lighthouse([ro(p.payer)])); }), p, expectOf(p), [LIGHTHOUSE_PROGRAM]))
      .toBe("payer-elsewhere");
    expect(await refusal(await variant(p, prices(p).free, (ixs) => { ixs.push(lighthouse([rs(p.cosigner)])); }), p, expectOf(p), [LIGHTHOUSE_PROGRAM]))
      .toBe("cosigner-position");
  });
});

describe("near misses", () => {
  it("refuses an account without the signer or writable flag the table needs", async () => {
    const p = await parts();
    expect(await refusal(await withMintAccounts(p, prices(p).free, (a) => { a[8] = ro(p.collection); }), p)).toBe("account-flags");
    expect(await refusal(await withMintAccounts(p, prices(p).sol, (a) => { a[13] = ro(p.publisher); }), p)).toBe("account-flags");
  });

  it("refuses a SOL transfer to anyone but the one-shot payer, or from anyone but the wallet", async () => {
    const p = await parts();
    const thief = await randomAddress();
    expect(await refusal(await variant(p, prices(p).sol, (ixs) => { ixs[0] = transferSol(p.wallet, thief, 1n); }), p)).toBe("payer-not-funded");
    const other = await randomAddress();
    expect(await refusal(await variant(p, prices(p).free, (ixs) => { ixs[0] = transferSol(other, p.payer, 1n); }), p)).toBe("wrong-transfer");
  });

  it("refuses a token transfer from anything but the wallet's own account, or to anything but the temporary account", async () => {
    const p = await parts();
    const price = prices(p).token as Extract<TestPrice, { kind: "token" }>;
    const stranger = await randomAddress();
    expect(await refusal(await variant(p, price, async (ixs) => {
      ixs[3] = tokenTransfer(await associatedTokenOf(stranger, p.tokenMint), p.temp, p.wallet, 42n);
    }), p)).toBe("wrong-token-transfer");
    expect(await refusal(await variant(p, price, async (ixs) => {
      ixs[3] = tokenTransfer(await associatedTokenOf(p.wallet, p.tokenMint), stranger, p.wallet, 42n);
    }), p)).toBe("wrong-token-transfer");
    expect(await refusal(await variant(p, price, (ixs) => { ixs[2] = initializeAccount3(p.temp, p.tokenMint, stranger); }), p))
      .toBe("wrong-temporary-account");
    expect(await refusal(await variant(p, price, (ixs) => { ixs[6] = closeAccount(p.temp, stranger, p.wallet); }), p)).toBe("wrong-close");
    expect(await refusal(await variant(p, price, (ixs) => { ixs[1] = createAccount(p.wallet, p.temp, 1n, 165, SYSVAR_SLOT_HASHES); }), p))
      .toBe("wrong-temporary-account");
  });

  it("refuses an extra System or Token instruction, a missing one, and another program", async () => {
    const p = await parts();
    expect(await refusal(await variant(p, prices(p).free, (ixs) => { ixs.push(transferSol(p.wallet, p.payer, 1n)); }), p))
      .toBe("wrong-instructions");
    expect(await refusal(await variant(p, prices(p).token, (ixs) => { ixs.push(closeAccount(p.temp, p.wallet, p.wallet)); }), p))
      .toBe("wrong-instructions");
    expect(await refusal(await variant(p, prices(p).sol, (ixs) => { ixs.pop(); }), p)).toBe("wrong-instructions");
    expect(await refusal(await variant(p, prices(p).free, (ixs) => { ixs.unshift(lighthouse()); }), p)).toBe("wrong-program");
    expect(await refusal(await variant(p, prices(p).free, (ixs) => { ixs[2] = transferSol(p.payer, p.wallet, 1n); }), p)).toBe("wrong-allocate");
  });

  it("refuses a durable nonce", async () => {
    const p = await parts();
    expect(await refusal(await variant(p, prices(p).free, async (ixs) => { ixs.unshift(advanceNonce(await randomAddress(), p.wallet)); }), p))
      .toBe("durable-nonce");
  });

  it("refuses a label, mint args, another guard instruction", async () => {
    const p = await parts();
    const label = new Uint8Array([...MINT_V1_DATA.subarray(0, 12), 1, 5, 0, 0, 0, ...new TextEncoder().encode("claim")]);
    expect(await refusal(await withMintData(p, label), p)).toBe("label-present");
    const labelTag = MINT_V1_DATA.slice(); labelTag[12] = 1;
    expect(await refusal(await withMintData(p, labelTag), p)).toBe("label-present");
    const args = MINT_V1_DATA.slice(); args[8] = 1;
    expect(await refusal(await withMintData(p, args), p)).toBe("mint-args");
    const route = MINT_V1_DATA.slice(); route[0] ^= 1;
    expect(await refusal(await withMintData(p, route), p)).toBe("not-mint");
  });

  it("refuses a mint-limit counter account after the co-signer", async () => {
    const p = await parts();
    expect(await refusal(await withMintAccounts(p, prices(p).free, (a) => { a.push(w(p.publisher)); }), p)).toBe("cosigner-position");
    expect(await refusal(await withMintAccounts(p, prices(p).sol, (a) => { a.push(w(p.publisher)); }), p)).toBe("account-count");
  });

  it("refuses a different candy machine, guard, payer, minter or owner", async () => {
    const p = await parts();
    const free = prices(p).free;
    const other = await randomAddress();
    expect(await refusal(await buildTransaction(p, await claimInstructions(p, free, p.publisher)), p, { ...expectOf(p), edition: other }))
      .toBe("wrong-candy-machine");
    expect(await refusal(await withMintAccounts(p, free, (a) => { a[0] = ro(other); }), p)).toBe("wrong-candy-guard");
    expect(await refusal(await withMintAccounts(p, free, (a) => { a[4] = ws(p.wallet); }), p)).toBe("payer-not-funded");
    expect(await refusal(await withMintAccounts(p, free, (a) => { a[5] = ws(p.asset); }), p)).toBe("minter-not-wallet");
    expect(await refusal(await withMintAccounts(p, free, (a) => { a[6] = ro(other); }), p)).toBe("owner-not-wallet");
    expect(await refusal(await withMintAccounts(p, free, (a) => { a[6] = ro(p.wallet); }), p)).toBe("accepted");
    expect(await refusal(await buildTransaction(p, await claimInstructions(p, free, p.publisher), { feePayer: other }), p)).toBe("fee-payer");
  });

  it("refuses a missing, writable, repeated or fee-paying co-signer", async () => {
    const p = await parts();
    const free = prices(p).free;
    expect(await refusal(await withMintAccounts(p, free, (a) => { a[a.length - 1] = ro(p.cosigner); }), p)).toBe("signers");
    expect(await refusal(await withMintAccounts(p, free, (a) => { a[a.length - 1] = ws(p.cosigner); }), p)).toBe("cosigner-writable");
    expect(await refusal(await withMintAccounts(p, free, (a) => { a[8] = rs(p.cosigner); }), p)).toBe("cosigner-position");
    expect(await refusal(await withMintAccounts(p, free, async (a) => { a[a.length - 1] = rs(p.publisher); }), p)).toBe("cosigner-position");
    expect(await refusal(await buildTransaction(p, await claimInstructions(p, free, p.publisher), { feePayer: p.cosigner }), p,
      { ...expectOf(p), wallet: p.cosigner })).toBe("cosigner-is-wallet");
  });

  it("refuses the one-shot payer anywhere else, and signers that are not fresh", async () => {
    const p = await parts();
    const free = prices(p).free;
    expect(await refusal(await withMintAccounts(p, free, (a) => { a[8] = w(p.payer); }), p)).toBe("payer-elsewhere");
    expect(await refusal(await withMintAccounts(p, free, (a) => { a[7] = ws(p.payer); }), p)).toBe("signers");
    expect(await refusal(await withMintAccounts(p, free, (a) => { a[7] = w(p.asset); }), p)).toBe("signers");
  });

  it("refuses address lookup tables", async () => {
    const p = await parts();
    const table = { address: await randomAddress(), addresses: [SYSVAR_SLOT_HASHES as Address] };
    const wire = await buildTransaction(p, await claimInstructions(p, prices(p).free, p.publisher), { lookupTable: table });
    expect(parseTransaction(wire).lookupCount).toBe(1);
    expect(await refusal(wire, p)).toBe("lookup-tables");
  });

  it("refuses malformed bytes: trailing data, a short read, a signature count that disagrees", async () => {
    const p = await parts();
    const wire = await buildTransaction(p, await claimInstructions(p, prices(p).free, p.publisher));
    const trailing = new Uint8Array(wire.length + 1); trailing.set(wire);
    expect(await refusal(trailing, p)).toBe("malformed");
    expect(await refusal(wire.subarray(0, wire.length - 1), p)).toBe("malformed");
    const count = wire.slice(); count[0] = 2;
    expect(await refusal(count, p)).toBe("malformed");
  });

  async function withMintData(p: P, data: Uint8Array) {
    return variant(p, prices(p).free, async (ixs) => { ixs[1] = mintInstruction([...ixs[1].accounts!], data); });
  }
});

