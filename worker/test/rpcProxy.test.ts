import { describe, expect, it } from "vitest";
import { MAX_RPC_BODY_BYTES, proxyRpc } from "../src/rpcProxy";
import { API_KEY, MAINNET_URL } from "./fixtures";

const post = (body: string) =>
  new Request("https://cosign.erashot.app/rpc", { method: "POST", headers: { "content-type": "application/json" }, body });

describe("POST /rpc", () => {
  it("forwards an allowed call to the mainnet endpoint and returns its answer", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const r = await proxyRpc(post(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "getGenesisHash" })), MAINNET_URL, async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 7, result: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }));
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ jsonrpc: "2.0", id: 7, result: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" });
    expect(seen).toEqual([{ url: MAINNET_URL, body: { jsonrpc: "2.0", id: 7, method: "getGenesisHash", params: [] } }]);
  });

  it("refuses methods the app never calls, batches and oversized bodies without asking upstream", async () => {
    let asked = 0;
    const f = async () => { asked++; return new Response("{}"); };
    expect((await proxyRpc(post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "requestAirdrop", params: [] })), MAINNET_URL, f)).status).toBe(403);
    expect((await proxyRpc(post(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "getHealth" }])), MAINNET_URL, f)).status).toBe(400);
    expect((await proxyRpc(post("not json"), MAINNET_URL, f)).status).toBe(400);
    expect((await proxyRpc(post("x".repeat(MAX_RPC_BODY_BYTES + 1)), MAINNET_URL, f)).status).toBe(413);
    expect(asked).toBe(0);
  });

  it("never returns the endpoint or its key when upstream fails", async () => {
    const r = await proxyRpc(post(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "getBalance", params: ["x"] })), MAINNET_URL,
      async () => { throw new TypeError(`fetch failed: ${MAINNET_URL}`); });
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain(API_KEY);
  });
});
