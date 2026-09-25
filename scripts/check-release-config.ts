/**
 * Release gate: which program will this APK ask a wallet to approve?
 *
 *   npx tsx scripts/check-release-config.ts [--allow-cluster devnet]
 *   npm run release:check
 *
 * EXPO_PUBLIC_* values are inlined into the bundle and `.env*.local` files are gitignored, so an
 * unreviewed local file could silently decide the cluster or program of a signed release. This loads
 * the environment as `expo export:embed --dev false` does, resolves the cluster and program, prints
 * them and records them in `.expo/release/config.json`.
 *
 * Refuses when a `.env*.local` file exists, when the cluster is not mainnet-beta without
 * `--allow-cluster devnet`, when a mainnet build has no RPC override or names a public solana.com
 * endpoint, when no program is configured, or when Google's live attestation root list is not
 * exactly the roots this build pins (a network check, so not part of `npm test`). Never prints the
 * RPC URL, which can carry a provider key.
 *
 * `resolveCluster` is duplicated from `src/solana/cluster.ts`, which cannot load under plain Node.
 */

import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectEnv, setNodeEnv } from "@expo/env";

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
 * Every `.env*.local` file in the project directory, sorted. These are the files Expo loads at
 * highest precedence and `.gitignore` hides, so an unreviewed one can silently reach a release
 * build.
 */
function localEnvFiles(projectRoot: string): string[] {
  if (!existsSync(projectRoot)) return [];
  return readdirSync(projectRoot)
    .filter((name) => /^\.env(?:\..+)?\.local$/.test(name))
    .sort();
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
 * The refusal for a mainnet build's RPC endpoint, or `null` when it is allowed. Without
 * `EXPO_PUBLIC_SOLANA_RPC_URL` the app falls back to Solana's public mainnet endpoint, which
 * https://solana.com/docs/references/clusters says is "not intended for production applications";
 * naming a public solana.com host outright is the same thing. The value is never repeated: it can
 * carry a provider key.
 */
export function rpcRefusal(cluster: Cluster, raw: string | undefined): string | null {
  if (cluster !== "mainnet-beta") return null;
  const fix =
    `    Set EXPO_PUBLIC_SOLANA_RPC_URL to the HTTPS proxy of a dedicated RPC provider; Solana's public\n` +
    `    endpoints are "not intended for production applications" (https://solana.com/docs/references/clusters).`;
  if (raw === undefined || raw.trim() === "")
    return `EXPO_PUBLIC_SOLANA_RPC_URL is not set, so this mainnet build would use Solana's public endpoint.\n${fix}`;
  let host: string;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return `EXPO_PUBLIC_SOLANA_RPC_URL is not an https:// URL.\n${fix}`;
    host = url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return `EXPO_PUBLIC_SOLANA_RPC_URL is not a URL.\n${fix}`;
  }
  if (host === "solana.com" || host.endsWith(".solana.com"))
    return `EXPO_PUBLIC_SOLANA_RPC_URL points at a public solana.com endpoint.\n${fix}`;
  return null;
}

/**
 * The program `cluster` would publish against, or a refusal message.
 *
 * `configured` is `configuredProgram` from `publications/deployments.ts`, passed in so this
 * function stays free of the environment it reads.
 */
function resolveProgram(
  cluster: Cluster,
  configured: (cluster: Cluster) => { toString(): string },
): { program: string } | { refusal: string } {
  try {
    return { program: String(configured(cluster)) };
  } catch (error) {
    return {
      refusal:
        `no reviewed program is configured for "${cluster}": ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        `    publications/deployments.ts decides this. A signed APK that cannot publish is not a release.`,
    };
  }
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
  const locals = localEnvFiles(ROOT);
  if (locals.length > 0) {
    fail(
      `app/ holds ${locals.length} local environment file${locals.length === 1 ? "" : "s"}: ${locals.join(", ")}.\n` +
        `    Expo loads these at the highest precedence and .gitignore hides them, so what they configure\n` +
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

  // Imported only now: deployments.ts reads the EXPO_PUBLIC_EDITIONS_* overrides at module load.
  const { configuredProgram, pinnedImage } = await import("../publications/deployments");
  const resolved = resolveProgram(cluster, configuredProgram);
  if ("refusal" in resolved) fail(resolved.refusal);
  // Publishing refuses a program whose bytes and upgrade authority are not on record
  // (`publications/programImage.ts`), so a build without that record cannot publish at all.
  if (!pinnedImage(resolved.program, cluster))
    fail(
      `${resolved.program} has no PROGRAM_IMAGES record for "${cluster}" in publications/deployments.ts.\n` +
        `    Record its ELF digest, length and upgrade authority; without them every publish is refused.`,
    );

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
  console.log(`  EXPO_PUBLIC_SOLANA_RPC_URL  ${config.rpcUrlConfigured ? "set (value not printed)" : "not set"}`);
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
