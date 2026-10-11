/**
 * `POST /rpc`: the app's mainnet JSON-RPC endpoint, so the provider key stays out of the APK.
 * Single calls only (Kit sends no batches), allowlisted methods, forwarded to `MAINNET_RPC_URL`.
 * Never logs or returns the endpoint.
 */

import { object, type Fetch } from "./rpc";

/** Methods the app and its wallet library call (README, "Mainnet build"). */
export const RPC_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo", "getBalance", "getBlockHeight", "getGenesisHash", "getLatestBlockhash",
  "getMinimumBalanceForRentExemption", "getMultipleAccounts", "getProgramAccounts",
  "getRecentPrioritizationFees", "getSignatureStatuses", "getSignaturesForAddress",
  "getTokenAccountsByOwner", "getTokenAccountBalance", "getTransaction", "sendTransaction",
  "simulateTransaction", "getSlot", "getEpochInfo", "getVersion", "getHealth",
]);

/** A sendTransaction or a 100-address getMultipleAccounts fits several times over. */
export const MAX_RPC_BODY_BYTES = 16384;

const rpcError = (status: number, id: unknown, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function proxyRpc(request: Request, upstream: string, fetchImpl: Fetch): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_RPC_BODY_BYTES) return rpcError(413, null, -32600, "request too large");
  const text = await request.text();
  if (text.length > MAX_RPC_BODY_BYTES) return rpcError(413, null, -32600, "request too large");
  let call: Record<string, unknown> | undefined;
  try {
    call = object(JSON.parse(text));
  } catch { /* falls through */ }
  if (!call || call.jsonrpc !== "2.0" || typeof call.method !== "string")
    return rpcError(400, call?.id, -32600, "invalid request");
  if (!RPC_METHODS.has(call.method)) return rpcError(403, call.id, -32601, "method not allowed");
  if (call.params !== undefined && !Array.isArray(call.params)) return rpcError(400, call.id, -32602, "invalid params");

  let answer: Response;
  try {
    answer = await fetchImpl(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: call.id ?? null, method: call.method, params: call.params ?? [] }),
    });
  } catch {
    // Only the method: a fetch error can quote the URL, and the URL carries the key.
    console.error("rpc-proxy", call.method);
    return rpcError(502, call.id, -32603, "upstream unavailable");
  }
  if (answer.status === 429) return rpcError(429, call.id, -32005, "rate limited");
  if (!answer.ok) {
    console.error("rpc-proxy", call.method, answer.status);
    return rpcError(502, call.id, -32603, "upstream unavailable");
  }
  return new Response(answer.body, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
