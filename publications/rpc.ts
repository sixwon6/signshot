import {
  address,
  getBase64Encoder,
  getBase64Decoder,
  createSolanaRpc,
  signature,
  type Instruction,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  partiallySignTransaction,
  getBase64EncodedWireTransaction,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
/**
 * Compute-budget ceiling and floor price. `core/transferReceipt.ts` bounds a wallet's fee rewrite
 * against these same values. https://solana.com/docs/core/fees
 */
const COMPUTE_UNIT_LIMIT = 400_000;
export const COMPUTE_UNIT_PRICE = 5_000n;
/** Wallet-added priority/guard costs, visibly included in the estimate rather than called a price. */
export const FEE_ALLOWANCE_LAMPORTS = 50_000n;

/**
 * Compute budget grid. Limit: `unitsConsumed × 13/10` rounded up to a step, within
 * [one step, COMPUTE_UNIT_LIMIT]. Price: median recent fee clamped to [COMPUTE_UNIT_PRICE,
 * COMPUTE_UNIT_PRICE_MAX] (an endpoint-supplied number) and rounded up to a step. Rounding keeps
 * the message bytes stable for the byte-for-byte check in `src/prints/quoteRefresh.ts`.
 */
const COMPUTE_UNIT_LIMIT_STEP = 50_000;
const COMPUTE_UNIT_MARGIN_NUMERATOR = 13n;
const COMPUTE_UNIT_MARGIN_DENOMINATOR = 10n;
const COMPUTE_UNIT_PRICE_STEP = 5_000n;
const COMPUTE_UNIT_PRICE_MAX = 50_000n;

/** `ceil(price × limit / 1_000_000)` lamports — the documented prioritization-fee arithmetic. */
const priorityFeeLamports = (limit: number, price: bigint): bigint =>
  (price * BigInt(limit) + 999_999n) / 1_000_000n;

/** The units to request for a transaction the network says consumed `unitsConsumed`. */
function computeUnitLimitFor(unitsConsumed: number | bigint): number {
  const units = BigInt(unitsConsumed);
  const step = BigInt(COMPUTE_UNIT_LIMIT_STEP);
  const ceiling = BigInt(COMPUTE_UNIT_LIMIT);
  if (units <= 0n) return COMPUTE_UNIT_LIMIT;
  const margin =
    (units * COMPUTE_UNIT_MARGIN_NUMERATOR + COMPUTE_UNIT_MARGIN_DENOMINATOR - 1n) /
    COMPUTE_UNIT_MARGIN_DENOMINATOR;
  const rounded = ((margin + step - 1n) / step) * step;
  return Number(rounded > ceiling ? ceiling : rounded < step ? step : rounded);
}

/**
 * The price to request, from a raw `getRecentPrioritizationFees` result. Malformed entries are
 * ignored; never throws, because an advisory fee query must not fail a quote.
 */
function computeUnitPriceFrom(fees: unknown): bigint {
  const values: bigint[] = [];
  if (Array.isArray(fees))
    for (const entry of fees) {
      const fee = (entry as { prioritizationFee?: unknown } | null)?.prioritizationFee;
      if (typeof fee === "bigint" || (typeof fee === "number" && Number.isSafeInteger(fee))) {
        const value = BigInt(fee);
        if (value >= 0n) values.push(value);
      }
    }
  values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // The lower median: with the usual answer — most slots reporting 0 — this is 0, and the floor
  // below is what is actually requested, which is what keeps a quote refresh byte-stable.
  const median = values.length ? values[(values.length - 1) >> 1] : 0n;
  const floored = median < COMPUTE_UNIT_PRICE ? COMPUTE_UNIT_PRICE : median;
  const capped = floored > COMPUTE_UNIT_PRICE_MAX ? COMPUTE_UNIT_PRICE_MAX : floored;
  return ((capped + COMPUTE_UNIT_PRICE_STEP - 1n) / COMPUTE_UNIT_PRICE_STEP) * COMPUTE_UNIT_PRICE_STEP;
}

/**
 * Byte cap for a JSON-RPC body, enforced before `JSON.parse` so a hostile endpoint cannot force a
 * huge allocation. Generous for every method this client calls.
 */
const RPC_MAX_BYTES = 4_000_000;
const RPC_TOO_LARGE = "The Solana response is too large to read safely.";
/**
 * The `id` every response must echo. Fixed, since requests are never multiplexed; the check
 * rejects bodies that are not a JSON-RPC reply at all (captive portals, cached pages).
 */
const RPC_REQUEST_ID = 1;

/**
 * A response body read with a byte ceiling. Streams are counted and aborted past `limit`. React
 * Native's fetch has no stream, so there `Content-Length` is the only pre-read bound, and
 * `refuseUndeclared` decides whether a missing length is refused (gateway files) or allowed (RPC).
 */
async function boundedBody(
  res: Response,
  limit: number,
  tooLarge: string,
  abort: () => void,
  refuseUndeclared: boolean,
): Promise<Uint8Array> {
  const declared = res.headers?.get?.("content-length") ?? null;
  const undeclared = declared === null || declared.trim() === "";
  if (!undeclared) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > limit)
      throw new Error(tooLarge);
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    if (undeclared && refuseUndeclared) throw new Error(tooLarge);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > limit) throw new Error(tooLarge);
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > limit) {
        abort();
        throw new Error(tooLarge);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function request<T>(
  endpoint: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: RPC_REQUEST_ID, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // A proxy may explain a 502/503 in a JSON-RPC error body; prefer that over the bare status.
      let message: string | undefined;
      try {
        // Bounded like any other body: an error page is still a body a hostile endpoint chooses.
        const body = JSON.parse(
          new TextDecoder().decode(
            await boundedBody(res, RPC_MAX_BYTES, RPC_TOO_LARGE, () => controller.abort(), false),
          ),
        );
        const text = body?.error?.message;
        if (typeof text === "string" && text.trim()) message = text.trim();
      } catch {
        // A non-JSON, oversized or truncated error body is not itself an error: use the status.
      }
      throw new Error(
        message ?? `Solana connection unavailable (${res.status}). Please retry.`,
      );
    }
    const body = JSON.parse(
      new TextDecoder().decode(
        await boundedBody(res, RPC_MAX_BYTES, RPC_TOO_LARGE, () => controller.abort(), false),
      ),
    );
    // The envelope before the payload. A body that does not name JSON-RPC 2.0 and echo this
    // call's own `id` is not an answer to this call, whatever it contains.
    if (
      !body ||
      typeof body !== "object" ||
      body.jsonrpc !== "2.0" ||
      body.id !== RPC_REQUEST_ID
    )
      throw new Error("Invalid Solana response");
    if (body.error)
      throw new Error(String(body.error.message ?? "Solana request failed"));
    if (!("result" in body)) throw new Error("Invalid Solana response");
    return body.result as T;
  } finally {
    clearTimeout(timeout);
  }
}
/** Everything a published file may weigh. The app's own upload cap is far below it. */
const ARWEAVE_MAX_BYTES = 200_000;
const FILE_TOO_LARGE = "Edition file is too large.";
const FILE_MISMATCH = "The published file does not match its onchain fingerprint.";

/**
 * Gateways in order. `arweave.net` first because it is the only host an on-chain `uri` may name;
 * the Turbo gateway's `/raw/` path returns the exact stored bytes a hash check needs.
 */
const ARWEAVE_GATEWAYS: readonly string[] = [
  "https://arweave.net/",
  "https://turbo-gateway.com/raw/",
];
/**
 * One deadline per gateway attempt, covering headers and body: short while another gateway
 * remains, long for the last one so a slow network still gets the file.
 */
const GATEWAY_TRY_TIMEOUT_MS = 1_200;
const GATEWAY_BODY_TIMEOUT_MS = 15_000;

/**
 * One published file, hash-checked, from the first gateway that produces matching bytes. A
 * mismatch tries the next gateway; `IntegrityError` is thrown only if all failed and one mismatched.
 */
export async function arweaveBytes(
  id: string,
  expectedHash?: string,
): Promise<Uint8Array> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id))
    throw new Error("Invalid Arweave reference");
  let last: unknown;
  let mismatched = false;
  for (const [index, host] of ARWEAVE_GATEWAYS.entries()) {
    // The deadline is the whole attempt's, and the last gateway's is the long one: there is
    // nowhere to fall through to, so abandoning it early only loses the file.
    const deadline = index === ARWEAVE_GATEWAYS.length - 1
      ? GATEWAY_BODY_TIMEOUT_MS
      : GATEWAY_TRY_TIMEOUT_MS;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadline);
      let bytes: Uint8Array;
      try {
        const r = await fetch(`${host}${id}`, { signal: controller.signal });
        if (!r.ok)
          throw new Error(
            "Photo is still becoming available. Try again shortly.",
          );
        bytes = await boundedBody(
          r,
          ARWEAVE_MAX_BYTES,
          FILE_TOO_LARGE,
          () => controller.abort(),
          // No stream reader and no declared length is the unbounded case this cap exists for:
          // refuse it rather than allocate whatever a gateway decides to send.
          true,
        );
      } finally {
        clearTimeout(timer);
      }
      if (bytes.length > ARWEAVE_MAX_BYTES) throw new Error(FILE_TOO_LARGE);
      if (expectedHash && bytesToHex(sha256(bytes)) !== expectedHash)
        throw new IntegrityError(FILE_MISMATCH);
      return bytes;
    } catch (error) {
      if (error instanceof IntegrityError) mismatched = true;
      last = error;
    }
  }
  if (mismatched) throw new IntegrityError(FILE_MISMATCH);
  throw last;
}
/** Bytes that reached us but were not the published bytes. Never a retryable failure. */
class IntegrityError extends Error {}
/**
 * The one message a collector or publisher can act on: add SOL and try again. Exported so a caller
 * that refuses BEFORE simulating — a purchase the wallet plainly cannot cover — says the same
 * sentence `prepareTransaction` says when it compares the balance against its own estimate.
 */
export const NEEDS_SOL =
  "This wallet needs more SOL for account creation and network fees.";
/** The System Program, whose custom error 1 is the payer going below zero lamports. */
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/**
 * A simulation failure as one plain sentence. Kit decodes `err` integers as bigints, so
 * formatting uses a bigint-aware replacer; insufficient-funds shapes map to `NEEDS_SOL`.
 */
function describeSimulationError(
  err: unknown,
  logs?: readonly string[] | null,
): string {
  const lines = logs ?? [];
  const kinds =
    typeof err === "string"
      ? [err]
      : err && typeof err === "object"
        ? Object.keys(err)
        : [];
  if (
    kinds.includes("InsufficientFundsForRent") ||
    kinds.includes("InsufficientFundsForFee") ||
    lines.some((line) =>
      /insufficient lamports|Transfer: insufficient/i.test(line),
    ) ||
    // A System Program instruction that failed with custom error 1 is the payer running out
    // mid-transaction. Another program's error 1 means something else entirely, so the System
    // Program's own failure line has to be there too.
    (customError(err) === 1n &&
      lines.some((line) =>
        line.startsWith(`Program ${SYSTEM_PROGRAM} failed`),
      ))
  )
    return NEEDS_SOL;
  // A program that named its own failure has already said it better than any generic line can.
  const verdict = describeProgramError(err, lines);
  if (verdict.known) return verdict.message;
  return `Transaction simulation failed: ${plainText(err)}. ${lines.slice(-3).join(" ")}`;
}

/**
 * Retryable-vs-terminal verdict for a program failure. `ExistingAsset` is terminal on a publication
 * address, offers a new album on an album address, and is retryable while collecting, where the
 * copy number — and so the print address — changes between attempts. A Core code is only read when the failing program is Core,
 * since other programs reuse small numbers.
 */
export type ProgramErrorFallback = "publish-without-album" | "new-album";
type ProgramErrorVerdict = {
  /** The `Custom` code the failure carried, or null when it was not a program error. */
  code: bigint | null;
  /** The program the last `Program <id> failed` log line named, or null when there was none. */
  program: string | null;
  /** True when the code was recognised; false when this is only a generic description. */
  known: boolean;
  /** One line for a person. The program's own `#[msg]` sentence wherever there is one. */
  message: string;
  /** May the same transaction be offered again, unchanged? */
  retryable: boolean;
  /** A different action that would work, when one exists. */
  fallback?: ProgramErrorFallback;
};

/**
 * Every `era_editions::EditionError`. Anchor numbers a program's own errors from 6000 in
 * DECLARATION order (https://www.anchor-lang.com/docs/features/errors), and the declaration order in
 * `programs/editions/src/lib.rs` is InvalidTerms, SoldOut, StaleNumber, ExistingAsset,
 * InvalidAlbum — so the two collecting codes sit between the publish ones and cannot be renumbered
 * without a new deployment address.
 */
const EDITION_ERROR = {
  INVALID_TERMS: 6000n,
  SOLD_OUT: 6001n,
  STALE_NUMBER: 6002n,
  EXISTING_ASSET: 6003n,
  INVALID_ALBUM: 6004n,
  // Appended by the paid-sales build, never inserted: 6000–6004 are the codes the deployed v1
  // client already maps to messages, so renumbering them would silently change what a wallet shows.
  NOT_FOR_SALE: 6005n,
  OFFER_CHANGED: 6006n,
  PAYMENT_REQUIRED: 6007n,
} as const;
/** `MplCoreError::GroupVectorFull`, 0x36. Raised by `AddCollectionsToGroupV1` at 256 members. */
const CORE_GROUP_VECTOR_FULL = 54n;
/**
 * Metaplex Core's program id. `core/protocol.ts` exports the same address as `MPL_CORE`; it
 * cannot be imported here because that module imports this one, so the two must stay in step.
 */
const MPL_CORE_ID = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";

const EDITION_MESSAGES: Readonly<Record<string, string>> = {
  [String(EDITION_ERROR.INVALID_TERMS)]:
    "Use a title up to 24 bytes, a valid photo URI and 1–1000 prints.",
  [String(EDITION_ERROR.SOLD_OUT)]: "All prints have been collected.",
  [String(EDITION_ERROR.STALE_NUMBER)]:
    "Another person just collected. Refresh before trying again.",
  [String(EDITION_ERROR.EXISTING_ASSET)]: "This publication account is already in use.",
  [String(EDITION_ERROR.INVALID_ALBUM)]:
    "Use an album name up to 32 bytes and either no link or a valid Arweave link.",
  [String(EDITION_ERROR.NOT_FOR_SALE)]: "This edition is free to collect.",
  [String(EDITION_ERROR.OFFER_CHANGED)]:
    "The price changed. Review the new price before buying.",
  [String(EDITION_ERROR.PAYMENT_REQUIRED)]: "This edition has a price. Buy a copy instead.",
};

/** The program named by the LAST `Program <id> failed` line, which is the one that failed. */
function failingProgram(logs: readonly string[]): string | null {
  let program: string | null = null;
  for (const line of logs) {
    const match = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed/.exec(line);
    if (match) program = match[1];
  }
  return program;
}

/**
 * What a failure means and what a screen may offer next. Accepts a bare error or a carrier
 * (`{ err, logs }` / `{ err, logMessages }`). Without `operation`, `ExistingAsset` is terminal.
 */
export function describeProgramError(
  simulationOrTxError: unknown,
  logs?: readonly string[] | null,
  options: { operation?: PublicationOperation } = {},
): ProgramErrorVerdict {
  let err = simulationOrTxError;
  let lines = logs ?? null;
  if (simulationOrTxError && typeof simulationOrTxError === "object" && "err" in simulationOrTxError) {
    const carrier = simulationOrTxError as {
      err: unknown;
      logs?: readonly string[] | null;
      logMessages?: readonly string[] | null;
    };
    err = carrier.err;
    if (!lines) lines = carrier.logs ?? carrier.logMessages ?? null;
  }
  const program = failingProgram(lines ?? []);
  const code = customError(err);
  const generic = (): ProgramErrorVerdict => ({
    code,
    program,
    known: false,
    // Unknown is never called terminal: refusing to offer a retry we cannot justify would be as
    // wrong as offering one the protocol forbids.
    retryable: true,
    message: `Transaction simulation failed: ${plainText(err)}. ${(lines ?? []).slice(-3).join(" ")}`,
  });
  if (code === null) return generic();

  if (program === MPL_CORE_ID) {
    if (code !== CORE_GROUP_VECTOR_FULL) return generic();
    return {
      code,
      program,
      known: true,
      // Core caps a group at 256 collections. A refused `publish_in_album` leaves no edition, so
      // the same nonce can still publish without the album.
      message: "This album is full. It can hold 256 photographs.",
      retryable: false,
      fallback: "publish-without-album",
    };
  }
  const message = EDITION_MESSAGES[String(code)];
  if (message === undefined) return generic();
  /**
   * COLLECTING IS THE ONE OPERATION WHERE A FAILURE CAN BE WORTH REPEATING.
   *
   * `retryable` asks whether this wallet may be offered the operation again; for publishing the
   * answer is always no, because the edition address comes from a deterministic nonce and a second
   * attempt would recreate the identical transaction. A claim is different: its copy `number` is
   * part of the instruction data, so the next attempt is a DIFFERENT transaction against a
   * different print PDA.
   *
   * `StaleNumber` (the program's own message: "Refresh before trying again") and `ExistingAsset`
   * are the two ways a competing collector taking the same number shows up — the first from the
   * `number == minted + 1` check, the second from `clear_pda` finding the print PDA already
   * owned. Both are answered by re-reading `minted` and claiming the next number.
   *
   * `SoldOut` is not: `minted == supply` is permanent, so no later attempt can succeed either.
   */
  /**
   * `buy` is `collect` with a payment, so every claiming rule reads the same way for both. The one
   * operation that is retried by re-reading the chain is the one that is retried by re-reading the
   * chain, whichever instruction carried it.
   */
  const claiming = options.operation === "collect" || options.operation === "buy";
  if (claiming &&
    (code === EDITION_ERROR.STALE_NUMBER || code === EDITION_ERROR.EXISTING_ASSET))
    return {
      code,
      program,
      known: true,
      message: EDITION_MESSAGES[String(EDITION_ERROR.STALE_NUMBER)],
      // No `fallback`: the recovery is this same operation on a refreshed number, which is exactly
      // what `retryable` already means. A fallback names a DIFFERENT action.
      retryable: true,
    };
  /**
   * THE THREE OFFER CODES ARE RETRYABLE WHILE CLAIMING, FOR THE SAME REASON `StaleNumber` IS.
   *
   * A price lives in its own account and can change between the review and the block. All three
   * codes say the offer the screen showed is not the offer on chain any more:
   *   `OfferChanged`    — `buy` carried a price/revision the offer no longer has;
   *   `PaymentRequired` — `collect` found an offer with a price, so the claim is a purchase;
   *   `NotForSale`      — `buy` found no offer, or a zero one, so the claim is free.
   * Each is answered by re-reading the offer account and quoting the OTHER instruction (or the
   * same one at the new price) — a different transaction, exactly as a refreshed copy number is.
   * None of them can be answered by resending the identical message, which is why `retryable` is
   * scoped to the claiming operations and nothing else.
   */
  if (claiming &&
    (code === EDITION_ERROR.OFFER_CHANGED ||
      code === EDITION_ERROR.PAYMENT_REQUIRED ||
      code === EDITION_ERROR.NOT_FOR_SALE))
    return { code, program, known: true, message, retryable: true };
  if (code === EDITION_ERROR.EXISTING_ASSET && options.operation === "create-album")
    return {
      code,
      program,
      known: true,
      message: "An album already exists at this address. Start a new album to continue.",
      retryable: false,
      fallback: "new-album",
    };
  return { code, program, known: true, message, retryable: false };
}
/** The `Custom` code of an `InstructionError` tuple, whether it arrived as number or bigint. */
function customError(err: unknown): bigint | null {
  const tuple = (err as { InstructionError?: unknown })?.InstructionError;
  if (!Array.isArray(tuple) || tuple.length < 2) return null;
  const detail = tuple[1] as { Custom?: unknown } | null;
  const code = detail && typeof detail === "object" ? detail.Custom : undefined;
  return typeof code === "bigint" || typeof code === "number"
    ? BigInt(code)
    : null;
}
function plainText(err: unknown): string {
  try {
    return (
      JSON.stringify(err, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ) ?? String(err)
    );
  } catch {
    return String(err);
  }
}
/**
 * Local cost floor, independent of the endpoint's simulation. Stated, never enforced: `clear_pda`
 * refunds lamports anyone pre-funded onto a PDA, so a real transaction can cost less. Rent is
 * `(128 + data_len) × 3,480 lamports/byte-year × 2 years` (https://solana.com/docs/core/fees).
 */
const CORE_CREATE_FEE_LAMPORTS = 1_500_000n;
const RENT_ACCOUNT_OVERHEAD_BYTES = 128n;
const RENT_LAMPORTS_PER_BYTE_YEAR = 3_480n;
const RENT_EXEMPTION_YEARS = 2n;
/** The rent-exempt minimum for an account holding `dataBytes` bytes. No RPC call. */
const rentExemption = (dataBytes: number | bigint): bigint =>
  (RENT_ACCOUNT_OVERHEAD_BYTES + BigInt(dataBytes)) *
  RENT_LAMPORTS_PER_BYTE_YEAR *
  RENT_EXEMPTION_YEARS;

/**
 * Anchor's fixed account sizes. Neither account has a version byte, so these lengths are the
 * layout version (see the decoders in `core/protocol.ts`).
 */
export const EDITION_ACCOUNT_BYTES = 301;
const RECEIPT_ACCOUNT_BYTES = 106;
/** 8 + `Offer::INIT_SPACE` (32 + 32 + 8 + 4 + 1). `core/protocol.ts` pins the same number. */
export const OFFER_ACCOUNT_BYTES = 85;
/** The smallest Core accounts a Seedshot publication can write. */
const CORE_COLLECTION_MIN_BYTES = 457;
const CORE_PRINT_MIN_BYTES = 186;
const CORE_GROUP_MIN_BYTES = 58;

export type PublicationOperation =
  | "publish"
  | "publish-in-album"
  | "collect"
  | "buy"
  | "set-offer"
  | "create-album"
  | "transfer";

/**
 * Historical reference costs at 6,960 lamports per byte, not a current funding threshold.
 * Devnet rent changed; simulation supplies the actual cost. Core's create fee is counted once
 * per operation. `transfer` creates nothing.
 */
export const OPERATION_FLOOR_LAMPORTS: Readonly<Record<PublicationOperation, bigint>> = {
  publish:
    CORE_CREATE_FEE_LAMPORTS +
    rentExemption(EDITION_ACCOUNT_BYTES) +
    rentExemption(CORE_COLLECTION_MIN_BYTES) +
    rentExemption(CORE_PRINT_MIN_BYTES) +
    rentExemption(RECEIPT_ACCOUNT_BYTES),
  // A member collection additionally carries a `Groups` plugin, so it is never cheaper.
  "publish-in-album":
    CORE_CREATE_FEE_LAMPORTS +
    rentExemption(EDITION_ACCOUNT_BYTES) +
    rentExemption(CORE_COLLECTION_MIN_BYTES) +
    rentExemption(CORE_PRINT_MIN_BYTES) +
    rentExemption(RECEIPT_ACCOUNT_BYTES),
  // A claim creates exactly one Core print and one `Receipt`; the `Edition` and the collection
  // already exist. Core's create fee is charged once, for the asset. The measured devnet total was
  // 5,367,800 = 1,500,000 + rent(193-byte asset) + rent(106) + the 5,000-lamport network fee, and
  // this floor uses the SMALLEST print image the composers can produce, so it stays under it.
  collect:
    CORE_CREATE_FEE_LAMPORTS +
    rentExemption(CORE_PRINT_MIN_BYTES) +
    rentExemption(RECEIPT_ACCOUNT_BYTES),
  /**
   * A purchase creates exactly what a claim creates — one Core print and one `Receipt` — so its
   * floor IS the claim's, and the measured devnet totals agree: a collect cost 5,367,800 lamports
   * and a buy cost the price PLUS 5,367,800.
   *
   * THE PRICE IS NOT IN THE FLOOR. A floor is a local lower bound on what the NETWORK charges, used
   * to sanity-check an endpoint's estimate; the price is an amount the creator chose and the buyer
   * reviewed separately. Folding it in here would make one number out of two facts the design
   * record requires be shown apart, and would make the floor depend on a mutable account. The
   * caller adds it.
   */
  buy: CORE_CREATE_FEE_LAMPORTS + rentExemption(CORE_PRINT_MIN_BYTES) + rentExemption(RECEIPT_ACCOUNT_BYTES),
  // `set_offer` creates no asset — Core is not called at all — so there is no protocol fee, only
  // rent for the 85-byte `Offer` account on the first call. Later calls rewrite it and cost the
  // network fee alone, which is under this floor: `EstimateBreakdown.floor` is stated, never
  // enforced, exactly as it is for a publish onto a pre-funded PDA.
  "set-offer": rentExemption(OFFER_ACCOUNT_BYTES),
  // An album is one Core `GroupV1` PDA and no asset, so Core charges no protocol fee for it.
  "create-album": rentExemption(CORE_GROUP_MIN_BYTES),
  transfer: 0n,
};

/** The estimate, itemised, so a number the endpoint supplied can be checked against one it did not. */
type EstimateBreakdown = {
  /** `getFeeForMessage` for this exact message. */
  networkFee: bigint;
  /** The payer's simulated balance delta — rent, Core's protocol fee and the network fee. */
  accountCost: bigint;
  /** The wallet-added priority/guard headroom already inside `estimatedLamports`. */
  allowance: bigint;
  /**
   * The locally computed lower bound for this operation, or 0 when the caller named none. Stated,
   * never enforced: `clear_pda` refunds pre-funded PDAs, so a real transaction can cost less. Carried so a
   * quote refresh re-estimates against the same floor.
   */
  floor: bigint;
};

/** Kit requests need the same bounded lifetime as the raw JSON-RPC reader above. */
export async function rpcWithTimeout<T>(send: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await send(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Solana did not answer in time. Please retry.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function prepareTransaction(
  endpoint: string,
  payer: string,
  ix: Instruction[],
  extraSigners: KeyPairSigner[] = [],
  floorLamports: bigint = 0n,
) {
  const rpc = createSolanaRpc(endpoint);
  const latest = await rpcWithTimeout(abortSignal => rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send({ abortSignal }));
  /**
   * The message at a given compute budget, compiled, signed and size-checked. Built as a probe
   * (ceiling limit, floor price) for simulation, then at the derived budget for signing.
   */
  const build = async (units: number, microLamports: bigint) => {
    const message = appendTransactionMessageInstructions(
      [
        getSetComputeUnitLimitInstruction({ units }),
        getSetComputeUnitPriceInstruction({ microLamports }),
        ...ix,
      ],
      setTransactionMessageLifetimeUsingBlockhash(
        latest.value,
        setTransactionMessageFeePayer(
          address(payer),
          createTransactionMessage({ version: 0 }),
        ),
      ),
    );
    let transaction: Transaction = compileTransaction(message);
    if (extraSigners.length)
      transaction = await partiallySignTransaction(
        extraSigners.map((s) => s.keyPair),
        transaction,
      );
    const wire = getBase64EncodedWireTransaction(transaction);
    if (getBase64Encoder().encode(wire).length > 1057)
      throw new Error(
        "Edition transaction exceeds the mobile wallet size budget.",
      );
    return { transaction, wire };
  };
  const probe = await build(COMPUTE_UNIT_LIMIT, COMPUTE_UNIT_PRICE);
  const [simulation, recentFees] = await Promise.all([
    rpcWithTimeout(abortSignal => rpc
      .simulateTransaction(probe.wire, {
        encoding: "base64",
        sigVerify: false,
        commitment: "confirmed",
        accounts: { addresses: [address(payer)], encoding: "base64" },
      })
      .send({ abortSignal })),
    // Advisory: a failed or malformed answer leaves the price at the floor.
    request<unknown>(endpoint, "getRecentPrioritizationFees", [[]]).catch(() => null),
  ]);
  if (simulation.value.err)
    throw new Error(
      describeSimulationError(simulation.value.err, simulation.value.logs),
    );
  // A missing, zero (Kit maps null to 0n) or impossible `unitsConsumed` means the simulation did
  // not execute this message, so its balance delta cannot be trusted.
  const units = simulation.value.unitsConsumed;
  if ((typeof units !== "bigint" && typeof units !== "number") || BigInt(units) <= 0n)
    throw new Error("The network did not report how much this transaction costs to run.");
  if (BigInt(units) > BigInt(COMPUTE_UNIT_LIMIT))
    throw new Error("The network reported an impossible compute cost for this transaction.");

  // Both values sit on the grid above, so a quote refresh recompiles the same bytes.
  const computeUnitLimit = computeUnitLimitFor(units);
  const computeUnitPrice = computeUnitPriceFrom(recentFees);
  const priorityFee = priorityFeeLamports(computeUnitLimit, computeUnitPrice);
  const { transaction } = await build(computeUnitLimit, computeUnitPrice);

  const [fee, balance] = await Promise.all([
    rpcWithTimeout(abortSignal => rpc
      .getFeeForMessage(
        getBase64Decoder().decode(transaction.messageBytes) as any,
        { commitment: "confirmed" },
      )
      .send({ abortSignal })),
    // Read at the simulation's slot: `accountCost` is their difference, and a quote refresh
    // compares estimates exactly.
    rpcWithTimeout(abortSignal => rpc
      .getBalance(address(payer), {
        commitment: "confirmed",
        minContextSlot: simulation.context.slot,
      })
      .send({ abortSignal })),
  ]);
  if (fee.value === null) throw new Error("Transaction expired. Try again.");
  const after = simulation.value.accounts?.[0]?.lamports;
  const simulated =
    after === undefined
      ? 0n
      : balance.value > after
        ? balance.value - after
        : 0n;
  // The simulation priced the probe prelude; adjust by the priority-fee difference to the signed
  // one, clamped at zero.
  const probePriority = priorityFeeLamports(COMPUTE_UNIT_LIMIT, COMPUTE_UNIT_PRICE);
  const adjusted = simulated + priorityFee - probePriority;
  const accountCost = after === undefined ? 0n : adjusted > 0n ? adjusted : 0n;
  // Simulation already debits the network fee. `transferReceipt.ts` bounds fee rewrites by the
  // same allowance.
  const cost = (accountCost > fee.value ? accountCost : fee.value) + FEE_ALLOWANCE_LAMPORTS;
  if (balance.value < cost) throw new Error(NEEDS_SOL);
  const estimateBreakdown: EstimateBreakdown = {
    networkFee: fee.value,
    accountCost,
    allowance: FEE_ALLOWANCE_LAMPORTS,
    floor: floorLamports,
  };
  return {
    transaction,
    minContextSlot: latest.context.slot,
    lastValidBlockHeight: latest.value.lastValidBlockHeight,
    estimatedLamports: cost,
    estimateBreakdown,
  };
}
/** Confirmation wait ceiling and poll interval. */
const CONFIRMATION_TIMEOUT_MS = 60_000;
const CONFIRMATION_POLL_MS = 1_600;

export async function confirmTransaction(
  endpoint: string,
  sig: string,
  lastValidBlockHeight: bigint,
) {
  signature(sig);
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = await request<{
      value: ({ err: unknown; confirmationStatus: string } | null)[];
    }>(endpoint, "getSignatureStatuses", [
      [sig],
      { searchTransactionHistory: true },
    ]);
    const s = r.value[0];
    // A `processed` status may be on an abandoned fork, so only `confirmed`/`finalized` decide.
    if (s && ["confirmed", "finalized"].includes(s.confirmationStatus)) {
      if (s.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
      return;
    }
    // A non-integer height is a network error, not a RangeError out of `BigInt`.
    const height = await request<number>(endpoint, "getBlockHeight", [
      { commitment: "confirmed" },
    ]);
    if (!Number.isSafeInteger(height) || height < 0)
      throw new Error("Invalid Solana block height.");
    // Strictly greater: the blockhash is still accepted at `lastValidBlockHeight` itself.
    if (BigInt(height) > lastValidBlockHeight)
      throw new Error("Transaction expired. Refresh to check before retrying.");
    await new Promise((r) => setTimeout(r, CONFIRMATION_POLL_MS));
  }
  throw new Error(
    "Confirmation is still pending. Refresh to check its status before retrying.",
  );
}
