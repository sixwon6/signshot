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
/** Wallet-added priority/guard costs, visibly included in the estimate rather than called a price. */
export const FEE_ALLOWANCE_LAMPORTS = 50_000n;

/**
 * Byte cap for a JSON-RPC body, enforced before `JSON.parse` so a hostile endpoint cannot force a
 * huge allocation. Generous for every method this client calls.
 */
const RPC_MAX_BYTES = 4_000_000;
const RPC_TOO_LARGE = "The Solana response is too large to read safely.";
/**
 * The `id` every response must echo. Fixed, since requests are never multiplexed; the check
 * rejects bodies that are not a JSON-RPC reply at all (captive portals, cached pages).
 */
const RPC_REQUEST_ID = 1;

/**
 * A response body read with a byte ceiling. Streams are counted and aborted past `limit`. React
 * Native's fetch has no stream, so there `Content-Length` is the only pre-read bound, and
 * `refuseUndeclared` decides whether a missing length is refused (gateway files) or allowed (RPC).
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
 * HTTP 429 is retried, and nothing else: the provider refused before doing any work, so a resend is
 * safe (a signed transaction resends as the same signature). Key-free provider URLs allow 5
 * requests per second per IP, and phones behind carrier NAT share one.
 */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_MS = 500;
const RATE_LIMIT_MAX_WAIT_MS = 5_000;

/**
 * The wait before retry `attempt` (from 0): `Retry-After` in seconds or as an HTTP date, else
 * 500 ms × 2^attempt jittered to 0.5–1.5×. Capped either way, so no header can stall a call.
 */
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

/** Waits `ms`, or rejects the moment `signal` aborts, with what fetch would reject with. */
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

/**
 * Every kit client: kit's default transport (coalescing and `Solana-Client` header kept) behind the
 * same 429 policy as `request()`. The last 429 is rethrown as kit threw it, so `safeErrorText`
 * still reads it as a busy network.
 */
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
    // The one deadline above spans every attempt and every wait.
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
      // A proxy may explain a 502/503 in a JSON-RPC error body; prefer that over the bare status.
      let message: string | undefined;
      try {
        // Bounded like any other body: an error page is still a body a hostile endpoint chooses.
        const body = JSON.parse(
          new TextDecoder().decode(
            await boundedBody(res, RPC_MAX_BYTES, RPC_TOO_LARGE, () => controller.abort(), false),
          ),
        );
        const text = body?.error?.message;
        if (typeof text === "string" && text.trim()) message = text.trim();
      } catch {
        // A non-JSON, oversized or truncated error body is not itself an error: use the status.
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
    // The envelope before the payload. A body that does not name JSON-RPC 2.0 and echo this
    // call's own `id` is not an answer to this call, whatever it contains.
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
/** Everything a published file may weigh. The app's own upload cap is far below it. */
const ARWEAVE_MAX_BYTES = 200_000;
const FILE_TOO_LARGE = "Edition file is too large.";
const FILE_MISMATCH = "The published file does not match its onchain fingerprint.";

/**
 * Gateways in order, both on `/raw/`, which answers 200 with the exact stored bytes a hash check
 * needs. `arweave.net` first because it is the only host an on-chain `uri` may name, and that
 * `uri` stays `https://arweave.net/<id>`; only the read path differs. The bare `arweave.net/<id>`
 * answers 302 to a per-item sandbox host (`<hash>.arweave.net`).
 */
const ARWEAVE_GATEWAYS: readonly string[] = [
  "https://arweave.net/raw/",
  "https://turbo-gateway.com/raw/",
];
/**
 * One deadline per gateway attempt, covering headers and body: short while another gateway
 * remains, long for the last one so a slow network still gets the file.
 */
const GATEWAY_TRY_TIMEOUT_MS = 1_200;
const GATEWAY_BODY_TIMEOUT_MS = 15_000;

/**
 * One published file, hash-checked, from the first gateway that produces matching bytes. A
 * mismatch tries the next gateway; `IntegrityError` is thrown only if all failed and one mismatched.
 */
export async function arweaveBytes(
  id: string,
  expectedHash?: string,
): Promise<Uint8Array> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id))
    throw new Error("Invalid Arweave reference");
  let last: unknown;
  let mismatched = false;
  for (const [index, host] of ARWEAVE_GATEWAYS.entries()) {
    // The deadline is the whole attempt's, and the last gateway's is the long one: there is
    // nowhere to fall through to, so abandoning it early only loses the file.
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
          // No stream reader and no declared length is the unbounded case this cap exists for:
          // refuse it rather than allocate whatever a gateway decides to send.
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
/** Bytes that reached us but were not the published bytes. Never a retryable failure. */
export class IntegrityError extends Error {}
/** The one message a collector or publisher can act on: add SOL and try again. */
export const NEEDS_SOL =
  "This wallet needs more SOL for account creation and network fees.";
/** Kit requests need the same bounded lifetime as the raw JSON-RPC reader above. */
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
