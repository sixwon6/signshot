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
 * `--allow-cluster devnet`, or when no program is configured. Never prints the RPC URL, which can
 * carry a provider key.
 *
 * `resolveCluster` is duplicated from `src/solana/cluster.ts`, which cannot load under plain Node.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectEnv, setNodeEnv } from "@expo/env";

import type { Cluster } from "../publications/types";

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

  // Imported only now: deployments.ts reads the EXPO_PUBLIC_EDITIONS_* overrides at module load.
  const { configuredProgram } = await import("../publications/deployments");
  const resolved = resolveProgram(cluster, configuredProgram);
  if ("refusal" in resolved) fail(resolved.refusal);

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
