import {
  createSolanaRpcSubscriptions,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import {
  createSolanaDevnet,
  createSolanaMainnet,
  type SolanaCluster,
  type SolanaClusterId,
} from "@wallet-ui/react-native-kit";
import { GENESIS_HASH } from "../../publications/core/genesisToken";
import { rpcWithTimeout, solanaRpc } from "../../publications/rpc";

/**
 * Build-time cluster and RPC config. Defaults to mainnet; EXPO_PUBLIC_SOLANA_CLUSTER=devnet for
 * devnet. Expo inlines EXPO_PUBLIC_* at build time, so restart Metro after changes.
 */

type ClusterName = "mainnet-beta" | "devnet";

function resolveCluster(raw: string | undefined): ClusterName {
  if (raw === undefined || raw === "" || raw === "mainnet-beta" || raw === "mainnet") {
    return "mainnet-beta";
  }
  if (raw === "devnet") return "devnet";
  // A typo must not send transactions somewhere unexpected.
  throw new Error(`EXPO_PUBLIC_SOLANA_CLUSTER is "${raw}"; expected "mainnet-beta" or "devnet"`);
}

export const CLUSTER_NAME: ClusterName = resolveCluster(process.env.EXPO_PUBLIC_SOLANA_CLUSTER);
export const IS_MAINNET = CLUSTER_NAME === "mainnet-beta";

/**
 * HTTPS RPC proxy. No provider-key variable: EXPO_PUBLIC_* ends up in the bundle, so credentials
 * live on the proxy. `npm run release:check` requires it for mainnet.
 */
function resolveRpcOverride(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  // https only: wallet addresses and signatures must not go in the clear.
  if (!/^https:\/\/[^\s]+$/.test(raw)) {
    throw new Error(`EXPO_PUBLIC_SOLANA_RPC_URL is "${raw}"; expected an https:// URL`);
  }
  return raw;
}

/**
 * Rate-limited and not for production (https://solana.com/docs/references/clusters). Used only by
 * non-mainnet builds for the Seeker lookups.
 */
const PUBLIC_MAINNET_ENDPOINT = "https://api.mainnet.solana.com";

const RPC_OVERRIDE = resolveRpcOverride(process.env.EXPO_PUBLIC_SOLANA_RPC_URL);
export const RPC_ENDPOINT: string =
  RPC_OVERRIDE ?? (IS_MAINNET ? PUBLIC_MAINNET_ENDPOINT : "https://api.devnet.solana.com");

/** Set by `npm run release:apk`, which checks for it in the bundle to catch stale Gradle output. */
export const BUILD_NONCE = process.env.EXPO_PUBLIC_BUILD_NONCE;

/** MWA chain ids differ from RPC cluster names; wallet-ui supplies them. */
export const CLUSTER: SolanaCluster = IS_MAINNET
  ? createSolanaMainnet({ url: RPC_ENDPOINT })
  : createSolanaDevnet({ url: RPC_ENDPOINT });

export const CHAIN: SolanaClusterId = CLUSTER.id;

let rpc: Rpc<SolanaRpcApi> | null = null;
let rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi> | null = null;

export function getRpc(): Rpc<SolanaRpcApi> {
  if (rpc === null) rpc = solanaRpc(RPC_ENDPOINT);
  return rpc;
}

let mainnetReadRpc: Rpc<SolanaRpcApi> | null = null;

export const MAINNET_READ_ENDPOINT: string = IS_MAINNET ? RPC_ENDPOINT : PUBLIC_MAINNET_ENDPOINT;

/**
 * Read-only mainnet client for SGT and `.skr`, which exist only on mainnet. Non-mainnet builds use
 * the public endpoint, not EXPO_PUBLIC_SOLANA_RPC_URL. Never used to sign, send or confirm.
 */
export function getMainnetReadRpc(): Rpc<SolanaRpcApi> {
  if (IS_MAINNET) return getRpc();
  if (mainnetReadRpc === null) mainnetReadRpc = solanaRpc(MAINNET_READ_ENDPOINT);
  return mainnetReadRpc;
}

function getRpcSubscriptions(): RpcSubscriptions<SolanaRpcSubscriptionsApi> {
  if (rpcSubscriptions === null) {
    rpcSubscriptions = createSolanaRpcSubscriptions(
      CLUSTER.urlWs ?? RPC_ENDPOINT.replace(/^http/, "ws"),
    );
  }
  return rpcSubscriptions;
}

/** Distinguishes misconfiguration from transient network errors. */
class ClusterMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClusterMismatchError";
  }
}

export function isClusterMismatch(error: unknown): error is Error {
  return error instanceof Error && error.name === "ClusterMismatchError";
}

let endpointCluster: Promise<void> | null = null;

/**
 * The wallet submits on `CHAIN` but reads go through `RPC_ENDPOINT`, whose proxy upstream can change
 * server-side. Success is memoized per process; failures are retried.
 */
export async function assertEndpointCluster(): Promise<void> {
  if (endpointCluster === null) {
    endpointCluster = checkEndpointCluster().catch((error: unknown) => {
      endpointCluster = null;
      throw error;
    });
  }
  return endpointCluster;
}

async function checkEndpointCluster(): Promise<void> {
  const expected = GENESIS_HASH[CLUSTER_NAME];
  const actual = await rpcWithTimeout(abortSignal => getRpc().getGenesisHash().send({ abortSignal }));
  if (actual !== expected) {
    // Don't include the endpoint URL: it may carry a credential and this is shown to the user.
    throw new ClusterMismatchError(
      `This build publishes on ${CLUSTER_NAME}, but its Solana connection is a different ` +
        `network (genesis ${actual}, expected ${expected}). Check the app's RPC configuration.`,
    );
  }
}

export function createAppClient(): {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
} {
  return { rpc: getRpc(), rpcSubscriptions: getRpcSubscriptions() };
}
