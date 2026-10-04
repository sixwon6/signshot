/**
 * The built `era_editions` ELFs, run end to end in LiteSVM: `npm run test:svm`. Not part of
 * `npm test`, because it needs the ELFs and, on its first run, builds the LiteSVM host and reads
 * Metaplex Core and a Seeker Genesis Token from mainnet (read only, cached in `.cache/svm/`).
 *
 *   npm run test:svm -- --plain <elf> --plain-id <address> [--devnet <elf> --devnet-id <address>]
 *   npm run test:svm -- --devnet <elf> --devnet-id <address>      (a devnet-genesis build alone)
 *   env: SVM_PLAIN_ELF SVM_PLAIN_ID SVM_DEVNET_ELF SVM_DEVNET_ID SVM_TOOLS_ROOT SVM_HOST SVM_MAINNET_RPC
 *   With no ELF named it builds nothing and skips.
 *   Delete `.cache/svm/` to read mainnet again (after a Metaplex Core upgrade, say).
 *
 * The `litesvm` npm package ships no Windows binary, so LiteSVM runs as `programs/svm` (the Rust
 * crate, built with `build-native-windows.ps1` on the pinned toolchain) and this script drives it
 * line by line. Every `era_editions` instruction comes from `publications/core/editionsProgram.ts`,
 * is compiled and signed with @solana/kit and runs with signature checks on; Core accounts are
 * decoded here. Token-2022 and the associated-token program are the builds LiteSVM carries;
 * Metaplex Core is mainnet's.
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
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  some,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  getCreateAssociatedTokenIdempotentInstruction,
  getFreezeAccountInstruction,
  getInitializeGroupMemberPointerInstruction,
  getInitializeMetadataPointerInstruction,
  getInitializeMint2Instruction,
  getInitializeMultisigInstruction,
  getInitializeTokenGroupMemberInstruction,
  getMintSize,
  getMintToInstruction,
  getMultisigSize,
  getThawAccountInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import {
  EDITIONS_ERROR_CODES as E,
  EDITION_ACCOUNT_BYTES,
  MPL_CORE,
  SYSTEM_PROGRAM,
  claimInstruction,
  claimantOf,
  decodeEdition,
  printAddress,
  publicationAddresses,
  publishInstruction,
  setPriceInstruction,
  type GenesisAccounts,
} from "../publications/core/editionsProgram";
import { SGT_GROUP_ADDRESS, isSeekerGenesisMint } from "../publications/core/genesisToken";
import {
  assertMemberDecodes,
  devnetGenesisKeys,
  genesisTokenAccount,
  groupInstructions,
  memberInstructions,
} from "../publications/devnet/genesisFixture";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// --- What runs ------------------------------------------------------------------------------------

const option = (flag: string, variable: string) => {
  const at = process.argv.indexOf(flag);
  return (at >= 0 ? process.argv[at + 1] : process.env[variable]) || undefined;
};
function named(kind: "plain" | "devnet"): { elf: string; id: Address } | null {
  const upper = kind.toUpperCase();
  const elf = option(`--${kind}`, `SVM_${upper}_ELF`);
  const id = option(`--${kind}-id`, `SVM_${upper}_ID`);
  if (!elf) return null;
  if (!id) throw new Error(`--${kind} needs --${kind}-id: the address that ELF's declare_id! names.`);
  if (!existsSync(elf)) throw new Error(`No ELF at ${elf}`);
  return { elf: resolve(elf), id: address(id) };
}

// --- The LiteSVM host -----------------------------------------------------------------------------

const HOST_ROOT = join(root, "programs", "svm");

function hostExecutable(): string {
  if (process.env.SVM_HOST) return process.env.SVM_HOST;
  const cargoArgs = ["build", "--release", "--locked"];
  console.log("Building the LiteSVM host (programs/svm; the first build takes a minute or two)...");
  const run = process.platform === "win32"
    ? spawnSync("pwsh", ["-NoProfile", "-Command",
      `& '${join(root, "programs", "editions", "scripts", "build-native-windows.ps1")}'` +
      ` -ToolsRoot '${process.env.SVM_TOOLS_ROOT ?? join(process.env.LOCALAPPDATA ?? tmpdir(), "ssbt")}'` +
      ` -ProgramRoot '${HOST_ROOT}' -CargoArgs @(${cargoArgs.map((a) => `'${a}'`).join(",")})`], { encoding: "utf8" })
    : spawnSync("cargo", cargoArgs, { cwd: HOST_ROOT, encoding: "utf8" });
  if (run.status !== 0) {
    console.error(run.stdout, run.stderr, run.error ?? "");
    throw new Error("The LiteSVM host did not build.");
  }
  return join(HOST_ROOT, "target", "release", process.platform === "win32" ? "svm-host.exe" : "svm-host");
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
  // Replies come back in request order, so a queue of resolvers pairs them.
  async call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const line = await new Promise<string>((done) => {
      this.waiting.push(done);
      this.child.stdin.write(`${JSON.stringify({ op, ...args })}\n`);
    });
    const reply = JSON.parse(line) as { result?: T; error?: string };
    if (reply.error !== undefined) throw new Error(`svm ${op}: ${reply.error}`);
    return reply.result as T;
  }
  close() {
    this.child.stdin.end();
  }
}

let host: Host;

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytesOf = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const keyBytes = (key: string) => new Uint8Array(getAddressEncoder().encode(address(key)));
const keyOf = (bytes: Uint8Array) => getAddressDecoder().decode(bytes);

interface Chain { lamports: bigint; owner: Address; executable: boolean; bytes: Uint8Array }

async function read(key: string): Promise<Chain | null> {
  const found = await host.call<null | { lamports: string; owner: string; executable: boolean; data: string }>(
    "get", { address: hexOf(keyBytes(key)) });
  return found && {
    lamports: BigInt(found.lamports), owner: keyOf(bytesOf(found.owner)),
    executable: found.executable, bytes: bytesOf(found.data),
  };
}
async function write(key: string, account: { lamports: bigint; owner: string; bytes: Uint8Array }) {
  await host.call("set", {
    address: hexOf(keyBytes(key)), lamports: account.lamports.toString(),
    owner: hexOf(keyBytes(account.owner)), data: hexOf(account.bytes), executable: false,
  });
}
const rent = async (length: number) => BigInt(await host.call<string>("rent", { len: length }));
const balance = async (key: string) => (await read(key))?.lamports ?? 0n;

const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
/** The Clock sysvar's `unix_timestamp` as last set here: what `published_at` must equal. */
let clockTime = 0n;
/**
 * Sets the Clock sysvar's `unix_timestamp`, which LiteSVM starts at 0: the last of its five
 * 8-byte fields (slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp).
 */
async function setClock(unixTimestamp: bigint) {
  const clock = await read(CLOCK);
  if (!clock || clock.bytes.length !== 40) throw new Error("No Clock sysvar to set");
  const bytes = new Uint8Array(clock.bytes);
  new DataView(bytes.buffer).setBigInt64(32, unixTimestamp, true);
  await write(CLOCK, { lamports: clock.lamports, owner: clock.owner, bytes });
  clockTime = unixTimestamp;
}

async function wallet(): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  await host.call("airdrop", { address: hexOf(keyBytes(signer.address)), lamports: "10000000000" });
  return signer;
}

interface Outcome {
  ok: boolean;
  err?: string;
  custom?: { index: number; code: number } | null;
  logs: string[];
  units: number;
}

/**
 * One v0 transaction, as the app sends one: the payer's wallet signs, plus any signer an
 * instruction carries. A compute limit of 400,000 (the app's ceiling) unless `budget` is false.
 */
async function send(payer: KeyPairSigner, instructions: Instruction[], budget = true): Promise<Outcome> {
  const recent = getBase58Decoder().decode(bytesOf(await host.call<string>("blockhash")));
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(recent), lastValidBlockHeight: 0n }, m),
    (m) => appendTransactionMessageInstructions(
      budget ? [getSetComputeUnitLimitInstruction({ units: 400_000 }), ...instructions] : instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  return host.call<Outcome>("send", { tx: hexOf(new Uint8Array(Buffer.from(getBase64EncodedWireTransaction(signed), "base64"))) });
}

// The genesis fixture reads accounts and rent over JSON-RPC; this answers it from the SVM.
const SVM_RPC = "http://litesvm.invalid";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input) !== SVM_RPC) return realFetch(input, init);
  const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
  const context = { slot: 1 };
  const view = async (key: string) => {
    const found = await read(key);
    return found && {
      owner: found.owner, executable: found.executable, lamports: Number(found.lamports), rentEpoch: 0,
      space: found.bytes.length, data: [Buffer.from(found.bytes).toString("base64"), "base64"],
    };
  };
  const result =
    method === "getAccountInfo" ? { context, value: await view(params[0] as string) }
    : method === "getMultipleAccounts" ? { context, value: await Promise.all((params[0] as string[]).map(view)) }
    : method === "getMinimumBalanceForRentExemption" ? Number(await rent(params[0] as number))
    : undefined;
  const body = result === undefined
    ? { jsonrpc: "2.0", id, error: { code: -32601, message: `${method} is not answered from the SVM` } }
    : { jsonrpc: "2.0", id, result };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

// --- Mainnet, read once ---------------------------------------------------------------------------

const MAINNET_RPC = process.env.SVM_MAINNET_RPC ?? "https://api.mainnet.solana.com";
const CACHE = join(root, ".cache", "svm");
const CORE_ELF = join(CACHE, "mpl-core.so");
const MAINNET_FILE = join(CACHE, "mainnet.json");
const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111";
// A real Seeker Genesis Token and its holder; the first read refuses if the token has moved.
const SGT_MINT = address("21Q8vbf36J9vJ6DDkUBjC29BKYMQdKZ5fs9LcJZQY4qH");
const SGT_HOLDER = address("CEQ6CHRGVdAzMj7upcnjrRB7y6utcaX8zd331ML6KwqG");
const GT22 = address(SGT_GROUP_ADDRESS);
const T22 = TOKEN_2022_PROGRAM_ADDRESS;

interface Dumped { address: string; lamports: string; owner: string; data: string }
interface Mainnet {
  rpc: string;
  readAt: string;
  rentMin0: string;
  core: { programData: string; slot: string; bytes: number; sha256: string };
  sgtMint: Dumped;
  sgtToken: Dumped;
  sgtGroup: Dumped;
}

async function mainnetCall<T>(method: string, params: unknown[]): Promise<T> {
  const response = await realFetch(MAINNET_RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (!response.ok || body.error || body.result === undefined)
    throw new Error(`${method}: ${JSON.stringify(body.error ?? response.status)}`);
  return body.result;
}
type RpcAccount = { lamports: number; owner: string; data: [string, string] };
const dumped = (key: string, account: RpcAccount): Dumped => ({
  address: key, lamports: String(account.lamports), owner: account.owner,
  data: Buffer.from(account.data[0], "base64").toString("hex"),
});
async function dump(key: string): Promise<Dumped> {
  const { value } = await mainnetCall<{ value: RpcAccount | null }>("getAccountInfo", [key, { encoding: "base64" }]);
  if (!value) throw new Error(`Nothing at ${key} on mainnet`);
  return dumped(key, value);
}

async function mainnet(): Promise<Mainnet> {
  if (existsSync(MAINNET_FILE) && existsSync(CORE_ELF)) return JSON.parse(readFileSync(MAINNET_FILE, "utf8")) as Mainnet;
  console.log(`Reading Metaplex Core and a Seeker Genesis Token from ${MAINNET_RPC} (read only, once)...`);
  // UpgradeableLoaderState: Program is tag 2 then the ProgramData address; ProgramData is tag 3,
  // the u64 slot and the Option<Pubkey> authority (45 bytes), then the ELF.
  const program = await dump(MPL_CORE);
  const programBytes = bytesOf(program.data);
  if (program.owner !== LOADER_V3 || programBytes[0] !== 2) throw new Error("Metaplex Core is not an upgradeable program");
  const programData = keyOf(programBytes.subarray(4, 36));
  const data = bytesOf((await dump(programData)).data);
  if (data[0] !== 3) throw new Error("Not a ProgramData account");
  const elf = data.subarray(45);
  const held = await mainnetCall<{ value: { pubkey: string; account: RpcAccount }[] }>(
    "getTokenAccountsByOwner", [SGT_HOLDER, { mint: SGT_MINT }, { encoding: "base64" }]);
  if (held.value.length !== 1) throw new Error(`${SGT_HOLDER} no longer holds ${SGT_MINT} in one account`);
  const record: Mainnet = {
    rpc: MAINNET_RPC,
    readAt: new Date().toISOString(),
    rentMin0: String(await mainnetCall<number>("getMinimumBalanceForRentExemption", [0])),
    core: {
      programData,
      slot: new DataView(data.buffer, data.byteOffset).getBigUint64(4, true).toString(),
      bytes: elf.length,
      sha256: createHash("sha256").update(elf).digest("hex"),
    },
    sgtMint: await dump(SGT_MINT),
    sgtToken: dumped(held.value[0].pubkey, held.value[0].account),
    sgtGroup: await dump(GT22),
  };
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(CORE_ELF, elf);
  writeFileSync(MAINNET_FILE, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

// --- Metaplex Core accounts, decoded here --------------------------------------------------------

/** A bounds-checked little-endian cursor. */
function cursor(bytes: Uint8Array, start = 0) {
  let at = start;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (n: number) => { if (at + n > bytes.length) throw new Error("Truncated Core account"); const was = at; at += n; return was; };
  const c = {
    u8: () => bytes[need(1)],
    u16: () => view.getUint16(need(2), true),
    u32: () => view.getUint32(need(4), true),
    u64: () => view.getBigUint64(need(8), true),
    key: () => { const was = need(32); return keyOf(bytes.subarray(was, was + 32)); },
    text: () => { const n = c.u32(); const was = need(n); return new TextDecoder().decode(bytes.subarray(was, was + n)); },
    get at() { return at; },
  };
  return c;
}

const AUTHORITY = ["None", "Owner", "UpdateAuthority", "Address"] as const;
type Plugin =
  | { type: "MasterEdition"; authority: string; maxSupply: number | null }
  | { type: "ImmutableMetadata"; authority: string }
  | { type: "Attributes"; authority: string; attributes: { key: string; value: string }[] }
  | { type: "Royalties"; authority: string; basisPoints: number; creators: { address: Address; percentage: number }[]; ruleSet: number }
  | { type: "Edition"; authority: string; number: number }
  | { type: "Other"; authority: string; id: number };

/** `PluginHeaderV1` at `base`, then `PluginRegistryV1` and the plugins it points at. */
function plugins(bytes: Uint8Array, base: number): Plugin[] {
  if (bytes.length === base) return [];
  const header = cursor(bytes, base);
  if (header.u8() !== 3) throw new Error("No plugin header");
  const registry = cursor(bytes, Number(header.u64()));
  if (registry.u8() !== 4) throw new Error("No plugin registry");
  const count = registry.u32();
  const out: Plugin[] = [];
  for (let i = 0; i < count; i += 1) {
    registry.u8(); // plugin type
    const tag = registry.u8();
    if (tag === 3) registry.key();
    const authority = AUTHORITY[tag];
    const p = cursor(bytes, Number(registry.u64()));
    const id = p.u8();
    if (id === 10) {
      const maxSupply = p.u8() ? p.u32() : null;
      out.push({ type: "MasterEdition", authority, maxSupply });
    } else if (id === 12) out.push({ type: "ImmutableMetadata", authority });
    else if (id === 6) {
      const n = p.u32();
      const attributes = Array.from({ length: n }, () => ({ key: p.text(), value: p.text() }));
      out.push({ type: "Attributes", authority, attributes });
    } else if (id === 0) {
      const basisPoints = p.u16();
      const n = p.u32();
      const creators = Array.from({ length: n }, () => ({ address: p.key(), percentage: p.u8() }));
      out.push({ type: "Royalties", authority, basisPoints, creators, ruleSet: p.u8() });
    } else if (id === 9) out.push({ type: "Edition", authority, number: p.u32() });
    else out.push({ type: "Other", authority, id });
  }
  return out;
}

/** Core `CollectionV1` (key 5). */
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

/** Core `AssetV1` (key 1). */
function decodeAsset(bytes: Uint8Array) {
  const c = cursor(bytes);
  if (c.u8() !== 1) throw new Error("Not a Core asset");
  const owner = c.key();
  const kind = c.u8();
  const updateAuthority = kind === 0 ? null : c.key();
  const name = c.text();
  const uri = c.text();
  if (c.u8()) c.u64(); // seq
  return { owner, updateKind: kind, updateAuthority, name, uri, plugins: plugins(bytes, c.at) };
}

const pluginOf = <T extends Plugin["type"]>(list: Plugin[], type: T) =>
  list.find((p): p is Extract<Plugin, { type: T }> => p.type === type);

// Core instructions the suite sends by hand, in the `mpl-core` crate builders' account order.
// An absent optional account is Core's own id.
const coreTransfer = (asset: string, collection: string, owner: Address, to: Address): Instruction => ({
  programAddress: MPL_CORE,
  accounts: [
    { address: address(asset), role: AccountRole.WRITABLE },
    { address: address(collection), role: AccountRole.READONLY },
    { address: owner, role: AccountRole.WRITABLE_SIGNER },
    { address: owner, role: AccountRole.READONLY_SIGNER },
    { address: to, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    { address: MPL_CORE, role: AccountRole.READONLY },
  ],
  data: new Uint8Array([14, 0]), // TransferV1, compression_proof None
});
const coreBurn = (asset: string, collection: string, owner: Address): Instruction => ({
  programAddress: MPL_CORE,
  accounts: [
    { address: address(asset), role: AccountRole.WRITABLE },
    { address: address(collection), role: AccountRole.WRITABLE },
    { address: owner, role: AccountRole.WRITABLE_SIGNER },
    { address: owner, role: AccountRole.READONLY_SIGNER },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    { address: MPL_CORE, role: AccountRole.READONLY },
  ],
  data: new Uint8Array([12, 0]), // BurnV1, compression_proof None
});
/** Core's permissionless fee sweep, `Collect` (19), with the two recipients its builder defaults to. */
const coreCollect = (asset: string): Instruction => ({
  programAddress: MPL_CORE,
  accounts: [
    { address: address("8AT6o8Qk5T9QnZvPThMrF9bcCQLTGkyGvVZZzHgCw11v"), role: AccountRole.WRITABLE },
    { address: address("MmHsqX4LxTfifxoH8BVRLUKrwDn1LPCac6YcCZTHhwt"), role: AccountRole.WRITABLE },
    { address: address(asset), role: AccountRole.WRITABLE },
  ],
  data: new Uint8Array([19]),
});

// --- Checks ---------------------------------------------------------------------------------------

let failures = 0;
// Where Anchor says it threw, so a refusal line names the check that refused.
const thrownAt = (o: Outcome) => o.logs.map((l) => /AnchorError (?:thrown in|caused by account: )(\S+(?::\d+)?)/.exec(l)?.[1]).find(Boolean);
const seen = (o: Outcome) => o.ok ? `ok, ${o.units} CU`
  : o.custom ? `error ${o.custom.code}${thrownAt(o) ? ` at ${thrownAt(o)}` : ""}` : o.err ?? "failed";
function ok(name: string, condition: boolean, outcome?: Outcome) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${outcome ? ` [${seen(outcome)}]` : ""}`);
  if (!condition) {
    failures += 1;
    if (outcome) console.log([outcome.err ?? "", ...outcome.logs.slice(-14)].map((l) => `      | ${l}`).join("\n"));
  }
}
const refused = (o: Outcome, code: number) => !o.ok && o.custom?.code === code;
const settles = async (label: string, o: Promise<Outcome>) => {
  const outcome = await o;
  if (!outcome.ok) ok(`setup: ${label}`, false, outcome);
  return outcome.ok;
};

// Anchor 1.1.2 (`anchor-lang-error`).
const A = {
  ConstraintHasOne: 2001, ConstraintSeeds: 2006, ConstraintOwner: 2004, ConstraintAddress: 2012,
  AccountNotEnoughKeys: 3005, AccountOwnedByWrongProgram: 3007, AccountNotSigner: 3010,
  DeclaredProgramIdMismatch: 4100,
} as const;
/** The System program's `AccountAlreadyInUse`, what Anchor's `init` answers for an existing account. */
const ACCOUNT_ALREADY_IN_USE = 0;

/** Measured once per build and printed at the end. */
const measured: Record<string, number | bigint | string> = {};

// --- Editions --------------------------------------------------------------------------------------

const arweave = () => `https://arweave.net/${randomBytes(32).toString("base64url")}`;
const hex32 = () => randomBytes(32).toString("hex");
let made = 0;

interface Draft {
  program: Address;
  creator: KeyPairSigner;
  nonce: string;
  title: string;
  uri: string;
  metadataHash: string;
  imageHash: string;
  supply: number;
  royaltyBps: number;
  seekerOnly: boolean;
  price: bigint;
  genesis?: GenesisAccounts;
  collection: Address;
  edition: Address;
  /** Copy 1's address. */
  print: Address;
}

type Terms = Partial<Pick<Draft, "royaltyBps" | "seekerOnly" | "price" | "genesis" | "title" | "uri" | "supply">>;

async function draft(program: Address, creator: KeyPairSigner, supply: number, terms: Terms = {}): Promise<Draft> {
  made += 1;
  const nonce = hex32();
  const seekerOnly = terms.seekerOnly ?? false;
  const k = await publicationAddresses(program, creator.address, nonce,
    claimantOf(creator.address, seekerOnly, terms.genesis?.mint));
  return {
    program, creator, nonce, supply, seekerOnly,
    // Two digits, so every title is the same length and every copy's Core asset the same size.
    title: `Moment ${String(made % 100).padStart(2, "0")}`,
    uri: arweave(), metadataHash: hex32(), imageHash: hex32(), royaltyBps: 500, price: 0n,
    ...terms,
    ...k,
  };
}

const publishIx = (d: Draft) => publishInstruction({
  program: d.program, creator: d.creator.address, nonce: d.nonce, title: d.title, uri: d.uri,
  metadataHash: d.metadataHash, imageHash: d.imageHash, supply: d.supply, royaltyBps: d.royaltyBps,
  seekerOnly: d.seekerOnly, price: d.price, genesis: d.genesis,
});
const publish = async (d: Draft, edit?: (ix: Instruction) => Instruction) =>
  send(d.creator, [edit ? edit(await publishIx(d)) : await publishIx(d)]);

const claimIx = (d: Draft, collector: Address, expectedPrice = 0n, genesis?: GenesisAccounts) => claimInstruction({
  program: d.program, collector, creator: d.creator.address, collection: d.collection, expectedPrice, genesis,
});
const claim = async (d: Draft, collector: KeyPairSigner, expectedPrice = 0n, genesis?: GenesisAccounts,
  edit?: (ix: Instruction) => Instruction) => {
  const ix = await claimIx(d, collector.address, expectedPrice, genesis);
  return send(collector, [edit ? edit(ix) : ix]);
};
const setPrice = (d: Draft, price: bigint, signer = d.creator) =>
  send(signer, [setPriceInstruction({ program: d.program, creator: signer.address, edition: d.edition, price })]);

/** The account at `place` (negative counts from the end) replaced by `to`. */
const swap = (place: number, to: Address) => (ix: Instruction): Instruction => ({
  ...ix,
  accounts: ix.accounts?.map((meta, i) =>
    (i === (place < 0 ? ix.accounts!.length + place : place) ? { ...meta, address: to } : meta)),
});
/** Anchor's absent optional account: the program's own id in that place. */
const absent = (place: number) => (ix: Instruction): Instruction => swap(place, ix.programAddress)(ix);

const editionOf = async (d: Draft) => {
  const found = await read(d.edition);
  return found && found.owner === d.program ? { length: found.bytes.length, ...decodeEdition(found.bytes) } : null;
};
const copyAt = async (key: string) => {
  const found = await read(key);
  return found && found.owner === MPL_CORE && found.bytes[0] === 1 ? decodeAsset(found.bytes) : null;
};
const printOf = (d: Draft, claimant: string) => printAddress(d.program, d.edition, claimant);

/** A conforming copy: owner, `Collection(collection)`, name `{title} #n`, the collection's uri, Edition n and ImmutableMetadata, both None. */
async function isCopy(d: Draft, key: string, owner: Address, n: number) {
  const a = await copyAt(key);
  const edition = a && pluginOf(a.plugins, "Edition");
  return Boolean(a && a.owner === owner && a.updateKind === 2 && a.updateAuthority === d.collection &&
    a.name === `${d.title} #${n}` && a.uri === d.uri && a.plugins.length === 2 &&
    edition?.number === n && edition.authority === "None" &&
    pluginOf(a.plugins, "ImmutableMetadata")?.authority === "None");
}

// --- Genesis Token accounts -----------------------------------------------------------------------

const TOKEN_OWNER_AT = 32;
const TOKEN_MINT_AT = 0;
const MULTISIG_BYTES = 355;

/** The real SGT token account's bytes with the given mint and owner written in. */
function tokenBytes(real: Dumped, mint: string, owner: string): Uint8Array {
  const bytes = bytesOf(real.data);
  bytes.set(keyBytes(mint), TOKEN_MINT_AT);
  bytes.set(keyBytes(owner), TOKEN_OWNER_AT);
  return bytes;
}

/** The value offset of a Token-2022 mint extension, walking the TLV area after the account type. */
function extensionAt(bytes: Uint8Array, type: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 166; at + 4 <= bytes.length; at += 4 + view.getUint16(at + 2, true))
    if (view.getUint16(at, true) === type) return at + 4;
  throw new Error(`No extension ${type}`);
}
const TOKEN_GROUP = 21;

/**
 * A member mint as Token-2022 writes one, the way `genesisFixture.memberInstructions` does:
 * `MetadataPointer` to `pointer`, `GroupMemberPointer` to itself, `TokenGroupMember` of `group`
 * signed by the group's update authority, one unit minted to `holder` and frozen. `at` is a
 * keypair to create, or an address that is first allocated empty (Token-2022-owned, rent paid),
 * which is all `create_account` would have done, for an address nobody holds a key to.
 */
async function member(at: KeyPairSigner | Address, group: Address, pointer: Address, authority: KeyPairSigner, holder: KeyPairSigner) {
  const mint = typeof at === "string" ? at : at.address;
  const fixed = [
    extension("MetadataPointer", { authority: some(authority.address), metadataAddress: some(pointer) }),
    extension("GroupMemberPointer", { authority: some(authority.address), memberAddress: some(mint) }),
  ];
  const space = getMintSize(fixed);
  const lamports = await rent(getMintSize([...fixed, extension("TokenGroupMember", { mint, group, memberNumber: 0n })]));
  if (typeof at === "string") await write(at, { lamports, owner: T22, bytes: new Uint8Array(space) });
  const token = await genesisTokenAccount(holder.address, mint);
  const outcome = await send(holder, [
    ...(typeof at === "string" ? [] : [getCreateAccountInstruction({ payer: holder, newAccount: at, lamports, space, programAddress: T22 })]),
    getInitializeMetadataPointerInstruction({ mint, authority: some(authority.address), metadataAddress: some(pointer) }),
    getInitializeGroupMemberPointerInstruction({ mint, authority: some(authority.address), memberAddress: some(mint) }),
    getInitializeMint2Instruction({ mint, decimals: 0, mintAuthority: authority.address, freezeAuthority: some(authority.address) }),
    getInitializeTokenGroupMemberInstruction({ member: mint, memberMint: mint, memberMintAuthority: authority, group, groupUpdateAuthority: authority }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: holder, ata: token, owner: holder.address, mint, tokenProgram: T22 }),
    getMintToInstruction({ mint, token, mintAuthority: authority, amount: 1n }),
    getFreezeAccountInstruction({ account: token, mint, owner: authority }),
  ]);
  if (!outcome.ok) ok(`setup: Token-2022 writes a member of ${group}`, false, outcome);
  return { mint, token, made: outcome.ok };
}

/**
 * A Token-2022 `Multisig` (m, n, is_initialized, then eleven signer keys) whose bytes read as
 * `image`: `InitializeMultisig` writes m, n = 11 and 1 into the first three, and the eleven
 * signer addresses, chosen from `image`, fill the other 352. Returns its bytes as written.
 */
async function multisigLaidOutAs(image: Uint8Array, payer: KeyPairSigner, account: KeyPairSigner) {
  if (image.length !== MULTISIG_BYTES || image[1] !== 11 || image[2] !== 1 || image[0] < 1 || image[0] > 11)
    throw new Error("A multisig image starts with m, 11 and 1");
  const signers = Array.from({ length: 11 }, (_, i) => keyOf(image.subarray(3 + 32 * i, 35 + 32 * i)));
  const space = getMultisigSize();
  const outcome = await send(payer, [
    getCreateAccountInstruction({ payer, newAccount: account, lamports: await rent(space), space, programAddress: T22 }),
    getInitializeMultisigInstruction({ multisig: account.address, m: image[0], signers }),
  ]);
  if (!outcome.ok) ok("setup: Token-2022 InitializeMultisig", false, outcome);
  return (await read(account.address))?.bytes ?? new Uint8Array(0);
}

// --- One SVM per build -------------------------------------------------------------------------------

async function fresh(elf: string, id: Address, chain: Mainnet, groupAuthority?: Address) {
  await host.call("reset");
  await host.call("rent_floor", { min0: chain.rentMin0 });
  await host.call("program", { id: hexOf(keyBytes(id)), path: elf });
  await host.call("program", { id: hexOf(keyBytes(MPL_CORE)), path: CORE_ELF });
  await setClock(BigInt(Math.floor(Date.now() / 1000)));
  await write(SGT_MINT, { lamports: BigInt(chain.sgtMint.lamports), owner: T22, bytes: bytesOf(chain.sgtMint.data) });
  // Solana Mobile's group, with only its TokenGroup update authority rewritten when asked, so
  // Token-2022 itself can write further members of it here.
  const group = bytesOf(chain.sgtGroup.data);
  if (groupAuthority) group.set(keyBytes(groupAuthority), extensionAt(group, TOKEN_GROUP));
  await write(GT22, { lamports: BigInt(chain.sgtGroup.lamports), owner: T22, bytes: group });
}

/** The real SGT token account at its own address, held by `owner` (only the owner field rewritten). */
const holdRealSgt = (chain: Mainnet, owner: string) =>
  write(chain.sgtToken.address, { lamports: BigInt(chain.sgtToken.lamports), owner: T22, bytes: tokenBytes(chain.sgtToken, SGT_MINT, owner) });

/** The fixture's builders read only `endpoint` and `payer` of the devnet session's context. */
const fixtureContext = (payer: KeyPairSigner) =>
  ({ endpoint: SVM_RPC, payer }) as unknown as Parameters<typeof groupInstructions>[0];

const STRAY = 777_777n;
/** Stray lamports at an address nobody holds a key to, as a transfer to it leaves them. */
const prefund = (key: string) => write(key, { lamports: STRAY, owner: SYSTEM_PROGRAM, bytes: new Uint8Array(0) });
/** What `send` took from `payer`. */
async function spent(payer: KeyPairSigner, outcome: Promise<Outcome>) {
  const before = await balance(payer.address);
  const result = await outcome;
  return { outcome: result, cost: before - (await balance(payer.address)) };
}

// --- Scenarios ----------------------------------------------------------------------------------------

async function plainBuild(plain: { elf: string; id: Address }, chain: Mainnet) {
  const program = plain.id;
  const groupAuthority = await generateKeyPairSigner();
  await fresh(plain.elf, program, chain, groupAuthority.address);
  const floor = await rent(0);
  console.log(`\n${plain.elf}\n  at ${program}; Metaplex Core ${chain.core.sha256.slice(0, 16)}... (${chain.core.bytes} bytes); rent floor ${floor}`);

  // 1. A plain publication.
  console.log("\n1. publish");
  const creator = await wallet();
  const first = await draft(program, creator, 5);
  const published = await spent(creator, publish(first));
  ok("publish without Genesis Token accounts", published.outcome.ok, published.outcome);
  const edition = await editionOf(first);
  ok(`Edition: ${EDITION_ACCOUNT_BYTES} bytes, the creator, supply 5, minted 1, price 0, open, published_at the Clock's ${clockTime}`,
    edition !== null && edition.length === EDITION_ACCOUNT_BYTES && edition.creator === creator.address &&
    edition.supply === 5 && edition.minted === 1 && edition.price === 0n && !edition.seekerOnly &&
    edition.publishedAt === Number(clockTime));
  const collectionAccount = (await read(first.collection))!;
  const collection = decodeCollection(collectionAccount.bytes);
  const attributes = pluginOf(collection.plugins, "Attributes");
  ok("collection: name the title, uri, update authority the Edition PDA; MasterEdition(5), ImmutableMetadata, Attributes, Royalties, every authority None",
    collection.name === first.title && collection.uri === first.uri && collection.updateAuthority === first.edition &&
    collection.numMinted === 1 && collection.plugins.length === 4 && collection.plugins.every((p) => p.authority === "None") &&
    pluginOf(collection.plugins, "MasterEdition")?.maxSupply === 5 && Boolean(pluginOf(collection.plugins, "ImmutableMetadata")));
  ok("attributes: exactly image_sha256 then metadata_sha256",
    attributes?.attributes.length === 2 &&
    attributes.attributes[0].key === "image_sha256" && attributes.attributes[0].value === first.imageHash &&
    attributes.attributes[1].key === "metadata_sha256" && attributes.attributes[1].value === first.metadataHash);
  ok("copy 1 at ['print', edition, creator]: the creator's, Edition #1 and ImmutableMetadata, both None",
    first.print === await printOf(first, creator.address) && await isCopy(first, first.print, creator.address, 1));
  const printAccount = (await read(first.print))!;
  measured.publishUnits = published.outcome.units;
  measured.publishCost = published.cost;
  measured.collectionBytes = collectionAccount.bytes.length;
  measured.assetBytes = printAccount.bytes.length;
  measured.assetLamports = printAccount.lamports;
  const again = await publish(first);
  ok("the same nonce again -> the Edition exists (System AccountAlreadyInUse); nothing changes",
    refused(again, ACCOUNT_ALREADY_IN_USE) && (await editionOf(first))?.minted === 1, again);

  // 2. The real Seeker Genesis Token, held by the creator.
  console.log("\n2. publish with the real Seeker Genesis Token");
  await holdRealSgt(chain, creator.address);
  const mintBefore = hexOf((await read(SGT_MINT))!.bytes);
  const real = { mint: SGT_MINT, token: address(chain.sgtToken.address) };
  const sealed = await draft(program, creator, 3, { genesis: real });
  const sealedOutcome = await publish(sealed);
  ok(`publish with ${SGT_MINT} and the creator's token account`, sealedOutcome.ok, sealedOutcome);
  const sealedAttributes = pluginOf(decodeCollection((await read(sealed.collection))!.bytes).plugins, "Attributes");
  ok("seeker_genesis_token=<mint> is the third attribute, authority None; copy 1 still the creator wallet's on an open edition",
    sealedAttributes?.authority === "None" && sealedAttributes.attributes.length === 3 &&
    sealedAttributes.attributes[2].key === "seeker_genesis_token" && sealedAttributes.attributes[2].value === SGT_MINT &&
    await isCopy(sealed, await printOf(sealed, creator.address), creator.address, 1));
  ok("the SGT mint is untouched", hexOf((await read(SGT_MINT))!.bytes) === mintBefore);

  // 3. Everything that is not the creator holding a Seeker Genesis Token.
  console.log("\n3. InvalidGenesisToken");
  const refusal = async (name: string, genesis: GenesisAccounts, edit?: (ix: Instruction) => Instruction) => {
    const d = await draft(program, creator, 2, { genesis });
    const outcome = await publish(d, edit);
    ok(`${name} -> InvalidGenesisToken`, refused(outcome, E.InvalidGenesisToken) && (await read(d.edition)) === null, outcome);
  };

  await write(chain.sgtToken.address, { lamports: BigInt(chain.sgtToken.lamports), owner: T22, bytes: bytesOf(chain.sgtToken.data) });
  await refusal("the real token account, still owned by its holder", real);
  await holdRealSgt(chain, creator.address);

  const empty = await genesisTokenAccount(creator.address, SGT_MINT);
  if (await settles("an empty associated account for the SGT", send(creator, [
    getCreateAssociatedTokenIdempotentInstruction({ payer: creator, ata: empty, owner: creator.address, mint: SGT_MINT, tokenProgram: T22 }),
  ]))) await refusal("the creator's own token account for the SGT with a zero balance", { mint: SGT_MINT, token: empty });

  await refusal("the mint without the token account", real, absent(-1));
  await refusal("the token account without the mint", real, absent(-2));
  {
    const d = await draft(program, creator, 2);
    const ix = await publishIx(d);
    const short = await send(creator, [{ ...ix, accounts: ix.accounts!.slice(0, -2) }]);
    ok("publish without the two trailing accounts at all -> AccountNotEnoughKeys", refused(short, A.AccountNotEnoughKeys), short);
  }

  {
    // A multisig laid out as a Seeker Genesis Token mint naming itself and GT22.
    const account = await generateKeyPairSigner();
    const image = new Uint8Array(MULTISIG_BYTES);
    image.set([1, 11, 1]);
    image[45] = 1; // is_initialized
    image[165] = 1; // AccountType::Mint
    const view = new DataView(image.buffer);
    view.setUint16(166, 18, true); view.setUint16(168, 64, true); // MetadataPointer
    image.set(keyBytes(GT22), 170 + 32);
    view.setUint16(234, 23, true); view.setUint16(236, 72, true); // TokenGroupMember
    image.set(keyBytes(account.address), 238);
    image.set(keyBytes(GT22), 270);
    view.setBigUint64(302, 1n, true);
    const onChain = await multisigLaidOutAs(image, creator, account);
    ok("Token-2022 wrote the 355-byte multisig exactly as laid out; one byte longer the client's decoder would call it an SGT",
      hexOf(onChain) === hexOf(image) &&
      !isSeekerGenesisMint(onChain, account.address) && isSeekerGenesisMint(new Uint8Array([...onChain, 0]), account.address));
    const holding = await generateKeyPairSigner();
    await write(holding.address, { lamports: BigInt(chain.sgtToken.lamports), owner: T22, bytes: tokenBytes(chain.sgtToken, account.address, creator.address) });
    await refusal("a Token-2022 multisig laid out as an SGT mint", { mint: account.address, token: holding.address });
  }

  {
    // A multisig laid out as the creator's holding of a genuine GT22 member. Its first three bytes
    // are m, n and 1, so the member's address must start with them: it is chosen, and Token-2022
    // writes the mint there after the account is allocated empty.
    const chosen = keyOf(new Uint8Array([1, 11, 1, ...randomBytes(29)]));
    const sgt = await member(chosen, GT22, GT22, groupAuthority, creator);
    const control = await draft(program, creator, 2, { genesis: { mint: sgt.mint, token: sgt.token } });
    const controlOutcome = await publish(control);
    const controlAttributes = controlOutcome.ok ? pluginOf(decodeCollection((await read(control.collection))!.bytes).plugins, "Attributes") : undefined;
    ok("control: a GT22 member Token-2022 wrote at that address, held by the creator, is sealed",
      sgt.made && controlOutcome.ok && controlAttributes?.attributes[2]?.value === sgt.mint, controlOutcome);
    const image = new Uint8Array(MULTISIG_BYTES);
    image.set(keyBytes(sgt.mint), 0);
    image.set(keyBytes(creator.address), 32);
    new DataView(image.buffer).setBigUint64(64, 1n, true); // amount
    image[108] = 2; // AccountState::Frozen
    image[165] = 2; // AccountType::Account
    const multisig = await generateKeyPairSigner();
    ok("Token-2022 wrote the multisig as a holding of that member", hexOf(await multisigLaidOutAs(image, creator, multisig)) === hexOf(image));
    await refusal("a Token-2022 multisig laid out as the creator's token account", { mint: sgt.mint, token: multisig.address });
  }

  {
    // Pointer to GT22, membership of another group: the devnet stand-in group, made by the fixture.
    const keys = await devnetGenesisKeys();
    await settles("the stand-in group", groupInstructions(fixtureContext(creator), keys).then((ix) => send(creator, ix)));
    const other = await member(await generateKeyPairSigner(), keys.group.address, GT22, keys.authority, creator);
    if (other.made) await refusal("a mint pointing at GT22 whose TokenGroupMember names another group", { mint: other.mint, token: other.token });
    const standIn = await generateKeyPairSigner();
    if (await settles("the fixture's stand-in SGT", memberInstructions(fixtureContext(creator), keys, standIn).then((ix) => send(creator, ix))))
      await refusal("the devnet stand-in SGT (genesisFixture.ts) on the mainnet build",
        { mint: standIn.address, token: await genesisTokenAccount(creator.address, standIn.address) });
  }

  {
    const elsewhere = await generateKeyPairSigner();
    const holding = await generateKeyPairSigner();
    await write(elsewhere.address, { lamports: BigInt(chain.sgtMint.lamports), owner: T22, bytes: bytesOf(chain.sgtMint.data) });
    await write(holding.address, { lamports: BigInt(chain.sgtToken.lamports), owner: T22, bytes: tokenBytes(chain.sgtToken, elsewhere.address, creator.address) });
    await refusal("the real SGT mint's bytes under another address", { mint: elsewhere.address, token: holding.address });
  }

  // 4. The terms publish checks: length bounds, the royalty, the price floor.
  console.log("\n4. publish terms");
  const terms = async (name: string, t: Terms, code: number) => {
    const d = await draft(program, creator, t.supply ?? 3, t);
    const outcome = await publish(d);
    ok(`${name} -> ${code}; nothing created`, refused(outcome, code) && (await read(d.edition)) === null &&
      (await read(d.collection)) === null, outcome);
  };
  await terms("supply 0", { supply: 0 }, E.InvalidTerms);
  await terms("supply 1001", { supply: 1001 }, E.InvalidTerms);
  await terms("an empty title", { title: "" }, E.InvalidTerms);
  await terms("a 25-byte title", { title: "x".repeat(25) }, E.InvalidTerms);
  await terms("an empty uri", { uri: "" }, E.InvalidTerms);
  await terms("a 97-byte uri", { uri: "u".repeat(97) }, E.InvalidTerms);
  await terms("royalty 1001 bps", { royaltyBps: 1001 }, E.InvalidRoyalty);
  await terms(`a price of ${floor - 1n}, one under the floor`, { price: floor - 1n }, E.PriceTooLow);
  await terms("a price of 1 lamport", { price: 1n }, E.PriceTooLow);
  await terms("Seeker-only without a Genesis Token", { seekerOnly: true }, E.GenesisTokenRequired);
  const controls: [string, Terms][] = [
    ["supply 1000", { supply: 1000 }], ["a 24-byte title", { title: "x".repeat(24) }],
    ["a 96-byte uri", { uri: "u".repeat(96) }], ["a title with U+200B", { title: "Moment​x" }],
    [`a price of ${floor}`, { price: floor }],
  ];
  for (const [label, t] of controls) {
    const d = await draft(program, creator, t.supply ?? 1, t);
    const outcome = await publish(d);
    ok(`control: ${label} publishes (length bounds only)`, outcome.ok &&
      (await editionOf(d))?.price === (t.price ?? 0n), outcome);
  }
  {
    const d = await draft(program, creator, 3);
    const other = await printOf(d, (await generateKeyPairSigner()).address);
    const misplaced = await publish(d, swap(3, other));
    ok("copy 1 at another claimant's print address -> ConstraintSeeds", refused(misplaced, A.ConstraintSeeds), misplaced);
    const prefunded = await draft(program, creator, 5);
    await prefund(prefunded.collection);
    await prefund(prefunded.print);
    const p = await spent(creator, publish(prefunded));
    ok(`collection and copy 1 pre-funded with ${STRAY} each: publish succeeds, costs ${2n * STRAY} less, both hold what an unfunded one does`,
      p.outcome.ok && p.cost === published.cost - 2n * STRAY &&
      (await read(prefunded.collection))?.lamports === collectionAccount.lamports &&
      (await read(prefunded.print))?.lamports === printAccount.lamports, p.outcome);
  }

  // 5. set_price.
  console.log("\n5. set_price");
  const seller = await wallet();
  const priced = await draft(program, seller, 5);
  await settles("an edition to price", publish(priced));
  const atFloor = await setPrice(priced, floor);
  ok(`set_price(${floor}), the rent-exempt minimum of an empty account`, atFloor.ok && (await editionOf(priced))?.price === floor, atFloor);
  measured.setPriceUnits = atFloor.units;
  const below = await setPrice(priced, floor - 1n);
  ok(`set_price(${floor - 1n}) -> PriceTooLow; the price is unchanged`, refused(below, E.PriceTooLow) && (await editionOf(priced))?.price === floor, below);
  const stranger = await wallet();
  const theirs = await setPrice(priced, 0n, stranger);
  ok("set_price signed by anyone else -> ConstraintHasOne", refused(theirs, A.ConstraintHasOne) && (await editionOf(priced))?.price === floor, theirs);
  const unsigned = await send(stranger, [{ ...setPriceInstruction({ program, creator: seller.address, edition: priced.edition, price: 0n }),
    accounts: [{ address: seller.address, role: AccountRole.READONLY }, { address: priced.edition, role: AccountRole.WRITABLE }] }]);
  ok("set_price naming the creator without their signature -> AccountNotSigner", refused(unsigned, A.AccountNotSigner), unsigned);
  const removed = await setPrice(priced, 0n);
  const restored = await setPrice(priced, floor);
  ok("set_price(0) removes the price and a later one sets it again; nothing else in the Edition moves",
    removed.ok && restored.ok && (await editionOf(priced))?.minted === 1 && (await editionOf(priced))?.supply === 5);

  // 6. Claims.
  console.log("\n6. claim");
  const giver = await wallet();
  const free = await draft(program, giver, 4);
  await settles("a free edition", publish(free));
  const freePublishedAt = clockTime;
  // An hour on, for every claim below: none of them may move the edition's publication time.
  await setClock(freePublishedAt + 3_600n);
  const collector = await wallet();
  const collected = await spent(collector, claim(free, collector));
  const collectorPrint = await printOf(free, collector.address);
  ok("claim copy 2 of a free edition: at ['print', edition, collector], named from the collection, minted 2",
    collected.outcome.ok && await isCopy(free, collectorPrint, collector.address, 2) && (await editionOf(free))?.minted === 2 &&
    decodeCollection((await read(free.collection))!.bytes).numMinted === 2, collected.outcome);
  measured.claimUnits = collected.outcome.units;
  measured.claimCost = collected.cost;
  const twice = await claim(free, collector);
  ok("the same wallet again -> AlreadyCollected (its print exists)", refused(twice, E.AlreadyCollected), twice);
  const own = await claim(free, giver);
  ok("(iv) the creator claiming their own edition -> AlreadyCollected", refused(own, E.AlreadyCollected), own);

  // (ii) A pre-funded print address.
  const grace = await wallet();
  await prefund(await printOf(free, grace.address));
  const graceClaim = await spent(grace, claim(free, grace));
  ok(`(ii) the claimant's print address pre-funded with ${STRAY}: the claim succeeds, costs ${STRAY} less, and the copy holds what copy 2 does`,
    graceClaim.outcome.ok && graceClaim.cost === collected.cost - STRAY &&
    (await read(await printOf(free, grace.address)))?.lamports === (await read(collectorPrint))?.lamports &&
    await isCopy(free, await printOf(free, grace.address), grace.address, 3), graceClaim.outcome);
  // Nobody can sign for a print address, so only this program and Core can put an account there;
  // written directly to show `clear_pda` refuses one it does not own rather than taking it.
  const ivan = await wallet();
  await write(await printOf(free, ivan.address), { lamports: await rent(0), owner: T22, bytes: new Uint8Array(0) });
  const squatted = await claim(free, ivan);
  ok("a print address owned by another program, empty -> ExistingAsset, never taken", refused(squatted, E.ExistingAsset), squatted);

  // Account slots.
  const judy = await wallet();
  const other = await draft(program, giver, 3);
  await settles("a second edition", publish(other));
  const wrongEdition = await claim(free, judy, 0n, undefined, swap(1, other.edition));
  ok("another edition beside this collection -> ConstraintSeeds", refused(wrongEdition, A.ConstraintSeeds), wrongEdition);
  const wrongPrint = await claim(free, judy, 0n, undefined, swap(3, await printOf(free, giver.address)));
  ok("another claimant's print address -> ConstraintSeeds", refused(wrongPrint, A.ConstraintSeeds), wrongPrint);
  const wrongPayee = await claim(free, judy, 0n, undefined, swap(4, judy.address));
  ok("a payee other than the edition's creator -> ConstraintAddress", refused(wrongPayee, A.ConstraintAddress), wrongPayee);
  const wrongCore = await claim(free, judy, 0n, undefined, swap(5, SYSTEM_PROGRAM));
  ok("anything but Metaplex Core in its slot -> ConstraintAddress", refused(wrongCore, A.ConstraintAddress), wrongCore);
  const noGenesisSlots = await claimIx(free, judy.address);
  const short = await send(judy, [{ ...noGenesisSlots, accounts: noGenesisSlots.accounts!.slice(0, -2) }]);
  ok("claim without the two trailing accounts at all -> AccountNotEnoughKeys", refused(short, A.AccountNotEnoughKeys), short);

  // (v) Supply.
  const last = await claim(free, judy);
  ok("claim the last copy (4 of 4)", last.ok && (await editionOf(free))?.minted === 4, last);
  const nobody = await wallet();
  const soldOut = await claim(free, nobody);
  ok("(v) a claim after the last copy -> SoldOut", refused(soldOut, E.SoldOut) && (await read(await printOf(free, nobody.address))) === null, soldOut);
  ok("four claims an hour later leave published_at as publish wrote it", (await editionOf(free))?.publishedAt === Number(freePublishedAt));

  // Paid claims, (iii) a stale price.
  console.log("\n7. paid claim");
  const sink = await generateKeyPairSigner();
  // Everything but the fee: one signature at 5,000 lamports, no compute budget.
  const drain = await send(seller, [getTransferSolInstruction({ source: seller, destination: sink.address, amount: (await balance(seller.address)) - 5_000n })], false);
  ok("the creator's wallet is drained to 0 lamports", drain.ok && (await read(seller.address)) === null, drain);
  const buyer = await wallet();
  const bought = await spent(buyer, claim(priced, buyer, floor));
  ok(`claim at ${floor} into the empty wallet: the creator ends with exactly the price, the buyer pays the price plus a free claim's cost`,
    bought.outcome.ok && (await balance(seller.address)) === floor && bought.cost === collected.cost + floor &&
    await isCopy(priced, await printOf(priced, buyer.address), buyer.address, 2), bought.outcome);
  measured.paidClaimUnits = bought.outcome.units;
  const late = await wallet();
  const stale0 = await claim(priced, late, 0n);
  ok("a claim expecting free on a priced edition -> PriceChanged", refused(stale0, E.PriceChanged), stale0);
  // The creator signs again below, so their wallet is funded again first.
  await host.call("airdrop", { address: hexOf(keyBytes(seller.address)), lamports: "1000000000" });
  await settles("set_price to twice the floor", setPrice(priced, 2n * floor));
  const paidBefore = await balance(seller.address);
  const stale = await claim(priced, late, floor);
  ok("(iii) a claim at the price before set_price -> PriceChanged; the creator is paid nothing, no copy",
    refused(stale, E.PriceChanged) && (await balance(seller.address)) === paidBefore &&
    (await read(await printOf(priced, late.address))) === null, stale);
  const over = await claim(priced, late, 3n * floor);
  ok("a claim at more than the price -> PriceChanged", refused(over, E.PriceChanged), over);
  const current = await claim(priced, late, 2n * floor);
  ok("a claim at the current price", current.ok && (await balance(seller.address)) === paidBefore + 2n * floor, current);
  await settles("set_price(0)", setPrice(priced, 0n));
  const staleFree = await claim(priced, await wallet(), 2n * floor);
  ok("a claim at the old price after the price is removed -> PriceChanged", refused(staleFree, E.PriceChanged), staleFree);
  const poor = await generateKeyPairSigner();
  await host.call("airdrop", { address: hexOf(keyBytes(poor.address)), lamports: "3000000" });
  await settles("set_price(1 SOL)", setPrice(priced, 1_000_000_000n));
  const sellerBefore = await balance(seller.address);
  const unpaid = await claim(priced, poor, 1_000_000_000n);
  ok("a collector who cannot pay the price -> the System program's ResultWithNegativeLamports (1); no copy, no payment",
    refused(unpaid, 1) && (await read(await printOf(priced, poor.address))) === null &&
    (await balance(seller.address)) === sellerBefore, unpaid);

  // (i) Burn and claim again.
  console.log("\n8. burn, then claim again");
  const burnt = await draft(program, giver, 6);
  await settles("an edition to burn from", publish(burnt));
  const kim = await wallet();
  await settles("kim's copy", claim(burnt, kim));
  const kimPrint = await printOf(burnt, kim.address);
  const burn = await send(kim, [coreBurn(kimPrint, burnt.collection, kim.address)]);
  const tomb = await read(kimPrint);
  ok("Core BurnV1 leaves a one-byte Uninitialized tombstone, Core-owned, at the print address",
    burn.ok && tomb?.owner === MPL_CORE && tomb.bytes.length === 1 && tomb.bytes[0] === 0, burn);
  const reclaim = await claim(burnt, kim);
  ok("(i) the same claimant again after the burn -> AlreadyCollected (the tombstone refuses it)",
    refused(reclaim, E.AlreadyCollected) && (await editionOf(burnt))?.minted === 2, reclaim);
  const sweep = await send(kim, [coreCollect(kimPrint)]);
  const swept = await read(kimPrint);
  ok(`Core's permissionless Collect sweeps the fee: the tombstone is System-owned, one zero byte, rent(1) = ${await rent(1)}`,
    sweep.ok && swept?.owner === SYSTEM_PROGRAM && swept.bytes.length === 1 && swept.bytes[0] === 0 && swept.lamports === await rent(1), sweep);
  const reclaimSwept = await claim(burnt, kim);
  ok("(i) the same claimant again after the sweep -> AlreadyCollected (one byte of data still refuses it)",
    refused(reclaimSwept, E.AlreadyCollected) && (await editionOf(burnt))?.minted === 2, reclaimSwept);
  const lee = await wallet();
  await settles("lee's copy", claim(burnt, lee));
  const away = await send(lee, [coreTransfer(await printOf(burnt, lee.address), burnt.collection, lee.address, kim.address)]);
  const leeAgain = await claim(burnt, lee);
  ok("a claimant who sent their copy away -> AlreadyCollected (the print still lives at their address)",
    away.ok && refused(leeAgain, E.AlreadyCollected), away.ok ? leeAgain : away);
  const control = await claim(burnt, await wallet());
  ok("control: another wallet still claims (copy 4)", control.ok && (await editionOf(burnt))?.minted === 4, control);

  // Members of Solana Mobile's group, written by Token-2022 under the rewritten group authority.
  await royaltiesAndSeekers(program, "plain build", {
    authority: groupAuthority,
    mint: async (holder) => member(await generateKeyPairSigner(), GT22, GT22, groupAuthority, holder),
  });
}

// --- Royalties and Seeker-only editions, on each build ---------------------------------------------

/** Genesis Tokens of the group the build under test names, and the key Token-2022 lets freeze them. */
interface Minter {
  authority: KeyPairSigner;
  mint: (holder: KeyPairSigner) => Promise<GenesisAccounts & { made: boolean }>;
}

/** The token moved to `to`: thawed by the freeze authority, sent with TransferChecked, frozen again. */
async function moveSgt(sgt: GenesisAccounts, from: KeyPairSigner, to: KeyPairSigner, authority: KeyPairSigner): Promise<GenesisAccounts> {
  const mint = address(sgt.mint);
  const source = address(sgt.token);
  const destination = await genesisTokenAccount(to.address, mint);
  await settles("Token-2022 moves the Genesis Token to another wallet", send(from, [
    getThawAccountInstruction({ account: source, mint, owner: authority }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: from, ata: destination, owner: to.address, mint, tokenProgram: T22 }),
    getTransferCheckedInstruction({ source, mint, destination, authority: from, amount: 1n, decimals: 0 }),
    getFreezeAccountInstruction({ account: destination, mint, owner: authority }),
  ]));
  return { mint, token: destination };
}

async function royaltiesAndSeekers(program: Address, build: string, sgts: Minter) {
  const floor = await rent(0);

  console.log(`\n${build}: royalty`);
  const creator = await wallet();
  for (const bps of [500, 0, 1000]) {
    const d = await draft(program, creator, 3, { royaltyBps: bps });
    const outcome = await publish(d);
    const plugin = outcome.ok ? pluginOf(decodeCollection((await read(d.collection))!.bytes).plugins, "Royalties") : undefined;
    ok(`publish at ${bps} bps: Royalties { ${bps}, [creator 100%], RuleSet::None }, authority None`,
      outcome.ok && plugin?.authority === "None" && plugin.basisPoints === bps && plugin.creators.length === 1 &&
      plugin.creators[0].address === creator.address && plugin.creators[0].percentage === 100 && plugin.ruleSet === 0, outcome);
  }
  const sent = await draft(program, creator, 3);
  await settles("an edition to send from", publish(sent));
  const holder = await wallet();
  await settles("copy 2", claim(sent, holder));
  const recipient = await generateKeyPairSigner();
  const two = await printOf(sent, holder.address);
  const moved1 = await send(creator, [coreTransfer(sent.print, sent.collection, creator.address, recipient.address)]);
  const moved2 = await send(holder, [coreTransfer(two, sent.collection, holder.address, recipient.address)]);
  ok("Core TransferV1 sends copy 1 and a claimed copy 2 out of a collection carrying the royalty (RuleSet::None)",
    moved1.ok && moved2.ok && (await copyAt(sent.print))?.owner === recipient.address && (await copyAt(two))?.owner === recipient.address,
    moved1.ok ? moved2 : moved1);

  console.log(`\n${build}: Seeker-only`);
  const host = await wallet();
  const hostSgt = await sgts.mint(host);
  const seeker = await draft(program, host, 9, { seekerOnly: true, genesis: hostSgt });
  const seekerOutcome = await publish(seeker);
  ok("publish Seeker-only with the creator's Genesis Token: seeker_only set, the token sealed, copy 1 at ['print', edition, mint]",
    seekerOutcome.ok && (await editionOf(seeker))?.seekerOnly === true &&
    pluginOf(decodeCollection((await read(seeker.collection))!.bytes).plugins, "Attributes")?.attributes[2]?.value === hostSgt.mint &&
    seeker.print === await printOf(seeker, hostSgt.mint) && await isCopy(seeker, seeker.print, host.address, 1) &&
    (await read(await printOf(seeker, host.address))) === null, seekerOutcome);
  if (build === "plain build") measured.seekerPublishUnits = seekerOutcome.units;
  const wrongPrint = await draft(program, host, 3, { seekerOnly: true, genesis: hostSgt });
  const wrongPrintOutcome = await publish(wrongPrint, swap(3, await printOf(wrongPrint, host.address)));
  ok("Seeker-only copy 1 at the creator wallet's print address -> ConstraintSeeds", refused(wrongPrintOutcome, A.ConstraintSeeds), wrongPrintOutcome);

  const [alice, bob, carol, dave, henry] = [await wallet(), await wallet(), await wallet(), await wallet(), await wallet()];
  const [aliceSgt, bobSgt, daveSgt, henrySgt] = [await sgts.mint(alice), await sgts.mint(bob), await sgts.mint(dave), await sgts.mint(henry)];
  ok("Token-2022 minted four Genesis Tokens of this build's group", aliceSgt.made && bobSgt.made && daveSgt.made && henrySgt.made);
  const none = await claim(seeker, carol);
  ok("(vi) a wallet without a Genesis Token -> GenesisTokenRequired", refused(none, E.GenesisTokenRequired), none);
  const half = await claim(seeker, alice, 0n, aliceSgt, absent(-1));
  ok("the mint but not the token account -> GenesisTokenRequired", refused(half, E.GenesisTokenRequired), half);
  const borrowed = await claim(seeker, alice, 0n, bobSgt);
  ok("another wallet's Genesis Token -> InvalidGenesisToken", refused(borrowed, E.InvalidGenesisToken), borrowed);
  const first = await spent(alice, claim(seeker, alice, 0n, aliceSgt));
  ok("a claim with the collector's own Genesis Token: the copy at ['print', edition, mint], none at the wallet's",
    first.outcome.ok && await isCopy(seeker, await printOf(seeker, aliceSgt.mint), alice.address, 2) &&
    (await read(await printOf(seeker, alice.address))) === null, first.outcome);
  if (build === "plain build") measured.seekerClaimUnits = first.outcome.units;
  const again = await claim(seeker, alice, 0n, aliceSgt);
  ok("the same Genesis Token again -> AlreadyCollected", refused(again, E.AlreadyCollected), again);
  const carried = await moveSgt(aliceSgt, alice, carol, sgts.authority);
  const moved = await claim(seeker, carol, 0n, carried);
  ok("(vi) the same Genesis Token moved to a second wallet -> AlreadyCollected; copy 2 still alice's",
    refused(moved, E.AlreadyCollected) && (await copyAt(await printOf(seeker, aliceSgt.mint)))?.owner === alice.address, moved);
  const bobClaim = await spent(bob, claim(seeker, bob, 0n, bobSgt));
  ok("another Genesis Token is another claim", bobClaim.outcome.ok, bobClaim.outcome);

  await settles("a price on the Seeker-only edition", setPrice(seeker, floor));
  const unpaid = await claim(seeker, dave, 0n, daveSgt);
  ok("a free claim on the priced Seeker-only edition -> PriceChanged", refused(unpaid, E.PriceChanged), unpaid);
  const hostBefore = await balance(host.address);
  const bought = await claim(seeker, dave, floor, daveSgt);
  ok("a paid claim with the collector's own Genesis Token; the creator is paid the price",
    bought.ok && (await balance(host.address)) - hostBefore === floor &&
    await isCopy(seeker, await printOf(seeker, daveSgt.mint), dave.address, 4), bought);
  const buyAgain = await claim(seeker, bob, floor, bobSgt);
  ok("a paid claim with a Genesis Token that already claimed -> AlreadyCollected", refused(buyAgain, E.AlreadyCollected), buyAgain);
  await settles("the Seeker-only edition free again", setPrice(seeker, 0n));
  const henryPrint = await printOf(seeker, henrySgt.mint);
  await prefund(henryPrint);
  const henryClaim = await spent(henry, claim(seeker, henry, 0n, henrySgt));
  ok(`a pre-funded token print address: the claim succeeds and costs ${STRAY} less than bob's`,
    henryClaim.outcome.ok && henryClaim.cost === bobClaim.cost - STRAY, henryClaim.outcome);

  const open = await draft(program, host, 5);
  await settles("an open edition", publish(open));
  const offered = await claim(open, bob, 0n, bobSgt);
  ok("Genesis Token accounts on an edition that is not Seeker-only -> InvalidGenesisToken", refused(offered, E.InvalidGenesisToken), offered);
  const frank = await wallet();
  const frankClaim = await claim(open, frank);
  ok("an open edition still counts wallets", frankClaim.ok && await isCopy(open, await printOf(open, frank.address), frank.address, 2), frankClaim);

  console.log(`\n${build}: the publisher's claim`);
  const tries = [
    await claim(seeker, host, 0n, hostSgt),
    await claim(seeker, host),
    await claim(open, host),
  ];
  ok("(iv) the creator claiming with the token copy 1 is sealed with, with their wallet alone, or on an open edition -> AlreadyCollected",
    tries.every((o) => refused(o, E.AlreadyCollected)), tries.find((o) => !refused(o, E.AlreadyCollected)));
  const hostSecond = await sgts.mint(host);
  const second = await claim(seeker, host, 0n, hostSecond);
  ok("the creator claiming with a second Genesis Token they hold -> AlreadyCollected (the creator rule)",
    hostSecond.made && refused(second, E.AlreadyCollected) && (await read(await printOf(seeker, hostSecond.mint))) === null, second);
  const hostOther = await wallet();
  const carriedHost = await moveSgt(hostSgt, host, hostOther, sgts.authority);
  const fromOther = await claim(seeker, hostOther, 0n, carriedHost);
  ok("the creator's sealed token moved to another wallet -> AlreadyCollected; copy 1 is still the token's",
    refused(fromOther, E.AlreadyCollected) && (await copyAt(seeker.print))?.owner === host.address, fromOther);
  const maker = await wallet();
  const makerSgt = await sgts.mint(maker);
  const prefunded = await draft(program, maker, 4, { seekerOnly: true, genesis: makerSgt });
  await prefund(prefunded.print);
  const prefundedOutcome = await publish(prefunded);
  ok("Seeker-only with copy 1's token print address pre-funded: publish succeeds",
    prefundedOutcome.ok && await isCopy(prefunded, prefunded.print, maker.address, 1), prefundedOutcome);
}

async function devnetBuild(devnet: { elf: string; id: Address }, chain: Mainnet) {
  const program = devnet.id;
  await fresh(devnet.elf, program, chain);
  console.log(`\n9. ${devnet.elf}\n  at ${program}`);
  const creator = await wallet();
  const context = fixtureContext(creator);
  const keys = await devnetGenesisKeys();
  await settles("the stand-in group", groupInstructions(context, keys).then((ix) => send(creator, ix)));
  const standIn = await generateKeyPairSigner();
  const made = await settles("the stand-in SGT", memberInstructions(context, keys, standIn).then((ix) => send(creator, ix)));
  let decodes = true;
  try { await assertMemberDecodes(context, standIn.address); } catch { decodes = false; }
  ok("genesisFixture.ts builds the stand-in, and the client decodes it only against the stand-in addresses", made && decodes);
  const sealed = await draft(program, creator, 2, { genesis: { mint: standIn.address, token: await genesisTokenAccount(creator.address, standIn.address) } });
  const outcome = await publish(sealed);
  ok("publish with the stand-in SGT is sealed, and records published_at", outcome.ok &&
    pluginOf(decodeCollection((await read(sealed.collection))!.bytes).plugins, "Attributes")?.attributes[2]?.value === standIn.address &&
    (await editionOf(sealed))?.publishedAt === Number(clockTime), outcome);
  await holdRealSgt(chain, creator.address);
  const realOnDevnet = await draft(program, creator, 2, { genesis: { mint: SGT_MINT, token: chain.sgtToken.address } });
  const refusal = await publish(realOnDevnet);
  ok("the real SGT, held by the creator -> InvalidGenesisToken on the devnet build", refused(refusal, E.InvalidGenesisToken), refusal);

  // Stand-ins of the fixture's group, as the devnet session's `stand-in` command mints them.
  await royaltiesAndSeekers(program, "devnet build", {
    authority: keys.authority,
    mint: async (holder) => member(await generateKeyPairSigner(), keys.group.address, keys.group.address, keys.authority, holder),
  });
}

const PLACEHOLDER = address("Ds4LT9zQ3a9V9ZxqKgwYQxskh1DgeYPhoCYz5iHjAizE"); // lib.rs declare_id!

async function elsewhere(build: { elf: string; id: Address }, chain: Mainnet) {
  console.log(`\n10. ${build.elf} at another address`);
  // A build answers DeclaredProgramIdMismatch away from its declare_id!. Its own address is the
  // one every section above ran it at; for a placeholder-address build that is the placeholder,
  // which therefore cannot be a refusal case here.
  const at = (await generateKeyPairSigner()).address;
  await fresh(build.elf, at, chain);
  const outcome = await publish(await draft(at, await wallet(), 1));
  ok(`loaded at ${at}: every call -> DeclaredProgramIdMismatch`, refused(outcome, A.DeclaredProgramIdMismatch), outcome);
  if (build.id === PLACEHOLDER)
    console.log(`NOTE  ${build.elf} is the placeholder-address build: it runs at ${PLACEHOLDER} (sections above), so no refusal is expected there.`);
}

function report() {
  const m = measured;
  if (m.publishUnits === undefined) return;
  console.log("\nMeasured on the plain build (compute units include the 150-unit SetComputeUnitLimit):");
  console.log(`  publish ${m.publishUnits} CU (Seeker-only ${m.seekerPublishUnits}); claim ${m.claimUnits} CU free, ${m.paidClaimUnits} paid (Seeker-only ${m.seekerClaimUnits}); set_price ${m.setPriceUnits} CU`);
  console.log(`  publish costs the creator ${m.publishCost} lamports; a free claim costs the collector ${m.claimCost}`);
  console.log(`  collection ${m.collectionBytes} bytes; a copy ${m.assetBytes} bytes holding ${m.assetLamports} lamports (rent + Core's create fee); Edition ${EDITION_ACCOUNT_BYTES} bytes`);
}

async function main(): Promise<boolean> {
  const plain = named("plain");
  const devnet = named("devnet");
  if (!plain && !devnet) {
    console.log("SKIP  no ELF: pass --plain <elf> --plain-id <address> (or SVM_PLAIN_ELF / SVM_PLAIN_ID).");
    return false;
  }
  const chain = await mainnet();
  host = new Host(hostExecutable());
  try {
    if (plain) await plainBuild(plain, chain);
    else console.log("\nSKIP  1-8. no plain ELF: pass --plain <elf> --plain-id <address>.");
    if (devnet) await devnetBuild(devnet, chain);
    else console.log("\nSKIP  9. no devnet-genesis ELF: pass --devnet <elf> --devnet-id <address>.");
    await elsewhere((plain ?? devnet)!, chain);
    report();
  } finally {
    host.close();
  }
  return true;
}

void main().then(
  (ran) => {
    if (ran) console.log(failures ? `\n${failures} check(s) failed.` : "\nprogram SVM suite passed.");
    process.exit(failures ? 1 : 0);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
