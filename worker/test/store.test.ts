import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { consumeNonce, findClaim, insertClaim, pruneNonces, replaceClaim, type NewClaim } from "../src/store";

const claim = (id: string, over: Partial<NewClaim> = {}): NewClaim => ({
  cluster: "devnet", edition: "E", sgt_mint: "S", wallet: `W-${id}`, asset: `A-${id}`, blockhash: `B-${id}`, last_valid_height: 100, message: `M-${id}`,
  signature: `T-${id}`, claim_id: id, created_at: 1, ...over,
});

describe("claims table", () => {
  it("lets exactly one of two simultaneous inserts take an (edition, SGT) slot", async () => {
    const results = await Promise.all([insertClaim(env.DB, claim("one")), insertClaim(env.DB, claim("two"))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    // Slots are per edition and per cluster.
    expect(await insertClaim(env.DB, claim("three", { edition: "E2" }))).toBe(true);
    expect(await insertClaim(env.DB, claim("four", { cluster: "mainnet-beta" }))).toBe(true);
  });

  it("hands a released row to exactly one of two simultaneous takers", async () => {
    await insertClaim(env.DB, claim("old", { edition: "R" }));
    const results = await Promise.all([
      replaceClaim(env.DB, "old", claim("new-a", { edition: "R" })),
      replaceClaim(env.DB, "old", claim("new-b", { edition: "R" })),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await findClaim(env.DB, "devnet", "R", "S"))?.claim_id).toMatch(/^new-/);
  });

  it("spends a nonce once and prunes it after expiry", async () => {
    expect(await consumeNonce(env.DB, "n1", 100)).toBe(true);
    expect(await consumeNonce(env.DB, "n1", 100)).toBe(false);
    await pruneNonces(env.DB, 101);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM used_nonces").first<{ n: number }>()).toEqual({ n: 0 });
  });
});
