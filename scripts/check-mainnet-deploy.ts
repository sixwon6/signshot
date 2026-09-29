/**
 * Self-test for the mainnet deploy tool (`publications/mainnet/`). Runs in `npm test` against a
 * stubbed `fetch` and a temporary folder; it sends nothing and reads no network.
 *
 *   - keys: made once and refused a second time, reloaded non-extractable at the recorded addresses;
 *   - steps refuse out of order: quote before svm, authority to an unverified address (or to a
 *     wallet on mainnet), forget before the refund; and svm counts only a passing run of the
 *     prepared ELF, never an exit code alone;
 *   - the quote arithmetic, and the largest transaction of each kind inside the packet limit;
 *   - Squads v4: the vault behind the example on Squads' Vault Check page, a real mainnet multisig
 *     account decoded, and the plan held to every field that binds it;
 *   - SetAuthority always names the new authority; the record matches its schema;
 *   - every step end to end on a cluster held in memory: responses lost mid-upload and during the
 *     transfer, resumed with nothing sent twice; fees exactly the quote's; the deployer refunded to
 *     0; the record written; the keys deleted; and on devnet a stopped upload closed and redone;
 *   - no step prints or saves a secret byte, and no error carries the endpoint's key.
 */

import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  LOADER_V3_PROGRAM_ADDRESS,
  getDeployWithMaxDataLenInstruction,
  getInitializeBufferInstruction,
  getSetAuthorityInstruction,
  getWriteInstruction,
} from "@solana-program/loader-v3";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKET_BYTES, UPLOAD_CHUNK_BYTES } from "../publications/deploy/loaderV3";
import { GENESIS_HASH } from "../publications/core/genesisToken";
import { COMPUTE_UNITS, budget, quote } from "../publications/mainnet/quote";
import { deploymentsLines, schemaErrors } from "../publications/mainnet/record";
import {
  SQUADS_V4_PROGRAM,
  decodeMultisig,
  multisigAddress,
  planMismatches,
  vaultAddress,
  type MultisigPlan,
} from "../publications/mainnet/squads";
import { assertKeyRoot, createKeys, keyPath, loadKeys, readState, saveState, statePath } from "../publications/mainnet/state";
import * as steps from "../publications/mainnet/steps";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const PLAN: MultisigPlan = JSON.parse(readFileSync(join(repoRoot, "programs", "editions", "mainnet-multisig-plan.json"), "utf8"));
const SCHEMA = JSON.parse(readFileSync(join(repoRoot, "programs", "editions", "scripts", "deployment-record.schema.json"), "utf8"));
const LIB = readFileSync(join(repoRoot, "programs", "editions", "src", "lib.rs"), "utf8");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

let failures = 0;
function ok(name: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failures += 1;
}
async function rejection(work: () => unknown): Promise<string> {
  try { await work(); return ""; } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printedSoFar.push(message);
    return message;
  }
}

// --- The stubbed network --------------------------------------------------------------------------

type Handler = (params: any[]) => unknown;
let rpc: Record<string, Handler> = {};
const calls: string[] = [];
globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
  const { method, params } = JSON.parse(String(init?.body));
  calls.push(method);
  const handler = rpc[method];
  if (!handler) throw new Error(`unexpected RPC ${method}`);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: await handler(params) }));
}) as typeof fetch;
const offline = () => { rpc = {}; calls.length = 0; };
const accountInfo = (owner: string, data: Uint8Array) =>
  ({ context: { slot: 1 }, value: { owner, executable: false, lamports: 1_000_000, data: [Buffer.from(data).toString("base64"), "base64"], space: data.length } });
const rent = (size: number) => (128 + size) * 5080;

// --- A Squads v4 multisig account, as the program writes it ---------------------------------------

const NO_KEY = "11111111111111111111111111111111";
const key = (a: string) => Buffer.from(getAddressEncoder().encode(address(a)));
function multisigBytes(o: {
  createKey: string; configAuthority?: string; threshold?: number; timeLock?: number;
  members?: { key: string; mask: number }[]; discriminator?: Buffer;
}) {
  const members = o.members ?? PLAN.members.map((m) => ({ key: m.address, mask: 7 }));
  const head = Buffer.alloc(2 + 4 + 8 + 8);
  head.writeUInt16LE(o.threshold ?? 2, 0);
  head.writeUInt32LE(o.timeLock ?? 0, 2);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(members.length);
  return Buffer.concat([
    o.discriminator ?? createHash("sha256").update("account:Multisig").digest().subarray(0, 8),
    key(o.createKey), key(o.configAuthority ?? NO_KEY), head,
    Buffer.from([0]), Buffer.from([255]), count,
    ...members.map((m) => Buffer.concat([key(m.key), Buffer.from([m.mask])])),
    Buffer.alloc(33 * 10), // room for more members, as the program allocates it
  ]);
}

/**
 * The first 891 bytes of mainnet account 3MyUSvyqpkJ8dYcYyoAbakbcf7G6y1fCrs3Yosnk9VhS (1,155 bytes of
 * space, the rest zero), read with getAccountInfo on 2026-09-28 at slot 451,520,692. Its vault,
 * index 0, is HFwi9HgNtFcMwNJPHa1czrPhuxeZFZ7G9tPQ1LqAd7sy, the example on Squads' Vault Check
 * page (https://docs.squads.so/main/development/api/vault-check); the multisig was found in that
 * vault's transaction history.
 */
const EXAMPLE_MULTISIG = Buffer.concat([Buffer.from(
  "4HR5ukShT+wBv7cBrwgnMObdvGyol7wtYxX6htMLaGvgVwQI18K9TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAABgcAAAAAAADrBgAAAAAAAAHxjvtyu43XvDtH2L0+14Jf4FYRmo9bmYwX7S/TSeMRVP4WAAAACjJg2+JqSzy+/kE7AVdEp919Nn6cauk8DbEJIYJtkPMBDCkXCb/MTWwuwIu4fvgCXnfaVc103xHodbK2WM4jc6UGDQYIcFUTNQH1oW4sga6dUIXN/bgmNr27qp8FlA545DoDIW+KRMoCUVFHdspkgafdBtIZRnY+Ak0u9nyV095G3skBKVEET0ojOu/acAOLYnN7/mLtqieSuBj7Nln3YYPEBTQHMaAjueb/EhlpYhQ2R4h1w87BnmfcFUtQBiteiZ1eqNoBOfcWoWmjCQQDv6NIrH7Vk1AnYqc6pfkNOFACmIgfbAABSueWBHy1TN0LjGVk502jjQJScbIFqSAYZQRwhep6OnABUARsRNSVr35ABEeStGhAxKWXmo6P4Np/PgifD/ZPF4wBU2r1Tep9bWA4dqaoSJDy/iGpKmrS8K1YYKVLgZdGC/MHaX45v3aolEFxOjc6Q72zoF58defdeiM4ba20M7AlLuMBg5SCEth5iyQ2Lc+3WS8m7NSD8HgQX2ZNfDNHJtYEGPIHpwZJmFtkNn+pSW39fxoptgCi4PtK95kuP/OctzvbiPcBrANIGfw0pZdU8Kmuro5tDnAEEyavlihvzuae7YdOY0MHrqI29c5hZz69adDWtaBw+66FirHTfWYZp+R5T/pj89IBrweObX2/wfl2cLMM4D5unBvWQtY0Bhx9xX65E4HOj5sBufBQ290T0w6+/nhClt0a/YNMRQE1vmc/NV4SsrEBTigBwicgLw5lzDSbgGc8cqeJjgPHeo2fKfop//bJLB3OyB4BxmE9F9a6bvKy0CX1LTUvma96ulPXRbNW7x56aB0cRicB1d8rNruzURES+u4Zmm8brYHNJH1ayQcwTewOlVOr8wcB8gQD4AnaWCmvlJJig7o1eL18khIR5g3LjRLfUtYs8fUB9ZTVj0SwxQU+KbbdODNAPAz625Cd6Qn4D5Cu+vO6XAIB9ZTVj0SwxQU+KbbdODNAPAz625Cd6Qn4D5Cu+vO6XAIB",
  "base64"), Buffer.alloc(1155 - 891)]);

async function squadsTests() {
  console.log("\nSquads v4");
  ok("the vault, index 0, of the multisig behind Squads' Vault Check example is that example",
    (await vaultAddress("3MyUSvyqpkJ8dYcYyoAbakbcf7G6y1fCrs3Yosnk9VhS", 0)) === "HFwi9HgNtFcMwNJPHa1czrPhuxeZFZ7G9tPQ1LqAd7sy");
  ok("vault index 1 is another address",
    (await vaultAddress("3MyUSvyqpkJ8dYcYyoAbakbcf7G6y1fCrs3Yosnk9VhS", 1)) !== "HFwi9HgNtFcMwNJPHa1czrPhuxeZFZ7G9tPQ1LqAd7sy");
  const real = decodeMultisig(EXAMPLE_MULTISIG);
  ok("a real mainnet multisig decodes: create key, no config authority, threshold, time lock",
    real.createKey === "7pxkpCYC94UibWcLeNTM7NzNf5ED15sQWRBFT8v5Gdy" && real.configAuthority === NO_KEY &&
    real.threshold === 1 && real.timeLock === 0 && real.transactionIndex === 1798n && real.staleTransactionIndex === 1771n);
  ok("its Some rent collector (33 bytes) shifts the bump and members, and trailing bytes are ignored",
    real.rentCollector === "HFwi9HgNtFcMwNJPHa1czrPhuxeZFZ7G9tPQ1LqAd7sy" && real.bump === 254 && real.members.length === 22 &&
    real.members[0].key === "godeYaXfVFa32acSUa39BTfFYrr9TeBkzgDanYowdo8" && real.members[0].mask === 1 &&
    real.members[21].key === "HXeWumtFJAgTDrRRRNsq9eQ8DzNytBMPp1fux5U3QYVw");
  ok("its address is the multisig PDA of its create key",
    (await multisigAddress(real.createKey)) === "3MyUSvyqpkJ8dYcYyoAbakbcf7G6y1fCrs3Yosnk9VhS");
  ok("it is not the reviewed multisig",
    (await planMismatches("3MyUSvyqpkJ8dYcYyoAbakbcf7G6y1fCrs3Yosnk9VhS", SQUADS_V4_PROGRAM, EXAMPLE_MULTISIG, PLAN))
      .some((m) => /threshold 1, expected 2/.test(m)));

  const createKey = (await generateKeyPairSigner()).address;
  const multisig = await multisigAddress(createKey);
  const planned = multisigBytes({ createKey });
  ok("a None rent collector is one byte: the plan's own multisig decodes",
    decodeMultisig(planned).members.map((m) => m.key).join() === PLAN.members.map((m) => m.address).join());
  ok("the plan's multisig matches the plan", (await planMismatches(multisig, SQUADS_V4_PROGRAM, planned, PLAN)).length === 0);
  const refused = async (name: string, bytes: Buffer, pattern: RegExp, at = multisig, owner: string = SQUADS_V4_PROGRAM) => {
    const found = await planMismatches(at, owner, bytes, PLAN);
    ok(`refused: ${name}`, found.some((m) => pattern.test(m)));
  };
  await refused("another owner", planned, /not Squads v4/, multisig, NO_KEY);
  await refused("another account type", multisigBytes({ createKey, discriminator: Buffer.alloc(8) }), /Not a Squads v4 multisig/);
  await refused("not at its create key's address", planned, /create key/, (await generateKeyPairSigner()).address);
  await refused("a config authority", multisigBytes({ createKey, configAuthority: PLAN.members[0].address }), /config authority/);
  await refused("threshold 1", multisigBytes({ createKey, threshold: 1 }), /threshold 1, expected 2/);
  await refused("a time lock", multisigBytes({ createKey, timeLock: 60 }), /time lock 60/);
  await refused("a member without Execute", multisigBytes({ createKey,
    members: PLAN.members.map((m, i) => ({ key: m.address, mask: i === 0 ? 3 : 7 })) }), /seedshot1 has permission mask 3, expected 7/);
  await refused("a missing member", multisigBytes({ createKey,
    members: PLAN.members.slice(1).map((m) => ({ key: m.address, mask: 7 })) }), /seedshot1 .* is not a member/);
  const stranger = (await generateKeyPairSigner()).address;
  await refused("an extra member", multisigBytes({ createKey,
    members: [...PLAN.members.map((m) => ({ key: m.address, mask: 7 })), { key: stranger, mask: 7 }] }), /is a member but not in the plan/);
  await refused("a truncated account", planned.subarray(0, 120), /truncated/);
}

// --- Quote, instructions and packets --------------------------------------------------------------

function quoteTests() {
  console.log("\nquote");
  const n = 427_016;
  const q = quote(n, { programData: rent(n + 45), programAccount: rent(36), buffer: rent(n + 37) });
  ok("ProgramData rent is read for 45 + ELF bytes, the program account for 36", q.rent.programData === 2_170_120_120 && q.rent.programAccount === 833_120);
  ok("475 writes of 900 bytes", q.writes === 475);
  ok("signatures: the buffer and the deploy two each, every write, the authority and the refund one", q.signatureFees === (2 + 475 + 2 + 1 + 1) * 5000);
  ok("priority fees: each transaction's limit at 50,000 micro-lamports per unit, rounded up",
    q.priorityFees === 300 + 475 * 200 + 70_000 + 200 + 50);
  ok("required = ProgramData + program account + signatures + priority + 0.01 SOL margin; the buffer is not added",
    q.required === 2_170_120_120 + 833_120 + 2_405_000 + 165_550 + 10_000_000 && q.required === 2_183_523_790);
  ok("an ELF one byte past a chunk costs one more write", quote(901, q.rent).writes === quote(900, q.rent).writes + 1);
  let invalid = false;
  try { quote(0, q.rent); } catch { invalid = true; }
  ok("an empty ELF is refused", invalid);
}

async function packetTests() {
  console.log("\ntransactions");
  const payer = await generateKeyPairSigner();
  const program = await generateKeyPairSigner();
  const buffer = await generateKeyPairSigner();
  const programData = address("11111111111111111111111111111112");
  const wire = (instructions: Instruction[]) => Buffer.from(getBase64EncodedWireTransaction(compileTransaction(
    appendTransactionMessageInstructions(instructions, setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 1n },
      setTransactionMessageFeePayer(payer.address, createTransactionMessage({ version: 0 })))))), "base64").length;
  const write = wire([...budget(COMPUTE_UNITS.write), getWriteInstruction({
    bufferAccount: buffer.address, bufferAuthority: payer, offset: 1_000_000, bytes: new Uint8Array(UPLOAD_CHUNK_BYTES) })]);
  ok(`a full ${UPLOAD_CHUNK_BYTES}-byte write with both compute-budget instructions fits a packet (${write} bytes)`, write <= PACKET_BYTES);
  const create = wire([...budget(COMPUTE_UNITS.buffer),
    getCreateAccountInstruction({ payer, newAccount: buffer, lamports: 1, space: 1, programAddress: LOADER_V3_PROGRAM_ADDRESS }),
    getInitializeBufferInstruction({ sourceAccount: buffer.address, bufferAuthority: payer.address })]);
  const deploy = wire([...budget(COMPUTE_UNITS.deploy),
    getCreateAccountInstruction({ payer, newAccount: program, lamports: 1, space: 36, programAddress: LOADER_V3_PROGRAM_ADDRESS }),
    getDeployWithMaxDataLenInstruction({ payerAccount: payer, programDataAccount: programData, programAccount: program.address,
      bufferAccount: buffer.address, authority: payer, maxDataLen: 500_000 })]);
  ok("the buffer and deploy transactions fit a packet", create <= PACKET_BYTES && deploy <= PACKET_BYTES);

  const to = (await generateKeyPairSigner()).address;
  const ix = steps.setAuthorityInstruction(programData, payer, to);
  ok("SetAuthority names ProgramData, the signing deployer and the new authority, read-only",
    ix.accounts?.length === 3 && ix.accounts[2].address === to);
  const omitted = getSetAuthorityInstruction({ bufferOrProgramDataAccount: programData, currentAuthority: payer });
  let caught = "";
  try { steps.assertSetAuthority(omitted, programData, payer.address, to); } catch (error) { caught = String(error); }
  ok("a SetAuthority built without the new authority (the builder puts the loader's id there) is refused",
    omitted.accounts?.[2]?.address === LOADER_V3_PROGRAM_ADDRESS && /does not name/.test(caught));
  let noop = "";
  try { steps.assertSetAuthority(getSetAuthorityInstruction({ bufferOrProgramDataAccount: programData,
    currentAuthority: createNoopSigner(payer.address), newAuthority: payer.address }), programData, payer.address, to); }
  catch (error) { noop = String(error); }
  ok("a SetAuthority to another address is refused", /does not name/.test(noop));
}

function recordTests() {
  console.log("\nrecord");
  const entry = {
    address: "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU", cluster: "mainnet-beta", elfSha256: "a".repeat(64),
    deployedSlot: 451_520_692, authority: "HFwi9HgNtFcMwNJPHa1czrPhuxeZFZ7G9tPQ1LqAd7sy", policy: "multisig",
    reviewedBy: ["owner"], date: "2026-10-01", programData: "BrcFJBrcj18FcPGfFJFZnNJirnaV45LcoRLibm7hqQ2u",
    bytes: 427_016, notes: "n",
  };
  ok("a complete record matches the schema", schemaErrors(entry, SCHEMA).length === 0);
  ok("\"none\" is an authority only as the literal", schemaErrors({ ...entry, authority: "none", policy: "final" }, SCHEMA).length === 0);
  const broken: [string, object][] = [
    ["no reviewer", { ...entry, reviewedBy: [] }],
    ["reviewedBy missing", Object.fromEntries(Object.entries(entry).filter(([k]) => k !== "reviewedBy"))],
    ["a third policy", { ...entry, policy: "wallet" }],
    ["an uppercase digest", { ...entry, elfSha256: "A".repeat(64) }],
    ["a timestamp for a date", { ...entry, date: "2026-10-01T00:00:00Z" }],
    ["slot 0", { ...entry, deployedSlot: 0 }],
    ["a field the schema does not have", { ...entry, extra: 1 }],
  ];
  for (const [name, value] of broken) ok(`refused: ${name}`, schemaErrors(value, SCHEMA).length > 0);
  const lines = deploymentsLines({ cluster: "mainnet-beta", address: entry.address, sha256: entry.elfSha256,
    bytes: 427_016, upgradeAuthority: entry.authority, source: "s" });
  ok("the deployments.ts lines carry HISTORICAL, PROGRAM_IMAGES and DEPLOYMENTS for mainnet",
    lines.includes(`HISTORICAL."mainnet-beta"`) && lines.includes("bytes: 427_016,") &&
    lines.includes(`upgradeAuthority: "${entry.authority}"`) && lines.includes(`"mainnet-beta": "${entry.address}",`));
  ok("devnet lines select the program through .env.local instead",
    deploymentsLines({ cluster: "devnet", address: entry.address, sha256: entry.elfSha256, bytes: 1,
      upgradeAuthority: entry.authority, source: "s" }).includes(`EXPO_PUBLIC_EDITIONS_DEVNET_PROGRAM=${entry.address}`));
}

// --- A cluster in memory ---------------------------------------------------------------------------

type Account = { lamports: number; owner: string; executable: boolean; data: Buffer };
const SYSTEM = "11111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const LOADER = LOADER_V3_PROGRAM_ADDRESS as string;

/**
 * Just enough of a cluster to run every step: the System program's create and transfer, loader-v3's
 * buffer, write, deploy, set-authority and close as Agave implements them (the deploy drains the
 * buffer to the payer, then funds ProgramData at its rent), fees of 5,000 per signature plus limit ×
 * price, and the rent-exempt rule on every account a transaction leaves funded. Signatures are not
 * verified. `lose` applies a transaction and then fails its response, as a dropped connection does.
 */
/** A compiled legacy or v0 message: its accounts, signers, instructions and the fee it pays. */
function decodeMessage(bytes: ArrayLike<number>) {
  const message = getCompiledTransactionMessageDecoder().decode(Uint8Array.from(bytes));
  if (!("instructions" in message)) throw new Error("not a legacy or v0 message");
  const keys = message.staticAccounts as string[];
  const ixs = message.instructions.map((ix) => ({
    program: keys[ix.programAddressIndex], accounts: (ix.accountIndices ?? []).map((i) => keys[i]), data: Buffer.from(ix.data ?? []),
  }));
  let limit = 200_000, price = 0;
  for (const ix of ixs.filter((i) => i.program === COMPUTE_BUDGET)) {
    if (ix.data[0] === 2) limit = ix.data.readUInt32LE(1);
    if (ix.data[0] === 3) price = Number(ix.data.readBigUInt64LE(1));
  }
  const signers = new Set(keys.slice(0, message.header.numSignerAccounts));
  return { keys, signers, ixs, fee: 5000 * signers.size + Math.ceil((limit * price) / 1e6) };
}

class Chain {
  accounts = new Map<string, Account>();
  landed = new Set<string>();
  fees = new Map<string, number>();
  applied: string[] = [];
  lose: (names: string[]) => boolean = () => false;
  refuseProgramAccounts = true;
  constructor(readonly cluster: "mainnet-beta" | "devnet") {}

  private run(bytes: Uint8Array, commit: boolean): { err: string | null; signature: string; names: string[] } {
    const tx = getTransactionDecoder().decode(bytes);
    const { keys, signers, ixs, fee } = decodeMessage(tx.messageBytes);
    const signature = getBase58Decoder().decode(tx.signatures[keys[0] as Address]!);
    const work = new Map<string, Account>([...this.accounts].map(([k, a]) => [k, { ...a, data: Buffer.from(a.data) }]));
    const get = (k: string): Account => work.get(k) ?? { lamports: 0, owner: SYSTEM, executable: false, data: Buffer.alloc(0) };
    const put = (k: string, a: Account) => work.set(k, a);
    const names: string[] = [];
    const payer = get(keys[0]);
    if (payer.lamports < fee) return { err: "InsufficientFundsForFee", signature, names };
    put(keys[0], { ...payer, lamports: payer.lamports - fee });
    const debit = (k: string, n: number) => {
      const a = get(k);
      if (a.lamports < n) throw new Error("insufficient lamports");
      put(k, { ...a, lamports: a.lamports - n });
    };
    const credit = (k: string, n: number) => { const a = get(k); put(k, { ...a, lamports: a.lamports + n }); };
    try {
      for (const { program, accounts: a, data } of ixs) {
        if (program === COMPUTE_BUDGET) continue;
        const kind = data.readUInt32LE(0);
        if (program === SYSTEM && kind === 0) {
          names.push("CreateAccount");
          if (get(a[1]).lamports || get(a[1]).data.length || !signers.has(a[1])) throw new Error("AccountAlreadyInUse");
          const lamports = Number(data.readBigUInt64LE(4));
          debit(a[0], lamports);
          put(a[1], { lamports, owner: getBase58Decoder().decode(data.subarray(20, 52)), executable: false,
            data: Buffer.alloc(Number(data.readBigUInt64LE(12))) });
        } else if (program === SYSTEM && kind === 2) {
          names.push("Transfer");
          const lamports = Number(data.readBigUInt64LE(4));
          debit(a[0], lamports);
          credit(a[1], lamports);
        } else if (program === LOADER && kind === 0) {
          names.push("InitializeBuffer");
          const buffer = get(a[0]);
          buffer.data.writeUInt32LE(1, 0); buffer.data[4] = 1; key(a[1]).copy(buffer.data, 5);
        } else if (program === LOADER && kind === 1) {
          names.push("Write");
          const buffer = get(a[0]);
          if (!buffer.data.subarray(5, 37).equals(key(a[1])) || !signers.has(a[1])) throw new Error("IncorrectAuthority");
          const offset = data.readUInt32LE(4), length = Number(data.readBigUInt64LE(8));
          data.subarray(16, 16 + length).copy(buffer.data, 37 + offset);
        } else if (program === LOADER && kind === 2) {
          names.push("DeployWithMaxDataLen");
          const [payerKey, programData, programKey, bufferKey, , , , authority] = a;
          const buffer = get(bufferKey), programAccount = get(programKey);
          if (programAccount.owner !== LOADER || programAccount.data.readUInt32LE(0) !== 0) throw new Error("AccountAlreadyInitialized");
          if (!buffer.data.subarray(5, 37).equals(key(authority)) || !signers.has(authority)) throw new Error("IncorrectAuthority");
          const maxDataLen = Number(data.readBigUInt64LE(4));
          const tail = buffer.data.subarray(37);
          if (maxDataLen < tail.length) throw new Error("AccountDataTooSmall");
          credit(payerKey, buffer.lamports);
          work.delete(bufferKey);
          debit(payerKey, rent(45 + maxDataLen));
          const header = Buffer.alloc(45);
          header.writeUInt32LE(3, 0); header.writeBigUInt64LE(451_600_000n, 4); header[12] = 1; key(authority).copy(header, 13);
          put(programData, { lamports: rent(45 + maxDataLen), owner: LOADER, executable: false,
            data: Buffer.concat([header, tail, Buffer.alloc(maxDataLen - tail.length)]) });
          const pointer = Buffer.alloc(36); pointer.writeUInt32LE(2, 0); key(programData).copy(pointer, 4);
          put(programKey, { ...programAccount, executable: true, data: pointer });
        } else if (program === LOADER && kind === 4) {
          names.push("SetAuthority");
          const programData = get(a[0]);
          if (!programData.data.subarray(13, 45).equals(key(a[1])) || !signers.has(a[1])) throw new Error("IncorrectAuthority");
          if (!a[2]) throw new Error("no new authority");
          key(a[2]).copy(programData.data, 13);
        } else if (program === LOADER && kind === 5) {
          names.push("Close");
          const buffer = get(a[0]);
          if (buffer.data.readUInt32LE(0) !== 1 || !buffer.data.subarray(5, 37).equals(key(a[2])) || !signers.has(a[2]))
            throw new Error("IncorrectAuthority");
          credit(a[1], buffer.lamports);
          work.delete(a[0]);
        } else throw new Error(`instruction ${program} ${kind} is not in this chain`);
      }
      for (const [k, account] of work) {
        if (account.lamports === 0) work.delete(k);
        else if (account.lamports < rent(account.data.length)) throw new Error(`InsufficientFundsForRent ${k}`);
      }
    } catch (error) {
      return { err: String(error instanceof Error ? error.message : error), signature, names };
    }
    if (commit) {
      this.accounts = work;
      this.landed.add(signature);
      this.fees.set(keys[0], (this.fees.get(keys[0]) ?? 0) + fee);
      this.applied.push(...names);
    }
    return { err: null, signature, names };
  }

  handlers(): Record<string, Handler> {
    const info = (k: string, slice?: { offset: number; length: number }) => {
      const a = this.accounts.get(k);
      if (!a) return { context: { slot: 1 }, value: null };
      const data = slice ? a.data.subarray(slice.offset, slice.offset + slice.length) : a.data;
      return { context: { slot: 1 }, value: { owner: a.owner, executable: a.executable, lamports: a.lamports,
        data: [data.toString("base64"), "base64"], space: a.data.length } };
    };
    return {
      getGenesisHash: () => GENESIS_HASH[this.cluster],
      getMinimumBalanceForRentExemption: ([size]) => rent(size),
      getBalance: ([k]) => ({ context: { slot: 1 }, value: this.accounts.get(k)?.lamports ?? 0 }),
      getAccountInfo: ([k, options]) => info(k, options?.dataSlice),
      getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: SYSTEM, lastValidBlockHeight: 1_150 } }),
      getBlockHeight: () => 1_000,
      getSignatureStatuses: ([signatures]) => ({ context: { slot: 1 },
        value: signatures.map((s: string) => (this.landed.has(s) ? { err: null, confirmationStatus: "confirmed" } : null)) }),
      simulateTransaction: ([wire]) => {
        const { err } = this.run(Buffer.from(wire, "base64"), false);
        return { context: { slot: 1 }, value: { err, logs: err ? [err] : [], unitsConsumed: 2_670 } };
      },
      sendTransaction: ([wire]) => {
        const { err, signature, names } = this.run(Buffer.from(wire, "base64"), true);
        if (err) throw new Error(`Transaction failed: ${err}`);
        if (this.lose(names)) throw new Error("socket hang up");
        return signature;
      },
      getFeeForMessage: ([message]) => ({ context: { slot: 1 }, value: decodeMessage(Buffer.from(message, "base64")).fee }),
      getProgramAccounts: () => {
        if (this.refuseProgramAccounts) throw new Error("Method getProgramAccounts is disabled");
        return [];
      },
    };
  }
}

/** A repository with just what the steps read: the program source, the multisig plan and the schema. */
function scratchRepo(): string {
  const repo = mkdtempSync(join(temporary, "repo-"));
  for (const file of [["src", "lib.rs"], ["mainnet-multisig-plan.json"], ["scripts", "deployment-record.schema.json"]]) {
    mkdirSync(join(repo, "programs", "editions", ...file.slice(0, -1)), { recursive: true });
    writeFileSync(join(repo, "programs", "editions", ...file), readFileSync(join(repoRoot, "programs", "editions", ...file)));
  }
  return repo;
}

async function chainTests() {
  console.log("\nthe whole deploy, on a cluster in memory");
  const chain = new Chain("mainnet-beta");
  rpc = chain.handlers();
  const repo = scratchRepo();
  const d = deps("mainnet-beta", { root: join(temporary, "e2e-mainnet"), repoRoot: repo });
  let program = "";
  d.svm = async () => ({ code: 0, output: `\n${resolve(readState(d.root)!.prepared!.elf)}\n  at ${program}\n\nprogram SVM suite passed.\n` });
  await steps.prepare(d);
  const start = readState(d.root)!;
  program = start.program;
  secrets.push(...readKeys(d.root));
  await steps.svm(d);
  out.length = 0;
  await steps.quoteStep(d);
  const toSend = Number(/Send exactly (\d+) lamports/.exec(out.join("\n"))?.[1]);
  ok("unfunded, deploy stops before creating anything and names the shortfall",
    new RegExp(`send ${toSend} to ${start.deployer}`).test(await rejection(() => steps.deploy(d))) && !chain.accounts.has(start.buffer));
  chain.accounts.set(start.deployer, { lamports: toSend, owner: SYSTEM, executable: false, data: Buffer.alloc(0) });

  let writes = 0;
  chain.lose = (names) => names.includes("Write") && ++writes === 3;
  ok("a response lost on the third write stops deploy after that write landed",
    /socket hang up/.test(await rejection(() => steps.deploy(d))) && chain.applied.filter((n) => n === "Write").length === 3);
  chain.lose = () => false;
  await steps.deploy(d);
  const elf = readFileSync(start.prepared!.elf);
  ok("deploy run again skips what the buffer already holds: every chunk written exactly once",
    chain.applied.filter((n) => n === "Write").length === Math.ceil(elf.length / UPLOAD_CHUNK_BYTES) &&
    chain.applied.filter((n) => n === "DeployWithMaxDataLen").length === 1);
  const deployedState = readState(d.root)!;
  ok("the deploy is byte-verified and the buffer is gone", deployedState.deploy?.deployed === true && !chain.accounts.has(start.buffer));
  ok("the frozen rent figures are in the state", deployedState.rent?.[String(45 + elf.length)] === rent(45 + elf.length));
  await steps.deploy(d);
  ok("deploy after the deploy sends nothing", chain.applied.filter((n) => n === "DeployWithMaxDataLen").length === 1);
  await steps.verify(d);
  ok("verify: ProgramData is 45 + the ELF, its tail the prepared digest, the authority the deployer",
    readState(d.root)!.verified?.authority === start.deployer);

  const createKey = (await generateKeyPairSigner()).address;
  const multisig = await multisigAddress(createKey);
  const vault = await vaultAddress(multisig, 0);
  chain.accounts.set(multisig, { lamports: rent(1000), owner: SQUADS_V4_PROGRAM, executable: false, data: multisigBytes({ createKey }) });
  await steps.vault(d, multisig);
  chain.lose = (names) => names.includes("SetAuthority");
  ok("a lost SetAuthority response stops authority after it landed",
    /socket hang up/.test(await rejection(() => steps.authority(d, vault))) && chain.applied.includes("SetAuthority"));
  chain.lose = () => false;
  await steps.authority(d, vault);
  ok("authority run again finds the vault already in place and sends nothing more",
    readState(d.root)!.authority?.confirmed === true && chain.applied.filter((n) => n === "SetAuthority").length === 1);
  ok("forget before the refund is still refused", /refund is not confirmed/.test(await rejection(() => steps.forget(d))));
  await steps.verify(d);
  ok("verify after the transfer expects the vault", readState(d.root)!.verified?.authority === vault);

  const owner = (await generateKeyPairSigner()).address;
  chain.accounts.set(owner, { lamports: 5_000_000, owner: SYSTEM, executable: false, data: Buffer.alloc(0) });
  await steps.refund(d, owner);
  const q = quote(elf.length, { programData: rent(45 + elf.length), programAccount: rent(36), buffer: rent(37 + elf.length) });
  const spent = rent(45 + elf.length) + rent(36) + chain.fees.get(start.deployer)!;
  ok("refund leaves the deployer at exactly 0 and the owner gets the rest",
    !chain.accounts.has(start.deployer) && chain.accounts.get(owner)!.lamports === 5_000_000 + toSend - spent);
  ok("the fees paid are exactly the quote's signatures and priority fees",
    chain.fees.get(start.deployer) === q.signatureFees + q.priorityFees);
  ok("the margin is what came back", toSend - spent === q.margin);

  out.length = 0;
  await steps.record(d, ["Owner", "Lead"]);
  const written = readdirSync(join(repo, "programs", "editions", "deployments"));
  const entry = JSON.parse(readFileSync(join(repo, "programs", "editions", "deployments", written[0]), "utf8"));
  ok("record writes programs/editions/deployments/mainnet-beta-<date>.json, and it matches the schema",
    written.length === 1 && /^mainnet-beta-\d{4}-\d{2}-\d{2}\.json$/.test(written[0]) && schemaErrors(entry, SCHEMA).length === 0);
  ok("the record names the vault, the multisig policy, the ELF digest and the ProgramData slot",
    entry.authority === vault && entry.policy === "multisig" && entry.elfSha256 === sha256(elf) &&
    entry.deployedSlot === 451_600_000 && entry.reviewedBy.join() === "Owner,Lead" && entry.notes.includes(multisig));
  ok("record prints the PROGRAM_IMAGES pin read from ProgramData",
    out.join("\n").includes(`sha256: "${sha256(elf)}"`) && out.join("\n").includes(`upgradeAuthority: "${vault}"`));
  ok("a second record the same day is refused", /already exists/.test(await rejection(() => steps.record(d, ["Owner"]))));
  await steps.forget(d);
  ok("forget deletes the three key files after re-reading authority, balance and buffer",
    ["deployer", "program", "buffer"].every((name) => !existsSync(keyPath(d.root, name as "deployer"))));
  out.length = 0;
  steps.status(d);
  ok("status: finished", out.join("\n").includes("Finished."));

  console.log("\nthe devnet rehearsal: a stopped upload closed, a wallet authority");
  const devChain = new Chain("devnet");
  devChain.refuseProgramAccounts = false;
  rpc = devChain.handlers();
  const dev = deps("devnet", { root: join(temporary, "e2e-devnet"), repoRoot: repo });
  dev.svm = async () => ({ code: 0, output: `\n7. ${resolve(readState(dev.root)!.prepared!.elf)}\n  at ${readState(dev.root)!.program}\n\nprogram SVM suite passed.\n` });
  await steps.prepare(dev);
  const rehearsal = readState(dev.root)!;
  secrets.push(...readKeys(dev.root));
  await steps.svm(dev);
  await steps.quoteStep(dev);
  const required = readState(dev.root)!.quote!.required;
  devChain.accounts.set(rehearsal.deployer, { lamports: required + 100_000, owner: SYSTEM, executable: false, data: Buffer.alloc(0) });
  out.length = 0;
  await steps.deploy({ ...dev, deadline: Date.now() - 1 });
  ok("past its deadline, deploy stops between sends with the buffer made and progress saved",
    devChain.accounts.has(rehearsal.buffer) && !devChain.applied.includes("Write") && /Stopped between sends/.test(out.join("\n")));
  const beforeClose = devChain.accounts.get(rehearsal.deployer)!.lamports;
  const bufferLamports = devChain.accounts.get(rehearsal.buffer)!.lamports;
  await steps.closeBuffer(dev);
  ok("close-buffer returns the buffer's lamports to the deployer and starts the upload over",
    !devChain.accounts.has(rehearsal.buffer) &&
    devChain.accounts.get(rehearsal.deployer)!.lamports === beforeClose + bufferLamports - 5000 - Math.ceil(COMPUTE_UNITS.close * 50_000 / 1e6) &&
    Object.keys(readState(dev.root)!.journal).length === 0 && !readState(dev.root)!.deploy?.initialized);
  await steps.deploy(dev);
  ok("deploy after close-buffer makes a new buffer and finishes", readState(dev.root)!.deploy?.deployed === true);
  await steps.verify(dev);
  const wallet = (await generateKeyPairSigner()).address;
  await steps.authority(dev, wallet, wallet);
  await steps.verify(dev);
  ok("on devnet the authority can go to a wallet typed twice", readState(dev.root)!.verified?.authority === wallet);
  await steps.refund(dev, wallet);
  ok("refund with getProgramAccounts answering leaves the deployer at 0", !devChain.accounts.has(rehearsal.deployer));
  out.length = 0;
  await steps.record(dev, ["Lead"]);
  ok("record writes no file for a wallet authority, and prints the devnet lines",
    readdirSync(join(repo, "programs", "editions", "deployments")).length === 1 &&
    out.join("\n").includes(`EXPO_PUBLIC_EDITIONS_DEVNET_PROGRAM=${rehearsal.program}`));
  await steps.forget(dev);
  ok("the rehearsal's keys are deleted too", !existsSync(keyPath(dev.root, "deployer")));
}

// --- The steps, against a temporary folder --------------------------------------------------------

const ENDPOINT = "https://rpc.example.test/v2/PATHSECRET77?api-key=QUERYSECRET88";
const out: string[] = [];
/** Every line any step printed, every error it threw, and every key it made. */
const printedSoFar: string[] = [];
const secrets: Uint8Array[] = [];
const readKeys = (root: string) => (["deployer", "program", "buffer"] as const).map((name) =>
  Uint8Array.from(JSON.parse(readFileSync(keyPath(root, name), "utf8")) as number[]));
const temporary = mkdtempSync(join(tmpdir(), "signshot-deploy-check-"));

function deps(cluster: "mainnet-beta" | "devnet", over: Partial<steps.Deps> = {}): steps.Deps {
  return {
    cluster,
    root: join(temporary, cluster),
    repoRoot,
    endpoint: ENDPOINT,
    log: (line) => { out.push(line); printedSoFar.push(line); },
    now: () => new Date("2026-09-28T12:00:00Z"),
    // Stands in for prepare-*-windows.ps1: the repository's source with only declare_id! changed.
    build: async (script, program, outputRoot) => {
      const release = join(outputRoot, "target", "sbpfv3-solana-solana", "release");
      mkdirSync(release, { recursive: true });
      mkdirSync(join(outputRoot, "src"));
      writeFileSync(join(outputRoot, "src", "lib.rs"), LIB.replace(/declare_id!\("[^"]+"\)/, `declare_id!("${program}")`));
      const elf = randomBytes(2_000);
      writeFileSync(join(release, "era_editions.so"), elf);
      writeFileSync(join(outputRoot, "prepared.json"), JSON.stringify({
        cluster: /mainnet/.test(script) ? "mainnet-beta" : "devnet", program,
        sourcePath: join(outputRoot, "src", "lib.rs"), binaryPath: join(release, "era_editions.so"),
        sha256: sha256(elf), bytes: elf.length, sharedSourceSha256: sha256(readFileSync(join(repoRoot, "programs", "editions", "src", "lib.rs"))),
      }));
    },
    svm: async () => ({ code: 0, output: "" }),
    git: (args) => (args[0] === "rev-parse" ? "0".repeat(40) : ""),
    pauseMs: 0,
    ...over,
  };
}

async function stepTests() {
  console.log("\nsteps");
  const mainnet = deps("mainnet-beta");
  ok("the key folder may not be the repository or the temporary folder",
    /inside the repository/.test(await rejection(() => assertKeyRoot(join(repoRoot, "keys"), repoRoot))) &&
    /temporary folder/.test(await rejection(() => assertKeyRoot(join(tmpdir(), "keys"), repoRoot))) &&
    (await rejection(() => assertKeyRoot("C:\\Users\\someone\\AppData\\Local\\signshot-deploy\\mainnet-beta", repoRoot))) === "");

  offline();
  ok("a step with no deploy state stops before any request",
    /start with npm run mainnet -- prepare/.test(await rejection(() => steps.quoteStep(mainnet))) && calls.length === 0);
  rpc.getGenesisHash = () => GENESIS_HASH.devnet;
  ok("prepare refuses an endpoint whose genesis is another cluster's, before making keys",
    /not mainnet-beta/.test(await rejection(() => steps.prepare(mainnet))) && !existsSync(mainnet.root));
  rpc.getGenesisHash = () => GENESIS_HASH["mainnet-beta"];
  ok("a mainnet build is refused from uncommitted source",
    /uncommitted/.test(await rejection(() => steps.prepare(deps("mainnet-beta", { git: (a) => (a[0] === "rev-parse" ? "0".repeat(40) : " M programs/editions/src/lib.rs") })))));

  await steps.prepare(mainnet);
  const first = readState(mainnet.root)!;
  ok("prepare makes three keys and records the build", Boolean(first.prepared) &&
    ["deployer", "program", "buffer"].every((name) => existsSync(keyPath(mainnet.root, name as "deployer"))));
  const made = readKeys(mainnet.root);
  secrets.push(...made);
  ok("key files are the Solana CLI's 64-number keypair", made.length === 3 && made.every((s) => s.length === 64));
  ok("keys are made once: a second creation is refused",
    /refusing to overwrite/.test(await rejection(() => createKeys(mainnet.root, "mainnet-beta", new Date()))));
  const stateText = readFileSync(statePath(mainnet.root), "utf8");
  unlinkSync(statePath(mainnet.root));
  ok("even with the state gone, existing key files are never overwritten",
    /refusing to overwrite/.test(await rejection(() => createKeys(mainnet.root, "mainnet-beta", new Date()))));
  writeFileSync(statePath(mainnet.root), stateText);
  const keys = await loadKeys(mainnet.root, first);
  ok("loaded keys are the recorded addresses", keys.deployer.address === first.deployer && keys.program.address === first.program);
  ok("a loaded private key cannot be exported",
    (await rejection(() => crypto.subtle.exportKey("pkcs8", keys.deployer.keyPair.privateKey))) !== "");
  const swapped = { ...first, deployer: first.buffer };
  ok("a key file that is not the recorded address is refused", /but the state names/.test(await rejection(() => loadKeys(mainnet.root, swapped))));

  offline();
  ok("quote before svm is refused, without a request",
    /Run svm first/.test(await rejection(() => steps.quoteStep(mainnet))) && calls.length === 0);
  ok("deploy before svm is refused, without a request",
    /Run svm first/.test(await rejection(() => steps.deploy(mainnet))) && calls.length === 0);

  rpc.getGenesisHash = () => GENESIS_HASH["mainnet-beta"];
  const elf = first.prepared!.elf;
  const passing = `\n${resolve(elf)}\n  at ${first.program}; Metaplex Core ...\nPASS  publish\n\nprogram SVM suite passed.\n`;
  const ran: string[] = [];
  const svmWith = (code: number | null, output: string) => deps("mainnet-beta", { svm: async (args) => {
    ran.push(args.join(" "));
    return { code, output };
  } });
  ok("svm: an exit code of 0 with SKIP is not a pass",
    /did not pass/.test(await rejection(() => steps.svm(svmWith(0, "SKIP  no ELF: pass --plain ...\n")))) && readState(mainnet.root)!.svm?.passed === false);
  ok("svm: a pass for another ELF is not a pass",
    /did not pass/.test(await rejection(() => steps.svm(svmWith(0, passing.replace(resolve(elf), "C:\\other.so"))))));
  ok("svm: a FAIL line is not a pass", /did not pass/.test(await rejection(() => steps.svm(svmWith(0, passing.replace("PASS", "FAIL"))))));
  ok("svm: a non-zero exit is not a pass", /did not pass/.test(await rejection(() => steps.svm(svmWith(1, passing)))));
  await steps.svm(svmWith(0, passing));
  ok("svm: a pass on the prepared ELF is recorded against its digest", readState(mainnet.root)!.svm?.sha256 === first.prepared!.sha256);
  ok("svm runs test:svm on the prepared ELF as the plain build, at the program key's address",
    ran.length === 5 && ran.every((args) => args === `--plain ${elf} --plain-id ${first.program}`));

  rpc.getMinimumBalanceForRentExemption = ([size]) => rent(size);
  rpc.getBalance = () => ({ context: { slot: 1 }, value: 1_000_000 });
  out.length = 0;
  await steps.quoteStep(mainnet);
  const quoted = readState(mainnet.root)!.quote!;
  const expected = quote(2_000, { programData: rent(2_045), programAccount: rent(36), buffer: rent(2_037) }).required;
  ok("quote records the live rent and prints the exact lamports to send the deployer",
    quoted.required === expected && out.join("\n").includes(`Send exactly ${expected - 1_000_000} lamports to ${first.deployer}`));

  await steps.prepare(mainnet);
  const second = readState(mainnet.root)!;
  ok("prepare again, before any upload: same keys, a fresh folder, svm and quote cleared",
    second.program === first.program && second.prepared!.outputRoot.endsWith("elf-2") && !second.svm && !second.quote);
  second.deploy = { initialized: true };
  saveState(mainnet.root, second);
  ok("prepare is refused once the upload has started", /upload has started/.test(await rejection(() => steps.prepare(mainnet))));

  // As if deployed and verified: the refusals below must come before any request.
  const deployed = readState(mainnet.root)!;
  deployed.svm = { passed: true, sha256: deployed.prepared!.sha256, at: "" };
  deployed.quote = { ...quoted, elfBytes: deployed.prepared!.bytes };
  deployed.deploy = { deployed: true, slot: "1" };
  deployed.verified = { authority: deployed.deployer, slot: "1", programData: NO_KEY, at: "" };
  saveState(mainnet.root, deployed);
  offline();
  const stranger = (await generateKeyPairSigner()).address;
  ok("authority to an address no vault step verified is refused, without a request",
    /not the vault verified/.test(await rejection(() => steps.authority(mainnet, stranger))) && calls.length === 0);
  ok("authority to a wallet is refused on mainnet",
    /devnet rehearsal/.test(await rejection(() => steps.authority(mainnet, stranger, stranger))) && calls.length === 0);
  ok("forget before the authority transfer is refused",
    /authority transfer is not confirmed/.test(await rejection(() => steps.forget(mainnet))) && calls.length === 0);
  ok("refund before the authority transfer is refused",
    /Transfer the upgrade authority first/.test(await rejection(() => steps.refund(mainnet, stranger))) && calls.length === 0);

  const createKey = (await generateKeyPairSigner()).address;
  const multisig = await multisigAddress(createKey);
  const vault = await vaultAddress(multisig, 0);
  rpc.getGenesisHash = () => GENESIS_HASH["mainnet-beta"];
  rpc.getAccountInfo = ([at]) => (at === multisig ? accountInfo(SQUADS_V4_PROGRAM, multisigBytes({ createKey })) : { context: { slot: 1 }, value: null });
  await steps.vault(mainnet, multisig);
  ok("vault verifies the multisig against the plan and records its vault, index 0", readState(mainnet.root)!.vault?.vault === vault);
  rpc.getAccountInfo = ([at]) => (at === multisig ? accountInfo(SQUADS_V4_PROGRAM, multisigBytes({ createKey, threshold: 1 })) : { context: { slot: 1 }, value: null });
  ok("vault refuses a multisig that is not the plan", /not the reviewed multisig/.test(await rejection(() => steps.vault(mainnet, multisig))));
  ok("authority to the multisig account itself is refused", /not the vault verified/.test(await rejection(() => steps.authority(mainnet, multisig))));
  ok("authority to the verified vault re-reads the multisig before anything is signed",
    /not the reviewed multisig/.test(await rejection(() => steps.authority(mainnet, vault))));
  rpc.getAccountInfo = ([at]) => (at === multisig ? accountInfo(SQUADS_V4_PROGRAM, multisigBytes({ createKey })) : { context: { slot: 1 }, value: null });
  ok("authority to the verified vault reaches the program read (here, no program)",
    /is not a deployed loader-v3 program/.test(await rejection(() => steps.authority(mainnet, vault))));

  const confirmed = readState(mainnet.root)!;
  confirmed.authority = { to: vault, kind: "vault", confirmed: true, at: "" };
  saveState(mainnet.root, confirmed);
  offline();
  ok("forget before the refund is refused, without a request",
    /refund is not confirmed/.test(await rejection(() => steps.forget(mainnet))) && calls.length === 0);
  ok("record needs a reviewer", /--reviewed-by/.test(await rejection(() => steps.record(mainnet, [" "]))));
  ok("refund to one of the deploy's own keys is refused",
    /own accounts/.test(await rejection(() => steps.refund(mainnet, confirmed.deployer))));

  const devnet = deps("devnet");
  rpc.getGenesisHash = () => GENESIS_HASH.devnet;
  await steps.prepare(devnet);
  const rehearsal = readState(devnet.root)!;
  ok("the devnet rehearsal builds with prepare-devnet-windows.ps1 into its own folder",
    rehearsal.cluster === "devnet" && rehearsal.program !== first.program && rehearsal.prepared!.outputRoot.startsWith(devnet.root));
  ok("svm on devnet runs the build as the devnet-genesis one",
    steps.svmArgs("devnet", "x.so", rehearsal.program).join(" ") === `--devnet x.so --devnet-id ${rehearsal.program}`);
  rehearsal.deploy = { deployed: true };
  rehearsal.verified = { authority: rehearsal.deployer, slot: "1", programData: NO_KEY, at: "" };
  saveState(devnet.root, rehearsal);
  offline();
  ok("on devnet, --wallet must repeat --to",
    /must repeat/.test(await rejection(() => steps.authority(devnet, stranger, NO_KEY))));
  ok("on devnet, a wallet must be on the curve (a vault is not a wallet)",
    /off the curve/.test(await rejection(() => steps.authority(devnet, vault, vault))));
  ok("a mainnet folder is not read as devnet", /holds a mainnet-beta deploy/.test(await rejection(() =>
    steps.verify({ ...devnet, root: mainnet.root }))));

  out.length = 0;
  offline();
  steps.status(mainnet);
  const moved = readState(mainnet.root)!;
  moved.verified = { ...moved.verified!, authority: vault };
  saveState(mainnet.root, moved);
  steps.status(mainnet);
  ok("status reads only the state and names the next step: verify after the transfer, then refund",
    out[0].includes("Next: npm run mainnet -- verify") &&
    out[1].includes("Next: npm run mainnet -- refund --to <owner address>") && calls.length === 0);
}

/** Everything printed and saved, against every encoding of every secret byte made in this run. */
function secretTests() {
  console.log("\nsecrets");
  const printed = printedSoFar.concat(out, logged).join("\n") + readdirSync(temporary, { recursive: true })
    .map((file) => join(temporary, String(file)))
    .filter((file) => statSync(file).isFile() && file.endsWith("state.json"))
    .map((file) => readFileSync(file, "utf8")).join("\n");
  const forms = secrets.flatMap((pair) => [
    Buffer.from(pair.subarray(0, 32)).toString("hex"), Buffer.from(pair).toString("hex"),
    Buffer.from(pair.subarray(0, 32)).toString("base64"), Buffer.from(pair).toString("base64"),
    getBase58Decoder().decode(pair.subarray(0, 32)), getBase58Decoder().decode(pair),
    Array.from(pair.subarray(0, 12)).join(","), Array.from(pair.subarray(0, 12)).join(", "),
  ]);
  ok("no step printed or saved a secret key byte, in any encoding", forms.every((form) => !printed.includes(form)));
  ok("no step printed or saved the endpoint or its key",
    !printed.includes("PATHSECRET77") && !printed.includes("QUERYSECRET88") && !printed.includes("rpc.example.test"));
}

function scrubTests() {
  console.log("\nendpoint");
  const said = `request to ${ENDPOINT} failed: api-key=QUERYSECRET88 at /v2/PATHSECRET77/ (${encodeURI(ENDPOINT)})`;
  const cut = steps.scrub(said, ENDPOINT);
  ok("an error's text loses the endpoint and each part that could be a key",
    !cut.includes("QUERYSECRET88") && !cut.includes("PATHSECRET77") && cut.includes("<rpc>"));
  ok("with no endpoint set, text is unchanged", steps.scrub(said) === said);
}

// Every console line too: the shared send prints through console.log.
const logged: string[] = [];
const print = console.log.bind(console);
console.log = (...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); print(...parts); };

void (async () => {
  try {
    await squadsTests();
    quoteTests();
    await packetTests();
    recordTests();
    await stepTests();
    await chainTests();
    scrubTests();
    secretTests();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
})().then(
  () => {
    console.log(failures ? `\n${failures} check(s) failed.` : "\nmainnet deploy self-test passed.");
    process.exit(failures ? 1 : 0);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
