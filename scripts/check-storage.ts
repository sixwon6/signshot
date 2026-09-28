/**
 * Self-test for paid storage (`publications/storage.ts`). Runs in `npm test` against a stubbed
 * `fetch`; it sends nothing to Turbo or to Solana.
 *
 *   - the quote: priced from the payment service before any approval, with every failure stopping
 *     publishing, and items the bundler already holds never paid for;
 *   - the two instructions: the System transfer held to the OFFICIAL `@solana-program/system`
 *     encoder, the memo to turbo-sdk's `turboCreditDestinationAddress=` convention, and the largest
 *     publication transaction still inside the mobile wallet's size budget with both added;
 *   - the credit: pending until the service credits the upload key, idempotent on a resume, and
 *     refused or misdirected credit re-posted with backoff, then the free tier for items within its
 *     size, never a second payment; unsettled credit reported rather than uploaded past, until ten
 *     minutes after the service first left it uncredited, then the free tier as for a refusal;
 *   - the payment address: Turbo's pinned Solana address, and nothing else `/info` names;
 *   - the lost receipt: the publication transaction found by fingerprint in the creator's claim
 *     receipt's history first, then the edition's, and by its transfer and memo when a wallet
 *     rewrote it;
 *   - `src/prints/creator.ts` records the path taken on the draft and resumes it as recorded.
 */

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TurboError } from "../src/arweave/turbo";
import { addresses, instruction, setOfferInstruction } from "../publications/core/protocol";
import { reviewedFingerprint } from "../publications/core/transferReceipt";
import {
  MAX_STORAGE_LAMPORTS,
  SETTLE_BOUND_MS,
  TURBO_SOLANA_ADDRESS,
  findStoragePayment,
  paidStorage,
  paysStorage,
  quoteStoragePayment,
  settleStoragePayment,
  storagePaymentInstructions,
  storageProblem,
  type StoragePayment,
} from "../publications/storage";
import type { CoreMetadata } from "../publications/types";

let failures = 0;
function ok(name: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failures += 1;
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; return undefined; } catch (error) { return error; }
}

// --- The stubbed network --------------------------------------------------------------------------
type Call = { url: string; method: string; body?: string };
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: [RegExp, Handler][] = [];
let calls: Call[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
  for (const [pattern, handler] of routes) if (pattern.test(url)) return handler(url, init);
  return new Response("Not Found", { status: 404 });
}) as typeof fetch;
function stub(next: [RegExp, Handler][]) {
  routes = next;
  calls = [];
}
const posts = () => calls.filter((call) => call.method === "POST");

// September 2026 answers from turbo.ardrive.io, rounded.
const TURBO = "HepiT2k93CFQaSB7i3ZNXhybZKn5MeWiv3UkLsaJKk4i";
const UPLOADER = "5jqYeSamsmxmnEtXteRNrTY5nQtTN4vmdyws1acnTvxW";
const CREATOR = "BSuFrMcYhSKS5dkprGtC17nVbP4VSFNvZzncnRtkVLpT";
const WINC_PER_SOL = 17_008_816_964_285n;
const WINC_PER_BYTE = 12_560n;
const items = [
  { id: "A".repeat(43), bytes: new Uint8Array(61_440) },
  { id: "B".repeat(43), bytes: new Uint8Array(2_048) },
];
const required = items.reduce((sum, item) => sum + BigInt(item.bytes.length) * WINC_PER_BYTE, 0n);
const expectedLamports = (required * 150n * 1_000_000_000n + 100n * WINC_PER_SOL - 1n) / (100n * WINC_PER_SOL);

const notHeld: [RegExp, Handler] = [/\/tx\/[A-Za-z0-9_-]{43}\/status$/, () => new Response("Not Found", { status: 404 })];
const held: [RegExp, Handler] = [/\/tx\/[A-Za-z0-9_-]{43}\/status$/, () => json({ status: "CONFIRMED" })];
const info = (solana: unknown = TURBO): [RegExp, Handler] =>
  [/\/v1\/info$/, () => json({ version: "0.2.0", addresses: { solana, arweave: "JNC6vBhjHY1EPwV3pEeNmrsgFMxH5d38_LHsZ7jful8" } })];
const bytePrice = (perByte = WINC_PER_BYTE): [RegExp, Handler] =>
  [/\/v1\/price\/bytes\/\d+$/, (url) => json({ winc: String(BigInt(url.split("/").pop()!) * perByte), adjustments: [] })];
const solPrice = (perSol = WINC_PER_SOL): [RegExp, Handler] =>
  [/\/v1\/price\/solana\/\d+$/, (url) => json({ winc: String((BigInt(url.split("/").pop()!) * perSol) / 1_000_000_000n), fees: [] })];
const pricing = (): [RegExp, Handler][] => [notHeld, info(), bytePrice(), solPrice()];

async function quoteTests() {
  ok("storage is paid on mainnet only", paidStorage("mainnet-beta") && !paidStorage("devnet"));

  stub(pricing());
  const quote = await quoteStoragePayment(UPLOADER, items);
  ok("the quote pays Turbo's advertised address, credited to the upload key",
    quote?.target === TURBO && quote.destination === UPLOADER);
  ok(`the quote is the byte price plus half, in whole lamports (${String(quote?.lamports)})`,
    quote?.lamports === expectedLamports && expectedLamports > 0n);
  ok("the exact amount is priced as a payment before it is offered",
    calls.some((call) => call.url.endsWith(`/v1/price/solana/${expectedLamports}`)));
  ok("quoting sends nothing", posts().length === 0);

  stub([held, info(), bytePrice(), solPrice()]);
  ok("items the bundler holds are never paid for", (await quoteStoragePayment(UPLOADER, items)) === null &&
    !calls.some((call) => call.url.includes("/price/")));

  stub([[/^https:\/\/turbo\.ardrive\.io\/v1\//, () => { throw new TypeError("fetch failed"); }], ...pricing()]);
  ok("a dead primary host falls through to the payment host",
    (await quoteStoragePayment(UPLOADER, items))?.lamports === expectedLamports &&
    calls.some((call) => call.url.startsWith("https://payment.ardrive.io/v1/price/")));

  const refusals: [string, [RegExp, Handler][]][] = [
    ["every host failing", [notHeld, [/\/v1\//, () => new Response("down", { status: 503 })]]],
    ["no Solana payment address", [notHeld, info(null), bytePrice(), solPrice()]],
    ["a payment address that is not an address", [notHeld, info("not-an-address"), bytePrice(), solPrice()]],
    ["a fractional price", [notHeld, info(), [/\/v1\/price\/bytes\//, () => json({ winc: "12.5" })], solPrice()]],
    ["a zero rate", [notHeld, info(), bytePrice(), solPrice(0n)]],
    ["a payment priced below the bytes", [notHeld, info(), bytePrice(),
      [/\/v1\/price\/solana\/1000000000$/, () => json({ winc: String(WINC_PER_SOL) })],
      [/\/v1\/price\/solana\/\d+$/, () => json({ winc: "1" })]]],
  ];
  for (const [name, next] of refusals) {
    stub(next);
    const error = await rejection(quoteStoragePayment(UPLOADER, items));
    const problem = storageProblem(error, true);
    ok(`refused before any approval: ${name}`,
      error !== undefined && problem.kind === "unavailable" && problem.retryable && posts().length === 0);
  }
  ok("the pinned payment address is the one Turbo's /info named on 2026-09-25", TURBO_SOLANA_ADDRESS === TURBO);
  stub([notHeld, info(CREATOR), bytePrice(), solPrice()]);
  const moved = await rejection(quoteStoragePayment(UPLOADER, items));
  const movedProblem = storageProblem(moved, true);
  ok("a valid payment address other than the pinned one stops publishing before the wallet opens",
    moved !== undefined && movedProblem.message === "Storage payment address changed. Update Signshot." &&
    !movedProblem.retryable && posts().length === 0 &&
    !calls.some((call) => /\/v1\/price\/solana\/(?!1000000000$)\d+$/.test(call.url)));
  stub([notHeld, info(), bytePrice(), solPrice(1_000n)]);
  const expensive = storageProblem(await rejection(quoteStoragePayment(UPLOADER, items)), true);
  ok("a quote over the ceiling is refused whatever the provider says",
    expensive.message === "Storage price out of range. Try again later." && expensive.retryable);
  stub(pricing());
  ok("an upload key that is not an address is refused",
    (await rejection(quoteStoragePayment("nope", items))) !== undefined);
}

// --- The two instructions --------------------------------------------------------------------------
const payment: StoragePayment = { target: TURBO, lamports: 68_229n, destination: UPLOADER };
function instructionTests() {
  const [transfer, memo] = storagePaymentInstructions(CREATOR, payment);
  const official = getTransferSolInstruction({
    source: createNoopSigner(address(CREATOR)),
    destination: address(TURBO),
    amount: payment.lamports,
  });
  ok("the transfer is the System Program's own encoding, byte for byte",
    transfer.programAddress === official.programAddress &&
    Buffer.from(transfer.data!).equals(Buffer.from(official.data)));
  ok("the transfer debits the publisher as signer and credits Turbo",
    transfer.accounts!.length === 2 &&
    transfer.accounts![0].address === CREATOR && transfer.accounts![0].role === AccountRole.WRITABLE_SIGNER &&
    transfer.accounts![1].address === TURBO && transfer.accounts![1].role === AccountRole.WRITABLE);
  ok("the memo is turbo-sdk's credit destination on spl-memo, with no accounts",
    memo.programAddress === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" && memo.accounts!.length === 0 &&
    new TextDecoder().decode(new Uint8Array(memo.data!)) === `turboCreditDestinationAddress=${UPLOADER}`);
  const throws = (p: StoragePayment) => { try { storagePaymentInstructions(CREATOR, p); return false; } catch { return true; } };
  ok("refuses: a zero payment", throws({ ...payment, lamports: 0n }));
  ok("refuses: a payment over the ceiling", throws({ ...payment, lamports: MAX_STORAGE_LAMPORTS + 1n }));
  ok("refuses: a destination that is not an address", throws({ ...payment, destination: "nope" }));
  ok("refuses: a transfer to any address but Turbo's pinned one", throws({ ...payment, target: CREATOR }));
}

/**
 * The largest publication the app builds: `publish_in_album` with the Genesis Token sealed, a
 * 24-byte title, the royalty and Seeker-only setting, `set_offer`, the compute budget, and now the
 * storage transfer and memo, compiled as
 * `prepareTransaction` compiles it and held to its 1,057-byte mobile wallet budget.
 */
async function sizeTest() {
  const program = "Ds4LT9zQ3a9V9ZxqKgwYQxskh1DgeYPhoCYz5iHjAizE";
  const nonce = "c".repeat(64);
  const keys = await addresses(program, CREATOR, nonce);
  const mint = "So11111111111111111111111111111111111111112";
  const e: CoreMetadata = {
    cluster: "mainnet-beta", program, edition: keys.edition, collection: keys.collection,
    creator: CREATOR, nonce, title: "x".repeat(24), supply: 1000,
    image: `https://arweave.net/${"C".repeat(43)}`, imageHash: "d".repeat(64), width: 2048, height: 1536,
    description: "", genesisMint: mint,
  };
  const publication: Instruction[] = [
    await instruction(e, CREATOR, 1, `https://arweave.net/${"D".repeat(43)}`, "e".repeat(64),
      "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d", { mint, token: "GH2ELkRUzqFRFZV6yJfjgE2XvzFz2mohS27Jrk6gji77" },
      { royaltyBps: 1000, seekerOnly: true }),
    await setOfferInstruction(e, 18_446_744_073_709_551_615n),
  ];
  const size = (ixs: Instruction[]) => {
    const message = appendTransactionMessageInstructions(
      [getSetComputeUnitLimitInstruction({ units: 400_000 }), getSetComputeUnitPriceInstruction({ microLamports: 2n ** 63n }), ...ixs],
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k" as Blockhash, lastValidBlockHeight: 0n },
        setTransactionMessageFeePayer(address(CREATOR), createTransactionMessage({ version: 0 })),
      ),
    );
    return getBase64Encoder().encode(getBase64EncodedWireTransaction(compileTransaction(message))).length;
  };
  const longest: StoragePayment = { ...payment, destination: "HepiT2k93CFQaSB7i3ZNXhybZKn5MeWiv3UkLsaJKk4i" };
  const without = size(publication);
  const withStorage = size([...publication, ...storagePaymentInstructions(CREATOR, longest)]);
  ok(`the largest publication with storage fits the wallet budget (${without} -> ${withStorage} of 1057 bytes)`,
    withStorage <= 1057 && withStorage > without);
}

// --- The credit ------------------------------------------------------------------------------------
const TX = "5".repeat(88);
const credited = (destination = UPLOADER, transactionId = TX) =>
  json({ message: "Transaction credited", creditedTransaction: { transactionId, destinationAddress: destination, winstonCreditAmount: "1" } });
const pending = () =>
  json({ message: "Transaction pending", pendingTransaction: { transactionId: TX, destinationAddress: UPLOADER } }, 202);
function sequence(...answers: (() => Response)[]): [RegExp, Handler] {
  let next = 0;
  return [/\/v1\/account\/balance\/solana$/, () => answers[Math.min(next++, answers.length - 1)]()];
}
const refused = () =>
  json({ message: "Transaction has already failed!", failedTransaction: { transactionId: TX, failureReason: "not a payment" } }, 400);
/** The upload service's `/info`, advertising `maxItemBytes` as its free item size. */
const uploadInfo = (maxItemBytes: number): [RegExp, Handler] =>
  [/^https:\/\/(turbo|upload)\.ardrive\.io\/info$/, () => json({ freeUploadLimitBytes: maxItemBytes, freeTier: { lifetimeBytes: 10_485_760, ipBytes: 10_485_760, maxItemBytes } })];
/** The waits the settlement makes, read off `setTimeout`; every request deadline is 15 s. */
let waits: number[] = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((handler: () => void, ms?: number) => {
  if (ms !== 15_000) waits.push(ms ?? 0);
  return realSetTimeout(handler, ms);
}) as unknown as typeof setTimeout;

async function creditTests() {
  let asked = 0;
  const signature = async () => { asked += 1; return TX; };

  stub([held, sequence(credited)]);
  const none = await settleStoragePayment(signature, UPLOADER, items, 0);
  ok("nothing to settle when the bundler holds both items: no receipt lookup, no request",
    none === null && asked === 0 && posts().length === 0);

  stub([notHeld, sequence(pending, credited)]);
  const funding = await settleStoragePayment(signature, UPLOADER, items, 0);
  const sent = posts();
  ok("a pending credit is asked again until the service credits it",
    funding === "credit" && sent.length === 2 && sent.every((call) => call.body === JSON.stringify({ tx_id: TX })) &&
    sent[0].url === "https://turbo.ardrive.io/v1/account/balance/solana");

  stub([notHeld, sequence(() => new Response("Transaction ID not found!", { status: 404 }), credited)]);
  ok("a transaction the service has not seen yet is pending, not refused",
    (await rejection(settleStoragePayment(signature, UPLOADER, items, 0))) === undefined);

  stub([notHeld, [/^https:\/\/turbo\.ardrive\.io\/v1\/account\//, () => new Response("down", { status: 503 })], sequence(credited)]);
  ok("a failing primary host falls through to the payment host",
    (await rejection(settleStoragePayment(signature, UPLOADER, items, 0))) === undefined &&
    posts().some((call) => call.url === "https://payment.ardrive.io/v1/account/balance/solana"));

  stub([notHeld, sequence(credited)]);
  await settleStoragePayment(signature, UPLOADER, items, 0);
  ok("a resume re-posts the same transaction and builds no payment",
    posts().length === 1 && calls.every((call) => /\/status$|\/account\/balance\/solana$/.test(call.url)));

  // A refusal that stands: the same transaction re-posted with doubling waits, then the free tier.
  const onlySettling = () => calls.every((call) => /\/status$|\/account\/balance\/solana$|\/info$/.test(call.url));
  stub([notHeld, uploadInfo(107_520), [/\/v1\/account\/balance\/solana$/, refused]]);
  waits = [];
  const afterRefusal = await settleStoragePayment(signature, UPLOADER, items, 1);
  ok("a refused payment is re-posted three times, waiting 1, 2 then 4 polls, then the free tier is used",
    afterRefusal === "free" && posts().length === 4 && posts().every((call) => call.body === JSON.stringify({ tx_id: TX })) &&
    waits.join() === "1,2,4" && onlySettling());
  stub([notHeld, uploadInfo(107_520), [/\/v1\/account\/balance\/solana$/, () => credited(CREATOR)]]);
  ok("credit landing on another account is re-posted the same way, then the free tier is used",
    (await settleStoragePayment(signature, UPLOADER, items, 0)) === "free" && posts().length === 4 && onlySettling());
  stub([notHeld, uploadInfo(107_520), sequence(refused, credited)]);
  ok("a refusal the service takes back on a re-post is the credit, not the free tier",
    (await settleStoragePayment(signature, UPLOADER, items, 0)) === "credit" && posts().length === 2);
  stub([notHeld, [/\/v1\/account\/balance\/solana$/, refused]]);
  ok("an upload service that does not answer /info leaves the documented free item size",
    (await settleStoragePayment(signature, UPLOADER, items, 0)) === "free");
  stub([notHeld, uploadInfo(4_096), [/\/v1\/account\/balance\/solana$/, refused]]);
  const oversize = storageProblem(await rejection(settleStoragePayment(signature, UPLOADER, items, 0)), true);
  ok("an item over the advertised free size ends in one line, and no second payment",
    oversize.message === "The storage provider refused this publication's payment." && !oversize.retryable &&
    oversize.kind === "quota" && posts().length === 4 && onlySettling());
  const freeRefused = [402, 413].map((status) => storageProblem(new TurboError(status, "{}", `turbo: upload refused with HTTP ${status}`), true, "free"));
  ok("the free tier refusing too ends in the same line",
    freeRefused.every((problem) => problem.message === "The storage provider refused this publication's payment." && !problem.retryable));

  const reported: [string, Handler, string, boolean][] = [
    ["a credit record for another transaction", () => credited(UPLOADER, "6".repeat(88)), "Storage payment is settling. Check again shortly.", true],
    ["credit that never settles", pending, "Storage payment is settling. Check again shortly.", true],
    ["no host answering", () => { throw new TypeError("fetch failed"); }, "Storage payment is settling. Check again shortly.", true],
  ];
  for (const [name, answer, message, retryable] of reported) {
    stub([notHeld, [/\/v1\/account\/balance\/solana$/, answer]]);
    const problem = storageProblem(await rejection(settleStoragePayment(signature, UPLOADER, items, 0)), true);
    ok(`reported, not uploaded past: ${name}`, problem.message === message && problem.retryable === retryable &&
      !calls.some((call) => call.url.endsWith("/tx")));
  }
  stub([notHeld, [/\/v1\/account\/balance\/solana$/, () => { throw new TypeError("fetch failed"); }]]);
  await rejection(settleStoragePayment(signature, UPLOADER, items, 0));
  ok("unreachable hosts end the wait at once instead of polling on", posts().length === 2);

  // The bound: a payment never credited reaches the free tier, measured from the first uncredited
  // answer the draft keeps for that transaction.
  let clocked: string[] = [];
  const clock = (ago: number) => async (tx: string) => { clocked.push(tx); return Date.now() - ago; };
  const uncredited: [string, Handler][] = [
    ["pending", pending],
    ["not found (404)", () => new Response("Transaction ID not found!", { status: 404 })],
    ["failing (503)", () => new Response("Error while processing transaction!", { status: 503 })],
    ["unreachable", () => { throw new TypeError("fetch failed"); }],
  ];
  for (const [name, answer] of uncredited) {
    stub([notHeld, uploadInfo(107_520), [/\/v1\/account\/balance\/solana$/, answer]]);
    clocked = [];
    const past = await settleStoragePayment(signature, UPLOADER, items, 0, clock(SETTLE_BOUND_MS));
    const postsPast = posts().length;
    stub([notHeld, uploadInfo(107_520), [/\/v1\/account\/balance\/solana$/, answer]]);
    const within = storageProblem(await rejection(settleStoragePayment(signature, UPLOADER, items, 0, clock(SETTLE_BOUND_MS - 60_000))), true);
    ok(`${name} past the bound goes to the free tier on the first answer; within it, still settling`,
      past === "free" && postsPast <= 2 && clocked.every((tx) => tx === TX) && clocked.length === 2 &&
      within.message === "Storage payment is settling. Check again shortly." && within.retryable);
  }
  stub([notHeld, sequence(credited)]);
  clocked = [];
  ok("a credit on the first answer never starts the clock",
    (await settleStoragePayment(signature, UPLOADER, items, 0, clock(SETTLE_BOUND_MS))) === "credit" && clocked.length === 0);
  stub([notHeld, sequence(pending, pending, credited)]);
  clocked = [];
  ok("the clock is read once per check, however many polls",
    (await settleStoragePayment(signature, UPLOADER, items, 0, clock(0))) === "credit" && clocked.length === 1);
  stub([notHeld, uploadInfo(4_096), [/\/v1\/account\/balance\/solana$/, pending]]);
  const tooBig = storageProblem(await rejection(settleStoragePayment(signature, UPLOADER, items, 0, clock(SETTLE_BOUND_MS))), true);
  ok("past the bound, an item over the free size ends as a refusal does",
    tooBig.message === "The storage provider refused this publication's payment." && tooBig.kind === "quota");
  ok("the bound is ten minutes", SETTLE_BOUND_MS === 600_000);

  const short = storageProblem(new TurboError(402, "{}", "turbo: upload refused with HTTP 402"), true);
  const credit = storageProblem(new TurboError(402, "{}", "turbo: upload refused with HTTP 402"), true, "credit");
  const free = storageProblem(new TurboError(402, "{}", "turbo: upload refused with HTTP 402"));
  ok("a 402 after paying is short credit, a 402 on devnet the free allowance",
    short.message === "Storage credit ran short for this upload." && short.kind === "quota" &&
    credit.message === short.message && free.message.startsWith("The storage provider refused the free upload allowance"));

  // The draft side, in `src/prints/creator.ts`: the path is saved before any upload and resumed as
  // saved, a lost receipt is looked up at the claim receipt, and the free tier refusing clears it.
  const creator = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "prints", "creator.ts"), "utf8")
    .replace(/\r\n/g, "\n");
  const settle = /async function settleStorage\([\s\S]*?\n\}/.exec(creator)?.[0] ?? "";
  const upload = /async function uploadConfirmed\([\s\S]*?\n\}/.exec(creator)?.[0] ?? "";
  ok("creator.ts resumes a recorded path without re-posting, and records a new one before uploading",
    /^async function settleStorage\([^)]*\) \{\n  if \(d\.storageFunding\) return;/.test(settle) &&
    /d\.storageFunding = funding;\n  await save\(r, d\);\n\}$/.test(settle) &&
    upload.indexOf("await settleStorage(r, d)") < upload.indexOf("await publish(d)"));
  ok("creator.ts looks a lost receipt up at the creator's claim receipt (the sealed token's on a Seeker-only edition), then the edition",
    /const receipt = await claimReceiptAddress\(d\.edition\.program, d\.edition\.edition,\s*publisherClaimant\(d\.edition\.creator, d\.seekerOnly, /.test(settle) &&
    /findStoragePayment\(RPC_ENDPOINT, \{ receipt, edition: d\.edition\.edition \}, quoteId,\s*\{ payer: d\.edition\.creator, destination: signer\.ownerBase58 \}\)/.test(settle));
  ok("creator.ts keeps the settling clock on the draft per transaction, across a stale screen and a reload",
    /\}, signer\.ownerBase58, \[img, meta\], undefined, async \(tx\) => \{/.test(settle) &&
    /if \(d\.storageSettling\?\.tx !== tx\) \{\n\s*d\.storageSettling = \{ tx, since: Date\.now\(\) \};\n\s*await save\(r, d\);\n\s*\}\n\s*return d\.storageSettling\.since;/.test(settle) &&
    /d\.storageSettling = current\.storageSettling;/.test(creator) &&
    /d\.storageSettling !== undefined && \(!\/\^\[1-9A-HJ-NP-Za-km-z\]\{64,88\}\$\/\.test/.test(creator));
  ok("creator.ts keeps the path across a stale screen and a reload, and forgets it only when the free tier refuses",
    /d\.storageFunding = current\.storageFunding;/.test(creator) &&
    /d\.storageFunding !== undefined && d\.storageFunding !== "credit" && d\.storageFunding !== "free"/.test(creator) &&
    /storageProblem\(error, paidStorage\(cluster\), d\.storageFunding\);\n\s*\/\/[^\n]*\n\s*if \(d\.storageFunding === "free" && d\.storageError\.kind === "quota"\) delete d\.storageFunding;/.test(upload));
}

// --- The lost receipt ------------------------------------------------------------------------------
async function receiptTests() {
  const payer = await generateKeyPairSigner();
  const other = await generateKeyPairSigner();
  const LIGHTHOUSE = address("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
  const note = (text: string): Instruction =>
    ({ programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [], data: new TextEncoder().encode(text) });
  const assertion: Instruction = { programAddress: LIGHTHOUSE, accounts: [{ address: payer.address, role: AccountRole.READONLY }], data: new Uint8Array([9, 1, 2]) };
  const pay = (from = payer.address, destination = UPLOADER) =>
    storagePaymentInstructions(from, { ...payment, destination });
  const signed = async (content: string | Instruction[], by = payer, blockhash = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k") => {
    const message = appendTransactionMessageInstructions(
      typeof content === "string" ? [note(content)] : content,
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash as Blockhash, lastValidBlockHeight: 0n },
        setTransactionMessageFeePayerSigner(by, createTransactionMessage({ version: 0 })),
      ),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    return {
      signature: getSignatureFromTransaction(transaction) as string,
      quoteId: reviewedFingerprint(new Uint8Array(transaction.messageBytes)),
      result: { slot: 7, version: 0, meta: { err: null }, transaction: [getBase64EncodedWireTransaction(transaction), "base64"] },
    };
  };
  const prefund = await signed("someone pre-funding the edition");
  const publication = await signed("the publication");
  const later = await signed("a later collect");
  const failed = await signed("a failed attempt");
  // What the wallet approved: the publication with its storage transfer and memo. What landed: the
  // same, rewritten by the wallet with a compute budget and Lighthouse assertions around them.
  const reviewed = await signed([note("the publication"), ...pay()]);
  const rewritten = await signed([getSetComputeUnitLimitInstruction({ units: 300_000 }), getSetComputeUnitPriceInstruction({ microLamports: 20_000n }),
    note("the publication"), assertion, ...pay(), assertion]);
  const elsewhere = await signed([note("the publication"), ...pay(payer.address, CREATOR)]);
  const byOther = await signed([note("the publication"), ...pay(other.address)], other);
  const memoOnly = await signed([note("the publication"), pay()[1]]);
  const toOther = await signed([note("the publication"), { ...pay()[0], accounts: [pay()[0].accounts![0], { address: address(CREATOR), role: AccountRole.WRITABLE }] }, pay()[1]]);
  const history = [later, failed, publication, prefund].map((tx) => ({
    signature: tx.signature, err: tx === failed ? { InstructionError: [0, "Custom"] } : null, slot: 7,
    confirmationStatus: "finalized",
  }));
  const byId = new Map([prefund, publication, later, failed, reviewed, rewritten, elsewhere, byOther, memoOnly, toOther]
    .map((tx) => [tx.signature, tx.result]));
  // The creator's claim receipt and the edition, by address; each answers its own history.
  const RECEIPT = "GH2ELkRUzqFRFZV6yJfjgE2XvzFz2mohS27Jrk6gji77", EDITION = CREATOR;
  const at = { receipt: RECEIPT, edition: EDITION };
  const entry = (tx: typeof publication) => ({ signature: tx.signature, err: null, slot: 7, confirmationStatus: "finalized" });
  let fetched: string[] = [], searched: string[] = [];
  const chain = (histories: Record<string, unknown[]>, unreadable?: string): Handler => (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "getSignaturesForAddress") {
      searched.push(body.params[0]);
      return json({ jsonrpc: "2.0", id: body.id, result: histories[body.params[0]] ?? [] });
    }
    fetched.push(body.params[0]);
    if (body.params[0] === unreadable) return new Response("pruned", { status: 500 });
    return json({ jsonrpc: "2.0", id: body.id, result: byId.get(body.params[0]) ?? null });
  };
  const search = async (histories: Record<string, unknown[]>, quoteId = publication.quoteId, unreadable?: string) => {
    fetched = []; searched = [];
    stub([[/^https:\/\/rpc\.invalid/, chain(histories, unreadable)]]);
    return findStoragePayment("https://rpc.invalid", at, quoteId, { payer: payer.address, destination: UPLOADER });
  };

  ok("the claim receipt is searched first, and the edition not at all when it holds the publication",
    (await search({ [RECEIPT]: [entry(publication)], [EDITION]: history })) === publication.signature &&
    searched.join() === RECEIPT && fetched.join() === publication.signature);
  ok("a pre-funding transfer on the claim receipt does not hide the publication behind it",
    (await search({ [RECEIPT]: [entry(publication), entry(prefund)] })) === publication.signature &&
    fetched.includes(prefund.signature));
  ok("a claim receipt without the publication falls through to the edition, verified the same way",
    (await search({ [RECEIPT]: [entry(prefund)], [EDITION]: history })) === publication.signature &&
    searched.join() === `${RECEIPT},${EDITION}`);
  ok("the publication is found by its fingerprint among the edition's oldest, past a pre-funding transfer",
    (await search({ [EDITION]: history })) === publication.signature && fetched.includes(prefund.signature));
  ok("a failed transaction is never read", !fetched.includes(failed.signature));
  ok("one unreadable transaction does not hide the publication",
    (await search({ [EDITION]: history }, publication.quoteId, prefund.signature)) === publication.signature);
  const missing = storageProblem(await rejection(search({ [RECEIPT]: [entry(publication)], [EDITION]: history }, "f".repeat(64))), true);
  ok("no matching transaction at either address is reported and can be checked again",
    missing.message === "The publication's payment was not found. Check again shortly." && missing.retryable &&
    searched.join() === `${RECEIPT},${EDITION}`);
  fetched = []; searched = [];
  const full = Array.from({ length: 1000 }, () => entry(later));
  stub([[/^https:\/\/rpc\.invalid/, chain({ [RECEIPT]: full, [EDITION]: full })]]);
  await rejection(findStoragePayment("https://rpc.invalid", at, publication.quoteId, { payer: payer.address, destination: UPLOADER }));
  ok("each address's history is walked at most five pages", searched.length === 10);

  // A wallet that rewrote the publication: the fingerprint no longer matches, the payment does.
  ok("the reviewed publication is found by its fingerprint, storage payment and all",
    (await search({ [RECEIPT]: [entry(reviewed)] }, reviewed.quoteId)) === reviewed.signature);
  ok("a publication the wallet rewrote (compute budget, Lighthouse) is found by its transfer and memo",
    (await search({ [RECEIPT]: [entry(later), entry(rewritten), entry(prefund)] }, reviewed.quoteId)) === rewritten.signature);
  ok("the same, at the edition when the claim receipt does not hold it",
    (await search({ [RECEIPT]: [entry(prefund)], [EDITION]: [entry(rewritten)] }, reviewed.quoteId)) === rewritten.signature);
  ok("an exact match wins over an older payment-shaped transaction",
    (await search({ [RECEIPT]: [entry(reviewed), entry(rewritten)] }, reviewed.quoteId)) === reviewed.signature);
  for (const [name, tx] of [["a memo naming another key", elsewhere], ["a transfer from another payer", byOther],
    ["a memo with no transfer", memoOnly], ["a transfer to another address", toOther]] as const) {
    const problem = storageProblem(await rejection(search({ [RECEIPT]: [entry(tx)] }, reviewed.quoteId)), true);
    ok(`not taken for the storage payment: ${name}`,
      problem.message === "The publication's payment was not found. Check again shortly.");
  }
  ok("paysStorage holds the payment to the message's own blockhash when asked",
    paysStorage(messageOf(rewritten), payer.address, UPLOADER, "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k") &&
    !paysStorage(messageOf(rewritten), payer.address, UPLOADER, "11111111111111111111111111111111"));
}
/** The message bytes out of a signed test transaction's `getTransaction` answer. */
const messageOf = (tx: { result: { transaction: unknown[] } }) =>
  new Uint8Array(getTransactionDecoder().decode(getBase64Encoder().encode(tx.result.transaction[0] as string)).messageBytes);

void (async () => {
  await quoteTests();
  instructionTests();
  await sizeTest();
  await creditTests();
  await receiptTests();
})().then(
  () => {
    console.log(failures ? `\n${failures} check(s) failed.` : "\nstorage payment self-test passed.");
    process.exit(failures ? 1 : 0);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
