/**
 * The built `era_editions` ELFs, run end to end in LiteSVM: `npm run test:svm`. Not part of
 * `npm test`, because it needs the ELFs and, on its first run, builds the LiteSVM host and reads
 * Metaplex Core and a Seeker Genesis Token from mainnet (read only, cached in `.cache/svm/`).
 *
 *   npm run test:svm -- --plain <elf> --plain-id <address> [--devnet <elf> --devnet-id <address>]
 *   env: SVM_PLAIN_ELF SVM_PLAIN_ID SVM_DEVNET_ELF SVM_DEVNET_ID SVM_TOOLS_ROOT SVM_HOST SVM_MAINNET_RPC
 *   Delete `.cache/svm/` to read mainnet again (after a Metaplex Core upgrade, say).
 *
 * The `litesvm` npm package ships no Windows binary, so LiteSVM runs as `programs/svm` (the Rust
 * crate, built with `build-native-windows.ps1` on the pinned toolchain) and this script drives it
 * line by line. Every `era_editions` instruction comes from the app's client
 * (`publications/core/protocol.ts`, `core/album.ts`), is compiled and signed with @solana/kit and
 * runs with signature checks on; the results are read back through the client's own readers over
 * a JSON-RPC stub that answers from the SVM. Token-2022 and the associated-token program are the
 * builds LiteSVM carries; Metaplex Core is mainnet's.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
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
} from "@solana-program/token-2022";
import {
  GENESIS_ATTRIBUTE,
  MPL_CORE,
  addresses,
  albumAddress,
  buyInstruction,
  collectInstruction,
  collectedCopy,
  decodeCollection,
  decodeGroup,
  instruction,
  readOfferAccount,
  readPrintState,
  readPublication,
  sealedGenesisMint,
  setOfferInstruction,
  type GenesisAccounts,
} from "../publications/core/protocol";
import { createAlbumInstruction } from "../publications/core/album";
import { publicationTime } from "../publications/core/attestationCheck";
import { SGT_GROUP_ADDRESS, isSeekerGenesisMint } from "../publications/core/genesisToken";
import {
  assertMemberDecodes,
  devnetGenesisKeys,
  genesisTokenAccount,
  groupInstructions,
  memberInstructions,
} from "../publications/devnet/genesisFixture";
import type { CoreMetadata } from "../publications/types";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// --- What runs ------------------------------------------------------------------------------------

const option = (flag: string, variable: string) => {
  const at = process.argv.indexOf(flag);
  return (at >= 0 ? process.argv[at + 1] : process.env[variable]) || undefined;
};
// The two builds made on 2026-09-25, used when nothing else is named and they are still there.
const SCRATCH = join(tmpdir(), "claude", "signshot",
  "06931168-1a5d-4a3f-bb87-8e52d8afa74b", "scratchpad", "elf");
const DEFAULT_BUILDS = {
  plain: { elf: join(SCRATCH, "plain-realid.so"), id: "EFru4ddFAuLHX1HFEvqynwEGhAnsPav5CPh8B6vPhzHg" },
  devnet: { elf: join(SCRATCH, "devnet-genesis.so"), id: "tAazSbRgAS2g9yDy83XPGGTTWTvgEwq294gjUWRN9Ea" },
};
function build(kind: "plain" | "devnet"): { elf: string; id: Address } | null {
  const upper = kind.toUpperCase();
  const elf = option(`--${kind}`, `SVM_${upper}_ELF`);
  const id = option(`--${kind}-id`, `SVM_${upper}_ID`);
  if (elf) {
    if (!id) throw new Error(`--${kind} needs --${kind}-id: the address that ELF's declare_id! names.`);
    if (!existsSync(elf)) throw new Error(`No ELF at ${elf}`);
    return { elf: resolve(elf), id: address(id) };
  }
  const fallback = DEFAULT_BUILDS[kind];
  return existsSync(fallback.elf) ? { elf: fallback.elf, id: address(id ?? fallback.id) } : null;
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
      ` -ToolsRoot '${process.env.SVM_TOOLS_ROOT ?? join(process.env.TEMP ?? tmpdir(), "ssbt")}'` +
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
 * Written as an account, it is what the program's `Clock::get()` reads next.
 */
async function setClock(unixTimestamp: bigint) {
  const clock = await read(CLOCK);
  if (!clock || clock.bytes.length !== 40) throw new Error("No Clock sysvar to set");
  const bytes = new Uint8Array(clock.bytes);
  new DataView(bytes.buffer).setBigInt64(32, unixTimestamp, true);
  await write(CLOCK, { lamports: clock.lamports, owner: clock.owner, bytes });
  clockTime = unixTimestamp;
}
const PUBLISHED_AT = 173; // lib.rs `published_at_is_eight_bytes_right_after_bump`

/** The edition's `published_at` straight from its bytes, and its length, beside what the client reads. */
async function recorded(edition: string) {
  const bytes = (await read(edition))?.bytes ?? new Uint8Array(0);
  const raw = bytes.length >= PUBLISHED_AT + 8
    ? new DataView(bytes.buffer, bytes.byteOffset).getBigInt64(PUBLISHED_AT, true) : null;
  return { length: bytes.length, raw };
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

// --- The client's readers, answered from the SVM ----------------------------------------------------

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
// A real Seeker Genesis Token and the wallet that held it when this suite was written.
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

// --- Checks ---------------------------------------------------------------------------------------

let failures = 0;
// Where Anchor says it threw, so a refusal line names the check that refused.
const thrownAt = (o: Outcome) => o.logs.map((l) => /AnchorError thrown in (\S+:\d+)/.exec(l)?.[1]).find(Boolean);
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

// Anchor 1.1.2 (`anchor-lang-error`), and `EditionError` in programs/editions/src/lib.rs.
const DECLARED_PROGRAM_ID_MISMATCH = 4100;
const E = {
  SoldOut: 6001, StaleNumber: 6002, NotForSale: 6005, OfferChanged: 6006, PaymentRequired: 6007,
  InvalidGenesisToken: 6008, PriceTooLow: 6009,
} as const;

// --- Editions --------------------------------------------------------------------------------------

const arweave = () => `https://arweave.net/${randomBytes(32).toString("base64url")}`;
const hex32 = () => randomBytes(32).toString("hex");
let made = 0;

interface Draft { e: CoreMetadata; uri: string; metadataHash: string; creator: KeyPairSigner }

async function draft(program: Address, creator: KeyPairSigner, supply: number, genesisMint?: string): Promise<Draft> {
  const nonce = hex32();
  const keys = await addresses(program, creator.address, nonce);
  made += 1;
  return {
    creator, uri: arweave(), metadataHash: hex32(),
    e: {
      cluster: "mainnet-beta", program, edition: keys.edition, collection: keys.collection,
      creator: creator.address, nonce, title: `Moment ${made}`, supply, image: arweave(),
      imageHash: hex32(), width: 3000, height: 4000, description: "",
      ...(genesisMint ? { genesisMint } : {}),
    },
  };
}

function publish(d: Draft, options: { album?: string; genesis?: GenesisAccounts; edit?: (ix: Instruction) => Instruction } = {}) {
  return instruction(d.e, d.e.creator, 1, d.uri, d.metadataHash, options.album, options.genesis)
    .then((ix) => send(d.creator, [options.edit ? options.edit(ix) : ix]));
}

/** Anchor's absent optional account: the program's own id in that place. */
const absent = (place: number) => (ix: Instruction): Instruction => ({
  ...ix,
  accounts: ix.accounts?.map((meta, i) => (i === ix.accounts!.length + place ? { ...meta, address: ix.programAddress } : meta)),
});

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
  // The fixed-size extensions' length, with rent for the final one (as `memberInstructions` does).
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
  const published = await publish(first);
  ok("publish without Genesis Token accounts", published.ok, published);
  const verified = await readPublication(SVM_RPC, program, first.e.edition);
  ok("the client's reader accepts the edition, the collection and the creator's receipt for copy 1",
    verified !== null && verified.state.minted === 1 && verified.creatorReceipt.number === 1 && verified.sealedGenesis === null);
  const collection = decodeCollection((await read(first.e.collection))!.bytes);
  const attributes = collection.plugins.find((p) => p.type === "Attributes");
  ok("collection: MasterEdition(5), ImmutableMetadata and Attributes, every authority None; update authority the edition PDA",
    collection.plugins.length === 3 && collection.plugins.every((p) => p.authority.kind === "None") &&
    collection.plugins.some((p) => p.type === "ImmutableMetadata") &&
    collection.plugins.some((p) => p.type === "MasterEdition" && p.maxSupply === 5) &&
    collection.updateAuthority === first.e.edition);
  ok("attributes locked: exactly the five, no seeker_genesis_token",
    attributes?.type === "Attributes" && attributes.attributes.length === 5 &&
    !attributes.attributes.some((a) => a.key === GENESIS_ATTRIBUTE));
  const copy1 = verified ? await readPrintState(SVM_RPC, verified, 1) : null;
  ok("copy 1 is live, owned by the creator, Edition #1 and ImmutableMetadata locked",
    copy1?.status === "live" && copy1.asset.owner === creator.address);
  const stamped = await recorded(first.e.edition);
  ok(`published_at is the Clock's unix_timestamp at publish (${clockTime}): 309-byte Edition, i64 at byte 173`,
    stamped.length === 309 && stamped.raw === clockTime && verified?.state.publishedAt === Number(clockTime));
  // The SVM answers no signature history, so this is the Edition read alone.
  ok("publicationTime reads it from the Edition, with no signature history to walk",
    (await publicationTime(SVM_RPC, program, first.e.edition).catch(() => null))?.getTime() === Number(clockTime) * 1000);

  // 2. The real Seeker Genesis Token, held by the creator.
  console.log("\n2. publish with the real Seeker Genesis Token");
  await holdRealSgt(chain, creator.address);
  const mintBefore = hexOf((await read(SGT_MINT))!.bytes);
  const sealed = await draft(program, creator, 3, SGT_MINT);
  const sealedOutcome = await publish(sealed, { genesis: { mint: SGT_MINT, token: chain.sgtToken.address } });
  ok(`publish with ${SGT_MINT} and the creator's token account`, sealedOutcome.ok, sealedOutcome);
  const sealedRead = await readPublication(SVM_RPC, program, sealed.e.edition);
  const sealedCollection = decodeCollection((await read(sealed.e.collection))!.bytes);
  const sealedAttributes = sealedCollection.plugins.find((p) => p.type === "Attributes");
  ok("seeker_genesis_token=<mint> is the sixth attribute, authority None",
    sealedAttributes?.type === "Attributes" && sealedAttributes.authority.kind === "None" &&
    sealedAttributes.attributes.length === 6 &&
    sealedAttributes.attributes[5].key === GENESIS_ATTRIBUTE && sealedAttributes.attributes[5].value === SGT_MINT);
  ok("protocol.ts reads it as sealed (readPublication, sealedGenesisMint)",
    sealedRead?.sealedGenesis === SGT_MINT && sealedGenesisMint(sealedCollection) === SGT_MINT);
  ok("the SGT mint is untouched", hexOf((await read(SGT_MINT))!.bytes) === mintBefore);

  // 3. Everything that is not the creator holding a Seeker Genesis Token.
  console.log("\n3. InvalidGenesisToken");
  const refusal = async (name: string, genesis: GenesisAccounts, edit?: (ix: Instruction) => Instruction) => {
    const d = await draft(program, creator, 2, genesis.mint);
    const outcome = await publish(d, { genesis, edit });
    ok(`${name} -> InvalidGenesisToken`, refused(outcome, E.InvalidGenesisToken) && (await read(d.e.edition)) === null, outcome);
  };
  const real = { mint: SGT_MINT, token: chain.sgtToken.address };

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
    // Token-2022 opens no account for a multisig, so the holding is the real account's bytes
    // with the mint and owner written in.
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
    const control = await draft(program, creator, 2, sgt.mint);
    const controlOutcome = await publish(control, { genesis: { mint: sgt.mint, token: sgt.token } });
    ok("control: a GT22 member Token-2022 wrote at that address, held by the creator, is sealed",
      sgt.made && controlOutcome.ok && (await readPublication(SVM_RPC, program, control.e.edition))?.sealedGenesis === sgt.mint, controlOutcome);
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

  // 4. Prices.
  console.log("\n4. set_offer and buy");
  const seller = await wallet();
  const priced = await draft(program, seller, 5);
  await settles("a priced edition", publish(priced));
  const offer = () => readOfferAccount(SVM_RPC, program, priced.e.edition);
  const free0 = await send(seller, [await setOfferInstruction(priced.e, 0n)]);
  const at0 = await offer();
  ok("set_offer(0)", free0.ok && at0?.priceLamports === 0n && at0.revision === 1, free0);
  const atFloor = await send(seller, [await setOfferInstruction(priced.e, floor)]);
  const floored = await offer();
  ok(`set_offer(${floor}), the rent-exempt minimum of an empty account`, atFloor.ok && floored?.priceLamports === floor && floored.revision === 2, atFloor);
  const below = await send(seller, [await setOfferInstruction(priced.e, floor - 1n)]);
  const after = await offer();
  ok(`set_offer(${floor - 1n}) -> PriceTooLow; the offer is unchanged`,
    refused(below, E.PriceTooLow) && after?.priceLamports === floor && after.revision === 2, below);
  const sink = await generateKeyPairSigner();
  // Everything but the fee: one signature at 5,000 lamports, no compute budget.
  const drain = await send(seller, [getTransferSolInstruction({ source: seller, destination: sink.address, amount: (await balance(seller.address)) - 5_000n })], false);
  ok("the creator's wallet is drained to 0 lamports", drain.ok && (await read(seller.address)) === null, drain);
  const buyer = await wallet();
  const bought = await send(buyer, [await buyInstruction(priced.e, buyer.address, 2, floor, 2)]);
  ok(`buy at ${floor} into the empty wallet; the creator ends with exactly the price`, bought.ok && (await balance(seller.address)) === floor, bought);
  const receipt = await collectedCopy(SVM_RPC, priced.e, buyer.address);
  const pricedRead = await readPublication(SVM_RPC, program, priced.e.edition);
  const copy2 = pricedRead ? await readPrintState(SVM_RPC, pricedRead, 2) : null;
  ok("the buyer holds copy 2 and its receipt", receipt?.number === 2 && copy2?.status === "live" && copy2.asset.owner === buyer.address);

  // 5. Claims.
  console.log("\n5. collect and buy rules");
  const giver = await wallet();
  const free = await draft(program, giver, 3);
  await settles("a free edition", publish(free));
  const freePublishedAt = clockTime;
  // An hour on, for every claim below: none of them may move the edition's publication time.
  await setClock(freePublishedAt + 3_600n);
  const collector = await wallet();
  const collected = await send(collector, [await collectInstruction(free.e, collector.address, 2)]);
  ok("collect copy 2 of a free edition", collected.ok && (await collectedCopy(SVM_RPC, free.e, collector.address))?.number === 2, collected);
  const again = await send(collector, [await collectInstruction(free.e, collector.address, 3)]);
  ok("the same wallet cannot collect a second copy (its receipt already exists)",
    !again.ok && again.custom?.code === 0 && again.logs.some((l) => l.includes("already in use")), again);
  const late = await wallet();
  const staleRevision = await send(late, [await buyInstruction(priced.e, late.address, 3, floor, 1)]);
  ok("buy with a stale revision -> OfferChanged", refused(staleRevision, E.OfferChanged), staleRevision);
  const stalePrice = await send(late, [await buyInstruction(priced.e, late.address, 3, floor + 1n, 2)]);
  ok("buy at a price other than the offer's -> OfferChanged", refused(stalePrice, E.OfferChanged), stalePrice);
  const staleNumber = await send(late, [await buyInstruction(priced.e, late.address, 2, floor, 2)]);
  ok("buy a copy number already issued -> StaleNumber", refused(staleNumber, E.StaleNumber), staleNumber);
  const unpaid = await send(late, [await collectInstruction(priced.e, late.address, 3)]);
  ok("collect on a priced edition -> PaymentRequired", refused(unpaid, E.PaymentRequired), unpaid);
  const noOffer = await send(late, [await buyInstruction(free.e, late.address, 3, 1_000_000n, 1)]);
  ok("buy on an edition with no offer -> NotForSale", refused(noOffer, E.NotForSale), noOffer);
  await settles("set_offer(0) on the free edition", send(giver, [await setOfferInstruction(free.e, 0n)]));
  const zero = await send(late, [await buyInstruction(free.e, late.address, 3, 1_000_000n, 1)]);
  ok("buy on an edition offered at 0 -> NotForSale", refused(zero, E.NotForSale), zero);
  const last = await send(late, [await collectInstruction(free.e, late.address, 3)]);
  ok("collect the last copy of an edition offered at 0", last.ok, last);
  const nobody = await wallet();
  const soldOut = await send(nobody, [await collectInstruction(free.e, nobody.address, 3)]);
  ok("collect after the last copy -> SoldOut", refused(soldOut, E.SoldOut), soldOut);
  ok("three claims and a set_offer an hour later leave published_at as publish wrote it",
    (await recorded(free.e.edition)).raw === freePublishedAt &&
    (await readPublication(SVM_RPC, program, free.e.edition))?.state.minted === 3);

  // 6. Albums.
  console.log("\n6. albums");
  const albumNonce = hex32();
  const created = await send(giver, [await createAlbumInstruction({ program, creator: giver.address, nonce: albumNonce, name: "Summer" })]);
  const album = await albumAddress(program, giver.address, albumNonce);
  const group = decodeGroup((await read(album))?.bytes ?? new Uint8Array([0]));
  ok("create_album makes a Core group the creator controls", created.ok && group.updateAuthority === giver.address && group.name === "Summer", created);
  const inAlbum = await draft(program, giver, 4);
  const albumOutcome = await publish(inAlbum, { album });
  ok("publish_in_album", albumOutcome.ok, albumOutcome);
  const albumRead = await readPublication(SVM_RPC, program, inAlbum.e.edition);
  const albumCollection = decodeCollection((await read(inAlbum.e.collection))!.bytes);
  ok("the group lists the collection, and the collection is sealed like any other (ImmutableMetadata None)",
    albumRead?.album?.group === album && albumRead.album.collections.includes(address(inAlbum.e.collection)) &&
    albumCollection.updateAuthority === inAlbum.e.edition &&
    albumCollection.plugins.some((p) => p.type === "ImmutableMetadata" && p.authority.kind === "None"));
  ok("publish_in_album records the Clock's unix_timestamp at its own publish",
    albumRead?.state.publishedAt === Number(clockTime) && clockTime === freePublishedAt + 3_600n);
}

async function devnetBuild(devnet: { elf: string; id: Address }, chain: Mainnet) {
  const program = devnet.id;
  await fresh(devnet.elf, program, chain);
  console.log(`\n7. ${devnet.elf}\n  at ${program}`);
  const creator = await wallet();
  const context = fixtureContext(creator);
  const keys = await devnetGenesisKeys();
  await settles("the stand-in group", groupInstructions(context, keys).then((ix) => send(creator, ix)));
  const standIn = await generateKeyPairSigner();
  const made = await settles("the stand-in SGT", memberInstructions(context, keys, standIn).then((ix) => send(creator, ix)));
  let decodes = true;
  try { await assertMemberDecodes(context, standIn.address); } catch { decodes = false; }
  ok("genesisFixture.ts builds the stand-in, and the client decodes it only against the stand-in addresses", made && decodes);
  const sealed = await draft(program, creator, 2, standIn.address);
  const outcome = await publish(sealed, { genesis: { mint: standIn.address, token: await genesisTokenAccount(creator.address, standIn.address) } });
  const sealedRead = await readPublication(SVM_RPC, program, sealed.e.edition);
  ok("publish with the stand-in SGT is sealed, and records published_at", outcome.ok &&
    sealedRead?.sealedGenesis === standIn.address && sealedRead.state.publishedAt === Number(clockTime), outcome);
  await holdRealSgt(chain, creator.address);
  const realOnDevnet = await draft(program, creator, 2, SGT_MINT);
  const refusal = await publish(realOnDevnet, { genesis: { mint: SGT_MINT, token: chain.sgtToken.address } });
  ok("the real SGT, held by the creator -> InvalidGenesisToken on the devnet build", refused(refusal, E.InvalidGenesisToken), refusal);
}

async function elsewhere(plain: { elf: string; id: Address }, chain: Mainnet) {
  console.log(`\n8. ${plain.elf} at other addresses`);
  const placeholder = address("Ds4LT9zQ3a9V9ZxqKgwYQxskh1DgeYPhoCYz5iHjAizE"); // lib.rs declare_id!
  for (const at of [placeholder, (await generateKeyPairSigner()).address]) {
    await fresh(plain.elf, at, chain);
    const creator = await wallet();
    const outcome = await publish(await draft(at, creator, 1));
    ok(`loaded at ${at}: every call -> DeclaredProgramIdMismatch`, refused(outcome, DECLARED_PROGRAM_ID_MISMATCH), outcome);
  }
}

async function main(): Promise<boolean> {
  const plain = build("plain");
  const devnet = build("devnet");
  if (!plain) {
    console.log("SKIP  no plain ELF: pass --plain <elf> --plain-id <address> (or SVM_PLAIN_ELF / SVM_PLAIN_ID).");
    return false;
  }
  const chain = await mainnet();
  host = new Host(hostExecutable());
  try {
    await plainBuild(plain, chain);
    if (devnet) await devnetBuild(devnet, chain);
    else console.log("\nSKIP  7. no devnet-genesis ELF: pass --devnet <elf> --devnet-id <address>.");
    await elsewhere(plain, chain);
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
