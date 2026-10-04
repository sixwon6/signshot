/**
 * Independent review: attacks on the co-signer, written as tests. Every test passes when the
 * attack is refused. The two that were named "VULN" (they passed while the attack succeeded) now
 * expect refusal: "FIXED (A1)" and "FIXED (A2)".
 */
import { env as cfEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder, signBytes, type Address,
} from "@solana/kit";
import { createSignInMessageText } from "@solana/wallet-standard-util";
import { CANDY_GUARD_PROGRAM, CANDY_MACHINE_PROGRAM, MPL_CORE, candyGuardOf, checkClaimTransaction, parseTransaction, Refused } from "../src/claimTransaction";
import { TOKEN_2022_PROGRAM } from "../src/genesis";
import { handle, type Deps, type Env } from "../src/index";
import { forgetCheckedEndpoints } from "../src/rpc";
import {
  DEVNET_URL, MAINNET_URL, b64, buildTransaction, candyGuardBytes, candyMachineBytes, claimInstructions, collectionBytes, concat,
  fakeRpc, newKey, randomAddress, sgtMintBytes, signIn, testEnv, tokenAccountRow, type ClaimParts, type FakeRpc, type TestKey,
} from "./fixtures";

interface World { rpc: FakeRpc; env: Env; deps: Deps; cosigner: TestKey; fresh: Set<string> }

/**
 * Like claim.test's world, but the fake RPC honours commitment for isBlockhashValid: a blockhash in
 * `fresh` is valid at "processed" and not yet known at "confirmed" (the confirmed bank lags the tip
 * by a few hundred ms to seconds; measured on devnet: 0.4-3 s).
 */
async function world(): Promise<World> {
  const rpc = fakeRpc();
  const cosigner = await newKey();
  const fresh = new Set<string>();
  const fetch = async (url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string);
    if (method === "isBlockhashValid" && params[1]?.commitment === "confirmed" && fresh.has(params[0])) {
      rpc.calls.push({ url, method });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: false } });
    }
    return rpc.fetch(url, init);
  };
  return { rpc, cosigner, fresh, env: testEnv(cfEnv, cosigner), deps: { fetch, now: () => Date.UTC(2026, 9, 4, 12) } };
}

async function edition(w: World) {
  const address = await randomAddress(), collection = await randomAddress(), publisher = await randomAddress();
  const guard = await candyGuardOf(address);
  const chain = w.rpc.chains[DEVNET_URL];
  chain.accounts.set(address, { owner: CANDY_MACHINE_PROGRAM, data: candyMachineBytes({ mintAuthority: guard, collection }) });
  chain.accounts.set(guard, { owner: CANDY_GUARD_PROGRAM, data: await candyGuardBytes(address, publisher, { kind: "free" }, { cosigner: w.cosigner.address }) });
  chain.accounts.set(collection, { owner: MPL_CORE, data: await collectionBytes({ edition: address, publisher }) });
  return { address, collection, publisher, price: { kind: "free" } as const };
}

async function sgt(w: World, holders: TestKey[]) {
  const mint = await randomAddress();
  w.rpc.chains[MAINNET_URL].accounts.set(mint, { owner: TOKEN_2022_PROGRAM, data: sgtMintBytes(mint, 7n) });
  for (const k of holders) w.rpc.tokenAccounts.set(k.address, [tokenAccountRow(k.address, mint, "1", await randomAddress())]);
  return mint;
}

async function claimTx(w: World, wallet: TestKey, e: Awaited<ReturnType<typeof edition>>, freshBlockhash = false) {
  const blockhash = await randomAddress();
  w.rpc.chains[DEVNET_URL].validBlockhashes.add(blockhash);
  if (freshBlockhash) w.fresh.add(blockhash);
  const parts: ClaimParts = {
    wallet: wallet.address, walletKey: wallet, edition: e.address, collection: e.collection, asset: await randomAddress(),
    payer: await randomAddress(), cosigner: w.cosigner.address, temp: await randomAddress(), blockhash,
  };
  return { wire: await buildTransaction(parts, await claimInstructions(parts, e.price, e.publisher)), ...parts };
}

const post = (w: World, path: string, body: unknown) =>
  handle(new Request(`https://cosigner.test${path}`, { method: "POST", body: JSON.stringify(body) }), w.env, w.deps);

async function claim(w: World, key: TestKey, editionAddress: string, wire: Uint8Array, signInFor = signIn) {
  const payload = (await (await post(w, "/challenge", { wallet: key.address })).json()) as Record<string, string>;
  const r = await post(w, "/claim", {
    wallet: key.address, nonce: payload.nonce, signInOutput: await signInFor(key, payload), edition: editionAddress, cluster: "devnet",
    transaction: b64(wire),
  });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

beforeEach(() => forgetCheckedEndpoints());

describe("pending-release race (index.ts pendingStanding asks 'confirmed', new claims are accepted at 'processed')", () => {
  it("FIXED (A1): one SGT gets one co-signed claim even when the next arrives before the first blockhash is confirmed", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w);
    const mint = await sgt(w, [holder]);

    const first = await claimTx(w, holder, e, true); // blockhash fetched at "processed", as the attacker chooses
    const r1 = await claim(w, holder, e.address, first.wire);
    expect(r1.status).toBe(200);

    // Immediately: a different message (another copy address), same SGT.
    const second = await claimTx(w, holder, e, true);
    const r2 = await claim(w, holder, e.address, second.wire);
    expect([r2.status, r2.body.error]).toEqual([409, "genesis-pending"]);
    expect(second.asset).not.toBe(first.asset);
    // The first co-signed transaction can still land: the row stays the first claim's.
    expect(w.rpc.chains[DEVNET_URL].validBlockhashes.has(first.blockhash)).toBe(true);
    const row = await cfEnv.DB.prepare("SELECT asset, sgt_mint FROM claims WHERE edition = ?").bind(e.address).first();
    expect(row).toEqual({ asset: first.asset, sgt_mint: mint });

    // Nor a third.
    const third = await claimTx(w, holder, e, true);
    expect((await claim(w, holder, e.address, third.wire)).body.error).toBe("genesis-pending");
  });

  it("control: with the blockhash already confirmed, the second claim is held back", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w);
    await sgt(w, [holder]);
    expect((await claim(w, holder, e.address, (await claimTx(w, holder, e)).wire)).status).toBe(200);
    const r = await claim(w, holder, e.address, (await claimTx(w, holder, e)).wire);
    expect([r.status, r.body.error]).toEqual([409, "genesis-pending"]);
  });
});

describe("unauthenticated cost (index.ts claim step 4-5)", () => {
  it("FIXED (A2): a fresh keypair with no SGT, a nonexistent edition and a random blockhash costs no D1 write and no Helius V2 call", async () => {
    const w = await world();
    const attacker = await newKey(); // free to make, as many as wanted
    const fakeEdition = await randomAddress(); // nothing on chain
    const parts: ClaimParts = {
      wallet: attacker.address, walletKey: attacker, edition: fakeEdition as Address, collection: await randomAddress(),
      asset: await randomAddress(), payer: await randomAddress(), cosigner: w.cosigner.address, temp: await randomAddress(),
      blockhash: await randomAddress(), // never a real blockhash
    };
    const wire = await buildTransaction(parts, await claimInstructions(parts, { kind: "free" }, await randomAddress()));
    const before = (await cfEnv.DB.prepare("SELECT COUNT(*) AS n FROM used_nonces").first<{ n: number }>())!.n;
    const r = await claim(w, attacker, fakeEdition, wire);
    expect([r.status, r.body.error]).toEqual([422, "blockhash-invalid"]);
    const after = (await cfEnv.DB.prepare("SELECT COUNT(*) AS n FROM used_nonces").first<{ n: number }>())!.n;
    expect(after - before).toBe(0);
    expect(w.rpc.calls.filter((c) => c.url === MAINNET_URL && c.method === "getTokenAccountsByOwnerV2")).toHaveLength(0);

    // With a live blockhash, the nonexistent edition is what refuses it, still before both.
    w.rpc.chains[DEVNET_URL].validBlockhashes.add(parts.blockhash);
    const r2 = await claim(w, attacker, fakeEdition, wire);
    expect([r2.status, r2.body.reason]).toEqual([422, "not-signshot-edition"]);
    expect((await cfEnv.DB.prepare("SELECT COUNT(*) AS n FROM used_nonces").first<{ n: number }>())!.n - before).toBe(0);
    expect(w.rpc.calls.filter((c) => c.url === MAINNET_URL && c.method === "getTokenAccountsByOwnerV2")).toHaveLength(0);
  });
});

/** Re-encode a compiled message after `edit`, have the wallet sign it, and frame it as a transaction. */
async function mutate(wire: Uint8Array, wallet: TestKey, edit: (m: any) => void) {
  const t = parseTransaction(wire);
  const m: any = getCompiledTransactionMessageDecoder().decode(t.message);
  edit(m);
  const message = new Uint8Array(getCompiledTransactionMessageEncoder().encode(m));
  const sig = new Uint8Array(await signBytes(wallet.privateKey, message));
  const sigs = new Uint8Array(64 * t.signatureCount); sigs.set(sig);
  return concat(new Uint8Array([t.signatureCount]), sigs, message);
}

describe("wire-format attacks (claimTransaction.ts), all refused", () => {
  async function base() {
    const wallet = await newKey();
    const p: ClaimParts = {
      wallet: wallet.address, walletKey: wallet, edition: await randomAddress(), collection: await randomAddress(), asset: await randomAddress(),
      payer: await randomAddress(), cosigner: await randomAddress(), temp: await randomAddress(), blockhash: await randomAddress(),
    };
    const wire = await buildTransaction(p, await claimInstructions(p, { kind: "free" }, await randomAddress()));
    return { wallet, p, wire, expected: { wallet: p.wallet, edition: p.edition, cosigner: p.cosigner } };
  }
  const reason = (promise: Promise<unknown>) => promise.then(() => "accepted", (e) => (e instanceof Refused ? e.reason : `threw ${e}`));

  it("an account index past the static keys (as a lookup-table index would be)", async () => {
    const { wallet, wire, expected } = await base();
    const bad = await mutate(wire, wallet, (m) => { m.instructions[1].accountIndices[6] = m.staticAccounts.length; });
    expect(await reason(checkClaimTransaction(bad, expected))).toBe("malformed");
  });

  it("the same key listed twice with different privileges (signer and non-signer)", async () => {
    const { wallet, wire, expected, p } = await base();
    const bad = await mutate(wire, wallet, (m) => { m.staticAccounts.push(p.cosigner); });
    expect(await reason(checkClaimTransaction(bad, expected))).toBe("duplicate-accounts");
  });

  it("a header that makes the co-signer writable", async () => {
    const { wallet, wire, expected } = await base();
    const bad = await mutate(wire, wallet, (m) => { m.header.numReadonlySignerAccounts = 0; });
    expect(await reason(checkClaimTransaction(bad, expected))).toBe("cosigner-writable");
  });

  it("the mint's owner pointed at another wallet, or the minter swapped for it", async () => {
    const { wallet, wire, expected, p } = await base();
    const victim = await randomAddress();
    const owner = await mutate(wire, wallet, (m) => { m.staticAccounts.push(victim); m.header.numReadonlyNonSignerAccounts += 1; m.instructions[1].accountIndices[6] = m.staticAccounts.length - 1; });
    expect(await reason(checkClaimTransaction(owner, expected))).toBe("owner-not-wallet");
    void p;
  });

  it("a non-canonical compact-u16 (0x80 0x00) instruction-data length", async () => {
    const { wire, expected } = await base();
    // signature count 1 -> 0x81 0x00 is not canonical.
    const bad = concat(new Uint8Array([0x81, 0x00]), wire.subarray(1));
    expect(await reason(checkClaimTransaction(bad, expected))).toBe("malformed");
  });
});

describe("SIWS against what wallets return", () => {
  it("a wallet that adds 'Chain ID' (or Version) to the message is refused, as the recipe's verifySignIn would", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w);
    await sgt(w, [holder]);
    const withChain = async (key: TestKey, payload: Record<string, string>) => {
      const text = createSignInMessageText({ ...payload, chainId: "solana:mainnet" } as never);
      const bytes = new TextEncoder().encode(text);
      return { address: b64(key.publicKey), signed_message: b64(bytes), signature: b64(new Uint8Array(await signBytes(key.privateKey, bytes))) };
    };
    const r = await claim(w, holder, e.address, (await claimTx(w, holder, e)).wire, withChain);
    expect([r.status, r.body.error]).toEqual([401, "signature-invalid"]);
  });
});
