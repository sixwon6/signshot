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
 *     refused, misdirected or unsettled credit reported rather than uploaded past;
 *   - the lost receipt: the publication transaction found in the edition's history by fingerprint.
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
import { TurboError } from "../src/arweave/turbo";
import { addresses, instruction, setOfferInstruction } from "../publications/core/protocol";
import { reviewedFingerprint } from "../publications/core/transferReceipt";
import {
  MAX_STORAGE_LAMPORTS,
  findStoragePayment,
  paidStorage,
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
}

/**
 * The largest publication the app builds: `publish_in_album` with the Genesis Token sealed, a
 * 24-byte title, `set_offer`, the compute budget, and now the storage transfer and memo, compiled as
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
      "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d", { mint, token: "GH2ELkRUzqFRFZV6yJfjgE2XvzFz2mohS27Jrk6gji77" }),
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
async function creditTests() {
  let asked = 0;
  const signature = async () => { asked += 1; return TX; };

  stub([held, sequence(credited)]);
  await settleStoragePayment(signature, UPLOADER, items, 0);
  ok("nothing to settle when the bundler holds both items: no receipt lookup, no request", asked === 0 && posts().length === 0);

  stub([notHeld, sequence(pending, credited)]);
  await settleStoragePayment(signature, UPLOADER, items, 0);
  const sent = posts();
  ok("a pending credit is asked again until the service credits it",
    sent.length === 2 && sent.every((call) => call.body === JSON.stringify({ tx_id: TX })) &&
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

  const reported: [string, Handler, string, boolean][] = [
    ["a refused payment", () => json({ message: "Transaction has already failed!", failedTransaction: { transactionId: TX, failureReason: "not a payment" } }, 400),
      "The storage provider refused this publication's payment.", false],
    ["credit landing on another account", () => credited(CREATOR), "The storage payment was credited to another account.", false],
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

  const short = storageProblem(new TurboError(402, "{}", "turbo: upload refused with HTTP 402"), true);
  const free = storageProblem(new TurboError(402, "{}", "turbo: upload refused with HTTP 402"));
  ok("a 402 after paying is short credit, a 402 on devnet the free allowance",
    short.message === "Storage credit ran short for this upload." && short.kind === "quota" &&
    free.message.startsWith("The storage provider refused the free upload allowance"));
}

// --- The lost receipt ------------------------------------------------------------------------------
async function receiptTests() {
  const payer = await generateKeyPairSigner();
  const signed = async (memo: string) => {
    const message = appendTransactionMessageInstructions(
      [{ programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [], data: new TextEncoder().encode(memo) }],
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k" as Blockhash, lastValidBlockHeight: 0n },
        setTransactionMessageFeePayerSigner(payer, createTransactionMessage({ version: 0 })),
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
  const history = [later, failed, publication, prefund].map((tx) => ({
    signature: tx.signature, err: tx === failed ? { InstructionError: [0, "Custom"] } : null, slot: 7,
    confirmationStatus: "finalized",
  }));
  const byId = new Map([prefund, publication, later, failed].map((tx) => [tx.signature, tx.result]));
  const fetched: string[] = [];
  stub([[/^https:\/\/rpc\.invalid/, (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "getSignaturesForAddress") return json({ jsonrpc: "2.0", id: body.id, result: history });
    fetched.push(body.params[0]);
    return json({ jsonrpc: "2.0", id: body.id, result: byId.get(body.params[0]) ?? null });
  }]]);
  const found = await findStoragePayment("https://rpc.invalid", CREATOR, publication.quoteId);
  ok("the publication is found by its fingerprint among the oldest, past a pre-funding transfer",
    found === publication.signature && fetched.includes(prefund.signature));
  ok("a failed transaction is never read", !fetched.includes(failed.signature));
  stub([[/^https:\/\/rpc\.invalid/, (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "getSignaturesForAddress") return json({ jsonrpc: "2.0", id: body.id, result: history });
    if (body.params[0] === prefund.signature) return new Response("pruned", { status: 500 });
    return json({ jsonrpc: "2.0", id: body.id, result: byId.get(body.params[0]) ?? null });
  }]]);
  ok("one unreadable transaction does not hide the publication",
    (await findStoragePayment("https://rpc.invalid", CREATOR, publication.quoteId)) === publication.signature);
  stub([[/^https:\/\/rpc\.invalid/, (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return json({ jsonrpc: "2.0", id: body.id, result: body.method === "getSignaturesForAddress" ? history : byId.get(body.params[0]) });
  }]]);
  const missing = storageProblem(await rejection(findStoragePayment("https://rpc.invalid", CREATOR, "f".repeat(64))), true);
  ok("no matching transaction is reported and can be checked again",
    missing.message === "The publication's payment was not found. Check again shortly." && missing.retryable);
}

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
