/**
 * `npm run mainnet -- <step> [options]`: one step of the `era_editions` deploy, then exit.
 *
 *   prepare                       make the keys once; build the ELF with the program key's address
 *   svm                           run test:svm on that ELF; quote and deploy need it passed
 *   quote                         live rent and fees; the exact lamports to send the deployer
 *   deploy [--minutes 8]          upload and deploy; stops between sends, run again to continue
 *   verify                        ProgramData against the prepared ELF, and the upgrade authority
 *   vault --multisig <address>    hold the Squads multisig to the plan and derive its vault
 *   authority --to <vault>        hand the upgrade authority to that vault
 *             --to <w> --wallet <w>   (devnet rehearsal) to a wallet, the address typed twice
 *   refund --to <address>         send what the deployer holds, less the fee
 *   close-buffer                  close an unfinished upload's buffer back to the deployer
 *   record --reviewed-by <names>  write the deployment record; print the deployments.ts lines
 *   forget                        delete the keys once authority and refund are confirmed
 *   status                        where it stands (reads only the state file)
 *
 * `--cluster devnet` rehearses on devnet; mainnet is the default. The endpoint is
 * SIGNSHOT_DEPLOY_RPC_URL (the public endpoint only on devnet), and it is never printed.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cluster } from "../types";
import { assertKeyRoot, keyRoot } from "./state";
import * as steps from "./steps";

const PUBLIC_DEVNET = "https://api.devnet.solana.com";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const [step, ...rest] = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i].startsWith("--") || rest[i + 1] === undefined || rest[i + 1].startsWith("--"))
    fail(`Expected --option value pairs, got ${rest.slice(i).join(" ")}`);
  options.set(rest[i].slice(2), rest[i + 1]);
}
const allowed: Record<string, string[]> = {
  prepare: [], svm: [], quote: [], deploy: ["minutes"], verify: [], vault: ["multisig"],
  authority: ["to", "wallet"], refund: ["to"], "close-buffer": [], record: ["reviewed-by"],
  forget: [], status: [],
};
if (!step || !(step in allowed)) fail(`Steps: ${Object.keys(allowed).join(", ")}`);
for (const name of options.keys())
  if (name !== "cluster" && !allowed[step].includes(name)) fail(`${step} takes no --${name}`);

const clusterName = options.get("cluster") ?? "mainnet-beta";
const cluster: Cluster = clusterName === "mainnet" ? "mainnet-beta" : (clusterName as Cluster);
if (cluster !== "mainnet-beta" && cluster !== "devnet") fail("--cluster is mainnet-beta or devnet");

const endpoint = process.env.SIGNSHOT_DEPLOY_RPC_URL?.trim() || (cluster === "devnet" ? PUBLIC_DEVNET : undefined);
if (endpoint && !/^https:\/\//.test(endpoint)) fail("SIGNSHOT_DEPLOY_RPC_URL must be an https URL");

/** Prints `message`, the endpoint cut out, and exits. Only the environment's endpoint can carry a key. */
function fail(message: string): never {
  console.error(steps.scrub(message, process.env.SIGNSHOT_DEPLOY_RPC_URL?.trim()));
  process.exit(1);
}

let root = "";
try {
  root = keyRoot(cluster);
  assertKeyRoot(root, repoRoot);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const minutes = Number(options.get("minutes") ?? 8);
if (!(minutes > 0)) fail("--minutes is a positive number");

const deps: steps.Deps = {
  cluster,
  root,
  repoRoot,
  endpoint,
  log: (line) => console.log(line),
  now: () => new Date(),
  build: (script, program, outputRoot) =>
    new Promise((accept, reject) => {
      const child = spawn("pwsh", ["-NoProfile", "-File", script, "-ProgramAddress", program, "-OutputRoot", outputRoot],
        { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? accept() : reject(new Error(`${script} exited ${code}; no build accepted`))));
    }),
  svm: (args) =>
    new Promise((accept, reject) => {
      const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
      if (!existsSync(tsx)) return reject(new Error("tsx is not installed; run npm install"));
      const child = spawn(process.execPath, [tsx, join(repoRoot, "scripts", "check-program-svm.ts"), ...args],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));
      child.once("error", reject);
      child.once("exit", (code) => accept({ code, output }));
    }),
  git: (args) => {
    const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  },
  deadline: Date.now() + minutes * 60_000,
  pauseMs: endpoint === PUBLIC_DEVNET ? 1500 : 0,
};

const need = (name: string) => options.get(name) ?? fail(`${step} needs --${name}`);

try {
  switch (step) {
    case "prepare": await steps.prepare(deps); break;
    case "svm": await steps.svm(deps); break;
    case "quote": await steps.quoteStep(deps); break;
    case "deploy": await steps.deploy(deps); break;
    case "verify": await steps.verify(deps); break;
    case "vault": await steps.vault(deps, need("multisig")); break;
    case "authority": await steps.authority(deps, need("to"), options.get("wallet")); break;
    case "refund": await steps.refund(deps, need("to")); break;
    case "close-buffer": await steps.closeBuffer(deps); break;
    case "record": await steps.record(deps, need("reviewed-by").split(",")); break;
    case "forget": await steps.forget(deps); break;
    case "status": steps.status(deps); break;
  }
} catch (error) {
  const text = error instanceof Error
    ? [error.message, error.cause instanceof Error ? error.cause.message : ""].filter(Boolean).join(": ")
    : String(error);
  fail(text);
}
// Nothing may keep the process, or a key, alive after the step.
process.exit(0);
