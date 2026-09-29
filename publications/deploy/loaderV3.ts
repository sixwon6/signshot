/**
 * Uploading and deploying `era_editions` through the upgradeable loader (loader-v3). Shared by the
 * devnet session (`../devnet/work.ts`) and the mainnet step tool (`../mainnet/`), which pass their own
 * guard, journal store, fee instructions and pacing.
 *
 *  - every send is simulated with `sigVerify` first, size-checked against the packet limit, and
 *    journalled by a blockhash-independent operation id BEFORE it is broadcast, so a lost response
 *    is reconciled rather than duplicated,
 *  - a re-run reads the program and buffer accounts first and never assumes a send failed,
 *  - a deployment is accepted only after the uploaded and the deployed bytes are compared with the
 *    locally built ELF byte for byte.
 *
 * Loader layouts (bincode): Buffer is u32 1, an Option tag and a 32-byte authority (37 bytes), then
 * the ELF; Program is u32 2 and the ProgramData address (36); ProgramData is u32 3, a u64 slot, an
 * Option tag and a 32-byte authority (45), then the ELF.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  getAddressEncoder,
  getProgramDerivedAddress,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  partiallySignTransaction,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  LOADER_V3_PROGRAM_ADDRESS as LOADER,
  getInitializeBufferInstruction,
  getWriteInstruction,
  getDeployWithMaxDataLenInstruction,
} from "@solana-program/loader-v3";
import { request, confirmTransaction } from "../rpc";
import { checkAttempt, type TransactionAttempt } from "../lifecycle";

/** Bytes per buffer write; a full chunk with two compute-budget instructions still fits a packet. */
export const UPLOAD_CHUNK_BYTES = 900;
export const LAMPORTS_PER_SIGNATURE = 5_000;
export const BUFFER_HEADER = 37;
export const PROGRAM_ACCOUNT_BYTES = 36;
export const PROGRAM_DATA_HEADER = 45;
export const PACKET_BYTES = 1232;

export type Journal = Record<string, TransactionAttempt & { confirmed?: boolean }>;

/** Who pays, where the journal lives and what must hold before any request that could send. */
export interface Sender {
  endpoint: string;
  payer: KeyPairSigner;
  journal: Journal;
  guard(): Promise<void>;
  /** Persists `journal`; called before every broadcast and after every confirmation. */
  save(): void;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// `ArrayLike<number>`, not `Uint8Array`: a Kit instruction's `data` is a ReadonlyUint8Array.
const hex = (bytes: ArrayLike<number>) =>
  Buffer.from(Uint8Array.from(Array.from(bytes))).toString("hex");

/** Stable instruction identity, independent of the blockhash. */
export function operationId(payer: string, instructions: Instruction[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        payer,
        instructions: instructions.map((ix) => ({
          program: ix.programAddress,
          accounts: ix.accounts?.map((a) => ({
            address: a.address,
            role: a.role,
          })),
          data: hex(ix.data ?? new Uint8Array()),
        })),
      }),
    )
    .digest("hex");
}

export async function sendJournalled(
  s: Sender,
  instructions: Instruction[],
  signers = [s.payer],
  expectedFailure?: RegExp,
) {
  await s.guard();
  // Retrying the same command first resolves its known signature, even after a lost send response.
  const operation = operationId(s.payer.address, instructions);
  const previous = !expectedFailure && s.journal[operation];
  if (previous) {
    const state = previous.confirmed
      ? "confirmed"
      : await checkAttempt(s.endpoint, previous);
    if (state === "confirmed") {
      previous.confirmed = true;
      s.save();
      return previous.signature!;
    }
    if (state !== "retryable")
      throw new Error(
        `Previous transaction is still unresolved; do not duplicate it: ${previous.signature}`,
      );
  }
  const { value: lifetime } = await request<any>(
    s.endpoint,
    "getLatestBlockhash",
    [{ commitment: "confirmed" }],
  );
  const paid = setTransactionMessageFeePayer(
    s.payer.address,
    createTransactionMessage({ version: 0 }),
  );
  const expiring = setTransactionMessageLifetimeUsingBlockhash(
    {
      ...lifetime,
      lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
    },
    paid,
  );
  const message = appendTransactionMessageInstructions(instructions, expiring);
  const tx = await partiallySignTransaction(
    signers.map((signer) => signer.keyPair),
    compileTransaction(message),
  );
  const wire = getBase64EncodedWireTransaction(tx);
  assert.ok(
    Buffer.from(wire, "base64").length <= PACKET_BYTES,
    "Transaction exceeds network packet limit",
  );
  const { value: simulation } = await request<any>(
    s.endpoint,
    "simulateTransaction",
    [wire, { encoding: "base64", commitment: "confirmed", sigVerify: true }],
  );
  if (expectedFailure) {
    assert.ok(simulation.err, "Expected rejection; transaction was not sent");
    assert.match(simulation.logs?.join("\n") ?? "", expectedFailure);
    console.log("Expected rejection verified:", expectedFailure.source);
    return `simulation-rejected:${expectedFailure.source}`;
  }
  if (simulation.err)
    throw new Error(
      `Simulation failed: ${JSON.stringify(simulation.err)}\n${simulation.logs?.join("\n")}`,
    );
  const signature = getSignatureFromTransaction(tx);
  s.journal[operation] = {
    signature,
    lastValidBlockHeight: String(lifetime.lastValidBlockHeight),
  };
  s.save();
  console.log(
    "Simulation OK:",
    simulation.unitsConsumed,
    "CU; sending",
    signature,
  );
  const submitted = await request<string>(s.endpoint, "sendTransaction", [
    wire,
    { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 },
  ]);
  assert.equal(submitted, signature);
  await confirmTransaction(
    s.endpoint,
    signature,
    BigInt(lifetime.lastValidBlockHeight),
  );
  s.journal[operation].confirmed = true;
  s.save();
  return signature;
}

/**
 * The public devnet endpoint reports rate limiting two ways: HTTP 429, which
 * `publications/rpc.ts` turns into "Solana connection unavailable (429)", and HTTP 200
 * carrying a JSON-RPC error, whose bare message ("Too many requests") that same helper
 * rethrows with no status in it. Match both, plus the generic wording.
 */
const RATE_LIMITED = /\(429\)|too many requests|rate limit/i;
/**
 * A 429 raised while confirming leaves a broadcast attempt pending in the journal, so the
 * next `send` of that operation refuses to duplicate it. Waiting is the only safe response:
 * the attempt resolves itself once it confirms or its blockhash expires.
 */
const UNRESOLVED = /still unresolved; do not duplicate it/;

export async function retryRateLimited<T>(
  work: () => Promise<T>,
  pause: () => Promise<void> = () => sleep(20_000),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); }
    catch (error) {
      if (attempt >= 5 || !(error instanceof Error)) throw error;
      const limited = RATE_LIMITED.test(error.message);
      if (!limited && !UNRESOLVED.test(error.message)) throw error;
      console.log(
        limited
          ? "RPC rate limit; waiting before reconciling the saved operation."
          : "A broadcast attempt is still pending; waiting for it to confirm or expire.",
      );
      await pause();
    }
  }
}

/** The ProgramData address of `program`. */
export async function programDataAddress(program: string): Promise<Address> {
  const [programData] = await getProgramDerivedAddress({
    programAddress: LOADER,
    seeds: [getAddressEncoder().encode(program as Address)],
  });
  return programData;
}

async function accountBytes(endpoint: string, key: string) {
  const { value } = await request<any>(endpoint, "getAccountInfo", [
    key,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  return value
    ? { owner: value.owner as string, executable: value.executable as boolean,
        data: Buffer.from(value.data[0], "base64") }
    : null;
}

/** What one upload needs besides the keys: fee instructions, pacing and where progress is kept. */
export interface Upload {
  sender: Sender;
  program: KeyPairSigner;
  buffer: KeyPairSigner;
  binary: Buffer;
  /** Kept by the caller: in memory for the devnet session, in the state file for mainnet. */
  progress: { offset?: number; initialized?: boolean; deploymentSignature?: string };
  saveProgress(): void;
  /** Lamports for an account of `size` bytes. Mainnet freezes it on first use (stable operation ids). */
  rent(size: number): Promise<number>;
  /** Throws unless the payer can fund everything from the buffer on. Runs once, before the buffer. */
  beforeBuffer(): Promise<void>;
  /** Compute-budget instructions put first in each transaction. */
  prefix: { buffer: Instruction[]; write: Instruction[]; deploy: Instruction[] };
  pauseMs: number;
  /** Skip every chunk the buffer already holds, read once, instead of resuming from `offset`. */
  skipWritten: boolean;
  /** Stop between sends after this time (ms since epoch); progress is saved. */
  deadline?: number;
  retryPause?: () => Promise<void>;
}

/**
 * Creates the buffer, writes the ELF, and deploys it with `max_data_len` exactly the ELF's length.
 * `DeployWithMaxDataLen` drains the buffer to the payer before it funds ProgramData (Agave
 * `programs/bpf_loader`), so buffer and ProgramData rent never coexist. Resolves `"paused"` when
 * `deadline` passed between sends.
 */
export async function uploadAndDeploy(u: Upload): Promise<"deployed" | "paused"> {
  const { sender, program, buffer, binary, progress } = u;
  const send = (instructions: Instruction[], signers?: KeyPairSigner[]) =>
    sendJournalled(sender, instructions, signers);
  const programData = await programDataAddress(program.address);
  // A lost final deployment response is resolved by the exact executable bytes;
  // its buffer was consumed, so do not try to create/upload that buffer again.
  if (await accountBytes(sender.endpoint, program.address)) return "deployed";
  if (!progress.initialized) {
    const held = await accountBytes(sender.endpoint, buffer.address);
    if (held) {
      assert.equal(held.owner, LOADER);
      assert.equal(held.data.length, binary.length + BUFFER_HEADER);
      assert.equal(held.data.readUInt32LE(0), 1);
      assert.equal(held.data[4], 1);
      assert.deepEqual(
        held.data.subarray(5, BUFFER_HEADER),
        Buffer.from(getAddressEncoder().encode(sender.payer.address)),
      );
      progress.initialized = true;
      u.saveProgress();
    }
  }
  if (!progress.initialized) {
    await u.beforeBuffer();
    await send(
      [
        ...u.prefix.buffer,
        getCreateAccountInstruction({
          payer: sender.payer,
          newAccount: buffer,
          lamports: await u.rent(binary.length + PROGRAM_DATA_HEADER),
          space: binary.length + BUFFER_HEADER,
          programAddress: LOADER,
        }),
        getInitializeBufferInstruction({
          sourceAccount: buffer.address,
          bufferAuthority: sender.payer.address,
        }),
      ],
      [sender.payer, buffer],
    );
    progress.initialized = true;
    u.saveProgress();
  }
  const written = u.skipWritten
    ? (await accountBytes(sender.endpoint, buffer.address))?.data.subarray(BUFFER_HEADER)
    : undefined;
  for (let offset = u.skipWritten ? 0 : progress.offset ?? 0; offset < binary.length; offset += UPLOAD_CHUNK_BYTES) {
    const chunk = binary.subarray(offset, offset + UPLOAD_CHUNK_BYTES);
    if (!written?.subarray(offset, offset + chunk.length).equals(chunk)) {
      if (u.deadline !== undefined && Date.now() > u.deadline) return "paused";
      await retryRateLimited(() => send([
        ...u.prefix.write,
        getWriteInstruction({
          bufferAccount: buffer.address,
          bufferAuthority: sender.payer,
          offset,
          bytes: chunk,
        }),
      ]), u.retryPause);
      if (u.pauseMs) await sleep(u.pauseMs);
    }
    progress.offset = Math.min(offset + UPLOAD_CHUNK_BYTES, binary.length);
    u.saveProgress();
    if (offset % (UPLOAD_CHUNK_BYTES * 10) === 0)
      console.log("Program upload:", progress.offset, "/", binary.length);
  }
  const info = await accountBytes(sender.endpoint, buffer.address);
  assert.equal(info?.owner, LOADER);
  assert.deepEqual(
    info!.data.subarray(BUFFER_HEADER),
    binary,
    "Uploaded binary differs",
  );
  if (u.deadline !== undefined && Date.now() > u.deadline) return "paused";
  progress.deploymentSignature = await send(
    [
      ...u.prefix.deploy,
      getCreateAccountInstruction({
        payer: sender.payer,
        newAccount: program,
        lamports: await u.rent(PROGRAM_ACCOUNT_BYTES),
        space: PROGRAM_ACCOUNT_BYTES,
        programAddress: LOADER,
      }),
      getDeployWithMaxDataLenInstruction({
        payerAccount: sender.payer,
        programDataAccount: programData,
        programAccount: program.address,
        bufferAccount: buffer.address,
        authority: sender.payer,
        maxDataLen: binary.length,
      }),
    ],
    [sender.payer, program],
  );
  u.saveProgress();
  await sleep(1500);
  return "deployed";
}

/**
 * The deployed program must be `binary`, byte for byte, behind the derived ProgramData address,
 * with `authority` as its upgrade authority. Returns the ProgramData address and its slot.
 */
export async function verifyDeployed(
  endpoint: string,
  program: string,
  binary: Buffer,
  authority: string,
): Promise<{ programData: Address; slot: bigint }> {
  const programData = await programDataAddress(program);
  const deployed = await accountBytes(endpoint, program);
  assert.equal(deployed?.owner, LOADER);
  assert.equal(deployed!.executable, true);
  assert.equal(deployed!.data.readUInt32LE(0), 2);
  assert.deepEqual(
    deployed!.data.subarray(4),
    Buffer.from(getAddressEncoder().encode(programData)),
  );
  const data = await accountBytes(endpoint, programData);
  assert.equal(data?.owner, LOADER);
  assert.equal(data!.data.readUInt32LE(0), 3);
  assert.equal(data!.data[12], 1);
  assert.deepEqual(
    data!.data.subarray(13, PROGRAM_DATA_HEADER),
    Buffer.from(getAddressEncoder().encode(authority as Address)),
  );
  assert.deepEqual(data!.data.subarray(PROGRAM_DATA_HEADER), binary);
  return { programData, slot: data!.data.readBigUInt64LE(4) };
}
