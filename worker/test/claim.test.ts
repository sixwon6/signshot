import { env as cfEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBase58Encoder, getBase64Encoder, type Address, type Instruction } from "@solana/kit";
import { CANDY_GUARD_PROGRAM, CANDY_MACHINE_PROGRAM, COMPUTE_BUDGET_PROGRAM, MPL_CORE, SYSTEM_PROGRAM, candyGuardOf, parseTransaction } from "../src/claimTransaction";
import { TOKEN_2022_PROGRAM } from "../src/genesis";
import { handle, VERSION, type Deps, type Env } from "../src/index";
import { forgetCheckedEndpoints, type Cluster } from "../src/rpc";
import {
  API_KEY, DEVNET_URL, advance, MAINNET_URL, b64, buildTransaction, candyGuardBytes, candyMachineBytes, claimInstructions, collectionBytes,
  fakeRpc, newKey, plainToken2022MintBytes, randomAddress, sgtMintBytes, signIn, testEnv, tokenAccountRow,
  type BuildOptions, type ClaimParts, type CollectionOptions, type FakeRpc, type GuardOptions, type MachineOptions, type TestKey, type TestPrice,
} from "./fixtures";

const urlOf = (cluster: Cluster) => (cluster === "devnet" ? DEVNET_URL : MAINNET_URL);

interface World {
  rpc: FakeRpc;
  env: Env;
  deps: Deps;
  cosigner: TestKey;
  clock: { now: number };
}

async function world(): Promise<World> {
  const rpc = fakeRpc();
  const cosigner = await newKey();
  const clock = { now: Date.UTC(2026, 9, 4, 12, 0, 0) };
  return { rpc, cosigner, clock, env: testEnv(cfEnv, cosigner), deps: { fetch: rpc.fetch, now: () => clock.now } };
}

interface Ed { address: Address; collection: Address; publisher: Address; price: TestPrice }

interface EditionOptions {
  cluster?: Cluster;
  price?: TestPrice;
  guard?: GuardOptions;
  machine?: Partial<MachineOptions>;
  collectionAuthority?: string;
  collection?: Partial<Omit<CollectionOptions, "edition" | "publisher">>;
}

/** A Seeker-only edition, laid out as the app's publishing leaves it, unless told otherwise. */
async function edition(w: World, o: EditionOptions = {}): Promise<Ed> {
  const address = await randomAddress();
  const collection = await randomAddress();
  const publisher = await randomAddress();
  const price = o.price ?? { kind: "free" };
  const guard = await candyGuardOf(address);
  const chain = w.rpc.chains[urlOf(o.cluster ?? "devnet")];
  chain.accounts.set(address, { owner: CANDY_MACHINE_PROGRAM, data: candyMachineBytes({ mintAuthority: guard, collection, ...o.machine }) });
  chain.accounts.set(guard, { owner: CANDY_GUARD_PROGRAM, data: await candyGuardBytes(address, publisher, price, { cosigner: w.cosigner.address, ...o.guard }) });
  const redeemed = Number(o.machine?.redeemed ?? 1n);
  chain.accounts.set(collection, {
    owner: MPL_CORE,
    data: await collectionBytes({
      edition: address, publisher, numMinted: redeemed, available: Number(o.machine?.available ?? 10n),
      updateAuthority: o.collectionAuthority, ...o.collection,
    }),
  });
  return { address, collection, publisher, price };
}

/** A Seeker Genesis Token on mainnet, held by `holders` (amount 1) and left by `former` (amount 0). */
async function sgt(w: World, member: bigint, holders: TestKey[], former: TestKey[] = [], bytes?: (mint: string) => Uint8Array) {
  const mint = await randomAddress();
  w.rpc.chains[MAINNET_URL].accounts.set(mint, { owner: TOKEN_2022_PROGRAM, data: bytes ? bytes(mint) : sgtMintBytes(mint, member) });
  for (const [list, amount] of [[holders, "1"], [former, "0"]] as const)
    for (const k of list) {
      const rows = w.rpc.tokenAccounts.get(k.address) ?? [];
      rows.push(tokenAccountRow(k.address, mint, amount, await randomAddress()));
      w.rpc.tokenAccounts.set(k.address, rows);
    }
  return mint;
}

/**
 * The table's claim on `e` with fresh keys and a blockhash live on `cluster`; `edit` may change
 * the instruction list first.
 */
async function claimTx(w: World, wallet: TestKey, e: Ed, cluster: Cluster = "devnet", edit?: (ixs: Instruction[], p: ClaimParts) => void | Promise<void>,
  options: BuildOptions = {}) {
  const blockhash = await randomAddress();
  w.rpc.chains[urlOf(cluster)].validBlockhashes.add(blockhash);
  const parts: ClaimParts = {
    wallet: wallet.address, walletKey: wallet, edition: e.address, collection: e.collection, asset: await randomAddress(), payer: await randomAddress(),
    cosigner: w.cosigner.address, temp: await randomAddress(), blockhash,
  };
  const ixs = await claimInstructions(parts, e.price, e.publisher);
  await edit?.(ixs, parts);
  return { wire: await buildTransaction(parts, ixs, options), ...parts };
}

const post = (w: World, path: string, body: unknown) =>
  handle(new Request(`https://cosigner.test${path}`, { method: "POST", body: JSON.stringify(body) }), w.env, w.deps);

async function challenge(w: World, wallet: string) {
  const r = await post(w, "/challenge", { wallet });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, string>;
}

async function claim(w: World, key: TestKey, e: Ed, wire: Uint8Array, cluster: Cluster = "devnet") {
  const payload = await challenge(w, key.address);
  const signInOutput = await signIn(key, payload);
  const response = await post(w, "/claim", {
    wallet: key.address, nonce: payload.nonce, signInOutput, edition: e.address, cluster, transaction: b64(wire),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string>, payload, signInOutput };
}

async function verifiesAs(signer: TestKey, signatureB58: string, wire: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", signer.publicKey, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, new Uint8Array(getBase58Encoder().encode(signatureB58)),
    parseTransaction(wire).message);
}

beforeEach(() => forgetCheckedEndpoints());

describe("health and challenge", () => {
  it("reports the version and the co-signer key", async () => {
    const w = await world();
    const r = await handle(new Request("https://cosigner.test/health"), w.env, w.deps);
    expect(await r.json()).toEqual({ version: VERSION, signer: w.cosigner.address, accepted: [w.cosigner.address] });
  });

  it("issues a SIWS payload bound to the wallet, with a 72-hex single-use nonce", async () => {
    const w = await world();
    const wallet = await randomAddress();
    const p = await challenge(w, wallet);
    expect(p).toMatchObject({
      domain: "erashot.app", uri: "https://erashot.app", address: wallet,
      issuedAt: "2026-10-04T12:00:00.000Z", expirationTime: "2026-10-04T12:10:00.000Z",
    });
    expect(p.nonce).toMatch(/^[0-9a-f]{72}$/);
    expect((await challenge(w, wallet)).nonce).not.toBe(p.nonce);
    expect((await post(w, "/challenge", { wallet: "not-an-address" })).status).toBe(400);
    expect((await post(w, "/challenge", { wallet: "x".repeat(9000) })).status).toBe(413);
  });
});

describe("claim", () => {
  it("co-signs a good claim, returns the SGT mint, and records it", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w);
    const mint = await sgt(w, 7n, [holder]);
    const tx = await claimTx(w, holder, e);
    const r = await claim(w, holder, e, tx.wire);
    expect(r.status).toBe(200);
    expect(r.body.signer).toBe(w.cosigner.address);
    expect(r.body.sgtMint).toBe(mint);
    expect(await verifiesAs(w.cosigner, r.body.signature, tx.wire)).toBe(true);
    const row = await cfEnv.DB.prepare("SELECT * FROM claims WHERE edition = ?").bind(e.address).first();
    expect(row).toMatchObject({ cluster: "devnet", sgt_mint: mint, wallet: holder.address, asset: tx.asset, status: "pending" });
  });

  it("co-signs a mainnet edition, reading the blockhash and the edition from mainnet", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w, { cluster: "mainnet-beta" });
    await sgt(w, 7n, [holder]);
    const tx = await claimTx(w, holder, e, "mainnet-beta");
    expect((await claim(w, holder, e, tx.wire, "mainnet-beta")).status).toBe(200);
    expect(w.rpc.calls.some((c) => c.url === DEVNET_URL)).toBe(false);
  });

  it("re-signs the identical claim after a lost response", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w);
    await sgt(w, 7n, [holder]);
    const tx = await claimTx(w, holder, e);
    const first = await claim(w, holder, e, tx.wire);
    const again = await claim(w, holder, e, tx.wire);
    expect(again.status).toBe(200);
    expect(again.body.signature).toBe(first.body.signature);
    // The same copy address in a different message (another priority fee) is not a retry.
    const repriced = await buildTransaction(tx, [
      { programAddress: COMPUTE_BUDGET_PROGRAM as Address, data: new Uint8Array([3, 9, 0, 0, 0, 0, 0, 0, 0]) },
      ...(await claimInstructions(tx, e.price, e.publisher)),
    ]);
    expect((await claim(w, holder, e, repriced)).body.error).toBe("genesis-pending");
  });

  it("returns the transaction as received with the co-signature in its slot, the wallet's untouched", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w, { price: { kind: "token", mint: await randomAddress(), amount: 3n } });
    await sgt(w, 7n, [holder]);
    const tx = await claimTx(w, holder, e, "devnet", undefined, { reorder: true });
    const r = await claim(w, holder, e, tx.wire);
    expect(r.status).toBe(200);
    const returned = new Uint8Array(getBase64Encoder().encode(r.body.transaction));
    const parsed = parseTransaction(returned);
    const slot = parsed.keys.indexOf(w.cosigner.address);
    expect([...parsed.signatures[slot]]).toEqual([...getBase58Encoder().encode(r.body.signature)]);
    expect([...parsed.signatures[0]]).toEqual([...parseTransaction(tx.wire).signatures[0]]);
    expect([...parsed.message]).toEqual([...parseTransaction(tx.wire).message]);
    expect(await verifiesAs(w.cosigner, r.body.signature, tx.wire)).toBe(true);
  });
});

describe("sign-in", () => {
  it("refuses a replayed nonce", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w);
    await sgt(w, 7n, [holder]);
    const tx = await claimTx(w, holder, e);
    const first = await claim(w, holder, e, tx.wire);
    expect(first.status).toBe(200);
    const replay = await post(w, "/claim", {
      wallet: holder.address, nonce: first.payload.nonce, signInOutput: first.signInOutput, edition: e.address, cluster: "devnet",
      transaction: b64((await claimTx(w, holder, e)).wire),
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "nonce-used" });
  });

  it("refuses a sign-in by another key, a forged signature, another domain, a tampered or expired nonce", async () => {
    const w = await world();
    const holder = await newKey();
    const other = await newKey();
    const e = await edition(w);
    await sgt(w, 7n, [holder]);
    const tx = b64((await claimTx(w, holder, e)).wire);
    const send = (nonce: string, signInOutput: unknown) =>
      post(w, "/claim", { wallet: holder.address, nonce, signInOutput, edition: e.address, cluster: "devnet", transaction: tx })
        .then(async (r) => [r.status, ((await r.json()) as { error: string }).error]);

    const p = await challenge(w, holder.address);
    // Signed by another wallet, presented as that wallet.
    expect(await send(p.nonce, await signIn(other, p, other.address))).toEqual([401, "signature-invalid"]);
    // Signed by another key, presented as the holder.
    const forged = { ...(await signIn(holder, p)), signature: (await signIn(other, p, holder.address)).signature };
    expect(await send(p.nonce, forged)).toEqual([401, "signature-invalid"]);
    // A message for another dApp's domain.
    expect(await send(p.nonce, await signIn(holder, { ...p, domain: "evil.example" }))).toEqual([401, "signature-invalid"]);
    // A nonce this Worker did not issue.
    const tampered = (p.nonce[0] === "a" ? "b" : "a") + p.nonce.slice(1);
    expect(await send(tampered, await signIn(holder, { ...p, nonce: tampered }))).toEqual([401, "nonce-invalid"]);
    // Expired.
    w.clock.now += 10 * 60 * 1000;
    expect(await send(p.nonce, await signIn(holder, p))).toEqual([401, "nonce-expired"]);
  });

  it("does not spend the nonce on a refused transaction", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w);
    await sgt(w, 7n, [holder]);
    const p = await challenge(w, holder.address);
    const signInOutput = await signIn(holder, p);
    const body = { wallet: holder.address, nonce: p.nonce, signInOutput, edition: e.address, cluster: "devnet" };
    const wrong = await claimTx(w, holder, { ...e, address: await randomAddress() });
    expect((await post(w, "/claim", { ...body, transaction: b64(wrong.wire) })).status).toBe(422);
    expect((await post(w, "/claim", { ...body, transaction: b64((await claimTx(w, holder, e)).wire) })).status).toBe(200);
  });
});

describe("genesis token", () => {
  it("refuses a wallet with no SGT", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w);
    const r = await claim(w, holder, e, (await claimTx(w, holder, e)).wire);
    expect([r.status, r.body.error]).toEqual([403, "no-genesis-token"]);
  });

  it("skips a zero-balance SGT token account", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w);
    await sgt(w, 7n, [], [holder]);
    const r = await claim(w, holder, e, (await claimTx(w, holder, e)).wire);
    expect([r.status, r.body.error]).toEqual([403, "no-genesis-token"]);
    const held = await sgt(w, 9n, [holder]);
    const again = await claim(w, holder, e, (await claimTx(w, holder, e)).wire);
    expect([again.status, again.body.sgtMint]).toEqual([200, held]);
  });

  it("refuses a Token-2022 token that is not a member of Solana Mobile's group", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w);
    await sgt(w, 0n, [holder], [], () => plainToken2022MintBytes());
    const otherGroup = await randomAddress();
    await sgt(w, 1n, [holder], [], (mint) => sgtMintBytes(mint, 1n, { group: otherGroup }));
    const someMint = await randomAddress();
    await sgt(w, 2n, [holder], [], (mint) => sgtMintBytes(mint, 2n, { memberMint: someMint }));
    // Right bytes, wrong owner program.
    const notToken2022 = await sgt(w, 3n, [holder]);
    w.rpc.chains[MAINNET_URL].accounts.get(notToken2022)!.owner = SYSTEM_PROGRAM;
    const r = await claim(w, holder, e, (await claimTx(w, holder, e)).wire);
    expect([r.status, r.body.error]).toEqual([403, "no-genesis-token"]);
  });

  it("picks the SGT with the lowest member number", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w);
    await sgt(w, 70n, [holder]);
    const low = await sgt(w, 3n, [holder]);
    const r = await claim(w, holder, e, (await claimTx(w, holder, e)).wire);
    expect(r.body.sgtMint).toBe(low);
  });

  it("refuses an SGT already used on this edition, and allows it on another", async () => {
    const w = await world();
    const first = await newKey();
    const second = await newKey();
    const e = await edition(w);
    // The SGT moved from `first` to `second` after the first claim.
    const mint = await sgt(w, 7n, [first, second]);
    const tx = await claimTx(w, first, e);
    expect((await claim(w, first, e, tx.wire)).status).toBe(200);

    // Pending: the confirmed block height has not passed the first claim's bound.
    const pending = await claim(w, second, e, (await claimTx(w, second, e)).wire);
    expect([pending.status, pending.body.error]).toEqual([409, "genesis-pending"]);

    // Landed: the chain is past the bound and the copy exists.
    advance(w.rpc.chains[DEVNET_URL]);
    w.rpc.chains[DEVNET_URL].accounts.set(tx.asset, { owner: MPL_CORE, data: new Uint8Array(120) });
    const used = await claim(w, second, e, (await claimTx(w, second, e)).wire);
    expect([used.status, used.body.error]).toEqual([409, "genesis-used"]);
    const row = await cfEnv.DB.prepare("SELECT status FROM claims WHERE edition = ? AND sgt_mint = ?").bind(e.address, mint).first();
    expect(row?.status).toBe("confirmed");
    // The same wallet again, too.
    expect((await claim(w, first, e, (await claimTx(w, first, e)).wire)).body.error).toBe("genesis-used");

    const e2 = await edition(w);
    const elsewhere = await claim(w, second, e2, (await claimTx(w, second, e2)).wire);
    expect([elsewhere.status, elsewhere.body.sgtMint]).toEqual([200, mint]);
  });

  it("holds a pending claim until the confirmed height passes its bound, whatever the blockhash reads", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w);
    await sgt(w, 7n, [holder]);
    const chain = w.rpc.chains[DEVNET_URL];
    chain.lag = 40; // a slow confirmed bank
    const tx = await claimTx(w, holder, e);
    expect((await claim(w, holder, e, tx.wire)).status).toBe(200);
    // 150 blocks on: the first transaction's blockhash is past its life at "processed", but the
    // confirmed height (lagging by 40) has not passed the stored bound. Still held.
    advance(chain, 152);
    expect((await claim(w, holder, e, (await claimTx(w, holder, e)).wire)).body.error).toBe("genesis-pending");
    // Once the confirmed bank is past the bound, the unlanded claim is released.
    advance(chain, 40);
    expect((await claim(w, holder, e, (await claimTx(w, holder, e)).wire)).status).toBe(200);
  });

  it("releases a claim whose transaction expired unlanded, even with lamports sent to the copy's address", async () => {
    const w = await world();
    const first = await newKey();
    const second = await newKey();
    const e = await edition(w);
    await sgt(w, 7n, [first, second]);
    const tx = await claimTx(w, first, e);
    expect((await claim(w, first, e, tx.wire)).status).toBe(200);
    advance(w.rpc.chains[DEVNET_URL]);
    w.rpc.chains[DEVNET_URL].accounts.set(tx.asset, { owner: SYSTEM_PROGRAM, data: new Uint8Array(0) });
    const r = await claim(w, second, e, (await claimTx(w, second, e)).wire);
    expect(r.status).toBe(200);
  });

  it("counts a burned copy (a 1-byte tombstone, Core- or System-owned) as landed", async () => {
    for (const owner of [MPL_CORE, SYSTEM_PROGRAM]) {
      const w = await world();
      const holder = await newKey();
      const e = await edition(w);
      await sgt(w, 7n, [holder]);
      const tx = await claimTx(w, holder, e);
      expect((await claim(w, holder, e, tx.wire)).status).toBe(200);
      advance(w.rpc.chains[DEVNET_URL]);
      w.rpc.chains[DEVNET_URL].accounts.set(tx.asset, { owner, data: new Uint8Array([0]) });
      expect((await claim(w, holder, e, (await claimTx(w, holder, e)).wire)).body.error).toBe("genesis-used");
    }
  });

  it("never releases on the word of a node behind the slot that saw the height pass", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w);
    await sgt(w, 7n, [holder]);
    const chain = w.rpc.chains[DEVNET_URL];
    const tx = await claimTx(w, holder, e);
    expect((await claim(w, holder, e, tx.wire)).status).toBe(200);
    advance(chain);
    // The node that answers the copy read lags further than the one that reported the height.
    w.rpc.gate = async (method) => { if (method === "getAccountInfo") chain.lag += 50; };
    const r = await claim(w, holder, e, (await claimTx(w, holder, e)).wire);
    expect([r.status, r.body.error]).toEqual([502, "rpc-unavailable"]);
    const row = await cfEnv.DB.prepare("SELECT asset FROM claims WHERE edition = ?").bind(e.address).first();
    expect(row?.asset).toBe(tx.asset);
  });

  it("uses a wallet's next Genesis Token when its first has claimed this edition", async () => {
    const w = await world();
    const holder = await newKey();
    const e = await edition(w);
    const low = await sgt(w, 3n, [holder]);
    const high = await sgt(w, 9n, [holder]);
    expect((await claim(w, holder, e, (await claimTx(w, holder, e)).wire)).body.sgtMint).toBe(low);
    expect((await claim(w, holder, e, (await claimTx(w, holder, e)).wire)).body.sgtMint).toBe(high);
    const third = await claim(w, holder, e, (await claimTx(w, holder, e)).wire);
    expect([third.status, third.body.error]).toEqual([409, "genesis-pending"]);
  });

  it("lets exactly one of two simultaneous claims with the same SGT through: the insert conflict", async () => {
    const w = await world();
    const a = await newKey();
    const b = await newKey();
    const e = await edition(w);
    await sgt(w, 7n, [a, b]);
    // Hold both requests at the SGT lookup until both have reached it, then release them together.
    let arrived = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => { release = resolve; });
    w.rpc.gate = async (method) => {
      if (method !== "getTokenAccountsByOwnerV2") return;
      arrived += 1;
      if (arrived === 2) release();
      await together;
    };
    const [ta, tb] = [await claimTx(w, a, e), await claimTx(w, b, e)];
    const results = await Promise.all([claim(w, a, e, ta.wire), claim(w, b, e, tb.wire)]);
    expect(arrived).toBe(2);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const rows = await cfEnv.DB.prepare("SELECT COUNT(*) AS n FROM claims WHERE edition = ?").bind(e.address).first<{ n: number }>();
    expect(rows?.n).toBe(1);
    // Both found no row and raced on the insert: neither asked the chain about a pending row.
    expect(w.rpc.calls.filter((c) => c.method === "getEpochInfo")).toHaveLength(0);
  });

  it("lets exactly one of two simultaneous takeovers of a released row through: the compare-and-swap", async () => {
    const w = await world();
    const [first, a, b] = [await newKey(), await newKey(), await newKey()];
    const e = await edition(w);
    await sgt(w, 7n, [first, a, b]);
    expect((await claim(w, first, e, (await claimTx(w, first, e)).wire)).status).toBe(200);
    advance(w.rpc.chains[DEVNET_URL]);
    // Both read the released row, then race on the swap.
    let arrived = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => { release = resolve; });
    w.rpc.gate = async (method) => {
      if (method !== "getAccountInfo") return;
      arrived += 1;
      if (arrived === 2) release();
      await together;
    };
    const [ta, tb] = [await claimTx(w, a, e), await claimTx(w, b, e)];
    const results = await Promise.all([claim(w, a, e, ta.wire), claim(w, b, e, tb.wire)]);
    expect(arrived).toBe(2);
    expect(results.map((r) => [r.status, r.body.error ?? "ok"]).sort()).toEqual([[200, "ok"], [409, "genesis-pending"]]);
  });
});

describe("edition", () => {
  it("co-signs each of the three shapes against a matching edition", async () => {
    const w = await world();
    const holder = await newKey();
    await sgt(w, 7n, [holder]);
    for (const price of [{ kind: "free" }, { kind: "sol", lamports: 250_000_000n }, { kind: "token", mint: await randomAddress(), amount: 42n }] as TestPrice[]) {
      const e = await edition(w, { price });
      const tx = await claimTx(w, holder, e);
      const r = await claim(w, holder, e, tx.wire);
      expect([price.kind, r.status]).toEqual([price.kind, 200]);
      expect(await verifiesAs(w.cosigner, r.body.signature, tx.wire)).toBe(true);
    }
  });

  it("refuses an edition whose guard does not require this key", async () => {
    const w = await world();
    const holder = await newKey();
    await sgt(w, 7n, [holder]);
    for (const guard of [{ cosigner: null }, { cosigner: await randomAddress() }]) {
      const e = await edition(w, { guard });
      const r = await claim(w, holder, e, (await claimTx(w, holder, e)).wire);
      expect([r.status, r.body.reason]).toEqual([422, "not-cosigned-edition"]);
    }
  });

  it("refuses an edition the app would not show: authorities not locked, extra guards, a group, a foreign destination", async () => {
    const w = await world();
    const holder = await newKey();
    await sgt(w, 7n, [holder]);
    const someone = await randomAddress();
    const cases: EditionOptions[] = [
      { machine: { authority: someone } },
      { collectionAuthority: someone },
      { guard: { botTax: true } },
      { guard: { mintLimit: true } },
      { guard: { group: true } },
      { price: { kind: "sol", lamports: 5n }, guard: { solDestination: someone } },
      { machine: { name: "Harbour $ID$ #$ID+1$" }, collection: { title: "Harbour $ID$" } },
      { collection: { title: "Another title" } },
      { collection: { numMinted: 2 } },
      { collection: { extraPlugin: true } },
      { collection: { bps: 10_001 } },
      { machine: { available: 1001n }, collection: { available: 1001 } },
      { machine: { mintAuthority: someone } },
    ];
    for (const [n, o] of cases.entries()) {
      const e = await edition(w, o);
      const r = await claim(w, holder, e, (await claimTx(w, holder, e)).wire);
      expect([n, r.status, r.body.reason]).toEqual([n, 422, "not-signshot-edition"]);
    }
  });

  it("refuses a sold-out edition and a wrong cluster", async () => {
    const w = await world();
    const holder = await newKey();
    await sgt(w, 7n, [holder]);
    const soldOut = await edition(w, { machine: { redeemed: 10n, available: 10n } });
    expect((await claim(w, holder, soldOut, (await claimTx(w, holder, soldOut)).wire)).body.reason).toBe("sold-out");
    // A devnet edition claimed as mainnet: its devnet blockhash is not a mainnet one.
    const e = await edition(w);
    const r = await claim(w, holder, e, (await claimTx(w, holder, e)).wire, "mainnet-beta");
    expect([r.status, r.body.error]).toEqual([422, "blockhash-invalid"]);
    // And with a blockhash that is live on mainnet, the edition's accounts are not there.
    const onMainnet = await claim(w, holder, e, (await claimTx(w, holder, e, "mainnet-beta")).wire, "mainnet-beta");
    expect([onMainnet.status, onMainnet.body.reason]).toEqual([422, "not-signshot-edition"]);
  });

  it("refuses a claim naming another collection, even one laid out exactly like the edition's", async () => {
    const w = await world();
    const holder = await newKey();
    await sgt(w, 7n, [holder]);
    const e = await edition(w);
    const chain = w.rpc.chains[DEVNET_URL];
    const lookalike = await randomAddress();
    chain.accounts.set(lookalike, chain.accounts.get(e.collection)!);
    const r = await claim(w, holder, e, (await claimTx(w, holder, { ...e, collection: lookalike })).wire);
    expect([r.status, r.body.reason]).toEqual([422, "wrong-collection"]);
  });

  it("holds the payment to the guard's terms: kind, SOL destination, token mint and amount, collection", async () => {
    const w = await world();
    const holder = await newKey();
    await sgt(w, 7n, [holder]);
    const sol = await edition(w, { price: { kind: "sol", lamports: 1_000_000n } });
    // A free-shaped claim on a priced edition, and a priced claim on a free one.
    expect((await claim(w, holder, sol, (await claimTx(w, holder, { ...sol, price: { kind: "free" } })).wire)).body.reason).toBe("wrong-payment");
    const free = await edition(w);
    expect((await claim(w, holder, free, (await claimTx(w, holder, { ...free, price: { kind: "sol", lamports: 1n } })).wire)).body.reason)
      .toBe("wrong-payment");
    // SOL to someone other than the publisher.
    const thief = await randomAddress();
    expect((await claim(w, holder, sol, (await claimTx(w, holder, { ...sol, publisher: thief })).wire)).body.reason).toBe("wrong-payment");
    // Token: another mint, another amount.
    const mint = await randomAddress();
    const token = await edition(w, { price: { kind: "token", mint, amount: 42n } });
    expect((await claim(w, holder, token, (await claimTx(w, holder, { ...token, price: { kind: "token", mint, amount: 41n } })).wire)).body.reason)
      .toBe("wrong-payment");
    expect((await claim(w, holder, token, (await claimTx(w, holder, { ...token, price: { kind: "token", mint: thief, amount: 42n } })).wire)).body.reason)
      .toBe("wrong-payment");
    // Another collection.
    expect((await claim(w, holder, free, (await claimTx(w, holder, { ...free, collection: thief })).wire)).body.reason).toBe("not-signshot-edition");
  });

  it("refuses a blockhash that is not live on the stated cluster", async () => {
    const w = await world();
    const holder = await newKey();
    await sgt(w, 7n, [holder]);
    const e = await edition(w);
    const tx = await claimTx(w, holder, e);
    w.rpc.chains[DEVNET_URL].validBlockhashes.delete(tx.blockhash);
    const r = await claim(w, holder, e, tx.wire);
    expect([r.status, r.body.error]).toEqual([422, "blockhash-invalid"]);
    expect(await cfEnv.DB.prepare("SELECT COUNT(*) AS n FROM claims WHERE edition = ?").bind(e.address).first()).toEqual({ n: 0 });
  });

  it("refuses a malformed transaction before asking the chain anything", async () => {
    const w = await world();
    const holder = await newKey();
    await sgt(w, 7n, [holder]);
    const e = await edition(w);
    const tx = await claimTx(w, holder, e, "devnet", (ixs) => {
      ixs.unshift({ programAddress: TOKEN_2022_PROGRAM as Address, data: new Uint8Array([1]) });
    });
    const r = await claim(w, holder, e, tx.wire);
    expect([r.status, r.body.reason]).toEqual([422, "wrong-program"]);
    expect(w.rpc.calls).toEqual([]);
  });
});

describe("failures", () => {
  for (const failure of ["throw", "http-500", "rpc-error"] as const) {
    it(`answers 502 without the endpoint when the keyed mainnet RPC fails (${failure})`, async () => {
      const w = await world();
      const holder = await newKey();
      const e = await edition(w, { cluster: "mainnet-beta" });
      await sgt(w, 7n, [holder]);
      const tx = await claimTx(w, holder, e, "mainnet-beta");
      w.rpc.failure = failure;
      const payload = await challenge(w, holder.address);
      const response = await post(w, "/claim", {
        wallet: holder.address, nonce: payload.nonce, signInOutput: await signIn(holder, payload), edition: e.address,
        cluster: "mainnet-beta", transaction: b64(tx.wire),
      });
      // The failing request was the keyed endpoint's, and its error quoted the URL.
      expect(w.rpc.calls.at(-1)?.url).toBe(MAINNET_URL);
      const text = await response.text();
      expect(response.status).toBe(502);
      expect(JSON.parse(text)).toEqual({ error: "rpc-unavailable" });
      expect(text).not.toContain(API_KEY);
    });
  }

  it("logs an unexpected error by its class only, never its message", async () => {
    const w = await world();
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    const holder = await newKey();
    const e = await edition(w);
    await sgt(w, 7n, [holder]);
    const tx = await claimTx(w, holder, e);
    const payload = await challenge(w, holder.address);
    const brokenDb = { prepare() { throw new Error(`D1 failed while asking ${MAINNET_URL}`); } } as unknown as D1Database;
    const response = await handle(new Request("https://cosigner.test/claim", {
      method: "POST",
      body: JSON.stringify({
        wallet: holder.address, nonce: payload.nonce, signInOutput: await signIn(holder, payload), edition: e.address, cluster: "devnet",
        transaction: b64(tx.wire),
      }),
    }), { ...w.env, DB: brokenDb }, w.deps);
    spy.mockRestore();
    expect(response.status).toBe(500);
    expect(logged).toEqual(["unhandled Error"]);
    expect(await response.text()).not.toContain(API_KEY);
  });

  it("refuses to run with a short NONCE_HMAC_SECRET", async () => {
    const w = await world();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await handle(new Request("https://cosigner.test/health"), { ...w.env, NONCE_HMAC_SECRET: "short" }, w.deps);
    spy.mockRestore();
    expect([r.status, await r.json()]).toEqual([500, { error: "misconfigured" }]);
  });
});

describe("rate limits", () => {
  /** A fake Workers Rate Limiting binding: `limit` requests per key. */
  const limiter = (limit: number) => {
    const counts = new Map<string, number>();
    return {
      keys: counts,
      binding: { async limit({ key }: { key: string }) { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return { success: n <= limit }; } } as RateLimit,
    };
  };
  const from = (ip: string, path = "/health") => new Request(`https://cosigner.test${path}`, { headers: { "cf-connecting-ip": ip } });

  it("limits /health per client network, one IPv6 /64 counting as one client", async () => {
    const w = await world();
    const per = limiter(2);
    const env = { ...w.env, LIMITER: per.binding };
    expect((await handle(from("2001:db8:1:2::1"), env, w.deps)).status).toBe(200);
    expect((await handle(from("2001:0db8:0001:0002:ffff::9"), env, w.deps)).status).toBe(200);
    expect((await handle(from("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), env, w.deps)).status).toBe(429);
    expect((await handle(from("2001:db8:1:3::1"), env, w.deps)).status).toBe(200);
    expect((await handle(from("203.0.113.7"), env, w.deps)).status).toBe(200);
    expect([...per.keys.keys()].sort()).toEqual(["health:2001:db8:1:2::/64", "health:2001:db8:1:3::/64", "health:203.0.113.7"]);
  });

  it("caps the whole Worker with one constant key, across clients and routes", async () => {
    const w = await world();
    const global = limiter(3);
    const env = { ...w.env, GLOBAL_LIMITER: global.binding };
    const statuses = [];
    for (const ip of ["198.51.100.1", "198.51.100.2", "2001:db8::1", "198.51.100.3"]) statuses.push((await handle(from(ip), env, w.deps)).status);
    const challengeResponse = await handle(new Request("https://cosigner.test/challenge", {
      method: "POST", body: JSON.stringify({ wallet: await randomAddress() }),
    }), env, w.deps);
    expect([...statuses, challengeResponse.status]).toEqual([200, 200, 200, 429, 429]);
    expect([...global.keys.keys()]).toEqual(["global"]);
  });
});

describe("key rotation", () => {
  it("co-signs with whichever accepted key the edition's guard names; /health names the active one", async () => {
    const w = await world();
    const old = await newKey();
    const rotated: World = { ...w, cosigner: old, env: { ...w.env, COSIGNER_SECRET_KEYS: JSON.stringify([[...old.secret]]) } };
    const health = await handle(new Request("https://cosigner.test/health"), rotated.env, w.deps);
    expect(await health.json()).toEqual({ version: VERSION, signer: w.cosigner.address, accepted: [w.cosigner.address, old.address] });

    const holder = await newKey();
    await sgt(rotated, 7n, [holder]);
    const e = await edition(rotated); // its guard names the old key
    const tx = await claimTx(rotated, holder, e);
    const r = await claim(rotated, holder, e, tx.wire);
    expect([r.status, r.body.signer]).toEqual([200, old.address]);
    expect(await verifiesAs(old, r.body.signature, tx.wire)).toBe(true);

    // Without the old key accepted, the same edition is refused.
    const fresh = await claim({ ...rotated, env: w.env }, holder, e, (await claimTx(rotated, holder, e)).wire);
    expect([fresh.status, fresh.body.reason]).toEqual([422, "cosigner-missing"]);
  });

  it("refuses a transaction naming two accepted keys", async () => {
    const w = await world();
    const old = await newKey();
    const rotated: World = { ...w, cosigner: old, env: { ...w.env, COSIGNER_SECRET_KEYS: JSON.stringify([[...old.secret]]) } };
    const holder = await newKey();
    await sgt(rotated, 7n, [holder]);
    const e = await edition(rotated);
    const tx = await claimTx(rotated, holder, e, "devnet", (ixs) => {
      const mint = ixs[1];
      ixs[1] = { ...mint, accounts: mint.accounts!.map((a, i) => (i === 6 ? { ...a, address: w.cosigner.address } : a)) };
    });
    const r = await claim(rotated, holder, e, tx.wire);
    expect([r.status, r.body.reason]).toEqual([422, "cosigner-position"]);
  });
});
