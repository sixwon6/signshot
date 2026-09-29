import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mock } from "node:test";

// Isolate synchronous URL parsing so a decoder regression cannot hang the test runner.
if (!process.argv.includes("--worker")) {
  const result = spawnSync(process.execPath,
    ["--experimental-test-module-mocks", "--disable-warning=ExperimentalWarning", "--import", "tsx",
      fileURLToPath(import.meta.url), "--worker"],
    { encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  process.stdout.write(result.stdout);
} else {
  const { matchesUploadCertificate } = await import("./signing-certificate.mjs");
  const uploadDigest = "ed334f571df9154c1ccfb3cada579771ef566c28dfd1534533b8782bc819dac9";
  const existingSigner = `Signer #1 certificate DN: CN=Era Shot\nSigner #1 certificate SHA-256 digest: ${uploadDigest}\n`;
  assert.equal(matchesUploadCertificate(existingSigner, uploadDigest), true, "a display-name change must not replace the signing identity");
  assert.equal(matchesUploadCertificate(existingSigner, "0".repeat(64)), false, "a different key must be refused even with the right name");
  assert.equal(matchesUploadCertificate(existingSigner.replace("CN=Era Shot", "CN=AndroidDebugKey"), uploadDigest), false);
  assert.equal(matchesUploadCertificate(existingSigner + `Signer #2 certificate SHA-256 digest: ${uploadDigest}\n`, uploadDigest), false);
  assert.equal(matchesUploadCertificate("", uploadDigest), false);
  const kit = await import("@solana/kit");
  const { readAlbumStore } = await import("../src/prints/albumStore.ts");
  const legacyAlbum = {
    nonce: "f272830b06c2d244dbbaf650cb8da98a414c98da2ccd6f37fca1eb98ef5bfa0d",
    address: "7NKvNJ29iaJixyAA8mwvJiLtYheqaVqx3rWUEh1Fgz24",
    name: "Devnet Phone Album",
    creator: "BSuFrMcYhSKS5dkprGtC17nVbP4VSFNvZzncnRtkVLpT",
    program: "BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq",
    createdAt: 1788972025900,
    attempt: { lastValidBlockHeight: "483514070" },
    confirmedAt: 1788976148447,
  };
  const albumJson = record => JSON.stringify({version: 1, albums: [record]});
  assert.deepEqual(await readAlbumStore(albumJson(legacyAlbum), "devnet"), [legacyAlbum],
    "a confirmed historical album must remain usable without invented review evidence");
  const pendingAlbum = {...legacyAlbum};
  delete pendingAlbum.confirmedAt;
  const [restoredPendingAlbum] = await readAlbumStore(albumJson(pendingAlbum), "devnet");
  assert.deepEqual(restoredPendingAlbum, pendingAlbum,
    "an older pending attempt must retain its lifetime and remain unconfirmed");
  const { checkReviewedReceipt } = await import("../src/prints/reviewedReceipt.ts");
  assert.equal(await checkReviewedReceipt("unused", undefined, legacyAlbum.attempt.quoteId), "unchecked");
  const reviewedAlbum = {...legacyAlbum, attempt: {...legacyAlbum.attempt, quoteId: "a".repeat(64)}};
  assert.deepEqual(await readAlbumStore(albumJson(reviewedAlbum), "devnet"), [reviewedAlbum]);
  for (const quoteId of [null, "", "invalid", 123])
    await assert.rejects(readAlbumStore(albumJson({...legacyAlbum,
      attempt: {...legacyAlbum.attempt, quoteId}}), "devnet"), /Saved albums/);
  await assert.rejects(readAlbumStore(albumJson({...legacyAlbum,
    address: legacyAlbum.creator}), "devnet"), /Saved albums/);
  await assert.rejects(readAlbumStore(albumJson({...legacyAlbum,
    attempt: {lastValidBlockHeight: "-1"}}), "devnet"), /lifetime/);
  await assert.rejects(readAlbumStore(albumJson(legacyAlbum), "mainnet-beta"), /not reviewed/);
  const { rpcWithTimeout } = await import("../publications/rpc.ts");
  mock.timers.enable({ apis: ["setTimeout"] });
  let timedOutSignal;
  const stalledRpc = rpcWithTimeout(signal => {
    timedOutSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  });
  const timeoutChecked = assert.rejects(stalledRpc, /Solana did not answer in time/);
  mock.timers.tick(20_000);
  await timeoutChecked;
  assert.equal(timedOutSignal.aborted, true, "timeout must cancel the transport");
  assert.equal(await rpcWithTimeout(async signal => {
    assert.equal(signal.aborted, false, "retry must get a fresh request lifetime");
    return "fresh response";
  }), "fresh response");
  await assert.rejects(rpcWithTimeout(async () => { throw new Error("different network"); }), /different network/);
  mock.timers.reset();
  const { isSigningRefused } = await import("../src/solana/walletErrors.ts");
  const { SolanaMobileWalletAdapterProtocolError, SolanaMobileWalletAdapterProtocolErrorCode,
    SolanaMobileWalletAdapterError, SolanaMobileWalletAdapterErrorCode } =
    createRequire(import.meta.url)("@solana-mobile/mobile-wallet-adapter-protocol");
  const refused = new SolanaMobileWalletAdapterProtocolError(
    1, SolanaMobileWalletAdapterProtocolErrorCode.ERROR_NOT_SIGNED, "Declined");
  assert.equal(isSigningRefused(refused), true);
  assert.equal(isSigningRefused(new Error("Timed out waiting for response")), false,
    "a missing wallet response must retain the pending attempt");
  assert.equal(isSigningRefused(new SolanaMobileWalletAdapterError(
    SolanaMobileWalletAdapterErrorCode.ERROR_SESSION_CLOSED, "Closed")), false,
    "closing the wallet can happen after broadcast");
  assert.equal(isSigningRefused({code: -3}), false, "unverified errors must not erase transaction state");
  assert.equal(isSigningRefused(new SolanaMobileWalletAdapterProtocolError(
    1, SolanaMobileWalletAdapterProtocolErrorCode.ERROR_NOT_SUBMITTED, "Submission uncertain")), false);
  {
    // A decline in the wallet puts the saved attempt back at once; nothing else touches it, since
    // a signed transaction may still land. Every flow that opens a wallet to sign goes through it.
    const { forgetIfRefused } = await import("../src/solana/walletErrors.ts");
    let forgotten = 0;
    const forget = async () => { forgotten++; };
    await assert.rejects(forgetIfRefused(Promise.reject(refused), forget), (error) => error === refused);
    assert.equal(forgotten, 1, "a refusal forgets the attempt once, then rethrows it");
    for (const kept of [new Error("Timed out waiting for response"),
      new SolanaMobileWalletAdapterError(SolanaMobileWalletAdapterErrorCode.ERROR_SESSION_CLOSED, "Closed"),
      { code: -3 },
      new SolanaMobileWalletAdapterProtocolError(1, SolanaMobileWalletAdapterProtocolErrorCode.ERROR_NOT_SUBMITTED, "Submission uncertain")])
      await assert.rejects(forgetIfRefused(Promise.reject(kept), forget), (error) => error === kept);
    assert.equal(forgotten, 1, "a timeout, a closed session or an unknown error keeps the attempt");
    assert.deepEqual(await forgetIfRefused(Promise.resolve(["signature"]), forget), ["signature"]);
    assert.equal(forgotten, 1);
    const { readFileSync } = await import("node:fs");
    for (const flow of ["collect", "creator", "offer", "albums", "transfer"]) {
      const text = readFileSync(new URL(`../src/prints/${flow}.ts`, import.meta.url), "utf8");
      const sends = text.split("wallet.signAndSendTransactions(").length - 1;
      assert.ok(sends >= 1 && text.split("forgetIfRefused(wallet.signAndSendTransactions(").length - 1 === sends,
        `${flow}.ts forgets a declined attempt`);
    }
    const transferFlow = readFileSync(new URL("../src/prints/transfer.ts", import.meta.url), "utf8");
    assert.match(transferFlow, /const previous = await read\(c\);[\s\S]*?previous \? write\(c, previous\) : AsyncStorage\.removeItem\(c\.key\)/,
      "a declined send restores the attempt before it, with its still-live messages");
    assert.match(transferFlow, /return holding\(c, async \(\) => \{[\s\S]*?forgetIfRefused\(wallet\.signAndSendTransactions\(/,
      "every send signs inside its copy's lock");
    // The WALLET screen sends through the same sheet and module: Send only for a copy the
    // connected wallet was read holding, and no signing of its own.
    const chainScreen = readFileSync(new URL("../src/screens/ChainScreen.tsx", import.meta.url), "utf8");
    const sendSheet = readFileSync(new URL("../src/prints/SendSheet.tsx", import.meta.url), "utf8");
    assert.match(chainScreen, /const sendable = activePhoto \? heldCopy\(activePhoto, wallet\) : null;/);
    assert.equal(chainScreen.split('testID="wallet-send"').length - 1, 1, "one Send chip");
    assert.match(chainScreen, /\{sendable && <Chip size="small" label=\{actions\.send\}[^>]*testID="wallet-send"/,
      "the Send chip stands behind heldCopy");
    assert.match(chainScreen, /<SendSheet target=\{sending\.target\}/);
    assert.match(sendSheet, /await sendTransfer\(target, session, quote,/);
    for (const [name, text] of [["ChainScreen", chainScreen], ["SendSheet", sendSheet]])
      assert.ok(!text.includes("signAndSendTransactions"), `${name} opens no signing of its own`);
  }
  {
    // The estimate is the payer's simulated balance delta, so a buy's already holds its price: the
    // total is the estimate alone, its rows add up to it, and a wallet holding exactly it passes.
    const { prepareTransaction, NEEDS_SOL } = await import("../publications/rpc.ts");
    const { costRows } = await import("../src/prints/price.ts");
    const realFetch = globalThis.fetch;
    const payer = "BSuFrMcYhSKS5dkprGtC17nVbP4VSFNvZzncnRtkVLpT";
    // Core's fee, mainnet rent for the 193-byte print and the 106-byte receipt, and the network fee.
    const price = 1_000_000_000, costs = 1_500_000 + 1_630_680 + 1_188_720 + 5_000;
    const chain = { balance: 0, accounts: undefined };
    const payerAfter = () => [{ lamports: chain.balance - price - costs, owner: "11111111111111111111111111111111",
      executable: false, rentEpoch: 0, space: 0, data: ["", "base64"] }];
    globalThis.fetch = async (_url, options) => {
      const { id, method } = JSON.parse(options.body);
      const context = { slot: 100 };
      const answers = {
        getLatestBlockhash: () => ({ context, value: { blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 200 } }),
        simulateTransaction: () => ({ context, value: { err: null, logs: [], unitsConsumed: 50_000, returnData: null,
          accounts: chain.accounts === undefined ? payerAfter() : chain.accounts } }),
        getRecentPrioritizationFees: () => [],
        getFeeForMessage: () => ({ context, value: 5_000 }),
        getBalance: () => ({ context, value: chain.balance }),
      };
      if (!answers[method]) throw new Error(`the estimate is not expected to call ${method}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: answers[method]() }),
        { headers: { "Content-Type": "application/json" } });
    };
    const memo = [{ programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [], data: new Uint8Array([1]) }];
    const quote = (balance, accounts) => {
      Object.assign(chain, { balance, accounts });
      return prepareTransaction("https://rpc.test", payer, memo);
    };
    try {
      const reviewed = await quote(10_000_000_000);
      const estimate = reviewed.estimatedLamports;
      assert.ok(estimate > BigInt(price + costs) - 10_000n && estimate < BigInt(price + costs) + 60_000n,
        "the estimate holds the price once");
      const rows = costRows(reviewed, BigInt(price));
      assert.equal(rows.total, estimate, "a buy's total is the estimate alone");
      assert.equal(BigInt(price) + rows.cost, rows.total, "the price and the costs line add up to the total");
      assert.equal(rows.networkFee + rows.accounts + rows.allowance, rows.cost, "the cost rows add up to the costs line");
      assert.equal((await quote(Number(estimate))).estimatedLamports, estimate,
        "a wallet holding exactly the price and the costs passes");
      await assert.rejects(quote(Number(estimate) - 1), { message: NEEDS_SOL });
      // No post-state for the payer is refused, never read as free; `null` is an account gone
      // afterwards, which is zero lamports and so more than the wallet holds.
      for (const accounts of [null, [], [{ ...payerAfter()[0], lamports: undefined }]])
        await assert.rejects(quote(10_000_000_000, accounts), /did not report this transaction's cost/);
      await assert.rejects(quote(10_000_000_000, [null]), { message: NEEDS_SOL });
    } finally {
      globalThis.fetch = realFetch;
    }
    // A publish holds its storage payment the way a buy holds its price.
    const breakdown = (accountCost) => ({ networkFee: 5_000n, accountCost, allowance: 50_000n, floor: 0n });
    const publish = costRows({ estimatedLamports: 16_050_000n, estimateBreakdown: breakdown(16_000_000n) }, 2_000_000n);
    assert.equal(publish.networkFee + publish.accounts + 2_000_000n + publish.allowance, publish.total);
    // A transfer creates nothing: its delta is the fee, which is not counted twice.
    const send = costRows({ estimatedLamports: 55_000n, estimateBreakdown: breakdown(5_000n) });
    assert.deepEqual([send.accounts, send.networkFee + send.allowance], [0n, send.total]);
    assert.equal(costRows({ estimatedLamports: 55_000n, estimateBreakdown: breakdown(0n) }, 1n).accounts, 0n, "clamped at zero");
    // The screens read the same rows (they cannot load under node).
    const { readFileSync } = await import("node:fs");
    const collectSheet = readFileSync(new URL("../src/prints/CollectSheet.tsx", import.meta.url), "utf8");
    assert.match(collectSheet, /<CostEstimate prepared=\{quote\.prepared\} apart=\{quote\.priceLamports\}/);
    assert.match(collectSheet, /priceCopy\.totalLabel\}\s*value=\{priceCopy\.value\(formatSol\(quote\.prepared\.estimatedLamports\)\)\}/);
    assert.doesNotMatch(collectSheet, /priceLamports \+/, "the price is never added to an estimate that holds it");
    assert.match(readFileSync(new URL("../src/prints/CostEstimate.tsx", import.meta.url), "utf8"),
      /const rows = costRows\(prepared, apart\);[\s\S]*costSol\(rows\.cost\)[\s\S]*costSol\(rows\.accounts\)/);
    assert.match(readFileSync(new URL("../src/prints/PrintSheet.tsx", import.meta.url), "utf8"),
      /costRows\(quote\.prepared, quote\.storageLamports\)\.accounts/);
  }
  {
    // A collect that failed on chain is forgotten, under the edition lock, and the edition answers
    // for itself; one that may still land, or confirmed unseen, still stops the offer. The real
    // collect.ts, with the build's cluster and AsyncStorage replaced (`mock.module` matches the
    // resolved file URL, as in check-looks.mjs).
    const require = createRequire(import.meta.url);
    const storage = { items: new Map(), reads: 0 };
    const AsyncStorage = {
      getItem: async (key) => { storage.reads++; return storage.items.get(key) ?? null; },
      setItem: async (key, value) => { storage.items.set(key, value); },
      removeItem: async (key) => { storage.items.delete(key); },
    };
    const mocks = [
      mock.module(new URL("../src/solana/cluster.ts", import.meta.url).href, { namedExports: {
        CLUSTER_NAME: "devnet", RPC_ENDPOINT: "https://rpc.test", assertEndpointCluster: async () => {} } }),
      mock.module(pathToFileURL(require.resolve("@react-native-async-storage/async-storage")).href,
        { defaultExport: AsyncStorage }),
    ];
    const { getCollectState, isCollectWorking } = await import("../src/prints/collect.ts");
    const { addresses } = await import("../publications/core/protocol.ts");
    const { TRUSTED } = await import("../publications/deployments.ts");
    // Required, not imported: the lock set is the one collect.ts loaded.
    const { exclusive } = require("../publications/lifecycle.ts");
    const { CORE_PROTOCOL } = await import("../publications/types.ts");
    const program = TRUSTED.devnet[0], creator = "BSuFrMcYhSKS5dkprGtC17nVbP4VSFNvZzncnRtkVLpT";
    const collector = "6r7wvBV2WR8L1GHJ1FV41j4JrqBxYfxQN3Xj7L2dPAuv", nonce = "cd".repeat(32);
    const keys = await addresses(program, creator, nonce);
    const edition = { cluster: "devnet", program, creator, nonce, edition: keys.edition,
      collection: keys.collection, title: "Sample", supply: 3 };
    const collectable = (remaining) => ({ edition, minted: 3 - remaining, remaining, imageUri: "",
      offer: null, seekerOnly: false, publication: {} });
    const key = `es.core-collect.v1:devnet:${keys.edition}:${collector}`;
    const saved = JSON.stringify({ version: 1, protocol: CORE_PROTOCOL, collector, edition: keys.edition,
      asset: (await addresses(program, creator, nonce, 3, collector)).print, number: 3,
      quoteId: "a".repeat(64), lastValidBlockHeight: "500", signature: "5".repeat(88) });
    const chain = { status: null, height: 0 };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      const { id, method } = JSON.parse(options.body);
      const results = {
        getAccountInfo: { context: { slot: 1 }, value: null },
        getSignatureStatuses: { context: { slot: 1 }, value: [chain.status] },
        getBlockHeight: chain.height,
      };
      if (!(method in results)) throw new Error(`the collect state is not expected to call ${method}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: results[method] }));
    };
    const failedWith = (code) => ({ err: { InstructionError: [0, { Custom: code }] }, confirmationStatus: "confirmed" });
    const stateAfter = async (status, remaining, height = 1_000) => {
      storage.items.set(key, saved);
      Object.assign(chain, { status, height });
      return getCollectState(collectable(remaining), collector);
    };
    try {
      const soldOut = await stateAfter(failedWith(6001), 0);
      assert.ok(storage.reads > 0, "the collect state must be reading the fake storage");
      assert.deepEqual([soldOut.eligibility, soldOut.reason, soldOut.attempt], ["soldOut", "Sold out.", null],
        "a claim that lost the last copy says sold out, not reopen the link");
      assert.equal(storage.items.has(key), false, "and its failed attempt is forgotten");
      const token = await stateAfter(failedWith(6008), 1);
      assert.equal(token.eligibility, "collect", "a claim refused on chain can be made again");
      assert.equal(storage.items.has(key), false);
      const pending = await stateAfter(null, 1, 400);
      assert.equal(pending.eligibility, "wait");
      assert.equal(storage.items.get(key), saved, "an attempt that may still land is kept");
      const unseen = await stateAfter({ err: null, confirmationStatus: "confirmed" }, 1);
      assert.equal(unseen.eligibility, "unavailable");
      assert.equal(storage.items.get(key), saved, "a confirmed attempt without its receipt is kept");
      let release;
      const held = exclusive(`collect:devnet:${keys.edition}`, () => new Promise((done) => { release = done; }));
      assert.equal(isCollectWorking(keys.edition), true, "the lock held is collect.ts's own");
      const during = await stateAfter(failedWith(6001), 1);
      release();
      await held;
      assert.equal(during.eligibility, "collect");
      assert.equal(storage.items.get(key), saved, "a running collection's lock is never taken from under it");
    } finally {
      globalThis.fetch = realFetch;
      for (const one of mocks) one.restore();
    }
  }
  const { readPhotoMetadata, readSavedPhotoMetadata } = await import("../publications/core/metadataDocument.ts");
  const { canonicalize } = await import("../src/jcs.ts");
  const legacyCommitment = {
    cluster: "devnet", program: "BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq",
    edition: "2qTq68fFdgZDp4cfaxpeis7z3M2VuoTwrA2Vwh8y9ruF", title: "Airpod", supply: 1,
    collection: "cxDV4N5ixJEukt5fQwjRBTavc48KQvVobfwSbdr2xuL", creator: "BSuFrMcYhSKS5dkprGtC17nVbP4VSFNvZzncnRtkVLpT",
    nonce: "d2ebdf80988d559aaf5bd5c405f3fd314bee061eaac0add45b50ae6c16147954",
    imageHash: "44c81f3e00c67d4a144f4af71271896e435c706d9f506961421319bd301fa876",
  };
  const legacyImage = "https://arweave.net/OpjuPPyPMVacebbDOwA1reqQ_5vNO2oTSDjWnEnNukQ";
  // A document in the legacy `erashot-core/1` format, as published on the legacy deployment.
  const legacyDocument = {
    name: "Airpod", image: legacyImage,
    description: "An Era Shot photograph published by a wallet. Ownership does not transfer copyright.",
    erashot: { ...legacyCommitment, schema: "erashot-core/1", protocol: "metaplex-core-editions-v1",
      image: legacyImage, width: 960, height: 1280, source: { profileId: "historical annotation" } },
    properties: { category: "image", files: [{ type: "image/jpeg", uri: legacyImage }] },
  };
  assert.deepEqual(readPhotoMetadata(legacyDocument, legacyCommitment), {
    image: legacyImage, description: legacyDocument.description, dimensions: {width:960,height:1280},
  });
  for (const field of ["creator", "program", "edition", "cluster", "collection", "nonce", "title", "supply", "imageHash"])
    assert.throws(() => readPhotoMetadata({ ...legacyDocument,
      erashot: { ...legacyDocument.erashot, [field]: "different" } }, legacyCommitment), /does not match/);
  assert.throws(() => readPhotoMetadata(legacyDocument, { ...legacyCommitment,
    program: "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU" }), /does not match/);
  assert.throws(() => readPhotoMetadata({ ...legacyDocument,
    properties: { category: "image", files: [{ type: "image/jpeg", uri: "https://example.com/unverified.jpg" }] } }, legacyCommitment), /does not match/);
  const currentDocument = {name:"Airpod", image:legacyImage, description:""};
  assert.deepEqual(readPhotoMetadata(currentDocument, legacyCommitment), {image:legacyImage,description:""});
  assert.throws(() => readPhotoMetadata({...currentDocument, extra:true}, legacyCommitment), /does not match/);
  const legacyLocal = { ...legacyCommitment, image: legacyImage, width: 960, height: 1280 };
  const legacyBytes = canonicalize(legacyDocument);
  const restoredLegacy = readSavedPhotoMetadata(legacyBytes, legacyLocal);
  assert.equal(restoredLegacy.description, legacyDocument.description,
    "pre-caption drafts must read the description already in their immutable document");
  assert.equal(legacyLocal.description, undefined, "reading must not mutate the saved edition");
  assert.equal(canonicalize(legacyDocument), legacyBytes, "legacy document bytes must never be rewritten");
  assert.throws(() => readSavedPhotoMetadata(legacyBytes, {...legacyLocal, width: 961}), /does not match/);
  assert.throws(() => readSavedPhotoMetadata(legacyBytes, {...legacyLocal, description: "changed"}), /does not match/);
  assert.throws(() => readSavedPhotoMetadata(`${legacyBytes} `, legacyLocal), /does not match/);
  assert.throws(() => readSavedPhotoMetadata(legacyBytes, {...legacyLocal, image: "https://arweave.net/" + "a".repeat(43)}), /does not match/);
  assert.throws(() => readSavedPhotoMetadata(canonicalize(currentDocument), legacyLocal), /does not match/);
  const currentLocal = {...legacyLocal, description: ""};
  assert.deepEqual(readSavedPhotoMetadata(canonicalize(currentDocument), currentLocal), currentLocal);
  const { getTransferSolInstruction } = await import("@solana-program/system");
  const { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } = await import("@solana-program/compute-budget");
  const { reviewedFingerprint, matchesReviewedMessage } = await import("../publications/core/transferReceipt.ts");
  const payer = kit.address("BSuFrMcYhSKS5dkprGtC17nVbP4VSFNvZzncnRtkVLpT");
  const fundingRecipient = kit.address("6r7wvBV2WR8L1GHJ1FV41j4JrqBxYfxQN3Xj7L2dPAuv");
  const fundingMessage = (recipient = fundingRecipient, amount = 2_400_000_000n, price = 5_000n) =>
    kit.compileTransaction(kit.appendTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: 50_000 }),
      getSetComputeUnitPriceInstruction({ microLamports: price }),
      getTransferSolInstruction({ source: kit.createNoopSigner(payer), destination: recipient, amount }),
    ], kit.setTransactionMessageLifetimeUsingBlockhash({
      blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1n,
    }, kit.setTransactionMessageFeePayer(payer, kit.createTransactionMessage({ version: 0 }))))).messageBytes;
  const reviewedFunding = new Uint8Array(fundingMessage());
  const fundingQuote = reviewedFingerprint(reviewedFunding);
  // Seed Vault reorders equally privileged accounts and changes the CU price before signing.
  // Those bytes differ, while the recipient, amount, account roles and instruction order agree.
  const walletMessage = kit.getCompiledTransactionMessageDecoder().decode(fundingMessage(fundingRecipient, 2_400_000_000n, 50_000n));
  const accountOrder = walletMessage.staticAccounts.map((_, i) => i);
  const last = accountOrder.length - 1;
  [accountOrder[last - 1], accountOrder[last]] = [accountOrder[last], accountOrder[last - 1]];
  const remap = index => accountOrder.indexOf(index);
  const walletFunding = new Uint8Array(kit.getCompiledTransactionMessageEncoder().encode({
    ...walletMessage,
    staticAccounts: accountOrder.map(index => walletMessage.staticAccounts[index]),
    instructions: walletMessage.instructions.map(instruction => ({ ...instruction,
      programAddressIndex: remap(instruction.programAddressIndex),
      ...(instruction.accountIndices ? { accountIndices: instruction.accountIndices.map(remap) } : {}),
    })),
  }));
  assert.notDeepEqual(walletFunding, reviewedFunding, "regression must exercise a real byte rewrite");
  assert.equal(matchesReviewedMessage(walletFunding, fundingQuote), true, "normal wallet rewrites must not discard an approved transfer");
  assert.equal(matchesReviewedMessage(new Uint8Array(fundingMessage(payer)), fundingQuote), false, "changed recipient must be refused");
  assert.equal(matchesReviewedMessage(new Uint8Array(fundingMessage(fundingRecipient, 2_400_000_001n)), fundingQuote), false, "changed amount must be refused");
  assert.equal(matchesReviewedMessage(new Uint8Array(fundingMessage(fundingRecipient, 2_400_000_000n, 1_000_000_000n)), fundingQuote), false, "excessive wallet fee must be refused");
  assert.equal(matchesReviewedMessage(new Uint8Array([255]), fundingQuote), false);
  const { sessionBudget, testReserve } = await import("../publications/devnet/work.ts");
  const { verifyCreatorProceeds } = await import("../publications/devnet/purchaseReceipt.ts");
  const paidReceipt = {
    transaction: { signatures: ["purchase"], message: { accountKeys: ["buyer", "creator"] } },
    meta: { err: null, preBalances: [30_000_000, 50_000_000], postBalances: [14_000_000, 60_000_000] },
  };
  assert.equal(verifyCreatorProceeds(paidReceipt, "purchase", "creator", 10_000_000n), 10_000_000n);
  assert.equal(verifyCreatorProceeds(paidReceipt, "purchase", "creator", 10_000_000n), 10_000_000n,
    "reconciling the same confirmed purchase must still prove its original payment");
  assert.throws(() => verifyCreatorProceeds(paidReceipt, "wrong", "creator", 10_000_000n), /Wrong purchase/);
  assert.throws(() => verifyCreatorProceeds(paidReceipt, "purchase", "creator", 20_000_000n), /exact reviewed/);
  assert.throws(() => verifyCreatorProceeds(paidReceipt, "purchase", "buyer", 10_000_000n), /must not pay/);
  assert.throws(() => verifyCreatorProceeds({ ...paidReceipt, meta: { ...paidReceipt.meta, err: "failed" } },
    "purchase", "creator", 10_000_000n), /failed on chain/);
  const originalFetch = globalThis.fetch;
  const rentQueries = [];
  try {
    globalThis.fetch = async (_url, options) => {
      const { method, params } = JSON.parse(options.body);
      assert.equal(method, "getMinimumBalanceForRentExemption");
      rentQueries.push(params[0]);
      // Rent comes from the RPC, never from a hard-coded formula.
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: (params[0] + 128) * 5080 }));
    };
    const budget = await sessionBudget({ endpoint: "https://api.devnet.solana.com" }, 438_912);
    assert.deepEqual(rentQueries.sort((a, b) => a - b), [36, 438_957]);
    assert.equal(budget.programData, 2_230_551_800);
    assert.equal(budget.programAccount, 833_120);
    assert.equal(budget.fees, 2_460_000, "488 uploads and two 2-signature transactions exceed the old fixed fee budget");
    assert.equal(budget.total, 2_463_174_440,
      "the reserve grew by one publish, the Genesis Token fixture, published_at, and the royalty and Seeker-only rows");
    assert.equal(budget.reserve, testReserve());
    const short = await sessionBudget({ endpoint: "https://api.devnet.solana.com" }, 900);
    const overflow = await sessionBudget({ endpoint: "https://api.devnet.solana.com" }, 901);
    assert.equal(overflow.fees - short.fees, 5_000, "a partial last upload still needs a transaction fee");
    await assert.rejects(sessionBudget({ endpoint: "unused" }, 0), /Invalid program byte count/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const { DEFAULT_CAPTURE_SETTINGS, settingsFromEffective, clampSettings, autoEvSpan } =
    await import("../src/capture/model.ts");
  const { captureModeOf, heldBeyondAuto, autoModeSettings, programSettings, manualSettings, displayIn, nextDisplay,
    settingsLeavingAuto, withBrightnessCarried, parseCaptureChrome, chromeHolding, DEFAULT_CAPTURE_CHROME,
    turnDial, holdsExposure, rememberedMode, rememberedFor } =
    await import("../src/capture/mode.ts");
  // Camera2 holds ISO and shutter together, so both are stored; restoring only one would let the
  // other read Auto and drift when the camera reopens.
  const manualCapture = { ...DEFAULT_CAPTURE_SETTINGS, manualExposure: true,
    iso: 320, shutterNs: 8_000_000, whiteBalance: "daylight", focus: 1.5 };
  const heldCapture = settingsFromEffective(manualCapture);
  assert.equal(heldCapture.iso, 320);
  assert.equal(heldCapture.shutterNs, 8_000_000);
  assert.equal("manualExposure" in heldCapture, false);
  // The mode dial follows what is held. A held value is never hidden, so restored manual
  // exposure reads M, and anything AUTO has no cell for reads P, whatever the stored choice was.
  assert.equal(captureModeOf(heldCapture, false), "manual");
  assert.equal(captureModeOf(heldCapture, true), "manual");
  assert.equal(captureModeOf(DEFAULT_CAPTURE_SETTINGS, false), "auto");
  assert.equal(captureModeOf(DEFAULT_CAPTURE_SETTINGS, true), "program");
  assert.equal(captureModeOf({ ...DEFAULT_CAPTURE_SETTINGS, ev: 3 }, false), "auto",
    "brightness is the one control AUTO shows, so holding it does not leave AUTO");
  for (const held of [{ awbLock: true }, { aeLock: true }, { whiteBalance: "daylight" },
    { whiteBalance: { kelvin: 5200 } }, { focus: 1.5 }]) {
    const settings = { ...DEFAULT_CAPTURE_SETTINGS, ...held };
    assert.equal(heldBeyondAuto(settings), true);
    assert.equal(captureModeOf(settings, false), "program", "AUTO must never hide a held value");
  }
  // P hands exposure back without losing the photographer's colour, focus or locks.
  const programCapture = programSettings({ ...heldCapture, awbLock: true });
  assert.equal(captureModeOf(programCapture, true), "program");
  assert.equal(programCapture.iso, "auto");
  assert.equal(programCapture.shutterNs, "auto");
  assert.equal(programCapture.whiteBalance, "daylight");
  assert.equal(programCapture.focus, 1.5);
  assert.equal(programCapture.awbLock, true);
  assert.equal(heldCapture.iso, 320, "switching modes must not mutate the saved settings");
  const unheld = { ...DEFAULT_CAPTURE_SETTINGS, whiteBalance: "daylight" };
  assert.equal(programSettings(unheld), unheld, "P with nothing to release must not restart the camera request");
  // AUTO releases everything it cannot show and keeps brightness.
  const autoCapture = autoModeSettings({ ...heldCapture, ev: 2, aeLock: true, awbLock: true });
  assert.deepEqual(autoCapture, { ...DEFAULT_CAPTURE_SETTINGS, ev: 2 });
  assert.equal(captureModeOf(autoCapture, false), "auto");
  // M holds the metered exposure, both values at once, and waits for a first reading.
  const reading = { iso: 137, shutterNs: 13_698_630, ev: 0, focusDistance: null, awbMode: "auto",
    aeState: "converged", afState: "inactive", manualExposure: false, histogram: [], sampled: 0,
    clippedBlack: 0, clippedWhite: 0 };
  const plainCaps = { manualSensor: true, iso: { min: 50, max: 6400 }, shutterNs: { min: 100_000, max: 30_000_000_000 } };
  const manualCaptureFromMeter = manualSettings(unheld, reading, plainCaps);
  assert.equal(manualCaptureFromMeter.iso, 137);
  assert.equal(manualCaptureFromMeter.shutterNs, 13_698_630);
  assert.equal(manualCaptureFromMeter.whiteBalance, "daylight");
  assert.equal(captureModeOf(manualCaptureFromMeter, true), "manual");
  assert.equal(manualSettings(unheld, null, plainCaps), null);
  assert.equal(manualSettings(unheld, { ...reading, iso: null }, plainCaps), null);
  assert.equal(manualSettings(heldCapture, null, plainCaps), heldCapture, "an exposure already held is kept, never re-metered");
  // The Seeker's meter can read past its manual ISO range (20000 against a maximum of 11470): M
  // clamps ISO and lengthens the shutter so the exposure stays the one metered.
  const seekerCaps = { ...plainCaps, iso: { min: 100, max: 11470 }, shutterNs: { min: 100_000, max: 16_000_000_000 } };
  const inTheDark = manualSettings(unheld, { ...reading, iso: 20000, shutterNs: 100_000_000 }, seekerCaps);
  assert.equal(inTheDark.iso, 11470);
  assert.equal(inTheDark.shutterNs, Math.round(100_000_000 * (20000 / 11470)));
  assert.ok(Math.abs(inTheDark.iso * inTheDark.shutterNs - 20000 * 100_000_000) / (20000 * 100_000_000) < 1e-6,
    "M must hold the exposure that was metered, not a darker one");
  const inRange = manualSettings(unheld, { ...reading, iso: 800, shutterNs: 8_000_000 }, seekerCaps);
  assert.deepEqual([inRange.iso, inRange.shutterNs], [800, 8_000_000], "a reading the sensor can hold is held as it is");
  // Leaving AUTO brings back what P and M held, under the brightness AUTO has now.
  const autoNow = { ...DEFAULT_CAPTURE_SETTINGS, ev: 3 };
  assert.deepEqual(settingsLeavingAuto(autoNow, heldCapture), { ...heldCapture, ev: 3 });
  assert.equal(programSettings(settingsLeavingAuto(autoNow, heldCapture)).iso, "auto", "P drops the parked exposure");
  assert.equal(manualSettings(settingsLeavingAuto(autoNow, heldCapture), null, plainCaps).iso, 320, "M keeps the parked exposure");
  assert.equal(settingsLeavingAuto(autoNow, null), autoNow);
  assert.equal(settingsLeavingAuto(autoNow, { ...DEFAULT_CAPTURE_SETTINGS, ev: -3 }), autoNow,
    "a parked AUTO-like state must not restart the camera request");
  // Brightness is set aside while M has no meter to steer, and returns with the meter.
  const plusOne = { ...DEFAULT_CAPTURE_SETTINGS, ev: 3 };
  const intoManual = withBrightnessCarried(plusOne, { ...heldCapture, ev: 0 }, null);
  assert.equal(intoManual.aside, 3);
  assert.equal(intoManual.settings.ev, 0);
  const withinManual = withBrightnessCarried(heldCapture, { ...heldCapture, iso: 640 }, intoManual.aside);
  assert.equal(withinManual.aside, 3);
  const backToProgram = withBrightnessCarried(heldCapture, programSettings({ ...heldCapture, ev: 0 }), withinManual.aside);
  assert.equal(backToProgram.settings.ev, 3, "P after M must not drop the photograph a stop");
  assert.equal(backToProgram.aside, null);
  assert.equal(withBrightnessCarried(heldCapture, DEFAULT_CAPTURE_SETTINGS, null).settings.ev, 0);
  assert.equal(withBrightnessCarried(plusOne, { ...plusOne, ev: 6 }, null).settings.ev, 6);
  // The stored chrome: the older `histogram` record, garbage, and a held value it would hide.
  assert.deepEqual(parseCaptureChrome('{"v":1,"histogram":true}'), { readout: false, display: "histogram" });
  assert.deepEqual(parseCaptureChrome('{"v":1,"readout":true,"display":"grid"}'), { readout: true, display: "grid" });
  assert.deepEqual(parseCaptureChrome('{"v":1,"readout":"yes","display":"zebra"}'), DEFAULT_CAPTURE_CHROME);
  for (const raw of [null, "", "null", "[]", "{", "7"]) assert.deepEqual(parseCaptureChrome(raw), DEFAULT_CAPTURE_CHROME);
  assert.deepEqual(chromeHolding(DEFAULT_CAPTURE_CHROME, heldCapture), { readout: true, display: "plain" },
    "releasing a restored held value must leave the dial on P, not drop it to AUTO");
  assert.equal(chromeHolding(DEFAULT_CAPTURE_CHROME, plusOne), DEFAULT_CAPTURE_CHROME);
  const upAlready = { readout: true, display: "grid" };
  assert.equal(chromeHolding(upAlready, heldCapture), upAlready);
  // DISP: plain, grid, histogram. The histogram belongs to the readout, so AUTO skips it.
  assert.deepEqual(["plain", "grid", "histogram"].map((one) => nextDisplay(one, "program")), ["grid", "histogram", "plain"]);
  assert.deepEqual(["plain", "grid", "histogram"].map((one) => nextDisplay(one, "auto")), ["grid", "plain", "grid"]);
  assert.equal(displayIn("histogram", "auto"), "plain");
  assert.equal(displayIn("histogram", "manual"), "histogram");
  assert.equal(displayIn("grid", "auto"), "grid");
  assert.deepEqual(settingsFromEffective({ ...DEFAULT_CAPTURE_SETTINGS, manualExposure: false }),
    DEFAULT_CAPTURE_SETTINGS, "automatic exposure must never store a metered ISO or shutter");
  const captureCaps = { manualSensor: true, iso: { min: 50, max: 6400 },
    shutterNs: { min: 100_000, max: 30_000_000_000 }, ev: { min: -6, max: 6, step: 1 / 3 },
    aeLock: true, awbLock: true, awbModes: ["auto", "daylight"], focus: "unavailable" };
  const preciseExposure = { ...DEFAULT_CAPTURE_SETTINGS, iso: 317, shutterNs: 8_234_567 };
  const changedColour = clampSettings({ ...preciseExposure, whiteBalance: "daylight" }, captureCaps);
  assert.equal(changedColour.iso, preciseExposure.iso,
    "changing white balance must not snap a metered companion ISO to the dial ladder");
  assert.equal(changedColour.shutterNs, preciseExposure.shutterNs);
  // M from the meter survives the device clamp unsnapped, with brightness zeroed as native does.
  const heldFromMeter = clampSettings(manualSettings({ ...unheld, ev: 3 }, reading, captureCaps), captureCaps);
  assert.equal(heldFromMeter.iso, 137);
  assert.equal(heldFromMeter.shutterNs, 13_698_630);
  assert.equal(heldFromMeter.ev, 0);
  assert.equal(captureModeOf(heldFromMeter, true), "manual");
  // A camera with no manual sensor has no M: the clamp drops the pair and the dial reads P.
  const noManualSensor = clampSettings(manualSettings(unheld, reading, captureCaps), { ...captureCaps, manualSensor: false });
  assert.equal(noManualSensor.iso, "auto");
  assert.equal(captureModeOf(noManualSensor, true), "program");
  // ISO and shutter are one pair: the dial has an M only when the camera reports both ranges.
  assert.equal(holdsExposure(captureCaps), true);
  assert.equal(holdsExposure({ ...captureCaps, manualSensor: false }), false);
  assert.equal(holdsExposure({ ...captureCaps, shutterNs: "unavailable" }), false);
  assert.equal(holdsExposure({ ...captureCaps, iso: "unavailable" }), false);
  // AUTO's brightness: two stops either way in device steps, never past what the camera offers.
  const spanOf = (ev) => autoEvSpan({ ...captureCaps, ev });
  assert.deepEqual(spanOf({ min: -9, max: 12, step: 1 / 3 }), { min: -6, max: 6 });
  assert.deepEqual(spanOf({ min: -4, max: 4, step: 1 / 3 }), { min: -4, max: 4 });
  assert.deepEqual(spanOf({ min: -24, max: 24, step: 1 / 6 }), { min: -12, max: 12 });
  for (const none of ["unavailable", { min: 0, max: 0, step: 1 / 3 }, { min: -6, max: 6, step: 0 }])
    assert.equal(spanOf(none), null);

  {
    // The dial as the photographer turns it. `turn` is the hook's own composition: the turn, then
    // the device clamp, then brightness carried; `move` is one control moved the same way.
    const startDial = { settings: DEFAULT_CAPTURE_SETTINGS, readout: false, parked: null, aside: null };
    const settle = (dial, next) => {
      const carried = withBrightnessCarried(dial.settings, clampSettings(next, captureCaps), dial.aside);
      return { ...dial, settings: carried.settings, aside: carried.aside };
    };
    const turn = (dial, to, meter = reading) => {
      const turned = turnDial(dial, to, meter, captureCaps);
      if (turned === null) return null;
      return settle({ ...dial, readout: turned.readout, parked: turned.parked }, turned.settings);
    };
    const move = (dial, patch) => settle(dial, { ...dial.settings, ...patch });
    const at = (dial) => captureModeOf(dial.settings, dial.readout);

    // P at +1, M, P: still +1. M holds what was metered; brightness waits and comes back.
    let dial = move(turn(startDial, "program"), { ev: 3 });
    assert.equal(at(dial), "program");
    dial = turn(dial, "manual");
    assert.equal(at(dial), "manual");
    assert.deepEqual([dial.settings.iso, dial.settings.shutterNs, dial.settings.ev], [137, 13_698_630, 0]);
    dial = turn(dial, "program");
    assert.equal(at(dial), "program");
    assert.deepEqual([dial.settings.iso, dial.settings.shutterNs, dial.settings.ev], ["auto", "auto", 3]);

    // A ruler moved in P turns the dial to M by itself, and Auto exposure turns it back.
    dial = move(dial, { iso: 800 });
    assert.equal(at(dial), "manual");
    dial = move(dial, { iso: "auto", shutterNs: "auto" });
    assert.equal(at(dial), "program");
    assert.equal(dial.settings.ev, 3);

    // M with colour held, AUTO, then M: the held pair and the colour come back as they were left.
    dial = move(turn(dial, "manual"), { iso: 800, whiteBalance: "daylight" });
    const leftInManual = dial.settings;
    dial = turn(dial, "auto");
    assert.equal(at(dial), "auto");
    assert.deepEqual(dial.settings, { ...DEFAULT_CAPTURE_SETTINGS, ev: 3 }, "AUTO keeps brightness and nothing else");
    assert.equal(heldBeyondAuto(dial.settings), false, "AUTO must never hold what it cannot show");
    dial = turn(move(dial, { ev: -3 }), "manual", null);
    assert.equal(at(dial), "manual");
    assert.deepEqual({ ...dial.settings, ev: 0 }, { ...leftInManual, ev: 0 }, "M needs no reading to bring back a held pair");
    assert.equal(dial.parked, null, "what AUTO set aside is spent once the dial leaves AUTO");
    // ...and P from there is under the brightness AUTO was given, not the one M set aside before it.
    assert.equal(turn(dial, "program").settings.ev, -3);

    // AUTO, then P instead: the colour comes back, the exposure does not, and the brightness is
    // the one AUTO was left on, because that is the control the two share.
    dial = turn(move(turn(dial, "auto"), { ev: 6 }), "program");
    assert.equal(at(dial), "program");
    assert.deepEqual([dial.settings.iso, dial.settings.whiteBalance, dial.settings.ev], ["auto", "daylight", 6]);

    // Refused turns change nothing: the dial already there, and M with nothing to hold.
    assert.equal(turnDial(dial, "program", reading, captureCaps), null);
    assert.equal(turnDial(startDial, "auto", reading, captureCaps), null);
    assert.equal(turnDial(startDial, "manual", null, captureCaps), null);
    assert.equal(turnDial(startDial, "manual", { ...reading, shutterNs: null }, captureCaps), null);
    // AUTO to P with nothing set aside tells the camera nothing new: the settings are the same object.
    assert.equal(turnDial(startDial, "program", reading, captureCaps).settings, startDial.settings);
    const parkedNothing = { ...startDial, parked: { ...DEFAULT_CAPTURE_SETTINGS, ev: -3 } };
    assert.equal(turnDial(parkedNothing, "program", reading, captureCaps).settings, parkedNothing.settings);
    // A restored held value reads P whatever was stored, and releasing it from AUTO's side of the
    // store (readout false) is still a turn the dial accepts.
    const latched = { ...startDial, settings: { ...DEFAULT_CAPTURE_SETTINGS, focus: 1.5 } };
    assert.equal(at(latched), "program");
    assert.equal(at(turn(latched, "auto")), "auto");
    assert.equal(turn(latched, "auto").parked.focus, 1.5);

    // What AUTO set aside is shown on the dial: M for an exposure, P for anything else it cannot show.
    assert.equal(rememberedMode(null), null);
    assert.equal(rememberedMode({ ...DEFAULT_CAPTURE_SETTINGS, ev: 3 }), null);
    assert.equal(rememberedMode({ ...DEFAULT_CAPTURE_SETTINGS, whiteBalance: "daylight" }), "program");
    assert.equal(rememberedMode(leftInManual), "manual");
    // What was stored beside the settings is believed only where it means something: the parked
    // settings while the dial is on AUTO, the set-aside brightness while an exposure is held.
    assert.deepEqual(rememberedFor(DEFAULT_CAPTURE_SETTINGS, false, leftInManual, 3), { parked: leftInManual, aside: null });
    assert.deepEqual(rememberedFor(DEFAULT_CAPTURE_SETTINGS, true, leftInManual, 3), { parked: null, aside: null },
      "off AUTO nothing is parked, whatever the store says");
    assert.deepEqual(rememberedFor(leftInManual, true, leftInManual, 3), { parked: null, aside: 3 });
    assert.deepEqual(rememberedFor(DEFAULT_CAPTURE_SETTINGS, false, { ...DEFAULT_CAPTURE_SETTINGS, ev: 3 }, null),
      { parked: null, aside: null }, "parked settings that hold nothing are nothing");
  }

  const { createSerialQueue } = await import("../src/serial.ts");
  const serial = createSerialQueue(), independent = createSerialQueue();
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = serial(async () => { order.push(1); await gate; throw new Error("expected"); });
  const rejected = assert.rejects(first, /expected/);
  const second = serial(async () => { order.push(2); return 42; });
  await independent(async () => { assert.deepEqual(order, [1]); });
  release();
  await rejected;
  assert.equal(await second, 42);
  assert.deepEqual(order, [1, 2]);
  const require = createRequire(import.meta.url);
  // xcode's only UUID API is CommonJS v4(); exercise the consumer after its scoped override.
  const configRequire = createRequire(require.resolve("expo-sharing/app.plugin.js"));
  const pluginsRequire = createRequire(configRequire.resolve("@expo/config-plugins"));
  const xcode = pluginsRequire("xcode");
  const project = xcode.project("unused.pbxproj");
  project.hash = { project: { objects: { PBXGroup: {} } } };
  for (let i = 0; i < 100; i++) {
    const id = project.generateUuid();
    assert.match(id, /^[A-F0-9]{24}$/);
    assert.equal(project.hash.project.objects.PBXGroup[id], undefined);
    project.hash.project.objects.PBXGroup[id] = {};
  }
  // Resolve the core actually used by our installed navigator, including nested copies.
  const nativeRequire = createRequire(require.resolve("@react-navigation/native/package.json"));
  const { getStateFromPath } = nativeRequire("@react-navigation/core");
  const { linking } = await import("../src/navigators/linking.ts");
  const edition = "BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq";
  for (const path of ["collect", "collect/"]) {
    const state = getStateFromPath(`/${path}?core=${edition}&cluster=devnet`, linking.config);
    assert.equal(state.routes[0].name, "Chain");
    assert.equal(state.routes[0].params.core, edition);
    assert.equal(state.routes[0].params.cluster, "devnet");
  }
  assert.equal(getStateFromPath("/Settings", linking.config), undefined);
  const malformed = getStateFromPath(`/collect?core=${"%FE%FF".repeat(500)}`, linking.config);
  assert.equal(malformed.routes[0].name, "Chain");

  const { createDevelopQueue } = await import("../src/prints/developQueue.ts");
  const started = [], delivered = [], pending = [];
  const queue = createDevelopQueue(request => {
    started.push(request.strength);
    return new Promise(resolve => pending.push(resolve));
  }, outcome => delivered.push(outcome.request.strength));
  const request = strength => ({ recipe: {}, strength });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  queue.request(request(0.1));
  queue.request(request(0.2));
  queue.request(request(0.3));
  pending.shift()({});
  await settle();
  assert.deepEqual(started, [0.1, 0.3]);
  assert.deepEqual(delivered, []);
  queue.request(request(0.4));
  queue.cancel();
  pending.shift()({});
  await settle();
  assert.deepEqual(started, [0.1, 0.3], "closing must discard waiting native renders");
  assert.deepEqual(delivered, [], "closed editor must not receive completed renders");
  queue.request(request(0.5));
  pending.shift()({});
  await settle();
  assert.deepEqual(delivered, [0.5], "effect replay must be able to reuse the queue");

  const debounceStarted = [], debounceDelivered = [], debouncePending = [];
  mock.timers.enable({ apis: ["setTimeout"] });
  const debounced = createDevelopQueue(request => {
    debounceStarted.push(request.strength);
    return new Promise(resolve => debouncePending.push(resolve));
  }, outcome => debounceDelivered.push(outcome.request.strength));
  debounced.request(request(0.1));
  debounced.request(request(0.2), 40);
  debouncePending.shift()({});
  await settle();
  assert.deepEqual(debounceStarted, [0.1], "new render must wait for the debounce deadline");
  assert.deepEqual(debounceDelivered, [], "old render must not become usable during debounce");
  mock.timers.tick(40);
  assert.deepEqual(debounceStarted, [0.1, 0.2]);
  debouncePending.shift()({});
  await settle();
  assert.deepEqual(debounceDelivered, [0.2]);
  debounced.request(request(0.3), 40);
  debounced.cancel();
  mock.timers.tick(40);
  assert.deepEqual(debounceStarted, [0.1, 0.2], "cancellation must clear the debounce timer");
  mock.timers.reset();
  const { loadPhotoEntries, loadPhotosInStages } = await import("../src/prints/photoLoading.ts");
  let running = 0, peak = 0;
  const entries = await loadPhotoEntries([0, 1, 2, 3, 4, 5, 6], async item => {
    peak = Math.max(peak, ++running);
    await settle();
    running--;
    return item * 2;
  }, () => true);
  assert.equal(peak, 3, "photo reads must have bounded concurrency");
  assert.deepEqual(entries, [0, 2, 4, 6, 8, 10, 12], "library order must be preserved");
  let current = true;
  const read = [];
  await assert.rejects(loadPhotoEntries([0, 1, 2, 3, 4, 5], async item => {
    read.push(item);
    await settle();
    current = false;
    return item;
  }, () => current), /cancelled/);
  await settle();
  assert.deepEqual(read, [0, 1, 2], "superseded loads must stop scheduling new work");
  let finishRemote;
  const remoteGate = new Promise(resolve => { finishRemote = resolve; });
  let localShown = [], freshShown = [];
  let photosCurrent = true;
  const staged = loadPhotosInStages({
    records: ["new local photo", "old published photo"],
    readLocal: async name => ({name, remote: false}),
    showLocal: entries => { localShown = entries; },
    refresh: async entry => { await remoteGate; return {...entry, remote: true}; },
    showFresh: entry => freshShown.push(entry),
    isCurrent: () => photosCurrent,
  });
  await settle();
  assert.equal(localShown.length, 2, "a stalled RPC must not hide the new local photo");
  assert.equal(localShown[0].remote, false);
  assert.equal(freshShown.length, 0);
  photosCurrent = false;
  finishRemote();
  await staged;
  assert.equal(freshShown.length, 0, "late remote results must not overwrite a newer photo selection");

  // Arweave reads: `/raw/` on arweave.net first (the bare path redirects to a sandbox host the
  // collect page's CSP refuses), the Turbo gateway second. The on-chain `uri` is untouched.
  const { sha256: sha256Of } = await import("@noble/hashes/sha2.js");
  const { bytesToHex: hexOf } = await import("@noble/hashes/utils.js");
  const { arweaveBytes } = await import("../publications/rpc.ts");
  const realFetch = globalThis.fetch;
  const arweaveId = "A".repeat(43);
  const storedBytes = new TextEncoder().encode('{"name":"x"}');
  const gatewayRequests = [];
  try {
    globalThis.fetch = async url => {
      gatewayRequests.push(String(url));
      return new Response(storedBytes, { headers: { "content-length": String(storedBytes.length) } });
    };
    assert.deepEqual(await arweaveBytes(arweaveId, hexOf(sha256Of(storedBytes))), storedBytes);
    assert.deepEqual(gatewayRequests, [`https://arweave.net/raw/${arweaveId}`],
      "documents and images are read from arweave.net/raw/, which answers without a redirect");
    gatewayRequests.length = 0;
    globalThis.fetch = async url => {
      gatewayRequests.push(String(url));
      return String(url).startsWith("https://arweave.net/")
        ? new Response("", { status: 404 })
        : new Response(storedBytes, { headers: { "content-length": String(storedBytes.length) } });
    };
    assert.deepEqual(await arweaveBytes(arweaveId, hexOf(sha256Of(storedBytes))), storedBytes);
    assert.deepEqual(gatewayRequests, [`https://arweave.net/raw/${arweaveId}`, `https://turbo-gateway.com/raw/${arweaveId}`],
      "the Turbo gateway's /raw/ stays the fallback");
  } finally {
    globalThis.fetch = realFetch;
  }

  // The deployed-program check refuses publish, collect and buy unless the ProgramData bytes hash
  // to the pin and the upgrade authority is the recorded one. Headers every time; bytes per slot.
  const { assertProgramImage, assertReviewedProgram, PROGRAM_CHANGED } = await import("../publications/programImage.ts");
  const { CLUSTERS, TRUSTED, pinnedImage } = await import("../publications/deployments.ts");
  const loader = "BPFLoaderUpgradeab1e11111111111111111111111";
  const pinnedProgram = "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU";
  const recordedAuthority = "6r7wvBV2WR8L1GHJ1FV41j4JrqBxYfxQN3Xj7L2dPAuv";
  const [programDataKey] = await kit.getProgramDerivedAddress({
    programAddress: kit.address(loader), seeds: [kit.getAddressEncoder().encode(kit.address(pinnedProgram))] });
  const elf = new Uint8Array(300_000).map((_, i) => (i * 31 + 7) & 255);
  const image = { sha256: hexOf(sha256Of(elf)), bytes: elf.length, upgradeAuthority: recordedAuthority, source: "test" };
  const chain = {
    program: new Uint8Array([2, 0, 0, 0, ...kit.getAddressEncoder().encode(programDataKey)]),
    programOwner: loader, slot: 100n, authority: recordedAuthority, elf, space: undefined,
  };
  const programDataBytes = () => {
    const header = new Uint8Array(45);
    const view = new DataView(header.buffer);
    view.setUint32(0, 3, true);
    view.setBigUint64(4, chain.slot, true);
    if (chain.authority) {
      header[12] = 1;
      header.set(kit.getAddressEncoder().encode(kit.address(chain.authority)), 13);
    }
    return new Uint8Array([...header, ...chain.elf]);
  };
  const reads = { header: 0, bytes: 0 };
  const serveProgram = async (_url, options) => {
    const { method, params: [key, { dataSlice }] } = JSON.parse(options.body);
    assert.equal(method, "getAccountInfo");
    const data = key === pinnedProgram ? chain.program : key === programDataKey ? programDataBytes() : null;
    if (!data) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: null } }));
    if (key === programDataKey) reads[dataSlice.length === 45 ? "header" : "bytes"] += 1;
    const slice = data.slice(dataSlice.offset, dataSlice.offset + dataSlice.length);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: {
      owner: key === pinnedProgram ? chain.programOwner : loader, executable: key === pinnedProgram,
      lamports: 1, data: [Buffer.from(slice).toString("base64"), "base64"], space: chain.space ?? data.length } } }));
  };
  const endpoint = "https://rpc.test";
  const check = scope => assertProgramImage(endpoint, pinnedProgram, image, scope);
  const programRefused = new RegExp(PROGRAM_CHANGED.replace(/\./g, "\\."));
  try {
    globalThis.fetch = serveProgram;
    await check("a");
    assert.deepEqual(reads, { header: 1, bytes: 2 }, "the first check reads the header and the ELF in bounded slices");
    await check("a");
    assert.deepEqual(reads, { header: 2, bytes: 2 }, "the same deployment slot is not downloaded twice");
    chain.slot = 101n;
    await check("a");
    assert.deepEqual(reads, { header: 3, bytes: 4 }, "a new deployment slot is hashed again");
    chain.elf = elf.map((byte, i) => (i === 299_999 ? byte ^ 1 : byte));
    chain.slot = 102n;
    await assert.rejects(check("a"), programRefused, "replaced bytes refuse");
    chain.elf = elf;
    chain.authority = "11111111111111111111111111111112";
    const before = reads.bytes;
    await assert.rejects(check("a"), programRefused, "a different upgrade authority refuses");
    assert.equal(reads.bytes, before, "an authority mismatch is settled from the header alone");
    chain.authority = null;
    chain.slot = 103n;
    await check("a");
    chain.authority = recordedAuthority;
    chain.space = 45 + elf.length + 8;
    await assert.rejects(check("b"), programRefused, "a reported length that differs refuses without a download");
    chain.space = undefined;
    chain.programOwner = "BPFLoader2111111111111111111111111111111111";
    await assert.rejects(check("c"), programRefused, "a program under another loader refuses");
    chain.programOwner = loader;
    chain.program = new Uint8Array([2, 0, 0, 0, ...new Uint8Array(32)]);
    await assert.rejects(check("d"), programRefused, "a program account pointing elsewhere refuses");
    await assert.rejects(assertReviewedProgram(endpoint, pinnedProgram, "mainnet-beta"), programRefused,
      "a program with no record on the cluster refuses");
    globalThis.fetch = async () => new Response("", { status: 503 });
    await assert.rejects(check("e"), error => !programRefused.test(error.message),
      "an unreachable endpoint is a network failure, never a changed program");
  } finally {
    globalThis.fetch = realFetch;
  }
  {
    // Every path that asks a wallet to sign against the program checks it: each signing module
    // at quote and again before its wallet opens, and the collect page right before sending.
    const { readFileSync } = await import("node:fs");
    const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
    const calls = (text) => text.split("await assertReviewedProgram(").length - 1;
    assert.equal(calls(source("../src/prints/collect.ts")), 2, "collect and buy check at quote and before the wallet");
    assert.equal(calls(source("../src/prints/offer.ts")), 2, "set_offer checks at quote and before the wallet");
    assert.ok(calls(source("../src/prints/PrintSheet.tsx")) >= 1, "publish checks before the wallet");
    const page = source("../site/collect/page.ts");
    assert.ok(page.indexOf("await adapter.assertProgram();") > 0 &&
      page.indexOf("await adapter.assertProgram();") < page.indexOf("p.signature = await connection.send("),
      "the collect page checks the program again right before the wallet opens");
    assert.match(source("../site/collect/core.ts"), /assertProgram: \(\) => assertReviewedProgram\(/);
  }
  for (const cluster of CLUSTERS)
    for (const program of TRUSTED[cluster]) {
      const record = pinnedImage(program, cluster);
      assert.ok(record && /^[0-9a-f]{64}$/.test(record.sha256) && record.bytes > 0 &&
        (record.upgradeAuthority === null || kit.isAddress(record.upgradeAuthority)),
        `${cluster} ${program} is trusted, so it needs a digest, a length and an upgrade authority`);
    }

  // Send: only FreezeDelegate blocks a transfer. A burn's tombstone reads as burned before and
  // after Core's `collect` sweeps its fees and hands the one-byte account to the System program.
  const protocol = await import("../publications/core/protocol.ts");
  const withPlugin = (plugin, frozen) => ({ plugins: [{ type: "OwnerManaged", plugin, authority: { kind: "Owner" }, frozen }] });
  assert.equal(protocol.isFrozen(withPlugin("FreezeExecute", true)), false, "FreezeExecute blocks Execute, never Transfer");
  assert.equal(protocol.isFrozen(withPlugin("FreezeDelegate", true)), true);
  assert.equal(protocol.isFrozen(withPlugin("FreezeDelegate", false)), false);
  const tombstone = (owner, bytes) => ({ owner, executable: false, data: ["", "base64"], bytes: new Uint8Array(bytes) });
  assert.equal(protocol.isBurnedPrintAccount(tombstone(protocol.MPL_CORE, [0])), true);
  assert.equal(protocol.isBurnedPrintAccount(tombstone(protocol.SYSTEM_PROGRAM, [0])), true, "a swept tombstone is still a burn");
  for (const [owner, bytes] of [[protocol.SYSTEM_PROGRAM, []], [protocol.SYSTEM_PROGRAM, [1]], [protocol.SYSTEM_PROGRAM, [0, 0]],
    ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", [0]]])
    assert.equal(protocol.isBurnedPrintAccount(tombstone(owner, bytes)), false);
  assert.equal(protocol.isBurnedPrintAccount(null), false);
  const creator = "BSuFrMcYhSKS5dkprGtC17nVbP4VSFNvZzncnRtkVLpT";
  const nonce = "d2ebdf80988d559aaf5bd5c405f3fd314bee061eaac0add45b50ae6c16147954";
  const issued = { program: pinnedProgram, state: { creator, nonce, minted: 2, uri: "https://arweave.net/" + arweaveId } };
  let heldAccount = { owner: protocol.SYSTEM_PROGRAM, bytes: [0] };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 },
      value: heldAccount && { owner: heldAccount.owner, executable: false, lamports: 897_840, space: heldAccount.bytes.length,
        data: [Buffer.from(heldAccount.bytes).toString("base64"), "base64"] } } }));
    assert.equal((await protocol.readPrintState(endpoint, issued, 2)).status, "burned", "an issued print swept by Core reads as burned");
    assert.equal((await protocol.readPrintState(endpoint, issued, 3)).status, "unavailable", "an unissued number proves nothing");
    heldAccount = { owner: protocol.SYSTEM_PROGRAM, bytes: [] };
    assert.equal((await protocol.readPrintState(endpoint, issued, 2)).status, "unavailable");
    heldAccount = { owner: protocol.SYSTEM_PROGRAM, bytes: [0] };
    const { inspectTransfer } = await import("../publications/core/transfer.ts");
    const keys = await protocol.addresses(pinnedProgram, creator, nonce);
    await assert.rejects(inspectTransfer(endpoint, { program: pinnedProgram, creator, nonce, edition: keys.edition, collection: keys.collection },
      arweaveId, recordedAuthority, creator), /burned/, "Send says burned, not unavailable, after the sweep");
  } finally {
    globalThis.fetch = realFetch;
  }

  // Send, for any copy: the gate print #1 has, on a collected copy #3, and one durable attempt per
  // asset. The real src/prints/transfer.ts, with the build's cluster, AsyncStorage and the photo
  // draft's `isSigned` replaced. An `AssetV1` as Core lays it out: key, owner, the collection as
  // update authority, name, uri, no `seq`, the plugin header, the blobs, then the registry, last.
  {
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
    const text = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
    const key = (a) => Buffer.from(kit.getAddressEncoder().encode(kit.address(a)));
    const title = "Sample", collector = recordedAuthority, program = TRUSTED.devnet[0];
    const keys = await protocol.addresses(program, creator, "ef".repeat(32));
    const edition = { cluster: "devnet", program, creator, nonce: "ef".repeat(32), edition: keys.edition,
      collection: keys.collection, title, supply: 5 };
    const at = {};
    for (const number of [1, 2, 3]) at[number] = (await protocol.addresses(program, creator, edition.nonce, number)).print;
    // [type, authority (0 None, 1 Owner), blob]: Edition, ImmutableMetadata, and a FreezeDelegate.
    const coreAsset = (owner, number, frozen = null) => {
      const base = Buffer.concat([Buffer.from([1]), key(owner), Buffer.from([2]), key(keys.collection),
        text(`${title} #${number}`), text(`https://arweave.net/${arweaveId}`), Buffer.from([0])]);
      const plugins = [[9, 0, Buffer.concat([Buffer.from([9]), u32(number)])], [12, 0, Buffer.from([12])],
        ...(frozen === null ? [] : [[1, 1, Buffer.from([1, frozen ? 1 : 0])]])];
      let offset = base.length + 9;
      const records = plugins.map(([type, authority, blob]) => {
        const record = Buffer.concat([Buffer.from([type, authority]), u64(offset)]);
        offset += blob.length;
        return record;
      });
      return Buffer.concat([base, Buffer.from([3]), u64(offset), ...plugins.map(([, , blob]) => blob),
        Buffer.from([4]), u32(records.length), ...records, u32(0)]);
    };
    const chain = new Map(), rpc = { height: 100, balance: 1_000_000_000 }, context = { slot: 100 };
    const answer = (method, [first]) => {
      switch (method) {
        case "getAccountInfo": {
          const bytes = chain.get(first);
          return { context, value: bytes ? { owner: protocol.MPL_CORE, executable: false, lamports: 3_000_000,
            space: bytes.length, data: [bytes.toString("base64"), "base64"] } : null };
        }
        case "getBlockHeight": return rpc.height;
        case "getSignaturesForAddress": return [];
        case "getLatestBlockhash": return { context, value: { blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 200 } };
        case "simulateTransaction": return { context, value: { err: null, logs: [], unitsConsumed: 20_000, returnData: null,
          accounts: [{ lamports: rpc.balance - 5_000, owner: "11111111111111111111111111111111", executable: false,
            rentEpoch: 0, space: 0, data: ["", "base64"] }] } };
        case "getRecentPrioritizationFees": return [];
        case "getFeeForMessage": return { context, value: 5_000 };
        case "getBalance": return { context, value: rpc.balance };
        default: throw new Error(`a send is not expected to call ${method}`);
      }
    };
    const require = createRequire(import.meta.url);
    const storage = { items: new Map(), reads: 0 };
    const AsyncStorage = {
      getItem: async (key) => { storage.reads++; return storage.items.get(key) ?? null; },
      setItem: async (key, value) => { storage.items.set(key, value); },
      removeItem: async (key) => { storage.items.delete(key); },
    };
    const mocks = [
      mock.module(new URL("../src/solana/cluster.ts", import.meta.url).href, { namedExports: {
        CLUSTER_NAME: "devnet", RPC_ENDPOINT: endpoint, assertEndpointCluster: async () => {} } }),
      mock.module(pathToFileURL(require.resolve("@react-native-async-storage/async-storage")).href,
        { defaultExport: AsyncStorage }),
      // creator.ts loads React Native; the photo path needs only its `isSigned`, and coordinator.ts its `readDraft`.
      mock.module(new URL("../src/prints/creator.ts", import.meta.url).href, { namedExports: {
        isSigned: async () => true, readDraft: async () => null } }),
    ];
    try {
      globalThis.fetch = async (_url, options) => {
        const { id, method, params } = JSON.parse(options.body);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: answer(method, params) }),
          { headers: { "Content-Type": "application/json" } });
      };
      const { inspectTransfer } = await import("../publications/core/transfer.ts");
      const gate = (recipient, owner) => inspectTransfer(endpoint, edition, arweaveId, recipient, owner, 3);
      chain.set(at[3], coreAsset(collector, 3));
      assert.deepEqual(await gate(creator, collector), { owner: collector, recipient: creator, asset: at[3], collection: keys.collection },
        "the wallet holding a collected copy can send it");
      await assert.rejects(gate(collector, collector), /different wallet/, "not to itself");
      await assert.rejects(gate(keys.edition, collector), /personal Solana wallet/, "not to the edition PDA");
      await assert.rejects(gate(collector, creator), /does not currently own/, "not by a wallet that does not hold it");
      chain.set(at[3], coreAsset(collector, 3, true));
      await assert.rejects(gate(creator, collector), /frozen/, "not while frozen");
      chain.set(at[3], coreAsset(collector, 3, false));
      assert.equal((await gate(creator, collector)).asset, at[3], "a lifted freeze sends");
      chain.set(at[3], Buffer.from([0]));
      await assert.rejects(gate(creator, collector), /burned/, "not once burned");
      chain.set(at[3], coreAsset(collector, 1));
      await assert.rejects(gate(creator, collector), /edition format/, "copy #1's asset read as copy #3 is refused");
      chain.set(at[3], coreAsset(collector, 3));

      const transfer = await import("../src/prints/transfer.ts");
      const { exclusive } = require("../publications/lifecycle.ts");
      const { CORE_PROTOCOL } = await import("../publications/types.ts");
      // The WALLET screen: Send only for a copy this wallet was read holding.
      const publication = { state: { uri: `https://arweave.net/${arweaveId}` } };
      const item = (number, owner) => ({ id: at[number], number, owner, imageUri: "", photo: { edition, publication } });
      const copy3 = transfer.heldCopy(item(3, collector), collector);
      assert.deepEqual(copy3, { edition, metadataId: arweaveId, number: 3, asset: at[3], holder: collector });
      assert.equal(transfer.heldCopy(item(3, collector), creator), null, "never for somebody else's copy");
      assert.equal(transfer.heldCopy(item(3, collector), undefined), null, "nor with no wallet connected");
      assert.equal(transfer.heldCopy({ ...item(3), number: undefined }, collector), null, "an edition under Published is no copy");
      assert.equal((await transfer.getTransferState({ ...copy3, asset: at[2] })).status, "unavailable",
        "an asset that is not the copy's own is refused");

      const copyKey = `es.core-copy-transfer.v1:devnet:${at[3]}`;
      const session = (sign) => ({ connectAnd: async (work) => work({ signAndSendTransactions: sign }),
        authorizeSession: async () => ({ address: collector }) });
      await assert.rejects(transfer.prepareTransfer(copy3, creator, creator), /wallet that holds this copy/);
      const quote = await transfer.prepareTransfer(copy3, creator, collector);
      assert.deepEqual([quote.asset, quote.owner, quote.recipient], [at[3], collector, creator]);
      let release;
      const held = exclusive(`transfer:devnet:${at[3]}`, () => new Promise((done) => { release = done; }));
      await assert.rejects(transfer.prepareTransfer(copy3, creator, collector), /in progress/, "one operation per copy");
      release();
      await held;
      // What the review saw is read again right before the wallet opens.
      let opened = 0;
      const watching = { connectAnd: async () => { opened++; }, authorizeSession: async () => ({ address: collector }) };
      for (const [account, bytes, refusal] of [[at[3], coreAsset(collector, 3, true), /frozen/],
        [at[3], coreAsset(creator, 3), /does not currently own/], [at[3], Buffer.from([0]), /burned/],
        [creator, Buffer.from([1]), /not a personal wallet/]]) {
        const before = chain.get(account);
        chain.set(account, bytes);
        await assert.rejects(transfer.sendTransfer(copy3, watching, quote), refusal);
        if (before) chain.set(account, before); else chain.delete(account);
      }
      assert.deepEqual([opened, storage.items.size], [0, 0], "each refused before the wallet opens, nothing saved");
      // A decline sends nothing, and forgets the attempt it saved.
      await assert.rejects(transfer.sendTransfer(copy3, session(async () => { throw refused; }), quote), (error) => error === refused);
      assert.ok(storage.reads > 0, "the send must be reading the fake storage");
      assert.equal(storage.items.size, 0, "a refused send leaves no attempt");
      // A wallet that never answers may have sent it: the attempt stays, under the copy's own key...
      await assert.rejects(transfer.sendTransfer(copy3, session(async () => { throw new Error("Timed out waiting for response"); }), quote),
        /Timed out/);
      assert.deepEqual([...storage.items.keys()], [copyKey]);
      const saved = JSON.parse(storage.items.get(copyKey));
      assert.deepEqual([saved.owner, saved.recipient, saved.asset, saved.lastValidBlockHeight], [collector, creator, at[3], "200"]);
      // ...and is what the next start reads: it may still land, so no new review until it cannot.
      const pending = await transfer.getTransferState(copy3);
      assert.deepEqual([pending.status, pending.eligibility, pending.attempt?.quoteId], ["pending", "wait", saved.quoteId]);
      await assert.rejects(transfer.prepareTransfer(copy3, creator, collector), /may still land/);
      assert.equal((await transfer.getTransferState(transfer.heldCopy(item(2, collector), collector))).status, "none",
        "a sibling copy keeps its own record");
      // A copy handed over from another wallet on this phone: that wallet's settled send does not
      // stop the holder, one that may still land does.
      const handed = { ...saved, owner: creator, recipient: collector, lastValidBlockHeight: "10" };
      storage.items.set(copyKey, JSON.stringify(handed));
      assert.equal((await transfer.getTransferState(copy3)).status, "none");
      storage.items.set(copyKey, JSON.stringify({ ...handed, lastValidBlockHeight: "150" }));
      assert.equal((await transfer.getTransferState(copy3)).status, "pending");

      // The photo page, unchanged: print #1's attempt stays per edition, as saved before this build,
      // and the WALLET screen's print #1 reads the same record.
      const record = { baseName: "IMG_0001" };
      const draft = { edition, metadataId: arweaveId, imagePath: "" };
      const photo = transfer.photoTransfer(record, draft);
      const editionKey = `es.core-transfer.v1:devnet:${keys.edition}`;
      const earlier = { version: 1, protocol: CORE_PROTOCOL, owner: creator, recipient: collector, asset: at[1],
        quoteId: "b".repeat(64), lastValidBlockHeight: "150" };
      storage.items.set(editionKey, JSON.stringify(earlier));
      for (const target of [photo, transfer.heldCopy(item(1, creator), creator)]) {
        const state = await transfer.getTransferState(target);
        assert.deepEqual([state.status, state.eligibility, state.attempt?.quoteId], ["pending", "wait", earlier.quoteId]);
      }
      storage.items.set(editionKey, JSON.stringify({ ...earlier, lastValidBlockHeight: "10" }));
      assert.equal((await transfer.getTransferState(photo)).status, "unresolved", "the photo page's own expired send stays on record");
      // Both locks hold print #1: the photograph's, which publishing shares, and the asset's.
      for (const lock of [`publication:devnet:${record.baseName}`, `transfer:devnet:${at[1]}`]) {
        const busy = exclusive(lock, () => new Promise((done) => { release = done; }));
        await assert.rejects(transfer.prepareTransfer(photo, collector, creator), /in progress/, lock);
        release();
        await busy;
      }
      // A photo page send takes both, so the WALLET screen cannot start one on the same print.
      storage.items.delete(editionKey);
      chain.set(at[1], coreAsset(creator, 1));
      const photoQuote = await transfer.prepareTransfer(photo, collector, creator);
      let approve;
      const approving = transfer.sendTransfer(photo, { authorizeSession: async () => ({ address: creator }),
        connectAnd: async (work) => { await new Promise((done) => { approve = done; });
          return work({ signAndSendTransactions: async () => { throw refused; } }); } }, photoQuote);
      while (!approve) await new Promise((next) => setImmediate(next));
      await assert.rejects(transfer.prepareTransfer(transfer.heldCopy(item(1, creator), creator), collector, creator),
        /in progress/, "print #1 on the WALLET screen waits for the photo page's send");
      approve();
      await assert.rejects(approving, (error) => error === refused);
      assert.equal(storage.items.has(editionKey), false);
      await transfer.forgetTransferAttempt(draft);
      assert.equal(storage.items.has(editionKey), false, "deleting the photograph forgets its print #1 attempt");
      assert.ok(storage.items.has(copyKey), "and no other copy's");
    } finally {
      globalThis.fetch = realFetch;
      for (const one of mocks) one.restore();
    }
  }

  // `Edition` in the owning program's layout: 8 + 293 bytes on the deployments that predate
  // `published_at`, 8 + 301 with it right after `bump`, 8 + 302 with `seeker_only` at byte 181.
  // Any other length is refused, whichever it is.
  {
    const { getAddressDecoder, getAddressEncoder } = await import("@solana/kit");
    const { LEGACY_WITHOUT_PUBLISHED_AT, LEGACY_WITHOUT_ROYALTIES_AND_SEEKER_ONLY, programFeatures } =
      await import("../publications/deployments.ts");
    const { EDITION_ACCOUNT_BYTES, PUBLISHED_AT_EDITION_ACCOUNT_BYTES, LEGACY_EDITION_ACCOUNT_BYTES } =
      await import("../publications/rpc.ts");
    const recording = getAddressDecoder().decode(new Uint8Array(32).fill(7));
    const timedOnly = LEGACY_WITHOUT_ROYALTIES_AND_SEEKER_ONLY[0];
    const legacy = LEGACY_WITHOUT_PUBLISHED_AT[0];
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    // `flag` is the `seeker_only` byte, absent when null.
    const editionAccount = (time, flag = null) => {
      const uri = Buffer.from(`https://arweave.net/${arweaveId}`);
      const at = time === null ? Buffer.alloc(0) : Buffer.alloc(8);
      if (time !== null) at.writeBigInt64LE(time);
      const seeker = flag === null ? Buffer.alloc(0) : Buffer.from([flag]);
      const body = Buffer.concat([Buffer.from(sha256Of(Buffer.from("account:Edition"))).subarray(0, 8),
        Buffer.from(getAddressEncoder().encode(creator)), Buffer.from(nonce, "hex"), Buffer.alloc(32, 3),
        Buffer.alloc(64, 4), Buffer.from([2, 0, 1, 0, 255]), at, seeker, u32(5), Buffer.from("Title"), u32(uri.length), uri]);
      return new Uint8Array(Buffer.concat([body, Buffer.alloc((time === null ? 301 : flag === null ? 309 : 310) - body.length)]));
    };
    assert.deepEqual([...editionAccount(1n, 1).subarray(173, 186)], [1, 0, 0, 0, 0, 0, 0, 0, 1, 5, 0, 0, 0],
      "published_at at 173, seeker_only at 181, the title at 182");
    assert.equal(programFeatures(legacy).publishedAt, false);
    assert.deepEqual([programFeatures(timedOnly).publishedAt, programFeatures(timedOnly).royaltiesAndSeekerOnly], [true, false]);
    assert.equal(programFeatures(recording).publishedAt, true, "a deployment added later records the time unlisted");
    assert.equal(programFeatures(recording).royaltiesAndSeekerOnly, true, "and seals royalties and Seeker-only unlisted");
    assert.deepEqual([legacy, timedOnly, recording].map(protocol.editionAccountBytes),
      [LEGACY_EDITION_ACCOUNT_BYTES, PUBLISHED_AT_EDITION_ACCOUNT_BYTES, EDITION_ACCOUNT_BYTES]);
    assert.deepEqual([LEGACY_EDITION_ACCOUNT_BYTES, PUBLISHED_AT_EDITION_ACCOUNT_BYTES, EDITION_ACCOUNT_BYTES], [301, 309, 310]);
    const open = protocol.readEdition(editionAccount(1_790_000_000n, 0), recording);
    const seekerOnly = protocol.readEdition(editionAccount(1_790_000_000n, 1), recording);
    const timed = protocol.readEdition(editionAccount(1_790_000_000n), timedOnly);
    const untimed = protocol.readEdition(editionAccount(null), legacy);
    assert.deepEqual([open, seekerOnly, timed, untimed].map((e) => e.publishedAt), [1_790_000_000, 1_790_000_000, 1_790_000_000, null]);
    assert.deepEqual([open, seekerOnly, timed, untimed].map((e) => e.seekerOnly), [false, true, false, false]);
    const terms = ({ publishedAt: _at, seekerOnly: _only, ...rest }) => rest;
    for (const other of [seekerOnly, timed, untimed])
      assert.deepEqual(terms(other), terms(open), "every other field reads the same in all three layouts");
    assert.equal(open.title, "Title");
    assert.equal(open.creator, creator);
    for (const [bytes, program] of [[editionAccount(null), recording], [editionAccount(1n), recording],
      [editionAccount(null), timedOnly], [editionAccount(1n, 0), timedOnly], [editionAccount(1n), legacy], [editionAccount(1n, 0), legacy]])
      assert.throws(() => protocol.readEdition(bytes, program), /Unsupported edition account/);
    assert.throws(() => protocol.readEdition(editionAccount(1n, 2), recording), /Invalid edition state/, "a bool is 0 or 1");
    assert.throws(() => protocol.readEdition(editionAccount(0n, 0), recording), /Invalid edition state/);
    assert.throws(() => protocol.readEdition(editionAccount(0n), timedOnly), /Invalid edition state/);
    assert.throws(() => protocol.readEdition(new Uint8Array([...editionAccount(1n, 0), 0]), recording), /Unsupported edition account/);
  }

  // A mainnet release needs its own RPC: unset, or a public solana.com host, fails release:check.
  const { genesisRefusal, refusedEnvFiles, rpcRefusal } = await import("./check-release-config.ts");
  for (const value of [undefined, "", " "])
    assert.match(rpcRefusal("mainnet-beta", value), /not set/);
  for (const value of ["https://api.mainnet.solana.com", "https://api.mainnet-beta.solana.com/", "https://API.Mainnet.Solana.com./"])
    assert.match(rpcRefusal("mainnet-beta", value), /public solana\.com endpoint/);
  assert.match(rpcRefusal("mainnet-beta", "http://rpc.example.com"), /https/);
  assert.equal(rpcRefusal("mainnet-beta", "https://notsolana.com"), null);
  assert.equal(rpcRefusal("mainnet-beta", "https://rpc.example.com/solana"), null, "a key-free proxy path");
  assert.equal(rpcRefusal("devnet", undefined), null, "a devnet build may use the public devnet endpoint");
  // Expo bundles EXPO_PUBLIC_* in plain text: a query string or credentials would ship in the APK.
  for (const cluster of ["mainnet-beta", "devnet"])
    for (const value of ["https://rpc.example.com/?api-key=SECRET", "https://rpc.example.com?SECRET",
      "https://SECRET@rpc.example.com", "https://user:SECRET@rpc.example.com/"]) {
      const refusal = rpcRefusal(cluster, value);
      assert.match(refusal, /credentials or a query string/, `${cluster} ${value}`);
      assert.ok(!refusal.includes("SECRET"), "the refusal never repeats a value that can carry a provider key");
    }
  assert.match(rpcRefusal("devnet", "http://rpc.example.com"), /https/, "the app refuses http at start-up on any cluster");
  assert.ok(!rpcRefusal("mainnet-beta", "https://api.mainnet.solana.com/SECRET").includes("SECRET"));

  // The endpoint's own chain, asked before the build: getGenesisHash, never repeating the URL.
  {
    const realFetch = globalThis.fetch;
    const URL_SECRET = "https://rpc.example.com/SECRET";
    let asked = [];
    const answering = (answer) => async (url, init) => {
      asked.push({ url: String(url), method: init?.method, body: JSON.parse(init?.body) });
      return answer();
    };
    const hash = (result) => answering(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result })));
    try {
      globalThis.fetch = hash("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
      assert.equal(await genesisRefusal("mainnet-beta", URL_SECRET), null);
      assert.deepEqual(asked, [{ url: URL_SECRET, method: "POST", body: { jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] } }]);
      assert.match(await genesisRefusal("devnet", URL_SECRET), /not on devnet \(genesis 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d, expected EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG\)/,
        "a devnet test build pointed at mainnet would spend real SOL");
      globalThis.fetch = hash("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
      assert.equal(await genesisRefusal("devnet", URL_SECRET), null);
      assert.match(await genesisRefusal("mainnet-beta", URL_SECRET), /not on mainnet-beta \(genesis EtWT/);
      const refusals = [];
      globalThis.fetch = hash(URL_SECRET);
      refusals.push(await genesisRefusal("mainnet-beta", URL_SECRET));
      assert.match(refusals[0], /genesis none/);
      globalThis.fetch = answering(() => new Response(`upstream ${URL_SECRET} failed`, { status: 502 }));
      refusals.push(await genesisRefusal("mainnet-beta", URL_SECRET));
      assert.match(refusals[1], /HTTP 502/);
      globalThis.fetch = answering(() => { throw new TypeError(`Failed to parse URL from ${URL_SECRET}`); });
      refusals.push(await genesisRefusal("mainnet-beta", URL_SECRET));
      assert.match(refusals[2], /did not answer getGenesisHash/);
      globalThis.fetch = answering(() => new Response("<html>", { status: 200 }));
      refusals.push(await genesisRefusal("mainnet-beta", URL_SECRET));
      assert.ok(refusals.every((refusal) => refusal && !refusal.includes("SECRET")), "no refusal repeats the URL");
      asked = [];
      assert.equal(await genesisRefusal("devnet", undefined), null);
      assert.equal(asked.length, 0, "no URL, nothing to ask: the app uses the public devnet endpoint");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // Every env file a production bundle loads (@expo/env's getFiles), and any other .local one.
  const { getEnvFiles } = await import("@expo/env");
  const envNames = [".env", ".env.local", ".env.production", ".env.production.local", ".env.development",
    ".env.development.local", ".env.test", ".env.example", ".envrc", "env.local", ".env.local.bak"];
  assert.deepEqual(refusedEnvFiles(envNames),
    [".env", ".env.development.local", ".env.local", ".env.production", ".env.production.local"]);
  const production = getEnvFiles({ mode: "production", silent: true });
  assert.equal(production.length, 4);
  assert.deepEqual(refusedEnvFiles(production), [...production].sort(),
    "the gate refuses every file Expo loads for a production export");
  const { readFileSync, readdirSync } = await import("node:fs");

  {
    // release:apk, around Gradle: the same env files refused again, and the bundle in the APK
    // proven this build's, against a synthetic zip laid out as an APK is.
    const artifact = await import("./release-artifact.mjs");
    assert.deepEqual(artifact.refusedEnvFiles(envNames), refusedEnvFiles(envNames), "release:apk refuses what the gate refuses");
    const { crc32, deflateRawSync } = await import("node:zlib");
    const zipOf = (entries, { junk = Buffer.alloc(0), comment = "", count } = {}) => {
      const locals = [], directory = [];
      let offset = 0;
      for (const { name, data, deflate = false, pad = 0, flags = 0 } of entries) {
        const body = deflate ? deflateRawSync(data) : data;
        const title = Buffer.from(name);
        const local = Buffer.alloc(30), entry = Buffer.alloc(46);
        local.writeUInt32LE(0x04034b50, 0);
        entry.writeUInt32LE(0x02014b50, 0);
        for (const [header, at] of [[local, 6], [entry, 8]]) {
          header.writeUInt16LE(flags, at);
          header.writeUInt16LE(deflate ? 8 : 0, at + 2);
          header.writeUInt32LE(crc32(data), at + 8);
          header.writeUInt32LE(body.length, at + 12);
          header.writeUInt32LE(data.length, at + 16);
          header.writeUInt16LE(title.length, at + 20);
        }
        // zipalign pads the local extra field only.
        local.writeUInt16LE(pad, 28);
        entry.writeUInt32LE(offset, 42);
        locals.push(local, title, Buffer.alloc(pad), body);
        directory.push(entry, title);
        offset += 30 + title.length + pad + body.length;
      }
      const central = Buffer.concat(directory), end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(count ?? entries.length, 8);
      end.writeUInt16LE(count ?? entries.length, 10);
      end.writeUInt32LE(central.length, 12);
      end.writeUInt32LE(offset + junk.length, 16);
      end.writeUInt16LE(Buffer.byteLength(comment), 20);
      return Buffer.concat([...locals, junk, central, end, Buffer.from(comment)]);
    };
    const NONCE = "9f0c2a7d41be8e35c6d0a1f47b2e9c58";
    const RPC = "https://rpc.example.com/solana";
    const PAYER = "BSuFrMcYhSKS5dkprGtC17nVbP4VSFNvZzncnRtkVLpT";
    // Hermes bytecode keeps each ASCII literal as its own bytes among binary ones.
    const hermes = (...literals) => Buffer.concat([Buffer.from([0xc6, 0x1f, 0xbc, 0x03]), ...literals.map((s) => Buffer.concat([Buffer.from(s), Buffer.from([0])])), Buffer.alloc(4096, 7)]);
    const bundle = hermes(NONCE, RPC, "https://api.mainnet.solana.com");
    const manifest = Buffer.from("<manifest/>");
    const apk = zipOf([
      { name: "AndroidManifest.xml", data: manifest },
      { name: "assets/index.android.bundle", data: bundle, deflate: true, pad: 3 },
      { name: "classes.dex", data: Buffer.alloc(100, 1), deflate: true },
    ], { junk: Buffer.concat([Buffer.alloc(16), Buffer.from("APK Sig Block 42")]), comment: "signed" });
    assert.ok(artifact.readZipEntry(apk, "assets/index.android.bundle").equals(bundle), "a deflated, padded entry past other entries");
    assert.ok(artifact.readZipEntry(apk, "AndroidManifest.xml").equals(manifest), "a stored entry");
    assert.equal(artifact.readZipEntry(apk, "assets/other.bundle"), null);
    const tampered = Buffer.from(zipOf([{ name: "assets/index.android.bundle", data: bundle }]));
    tampered[30 + "assets/index.android.bundle".length + 5] ^= 1;
    assert.throws(() => artifact.readZipEntry(tampered, "assets/index.android.bundle"), /checksum/);
    assert.throws(() => artifact.readZipEntry(zipOf([{ name: "a", data: bundle, flags: 1 }]), "a"), /encrypted/);
    assert.throws(() => artifact.readZipEntry(zipOf([{ name: "a", data: bundle }], { count: 0xffff }), "a"), /zip64/);
    assert.throws(() => artifact.readZipEntry(Buffer.from("not a zip at all, just text"), "a"), /not a zip/);
    assert.throws(() => artifact.readZipEntry(apk.subarray(0, apk.length - 1), "a"), /not a zip/, "a cut-off end record");

    const refusal = (bytes, env) => artifact.bundleRefusal(artifact.readZipEntry(zipOf([{ name: "b", data: bytes, deflate: true }]), "b"), env);
    assert.equal(refusal(bundle, { nonce: NONCE, cluster: "mainnet-beta", rpcUrl: RPC, devnetPayer: PAYER }), null);
    assert.equal(refusal(bundle, { nonce: NONCE, cluster: "mainnet-beta", rpcUrl: undefined }), null, "no RPC URL, nothing to find");
    assert.match(refusal(hermes(RPC), { nonce: NONCE, cluster: "mainnet-beta", rpcUrl: RPC }), /not this build's/,
      "a bundle Gradle kept from an earlier build");
    assert.match(refusal(bundle, { nonce: undefined, cluster: "mainnet-beta" }), /not this build's/);
    const otherRpc = refusal(hermes(NONCE, "https://old.example.com/solana"), { nonce: NONCE, cluster: "mainnet-beta", rpcUrl: RPC });
    assert.match(otherRpc, /EXPO_PUBLIC_SOLANA_RPC_URL/);
    assert.ok(!otherRpc.includes("example.com"), "the URL is never repeated");
    const withPayer = hermes(NONCE, RPC, PAYER);
    assert.match(refusal(withPayer, { nonce: NONCE, cluster: "mainnet-beta", rpcUrl: RPC, devnetPayer: PAYER }), /EXPO_PUBLIC_DEVNET_TEST_PAYER/);
    assert.equal(refusal(withPayer, { nonce: NONCE, cluster: "devnet", rpcUrl: RPC, devnetPayer: PAYER }), null, "a devnet session's build carries it");

    // Metro inlines only a literal `process.env.NAME`, and the app always bundles cluster.ts.
    const cluster = readFileSync(new URL("../src/solana/cluster.ts", import.meta.url), "utf8");
    assert.match(cluster, /^export const BUILD_NONCE = process\.env\.EXPO_PUBLIC_BUILD_NONCE;$/m);
    assert.match(readFileSync(new URL("../App.tsx", import.meta.url), "utf8"), /from "\.\/src\/solana\/cluster";/);
    const release = readFileSync(new URL("./release-apk.mjs", import.meta.url), "utf8");
    const at = (text) => release.indexOf(text);
    assert.ok(at("refusedEnvFiles(readdirSync(root))") > at("check-release-config.ts")
      && at('for (const kind of ["assets", "res"])') > at("refusedEnvFiles(readdirSync(root))")
      && at('rmSync(resolve(android, "app", "build", "generated", kind, "react", "release"), { recursive: true, force: true });') > 0
      && at("env: { ...process.env, EXPO_PUBLIC_BUILD_NONCE: nonce },") > at('for (const kind of ["assets", "res"])')
      && at('readZipEntry(readFileSync(APK), "assets/index.android.bundle")') > at(":app:assembleRelease")
      && at("bundleRefusal(bundle, {") > at(":app:assembleRelease")
      && at("rmSync(APK, { force: true });\n  process.exit(1);\n}") > at("bundleRefusal(bundle, {"),
      "release:apk refuses env files, removes the bundle outputs and sets the nonce before Gradle, and checks the APK after it");
  }
  assert.match(readFileSync(new URL("../src/solana/cluster.ts", import.meta.url), "utf8"),
    /PUBLIC_MAINNET_ENDPOINT = "https:\/\/api\.mainnet\.solana\.com"/,
    "the public fallback is the host https://solana.com/docs/references/clusters names");
  {
    // The README names exactly the Solana methods the app calls, read from the code: a request's
    // method string or a Kit client call. Devnet and deploy tooling (`src/dev/`, `publications/devnet/`,
    // `publications/deploy/`, `publications/mainnet/`) is not the app.
    const root = new URL("../", import.meta.url);
    const known = readdirSync(new URL("node_modules/@solana/rpc-api/dist/types/", root))
      .filter((file) => /^[a-z]\w+\.d\.ts$/.test(file) && file !== "index.d.ts").map((file) => file.slice(0, -".d.ts".length));
    const app = ["src", "publications"].flatMap((dir) => readdirSync(new URL(`${dir}/`, root), { recursive: true })
      .filter((file) => /\.tsx?$/.test(file) && !/^(dev|devnet|deploy|mainnet)[\\/]/.test(file))
      .map((file) => readFileSync(new URL(`${dir}/${file.replace(/\\/g, "/")}`, root), "utf8")))
      .concat(readFileSync(new URL("App.tsx", root), "utf8")).join("\n");
    const called = known.filter((method) => app.includes(`"${method}"`) || app.includes(`.${method}(`)).sort();
    const readme = readFileSync(new URL("README.md", root), "utf8");
    const bullet = /`EXPO_PUBLIC_SOLANA_RPC_URL` at a\s+key-free[\s\S]*?\n- /.exec(readme)?.[0] ?? "";
    assert.deepEqual([...bullet.matchAll(/`(\w+)`/g)].map((m) => m[1]).filter((name) => known.includes(name)).sort(), called,
      "README's RPC line lists every method the app calls");
    assert.ok(called.includes("getProgramAccounts") && called.includes("getMultipleAccounts") && !called.includes("sendTransaction"));

    // The program pin is the deployed ProgramData tail, as MAINNET.md step 9 says to read it.
    const mainnet = readFileSync(new URL("programs/editions/MAINNET.md", root), "utf8").replace(/\s+/g, " ");
    const image = readFileSync(new URL("publications/programImage.ts", root), "utf8");
    assert.match(mainnet, /`bytes` is the account's space − 45 and `sha256` is the SHA-256 of everything after its 45-byte header/);
    assert.match(mainnet, /On a first deploy assert space == 45 \+ the step 6 ELF's size/);
    assert.ok(image.includes("const PROGRAM_DATA_HEADER = 45;") && image.includes("const length = PROGRAM_DATA_HEADER + image.bytes;")
      && image.includes("sha256(data.subarray(PROGRAM_DATA_HEADER))"), "programImage.ts hashes the whole tail at space − 45");
  }

  {
    // The price floor is the cluster's rent-exempt minimum for an empty account, read, never kept.
    const { checkPriceMinimum, minimumPriceLamports } = await import("../src/prints/price.ts");
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (_url, options) => {
        const { method, params } = JSON.parse(options.body);
        assert.equal(method, "getMinimumBalanceForRentExemption");
        assert.deepEqual(params, [0]);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 650_240 }));
      };
      assert.equal(await minimumPriceLamports("https://rpc.example"), 650_240n);
      globalThis.fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: -1 }));
      await assert.rejects(minimumPriceLamports("https://rpc.example"), /Invalid Solana response/);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(checkPriceMinimum(0n, 650_240n), 0n, "free is always allowed");
    assert.equal(checkPriceMinimum(650_240n, 650_240n), 650_240n);
    assert.throws(() => checkPriceMinimum(650_239n, 650_240n), /The lowest price is 0\.00065024 SOL\./);

    // Every EditionError the IDL declares has the app's own words, and 6008 to 6012 are final.
    const { describeProgramError } = await import("../publications/rpc.ts");
    const idl = JSON.parse(readFileSync(new URL("../programs/editions/idl.json", import.meta.url), "utf8"));
    const failed = (code, operation) => describeProgramError({ InstructionError: [0, { Custom: code }] },
      ["Program 7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU failed: custom program error"], { operation });
    for (const { code, name } of idl.errors)
      assert.equal(failed(code, "publish").known, true, `${name} (${code}) has a message`);
    assert.equal(failed(6010, "publish").message, protocol.ROYALTY_RANGE);
    assert.equal(failed(6011, "collect").message,
      "This edition is for Seeker holders. Collect with the wallet that holds a Seeker Genesis Token.");
    assert.equal(failed(6012, "buy").message, "This wallet or Seeker Genesis Token has already collected this edition.");
    for (const code of [6008, 6009, 6010, 6011, 6012])
      for (const operation of ["publish", "collect", "buy", "set-offer"])
        assert.equal(failed(code, operation).retryable, false, `${code} is never offered again as ${operation}`);
  }
  {
    // The royalty and Seeker-only terms, the honest Device trait at publish, and a seeker-only claim.
    const { readFileSync } = await import("node:fs");
    const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
    const { publish: publishWords, collect: collectWords } = await import("../src/ui/copy.ts");
    assert.equal(publishWords.royaltyValue(500), "5%");
    assert.equal(publishWords.royaltyValue(0), "0%");
    assert.equal(publishWords.royaltyValue(1000), "10%");
    assert.equal(collectWords.seekerOnly, "Seeker holders only");
    assert.equal(collectWords.needsGenesis, "Needs a Seeker Genesis Token.");
    const types = await import("../publications/types.ts");
    assert.equal(types.DEFAULT_ROYALTY_BPS, 500, "5% unless the creator chose");
    assert.equal(types.MAX_ROYALTY_BPS, 1000, "10% at most");
    assert.equal(types.DEFAULT_SEEKER_ONLY, true, "Seeker holders only unless the creator chose");
    const creator = source("../src/prints/creator.ts");
    assert.match(creator, /metadata\(e, attested\.attestation\.bundle, await sealVerdict\(attested\.attestation\.summary\)\)/,
      "the document names the device only on the verdict judged as it is sealed");
    // The reseal runs where the renewal does: after the attempt is known to be over, before the
    // album check, the storage quote and the instruction that commits the document's hash.
    const prepare = creator.slice(creator.indexOf("export async function prepareSetup("));
    const at = (text) => prepare.indexOf(text);
    assert.ok(at("await renewStaleAttestation(r, d);") > at("await attemptStanding(d)") &&
      at("await resealDocument(r, d);") === at("await renewStaleAttestation(r, d);") + "await renewStaleAttestation(r, d);\n  ".length &&
      at("await resealDocument(r, d);") < at("const storage = await checkStorage(d);") &&
      at("const storage = await checkStorage(d);") < at("const ix = await instruction("),
      "a draft's document is resealed beside the renewal, before the storage quote and the transaction");
    // The royalty and the Seeker-only setting, from the form through the draft into the builder
    // (the node gates cannot run `creator.ts`, so its path is held here as text).
    const sheet = source("../src/prints/PrintSheet.tsx");
    assert.match(sheet, /setDistribution\(!!features\?\.royaltiesAndSeekerOnly\)/, "the form offers the terms only where the program takes them");
    assert.match(sheet, /createDraft\(\s*record,[^;]*?\blamports,\s*(?:\/\/[^\n]*\n\s*)*distribution \? \{ royaltyBps, seekerOnly: sealable && \(solo \|\| seekerOnly\) \} : undefined,\s*\)/,
      "the form's terms are createDraft's last argument, after the price");
    // Seeker-only only with the creator's Genesis Token to seal, which the program requires (6011).
    assert.match(sheet, /setSealable\(!!features && canSealGenesis\(configuredProgram\(cluster\)\)\)/);
    assert.match(sheet, /\{!solo && sealable && \(/, "the switch is absent where no Genesis Token can be sealed");
    assert.match(sheet, /value=\{draft\.seekerOnly \? collectCopy\.seekerOnly : collectCopy\.anyone\}/,
      "the review states who may collect either way, so an unsealable request reads as Anyone");
    assert.match(creator, /export function canSealGenesis\(program: string\): boolean \{\s*return cluster === "mainnet-beta" && programFeatures\(program\)\.genesis;/);
    assert.match(creator, /const sealsGenesis = [^\n]*\n\s*!!e\.genesisMint && canSealGenesis\(e\.program\);/);
    assert.match(creator, /seekerOnly: chosenTerms\.seekerOnly && sealsGenesis\(e\),/, "the draft records Seeker-only only with a token to seal");
    assert.match(creator, /async function genesisAccounts\(e: CoreMetadata\)[^{]*\{\s*if \(!sealsGenesis\(e\)\) return undefined;/,
      "and publish sends the accounts on the same condition");
    assert.match(creator, /priceLamports\?: bigint,\s*\/\*\*[\s\S]*?\*\/\s*sealed\?: SealedTerms,\s*\): Promise<CoreDraft>/,
      "createDraft takes them as `sealed`, after the price");
    assert.match(creator, /const chosenTerms = sealedFor\(program, sealed \?\? \(/, "the draft records what the form chose, or the defaults");
    assert.match(creator, /royaltyBps: chosenTerms\.royaltyBps,\s*(?:\/\/[^\n]*\n\s*)*seekerOnly: chosenTerms\.seekerOnly && /, "both go into the saved draft");
    assert.match(prepare, /const ix = await instruction\((?:(?!\n {2}\);)[\s\S])*?\{ royaltyBps: d\.royaltyBps, seekerOnly: d\.seekerOnly \},\s*\);/,
      "and from the draft into the publish builder's `sealed`");
    assert.match(creator, /current\.royaltyBps !== d\.royaltyBps \|\| current\.seekerOnly !== d\.seekerOnly/, "a stale screen cannot approve other terms");
    assert.match(sheet, /Math\.min\(MAX_ROYALTY_BPS, bps \+ 100\)/, "whole percents, up to 10%");
    assert.match(sheet, /Math\.max\(0, bps - 100\)/, "down to 0%");
    assert.match(sheet, /value=\{copy\.royaltyValue\(draft\.royaltyBps\)\}/, "the review reads the royalty back off the draft");
    assert.match(sheet, /royaltiesAndSeekerOnly && draft\.edition\.supply > 1 && \(/, "and the rule, where there is a copy to collect");
    const collectFlow = source("../src/prints/collect.ts");
    assert.equal(collectFlow.split("await claimedCopy(").length - 1, 2, "the eligibility and the confirmation both read the claim's own receipt");
    assert.match(collectFlow, /claimGenesis\(RPC_ENDPOINT, cluster, c\.seekerOnly, wallet\)/, "the rule comes off the loaded edition");
    assert.match(collectFlow, /seekerOnly: result\.seekerOnly,/);
    assert.doesNotMatch(collectFlow, /collectedCopy\(/, "no wallet-keyed receipt read on a path a seeker-only edition takes");
    assert.match(collectFlow, /buyInstruction\([^)]*quote\.genesis\)/);
    assert.match(collectFlow, /collectInstruction\([^)]*quote\.genesis\)/);
    assert.match(collectFlow, /state\.genesis\?\.mint !== quote\.genesis\?\.mint/, "another token than reviewed is refused before the wallet");
    const { sealedEvidence } = await import("../publications/core/metadataDocument.ts");
    const trait = { trait_type: "Device", value: "Solana Seeker" };
    assert.deepEqual(sealedEvidence(JSON.stringify({ name: "x", external_url: "u", attributes: [trait], properties: { seedshot: { a: 1 } } })),
      { current: true, bundle: { a: 1 }, namesDevice: true });
    assert.deepEqual(sealedEvidence(JSON.stringify({ name: "x", attributes: [trait, { trait_type: "Attestation", value: "k" }], properties: {} })),
      { current: false, namesDevice: true });
    assert.deepEqual(sealedEvidence(JSON.stringify({ name: "x", description: "", image: "i" })), { current: false, namesDevice: false });
  }
  {
    // kit's production RPC errors read as a decode hint; the screens get one plain line instead.
    const { SolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SOLANA_ERROR__INVALID_NONCE } = await import("@solana/kit");
    const { safeErrorText } = await import("../src/ui/errorText.ts");
    const http = (statusCode) => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
      { headers: new Headers(), message: "", statusCode });
    assert.equal(safeErrorText(http(429)), "The network is busy. Try again in a moment.");
    assert.equal(safeErrorText(http(503)), "The network did not answer. Try again.");
    assert.equal(safeErrorText(new Error("Solana error #8100002; Decode this error by running `npx @solana/errors decode -- 8100002 'X19j'`")),
      "Solana error #8100002", "a bare production message keeps only its code");
    assert.equal(safeErrorText(new Error("Transaction expired. Try again.")), "Transaction expired. Try again.");
    assert.ok(!safeErrorText(new SolanaError(SOLANA_ERROR__INVALID_NONCE, { actualNonceValue: "a", expectedNonceValue: "b" })).includes("Decode"));
  }
  console.log("runtime checks ok —legacy publication metadata, devnet rent/upload budget, capture modes/exposure, collect links, malformed URLs, editor debounce/cancellation, bounded photo loading, serialized storage, Arweave /raw/ reads, deployed-program pin, send freeze and burn tombstones, sending a collected copy, all three Edition layouts, release RPC, price floor and program error words, royalty and Seeker-only terms, the Device trait at publish, seeker-only claims");
}
