/**
 * Signshot's Seeker co-signer. It holds the Third Party Signer keys of Seeker-only editions and
 * co-signs one claim per Seeker Genesis Token per edition, after Solana Mobile's server-side
 * check: SIWS proves the wallet, mainnet shows the wallet holds an SGT, and the SGT's mint has
 * not already claimed this edition.
 *
 *   GET  /health     { version, signer, accepted }
 *   POST /challenge  { wallet } → the SIWS sign-in payload
 *   POST /claim      { wallet, nonce, signInOutput, edition, cluster, transaction }
 *                    → { signature, signer, sgtMint, transaction }
 */

import { getBase58Decoder, getBase64Decoder, getBase64Encoder, isAddress } from "@solana/kit";
import { checkClaimTransaction, MPL_CORE, parseTransaction, Refused } from "./claimTransaction";
import { loadCosigners, type Cosigner } from "./cosigner";
import { checkAgainstEdition, readEdition } from "./edition";
import { findSeekerGenesisTokens, TooManyTokens } from "./genesis";
import { assertCluster, GENESIS_HASH, object, rpc, RpcError, type Cluster, type Fetch } from "./rpc";
import { issueChallenge, verifySignIn, type SignInResult, type SiwsConfig } from "./siws";
import { confirmClaim, consumeNonce, findClaim, insertClaim, pruneNonces, replaceClaim, type ClaimRow, type NewClaim } from "./store";

export const VERSION = "1.1.0";

export interface Env {
  DB: D1Database;
  /** Workers Rate Limiting: per client network (IPv4 address or IPv6 /64), per route. */
  LIMITER?: RateLimit;
  /** Workers Rate Limiting with one constant key: a cap on the whole Worker. */
  GLOBAL_LIMITER?: RateLimit;
  /** Secret: the active co-signer key, solana-keygen JSON, 64 bytes. */
  COSIGNER_SECRET_KEY: string;
  /** Secret, optional: a JSON array of further accepted co-signer keys (rotation overlap). */
  COSIGNER_SECRET_KEYS?: string;
  /** Secret: at least 32 characters of random material. */
  NONCE_HMAC_SECRET: string;
  /** Secret: a Helius mainnet URL with its API key. Never logged, never returned. */
  MAINNET_RPC_URL: string;
  /** Var: a devnet endpoint, for devnet editions' blockhash and copy checks. */
  DEVNET_RPC_URL: string;
  /** Var: the SIWS domain and URI. */
  SIWS_DOMAIN: string;
  SIWS_URI: string;
}

export interface Deps { fetch: Fetch; now: () => number }

const MAX_BODY_BYTES = 8192;
export const MIN_HMAC_SECRET_LENGTH = 32;
/** Held Genesis Tokens tried for one claim, lowest member number first. */
const MAX_TOKENS_TRIED = 10;
/** A transaction is valid for 150 blocks after its blockhash's; one more is the stored bound. */
const BLOCKHASH_LIFETIME_BLOCKS = 151;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fail = (status: number, error: string, reason?: string) => json(status, reason ? { error, reason } : { error });

class HttpError extends Error {
  constructor(readonly response: Response) { super("http"); }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new HttpError(fail(413, "too-large"));
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(fail(413, "too-large"));
  try {
    const body = object(JSON.parse(text));
    if (body) return body;
  } catch { /* fall through */ }
  throw new HttpError(fail(400, "bad-request"));
}

const address = (value: unknown): string => {
  if (typeof value !== "string" || !isAddress(value)) throw new HttpError(fail(400, "bad-request"));
  return value;
};

const siwsConfig = (env: Env): SiwsConfig => ({ domain: env.SIWS_DOMAIN, uri: env.SIWS_URI, hmacSecret: env.NONCE_HMAC_SECRET });

/** The rate-limit key of a client: its IPv4 address, or the /64 network of its IPv6 address. */
export function clientNetwork(ip: string | null): string {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

async function rateLimited(env: Env, request: Request, route: string): Promise<boolean> {
  if (env.GLOBAL_LIMITER && !(await env.GLOBAL_LIMITER.limit({ key: "global" })).success) return true;
  if (env.LIMITER && !(await env.LIMITER.limit({ key: `${route}:${clientNetwork(request.headers.get("cf-connecting-ip"))}` })).success)
    return true;
  return false;
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
    if ((env.NONCE_HMAC_SECRET ?? "").length < MIN_HMAC_SECRET_LENGTH) {
      console.error("misconfigured", "NONCE_HMAC_SECRET");
      return fail(500, "misconfigured");
    }
    const route = pathname === "/health" && request.method === "GET" ? "health"
      : pathname === "/challenge" && request.method === "POST" ? "challenge"
      : pathname === "/claim" && request.method === "POST" ? "claim" : null;
    if (!route) return fail(404, "not-found");
    if (await rateLimited(env, request, route)) return fail(429, "rate-limited");
    if (route === "health") {
      const keys = await loadCosigners(env.COSIGNER_SECRET_KEY, env.COSIGNER_SECRET_KEYS);
      return json(200, { version: VERSION, signer: keys.active.address, accepted: [...keys.accepted.keys()] });
    }
    if (route === "challenge") {
      const wallet = address((await readBody(request)).wallet);
      return json(200, await issueChallenge(siwsConfig(env), wallet, deps.now()));
    }
    return await claim(await readBody(request), env, deps);
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    if (e instanceof RpcError) {
      // Only the method: the endpoint carries a key.
      console.error("rpc", e.method);
      return fail(502, "rpc-unavailable");
    }
    // Only the error's class: a message could quote a URL.
    console.error("unhandled", e instanceof Error ? e.name : typeof e);
    return fail(500, "internal");
  }
}

/**
 * The accepted key the transaction names, or a refusal. Exactly one accepted key may appear; the
 * transaction check then holds it to the co-signer's place, and the edition check to the guard.
 */
function namedCosigner(wire: Uint8Array, accepted: Map<string, Cosigner>): Cosigner {
  const named = parseTransaction(wire).keys.filter((k) => accepted.has(k));
  if (named.length !== 1) throw new Refused(named.length ? "cosigner-position" : "cosigner-missing");
  return accepted.get(named[0])!;
}

async function claim(body: Record<string, unknown>, env: Env, deps: Deps): Promise<Response> {
  // 1. Shapes.
  const wallet = address(body.wallet);
  const edition = address(body.edition);
  const cluster = body.cluster as Cluster;
  if (typeof cluster !== "string" || !Object.hasOwn(GENESIS_HASH, cluster)) return fail(400, "bad-request");
  const nonce = body.nonce;
  const signIn = object(body.signInOutput);
  if (typeof nonce !== "string" || !signIn || typeof signIn.address !== "string" ||
      typeof signIn.signed_message !== "string" || typeof signIn.signature !== "string" ||
      typeof body.transaction !== "string" || body.transaction.length > 2000)
    return fail(400, "bad-request");
  let wire: Uint8Array;
  try {
    wire = new Uint8Array(getBase64Encoder().encode(body.transaction));
  } catch {
    return fail(400, "bad-request");
  }

  // 2. SIWS: the wallet signed the payload this Worker issued, unexpired. Local, no RPC.
  const now = deps.now();
  const signedIn = await verifySignIn(siwsConfig(env), wallet, nonce, signIn as unknown as SignInResult, now);
  if (!signedIn.ok) return fail(401, signedIn.reason);

  // 3. The transaction: the wallet's signature over it first, then exactly a claim on this
  //    edition by this wallet naming one accepted key. Local, no RPC.
  const keys = await loadCosigners(env.COSIGNER_SECRET_KEY, env.COSIGNER_SECRET_KEYS);
  const clusterUrl = cluster === "mainnet-beta" ? env.MAINNET_RPC_URL : env.DEVNET_RPC_URL;
  let tx: Awaited<ReturnType<typeof checkClaimTransaction>>;
  let cosigner: Cosigner;
  let lastValidHeight: number;
  try {
    cosigner = namedCosigner(wire, keys.accepted);
    tx = await checkClaimTransaction(wire, { wallet, edition, cosigner: cosigner.address });

    // 4. The edition's cluster, one cheap read after another: the blockhash is live (which binds
    //    the claim to that cluster, and bounds when it can land), then the edition is one the
    //    app itself accepts, its guard naming this key, and the claim pays exactly its terms.
    lastValidHeight = await liveUntil(deps.fetch, clusterUrl, cluster, tx.blockhash);
    if (lastValidHeight < 0) return fail(422, "blockhash-invalid");
    checkAgainstEdition(tx, await readEdition(deps.fetch, clusterUrl, edition, tx, cosigner.address));
  } catch (e) {
    if (e instanceof Refused) return fail(422, "transaction-refused", e.reason);
    throw e;
  }

  // 5. Only now: spend the nonce, then the paid Genesis Token lookup on mainnet.
  if (!(await consumeNonce(env.DB, nonce, signedIn.expiresAt))) return fail(401, "nonce-used");
  let tokens: string[];
  try {
    tokens = await findSeekerGenesisTokens(deps.fetch, env.MAINNET_RPC_URL, wallet);
  } catch (e) {
    if (e instanceof TooManyTokens) return fail(422, "too-many-tokens");
    throw e;
  }
  if (tokens.length === 0) return fail(403, "no-genesis-token");

  // 6. Record, then sign (see store.ts for why in this order), with the first held Genesis Token
  //    that has not claimed this edition.
  const base = {
    cluster, edition, wallet, asset: tx.asset, blockhash: tx.blockhash, last_valid_height: lastValidHeight,
    message: await sha256Hex(tx.message), claim_id: crypto.randomUUID(), created_at: now,
  };
  let refusal: "genesis-used" | "genesis-pending" = "genesis-used";
  let sgtMint: string | null = null;
  for (const mint of tokens.slice(0, MAX_TOKENS_TRIED)) {
    const held = await hold(env, deps, { ...base, sgt_mint: mint }, clusterUrl);
    if (held === "held") { sgtMint = mint; break; }
    if (held === "genesis-pending") refusal = held;
  }
  if (!sgtMint) return fail(409, refusal);

  const signature = await cosigner.sign(tx.message);
  // The transaction as received with this signature in its slot: ready for the app to broadcast.
  const signed = wire.slice();
  signed.set(signature, tx.signaturesStart + 64 * tx.cosignerSlot);
  return json(200, {
    signature: getBase58Decoder().decode(signature), signer: cosigner.address, sgtMint, transaction: getBase64Decoder().decode(signed),
  });
}

/** Take the `(cluster, edition, sgt)` slot for `claim`, or say why not. */
async function hold(env: Env, deps: Deps, claim: NewClaim, clusterUrl: string): Promise<"held" | "genesis-used" | "genesis-pending"> {
  const row = await findClaim(env.DB, claim.cluster, claim.edition, claim.sgt_mint);
  if (!row) return (await insertClaim(env.DB, claim)) ? "held" : "genesis-pending";
  if (row.status === "confirmed") return "genesis-used";
  // The same claim again (a retry after a lost response): the same wallet and the same message
  // bytes as received, so the same transaction, which can land at most once.
  if (row.wallet === claim.wallet && row.message === claim.message) return "held";
  const standing = await pendingStanding(deps.fetch, clusterUrl, row);
  if (standing === "landed") {
    await confirmClaim(env.DB, row);
    return "genesis-used";
  }
  if (standing === "may-land") return "genesis-pending";
  return (await replaceClaim(env.DB, row.claim_id, claim)) ? "held" : "genesis-pending";
}

/**
 * Whether a pending claim's transaction landed, may still land, or never will (store.ts). The
 * confirmed block height must be past the stored bound before the copy's address is read, and
 * that read is pinned to the slot that answered.
 */
async function pendingStanding(fetchImpl: Fetch, url: string, row: ClaimRow): Promise<"landed" | "may-land" | "expired"> {
  await assertCluster(fetchImpl, url, row.cluster);
  const epoch = object(await rpc<unknown>(fetchImpl, url, "getEpochInfo", [{ commitment: "confirmed" }]));
  const height = epoch?.blockHeight, slot = epoch?.absoluteSlot;
  if (typeof height !== "number" || typeof slot !== "number") throw new RpcError("getEpochInfo");
  if (height <= row.last_valid_height) return "may-land";
  return (await copyLanded(fetchImpl, url, row.asset, slot)) ? "landed" : "expired";
}

/**
 * The bound on the block height through which a transaction with `blockhash` can land, or -1
 * when the blockhash is not live on `cluster`. Asked at "processed": a blockhash the app just
 * fetched is there first, and one valid at any commitment on a cluster is that cluster's. The
 * height is read no earlier than the slot that answered, so it is at least the blockhash's own.
 */
async function liveUntil(fetchImpl: Fetch, url: string, cluster: Cluster, blockhash: string): Promise<number> {
  await assertCluster(fetchImpl, url, cluster);
  const valid = object(await rpc<unknown>(fetchImpl, url, "isBlockhashValid", [blockhash, { commitment: "processed" }]));
  const slot = object(valid?.context)?.slot;
  if (typeof valid?.value !== "boolean" || typeof slot !== "number") throw new RpcError("isBlockhashValid");
  if (!valid.value) return -1;
  const height = await rpc<unknown>(fetchImpl, url, "getBlockHeight", [{ commitment: "processed", minContextSlot: slot }]);
  if (typeof height !== "number") throw new RpcError("getBlockHeight");
  return height + BLOCKHASH_LIFETIME_BLOCKS;
}

/**
 * Whether the copy's address shows the claim landed: a Core-owned account, or a 1-byte account
 * (Core's burn leaves a 1-byte tombstone; Core's permissionless fee sweep can leave it
 * System-owned). Lamports sent to the address make a 0-byte System account, which is not one.
 */
async function copyLanded(fetchImpl: Fetch, url: string, asset: string, minContextSlot: number): Promise<boolean> {
  const result = object(await rpc<unknown>(fetchImpl, url, "getAccountInfo", [
    asset, { encoding: "base64", commitment: "confirmed", minContextSlot },
  ]));
  if (!result || !("value" in result)) throw new RpcError("getAccountInfo");
  if (result.value === null) return false;
  const info = object(result.value);
  const data = info?.data;
  if (!info || typeof info.owner !== "string" || !Array.isArray(data) || typeof data[0] !== "string") throw new RpcError("getAccountInfo");
  let length: number;
  try {
    length = getBase64Encoder().encode(data[0]).length;
  } catch {
    throw new RpcError("getAccountInfo");
  }
  return info.owner === MPL_CORE || length === 1;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, { fetch: (input, init) => fetch(input, init), now: () => Date.now() });
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await pruneNonces(env.DB, Math.floor(Date.now() / 1000));
  },
} satisfies ExportedHandler<Env>;
