/**
 * JSON-RPC over `fetch`. The endpoint URL carries an API key, so nothing that leaves this file
 * names it: every failure becomes an `RpcError` carrying only the method name, and the cause
 * (a fetch TypeError can quote the URL) is dropped, never chained.
 */

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class RpcError extends Error {
  constructor(readonly method: string) {
    super(`Solana RPC ${method} failed`);
    this.name = "RpcError";
  }
}

/** Every answer this Worker reads is small; a bigger body is refused before it is parsed. */
const MAX_RESPONSE_BYTES = 2_000_000;

export async function rpc<T>(fetchImpl: Fetch, url: string, method: string, params: unknown[]): Promise<T> {
  let body: unknown;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw 0;
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw 0;
    body = JSON.parse(text);
  } catch {
    throw new RpcError(method);
  }
  const reply = body as { result?: unknown; error?: unknown } | null;
  if (!reply || typeof reply !== "object" || reply.error !== undefined || !("result" in reply))
    throw new RpcError(method);
  return reply.result as T;
}

export const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Each cluster's genesis hash: the one value that says which chain an endpoint is really on. */
export const GENESIS_HASH = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
} as const;

export type Cluster = keyof typeof GENESIS_HASH;

const checked = new Map<string, Promise<void>>();

/**
 * Refuse an endpoint that is not on `cluster` before any answer from it is believed. Asked once
 * per endpoint per isolate; a failure is forgotten so the next request asks again.
 */
export function assertCluster(fetchImpl: Fetch, url: string, cluster: Cluster): Promise<void> {
  const key = `${cluster}\n${url}`;
  let asking = checked.get(key);
  if (!asking) {
    asking = rpc<unknown>(fetchImpl, url, "getGenesisHash", []).then((hash) => {
      if (hash !== GENESIS_HASH[cluster]) throw new RpcError("getGenesisHash");
    });
    const mine = asking;
    mine.catch(() => { if (checked.get(key) === mine) checked.delete(key); });
    checked.set(key, mine);
  }
  return asking;
}

/** For tests: forget which endpoints were checked. */
export const forgetCheckedEndpoints = () => checked.clear();
