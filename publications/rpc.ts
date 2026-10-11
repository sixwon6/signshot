import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type Rpc,
  type RpcResponse,
  type RpcTransport,
  type SolanaRpcApi,
} from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
/** Headroom in cost estimates for wallet-added priority fees. */
export const FEE_ALLOWANCE_LAMPORTS = 250_000n;

/** JSON-RPC body cap, enforced before `JSON.parse`. */
const RPC_MAX_BYTES = 4_000_000;
const RPC_TOO_LARGE = "The Solana response is too large to read safely.";
/** Fixed (no multiplexing); echo check rejects non-RPC bodies such as captive portals. */
const RPC_REQUEST_ID = 1;

/**
 * Read a body up to `limit` bytes. React Native's fetch has no stream, so `Content-Length` is the
 * only pre-read bound there; `refuseUndeclared` decides whether a missing length is refused.
 */
async function boundedBody(
  res: Response,
  limit: number,
  tooLarge: string,
  abort: () => void,
  refuseUndeclared: boolean,
): Promise<Uint8Array> {
  const declared = res.headers?.get?.("content-length") ?? null;
  const undeclared = declared === null || declared.trim() === "";
  if (!undeclared) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > limit)
      throw new Error(tooLarge);
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    if (undeclared && refuseUndeclared) throw new Error(tooLarge);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > limit) throw new Error(tooLarge);
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > limit) {
        abort();
        throw new Error(tooLarge);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Only 429 is retried: the provider did no work, so a resend is safe. Key-free RPC URLs allow
 * 5 req/s per IP, and phones behind carrier NAT share one.
 */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_MS = 500;
const RATE_LIMIT_MAX_WAIT_MS = 5_000;

/** `Retry-After` (seconds or HTTP date), else 500 ms × 2^attempt with 0.5–1.5× jitter; capped. */
export function rateLimitDelayMs(
  attempt: number,
  retryAfter: string | null | undefined,
  now = Date.now(),
  random = Math.random(),
): number {
  const value = retryAfter?.trim() ?? "";
  let ms = /^\d+$/.test(value) ? Number(value) * 1000 : value ? Date.parse(value) - now : NaN;
  if (!Number.isFinite(ms)) ms = RATE_LIMIT_BASE_MS * 2 ** attempt * (0.5 + random);
  return Math.round(Math.min(RATE_LIMIT_MAX_WAIT_MS, Math.max(0, ms)));
}

function waitUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  // React Native's AbortSignal has no `reason`; its fetch rejects with this instead.
  const aborted = () => signal?.reason ?? Object.assign(new Error("Aborted"), { name: "AbortError" });
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Kit's default transport with the same 429 retry as `request()`; the last 429 is rethrown unchanged. */
export function solanaRpc(endpoint: string): Rpc<SolanaRpcApi> {
  const transport = createDefaultRpcTransport({ url: endpoint });
  const retrying: RpcTransport = async <TResponse>(
    config: Parameters<RpcTransport>[0],
  ): Promise<RpcResponse<TResponse>> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport<TResponse>(config);
      } catch (error) {
        if (
          attempt >= RATE_LIMIT_RETRIES ||
          !isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) ||
          error.context.statusCode !== 429
        )
          throw error;
        await waitUnlessAborted(
          rateLimitDelayMs(attempt, error.context.headers?.get?.("retry-after")),
          config.signal,
        );
      }
    }
  };
  return createSolanaRpcFromTransport(retrying);
}

export async function request<T>(
  endpoint: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    // One deadline spans all attempts and waits.
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: RPC_REQUEST_ID, method, params }),
        signal: controller.signal,
      });
      if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) break;
      // Unread, the refused body would hold its connection open.
      res.body?.cancel?.().catch(() => {});
      await waitUnlessAborted(
        rateLimitDelayMs(attempt, res.headers?.get?.("retry-after")),
        controller.signal,
      );
    }
    if (!res.ok) {
      // Prefer a JSON-RPC error message over the bare status.
      let message: string | undefined;
      try {
        const body = JSON.parse(
          new TextDecoder().decode(
            await boundedBody(res, RPC_MAX_BYTES, RPC_TOO_LARGE, () => controller.abort(), false),
          ),
        );
        const text = body?.error?.message;
        if (typeof text === "string" && text.trim()) message = text.trim();
      } catch {
        // Fall back to the status.
      }
      throw new Error(
        message ?? `Solana connection unavailable (${res.status}). Please retry.`,
      );
    }
    const body = JSON.parse(
      new TextDecoder().decode(
        await boundedBody(res, RPC_MAX_BYTES, RPC_TOO_LARGE, () => controller.abort(), false),
      ),
    );
    if (
      !body ||
      typeof body !== "object" ||
      body.jsonrpc !== "2.0" ||
      body.id !== RPC_REQUEST_ID
    )
      throw new Error("Invalid Solana response");
    if (body.error)
      throw new Error(String(body.error.message ?? "Solana request failed"));
    if (!("result" in body)) throw new Error("Invalid Solana response");
    return body.result as T;
  } finally {
    clearTimeout(timeout);
  }
}
/** Read cap for a published file; well above the app's upload cap. */
const ARWEAVE_MAX_BYTES = 200_000;
const FILE_TOO_LARGE = "Edition file is too large.";
const FILE_MISMATCH = "The published file does not match its onchain fingerprint.";

/**
 * `/raw/` returns the exact stored bytes with a 200; bare `arweave.net/<id>` 302s to a sandbox
 * subdomain. On-chain `uri`s still name `https://arweave.net/<id>`.
 */
const ARWEAVE_GATEWAYS: readonly string[] = [
  "https://arweave.net/raw/",
  "https://turbo-gateway.com/raw/",
];
/** Per-attempt deadline (headers and body): short while a fallback remains, long for the last. */
const GATEWAY_TRY_TIMEOUT_MS = 1_200;
const GATEWAY_BODY_TIMEOUT_MS = 15_000;

/** First gateway's bytes that match `expectedHash`. `IntegrityError` if all failed and any mismatched. */
export async function arweaveBytes(
  id: string,
  expectedHash?: string,
): Promise<Uint8Array> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id))
    throw new Error("Invalid Arweave reference");
  let last: unknown;
  let mismatched = false;
  for (const [index, host] of ARWEAVE_GATEWAYS.entries()) {
    const deadline = index === ARWEAVE_GATEWAYS.length - 1
      ? GATEWAY_BODY_TIMEOUT_MS
      : GATEWAY_TRY_TIMEOUT_MS;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadline);
      let bytes: Uint8Array;
      try {
        const r = await fetch(`${host}${id}`, { signal: controller.signal });
        if (!r.ok)
          throw new Error(
            "Photo is still becoming available. Try again shortly.",
          );
        bytes = await boundedBody(
          r,
          ARWEAVE_MAX_BYTES,
          FILE_TOO_LARGE,
          () => controller.abort(),
          // No stream and no Content-Length would be an unbounded read.
          true,
        );
      } finally {
        clearTimeout(timer);
      }
      if (bytes.length > ARWEAVE_MAX_BYTES) throw new Error(FILE_TOO_LARGE);
      if (expectedHash && bytesToHex(sha256(bytes)) !== expectedHash)
        throw new IntegrityError(FILE_MISMATCH);
      return bytes;
    } catch (error) {
      if (error instanceof IntegrityError) mismatched = true;
      last = error;
    }
  }
  if (mismatched) throw new IntegrityError(FILE_MISMATCH);
  throw last;
}
/** Bytes that do not match the published hash. Not retryable. */
export class IntegrityError extends Error {}
export const NEEDS_SOL =
  "This wallet needs more SOL for account creation and network fees.";
/** Same 20 s deadline as `request()`, for kit calls. */
export async function rpcWithTimeout<T>(send: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await send(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Solana did not answer in time. Please retry.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
