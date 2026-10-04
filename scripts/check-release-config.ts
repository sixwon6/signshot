/**
 * Release gate: which program will this APK ask a wallet to approve?
 *
 *   npx tsx scripts/check-release-config.ts [--allow-cluster devnet]
 *   npm run release:check
 *
 * EXPO_PUBLIC_* values are inlined into the bundle and every `.env*` file is gitignored, so an
 * unreviewed local file could silently decide the cluster or program of a signed release. This loads
 * the environment as `expo export:embed --dev false` does, resolves the cluster and program, prints
 * them and records them in `.expo/release/config.json`.
 *
 * Refuses when an env file a production bundle would load exists, when the cluster is not
 * mainnet-beta without `--allow-cluster devnet`, when a mainnet build has no RPC override or names a
 * public solana.com endpoint, when the RPC URL carries a query string or credentials, when no
 * program is configured, and, with network checks that are not part of `npm test`, when the RPC
 * endpoint is on another network or Google's live attestation root list is not exactly the roots
 * this build pins. Never prints the RPC URL: a path can still carry a provider key.
 *
 * `resolveCluster` is duplicated from `src/solana/cluster.ts`, which cannot load under plain Node.
 */

import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectEnv, setNodeEnv } from "@expo/env";

import { GENESIS_HASH } from "../publications/core/genesisToken";
import type { Cluster } from "../publications/types";
import { GOOGLE_ATTESTATION_ROOT_KEYS } from "../src/seeker/keyAttestation";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORD = resolve(ROOT, ".expo", "release", "config.json");

/** The build record written beside the APK. Values only — never a secret, never an endpoint. */
interface ReleaseConfig {
  cluster: Cluster;
  program: string;
  /** Whether an RPC override is configured, never the endpoint itself. */
  rpcUrlConfigured: boolean;
  commit: string;
  timestamp: string;
}

/**
 * Mirrors `src/solana/cluster.ts`'s `resolveCluster`: unset means mainnet, and anything that is
 * not one of the two spellings is refused rather than guessed.
 */
export function resolveCluster(raw: string | undefined): Cluster {
  if (raw === undefined || raw === "" || raw === "mainnet-beta" || raw === "mainnet") return "mainnet-beta";
  if (raw === "devnet") return "devnet";
  throw new Error(`EXPO_PUBLIC_SOLANA_CLUSTER is "${raw}"; expected "mainnet-beta" or "devnet"`);
}

/**
 * Of `names`, the env files a release refuses, sorted: the four a production bundle loads (`.env`,
 * `.env.local`, `.env.production`, `.env.production.local`, per `@expo/env`'s `getFiles`) and any
 * other `.env*.local`. `.gitignore` hides them all, so an unreviewed one can silently reach a
 * release build; the values come from the command line instead. `scripts/release-artifact.mjs`
 * refuses the same names again right before Gradle bundles.
 */
export function refusedEnvFiles(names: readonly string[]): string[] {
  return names.filter((name) => /^\.env(?:\.production)?$|^\.env(?:\..+)?\.local$/.test(name)).sort();
}

function envFiles(projectRoot: string): string[] {
  return existsSync(projectRoot) ? refusedEnvFiles(readdirSync(projectRoot)) : [];
}

/** `--allow-cluster devnet`, and nothing else. */
function parseArgs(argv: readonly string[]): { allowCluster?: Cluster } {
  const out: { allowCluster?: Cluster } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--allow-cluster") {
      const value = argv[i + 1];
      i += 1;
      if (value !== "devnet") {
        throw new Error(
          `--allow-cluster takes "devnet" and nothing else (got ${value === undefined ? "no value" : `"${value}"`}). ` +
            "A mainnet release needs no flag; every other network is not a release.",
        );
      }
      out.allowCluster = value;
    } else if (arg.startsWith("--allow-cluster=")) {
      const value = arg.slice("--allow-cluster=".length);
      if (value !== "devnet") throw new Error(`--allow-cluster takes "devnet" and nothing else (got "${value}").`);
      out.allowCluster = value;
    } else {
      throw new Error(`unknown argument "${arg}". Usage: check-release-config.ts [--allow-cluster devnet]`);
    }
  }
  return out;
}

/** The refusal for a non-mainnet build without the explicit flag, or `null` when it is allowed. */
function clusterRefusal(cluster: Cluster, allowCluster: Cluster | undefined): string | null {
  if (cluster === "mainnet-beta" || cluster === allowCluster) return null;
  return (
    `the resolved cluster is "${cluster}", not "mainnet-beta".\n` +
    `    A store artifact built against a test network is indistinguishable from a real one once it is\n` +
    `    signed. If that is what you mean, say so: npm run release:apk -- --allow-cluster ${cluster}`
  );
}

/**
 * The refusal for a build's RPC endpoint, or `null` when it is allowed. Without
 * `EXPO_PUBLIC_SOLANA_RPC_URL` a mainnet build falls back to Solana's public mainnet endpoint, which
 * https://solana.com/docs/references/clusters says is "not intended for production applications";
 * naming a public solana.com host outright is the same thing. On any cluster the URL must be https
 * and key-free: Expo inlines EXPO_PUBLIC_* values into the bundle in plain text
 * (https://docs.expo.dev/guides/environment-variables/), so a query string or credentials in it
 * would ship with every APK. The value is never repeated: a path can still carry a key.
 */
export function rpcRefusal(cluster: Cluster, raw: string | undefined): string | null {
  const fix =
    `    Set EXPO_PUBLIC_SOLANA_RPC_URL to the key-free HTTPS proxy of a dedicated RPC provider; Solana's public\n` +
    `    endpoints are "not intended for production applications" (https://solana.com/docs/references/clusters).`;
  if (raw === undefined || raw.trim() === "")
    return cluster === "mainnet-beta"
      ? `EXPO_PUBLIC_SOLANA_RPC_URL is not set, so this mainnet build would use Solana's public endpoint.\n${fix}`
      : null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `EXPO_PUBLIC_SOLANA_RPC_URL is not a URL.\n${fix}`;
  }
  if (url.protocol !== "https:") return `EXPO_PUBLIC_SOLANA_RPC_URL is not an https:// URL.\n${fix}`;
  if (url.username || url.password || url.search)
    return (
      `EXPO_PUBLIC_SOLANA_RPC_URL carries credentials or a query string, which the APK would publish.\n` +
      `    Expo bundles EXPO_PUBLIC_* values in plain text (https://docs.expo.dev/guides/environment-variables/):\n` +
      `    use a keyless proxy or the provider's key-free URL.`
    );
  if (cluster !== "mainnet-beta") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "solana.com" || host.endsWith(".solana.com"))
    return `EXPO_PUBLIC_SOLANA_RPC_URL points at a public solana.com endpoint.\n${fix}`;
  return null;
}

/**
 * The refusal for an RPC endpoint on another network than `cluster`, or `null`. The app refuses
 * one at runtime (`assertEndpointCluster` in `src/solana/cluster.ts`), which would stop every
 * operation of a shipped build; this asks `getGenesisHash` before building instead. Nothing `fetch`
 * or the endpoint says is repeated but a status and a hash: an error can quote the URL.
 */
export async function genesisRefusal(cluster: Cluster, raw: string | undefined): Promise<string | null> {
  if (raw === undefined || raw.trim() === "") return null;
  const expected = GENESIS_HASH[cluster];
  let hash: unknown;
  try {
    const response = await fetch(raw, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return `EXPO_PUBLIC_SOLANA_RPC_URL answered getGenesisHash with HTTP ${response.status}.`;
    hash = (await response.json() as { result?: unknown } | null)?.result;
  } catch {
    return `EXPO_PUBLIC_SOLANA_RPC_URL did not answer getGenesisHash; run the check again with a network.`;
  }
  if (hash === expected) return null;
  const said = typeof hash === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash) ? hash : "none";
  return `EXPO_PUBLIC_SOLANA_RPC_URL is not on ${cluster} (genesis ${said}, expected ${expected}).`;
}

/** Google's published set of valid attestation roots, a JSON array of PEM certificates. */
const ATTESTATION_ROOT_LIST = "https://android.googleapis.com/attestation/root";

/**
 * The pinned roots (`GOOGLE_ATTESTATION_ROOT_KEYS`, asserted equal to `scripts/attestation-roots.pem`
 * by `npm test`) against Google's live list, by SHA-256 of each root's SubjectPublicKeyInfo. A root
 * Google added means new devices' chains would read "does not end at a Google attestation root" in
 * this build; one Google withdrew means this build still vouches for chains Google no longer does.
 * Either is a reviewed change to the pin and the PEM, never something a release ships past.
 * `null` when they match.
 */
export async function attestationRootsRefusal(): Promise<string | null> {
  let pems: unknown;
  try {
    const response = await fetch(ATTESTATION_ROOT_LIST);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    pems = await response.json();
  } catch (error) {
    return `could not read Google's attestation root list at ${ATTESTATION_ROOT_LIST} (${error instanceof Error ? error.message : String(error)}).\n` +
      `    The release check compares the pinned roots with it; run it again with a network.`;
  }
  if (!Array.isArray(pems) || pems.length === 0 || !pems.every((pem) => typeof pem === "string"))
    return `${ATTESTATION_ROOT_LIST} is no longer a JSON array of PEM certificates; review the format before releasing.`;
  const live = new Map<string, string>();
  for (const pem of pems as string[]) {
    const cert = new X509Certificate(pem);
    const spki = createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    live.set(spki, cert.subject.replace(/\n/g, ", "));
  }
  const pinned = new Set(GOOGLE_ATTESTATION_ROOT_KEYS);
  const added = [...live].filter(([spki]) => !pinned.has(spki));
  const removed = [...pinned].filter((spki) => !live.has(spki));
  if (!added.length && !removed.length) return null;
  return (
    `Google's attestation root list differs from the roots this build pins.\n` +
    added.map(([spki, subject]) => `    NEW root at Google, not pinned: ${subject} (SPKI SHA-256 ${spki})\n`).join("") +
    removed.map((spki) => `    pinned root no longer at Google: SPKI SHA-256 ${spki}\n`).join("") +
    `    Copy the roots from https://developer.android.com/privacy-and-security/security-key-attestation\n` +
    `    into scripts/attestation-roots.pem, update GOOGLE_ATTESTATION_ROOT_KEYS in\n` +
    `    src/seeker/keyAttestation.ts, and run npm test (check-attestation asserts the two agree).`
  );
}

/** `git rev-parse HEAD`, or `"unknown"` outside a checkout. */
function headCommit(cwd: string): string {
  try {
    // stderr is discarded: outside a checkout git's own complaint is noise, not a result.
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/** Write the build record. Returns the path so the caller can name it. */
function writeRecord(file: string, config: ReleaseConfig): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return file;
}

async function main(argv: readonly string[]): Promise<void> {
  const { allowCluster } = parseArgs(argv);

  // BEFORE loading anything. An unreviewed file must be refused, not read.
  const files = envFiles(ROOT);
  if (files.length > 0) {
    fail(
      `the project root holds ${files.length} environment file${files.length === 1 ? "" : "s"}: ${files.join(", ")}.\n` +
        `    Expo loads these into a production bundle and .gitignore hides them, so what they configure\n` +
        `    never reaches a diff or a review — and what they configure is which program the user's wallet\n` +
        `    approves. Move or delete them for the release build and set the values on the command line if\n` +
        `    they are needed.`,
    );
  }

  // Exactly what `expo export:embed --dev false` does before it bundles.
  setNodeEnv("production");
  loadProjectEnv(ROOT, { force: true });

  const cluster = resolveCluster(process.env.EXPO_PUBLIC_SOLANA_CLUSTER);
  const refusal = clusterRefusal(cluster, allowCluster);
  if (refusal) fail(refusal);
  const rpc = rpcRefusal(cluster, process.env.EXPO_PUBLIC_SOLANA_RPC_URL);
  if (rpc) fail(rpc);
  const network = await genesisRefusal(cluster, process.env.EXPO_PUBLIC_SOLANA_RPC_URL);
  if (network) fail(network);
  // The devnet funding tool (`src/dev/DevnetFunding.tsx`) is compiled in when these are set.
  for (const name of ["EXPO_PUBLIC_DEVNET_TEST_PAYER", "EXPO_PUBLIC_DEVNET_TEST_LAMPORTS"])
    if (cluster !== "devnet" && process.env[name])
      fail(`${name} is set on a ${cluster} build; it belongs to a devnet test session only.`);

  // No program of this app's own: editions are Metaplex's Core Candy Machine, the same address on
  // every cluster. A Seeker-only edition needs the co-signer, an HTTPS URL when set.
  const { CANDY_MACHINE_PROGRAM } = await import("../publications/candy/programs");
  const resolved = { program: String(CANDY_MACHINE_PROGRAM) };
  const cosigner = process.env.EXPO_PUBLIC_SEEKER_COSIGNER_URL;
  if (cosigner && !cosigner.trim().startsWith("https://")) fail("EXPO_PUBLIC_SEEKER_COSIGNER_URL must be an https:// URL.");

  const roots = await attestationRootsRefusal();
  if (roots) fail(roots);

  const config: ReleaseConfig = {
    cluster,
    program: resolved.program,
    rpcUrlConfigured: Boolean(process.env.EXPO_PUBLIC_SOLANA_RPC_URL),
    commit: headCommit(ROOT),
    timestamp: new Date().toISOString(),
  };
  const file = writeRecord(RECORD, config);

  console.log("release config ok");
  console.log(`  cluster                  ${config.cluster}${cluster === "mainnet-beta" ? "" : "  (explicitly allowed)"}`);
  console.log(`  program                  ${config.program}`);
  console.log(`  EXPO_PUBLIC_SOLANA_RPC_URL  ${config.rpcUrlConfigured ? `set (value not printed), on ${config.cluster}` : "not set"}`);
  console.log(`  attestation roots        the ${GOOGLE_ATTESTATION_ROOT_KEYS.length} pinned roots are exactly Google's live list`);
  console.log(`  commit                   ${config.commit}`);
  console.log(`  record                   ${file}`);
  console.log("\nRecord the cluster and program with the APK's SHA-256 in the release notes.");
}

function fail(message: string): never {
  console.error(`\nrelease config check FAILED:\n\n  - ${message}\n`);
  process.exit(1);
}

const invokedDirectly =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`release config check FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
