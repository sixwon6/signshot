/**
 * What the deploy costs, from live rent and the ELF's size. Every transaction carries a compute
 * limit near its measured use and one fixed price, so the fee is known before anything is sent
 * (priority fee = ceil(limit × price / 1,000,000), https://solana.com/docs/core/fees). The price
 * is not sampled from recent fees: a loader write locks only its own buffer, so it does not
 * compete for busy accounts.
 */
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import type { Instruction } from "@solana/kit";
import {
  BUFFER_HEADER,
  LAMPORTS_PER_SIGNATURE,
  PROGRAM_ACCOUNT_BYTES,
  PROGRAM_DATA_HEADER,
  UPLOAD_CHUNK_BYTES,
} from "../deploy/loaderV3";

/** Micro-lamports per compute unit, on every transaction this tool sends. */
export const COMPUTE_UNIT_PRICE = 50_000;

/**
 * Compute-unit limits. A loader instruction costs 2,370 units (measured per write on devnet), a
 * System one 150 and each compute-budget instruction 150. The deploy keeps the devnet session's
 * 1,400,000: it runs the loader's ELF verification and is sent once.
 */
export const COMPUTE_UNITS = {
  buffer: 6_000,
  write: 4_000,
  deploy: 1_400_000,
  authority: 4_000,
  refund: 1_000,
  close: 4_000,
} as const;

/** Headroom for a write sent twice, a changed rent step and rounding. `refund` returns what is left. */
export const MARGIN_LAMPORTS = 10_000_000;

export const priorityFee = (units: number) => Math.ceil((units * COMPUTE_UNIT_PRICE) / 1_000_000);

/** The two compute-budget instructions that open each transaction. */
export const budget = (units: number): Instruction[] => [
  getSetComputeUnitLimitInstruction({ units }),
  getSetComputeUnitPriceInstruction({ microLamports: COMPUTE_UNIT_PRICE }),
];

/** Rent-exempt minimums read from the cluster, in lamports. */
export interface Rent {
  /** ProgramData, 45 + ELF bytes: the program's permanent rent. */
  programData: number;
  /** The 36-byte program account. */
  programAccount: number;
  /** A buffer's minimum, 37 + ELF bytes, for reference: the buffer is funded at `programData`. */
  buffer: number;
}

export interface Quote {
  elfBytes: number;
  writes: number;
  rent: Rent;
  signatureFees: number;
  priorityFees: number;
  margin: number;
  /** What the deployer must hold before the buffer is created. */
  required: number;
}

/** The byte sizes whose rent the quote reads. */
export const rentSizes = (elfBytes: number) => ({
  programData: PROGRAM_DATA_HEADER + elfBytes,
  programAccount: PROGRAM_ACCOUNT_BYTES,
  buffer: BUFFER_HEADER + elfBytes,
});

/**
 * The buffer is funded with ProgramData's rent, as the Solana CLI funds it, and
 * `DeployWithMaxDataLen` drains it back to the deployer before it funds ProgramData, so the
 * buffer's rent is held during the upload and never added. Signatures: the buffer (deployer and
 * buffer key), one per write, the deploy (deployer and program key), the authority transfer and
 * the refund.
 */
export function quote(elfBytes: number, rent: Rent): Quote {
  if (!Number.isSafeInteger(elfBytes) || elfBytes <= 0) throw new Error("Invalid program byte count");
  for (const [name, lamports] of Object.entries(rent))
    if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new Error(`Invalid ${name} rent`);
  const writes = Math.ceil(elfBytes / UPLOAD_CHUNK_BYTES);
  const signatureFees = (2 + writes + 2 + 1 + 1) * LAMPORTS_PER_SIGNATURE;
  const priorityFees =
    priorityFee(COMPUTE_UNITS.buffer) +
    writes * priorityFee(COMPUTE_UNITS.write) +
    priorityFee(COMPUTE_UNITS.deploy) +
    priorityFee(COMPUTE_UNITS.authority) +
    priorityFee(COMPUTE_UNITS.refund);
  const required =
    rent.programData + rent.programAccount + signatureFees + priorityFees + MARGIN_LAMPORTS;
  return { elfBytes, writes, rent, signatureFees, priorityFees, margin: MARGIN_LAMPORTS, required };
}

/** "2,183,523,990 lamports (2.18352399 SOL)". */
export function lamportsText(lamports: number): string {
  const sol = (lamports / 1e9).toFixed(9).replace(/\.?0+$/, "");
  return `${lamports.toLocaleString("en-US")} lamports (${sol} SOL)`;
}
