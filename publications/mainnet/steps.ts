/**
 * The mainnet deploy of `era_editions` as short steps. Each reads the state file, does one thing,
 * saves and exits, so no key is held by a long-lived process and every step can be run again:
 *
 *   prepare → svm → quote → (fund the deployer) → deploy … → verify → vault → authority → verify
 *   → refund → record → forget
 *
 * `--cluster devnet` is the same flow on devnet, as a rehearsal. Every step but `status` first
 * checks the endpoint's genesis hash against the cluster's. A re-run reads the chain and never
 * assumes an earlier send failed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  isOffCurveAddress,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  LOADER_V3_PROGRAM_ADDRESS as LOADER,
  getCloseInstruction,
  getSetAuthorityInstruction,
} from "@solana-program/loader-v3";
import { request } from "../rpc";
import { checkAttempt } from "../lifecycle";
import { GENESIS_HASH } from "../core/genesisToken";
import { programFeatures } from "../deployments";
import { assertProgramImage } from "../programImage";
import {
  BUFFER_HEADER,
  PROGRAM_ACCOUNT_BYTES,
  PROGRAM_DATA_HEADER,
  deployInstructions,
  operationId,
  programDataAddress,
  retryRateLimited,
  sendJournalled,
  uploadAndDeploy,
  verifyDeployed,
  type Sender,
} from "../deploy/loaderV3";
import type { Cluster } from "../types";
import { COMPUTE_UNITS, budget, lamportsText, quote, rentSizes } from "./quote";
import { deploymentsLines, schemaErrors, type DeploymentRecord } from "./record";
import { planMismatches, vaultAddress, type MultisigPlan } from "./squads";
import { createKeys, deleteKeys, loadKeys, readState, saveState, type DeployState } from "./state";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export interface Deps {
  cluster: Cluster;
  /** The key and state folder. */
  root: string;
  repoRoot: string;
  /** The RPC endpoint. It may carry a provider key: never printed, never saved. */
  endpoint?: string;
  log(line: string): void;
  now(): Date;
  /** Runs a `prepare-*-windows.ps1`; resolves once it exited 0. */
  build(script: string, program: string, outputRoot: string): Promise<void>;
  /** Runs `test:svm` with `args`: its exit code and everything it printed. */
  svm(args: string[]): Promise<{ code: number | null; output: string }>;
  /** A git command's trimmed output, or null when it failed. */
  git(args: string[]): string | null;
  /** `deploy` stops between sends after this time (ms since epoch). */
  deadline?: number;
  /** Pause after each write, for the public devnet endpoint's rate limit. */
  pauseMs: number;
}

/** `text` with the endpoint, and every part of it that could be a provider key, cut out. */
export function scrub(text: string, endpoint?: string): string {
  if (!endpoint) return text;
  const forms = [endpoint, encodeURI(endpoint)];
  try {
    const url = new URL(endpoint);
    forms.push(url.search, url.pathname, url.username, url.password,
      ...url.searchParams.values(), ...url.pathname.split("/"));
  } catch {
    // Not a URL: the whole string is all there is to cut.
  }
  let out = text;
  for (const form of forms.filter((f) => f.length >= 6).sort((a, b) => b.length - a.length))
    out = out.split(form).join("<rpc>");
  return out;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const flag = (d: Deps) => (d.cluster === "devnet" ? " --cluster devnet" : "");
const run = (d: Deps, step: string) => `npm run mainnet -- ${step}${flag(d)}`;
const sourcePath = (d: Deps) => join(d.repoRoot, "programs", "editions", "src", "lib.rs");
const inside = (parent: string, child: string) => {
  const path = relative(resolve(parent), resolve(child));
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
};

function need(d: Deps): DeployState {
  const state = readState(d.root);
  if (!state) throw new Error(`No deploy state in ${d.root}; start with ${run(d, "prepare")}`);
  if (state.cluster !== d.cluster) throw new Error(`${d.root} holds a ${state.cluster} deploy, not ${d.cluster}`);
  return state;
}

function prepared(state: DeployState) {
  if (!state.prepared) throw new Error("Run prepare first");
  return state.prepared;
}

function svmPassed(state: DeployState) {
  const p = prepared(state);
  if (!state.svm?.passed || state.svm.sha256 !== p.sha256)
    throw new Error("Run svm first: only a build that passed test:svm is quoted or deployed");
  return p;
}

async function guard(d: Deps) {
  if (!d.endpoint)
    throw new Error(`Set SIGNSHOT_DEPLOY_RPC_URL to a ${d.cluster} endpoint`);
  const hash = await request<string>(d.endpoint, "getGenesisHash", []);
  if (hash !== GENESIS_HASH[d.cluster])
    throw new Error(`The endpoint is not ${d.cluster}: its genesis hash is ${hash}`);
}

async function account(d: Deps, key: string) {
  const { value } = await request<any>(d.endpoint!, "getAccountInfo", [
    key,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  return value
    ? { owner: value.owner as string, executable: value.executable as boolean,
        lamports: value.lamports as number, data: Buffer.from(value.data[0], "base64") }
    : null;
}

async function balance(d: Deps, key: string): Promise<number> {
  const { value } = await request<{ value: number }>(d.endpoint!, "getBalance", [
    key,
    { commitment: "confirmed" },
  ]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid balance");
  return value;
}

async function rentFor(d: Deps, size: number): Promise<number> {
  const lamports = await request<number>(d.endpoint!, "getMinimumBalanceForRentExemption", [size]);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new Error("Invalid rent");
  return lamports;
}

/** The program account and its ProgramData, as the loader holds them now. */
async function readProgram(d: Deps, state: DeployState) {
  const programData = await programDataAddress(state.program);
  const program = await account(d, state.program);
  if (
    !program || program.owner !== LOADER || !program.executable || program.data.length !== 36 ||
    program.data.readUInt32LE(0) !== 2 ||
    !program.data.subarray(4).equals(Buffer.from(getAddressEncoder().encode(programData)))
  )
    throw new Error(`${state.program} is not a deployed loader-v3 program pointing at ${programData}`);
  const data = await account(d, programData);
  if (!data || data.owner !== LOADER || data.data.length < PROGRAM_DATA_HEADER ||
      data.data.readUInt32LE(0) !== 3 || data.data[12] > 1)
    throw new Error(`${programData} is not the program's ProgramData`);
  return {
    programData,
    slot: data.data.readBigUInt64LE(4),
    authority: data.data[12] === 1
      ? getAddressDecoder().decode(data.data.subarray(13, PROGRAM_DATA_HEADER)) as string
      : null,
    bytes: data.data.length - PROGRAM_DATA_HEADER,
    sha256: sha256(data.data.subarray(PROGRAM_DATA_HEADER)),
  };
}

/** The deployed tail must be the prepared ELF exactly: space 45 + its length, and its SHA-256. */
function assertImage(state: DeployState, read: { bytes: number; sha256: string }) {
  const p = prepared(state);
  if (read.bytes !== p.bytes)
    throw new Error(`ProgramData space is 45 + ${read.bytes}, not 45 + ${p.bytes}`);
  if (read.sha256 !== p.sha256)
    throw new Error(`The ProgramData tail hashes to ${read.sha256}, not the prepared ${p.sha256}`);
}

/**
 * The signature of `instructions` when they landed, from the journal entry saved before they were
 * sent: a re-run after a lost response knows the transaction happened but not its signature.
 */
async function landed(d: Deps, state: DeployState, instructions: Instruction[]): Promise<string | undefined> {
  const entry = state.journal[operationId(state.deployer, instructions)];
  if (!entry?.signature) return undefined;
  if (!entry.confirmed && (await checkAttempt(d.endpoint!, entry)) !== "confirmed") return undefined;
  entry.confirmed = true;
  return entry.signature;
}

function sender(d: Deps, state: DeployState, payer: KeyPairSigner): Sender {
  return {
    endpoint: d.endpoint!,
    payer,
    journal: state.journal,
    guard: () => guard(d),
    save: () => saveState(d.root, state),
  };
}

const SVM_PASSED = /program SVM suite passed\.\s*$/;
export const svmArgs = (cluster: Cluster, elf: string, program: string) =>
  cluster === "mainnet-beta"
    ? ["--plain", elf, "--plain-id", program]
    : ["--devnet", elf, "--devnet-id", program];

/** Makes the keys once, then builds the ELF with the program key's address into a fresh folder. */
export async function prepare(d: Deps) {
  let state = readState(d.root);
  if (state?.deploy?.initialized)
    throw new Error("The upload has started: the prepared build is the one being deployed");
  await guard(d);
  const commit = d.git(["rev-parse", "HEAD"]);
  const changes = d.git(["status", "--porcelain", "--", "programs/editions"]);
  const sourceClean = changes === "";
  if (d.cluster === "mainnet-beta" && (!commit || !sourceClean))
    throw new Error("programs/editions has uncommitted changes (or git is unavailable): build mainnet from a commit");
  if (!sourceClean) d.log("Note: programs/editions has uncommitted changes; this rehearsal build is not a commit.");
  state ??= await createKeys(d.root, d.cluster, d.now());
  if (state.cluster !== d.cluster) throw new Error(`${d.root} holds a ${state.cluster} deploy`);
  d.log(`Deployer ${state.deployer}\nProgram  ${state.program}\nBuffer   ${state.buffer}`);
  let n = 1;
  while (existsSync(join(d.root, `elf-${n}`))) n++;
  const outputRoot = join(d.root, `elf-${n}`);
  const script = join(d.repoRoot, "programs", "editions", "scripts",
    d.cluster === "mainnet-beta" ? "prepare-mainnet-windows.ps1" : "prepare-devnet-windows.ps1");
  await d.build(script, state.program, outputRoot);
  const built = readPrepared(outputRoot, d.cluster, state.program, sourcePath(d));
  state.prepared = { outputRoot, ...built, commit, sourceClean, at: d.now().toISOString() };
  delete state.svm;
  delete state.quote;
  saveState(d.root, state);
  d.log(`ELF ${built.bytes} bytes, SHA-256 ${built.sha256}\n  ${built.elf}`);
  if (n > 1) d.log(`Earlier builds in ${d.root}\\elf-1 … elf-${n - 1} are no longer used.`);
  d.log(`Next: ${run(d, "svm")}, which runs\n  npm run test:svm -- ${svmArgs(d.cluster, built.elf, state.program).join(" ")}`);
}

/**
 * The build a `prepare-*-windows.ps1` left in `outputRoot`, held to its `prepared.json`: the ELF
 * inside the folder hashing to the recorded digest, built from a copy of `source` whose only
 * change is `declare_id!` naming `program`.
 */
export function readPrepared(outputRoot: string, cluster: Cluster, program: string, source: string) {
  const manifest = JSON.parse(readFileSync(join(outputRoot, "prepared.json"), "utf8"));
  if (manifest.cluster !== cluster || manifest.program !== program)
    throw new Error("prepared.json names another cluster or program");
  for (const key of ["sourcePath", "binaryPath"])
    if (typeof manifest[key] !== "string" || !inside(outputRoot, manifest[key]))
      throw new Error(`prepared.json ${key} is outside ${outputRoot}`);
  if (!/era_editions\.so$/.test(manifest.binaryPath)) throw new Error("prepared.json names no era_editions.so");
  for (const key of ["sha256", "sharedSourceSha256"])
    if (!/^[a-f0-9]{64}$/.test(manifest[key])) throw new Error(`prepared.json ${key} is not a digest`);
  const elf = readFileSync(manifest.binaryPath);
  if (sha256(elf) !== manifest.sha256 || elf.length !== manifest.bytes)
    throw new Error("The ELF on disk is not the one prepared.json describes");
  if (manifest.sharedSourceSha256 !== sha256(readFileSync(source)))
    throw new Error("The build was not copied from this repository's programs/editions/src/lib.rs");
  if (!readFileSync(manifest.sourcePath, "utf8").includes(`declare_id!("${program}")`))
    throw new Error("The built source does not declare the program key's address");
  return {
    elf: manifest.binaryPath as string,
    bytes: elf.length,
    sha256: manifest.sha256 as string,
    sharedSourceSha256: manifest.sharedSourceSha256 as string,
  };
}

/** Runs test:svm on the prepared ELF and records whether it passed. */
export async function svm(d: Deps) {
  const state = need(d);
  const p = prepared(state);
  await guard(d);
  if (sha256(readFileSync(p.elf)) !== p.sha256) throw new Error("The prepared ELF changed on disk");
  const args = svmArgs(d.cluster, p.elf, state.program);
  d.log(`npm run test:svm -- ${args.join(" ")}`);
  const { code, output } = await d.svm(args);
  // The suite exits 0 on SKIP too, so the pass line, the ELF and its address must all be printed.
  const passed = code === 0 && SVM_PASSED.test(output) && !/^FAIL/m.test(output) &&
    output.includes(resolve(p.elf)) && output.includes(state.program);
  state.svm = { passed, sha256: p.sha256, at: d.now().toISOString() };
  saveState(d.root, state);
  if (!passed) throw new Error("test:svm did not pass on the prepared ELF; quote and deploy stay refused");
  d.log(`test:svm passed on ${p.sha256}. Next: ${run(d, "quote")}`);
}

/** Live rent for this ELF, the fees, and what to send to the deployer. */
export async function quoteStep(d: Deps) {
  const state = need(d);
  const p = svmPassed(state);
  await guard(d);
  const sizes = rentSizes(p.bytes);
  const rent = {
    programData: await rentFor(d, sizes.programData),
    programAccount: await rentFor(d, sizes.programAccount),
    buffer: await rentFor(d, sizes.buffer),
  };
  const q = quote(p.bytes, rent);
  const held = await balance(d, state.deployer);
  state.quote = { elfBytes: p.bytes, rent, required: q.required, balance: held, at: d.now().toISOString() };
  saveState(d.root, state);
  d.log(
    `Quote for the ${p.bytes}-byte ELF on ${d.cluster}, rent read now:\n` +
    `  ProgramData rent, ${sizes.programData} bytes      ${lamportsText(rent.programData)}\n` +
    `  program account rent, ${sizes.programAccount} bytes       ${lamportsText(rent.programAccount)}\n` +
    `  signatures, ${q.writes} writes + 6          ${lamportsText(q.signatureFees)}\n` +
    `  priority fees, fixed price          ${lamportsText(q.priorityFees)}\n` +
    `  margin, returned by refund          ${lamportsText(q.margin)}\n` +
    `  required                            ${lamportsText(q.required)}\n` +
    `  The buffer (minimum ${lamportsText(rent.buffer)}) is funded at the ProgramData rent and\n` +
    `  drained back to the deployer by the deploy: held during the upload, not added.\n` +
    `Deployer ${state.deployer} holds ${lamportsText(held)}.`,
  );
  d.log(held >= q.required
    ? `Funded. Next: ${run(d, "deploy")}`
    : `Send exactly ${q.required - held} lamports to ${state.deployer}, then ${run(d, "deploy")}.`);
}

/** Uploads and deploys until done or the deadline passes; run again to continue. */
export async function deploy(d: Deps) {
  const state = need(d);
  const p = svmPassed(state);
  if (!state.quote || state.quote.elfBytes !== p.bytes) throw new Error("Run quote first");
  if (state.deploy?.deployed) {
    d.log(`Already deployed and byte-verified. Next: ${run(d, "verify")}`);
    return;
  }
  const binary = readFileSync(p.elf);
  if (sha256(binary) !== p.sha256 || binary.length !== p.bytes) throw new Error("The prepared ELF changed on disk");
  if (p.sharedSourceSha256 !== sha256(readFileSync(sourcePath(d))))
    throw new Error("programs/editions/src/lib.rs changed since prepare; prepare again");
  // The client must treat a new address as the current program, or it would send old shapes.
  const features = programFeatures(state.program);
  if (!Object.values(features).every(Boolean))
    throw new Error("This client would treat the program as a legacy deployment");
  await guard(d);
  const keys = await loadKeys(d.root, state);
  const save = () => saveState(d.root, state);
  const progress = (state.deploy ??= {});
  const frozen = (state.rent ??= {});
  const rent = async (size: number) => {
    frozen[size] ??= await rentFor(d, size);
    save();
    return frozen[size];
  };
  const outcome = await retryRateLimited(() => uploadAndDeploy({
    sender: sender(d, state, keys.deployer),
    program: keys.program,
    buffer: keys.buffer,
    binary,
    progress,
    saveProgress: save,
    rent,
    beforeBuffer: async () => {
      const sizes = rentSizes(p.bytes);
      const q = quote(p.bytes, {
        programData: await rent(sizes.programData),
        programAccount: await rent(sizes.programAccount),
        buffer: await rentFor(d, sizes.buffer),
      });
      const held = await balance(d, state.deployer);
      if (held < q.required)
        throw new Error(`The deployer holds ${held} lamports and the deploy needs ${q.required}: ` +
          `send ${q.required - held} to ${state.deployer}, then run deploy again`);
    },
    prefix: {
      buffer: budget(COMPUTE_UNITS.buffer),
      write: budget(COMPUTE_UNITS.write),
      deploy: budget(COMPUTE_UNITS.deploy),
    },
    pauseMs: d.pauseMs,
    skipWritten: true,
    deadline: d.deadline,
  }));
  if (outcome === "paused") {
    d.log(`Stopped between sends at ${progress.offset ?? 0} / ${p.bytes} bytes; progress is saved. ` +
      `Run ${run(d, "deploy")} again.`);
    return;
  }
  const { programData, slot } = await verifyDeployed(d.endpoint!, state.program, binary, state.deployer);
  if (!progress.deploymentSignature && frozen[PROGRAM_ACCOUNT_BYTES] !== undefined)
    progress.deploymentSignature = await landed(d, state, deployInstructions(budget(COMPUTE_UNITS.deploy),
      createNoopSigner(address(state.deployer)), createNoopSigner(address(state.program)), state.buffer,
      programData, frozen[PROGRAM_ACCOUNT_BYTES], p.bytes));
  Object.assign(progress, { deployed: true, programData, slot: String(slot) });
  save();
  d.log(`DEPLOYED AND BYTE-VERIFIED ${state.program} (ProgramData ${programData}, slot ${slot}).\n` +
    `Next: ${run(d, "verify")}`);
}

/**
 * ProgramData space is 45 + the ELF, its tail hashes to the prepared SHA-256, and the authority is
 * the deployer, or after `authority` the new one. The app's own check (`programImage.ts`) must
 * accept the same pin.
 */
export async function verify(d: Deps) {
  const state = need(d);
  const p = prepared(state);
  if (!state.deploy?.deployed) throw new Error("Run deploy first");
  await guard(d);
  const expected = state.authority?.confirmed ? state.authority.to : state.deployer;
  const read = await readProgram(d, state);
  assertImage(state, read);
  if (read.authority !== expected)
    throw new Error(`The upgrade authority is ${read.authority ?? "none"}, expected ${expected}`);
  await assertProgramImage(d.endpoint!, state.program,
    { sha256: p.sha256, bytes: p.bytes, upgradeAuthority: expected, source: "deploy verify" },
    `deploy-${d.cluster}`);
  state.verified = { authority: expected, slot: String(read.slot), programData: read.programData, at: d.now().toISOString() };
  saveState(d.root, state);
  d.log(`VERIFIED ${state.program}: ${p.bytes} bytes, SHA-256 ${p.sha256}, slot ${read.slot}, ` +
    `upgrade authority ${expected}${expected === state.deployer ? " (the deployer)" : ""}.`);
  d.log(state.authority?.confirmed
    ? `Next: ${run(d, "refund --to <owner address>")}`
    : `Next: ${run(d, "vault --multisig <multisig address>")}, then ${run(d, "authority --to <vault>")}`);
}

function plan(d: Deps): MultisigPlan {
  return JSON.parse(readFileSync(join(d.repoRoot, "programs", "editions", "mainnet-multisig-plan.json"), "utf8"));
}

/** Reads the multisig on chain, holds it to the plan, and derives its vault, index 0. */
async function verifiedVault(d: Deps, multisig: string) {
  const reviewed = plan(d);
  const held = await account(d, multisig);
  if (!held) throw new Error(`No account at ${multisig} on ${d.cluster}`);
  const mismatches = await planMismatches(multisig, held.owner, held.data, reviewed);
  if (mismatches.length)
    throw new Error(`${multisig} is not the reviewed multisig:\n  ${mismatches.join("\n  ")}`);
  const vault = await vaultAddress(multisig, 0);
  const vaultAccount = await account(d, vault);
  if (vaultAccount && (vaultAccount.owner !== SYSTEM_PROGRAM || vaultAccount.data.length !== 0))
    throw new Error(`${vault} holds data or belongs to ${vaultAccount.owner}: not a Squads vault`);
  return { vault, plan: reviewed };
}

/** Verifies the multisig and derives its vault; saved for `authority` once a deploy exists. */
export async function vault(d: Deps, multisig: string) {
  const state = readState(d.root) && need(d);
  address(multisig);
  await guard(d);
  const found = await verifiedVault(d, multisig);
  d.log(`Squads v4 multisig ${multisig}: ${found.plan.threshold} of ` +
    found.plan.members.map((m) => `${m.name} ${m.address}`).join(", ") +
    `; no config authority; time lock ${found.plan.timeLockSeconds} s.\nVault, index 0: ${found.vault}`);
  if (!state) {
    d.log(`Not saved: there is no deploy yet. Run this again after ${run(d, "prepare")}.`);
    return;
  }
  state.vault = {
    multisig,
    vault: found.vault,
    threshold: found.plan.threshold,
    members: found.plan.members.map(({ name, address }) => ({ name, address })),
    at: d.now().toISOString(),
  };
  saveState(d.root, state);
  d.log(`Next: ${run(d, `authority --to ${found.vault}`)}`);
}

/**
 * Loader-v3 `SetAuthority` from `current` to `to`. The builder fills an omitted new authority with
 * the loader's own id, which would leave the program with no usable authority, so the three
 * accounts are checked before anything is signed.
 */
export function setAuthorityInstruction(programData: string, current: TransactionSigner, to: string): Instruction {
  const ix = getSetAuthorityInstruction({
    bufferOrProgramDataAccount: address(programData),
    currentAuthority: current,
    newAuthority: address(to),
  });
  assertSetAuthority(ix, programData, current.address, to);
  return ix;
}

export function assertSetAuthority(ix: Instruction, programData: string, current: string, to: string) {
  const accounts = ix.accounts ?? [];
  if (
    ix.programAddress !== LOADER || accounts.length !== 3 ||
    accounts[0].address !== programData || accounts[0].role !== AccountRole.WRITABLE ||
    accounts[1].address !== current || accounts[1].role !== AccountRole.READONLY_SIGNER ||
    accounts[2].address !== to || accounts[2].role !== AccountRole.READONLY
  )
    throw new Error(`The SetAuthority instruction does not name ${to} as the new authority`);
}

/**
 * Transfers the upgrade authority with `SetAuthority`, which the new authority does not sign. The
 * vault signs only through an executed Squads transaction, and Squads' Safe Authority Transfer
 * needs the deploying key added as a member first
 * (https://docs.squads.so/main/navigating-your-squad/developers-assets/programs), a configuration
 * vote away from the reviewed members. The CLI's equivalent is `solana program
 * set-upgrade-authority --skip-new-upgrade-authority-signer-check`. What the checked form would
 * prove, that the destination is controlled, is proven here by `vault` instead: the destination
 * must be the vault derived from the multisig read on chain and held to the plan, re-read now.
 */
export async function authority(d: Deps, to: string, wallet?: string) {
  const state = need(d);
  if (!state.deploy?.deployed || !state.verified) throw new Error("Run deploy and verify first");
  address(to);
  let kind: "vault" | "wallet";
  if (wallet !== undefined) {
    if (d.cluster !== "devnet")
      throw new Error("--wallet is for a devnet rehearsal: on mainnet the upgrade authority is the multisig vault");
    if (wallet !== to) throw new Error("--wallet must repeat the --to address");
    if (isOffCurveAddress(address(to))) throw new Error(`${to} is off the curve: not a wallet`);
    kind = "wallet";
  } else {
    if (!state.vault || state.vault.vault !== to)
      throw new Error(`${to} is not the vault verified by \`vault --multisig\`; refusing to transfer to it`);
    kind = "vault";
  }
  if ([state.deployer, state.program, state.buffer].includes(to))
    throw new Error(`${to} is one of this deploy's own keys`);
  if (state.authority && !state.authority.confirmed && state.authority.to !== to)
    throw new Error(`A transfer to ${state.authority.to} was started; finish it with --to ${state.authority.to}`);
  await guard(d);
  if (kind === "vault" && (await verifiedVault(d, state.vault!.multisig)).vault !== to)
    throw new Error("The vault no longer derives from the recorded multisig");
  const read = await readProgram(d, state);
  assertImage(state, read);
  const transfer = (current: TransactionSigner) =>
    [...budget(COMPUTE_UNITS.authority), setAuthorityInstruction(read.programData, current, to)];
  if (read.authority === to) {
    const signature = state.authority?.signature ?? await landed(d, state, transfer(createNoopSigner(address(state.deployer))));
    state.authority = { ...state.authority, to, kind, signature, confirmed: true, at: state.authority?.at ?? d.now().toISOString() };
    saveState(d.root, state);
    d.log(`The upgrade authority is already ${to}${signature ? ` (${signature})` : ""}. Next: ${run(d, "verify")}`);
    return;
  }
  if (read.authority !== state.deployer)
    throw new Error(`The upgrade authority is ${read.authority ?? "none"}, neither the deployer nor ${to}`);
  const keys = await loadKeys(d.root, state);
  state.authority = { to, kind, at: d.now().toISOString() };
  saveState(d.root, state);
  const signature = await retryRateLimited(() =>
    sendJournalled(sender(d, state, keys.deployer), transfer(keys.deployer)));
  const after = await readProgram(d, state);
  if (after.authority !== to) throw new Error(`The upgrade authority reads ${after.authority} after ${signature}`);
  Object.assign(state.authority, { signature, confirmed: true });
  saveState(d.root, state);
  d.log(`UPGRADE AUTHORITY ${to} (${kind}), SetAuthority ${signature}. Next: ${run(d, "verify")}`);
}

/** Every buffer the loader holds with the deployer as authority, or null when the endpoint will not say. */
async function buffersOf(d: Deps, deployer: string): Promise<string[] | null> {
  try {
    const found = await request<{ pubkey: string }[]>(d.endpoint!, "getProgramAccounts", [LOADER, {
      encoding: "base64",
      commitment: "confirmed",
      dataSlice: { offset: 0, length: 0 },
      // Buffer: u32 1, then Some(authority).
      filters: [
        { memcmp: { offset: 0, bytes: Buffer.from([1, 0, 0, 0, 1]).toString("base64"), encoding: "base64" } },
        { memcmp: { offset: 5, bytes: deployer } },
      ],
    }]);
    return found.map((a) => a.pubkey);
  } catch {
    return null;
  }
}

/** The fee `instructions` would cost the deployer now, as the cluster computes it. */
async function feeFor(d: Deps, payer: string, instructions: Instruction[]): Promise<number> {
  const { value: lifetime } = await request<any>(d.endpoint!, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const message = appendTransactionMessageInstructions(instructions,
    setTransactionMessageLifetimeUsingBlockhash(
      { ...lifetime, lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) },
      setTransactionMessageFeePayer(address(payer), createTransactionMessage({ version: 0 }))));
  const bytes = Buffer.from(compileTransaction(message).messageBytes).toString("base64");
  const { value } = await request<{ value: number | null }>(d.endpoint!, "getFeeForMessage", [bytes, { commitment: "confirmed" }]);
  if (!Number.isSafeInteger(value) || value! <= 0) throw new Error("The cluster did not price the refund");
  return value!;
}

/**
 * Sends everything the deployer holds, less the fee, to `to`; the deployer ends at exactly 0. Once
 * a program exists that is after the authority transfer; before, it ends an abandoned upload, whose
 * buffer `close-buffer` has returned.
 */
export async function refund(d: Deps, to: string) {
  const state = need(d);
  const abandoned = !state.authority?.confirmed;
  if (abandoned && state.deploy?.deployed)
    throw new Error("Transfer the upgrade authority first: the deployer pays its fee");
  address(to);
  if ([state.deployer, state.program, state.buffer, state.deploy?.programData].includes(to))
    throw new Error(`${to} is one of this deploy's own accounts`);
  if (state.refund && !state.refund.confirmed && state.refund.to !== to)
    throw new Error(`A refund to ${state.refund.to} was started; finish it with --to ${state.refund.to}`);
  await guard(d);
  if (abandoned) {
    if (await account(d, state.program)) throw new Error("The program is deployed: transfer the upgrade authority first");
    for (const attempt of Object.values(state.journal))
      if (!attempt.confirmed && (await checkAttempt(d.endpoint!, attempt)) === "pending")
        throw new Error(`${attempt.signature} may still land; run refund again in a minute`);
  } else {
    const read = await readProgram(d, state);
    if (read.authority !== state.authority!.to)
      throw new Error(`The upgrade authority reads ${read.authority}, not ${state.authority!.to}`);
  }
  // This deploy makes one buffer, at the recorded address; getProgramAccounts is a second look.
  if (await account(d, state.buffer)) throw new Error(`The buffer ${state.buffer} still exists; run ${run(d, "close-buffer")}`);
  const others = await buffersOf(d, state.deployer);
  if (others === null) d.log("This endpoint refused getProgramAccounts; the recorded buffer, the only one this deploy made, is gone.");
  else if (others.length) throw new Error(`Buffers with the deployer as authority remain: ${others.join(", ")}`);
  const next = abandoned
    ? `Nothing is deployed; to deploy after all, fund the deployer and run ${run(d, "deploy")}`
    : `Next: ${run(d, "record --reviewed-by <names>")}`;
  const held = await balance(d, state.deployer);
  if (held === 0) {
    if (state.refund) Object.assign(state.refund, { confirmed: true });
    else state.refund = { to, lamports: 0, confirmed: true, at: d.now().toISOString() };
    saveState(d.root, state);
    d.log(`The deployer holds nothing. ${next}`);
    return;
  }
  const keys = await loadKeys(d.root, state);
  const transfer = (amount: number) => [
    ...budget(COMPUTE_UNITS.refund),
    getTransferSolInstruction({ source: keys.deployer, destination: address(to), amount }),
  ];
  const fee = await feeFor(d, state.deployer, transfer(held));
  const lamports = held - fee;
  if (lamports <= 0) throw new Error(`The deployer's ${held} lamports do not cover the ${fee}-lamport fee`);
  if ((await balance(d, to)) === 0 && lamports < (await rentFor(d, 0)))
    throw new Error(`${to} is empty and ${lamports} lamports is below the rent-exempt minimum`);
  state.refund = { to, lamports, at: d.now().toISOString() };
  saveState(d.root, state);
  const signature = await retryRateLimited(() =>
    sendJournalled(sender(d, state, keys.deployer), transfer(lamports)));
  const left = await balance(d, state.deployer);
  if (left !== 0) throw new Error(`The deployer still holds ${left} lamports after ${signature}`);
  Object.assign(state.refund, { signature, confirmed: true });
  saveState(d.root, state);
  d.log(`REFUNDED ${lamportsText(lamports)} to ${to} (${signature}); the deployer is empty.\n${next}`);
}

/**
 * Closes a buffer the deploy will not finish, its lamports back to the deployer, and starts the
 * upload over: its journal would otherwise answer a new buffer's sends with the old signatures.
 */
export async function closeBuffer(d: Deps) {
  const state = need(d);
  await guard(d);
  const held = await account(d, state.buffer);
  if (!held) {
    d.log(`There is no buffer at ${state.buffer}.`);
    return;
  }
  if (held.owner !== LOADER || held.data.length < BUFFER_HEADER || held.data.readUInt32LE(0) !== 1 ||
      held.data[4] !== 1 || !held.data.subarray(5, BUFFER_HEADER).equals(Buffer.from(getAddressEncoder().encode(address(state.deployer)))))
    throw new Error(`${state.buffer} is not a buffer under the deployer's authority`);
  for (const attempt of Object.values(state.journal))
    if (!attempt.confirmed && (await checkAttempt(d.endpoint!, attempt)) === "pending")
      throw new Error(`${attempt.signature} may still land; run close-buffer again in a minute`);
  const keys = await loadKeys(d.root, state);
  const signature = await retryRateLimited(() => sendJournalled(sender(d, state, keys.deployer), [
    ...budget(COMPUTE_UNITS.close),
    getCloseInstruction({
      bufferOrProgramDataAccount: address(state.buffer),
      destinationAccount: address(state.deployer),
      authority: keys.deployer,
    }),
  ]));
  if (await account(d, state.buffer)) throw new Error(`${state.buffer} still exists after ${signature}`);
  state.deploy = {};
  state.journal = {};
  saveState(d.root, state);
  d.log(`CLOSED ${state.buffer} (${signature}); its lamports are back with the deployer.`);
}

/** YYYY-MM-DD in local time. */
const localDate = (now: Date) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/**
 * Re-reads ProgramData and the multisig, writes `programs/editions/deployments/<cluster>-<date>.json`
 * when the authority is the verified vault (`policy: "multisig"`), and prints the lines for
 * `publications/deployments.ts`. A wallet authority is neither `multisig` nor `final`: no record.
 */
export async function record(d: Deps, reviewedBy: string[]) {
  const state = need(d);
  const p = prepared(state);
  if (!state.authority?.confirmed) throw new Error("Transfer the upgrade authority first");
  if (!reviewedBy.length || reviewedBy.some((name) => !name.trim()))
    throw new Error("--reviewed-by names who checked the deployed bytes and the authority");
  await guard(d);
  const read = await readProgram(d, state);
  assertImage(state, read);
  if (read.authority !== state.authority.to)
    throw new Error(`The upgrade authority reads ${read.authority}, not ${state.authority.to}`);
  const date = localDate(d.now());
  let written: string | null = null;
  if (state.authority.kind === "vault") {
    const { vault, plan: reviewed } = await verifiedVault(d, state.vault!.multisig);
    if (vault !== state.authority.to) throw new Error("The authority is not the recorded multisig's vault");
    const script = d.cluster === "mainnet-beta" ? "prepare-mainnet-windows.ps1" : "prepare-devnet-windows.ps1";
    const entry: DeploymentRecord = {
      address: state.program,
      cluster: d.cluster,
      elfSha256: p.sha256,
      deployedSlot: Number(read.slot),
      authority: vault,
      policy: "multisig",
      reviewedBy: reviewedBy.map((name) => name.trim()),
      date,
      programData: read.programData,
      ...(state.deploy?.deploymentSignature ? { signature: state.deploy.deploymentSignature } : {}),
      bytes: p.bytes,
      notes:
        `Squads v4 multisig ${state.vault!.multisig}, threshold ${reviewed.threshold} of ` +
        `${reviewed.members.length} (${reviewed.members.map((m) => m.name).join(", ")}), no config authority; ` +
        `the upgrade authority is its vault, index 0, set with loader-v3 SetAuthority ` +
        `${state.authority.signature ?? "(signature not recorded)"}. Built by scripts/${script} from commit ` +
        `${p.commit ?? "unknown"}${p.sourceClean ? "" : " with uncommitted changes under programs/editions"}; ` +
        "deployed from a one-time key (publications/mainnet) that `forget` deletes once the authority " +
        "and the refund are confirmed on chain.",
    };
    const schema = JSON.parse(readFileSync(
      join(d.repoRoot, "programs", "editions", "scripts", "deployment-record.schema.json"), "utf8"));
    const errors = schemaErrors(entry, schema);
    if (errors.length) throw new Error(`The record does not match the schema:\n  ${errors.join("\n  ")}`);
    written = join(d.repoRoot, "programs", "editions", "deployments", `${d.cluster}-${date}.json`);
    if (existsSync(written)) throw new Error(`${written} already exists`);
    mkdirSync(dirname(written), { recursive: true });
    writeFileSync(written, JSON.stringify(entry, null, 2) + "\n", { flag: "wx" });
    d.log(`Wrote ${relative(d.repoRoot, written)}`);
  } else {
    d.log("No record file: a wallet upgrade authority is neither `multisig` nor `final`.");
  }
  d.log(deploymentsLines({
    cluster: d.cluster,
    address: state.program,
    sha256: read.sha256,
    bytes: read.bytes,
    upgradeAuthority: state.authority.to,
    source: `${date} ${d.cluster} deployment, commit ${p.commit?.slice(0, 7) ?? "unknown"}, publications/mainnet` +
      (written ? ` (${relative(d.repoRoot, written).replace(/\\/g, "/")})` : ""),
  }));
  state.record = { path: written && relative(d.repoRoot, written), at: d.now().toISOString() };
  saveState(d.root, state);
  d.log(`Next: ${run(d, "forget")}`);
}

/** Deletes the key files, only once the authority and the refund are confirmed on chain again. */
export async function forget(d: Deps) {
  const state = need(d);
  if (!state.authority?.confirmed) throw new Error("Refusing: the upgrade authority transfer is not confirmed");
  if (!state.refund?.confirmed) throw new Error("Refusing: the refund is not confirmed");
  await guard(d);
  const read = await readProgram(d, state);
  if (read.authority !== state.authority.to || read.authority === state.deployer)
    throw new Error(`Refusing: the upgrade authority reads ${read.authority}`);
  const left = await balance(d, state.deployer);
  if (left !== 0) throw new Error(`Refusing: the deployer holds ${left} lamports; run refund again`);
  if (await account(d, state.buffer)) throw new Error("Refusing: the buffer still exists");
  const removed = deleteKeys(d.root);
  state.forgotten = { at: d.now().toISOString() };
  saveState(d.root, state);
  d.log(`Deleted ${removed.join(", ") || "nothing (already gone)"}. The deploy is finished.`);
}

/** Where the deploy stands and the next command. Reads only the state file. */
export function status(d: Deps) {
  const state = readState(d.root);
  if (!state) {
    d.log(`No ${d.cluster} deploy in ${d.root}. Start with ${run(d, "prepare")}`);
    return;
  }
  const p = state.prepared;
  const lines = [
    `${state.cluster} deploy in ${d.root}`,
    `  deployer ${state.deployer}`,
    `  program  ${state.program}`,
    `  buffer   ${state.buffer}`,
    `  prepared ${p ? `${p.bytes} bytes, ${p.sha256}, commit ${p.commit ?? "unknown"}` : "no"}`,
    `  svm      ${state.svm ? (state.svm.passed && state.svm.sha256 === p?.sha256 ? "passed" : "not passed") : "not run"}`,
    `  quote    ${state.quote ? `${lamportsText(state.quote.required)} at ${state.quote.at}` : "no"}`,
    `  deploy   ${state.deploy?.deployed ? `deployed, slot ${state.deploy.slot}` : state.deploy?.initialized ? `uploading, ${state.deploy.offset ?? 0} / ${p?.bytes} bytes` : "not started"}`,
    `  verified ${state.verified ? `authority ${state.verified.authority} at ${state.verified.at}` : "no"}`,
    `  vault    ${state.vault ? `${state.vault.vault} of ${state.vault.multisig}` : "no"}`,
    `  authority ${state.authority ? `${state.authority.to} (${state.authority.kind})${state.authority.confirmed ? "" : ", not confirmed"}` : "deployer"}`,
    `  refund   ${state.refund ? `${lamportsText(state.refund.lamports)} to ${state.refund.to}${state.refund.confirmed ? "" : ", not confirmed"}` : "no"}`,
    `  record   ${state.record ? state.record.path ?? "lines printed, no file" : "no"}`,
    `  keys     ${state.forgotten ? `deleted ${state.forgotten.at}` : "held"}`,
  ];
  const next =
    !p ? "prepare"
    : !(state.svm?.passed && state.svm.sha256 === p.sha256) ? "svm"
    : !state.quote ? "quote"
    : !state.deploy?.deployed ? "deploy"
    : !state.verified ? "verify"
    : !state.authority?.confirmed ? (state.vault ? `authority --to ${state.vault.vault}` : "vault --multisig <multisig address>")
    : state.verified.authority !== state.authority.to ? "verify"
    : !state.refund?.confirmed ? "refund --to <owner address>"
    : !state.record ? "record --reviewed-by <names>"
    : !state.forgotten ? "forget"
    : null;
  lines.push(next ? `Next: ${run(d, next)}` : "Finished.");
  d.log(lines.join("\n"));
}
