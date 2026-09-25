import {
  createSolanaRpc,
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
import { rpcWithTimeout } from "../../publications/rpc";

/**
 * Build-time cluster and RPC configuration shared by the wallet provider and publication code.
 * Defaults to mainnet; set EXPO_PUBLIC_SOLANA_CLUSTER=devnet for a devnet build.
 * Expo inlines public environment variables, so restart Metro after configuration changes.
 */

type ClusterName = "mainnet-beta" | "devnet";

function resolveCluster(raw: string | undefined): ClusterName {
  if (raw === undefined || raw === "" || raw === "mainnet-beta" || raw === "mainnet") {
    return "mainnet-beta";
  }
  if (raw === "devnet") return "devnet";
  // Refusing beats guessing: a typo must not send transactions somewhere unexpected.
  throw new Error(`EXPO_PUBLIC_SOLANA_CLUSTER is "${raw}"; expected "mainnet-beta" or "devnet"`);
}

export const CLUSTER_NAME: ClusterName = resolveCluster(process.env.EXPO_PUBLIC_SOLANA_CLUSTER);
export const IS_MAINNET = CLUSTER_NAME === "mainnet-beta";

/**
 * Optional HTTPS RPC proxy; public Solana endpoints are the fallback. There is no provider-key
 * variable: Metro inlines EXPO_PUBLIC_* values into the bundle, so credentials belong on the proxy.
 */
function resolveRpcOverride(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  // `https:` only. An `http:` endpoint would carry a wallet address and every signature this app
  // asks about in the clear, and Android blocks cleartext for this app anyway.
  if (!/^https:\/\/[^\s]+$/.test(raw)) {
    throw new Error(`EXPO_PUBLIC_SOLANA_RPC_URL is "${raw}"; expected an https:// URL`);
  }
  return raw;
}

/** Solana's public mainnet endpoint: rate-limited per IP (https://solana.com/docs/references/clusters). */
const PUBLIC_MAINNET_ENDPOINT = "https://api.mainnet-beta.solana.com";

const RPC_OVERRIDE = resolveRpcOverride(process.env.EXPO_PUBLIC_SOLANA_RPC_URL);
export const RPC_ENDPOINT: string =
  RPC_OVERRIDE ?? (IS_MAINNET ? PUBLIC_MAINNET_ENDPOINT : "https://api.devnet.solana.com");

/** Wallet UI supplies the MWA chain id, which differs from the RPC cluster spelling. */
export const CLUSTER: SolanaCluster = IS_MAINNET
  ? createSolanaMainnet({ url: RPC_ENDPOINT })
  : createSolanaDevnet({ url: RPC_ENDPOINT });

export const CHAIN: SolanaClusterId = CLUSTER.id;

let rpc: Rpc<SolanaRpcApi> | null = null;
let rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi> | null = null;

/** Shared lazy Kit RPC client. Requests execute when their .send() method is called. */
export function getRpc(): Rpc<SolanaRpcApi> {
  if (rpc === null) rpc = createSolanaRpc(RPC_ENDPOINT);
  return rpc;
}

let mainnetReadRpc: Rpc<SolanaRpcApi> | null = null;

/** The endpoint `getMainnetReadRpc` reads, for the raw JSON-RPC reader (`verifyGenesisToken`). */
export const MAINNET_READ_ENDPOINT: string = IS_MAINNET ? RPC_ENDPOINT : PUBLIC_MAINNET_ENDPOINT;

/**
 * Read-only mainnet client for the Seeker facts (SGT, `.skr`), which exist on mainnet only. A
 * mainnet build reuses the app client, so its proxy still applies; any other build reads the public
 * mainnet endpoint, never `EXPO_PUBLIC_SOLANA_RPC_URL`, which points at that build's own cluster.
 * Display only: nothing signs, sends or confirms through this client, and `CHAIN` is unaffected.
 */
export function getMainnetReadRpc(): Rpc<SolanaRpcApi> {
  if (IS_MAINNET) return getRpc();
  if (mainnetReadRpc === null) mainnetReadRpc = createSolanaRpc(MAINNET_READ_ENDPOINT);
  return mainnetReadRpc;
}

/** WebSocket subscriptions; created lazily and nothing opens a socket until it is used. */
function getRpcSubscriptions(): RpcSubscriptions<SolanaRpcSubscriptionsApi> {
  if (rpcSubscriptions === null) {
    rpcSubscriptions = createSolanaRpcSubscriptions(
      CLUSTER.urlWs ?? RPC_ENDPOINT.replace(/^http/, "ws"),
    );
  }
  return rpcSubscriptions;
}

/**
 * Each cluster's genesis hash, the one value that says which chain an endpoint is really on. Read
 * with `getGenesisHash` from the public endpoints, since the Solana docs do not publish them.
 */
const GENESIS_HASH: Record<ClusterName, string> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

/** Named so a screen can tell a configuration error from "the network is having a moment". */
class ClusterMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClusterMismatchError";
  }
}

/** True for the error `assertEndpointCluster` throws when the endpoint is on the wrong chain. */
export function isClusterMismatch(error: unknown): error is Error {
  return error instanceof Error && error.name === "ClusterMismatchError";
}

let endpointCluster: Promise<void> | null = null;

/**
 * Refuse an RPC endpoint on a different chain from `CHAIN`. The wallet submits on `CHAIN`, but
 * every estimate, confirmation and status read uses `RPC_ENDPOINT`, whose proxy upstream can change
 * server-side. Memoized per process; a failure is not, so a cold-start network error is retried.
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
    // The endpoint URL may carry a provider credential and this message is shown to the user.
    throw new ClusterMismatchError(
      `This build publishes on ${CLUSTER_NAME}, but its Solana connection is a different ` +
        `network (genesis ${actual}, expected ${expected}). Check the app's RPC configuration.`,
    );
  }
}

/** Supplies the shared clients to MobileWalletProvider. */
export function createAppClient(): {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
} {
  return { rpc: getRpc(), rpcSubscriptions: getRpcSubscriptions() };
}
