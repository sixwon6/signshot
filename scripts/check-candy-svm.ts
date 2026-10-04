/**
 * Numbered editions on Metaplex's deployed Core Candy Machine + Core Candy Guard, run end to end
 * in LiteSVM with no program of this app's own: `npx tsx scripts/check-candy-svm.ts`.
 *
 *   env: SVM_HOST SVM_TOOLS_ROOT SVM_MAINNET_RPC
 *   Delete `.cache/svm/candy*` to read the programs from mainnet again.
 *
 * The first run reads, once and read only, the executable data of Core Candy Machine, Core Candy
 * Guard and Metaplex Core from mainnet (`SVM_MAINNET_RPC`) into `.cache/svm/` (gitignored); the
 * RPC URL is never written down, and every later run checks the ELFs against their recorded
 * sha256.
 *
 * Every edition flow goes as the app will send it: the client's draft is compiled with
 * SetComputeUnitLimit + SetComputeUnitPrice (`prepareForWallet`), a simulated wallet REWRITES it
 * (a new compute-unit price, the accounts reordered) and signs first, the client's `finish`
 * checks the returned message and adds the local keypairs' signatures, the server signs
 * Seeker-only claims last, and LiteSVM runs it with signature checks on. Hostile instructions (what
 * a publisher or a stranger could send by hand) are built here and say so.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getProgramDerivedAddress,
  isOffCurveAddress,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
  type TransactionSigner,
} from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getInitializeMint2Instruction, getMintToInstruction, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import {
  CANDY_GUARD_HEADER,
  CANDY_GUARD_PROGRAM,
  CANDY_MACHINE_HIDDEN_BYTES,
  CANDY_MACHINE_PROGRAM,
  MINT_COUNTER_BYTES,
  MPL_CORE,
  SYSTEM_PROGRAM,
  SYSVAR_INSTRUCTIONS,
  SYSVAR_SLOT_HASHES,
  TOKEN_PROGRAM,
  associatedTokenAddress,
  candyMachineAuthorityPda,
  createAccountInstruction,
  createTokenAccountInstruction,
  decodeCandyMachine,
  mintCounterAddress,
  mintInstruction,
  addVerifiedCreatorInstruction,
  setCandyGuardAuthorityInstruction,
  transferSolInstruction,
  unwrapInstruction,
  updateCandyGuardInstruction,
  updateCandyMachineInstruction,
  updateCollectionInstruction,
  withdrawCandyMachineInstruction,
} from "../publications/candy/programs";
import {
  CORE_CREATE_FEE,
  NO_AUTHORITY,
  canAfford,
  checkTerms,
  claimCost,
  claimDraft,
  claimStatus,
  classifyClaimFailure,
  closeDraft,
  copyBytes,
  copyAnomalies,
  counterAddress,
  editionGuards,
  noAuthorityAddress,
  publishTransactions,
  readCopy,
  readEdition,
  setPriceDraft,
  type AccountView,
  type ClaimCost,
  type CopyView,
  type Edition,
  type EditionTerms,
  type EditionVerdict,
  type Price,
} from "../publications/candy/edition";
import { decodeGuardData, encodeGuardData } from "../publications/candy/guards";
import { COMPUTE_BUDGET_PROGRAM, prepareForWallet, sameMeaning, type DraftTransaction } from "../publications/candy/transactions";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// --- The LiteSVM host (as in check-program-svm.ts) -----------------------------------------------

const HOST_ROOT = join(root, "programs", "svm");

function hostExecutable(): string {
  if (process.env.SVM_HOST) return process.env.SVM_HOST;
  const built = join(HOST_ROOT, "target", "release", process.platform === "win32" ? "svm-host.exe" : "svm-host");
  const cargoArgs = ["build", "--release", "--locked"];
  console.log("Building the LiteSVM host (programs/svm)...");
  const run = process.platform === "win32"
    ? spawnSync("pwsh", ["-NoProfile", "-Command",
      `& '${join(root, "programs", "svm", "scripts", "build-native-windows.ps1")}'` +
      ` -ToolsRoot '${process.env.SVM_TOOLS_ROOT ?? join(process.env.LOCALAPPDATA ?? tmpdir(), "ssbt")}'` +
      ` -ProgramRoot '${HOST_ROOT}' -CargoArgs @(${cargoArgs.map((a) => `'${a}'`).join(",")})`], { encoding: "utf8" })
    : spawnSync("cargo", cargoArgs, { cwd: HOST_ROOT, encoding: "utf8" });
  if (run.status !== 0) {
    console.error(run.stdout, run.stderr, run.error ?? "");
    throw new Error("The LiteSVM host did not build.");
  }
  return built;
}

class Host {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting: ((line: string) => void)[] = [];
  constructor(executable: string) {
    this.child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.pipe(process.stderr);
    createInterface({ input: this.child.stdout }).on("line", (line) => this.waiting.shift()?.(line));
    this.child.on("exit", (code) => {
      for (const reply of this.waiting.splice(0)) reply(JSON.stringify({ error: `the host exited (${code})` }));
    });
  }
  async call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const line = await new Promise<string>((done) => {
      this.waiting.push(done);
      this.child.stdin.write(`${JSON.stringify({ op, ...args })}\n`);
    });
    const reply = JSON.parse(line) as { result?: T; error?: string };
    if (reply.error !== undefined) throw new Error(`svm ${op}: ${reply.error}`);
    return reply.result as T;
  }
  close() { this.child.stdin.end(); }
}

let host: Host;
const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytesOf = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const keyBytes = (key: string) => new Uint8Array(getAddressEncoder().encode(address(key)));
const keyOf = (bytes: Uint8Array) => getAddressDecoder().decode(bytes);

async function read(key: string): Promise<AccountView | null> {
  const found = await host.call<null | { lamports: string; owner: string; data: string }>("get", { address: hexOf(keyBytes(key)) });
  return found && { address: address(key), lamports: BigInt(found.lamports), owner: keyOf(bytesOf(found.owner)), bytes: bytesOf(found.data) };
}
async function write(key: string, account: { lamports: bigint; owner: string; bytes: Uint8Array }) {
  await host.call("set", {
    address: hexOf(keyBytes(key)), lamports: account.lamports.toString(),
    owner: hexOf(keyBytes(account.owner)), data: hexOf(account.bytes), executable: false,
  });
}
const rent = async (length: number) => BigInt(await host.call<string>("rent", { len: length }));
const balance = async (key: string) => (await read(key))?.lamports ?? 0n;

async function wallet(lamports = 10_000_000_000n): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  if (lamports > 0n) await host.call("airdrop", { address: hexOf(keyBytes(signer.address)), lamports: lamports.toString() });
  return signer;
}

interface Outcome {
  ok: boolean; err?: string; custom?: { index: number; code: number } | null; logs: string[]; units: number;
  size: number; signers: number; accountKeys: Address[];
}
const LIMIT = 1_232;
/** `publications/rpc.ts` refuses a transaction over this many bytes before asking the wallet. */
const APP_BUDGET = 1_057;

/** As the app sends: SetComputeUnitLimit + SetComputeUnitPrice (price 0 keeps lamport accounting exact; the size is the same). */
async function send(payer: TransactionSigner, instructions: Instruction[]): Promise<Outcome> {
  const recent = getBase58Decoder().decode(bytesOf(await host.call<string>("blockhash")));
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(recent), lastValidBlockHeight: 0n }, m),
    (m) => appendTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: 400_000 }), getSetComputeUnitPriceInstruction({ microLamports: 0n }), ...instructions], m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wire = Buffer.from(getBase64EncodedWireTransaction(signed), "base64");
  const accountKeys = getCompiledTransactionMessageDecoder().decode(signed.messageBytes).staticAccounts as Address[];
  const outcome = await host.call<Omit<Outcome, "size" | "signers" | "accountKeys">>("send", { tx: hexOf(new Uint8Array(wire)) });
  return { ...outcome, size: wire.length, signers: Object.keys(signed.signatures).length, accountKeys };
}

// --- Mainnet, read once ----------------------------------------------------------------------------

const MAINNET_RPC = process.env.SVM_MAINNET_RPC ?? "https://api.mainnet.solana.com";
const CACHE = join(root, ".cache", "svm");
const CANDY_FILE = join(CACHE, "candy.json");
const ELF = {
  core: join(CACHE, "mpl-core.so"),
  machine: join(CACHE, "candy-machine-core.so"),
  guard: join(CACHE, "candy-guard.so"),
};
interface ProgramRecord { programData: string; slot: string; bytes: number; sha256: string }
interface CandyRecord { readAt: string; rentMin0: string; core: ProgramRecord; machine: ProgramRecord; guard: ProgramRecord }

async function mainnetCall<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(MAINNET_RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (!response.ok || body.error || body.result === undefined) throw new Error(`${method}: ${JSON.stringify(body.error ?? response.status)}`);
  return body.result;
}
async function accountData(key: string) {
  const { value } = await mainnetCall<{ value: { owner: string; data: [string, string] } | null }>("getAccountInfo", [key, { encoding: "base64" }]);
  if (!value) throw new Error(`Nothing at ${key} on mainnet`);
  return { owner: value.owner, bytes: new Uint8Array(Buffer.from(value.data[0], "base64")) };
}
/** Program (tag 2, ProgramData address) -> ProgramData (tag 3, u64 slot, Option<Pubkey>; 45 bytes) -> ELF. */
async function dumpProgram(id: Address, file: string): Promise<ProgramRecord> {
  const program = await accountData(id);
  if (program.owner !== "BPFLoaderUpgradeab1e11111111111111111111111" || program.bytes[0] !== 2) throw new Error(`${id} is not an upgradeable program`);
  const programData = keyOf(program.bytes.subarray(4, 36));
  const data = (await accountData(programData)).bytes;
  if (data[0] !== 3) throw new Error("Not a ProgramData account");
  const elf = data.subarray(45);
  writeFileSync(file, elf);
  return {
    programData, slot: new DataView(data.buffer, data.byteOffset).getBigUint64(4, true).toString(),
    bytes: elf.length, sha256: createHash("sha256").update(elf).digest("hex"),
  };
}
async function mainnet(): Promise<CandyRecord> {
  if (existsSync(CANDY_FILE) && Object.values(ELF).every(existsSync)) {
    const record = JSON.parse(readFileSync(CANDY_FILE, "utf8")) as CandyRecord;
    for (const [file, rec] of [[ELF.core, record.core], [ELF.machine, record.machine], [ELF.guard, record.guard]] as const)
      if (createHash("sha256").update(readFileSync(file)).digest("hex") !== rec.sha256) throw new Error(`${file} does not match candy.json`);
    return record;
  }
  console.log("Reading Core Candy Machine, Core Candy Guard and Metaplex Core from mainnet (read only, once)...");
  mkdirSync(CACHE, { recursive: true });
  const record: CandyRecord = {
    readAt: new Date().toISOString(),
    rentMin0: String(await mainnetCall<number>("getMinimumBalanceForRentExemption", [0])),
    core: await dumpProgram(MPL_CORE, ELF.core),
    machine: await dumpProgram(CANDY_MACHINE_PROGRAM, ELF.machine),
    guard: await dumpProgram(CANDY_GUARD_PROGRAM, ELF.guard),
  };
  writeFileSync(CANDY_FILE, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
async function fresh(chain: CandyRecord) {
  await host.call("reset");
  await host.call("rent_floor", { min0: chain.rentMin0 });
  await host.call("program", { id: hexOf(keyBytes(MPL_CORE)), path: ELF.core });
  await host.call("program", { id: hexOf(keyBytes(CANDY_MACHINE_PROGRAM)), path: ELF.machine });
  await host.call("program", { id: hexOf(keyBytes(CANDY_GUARD_PROGRAM)), path: ELF.guard });
  const clock = (await read(CLOCK))!;
  const bytes = new Uint8Array(clock.bytes);
  new DataView(bytes.buffer).setBigInt64(32, BigInt(Math.floor(Date.now() / 1000)), true);
  await write(CLOCK, { lamports: clock.lamports, owner: clock.owner, bytes });
  // The candy machine reads bytes 12..20 of SlotHashes; LiteSVM's carries entries.
  const slotHashes = await read(SYSVAR_SLOT_HASHES);
  if (!slotHashes || slotHashes.bytes.length < 20) throw new Error("No SlotHashes to seed the candy machine");
}

// --- Core accounts ---------------------------------------------------------------------------------

function cursor(bytes: Uint8Array, start = 0) {
  let at = start;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (n: number) => { if (at + n > bytes.length) throw new Error("Truncated Core account"); const was = at; at += n; return was; };
  const c = {
    u8: () => bytes[need(1)], u16: () => view.getUint16(need(2), true), u32: () => view.getUint32(need(4), true),
    u64: () => view.getBigUint64(need(8), true),
    key: () => { const was = need(32); return keyOf(bytes.subarray(was, was + 32)); },
    text: () => { const n = c.u32(); const was = need(n); return new TextDecoder().decode(bytes.subarray(was, was + n)); },
    get at() { return at; },
  };
  return c;
}
const AUTHORITY = ["None", "Owner", "UpdateAuthority", "Address"] as const;
interface Plugin { type: string; authority: string; maxSupply?: number | null; number?: number; basisPoints?: number; creators?: { address: Address; percentage: number }[]; delegates?: Address[] }
function plugins(bytes: Uint8Array, base: number): Plugin[] {
  if (bytes.length === base) return [];
  const header = cursor(bytes, base);
  if (header.u8() !== 3) throw new Error("No plugin header");
  const registry = cursor(bytes, Number(header.u64()));
  if (registry.u8() !== 4) throw new Error("No plugin registry");
  const count = registry.u32();
  const out: Plugin[] = [];
  for (let i = 0; i < count; i += 1) {
    registry.u8();
    const tag = registry.u8();
    const authority = tag === 3 ? `Address(${registry.key()})` : AUTHORITY[tag];
    const p = cursor(bytes, Number(registry.u64()));
    const id = p.u8();
    if (id === 10) out.push({ type: "MasterEdition", authority, maxSupply: p.u8() ? p.u32() : null });
    else if (id === 0) {
      const basisPoints = p.u16();
      const n = p.u32();
      out.push({ type: "Royalties", authority, basisPoints, creators: Array.from({ length: n }, () => ({ address: p.key(), percentage: p.u8() })) });
    } else if (id === 9) out.push({ type: "Edition", authority, number: p.u32() });
    else if (id === 4) { const n = p.u32(); out.push({ type: "UpdateDelegate", authority, delegates: Array.from({ length: n }, () => p.key()) }); }
    else out.push({ type: `Plugin${id}`, authority });
  }
  return out;
}
function decodeCollection(bytes: Uint8Array) {
  const c = cursor(bytes);
  if (c.u8() !== 5) throw new Error("Not a Core collection");
  const updateAuthority = c.key();
  const name = c.text();
  const uri = c.text();
  const numMinted = c.u32();
  const currentSize = c.u32();
  return { updateAuthority, name, uri, numMinted, currentSize, plugins: plugins(bytes, c.at) };
}
function decodeAsset(bytes: Uint8Array) {
  const c = cursor(bytes);
  if (c.u8() !== 1) throw new Error("Not a Core asset");
  const owner = c.key();
  const kind = c.u8();
  const updateAuthority = kind === 0 ? null : c.key();
  const name = c.text();
  const uri = c.text();
  if (c.u8()) c.u64();
  return { owner, updateKind: kind, updateAuthority, name, uri, plugins: plugins(bytes, c.at) };
}
const pluginOf = (list: Plugin[], type: string) => list.find((p) => p.type === type);
const assetAt = async (key: string) => { const a = await read(key); return a && a.owner === MPL_CORE && a.bytes[0] === 1 ? decodeAsset(a.bytes) : null; };
const collectionAt = async (key: string) => decodeCollection((await read(key))!.bytes);

// Hostile instructions: what a publisher or a stranger could send by hand.
const meta = (a: Address, role: AccountRole) => ({ address: a, role });
const signerMeta = (s: TransactionSigner, role: AccountRole) => ({ address: s.address, role, signer: s });
const u32le = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const strBytes = (s: string) => { const b = new TextEncoder().encode(s); return new Uint8Array([...u32le(b.length), ...b]); };
const anchorDisc = (s: string) => createHash("sha256").update(s).digest().subarray(0, 8);
/** Core UpdateV1 (15): new_uri only. */
const coreUpdateAsset = (asset: Address, collection: Address, authority: TransactionSigner, uri: string): Instruction => ({
  programAddress: MPL_CORE,
  accounts: [meta(asset, AccountRole.WRITABLE), meta(collection, AccountRole.READONLY), signerMeta(authority, AccountRole.WRITABLE_SIGNER),
    signerMeta(authority, AccountRole.READONLY_SIGNER), meta(SYSTEM_PROGRAM, AccountRole.READONLY), meta(MPL_CORE, AccountRole.READONLY)],
  data: new Uint8Array([15, 0, 1, ...strBytes(uri), 0]),
});
/** Core UpdatePluginV1 (6): Plugin::Edition (9) { number }. */
const coreRenumber = (asset: Address, collection: Address, authority: TransactionSigner, n: number): Instruction => ({
  programAddress: MPL_CORE,
  accounts: [meta(asset, AccountRole.WRITABLE), meta(collection, AccountRole.WRITABLE), signerMeta(authority, AccountRole.WRITABLE_SIGNER),
    signerMeta(authority, AccountRole.READONLY_SIGNER), meta(SYSTEM_PROGRAM, AccountRole.READONLY), meta(MPL_CORE, AccountRole.READONLY)],
  data: new Uint8Array([6, 9, ...u32le(n)]),
});
/** Core UpdateCollectionPluginV1 (7): Plugin::Royalties (0). */
const coreRoyalties = (collection: Address, authority: TransactionSigner, bps: number): Instruction => ({
  programAddress: MPL_CORE,
  accounts: [meta(collection, AccountRole.WRITABLE), signerMeta(authority, AccountRole.WRITABLE_SIGNER),
    signerMeta(authority, AccountRole.READONLY_SIGNER), meta(SYSTEM_PROGRAM, AccountRole.READONLY), meta(MPL_CORE, AccountRole.READONLY)],
  data: new Uint8Array([7, 0, bps & 255, bps >>> 8, ...u32le(1), ...keyBytes(authority.address), 100, 0]),
});
/** Core CreateV1 (0) straight into the collection, the publisher as authority. */
const coreCreateInto = (asset: TransactionSigner, collection: Address, authority: TransactionSigner): Instruction => ({
  programAddress: MPL_CORE,
  accounts: [signerMeta(asset, AccountRole.WRITABLE_SIGNER), meta(collection, AccountRole.WRITABLE), signerMeta(authority, AccountRole.READONLY_SIGNER),
    signerMeta(authority, AccountRole.WRITABLE_SIGNER), meta(MPL_CORE, AccountRole.READONLY), meta(MPL_CORE, AccountRole.READONLY),
    meta(SYSTEM_PROGRAM, AccountRole.READONLY), meta(MPL_CORE, AccountRole.READONLY)],
  data: new Uint8Array([0, 0, ...strBytes("fake"), ...strBytes("uri:"), 0]),
});
/** Candy machine `mint_asset` straight from a would-be mint authority, any Edition number. */
const directMint = async (candyMachine: Address, authority: TransactionSigner, asset: TransactionSigner, collection: Address, edition: number): Promise<Instruction> => ({
  programAddress: CANDY_MACHINE_PROGRAM,
  accounts: [meta(candyMachine, AccountRole.WRITABLE), meta(await candyMachineAuthorityPda(candyMachine), AccountRole.WRITABLE),
    signerMeta(authority, AccountRole.READONLY_SIGNER), signerMeta(authority, AccountRole.WRITABLE_SIGNER), meta(authority.address, AccountRole.READONLY),
    signerMeta(asset, AccountRole.WRITABLE_SIGNER), meta(collection, AccountRole.WRITABLE), meta(MPL_CORE, AccountRole.READONLY),
    meta(SYSTEM_PROGRAM, AccountRole.READONLY), meta(SYSVAR_INSTRUCTIONS, AccountRole.READONLY), meta(SYSVAR_SLOT_HASHES, AccountRole.READONLY)],
  data: new Uint8Array([...anchorDisc("global:mint_asset"), ...u32le(1), 9, ...u32le(edition), 0]),
});
/** Candy guard `update` with arbitrary data bytes (the publisher, writing guards this app never writes). */
const rawGuardUpdate = (candyGuard: Address, authority: TransactionSigner, data: Uint8Array): Instruction => ({
  programAddress: CANDY_GUARD_PROGRAM,
  accounts: [meta(candyGuard, AccountRole.WRITABLE), signerMeta(authority, AccountRole.READONLY_SIGNER),
    signerMeta(authority, AccountRole.WRITABLE_SIGNER), meta(SYSTEM_PROGRAM, AccountRole.READONLY)],
  data: new Uint8Array([...anchorDisc("global:update"), ...u32le(data.length), ...data]),
});


// --- Checks ----------------------------------------------------------------------------------------

let failures = 0;
let passes = 0;
const seen = (o: Outcome) => o.ok ? `ok, ${o.units} CU, ${o.size} B` : o.custom ? `error ${o.custom.code}` : o.err ?? "failed";
function ok(name: string, condition: boolean, outcome?: Outcome) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${outcome ? ` [${seen(outcome)}]` : ""}`);
  if (condition) passes += 1;
  else {
    failures += 1;
    if (outcome) console.log([outcome.err ?? "", ...outcome.logs.slice(-12)].map((l) => `      | ${l}`).join("\n"));
  }
}
const refused = (o: Outcome, code: number) => !o.ok && o.custom?.code === code;
const logged = (o: Outcome, pattern: RegExp) => o.logs.some((l) => pattern.test(l));
const throws = async (f: () => unknown | Promise<unknown>, pattern?: RegExp) => {
  try { await f(); return false; } catch (error) { return !pattern || pattern.test((error as Error).message); }
};
// Candy Guard and Candy Machine codes (IDLs and errors.rs), Anchor 0.28's own, SPL Token's.
const G = { PublicKeyMismatch: 6002, MissingRemainingAccount: 6006, CollectionKeyMismatch: 6013, NotEnoughSOL: 6018, NotEnoughTokens: 6020,
  MissingRequiredSignature: 6022, AllowedMintLimitReached: 6029 };
const CM = { CandyMachineEmpty: 6006 };
const ANCHOR = { ConstraintHasOne: 2001, ConstraintRaw: 2003, AccountNotInitialized: 3012 };
const TOKEN = { InsufficientFunds: 1, NonNativeHasBalance: 11, AccountFrozen: 17 };
const lines: string[] = [];
const note = (s: string) => { lines.push(s); };

// --- The wallet, as Seed Vault behaves ------------------------------------------------------------

const BUDGET = { units: 400_000, microLamports: 7n };
const messageDecoder = getCompiledTransactionMessageDecoder();
const messageEncoder = getCompiledTransactionMessageEncoder();
type Compiled = Extract<ReturnType<typeof messageDecoder.decode>, { version: 0 }>;
type Mutation = (m: Compiled) => Compiled;

async function lifetime() {
  return { blockhash: blockhash(getBase58Decoder().decode(bytesOf(await host.call<string>("blockhash")))), lastValidBlockHeight: 0n };
}
const priceData = (microLamports: bigint) => { const b = new Uint8Array(9); b[0] = 3; new DataView(b.buffer).setBigUint64(1, microLamports, true); return b; };

/**
 * What the wallet returns: the compute-unit price replaced (by 0, which also keeps the lamport
 * accounting below exact), every account but the fee payer reordered within its role, the
 * instructions re-indexed, optionally `mutate`d, then signed by the wallet's key.
 */
async function walletSigns(unsigned: Transaction, key: KeyPairSigner, mutate?: Mutation): Promise<Transaction> {
  const m = messageDecoder.decode(unsigned.messageBytes) as Compiled;
  const { numSignerAccounts: s, numReadonlySignerAccounts: rs, numReadonlyNonSignerAccounts: ro } = m.header;
  const n = m.staticAccounts.length;
  const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
  const order = [0, ...range(1, s - rs).reverse(), ...range(s - rs, s).reverse(), ...range(s, n - ro).reverse(), ...range(n - ro, n).reverse()];
  const at = new Map(order.map((old, i) => [old, i]));
  let next: Compiled = {
    ...m,
    staticAccounts: order.map((i) => m.staticAccounts[i]),
    instructions: m.instructions.map((ix) => ({
      programAddressIndex: at.get(ix.programAddressIndex)!,
      accountIndices: ix.accountIndices?.map((i) => at.get(i)!),
      data: m.staticAccounts[ix.programAddressIndex] === COMPUTE_BUDGET_PROGRAM && ix.data?.[0] === 3 ? priceData(0n) : ix.data,
    })),
  };
  if (mutate) next = mutate(next);
  const messageBytes = messageEncoder.encode(next);
  const signatures: Record<string, unknown> = Object.fromEntries(next.staticAccounts.slice(0, next.header.numSignerAccounts).map((a) => [a, null]));
  signatures[key.address] = await signBytes(key.keyPair.privateKey, messageBytes);
  return { messageBytes, signatures } as unknown as Transaction;
}

async function sendTx(tx: Transaction): Promise<Outcome> {
  const wire = Buffer.from(getBase64EncodedWireTransaction(tx), "base64");
  const accountKeys = messageDecoder.decode(tx.messageBytes).staticAccounts as Address[];
  const outcome = await host.call<Omit<Outcome, "size" | "signers" | "accountKeys">>("send", { tx: hexOf(new Uint8Array(wire)) });
  return { ...outcome, size: wire.length, signers: Object.keys(tx.signatures).length, accountKeys };
}

/** One draft transaction the app's way: compile, the wallet rewrites and signs, finish, [server signs], send. */
async function submit(walletKey: KeyPairSigner, dtx: DraftTransaction, options: { server?: KeyPairSigner; mutate?: Mutation } = {}): Promise<Outcome> {
  const prepared = prepareForWallet(walletKey.address, dtx, await lifetime(), BUDGET);
  const returned = await walletSigns(prepared.transaction, walletKey, options.mutate);
  let tx = await prepared.finish(returned);
  if (options.server) tx = await partiallySignTransaction([options.server.keyPair], tx);
  return sendTx(tx);
}

// --- Editions --------------------------------------------------------------------------------------

let made = 0;
interface Ed {
  publisher: KeyPairSigner; collection: Address; candyMachine: Address; candyGuard: Address; copy1: Address;
  terms: EditionTerms; outcomes: Outcome[]; cost: bigint; tx: DraftTransaction[];
}

function terms(supply: number, price: Price = { kind: "free" }, cosigner: Address | null = null): EditionTerms {
  made += 1;
  return {
    title: `Moment ${String(made).padStart(2, "0")}`, uri: `https://arweave.net/${randomBytes(32).toString("base64url")}`,
    imageSha256: new Uint8Array(randomBytes(32)), supply, royaltyBasisPoints: 500, price, cosigner,
  };
}

async function build(t: EditionTerms, publisher?: KeyPairSigner): Promise<Ed> {
  publisher ??= await wallet();
  const collection = await generateKeyPairSigner();
  const candyMachine = await generateKeyPairSigner();
  const copy = await generateKeyPairSigner();
  const built = await publishTransactions({ publisher: publisher.address, collection, candyMachine, copy, terms: t, candyMachineRent: await rent(CANDY_MACHINE_HIDDEN_BYTES) });
  return { publisher, collection: collection.address, candyMachine: candyMachine.address, candyGuard: built.candyGuard,
    copy1: copy.address, terms: t, outcomes: [], cost: 0n, tx: built.draft.transactions };
}
async function run(e: Ed) {
  const before = await balance(e.publisher.address);
  for (const dtx of e.tx) {
    const o = await submit(e.publisher, dtx);
    e.outcomes.push(o);
    if (!o.ok) break;
  }
  e.cost = before - (await balance(e.publisher.address));
  return e;
}
const publish = async (t: EditionTerms, publisher?: KeyPairSigner) => run(await build(t, publisher));
const allOk = (e: Ed) => e.outcomes.length === 2 && e.outcomes.every((o) => o.ok);
const firstBad = (os: Outcome[]) => os.find((o) => !o.ok);
const sizes = (e: Ed) => e.outcomes.map((o) => o.size).join(" + ");

const verdict = async (e: Ed): Promise<EditionVerdict> =>
  readEdition({ candyMachine: await read(e.candyMachine), candyGuard: await read(e.candyGuard), collection: await read(e.collection) });
const edition = async (e: Ed): Promise<Edition> => {
  const v = await verdict(e);
  if (!v.ok) throw new Error(`readEdition refused: ${v.reason}`);
  return v;
};
/** An edition's fields read without `readEdition`'s checks, to send a claim at an account it refuses. */
const readEditionLoose = async (e: Ed): Promise<Omit<Edition, "ok">> => {
  const m = decodeCandyMachine((await read(e.candyMachine))!.bytes);
  return {
    candyMachine: e.candyMachine, candyGuard: e.candyGuard, collection: e.collection, publisher: e.publisher.address,
    royaltyBasisPoints: e.terms.royaltyBasisPoints, minted: Number(m.itemsRedeemed), supply: Number(m.data.itemsAvailable), soldOut: false,
    price: { kind: "free" }, cosigner: null, onePerWallet: true, title: e.terms.title, nextName: `${e.terms.title} #${Number(m.itemsRedeemed) + 1}`,
    uri: e.terms.uri, imageSha256: e.terms.imageSha256, guards: decodeGuardData((await read(e.candyGuard))!.bytes, CANDY_GUARD_HEADER),
  };
};
const costOf = async (e: Ed) => claimCost(await edition(e), rent);
const counterOf = async (e: Ed, who: Address) => read(await counterAddress(await edition(e), who));
const setPrice = async (e: Ed, price: Price, signer: KeyPairSigner = e.publisher) =>
  submit(signer, (await setPriceDraft({ publisher: signer.address, edition: await edition(e), price })).transactions[0]);

interface Claim { outcome: Outcome; asset: Address; payer: Address; tokenAccount?: Address; cost: ClaimCost; spent: bigint; failure: string }
/**
 * A claim the app's way, from what `readEdition` saw (`reviewed`, by default now); `between` runs
 * after the review and before it lands (the publisher acting meanwhile); `server` co-signs.
 */
async function claim(e: Ed, collector: KeyPairSigner, options: {
  server?: KeyPairSigner; edit?: (d: DraftTransaction) => DraftTransaction; between?: () => Promise<unknown>; reviewed?: Edition; mutate?: Mutation;
} = {}): Promise<Claim> {
  const reviewed = options.reviewed ?? await edition(e);
  const cost = await claimCost(reviewed, rent);
  const asset = await generateKeyPairSigner();
  const payer = await generateKeyPairSigner();
  const tokenAccount = reviewed.price.kind === "token" ? await generateKeyPairSigner() : undefined;
  const counter = reviewed.onePerWallet ? await read(await counterAddress(reviewed, collector.address)) : null;
  const draft = await claimDraft({ edition: reviewed, counter, cost, collector: collector.address, asset, payer, tokenAccount });
  await options.between?.();
  const before = await balance(collector.address);
  const dtx = options.edit ? options.edit(draft.transactions[0]) : draft.transactions[0];
  const outcome = await submit(collector, dtx, { server: options.server, mutate: options.mutate });
  const spent = before - (await balance(collector.address));
  const failure = outcome.ok ? "" : classifyClaimFailure({ err: outcome.err ?? "", custom: outcome.custom, logs: outcome.logs },
    { accountKeys: outcome.accountKeys, wallet: collector.address, payer: payer.address });
  return { outcome, asset: asset.address, payer: payer.address, tokenAccount: tokenAccount?.address, cost, spent, failure };
}

const isCopy = async (e: Ed, key: Address, owner: Address, n: number) => {
  const a = await assetAt(key);
  const ed = a && pluginOf(a.plugins, "Edition");
  return Boolean(a && a.owner === owner && a.updateKind === 2 && a.updateAuthority === e.collection &&
    a.name === `${e.terms.title} #${n}` && a.uri === e.terms.uri && ed?.number === n);
};
const mapMint = (f: (ix: Instruction) => Instruction) => (d: DraftTransaction): DraftTransaction =>
  ({ ...d, instructions: d.instructions.map((ix) => (ix.programAddress === CANDY_GUARD_PROGRAM ? f(ix) : ix)) });
/** Replace one account in the mint instruction. */
const swapIn = (from: Address, to: Address) => mapMint((ix) => ({ ...ix, accounts: ix.accounts!.map((m) => (m.address === from ? { address: to, role: m.role } : m)) }));
/** The co-signer's account left in place but not a signer. */
const unsign = (key: Address) => mapMint((ix) => ({ ...ix, accounts: ix.accounts!.map((m) => (m.address === key ? { address: m.address, role: AccountRole.READONLY } : m)) }));

async function testMint(mintAuthority: KeyPairSigner, holders: [KeyPairSigner, bigint][], freeze = false) {
  const mint = await generateKeyPairSigner();
  const ixs: Instruction[] = [
    createAccountInstruction(mintAuthority, mint, await rent(82), 82, TOKEN_PROGRAM),
    getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: mintAuthority.address, freezeAuthority: freeze ? mintAuthority.address : null }, { programAddress: TOKEN_PROGRAM }),
  ];
  for (const [holder, amount] of holders) {
    ixs.push(await createTokenAccountInstruction(mintAuthority, holder.address, mint.address));
    if (amount > 0n) ixs.push(getMintToInstruction({ mint: mint.address, token: await associatedTokenAddress(holder.address, mint.address), mintAuthority, amount }, { programAddress: TOKEN_PROGRAM }));
  }
  const o = await send(mintAuthority, ixs);
  if (!o.ok) ok("setup: a test SPL mint", false, o);
  return mint.address;
}
async function tokenBalance(owner: Address, mint: Address) {
  const acc = await read(await associatedTokenAddress(owner, mint));
  return acc ? new DataView(acc.bytes.buffer, acc.bytes.byteOffset).getBigUint64(64, true) : 0n;
}
const tokenPrice = (mint: Address, amount: bigint): Price => ({ kind: "token", mint, amount, tokenProgram: TOKEN_PROGRAM });
const strArr = (s: string) => { const b = new TextEncoder().encode(s); return [...u32le(b.length), ...b]; };

async function main() {
  const chain = await mainnet();
  host = new Host(hostExecutable());
  try {
    await fresh(chain);
    const floor = await rent(0);
    console.log(`Core Candy Machine ${chain.machine.sha256.slice(0, 16)}... (slot ${chain.machine.slot}); Core Candy Guard ${chain.guard.sha256.slice(0, 16)}... ` +
      `(slot ${chain.guard.slot}); Core ${chain.core.sha256.slice(0, 16)}...; rent floor ${floor}; NO_AUTHORITY ${NO_AUTHORITY}`);

    // 0. Codec, constants, the wallet check.
    console.log("\n0. codec, constants, the wallet's rewrite");
    {
      const pub = (await generateKeyPairSigner()).address;
      const open = await editionGuards(pub, { kind: "sol", lamports: 5n }, null);
      const bytes = encodeGuardData(open);
      ok(`open SOL guard data: ${bytes.length} bytes (features 8 + sol 40 + limit 3 + edition 4, groups 4), decodes back`,
        bytes.length === 8 + 40 + 3 + 4 + 4 && hexOf(encodeGuardData(decodeGuardData(bytes))) === hexOf(bytes));
      ok("Writer refuses out-of-range values instead of wrapping (mint limit id 256, limit 65536, offset -1)",
        await throws(() => encodeGuardData({ default: { mintLimit: { id: 256, limit: 1 } }, groups: [] }), /u8/) &&
        await throws(() => encodeGuardData({ default: { mintLimit: { id: 0, limit: 65_536 } }, groups: [] }), /u16/) &&
        await throws(() => encodeGuardData({ default: { edition: { editionStartOffset: -1 } }, groups: [] }), /u32/));
      const [derived, bump] = await getProgramDerivedAddress({ programAddress: SYSTEM_PROGRAM, seeds: [Buffer.from("signshot"), Buffer.from("no authority")] });
      let walked: { key: Address; bump: number } | null = null;
      for (let b = 255; b >= 0 && !walked; b -= 1) {
        const h = sha256(new Uint8Array([...Buffer.from("signshot"), ...Buffer.from("no authority"), b, ...keyBytes(SYSTEM_PROGRAM), ...Buffer.from("ProgramDerivedAddress")]));
        let onCurve = true;
        try { ed25519.Point.fromBytes(h, true); } catch { onCurve = false; }
        if (!onCurve) walked = { key: keyOf(h), bump: b };
      }
      ok(`NO_AUTHORITY = the System Program's derived address for ["signshot", "no authority"] (bump ${bump}); an independent sha256 walk agrees and it is no ed25519 point`,
        derived === NO_AUTHORITY && (await noAuthorityAddress()) === NO_AUTHORITY && isOffCurveAddress(NO_AUTHORITY) && walked?.key === NO_AUTHORITY && walked.bump === bump);
      ok(`Core's create fee is ${CORE_CREATE_FEE} lamports`, CORE_CREATE_FEE === 1_500_000n);

      // The wallet's freedom: price and order only.
      const w = await wallet();
      const dtx: DraftTransaction = { instructions: [transferSolInstruction(w, (await generateKeyPairSigner()).address, 1_000_000n)], localSigners: [] };
      const prepared = prepareForWallet(w.address, dtx, await lifetime(), BUDGET);
      const rewritten = await walletSigns(prepared.transaction, w);
      ok("a rewritten message (new price, reordered accounts) differs in bytes and means the same",
        hexOf(new Uint8Array(rewritten.messageBytes)) !== hexOf(new Uint8Array(prepared.transaction.messageBytes)) &&
        sameMeaning(prepared.transaction.messageBytes, rewritten.messageBytes, { reviewedMicroLamports: BUDGET.microLamports, feeAllowanceLamports: 50_000n }) === null);
    }

    // 1. checkTerms.
    console.log("\n1. terms the client refuses before building anything");
    {
      const base = terms(10);
      const bad: [string, Partial<EditionTerms>][] = [
        ["a 25-byte title (the app's limit is 24)", { title: "T".repeat(25) }],
        ["13 x 'é' (26 bytes)", { title: "é".repeat(13) }],
        ["an empty title", { title: "" }],
        ["a title containing $ID$", { title: "Dawn $ID$" }],
        ["a title containing $ID+1$", { title: "Dawn $ID+1$" }],
        ["a 201-byte URI", { uri: `https://arweave.net/${"u".repeat(181)}` }],
        ["supply 0", { supply: 0 }], ["supply 1001", { supply: 1001 }],
        ["a SOL price of 0", { price: { kind: "sol", lamports: 0n } }],
        ["a Token-2022 mint as the price", { price: { kind: "token", mint: SYSTEM_PROGRAM, amount: 1n, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS } }],
      ];
      for (const [label, change] of bad) ok(`refused: ${label}`, await throws(() => checkTerms({ ...base, ...change })));
      ok("accepted: a 24-byte title, 12 x 'é', a 200-byte URI, supply 1 and 1000",
        !(await throws(() => checkTerms({ ...base, title: "T".repeat(24) }))) && !(await throws(() => checkTerms({ ...base, title: "é".repeat(12) }))) &&
        !(await throws(() => checkTerms({ ...base, uri: `https://arweave.net/${"u".repeat(180)}` }))) &&
        !(await throws(() => checkTerms({ ...base, supply: 1 }))) && !(await throws(() => checkTerms({ ...base, supply: 1000 }))));
      ok("publishTransactions refuses a Token-2022 price before building", await throws(() =>
        build(terms(3, { kind: "token", mint: SYSTEM_PROGRAM, amount: 1n, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })), /Token-2022/));
    }

    // 2. Publish an open free edition of 3.
    console.log("\n2. publish (open, free, supply 3)");
    const free = await publish(terms(3));
    ok("publish: two transactions, both rewritten by the wallet, both land", allOk(free), firstBad(free.outcomes));
    if (!allOk(free)) return;
    free.outcomes.forEach((o, i) => ok(`  transaction ${i + 1}: ${o.size} of ${LIMIT} bytes, ${o.signers} signatures, ${o.units} CU`, o.size <= LIMIT));
    const v1 = await edition(free);
    const pda = await candyMachineAuthorityPda(free.candyMachine);
    const machine = decodeCandyMachine((await read(free.candyMachine))!.bytes);
    ok("candy machine: authority NO_AUTHORITY, mint authority the guard, 1 of 3 redeemed, hidden name 'Title #$ID+1$', uri, image hash",
      machine.authority === NO_AUTHORITY && machine.mintAuthority === free.candyGuard && machine.itemsRedeemed === 1n &&
      machine.data.itemsAvailable === 3n && machine.data.hidden.name === `${free.terms.title} #$ID+1$` && machine.data.hidden.uri === free.terms.uri &&
      hexOf(machine.data.hidden.hash) === hexOf(free.terms.imageSha256));
    const col = await collectionAt(free.collection);
    ok("collection: update authority NO_AUTHORITY; MasterEdition(3) None, Royalties 500 bps publisher 100% None, UpdateDelegate [authority PDA], nothing else",
      col.updateAuthority === NO_AUTHORITY && col.name === free.terms.title && col.uri === free.terms.uri && col.plugins.length === 3 &&
      pluginOf(col.plugins, "MasterEdition")?.maxSupply === 3 && pluginOf(col.plugins, "MasterEdition")?.authority === "None" &&
      pluginOf(col.plugins, "Royalties")?.basisPoints === 500 && pluginOf(col.plugins, "Royalties")?.authority === "None" &&
      pluginOf(col.plugins, "Royalties")?.creators?.[0].address === free.publisher.address &&
      JSON.stringify(pluginOf(col.plugins, "UpdateDelegate")?.delegates) === JSON.stringify([pda]));
    ok("guard: no groups, exactly Mint Limit(0, 1) + Edition(0), the publisher its authority",
      hexOf((await read(free.candyGuard))!.bytes.subarray(CANDY_GUARD_HEADER)) === hexOf(encodeGuardData(await editionGuards(free.publisher.address, { kind: "free" }, null))) &&
      v1.publisher === free.publisher.address);
    ok("copy 1: the publisher's, 'Title #1', the uri, Collection(collection), Edition 1", await isCopy(free, free.copy1, free.publisher.address, 1));
    ok("copy 1 opened no counter for the publisher", (await read(await counterAddress(v1, free.publisher.address))) === null);
    ok("readEdition: ok, free, one per wallet, 500 bps, 1 of 3, next 'Title #2'", v1.price.kind === "free" && v1.cosigner === null &&
      v1.onePerWallet && v1.royaltyBasisPoints === 500 && v1.minted === 1 && v1.supply === 3 && v1.nextName === `${free.terms.title} #2`);
    {
      const collectionLamports = await balance(free.collection);
      const machineLamports = await balance(free.candyMachine);
      const guardLamports = await balance(free.candyGuard);
      const copyLamports = await balance(free.copy1);
      const fees = BigInt(free.outcomes.reduce((n, o) => n + o.signers, 0)) * 5000n;
      ok(`publisher paid ${free.cost} = collection ${collectionLamports} + candy machine ${machineLamports} + guard ${guardLamports} + copy 1 ${copyLamports} + fees ${fees}`,
        collectionLamports + machineLamports + guardLamports + copyLamports + fees === free.cost);
      ok(`copy 1 holds rent for ${copyBytes(`${free.terms.title} #1`, free.terms.uri)} bytes + Core's fee`,
        copyLamports === (await rent(copyBytes(`${free.terms.title} #1`, free.terms.uri))) + CORE_CREATE_FEE &&
        (await read(free.copy1))!.bytes.length === copyBytes(`${free.terms.title} #1`, free.terms.uri));
      note(`publish open free: ${sizes(free)} B, ${free.outcomes.map((o) => o.signers).join(" + ")} signatures, CU ${free.outcomes.map((o) => o.units).join(" + ")}; publisher pays ${free.cost} (collection ${collectionLamports}, candy machine ${machineLamports}, guard ${guardLamports}, copy 1 ${copyLamports}, fees ${fees})`);
    }

    // 3. Claims on the open free edition.
    console.log("\n3. open edition: claims, one per wallet, sold out, close");
    const a = await wallet();
    const ca = await claim(free, a);
    ok("A claims free: copy #2; the one-shot payer ends closed", ca.outcome.ok && await isCopy(free, ca.asset, a.address, 2) && (await read(ca.payer)) === null, ca.outcome);
    ok(`A spent ${ca.spent} = claimCost total (copy ${ca.cost.copy} + counter ${ca.cost.counter} + ${ca.cost.signatures} signatures)`,
      ca.spent === ca.cost.total && ca.cost.counter === await rent(MINT_COUNTER_BYTES) && (await balance(ca.asset)) === ca.cost.copy);
    note(`open free claim: ${ca.outcome.size} B, ${ca.outcome.signers} signatures, ${ca.outcome.units} CU; collector pays ${ca.spent} (copy ${ca.cost.copy}, counter ${ca.cost.counter}, fees ${ca.cost.fees})`);
    ok("claimStatus: A claimed", claimStatus(await edition(free), await counterOf(free, a.address)) === "claimed");
    ok("the client refuses A's second claim before building", await throws(() => claim(free, a), /has its copy/));
    {
      const v = await edition(free);
      const d = await claimDraft({ edition: v, counter: null, cost: await claimCost(v, rent), collector: a.address,
        asset: await generateKeyPairSigner(), payer: await generateKeyPairSigner() });
      const raw = await submit(a, d.transactions[0]);
      ok("A's second claim sent anyway -> AllowedMintLimitReached (6029); classified already-claimed", refused(raw, G.AllowedMintLimitReached) &&
        classifyClaimFailure({ err: raw.err ?? "", custom: raw.custom, logs: raw.logs }, { accountKeys: raw.accountKeys, wallet: a.address, payer: a.address }) === "already-claimed", raw);
    }
    const self = await claim(free, free.publisher);
    ok("the publisher can claim one more copy (#3): copy 1 never opened their counter", self.outcome.ok && await isCopy(free, self.asset, free.publisher.address, 3), self.outcome);
    {
      const c = await wallet();
      ok("readEdition: sold out; the client refuses to build a claim", (await edition(free)).soldOut && await throws(() => claim(free, c), /Sold out/));
      const v = { ...(await edition(free)), soldOut: false };
      const d = await claimDraft({ edition: v, counter: null, cost: await claimCost(v, rent), collector: c.address,
        asset: await generateKeyPairSigner(), payer: await generateKeyPairSigner() });
      const raw = await submit(c, d.transactions[0]);
      ok("a claim sent on 3 of 3 -> the candy machine's CandyMachineEmpty (6006, logged) through the CPI; classified sold-out",
        refused(raw, CM.CandyMachineEmpty) && logged(raw, /CandyMachineEmpty/) &&
        classifyClaimFailure({ err: raw.err ?? "", custom: raw.custom, logs: raw.logs }, { accountKeys: raw.accountKeys, wallet: c.address, payer: c.address }) === "sold-out", raw);
    }
    ok("numbering: copies 1, 2, 3 in claim order; collection counts 3", (await collectionAt(free.collection)).numMinted === 3 &&
      await isCopy(free, free.copy1, free.publisher.address, 1) && await isCopy(free, ca.asset, a.address, 2));
    {
      const guardLamports = await balance(free.candyGuard);
      const before = await balance(free.publisher.address);
      const closed = await submit(free.publisher, closeDraft({ publisher: free.publisher.address, candyGuard: free.candyGuard }).transactions[0]);
      const back = (await balance(free.publisher.address)) - before;
      ok(`close: the guard's ${guardLamports} lamports return (net ${back} after the fee); the candy machine's ${await balance(free.candyMachine)} stay locked`,
        closed.ok && back === guardLamports - 5000n && (await read(free.candyGuard)) === null && (await balance(free.candyMachine)) > 0n, closed);
      const v = await verdict(free);
      ok(`readEdition after close: not ok ('${v.ok ? "" : v.reason}')`, !v.ok && /closed/.test(v.reason));
      ok("the client refuses to build a claim on a closed edition", await throws(() => claimDraft({ edition: v, counter: null, cost: ca.cost,
        collector: a.address, asset: a, payer: a }), /closed/));
      note(`close: ${closed.size} B; returns the guard's ${guardLamports}; the candy machine's ${await balance(free.candyMachine)}, the collection, copies and counters stay`);
    }

    // 4. SOL price; the reviewed price is the paid price.
    console.log("\n4. open edition at a SOL price");
    const price = 50_000_000n;
    const paid = await publish(terms(30, { kind: "sol", lamports: price }));
    ok("publish at 0.05 SOL; copy 1 cost the publisher no price", allOk(paid) && await isCopy(paid, paid.copy1, paid.publisher.address, 1), firstBad(paid.outcomes));
    note(`publish open SOL: ${sizes(paid)} B, CU ${paid.outcomes.map((o) => o.units).join(" + ")}, publisher pays ${paid.cost}`);
    {
      const before = await balance(paid.publisher.address);
      const cp = await claim(paid, a);
      ok(`A pays: the publisher receives exactly ${price}; A spent claimCost's total ${cp.cost.total}`, cp.outcome.ok &&
        (await balance(paid.publisher.address)) - before === price && cp.spent === cp.cost.total && cp.cost.payerFunding === price + cp.cost.copy + cp.cost.counter, cp.outcome);
      note(`open SOL claim: ${cp.outcome.size} B, ${cp.outcome.signers} signatures, ${cp.outcome.units} CU; collector pays ${cp.spent}`);

      const to = (lamports: bigint) => async () => { const o = await setPrice(paid, { kind: "sol", lamports }); if (!o.ok) ok("setup: price change", false, o); };
      const moves: [string, bigint, number | "rent"][] = [
        ["raised to 0.10", price * 2n, G.NotEnoughSOL],
        ["raised by 1 lamport", price + 1n, 1],
        ["raised by 3,000,000 (less than copy + counter)", price + 3_000_000n, 1],
        ["lowered by 1 lamport", price - 1n, "rent"],
        ["lowered to 0.025 (more than the rent floor)", price / 2n, "rent"],
      ];
      for (const [label, lamports, expected] of moves) {
        const r = await claim(paid, await wallet(), { between: to(lamports) });
        const how = expected === "rent" ? /InsufficientFundsForRent/.test(r.outcome.err ?? "") : refused(r.outcome, expected);
        ok(`reviewed at 0.05, ${label} before landing -> ${expected === "rent" ? "InsufficientFundsForRent on the one-shot payer" : expected === 1 ? "System 1 inside the guard" : expected}; classified terms-changed; only fees spent`,
          how && r.failure === "terms-changed" && r.spent === 5000n * BigInt(r.outcome.signers), r.outcome);
        await to(price)();
      }
      const r3 = await claim(paid, await wallet(), { between: () => setPrice(paid, { kind: "free" }) });
      ok("reviewed at 0.05, made free -> PublicKeyMismatch (6002, the accounts shift); classified terms-changed",
        refused(r3.outcome, G.PublicKeyMismatch) && r3.failure === "terms-changed", r3.outcome);
      await to(price)();
      // The copy's number gains a digit between review and landing: its name and rent grow.
      for (let i = 0; i < 12 && (await edition(paid)).minted < 8; i += 1) await claim(paid, await wallet());
      const v9 = await edition(paid);
      const first = await claim(paid, await wallet());
      const late = await claim(paid, await wallet(), { reviewed: v9 });
      ok(`reviewed '${v9.nextName}', someone takes it first: the claim (now one digit longer) fails, classified terms-changed`,
        v9.nextName.endsWith(" #9") && first.outcome.ok && !late.outcome.ok && late.failure === "terms-changed", late.outcome);
      const stranger = await wallet();
      const notPublisher = await setPrice(paid, { kind: "free" }, stranger);
      ok("anyone else changing the price -> ConstraintHasOne (2001)", refused(notPublisher, ANCHOR.ConstraintHasOne), notPublisher);
      const newPrice = 80_000_000n;
      const changed = await setPrice(paid, { kind: "sol", lamports: newPrice });
      const before2 = await balance(paid.publisher.address);
      const cb = await claim(paid, await wallet());
      ok("the publisher changes the price to 0.08 SOL; the next collector pays exactly that", changed.ok && cb.outcome.ok &&
        (await balance(paid.publisher.address)) - before2 === newPrice, changed.ok ? cb.outcome : changed);
      note(`price change: ${changed.size} B, ${changed.units} CU`);

      const cost = await costOf(paid);
      const exact = await wallet(cost.total);
      ok("canAfford: exactly the total yes, one less no, one more no (a balance left under the rent floor), total + floor yes",
        canAfford(cost.total, cost, floor) && !canAfford(cost.total - 1n, cost, floor) && !canAfford(cost.total + 1n, cost, floor) && canAfford(cost.total + floor, cost, floor));
      const e0 = await claim(paid, exact);
      ok("a wallet holding exactly the total claims and ends at zero", e0.outcome.ok && (await read(exact.address)) === null, e0.outcome);
      const short = await claim(paid, await wallet(cost.total - 1n));
      ok("one lamport short -> System 1 on the funding transfer; classified not-enough-sol", refused(short.outcome, 1) && short.failure === "not-enough-sol", short.outcome);
      const over = await claim(paid, await wallet(cost.total + 1n));
      ok("one lamport over (left under the rent floor) -> InsufficientFundsForRent on the wallet; classified not-enough-sol",
        !over.outcome.ok && /InsufficientFundsForRent/.test(over.outcome.err ?? "") && over.failure === "not-enough-sol", over.outcome);
      const big = await publish(terms(3, { kind: "sol", lamports: 50_000_000_000n }));
      const bc = await claim(big, await wallet(60_000_000_000n));
      ok(`a 50 SOL price: the one-shot payer is allocated ${bc.cost.payerSpace} bytes after the mint; lands`, bc.outcome.ok, bc.outcome);
    }

    // 5. Seeker holders only.
    console.log("\n5. Seeker-only edition (Third Party Signer, no Mint Limit)");
    const worker = await generateKeyPairSigner();
    const sealed = await publish(terms(6, { kind: "free" }, worker.address));
    ok("publish a Seeker-only edition; copy 1 needs no co-signature", allOk(sealed) && await isCopy(sealed, sealed.copy1, sealed.publisher.address, 1), firstBad(sealed.outcomes));
    note(`publish Seeker-only free: ${sizes(sealed)} B, publisher pays ${sealed.cost}`);
    ok("guard: exactly Third Party Signer + Edition, no Mint Limit; readEdition: co-signer the server, not one-per-wallet",
      hexOf((await read(sealed.candyGuard))!.bytes.subarray(CANDY_GUARD_HEADER)) === hexOf(encodeGuardData(await editionGuards(sealed.publisher.address, { kind: "free" }, worker.address))) &&
      (await edition(sealed)).cosigner === worker.address && !(await edition(sealed)).onePerWallet &&
      claimStatus(await edition(sealed), null) === "server");
    {
      const noServer = await claim(sealed, a);
      ok("the server never signs: the runtime refuses the transaction (a required signature is missing)", !noServer.outcome.ok && !noServer.outcome.custom &&
        /Signature/i.test(noServer.outcome.err ?? ""), noServer.outcome);
      const unsigned = await claim(sealed, a, { edit: unsign(worker.address) });
      ok("co-signer account present but not a signer -> MissingRequiredSignature (6022); classified needs-cosigner; nothing created",
        refused(unsigned.outcome, G.MissingRequiredSignature) && unsigned.failure === "needs-cosigner" && (await read(unsigned.asset)) === null, unsigned.outcome);
      const impostor = await generateKeyPairSigner();
      const wrong = await claim(sealed, a, { server: impostor, edit: mapMint((ix) => ({ ...ix, accounts: ix.accounts!.map((m) =>
        (m.address === worker.address ? { address: impostor.address, role: AccountRole.READONLY_SIGNER } : m)) })) });
      ok("signed by another key in its place -> 6022", refused(wrong.outcome, G.MissingRequiredSignature), wrong.outcome);
      const omitted = await claim(sealed, a, { edit: mapMint((ix) => ({ ...ix, accounts: ix.accounts!.filter((m) => m.address !== worker.address) })) });
      ok("co-signer account left out -> MissingRemainingAccount (6006, logged)", refused(omitted.outcome, G.MissingRemainingAccount) &&
        logged(omitted.outcome, /MissingRemainingAccount/), omitted.outcome);
      const signed = await claim(sealed, a, { server: worker });
      ok(`the server signs last, over the message the wallet rewrote: copy #2; A spent ${signed.spent} (no counter)`, signed.outcome.ok &&
        await isCopy(sealed, signed.asset, a.address, 2) && signed.cost.counter === 0n && signed.spent === signed.cost.total, signed.outcome);
      note(`Seeker-only free claim: ${signed.outcome.size} B, ${signed.outcome.signers} signatures, ${signed.outcome.units} CU; collector pays ${signed.spent}`);
      const twice = await claim(sealed, a, { server: worker });
      ok("the same wallet again, co-signed: lands (#3) - only the server limits Seeker-only claims", twice.outcome.ok && await isCopy(sealed, twice.asset, a.address, 3), twice.outcome);
      const priced = await setPrice(sealed, { kind: "sol", lamports: price });
      const before = await balance(sealed.publisher.address);
      const paidSigned = await claim(sealed, await wallet(), { server: worker });
      ok("a price on the Seeker-only edition keeps the co-signer; a co-signed claim pays exactly the price",
        priced.ok && (await edition(sealed)).cosigner === worker.address && paidSigned.outcome.ok &&
        (await balance(sealed.publisher.address)) - before === price, priced.ok ? paidSigned.outcome : priced);
      note(`Seeker-only SOL claim: ${paidSigned.outcome.size} B, ${paidSigned.outcome.units} CU; collector pays ${paidSigned.spent}`);
    }

    // 6. Token price.
    console.log("\n6. token price (classic SPL Token, as SKR is)");
    {
      const amount = 250_000_000n;
      const mintAuthority = await wallet();
      const ta = await wallet(); const tb = await wallet(); const exactHolder = await wallet();
      const mint = await testMint(mintAuthority, [[ta, amount * 4n], [tb, amount / 2n], [exactHolder, amount]], true);
      const holder = async (tokens: bigint) => {
        const w = await wallet();
        await send(mintAuthority, [await createTokenAccountInstruction(mintAuthority, w.address, mint),
          getMintToInstruction({ mint, token: await associatedTokenAddress(w.address, mint), mintAuthority, amount: tokens }, { programAddress: TOKEN_PROGRAM })]);
        return w;
      };
      const tokenEd = await publish(terms(20, tokenPrice(mint, amount)));
      ok("publish at 250 test tokens (the publisher's token account made in transaction 2)", allOk(tokenEd), firstBad(tokenEd.outcomes));
      note(`publish open token: ${sizes(tokenEd)} B, CU ${tokenEd.outcomes.map((o) => o.units).join(" + ")}`);
      const v = await edition(tokenEd);
      ok("readEdition: token price, mint and amount", v.price.kind === "token" && v.price.mint === mint && v.price.amount === amount);
      const solBefore = await balance(tokenEd.publisher.address);
      const ct = await claim(tokenEd, ta);
      ok(`A pays ${amount} tokens through a temporary account closed in the same transaction; the publisher receives exactly that, no SOL`,
        ct.outcome.ok && (await tokenBalance(tokenEd.publisher.address, mint)) === amount && (await tokenBalance(ta.address, mint)) === amount * 3n &&
        (await balance(tokenEd.publisher.address)) === solBefore && ct.spent === ct.cost.total && await isCopy(tokenEd, ct.asset, ta.address, 2), ct.outcome);
      note(`open token claim: ${ct.outcome.size} B, ${ct.outcome.signers} signatures, ${ct.outcome.units} CU; collector pays ${ct.spent} SOL (temporary account rent ${ct.cost.tokenAccountRent} returned)`);
      const ex = await claim(tokenEd, exactHolder);
      ok("a holder of exactly the price: lands, their account ends at 0, the temporary account is gone", ex.outcome.ok &&
        (await tokenBalance(exactHolder.address, mint)) === 0n && (await read(ex.tokenAccount!)) === null && ex.spent === ex.cost.total, ex.outcome);
      const setTokens = (to: bigint) => async () => setPrice(tokenEd, tokenPrice(mint, to));
      for (const [label, to, code] of [["raised to 500", amount * 2n, G.NotEnoughTokens], ["raised by 1 unit", amount + 1n, G.NotEnoughTokens],
        ["lowered to 125", amount / 2n, TOKEN.NonNativeHasBalance], ["lowered by 1 unit", amount - 1n, TOKEN.NonNativeHasBalance]] as const) {
        const h = await holder(amount * 4n);
        const r = await claim(tokenEd, h, { between: setTokens(to) });
        ok(`reviewed at 250, ${label} -> ${code === G.NotEnoughTokens ? "NotEnoughTokens (6020)" : "CloseAccount refuses the leftover (Token 11)"}; classified terms-changed; no tokens move`,
          refused(r.outcome, code) && r.failure === "terms-changed" && (await tokenBalance(h.address, mint)) === amount * 4n, r.outcome);
        await setTokens(amount)();
      }
      const short = await claim(tokenEd, tb);
      ok("a holder of half -> the token transfer fails (Token 1); classified not-enough-tokens",
        refused(short.outcome, TOKEN.InsufficientFunds) && short.failure === "not-enough-tokens", short.outcome);
      const freezeIx = (account: Address, code: number): Instruction => ({ programAddress: TOKEN_PROGRAM,
        accounts: [{ address: account, role: AccountRole.WRITABLE }, { address: mint, role: AccountRole.READONLY },
          signerMeta(mintAuthority, AccountRole.READONLY_SIGNER)], data: new Uint8Array([code]) });
      const frozenHolder = await holder(amount * 2n);
      await send(mintAuthority, [freezeIx(await associatedTokenAddress(frozenHolder.address, mint), 10)]);
      const fh = await claim(tokenEd, frozenHolder);
      ok("the collector's own token account frozen -> Token 17 on the transfer; classified tokens-frozen", refused(fh.outcome, TOKEN.AccountFrozen) && fh.failure === "tokens-frozen", fh.outcome);
      const dest = await associatedTokenAddress(tokenEd.publisher.address, mint);
      const fz = await send(mintAuthority, [freezeIx(dest, 10)]);
      const rf = await claim(tokenEd, await holder(amount * 2n));
      ok("the publisher's token account frozen -> Token 17 inside the guard; classified publisher-cannot-receive",
        fz.ok && refused(rf.outcome, TOKEN.AccountFrozen) && rf.failure === "publisher-cannot-receive", rf.outcome);
      await send(mintAuthority, [freezeIx(dest, 11)]);
      const p = tokenEd.publisher;
      const sink = await holder(0n);
      const held = await tokenBalance(p.address, mint);
      const emptied = await send(p, [
        { programAddress: TOKEN_PROGRAM, accounts: [{ address: dest, role: AccountRole.WRITABLE }, { address: await associatedTokenAddress(sink.address, mint), role: AccountRole.WRITABLE },
          signerMeta(p, AccountRole.READONLY_SIGNER)], data: new Uint8Array([3, ...Buffer.from(new BigUint64Array([held]).buffer)]) },
        { programAddress: TOKEN_PROGRAM, accounts: [{ address: dest, role: AccountRole.WRITABLE }, { address: p.address, role: AccountRole.WRITABLE },
          signerMeta(p, AccountRole.READONLY_SIGNER)], data: new Uint8Array([9]) }]);
      const rc = await claim(tokenEd, await holder(amount * 2n));
      ok(`the publisher's token account closed -> ${rc.outcome.custom?.code ?? rc.outcome.err} inside the guard; classified publisher-cannot-receive`,
        emptied.ok && !rc.outcome.ok && rc.failure === "publisher-cannot-receive", rc.outcome);
      await send(p, [await createTokenAccountInstruction(p, p.address, mint)]);

      const sealedToken = await publish(terms(5, tokenPrice(mint, amount), worker.address));
      const st = await claim(sealedToken, ta, { server: worker });
      ok("Seeker-only at a token price: a co-signed claim pays exactly the tokens", allOk(sealedToken) && st.outcome.ok &&
        (await tokenBalance(sealedToken.publisher.address, mint)) === amount, st.outcome);
      note(`Seeker-only token publish: ${sizes(sealedToken)} B; claim ${st.outcome.size} B, ${st.outcome.signers} signatures, ${st.outcome.units} CU; collector pays ${st.spent} SOL`);
      const stu = await claim(sealedToken, ta, { edit: unsign(worker.address) });
      ok("Seeker-only token claim without the co-signer as signer -> 6022 (A holds the price; Token Payment validates first)", refused(stu.outcome, G.MissingRequiredSignature), stu.outcome);

      // The same claims paying straight from the collector's associated account: no temporary
      // account, so no protection against a lowered token price (a raised one still fails 6020).
      const direct = async (e: Ed, who: KeyPairSigner, server?: KeyPairSigner) => {
        const ata = await associatedTokenAddress(who.address, mint);
        return claim(e, who, { server, edit: (d) => {
          const temp = d.localSigners[2].address;
          return {
            instructions: d.instructions.filter((ix) => ix.programAddress !== TOKEN_PROGRAM && !(ix.programAddress === SYSTEM_PROGRAM && ix.data![0] === 0))
              .map((ix) => ix.programAddress !== CANDY_GUARD_PROGRAM ? ix : { ...ix, accounts: ix.accounts!.map((m) => (m.address === temp ? { address: ata, role: m.role } : m)) }),
            localSigners: d.localSigners.slice(0, 2),
          };
        } });
      };
      const dOpen = await direct(tokenEd, await holder(amount * 2n));
      const dSeeker = await direct(sealedToken, await holder(amount * 2n), worker);
      ok(`unprotected variant (paying from the associated account): open ${dOpen.outcome.size} B, Seeker-only ${dSeeker.outcome.size} B; both land`,
        dOpen.outcome.ok && dSeeker.outcome.ok, dOpen.outcome.ok ? dSeeker.outcome : dOpen.outcome);
      note(`token claim, protected vs unprotected: open ${ct.outcome.size} vs ${dOpen.outcome.size} B; Seeker-only ${st.outcome.size} vs ${dSeeker.outcome.size} B`);

      // Largest transactions the client builds: 24-byte title, 200-byte URI, supply 1000 (and 9), token + co-signer.
      for (const supply of [1000, 9]) {
        const t = terms(supply, tokenPrice(mint, amount), worker.address);
        t.title = "T".repeat(24);
        t.uri = `https://arweave.net/${"u".repeat(180)}`;
        const big = await publish(t);
        ok(`largest publish at supply ${supply}: ${sizes(big)} bytes, each within ${LIMIT}`, allOk(big) && big.outcomes.every((o) => o.size <= LIMIT), firstBad(big.outcomes));
        note(`largest publish (24-byte title, 200-byte URI, token + co-signer, supply ${supply}): ${sizes(big)} B, CU ${big.outcomes.map((o) => o.units).join(" + ")}`);
        if (supply === 1000) {
          const bc = await claim(big, ta, { server: worker });
          ok(`largest claim (token + co-signer, 200-byte URI): ${bc.outcome.size} bytes`, bc.outcome.ok && bc.outcome.size <= LIMIT, bc.outcome);
          note(`largest claim: ${bc.outcome.size} B, ${bc.outcome.signers} signatures`);
        }
      }
      const multi = terms(1000);
      multi.title = "é".repeat(12);
      multi.uri = `https://arweave.net/${"é".repeat(90)}`;
      const em = await publish(multi);
      const mc = await wallet();
      const cm = allOk(em) ? await claim(em, mc) : null;
      ok(`12 x 'é' (24 bytes) and a 200-byte multi-byte URI at supply 1000: publish + claim, copy '${cm && (await assetAt(cm.asset))?.name}'`,
        allOk(em) && !!cm?.outcome.ok && await isCopy(em, cm.asset, mc.address, 2), firstBad(em.outcomes) ?? cm?.outcome);
      const t = terms(1000, { kind: "free" });
      t.title = "T".repeat(24);
      const arweave = await publish({ ...t, uri: `https://arweave.net/${"u".repeat(43)}` });
      note(`24-byte title + an Arweave URI (63 B): ${sizes(arweave)} B against the app's ${APP_BUDGET}-byte budget in publications/rpc.ts; each URI byte adds 2 bytes to transaction 1`);
    }

    // 7. The lock, from the client's own publish.
    console.log("\n7. what the publisher can still do after publishing");
    {
      const locked = await publish(terms(9, { kind: "sol", lamports: price }));
      const p = locked.publisher;
      const one = await claim(locked, a);
      ok("published (locked by the client's own transaction 2); A claims #2", allOk(locked) && one.outcome.ok && await isCopy(locked, one.asset, a.address, 2), one.outcome);
      const m = decodeCandyMachine((await read(locked.candyMachine))!.bytes);
      const tries: [string, Outcome, number | null][] = [
        ["raise supply (candy machine update)", await send(p, [updateCandyMachineInstruction({ candyMachine: locked.candyMachine, authority: p, data: { ...m.data, itemsAvailable: 99n } })]), ANCHOR.ConstraintHasOne],
        ["unwrap the guard", await send(p, [unwrapInstruction({ candyGuard: locked.candyGuard, guardAuthority: p, candyMachine: locked.candyMachine, candyMachineAuthority: p })]), ANCHOR.ConstraintRaw],
        ["mint straight from the candy machine (Edition #1 again)", await send(p, [await directMint(locked.candyMachine, p, await generateKeyPairSigner(), locked.collection, 1)]), ANCHOR.ConstraintHasOne],
        ["withdraw the candy machine", await send(p, [withdrawCandyMachineInstruction({ candyMachine: locked.candyMachine, authority: p })]), ANCHOR.ConstraintHasOne],
        ["create an asset straight into the collection", await send(p, [coreCreateInto(await generateKeyPairSigner(), locked.collection, p)]), 26],
        ["re-point the collection's URI", await send(p, [updateCollectionInstruction({ collection: locked.collection, authority: p, payer: p, newUri: "https://arweave.net/x" })]), 9],
        ["re-point a copy's URI", await send(p, [coreUpdateAsset(one.asset, locked.collection, p, "https://arweave.net/x")]), 26],
        ["renumber a copy", await send(p, [coreRenumber(one.asset, locked.collection, p, 99)]), 26],
        ["change the royalty", await send(p, [coreRoyalties(locked.collection, p, 1000)]), 9],
      ];
      for (const [what, o, code] of tries) ok(`locked: the publisher cannot ${what} -> ${code}`, refused(o, code!), o);
      const before = await balance(p.address);
      const lprice = await setPrice(locked, { kind: "sol", lamports: price * 2n });
      const lb = await claim(locked, await wallet());
      ok("locked: the price still changes and the next claim pays it", lprice.ok && lb.outcome.ok && (await balance(p.address)) - before === price * 2n - 5000n, lprice.ok ? lb.outcome : lprice);
      const g = (await edition(locked)).guards;
      const shifted = await send(p, [updateCandyGuardInstruction({ candyGuard: locked.candyGuard, authority: p, payer: p,
        guards: { ...g, default: { ...g.default, edition: { editionStartOffset: 1 } } } })]);
      const vShift = await verdict(locked);
      ok(`the publisher shifts the Edition offset by hand: readEdition refuses ('${vShift.ok ? "" : vShift.reason}') and the client builds no claim`,
        shifted.ok && !vShift.ok && await throws(() => claimDraft({ edition: vShift, counter: null, cost: lb.cost, collector: a.address, asset: a, payer: a })), shifted);
      const back = await submit(p, (await setPriceDraft({ publisher: p.address, edition: { candyGuard: locked.candyGuard, cosigner: null }, price: { kind: "sol", lamports: price } })).transactions[0]);
      ok("setting a price restores the app's shape; readEdition accepts it again", back.ok && (await verdict(locked)).ok, back);
    }

    // 8. Accounts this client never writes.
    console.log("\n8. foreign guards, forged collections, a guard handed on");
    {
      const e = await publish(terms(5));
      const p = e.publisher;
      // BotTax(u64 max) + StartDate(2100) + Mint Limit(0, 1) + Edition(0), hand-encoded.
      const parts: number[] = [];
      const u64 = (x: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(x); parts.push(...b); };
      const features = (bits: number[]) => u64(bits.reduce((f, b) => f | (1n << BigInt(b)), 0n));
      features([0, 3, 9, 23]); u64(0xffff_ffff_ffff_ffffn); parts.push(0); u64(4_102_444_800n); parts.push(0, 1, 0); parts.push(0, 0, 0, 0);
      parts.push(...u32le(0));
      const botTax = await send(p, [rawGuardUpdate(e.candyGuard, p, new Uint8Array(parts))]);
      const v = await verdict(e);
      ok(`BotTax(u64 max) + StartDate(2100) written: readEdition refuses ('${v.ok ? "" : v.reason}'); the client builds no claim`,
        botTax.ok && !v.ok && await throws(() => claimDraft({ edition: v, counter: null, cost: {} as ClaimCost, collector: a.address, asset: a, payer: a })), botTax);
      const variants: [string, Uint8Array][] = [
        ["a group", encodeGuardData({ default: { mintLimit: { id: 0, limit: 1 }, edition: { editionStartOffset: 0 } }, groups: [{ label: "x", guards: {} }] })],
        ["Mint Limit 2", encodeGuardData({ default: { mintLimit: { id: 0, limit: 2 }, edition: { editionStartOffset: 0 } }, groups: [] })],
        ["Mint Limit id 1", encodeGuardData({ default: { mintLimit: { id: 1, limit: 1 }, edition: { editionStartOffset: 0 } }, groups: [] })],
        ["no Edition", encodeGuardData({ default: { mintLimit: { id: 0, limit: 1 } }, groups: [] })],
        ["a SOL price to someone else", encodeGuardData({ default: { solPayment: { lamports: 1n, destination: a.address }, mintLimit: { id: 0, limit: 1 }, edition: { editionStartOffset: 0 } }, groups: [] })],
        ["Mint Limit and a co-signer together", encodeGuardData({ default: { thirdPartySigner: { signerKey: worker.address }, mintLimit: { id: 0, limit: 1 }, edition: { editionStartOffset: 0 } }, groups: [] })],
      ];
      for (const [label, data] of variants) {
        const o = await send(p, [rawGuardUpdate(e.candyGuard, p, data)]);
        ok(`guard with ${label}: readEdition refuses`, o.ok && !(await verdict(e)).ok, o);
      }
      const restore = await send(p, [rawGuardUpdate(e.candyGuard, p, encodeGuardData(await editionGuards(p.address, { kind: "free" }, null)))]);
      ok("the app's own set written back: accepted again", restore.ok && (await verdict(e)).ok, restore);

      // Reader-only forgeries of otherwise good accounts.
      const good = { candyMachine: (await read(e.candyMachine))!, candyGuard: (await read(e.candyGuard))!, collection: (await read(e.collection))! };
      const forge = (which: "candyMachine" | "collection", at: number, bytes: number[] | Uint8Array, extra = 0) => {
        const copy = new Uint8Array(good[which].bytes.length + extra);
        copy.set(good[which].bytes);
        copy.set(bytes, at);
        return readEdition({ ...good, [which]: { ...good[which], bytes: copy } });
      };
      const registryAt = Number(new DataView(good.collection.bytes.buffer, good.collection.bytes.byteOffset).getBigUint64(
        1 + 32 + 4 + new TextEncoder().encode(e.terms.title).length + 4 + new TextEncoder().encode(e.terms.uri).length + 8 + 1, true));
      const externalAt = good.collection.bytes.length - 4;
      // The candy machine's data ends after three u64s (items_redeemed, items_available, max_supply), the flags and hidden settings.
      const dataEnd = 8 + 32 * 3 + 8 * 3 + 1 + 1 + 1 + 4 + new TextEncoder().encode(`${e.terms.title} #$ID+1$`).length +
        4 + new TextEncoder().encode(e.terms.uri).length + 32;
      ok(`the candy machine's data ends at byte ${dataEnd}; zeros from there to ${CANDY_MACHINE_HIDDEN_BYTES}`,
        good.candyMachine.bytes.subarray(dataEnd).every((b) => b === 0) && good.candyMachine.bytes.subarray(dataEnd - 32, dataEnd).some((b) => b !== 0));
      const forgeries: [string, Promise<EditionVerdict>][] = [
        ["candy machine padding: a non-zero first byte after the data", forge("candyMachine", dataEnd, [1])],
        ["candy machine padding: a non-zero eighth byte after the data", forge("candyMachine", dataEnd + 7, [1])],
        ["candy machine authority not NO_AUTHORITY", forge("candyMachine", 8, keyBytes(a.address))],
        ["candy machine padding not zero", forge("candyMachine", CANDY_MACHINE_HIDDEN_BYTES - 1, [1])],
        ["collection update authority not NO_AUTHORITY", forge("collection", 1, keyBytes(a.address))],
        ["one external plugin adapter counted", forge("collection", externalAt, u32le(1))],
        ["a byte after the plugin registry", forge("collection", good.collection.bytes.length, [0], 1)],
        ["the registry claiming a fifth plugin", forge("collection", registryAt + 1, u32le(5))],
      ];
      for (const [label, f] of forgeries) ok(`forged ${label}: readEdition refuses`, !(await f).ok);
      ok("the unforged accounts: accepted", (await readEdition(good)).ok);

      // A publisher's own transaction 1, with collection plugins this app never writes, followed by the client's transaction 2.
      const attacker = (await generateKeyPairSigner()).address;
      const pair = (plugin: number[], auth: number[]) => [...plugin, 1, ...auth];
      const forged = async (label: string, plugins: (pub: Address) => number[][], extraTx1?: (ed: Ed) => Promise<DraftTransaction>) => {
        const pub = await wallet();
        const t = terms(5, { kind: "sol", lamports: 10_000_000n });
        const ed = await build(t, pub);
        const list = plugins(pub.address);
        ed.tx[0] = { ...ed.tx[0], instructions: [{ ...ed.tx[0].instructions[0],
          data: new Uint8Array([1, ...strArr(t.title), ...strArr(t.uri), 1, ...u32le(list.length), ...list.flat()]) }, ...ed.tx[0].instructions.slice(1)] };
        if (extraTx1) ed.tx[0] = await extraTx1(ed);
        await run(ed);
        const vv = await verdict(ed);
        ok(`forged collection, ${label}: ${allOk(ed) ? "both transactions land" : `transaction ${ed.outcomes.length} fails`}; readEdition refuses ('${vv.ok ? "" : vv.reason}')`,
          !vv.ok, firstBad(ed.outcomes));
        if (!vv.ok) ok(`  ...and the client builds no claim on it`, await throws(() => claimDraft({ edition: vv, counter: null, cost: {} as ClaimCost, collector: a.address, asset: a, payer: a })));
        return ed;
      };
      const me = (n = 5) => pair([10, 1, ...u32le(n), 0, 0], [0]);
      const roy = (to: Address, bps = 500, auth = [0]) => pair([0, bps & 255, bps >>> 8, ...u32le(1), ...keyBytes(to), 100, 0], auth);
      await forged("the reviewer's set (UpdateDelegate[publisher], PermanentTransferDelegate(publisher), 100% royalty to another key)", (pub) =>
        [me(), roy(attacker, 10_000), pair([4, ...u32le(1), ...keyBytes(pub)], [2]), pair([7], [3, ...keyBytes(pub)])]);
      await forged("UpdateDelegate listing the publisher", (pub) => [me(), roy(pub), pair([4, ...u32le(1), ...keyBytes(pub)], [2])]);
      await forged("PermanentTransferDelegate", (pub) => [me(), roy(pub), pair([7], [3, ...keyBytes(pub)])]);
      await forged("PermanentFreezeDelegate", (pub) => [me(), roy(pub), pair([5, 0], [3, ...keyBytes(pub)])]);
      await forged("PermanentBurnDelegate", (pub) => [me(), roy(pub), pair([8], [3, ...keyBytes(pub)])]);
      await forged("Attributes", (pub) => [me(), roy(pub), pair([6, ...u32le(0)], [2])]);
      await forged("the royalty to another key", () => [me(), roy(attacker)]);
      await forged("the royalty plugin's authority UpdateAuthority", (pub) => [me(), roy(pub, 500, [2])]);
      await forged("MasterEdition saying 99", (pub) => [me(99), roy(pub)]);
      await forged("a copy created straight into the collection in transaction 1", (pub) => [me(), roy(pub)], async (ed) => {
        const extra = await generateKeyPairSigner();
        return { instructions: [...ed.tx[0].instructions.slice(0, 1), coreCreateInto(extra, ed.collection, createNoopSignerFor(ed.publisher)), ...ed.tx[0].instructions.slice(1)],
          localSigners: [...ed.tx[0].localSigners, extra] };
      });

      // Why the collection carries no VerifiedCreators: the publisher signs one in during
      // transaction 2 (Core accepts it), and then no copy can be created into the collection.
      {
        const vc = await build(terms(5));
        const second = vc.tx[1].instructions;
        vc.tx[1] = { ...vc.tx[1], instructions: [...second.slice(0, -2),
          addVerifiedCreatorInstruction({ collection: vc.collection, creator: vc.publisher, payer: vc.publisher }), ...second.slice(-2)] };
        await run(vc);
        const vcClaim = allOk(vc) ? await claim(vc, await wallet(), { reviewed: { ...(await readEditionLoose(vc)), ok: true } as Edition }) : null;
        ok(`VerifiedCreators signed in at publish: publish lands (${sizes(vc)} B), then every claim fails in Core (0x28, 'Verified creators: Rejected')`,
          allOk(vc) && !!vcClaim && refused(vcClaim.outcome, 40) && logged(vcClaim.outcome, /Verified creators: Rejected/), vcClaim?.outcome ?? firstBad(vc.outcomes));
      }

      // A guard handed on: payee and authority moved to someone else after publishing.
      const handedFrom = await wallet();
      const victim = (await wallet()).address;
      const h = await publish(terms(5, { kind: "sol", lamports: 10_000_000n }), handedFrom);
      const moved = await send(handedFrom, [updateCandyGuardInstruction({ candyGuard: h.candyGuard, authority: handedFrom, payer: handedFrom,
        guards: await editionGuards(victim, { kind: "sol", lamports: 10_000_000n }, null) }),
        setCandyGuardAuthorityInstruction({ candyGuard: h.candyGuard, authority: handedFrom, newAuthority: victim })]);
      const vh = await verdict(h);
      ok(`the guard and its payee handed to another wallet: readEdition refuses ('${vh.ok ? "" : vh.reason}'): the royalty creator is still the publisher`,
        moved.ok && !vh.ok, moved);
    }

    // 9. Pre-funded addresses and ordering.
    console.log("\n9. pre-funded addresses and transaction order");
    {
      const stranger = await wallet();
      const fund = (to: Address, amount = floor) => send(stranger, [transferSolInstruction(stranger, to, amount)]);
      const e = await publish(terms(5));
      const victim = await wallet();
      const counter = await counterAddress(await edition(e), victim.address);
      const small = await fund(counter, floor - 1n);
      ok("a transfer below the rent floor to a counter address -> InsufficientFundsForRent", !small.ok && /InsufficientFundsForRent/.test(small.err ?? ""), small);
      const funded = await fund(counter);
      ok("a stranger funds the victim's counter address: claimStatus 'blocked'", funded.ok && claimStatus(await edition(e), await read(counter)) === "blocked", funded);
      ok("the client refuses the blocked wallet's claim early with a clear error", await throws(() => claim(e, victim), /claim record's address is taken/));
      {
        const v = await edition(e);
        const d = await claimDraft({ edition: v, counter: null, cost: await claimCost(v, rent), collector: victim.address,
          asset: await generateKeyPairSigner(), payer: await generateKeyPairSigner() });
        const raw = await submit(victim, d.transactions[0]);
        ok("sent anyway: System 'already in use' (error 0) from the counter's create_account", refused(raw, 0) && logged(raw, /already in use/), raw);
      }
      const b = await build(terms(5));
      const t2first = await submit(b.publisher, b.tx[1]);
      const t1 = await submit(b.publisher, b.tx[0]);
      await fund(await mintCounterAddress(0, b.publisher.address, b.candyGuard, b.candyMachine));
      await fund(b.candyGuard);
      const t2 = await submit(b.publisher, b.tx[1]);
      const t1again = await submit(b.publisher, b.tx[0]);
      const t2again = await submit(b.publisher, b.tx[1]);
      ok(`transaction 2 before 1 fails (${t2first.custom?.code}); 1 then 2 lands although the publisher's counter and the guard address were pre-funded; neither again`,
        refused(t2first, ANCHOR.AccountNotInitialized) && t1.ok && t2.ok && !t1again.ok && !t2again.ok, t2.ok ? undefined : t2);
      const pre = await publish(terms(5));
      const asset = await generateKeyPairSigner();
      await fund(asset.address);
      const c = await wallet();
      const v = await edition(pre);
      const d = await claimDraft({ edition: v, counter: null, cost: await claimCost(v, rent), collector: c.address, asset, payer: await generateKeyPairSigner() });
      const pf = await submit(c, d.transactions[0]);
      ok("a copy address someone funded first (seen in flight): the claim fails with System 'already in use' (0) in Core's create; only fees spent",
        refused(pf, 0) && logged(pf, /already in use/), pf);
    }

    // 10. Wrong targets.
    console.log("\n10. claims aimed at the wrong accounts");
    {
      const x = await publish(terms(5, { kind: "sol", lamports: 5_000_000n }));
      const y = await publish(terms(5, { kind: "sol", lamports: 5_000_000n }));
      const c = await wallet();
      const r1 = await claim(x, c, { edit: swapIn(x.candyMachine, y.candyMachine) });
      ok("X's claim pointed at Y's candy machine -> ConstraintRaw (2003)", refused(r1.outcome, ANCHOR.ConstraintRaw), r1.outcome);
      const r2 = await claim(x, c, { edit: swapIn(x.collection, y.collection) });
      ok("X's claim with Y's collection -> CollectionKeyMismatch (6013)", refused(r2.outcome, G.CollectionKeyMismatch), r2.outcome);
      const other = await wallet(0n);
      const r3 = await claim(x, c, { edit: swapIn(x.publisher.address, other.address) });
      ok("payment redirected -> PublicKeyMismatch (6002)", refused(r3.outcome, G.PublicKeyMismatch), r3.outcome);
      const real = await mintCounterAddress(0, c.address, x.candyGuard, x.candyMachine);
      for (const [label, ctr] of [["id 1", await mintCounterAddress(1, c.address, x.candyGuard, x.candyMachine)],
        ["Y's guard and machine in the seeds", await mintCounterAddress(0, c.address, y.candyGuard, y.candyMachine)],
        ["another wallet's counter", await mintCounterAddress(0, other.address, x.candyGuard, x.candyMachine)]] as const) {
        const r = await claim(x, c, { edit: swapIn(real, ctr) });
        ok(`mint limit dodged via ${label} -> 6002`, refused(r.outcome, G.PublicKeyMismatch), r.outcome);
      }
      const stuffed = await claim(x, c, { edit: mapMint((ix) => ({ ...ix, data: new Uint8Array([...ix.data!.subarray(0, 8), ...u32le(5), 9, ...u32le(1), ...ix.data!.subarray(12)]) })) });
      ok("mint_args stuffed asking for Edition #1: ignored, copy #2", stuffed.outcome.ok && await isCopy(x, stuffed.asset, c.address, 2), stuffed.outcome);
      const p1 = await publish(terms(1));
      ok("supply 1: copy 1 is the publisher's and the edition reads sold out", allOk(p1) && (await edition(p1)).soldOut);
      const tiny = await publish(terms(3, { kind: "sol", lamports: 1n }));
      const before = await balance(tiny.publisher.address);
      const ct = await claim(tiny, await wallet());
      ok("price 1 lamport: lands, the publisher receives 1", ct.outcome.ok && (await balance(tiny.publisher.address)) - before === 1n, ct.outcome);
      const max = await publish(terms(3, { kind: "sol", lamports: 0xffff_ffff_ffff_ffffn }));
      const maxCost = await costOf(max);
      ok("price u64 max: publishes; canAfford is false and the client refuses to build a claim (no account can hold enough rent to fail it closed)",
        allOk(max) && !canAfford(10n ** 19n, maxCost, floor) && maxCost.payerSpace === null && await throws(() => claim(max, a), /too high/));
      note(`the highest SOL claim the client fails closed on a lowered price: about ${(await rent(10 * 1024 * 1024)) - 1n} lamports of funding (rent for 10 MiB)`);
    }

    // 11. A wallet that changes the meaning.
    console.log("\n11. the client refuses a wallet's transaction that means something else");
    {
      const e = await publish(terms(5, { kind: "sol", lamports: 5_000_000n }));
      const c = await wallet();
      const v = await edition(e);
      const cost = await claimCost(v, rent);
      const make = async () => (await claimDraft({ edition: v, counter: null, cost, collector: c.address, asset: await generateKeyPairSigner(), payer: await generateKeyPairSigner() })).transactions[0];
      const index = (m: Compiled, key: Address) => m.staticAccounts.indexOf(key);
      const attempts: [string, Mutation][] = [
        ["an added System transfer", (m) => ({ ...m, instructions: [...m.instructions, { programAddressIndex: index(m, SYSTEM_PROGRAM),
          accountIndices: [0, 1], data: new Uint8Array([2, 0, 0, 0, ...new Uint8Array(new BigUint64Array([1n]).buffer)]) }] })],
        ["the funding amount altered", (m) => ({ ...m, instructions: m.instructions.map((ix) => m.staticAccounts[ix.programAddressIndex] === SYSTEM_PROGRAM && ix.data?.[0] === 2
          ? { ...ix, data: new Uint8Array([2, 0, 0, 0, ...new Uint8Array(new BigUint64Array([1n]).buffer)]) } : ix) })],
        ["an added SetLoadedAccountsDataSizeLimit", (m) => ({ ...m, instructions: [{ programAddressIndex: index(m, COMPUTE_BUDGET_PROGRAM), accountIndices: [], data: new Uint8Array([4, 0, 0, 1, 0]) }, ...m.instructions] })],
        ["a second SetComputeUnitPrice", (m) => ({ ...m, instructions: [{ programAddressIndex: index(m, COMPUTE_BUDGET_PROGRAM), accountIndices: [], data: priceData(5n) }, ...m.instructions] })],
        ["the mint instruction dropped", (m) => ({ ...m, instructions: m.instructions.filter((ix) => m.staticAccounts[ix.programAddressIndex] !== CANDY_GUARD_PROGRAM) })],
        ["an account's role changed (header shifted)", (m) => ({ ...m, header: { ...m.header, numReadonlyNonSignerAccounts: m.header.numReadonlyNonSignerAccounts + 1 } })],
      ];
      for (const [label, mutate] of attempts) {
        const dtx = await make();
        const prepared = prepareForWallet(c.address, dtx, await lifetime(), BUDGET);
        const returned = await walletSigns(prepared.transaction, c, mutate);
        ok(`wallet returns ${label}: finish refuses`, await throws(() => prepared.finish(returned), /different transaction/));
      }
      const dtx = await make();
      const prepared = prepareForWallet(c.address, dtx, await lifetime(), BUDGET);
      const raised = await walletSigns(prepared.transaction, c, (m) => ({ ...m, instructions: m.instructions.map((ix) =>
        m.staticAccounts[ix.programAddressIndex] === COMPUTE_BUDGET_PROGRAM && ix.data?.[0] === 2 ? { ...ix, data: new Uint8Array([2, ...u32le(300_000)]) } : ix) }));
      const finished = await prepared.finish(raised);
      const o = await sendTx(finished);
      ok("wallet returns a different compute-unit limit and price, accounts reordered: accepted, and it lands", o.ok, o);

      // The priority fee the wallet may set: the reviewed price at its limit + 50,000 lamports.
      const withPrice = (micro: bigint, units?: number): Mutation => (m) => ({ ...m, instructions: m.instructions.map((ix) =>
        m.staticAccounts[ix.programAddressIndex] !== COMPUTE_BUDGET_PROGRAM ? ix
          : ix.data?.[0] === 3 ? { ...ix, data: priceData(micro) }
          : ix.data?.[0] === 2 && units !== undefined ? { ...ix, data: new Uint8Array([2, ...u32le(units)]) } : ix) });
      const within = await claim(e, await wallet(), { mutate: withPrice(100_000n) });
      ok(`wallet raises the price to 100,000 micro-lamports at 400,000 units (40,000 lamports, within the 50,000 allowance): lands; the collector pays ${within.spent - within.cost.total} more`,
        within.outcome.ok && within.spent - within.cost.total === 40_000n, within.outcome);
      for (const [label, mutate, pattern] of [
        ["200,000 micro-lamports at 400,000 units (80,000 lamports)", withPrice(200_000n), /priority fee/],
        ["the third review's 25,000,000,000 micro-lamports at 400,000 units (10 SOL)", withPrice(25_000_000_000n), /priority fee/],
        ["u64-max price at 1,400,000 units", withPrice(0xffff_ffff_ffff_ffffn, 1_400_000), /priority fee/],
        ["a limit of 1,400,001 units", withPrice(0n, 1_400_001), /compute unit limit/],
      ] as const) {
        const dtx = await make();
        const prepared = prepareForWallet(c.address, dtx, await lifetime(), BUDGET);
        const returned = await walletSigns(prepared.transaction, c, mutate);
        ok(`wallet returns ${label}: finish refuses`, await throws(() => prepared.finish(returned), pattern));
      }
      {
        const dtx = await make();
        const prepared = prepareForWallet(c.address, dtx, await lifetime(), BUDGET);
        const noLimit = await walletSigns(prepared.transaction, c, (m) => ({ ...m, instructions: m.instructions.filter((ix) =>
          !(m.staticAccounts[ix.programAddressIndex] === COMPUTE_BUDGET_PROGRAM && ix.data?.[0] === 2)) }));
        ok("wallet drops SetComputeUnitLimit (the default 200,000 per instruction then bounds the fee): accepted", !(await throws(() => prepared.finish(noLimit))));
      }
      // The wallet's own signature, verified before any local key signs.
      {
        const dtx = await make();
        const prepared = prepareForWallet(c.address, dtx, await lifetime(), BUDGET);
        const returned = await walletSigns(prepared.transaction, c);
        const zeroed = { ...returned, signatures: { ...returned.signatures, [c.address]: new Uint8Array(64) } } as unknown as Transaction;
        const other = await generateKeyPairSigner();
        const byOther = { ...returned, signatures: { ...returned.signatures, [c.address]: await signBytes(other.keyPair.privateKey, returned.messageBytes) } } as unknown as Transaction;
        const over = await walletSigns(prepared.transaction, c);
        const stale = { ...over, signatures: { ...over.signatures, [c.address]: await signBytes(c.keyPair.privateKey, prepared.transaction.messageBytes) } } as unknown as Transaction;
        const unsigned = { messageBytes: returned.messageBytes, signatures: Object.fromEntries(Object.keys(returned.signatures).map((k) => [k, null])) } as unknown as Transaction;
        ok("finish refuses a zeroed wallet signature, one by another key, one over the unrewritten message, and none",
          await throws(() => prepared.finish(zeroed), /does not verify/) && await throws(() => prepared.finish(byOther), /does not verify/) &&
          await throws(() => prepared.finish(stale), /does not verify/) && await throws(() => prepared.finish(unsigned), /does not verify/));
        const done = await prepared.finish(returned);
        const verifies = (k: KeyPairSigner) => ed25519.verify(done.signatures[k.address] as Uint8Array, new Uint8Array(returned.messageBytes), keyBytes(k.address));
        ok("finish signs exactly the bytes the wallet returned with every local key (ed25519 verifies), keeping the wallet's signature",
          dtx.localSigners.every(verifies) && done.messageBytes === returned.messageBytes && done.signatures[c.address] === returned.signatures[c.address]);
      }
    }

    // 12. The third review's cases.
    console.log("\n12. a real claim message against every change a wallet could make; Core collections; duplicate numbers; classification");
    {
      const e = await publish(terms(40, { kind: "sol", lamports: 5_000_000n }));
      const c = await wallet();
      const v = await edition(e);
      const cost = await claimCost(v, rent);
      const asset = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const dtx = (await claimDraft({ edition: v, counter: null, cost, collector: c.address, asset, payer })).transactions[0];
      const prepared = prepareForWallet(c.address, dtx, await lifetime(), BUDGET);
      const orig = new Uint8Array(prepared.transaction.messageBytes);
      const m0 = messageDecoder.decode(orig) as Compiled;
      const idx = (k: Address) => m0.staticAccounts.indexOf(k);
      const { numSignerAccounts: S, numReadonlySignerAccounts: RS, numReadonlyNonSignerAccounts: RO } = m0.header;
      const N = m0.staticAccounts.length;
      const mintAt = m0.instructions.findIndex((ix) => m0.staticAccounts[ix.programAddressIndex] === CANDY_GUARD_PROGRAM);
      const writableNonSigner = Array.from({ length: N - RO - S }, (_, i) => S + i);
      const readonlyNonSigner = Array.from({ length: RO }, (_, i) => N - RO + i);
      const ident = Array.from({ length: N }, (_, i) => i);
      const swap = (o: number[], x: number, y: number) => { const z = [...o]; [z[x], z[y]] = [z[y], z[x]]; return z; };
      const isB = (m: Compiled, ix: Compiled["instructions"][number], kind: number) => m.staticAccounts[ix.programAddressIndex] === COMPUTE_BUDGET_PROGRAM && ix.data?.[0] === kind;
      const limitData = (x: number) => new Uint8Array([2, ...u32le(x)]);
      const permute = (m: Compiled, order: number[]): Compiled => {
        const at = new Map(order.map((old, i) => [old, i]));
        return { ...m, staticAccounts: order.map((i) => m.staticAccounts[i]),
          instructions: m.instructions.map((ix) => ({ ...ix, programAddressIndex: at.get(ix.programAddressIndex)!, accountIndices: ix.accountIndices?.map((i) => at.get(i)!) })) };
      };
      const fee = { reviewedMicroLamports: BUDGET.microLamports, feeAllowanceLamports: 50_000n };
      const cases: [string, (m: Compiled) => Compiled, boolean][] = [
        ["unchanged", (m) => m, true],
        ["only the price (x1000)", (m) => ({ ...m, instructions: m.instructions.map((ix) => isB(m, ix, 3) ? { ...ix, data: priceData(7_000n) } : ix) }), true],
        ["only the limit", (m) => ({ ...m, instructions: m.instructions.map((ix) => isB(m, ix, 2) ? { ...ix, data: limitData(250_000) } : ix) }), true],
        ["accounts reordered within each role", (m) => permute(m, [0, ...ident.slice(1, S - RS).reverse(), ...ident.slice(S - RS, S).reverse(), ...[...writableNonSigner].reverse(), ...[...readonlyNonSigner].reverse()]), true],
        ["budget instructions moved to the end", (m) => ({ ...m, instructions: [...m.instructions.slice(2), ...m.instructions.slice(0, 2)] }), true],
        ["SetComputeUnitPrice removed", (m) => ({ ...m, instructions: m.instructions.filter((ix) => !isB(m, ix, 3)) }), true],
        ["price u64 max and limit 1,400,000", (m) => ({ ...m, instructions: m.instructions.map((ix) => isB(m, ix, 3) ? { ...ix, data: priceData(0xffff_ffff_ffff_ffffn) } : isB(m, ix, 2) ? { ...ix, data: limitData(1_400_000) } : ix) }), false],
        ["an instruction duplicated (the mint twice)", (m) => ({ ...m, instructions: [...m.instructions, m.instructions[mintAt]] }), false],
        ["an instruction removed (the Allocate)", (m) => ({ ...m, instructions: m.instructions.slice(0, -1) }), false],
        ["two instructions reordered (Allocate before the mint)", (m) => ({ ...m, instructions: [...m.instructions.slice(0, mintAt), m.instructions[mintAt + 1], m.instructions[mintAt]] }), false],
        ["instruction data changed (Allocate size)", (m) => ({ ...m, instructions: m.instructions.map((ix, i) => i === m.instructions.length - 1 ? { ...ix, data: new Uint8Array([8, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) } : ix) }), false],
        ["an account swapped at the same position (collection -> candy machine)", (m) => ({ ...m, instructions: m.instructions.map((ix, i) => i === mintAt ? { ...ix, accountIndices: ix.accountIndices!.map((x) => x === idx(e.collection) ? idx(e.candyMachine) : x) } : ix) }), false],
        ["a writable and a read-only account trade places", (m) => ({ ...m, staticAccounts: swap(m.staticAccounts as unknown as number[], writableNonSigner[0], readonlyNonSigner[0]) as unknown as typeof m.staticAccounts }), false],
        ["the one-shot payer made fee payer", (m) => permute(m, swap(ident, 0, idx(payer.address))), false],
        ["an address lookup table", (m) => ({ ...m, addressTableLookups: [{ lookupTableAddress: e.collection, writableIndexes: [], readonlyIndexes: [0] }] }), false],
        ["a different blockhash", (m) => ({ ...m, lifetimeToken: e.candyGuard as unknown as typeof m.lifetimeToken }), false],
        ["an extra required signer", (m) => ({ ...m, header: { ...m.header, numSignerAccounts: S + 1 } }), false],
        ["RequestHeapFrame added", (m) => ({ ...m, instructions: [{ programAddressIndex: m.staticAccounts.indexOf(COMPUTE_BUDGET_PROGRAM), accountIndices: [], data: new Uint8Array([1, 0, 0, 4, 0]) }, ...m.instructions] }), false],
        ["a budget instruction carrying an account", (m) => ({ ...m, instructions: m.instructions.map((ix) => isB(m, ix, 3) ? { ...ix, accountIndices: [0] } : ix) }), false],
        ["a second SetComputeUnitLimit", (m) => ({ ...m, instructions: [m.instructions[0], ...m.instructions] }), false],
      ];
      for (const [label, f, accept] of cases) {
        let bytes: Uint8Array | null = null;
        try { bytes = new Uint8Array(messageEncoder.encode(f(messageDecoder.decode(orig) as Compiled))); } catch { bytes = null; }
        const why = bytes ? sameMeaning(orig, bytes, fee) : "could not encode";
        ok(`${label}: ${why === null ? "accepted" : `refused (${why})`}`, (why === null) === accept);
      }
      {
        const legacy = new Uint8Array(orig);
        legacy[0] = 0x01; // a legacy message starts with the header, not the 0x80 version byte
        ok("a legacy (unversioned) message: refused", sameMeaning(orig, legacy, fee) !== null);
      }

      // Core collections from a publisher's own transaction 1.
      const pair = (plugin: number[], auth: number[]) => [...plugin, 1, ...auth];
      const variants: [string, (t: EditionTerms, p: Uint8Array) => number[], boolean][] = [
        ["Royalties RuleSet ProgramDenyList([])", (t, p) => [1, ...strArr(t.title), ...strArr(t.uri), 1, ...u32le(2), ...pair([10, 1, ...u32le(5), 0, 0], [0]), ...pair([0, 0xf4, 1, ...u32le(1), ...p, 100, 2, ...u32le(0)], [0])], false],
        ["MasterEdition authority Address(publisher)", (t, p) => [1, ...strArr(t.title), ...strArr(t.uri), 1, ...u32le(2), ...pair([10, 1, ...u32le(5), 0, 0], [3, ...p]), ...pair([0, 0xf4, 1, ...u32le(1), ...p, 100, 0], [0])], false],
        ["UpdateDelegate pre-created with authority Address(publisher)", (t, p) => [1, ...strArr(t.title), ...strArr(t.uri), 1, ...u32le(3), ...pair([10, 1, ...u32le(5), 0, 0], [0]), ...pair([0, 0xf4, 1, ...u32le(1), ...p, 100, 0], [0]), ...pair([4, ...u32le(0)], [3, ...p])], false],
        ["plugins in the other order (Royalties first)", (t, p) => [1, ...strArr(t.title), ...strArr(t.uri), 1, ...u32le(2), ...pair([0, 0xf4, 1, ...u32le(1), ...p, 100, 0], [0]), ...pair([10, 1, ...u32le(5), 0, 0], [0])], true],
        ["CreateCollectionV2 with an AppData adapter (data authority the publisher)", (t, p) => [21, ...strArr(t.title), ...strArr(t.uri), 1, ...u32le(2), ...pair([10, 1, ...u32le(5), 0, 0], [0]), ...pair([0, 0xf4, 1, ...u32le(1), ...p, 100, 0], [0]), 1, ...u32le(1), 2, 3, ...p, 0, 0], false],
      ];
      for (const [label, data, accept] of variants) {
        const t = terms(5);
        const ed = await build(t);
        ed.tx[0] = { ...ed.tx[0], instructions: [{ ...ed.tx[0].instructions[0], data: new Uint8Array(data(t, keyBytes(ed.publisher.address))) }, ...ed.tx[0].instructions.slice(1)] };
        await run(ed);
        const vv = allOk(ed) ? await verdict(ed) : null;
        ok(`Core collection with ${label}: ${allOk(ed) ? `lands; readEdition ${vv!.ok ? "accepts" : `refuses (${(vv as { reason: string }).reason})`}` : "publish fails"}`,
          allOk(ed) ? vv!.ok === accept : !accept, firstBad(ed.outcomes));
      }

      // Duplicate Edition numbers through the guard authority, and copyAnomalies.
      {
        const ed = await publish(terms(9));
        const p = ed.publisher;
        const ca = await claim(ed, await wallet());
        const shifted = { default: { mintLimit: { id: 0, limit: 1 }, edition: { editionStartOffset: 1 } }, groups: [] };
        const up = await submit(p, { instructions: [updateCandyGuardInstruction({ candyGuard: ed.candyGuard, authority: p, payer: p, guards: shifted })], localSigners: [] });
        const own = await generateKeyPairSigner();
        const self = await submit(p, { instructions: [await mintInstruction({ candyMachine: ed.candyMachine, candyGuard: ed.candyGuard, collection: ed.collection, guards: shifted, payer: p, minter: p, asset: own })], localSigners: [own] });
        const back = await submit(p, { instructions: [updateCandyGuardInstruction({ candyGuard: ed.candyGuard, authority: p, payer: p, guards: await editionGuards(p.address, { kind: "free" }, null) })], localSigners: [] });
        const cb = await claim(ed, await wallet());
        const vd = await verdict(ed);
        const copies = (await Promise.all([ed.copy1, ca.asset, own.address, cb.asset].map(async (k) => readCopy((await read(k))!, ed.collection)))).filter((x): x is CopyView => x !== null);
        const anomalies = copyAnomalies({ title: ed.terms.title, minted: vd.ok ? vd.minted : 0 }, copies);
        const dup = anomalies.find((x) => x.kind === "duplicate-number");
        ok(`offset shifted, the publisher mints their own copy, offset restored: readEdition still accepts (it cannot see copies); copies read ${copies.map((x) => `'${x.name}'=#${x.edition}`).join(", ")}`,
          up.ok && self.ok && back.ok && ca.outcome.ok && cb.outcome.ok && vd.ok && copies.length === 4, firstBad([up, self, back, ca.outcome, cb.outcome]));
        ok(`copyAnomalies reports the duplicate number ${dup && "number" in dup ? dup.number : "?"} and the name that disagrees with its number`,
          dup?.kind === "duplicate-number" && dup.number === 4 && dup.copies.length === 2 &&
          anomalies.some((x) => x.kind === "name-mismatch" && x.copy === own.address && x.number === 4));
        ok("copyAnomalies on the consistent copies alone: none", copyAnomalies({ title: ed.terms.title, minted: 4 },
          copies.filter((x) => x.address !== own.address).map((x, i) => (i === 2 ? { ...x, name: `${ed.terms.title} #3`, edition: 3 } : x))).length === 0);
        const synthetic = copyAnomalies({ title: "T", minted: 2 }, [
          { address: a.address, name: "T #1", edition: 1 }, { address: c.address, name: "T #3", edition: 3 },
          { address: e.collection, name: "T #null", edition: null },
        ]);
        ok("copyAnomalies: more copies than minted, a number past minted, a copy with no Edition number",
          synthetic.some((x) => x.kind === "too-many-copies") && synthetic.some((x) => x.kind === "number-out-of-range" && x.number === 3) &&
          synthetic.some((x) => x.kind === "number-out-of-range" && x.number === null));
      }

      // Classification keys on the program and its own log, not the bare code.
      {
        const ctx = { accountKeys: [] as Address[], wallet: SYSTEM_PROGRAM, payer: SYSTEM_PROGRAM };
        const inGuard = (code: number, extra: string[] = []) => ({ err: `InstructionError(3, Custom(${code}))`, custom: { code },
          logs: [`Program ${CANDY_GUARD_PROGRAM} invoke [1]`, ...extra, `Program ${CANDY_GUARD_PROGRAM} failed: custom program error`] });
        const rows: [string, string, string][] = [
          ["Core error 1 (DeserializationError) inside the mint", classifyClaimFailure(inGuard(1, [`Program ${MPL_CORE} invoke [3]`, `Program ${MPL_CORE} failed: custom program error: 0x1`]), ctx), "other"],
          ["Core error 17 inside the mint", classifyClaimFailure(inGuard(17, [`Program ${MPL_CORE} invoke [3]`]), ctx), "other"],
          ["candy machine 6006 with its log truncated", classifyClaimFailure(inGuard(6006, ["Log truncated"]), ctx), "other"],
          ["System 1 with 'Transfer: insufficient lamports'", classifyClaimFailure(inGuard(1, ["Transfer: insufficient lamports 5, need 10"]), ctx), "terms-changed"],
          ["Token 17 with 'Account is frozen'", classifyClaimFailure(inGuard(17, ["Program log: Error: Account is frozen"]), ctx), "publisher-cannot-receive"],
        ];
        for (const [label, got, want] of rows) ok(`classify ${label} -> ${got}`, got === want);
      }
    }
  } finally {
    host.close();
  }
  console.log("\nMeasured (every transaction with SetComputeUnitLimit + SetComputeUnitPrice, as the wallet returned it):");
  for (const l of lines) console.log(`  ${l}`);
}

/** The publisher as a signer meta for a hand-built instruction inside a draft (the wallet signs for it). */
const createNoopSignerFor = (k: KeyPairSigner): TransactionSigner => k;

void main().then(
  () => {
    console.log(failures ? `\n${failures} check(s) failed, ${passes} passed.` : `\ncandy SVM suite passed (${passes} checks).`);
    process.exit(failures ? 1 : 0);
  },
  (error) => { console.error(error); process.exit(1); },
);
