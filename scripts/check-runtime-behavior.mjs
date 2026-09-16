import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";

// Isolate synchronous URL parsing so a decoder regression cannot hang the test runner.
if (!process.argv.includes("--worker")) {
  const result = spawnSync(process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--worker"],
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
  // Reproduce the published format that the newer three-field-only parser rejected.
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
      // A changed rent schedule must be read from RPC rather than the old documented formula.
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: (params[0] + 128) * 5080 }));
    };
    const budget = await sessionBudget({ endpoint: "https://api.devnet.solana.com" }, 438_912);
    assert.deepEqual(rentQueries.sort((a, b) => a - b), [36, 438_957]);
    assert.equal(budget.programData, 2_230_551_800);
    assert.equal(budget.programAccount, 833_120);
    assert.equal(budget.fees, 2_460_000, "488 uploads and two 2-signature transactions exceed the old fixed fee budget");
    assert.equal(budget.total, 2_394_084_600);
    assert.equal(budget.reserve, testReserve());
    const short = await sessionBudget({ endpoint: "https://api.devnet.solana.com" }, 900);
    const overflow = await sessionBudget({ endpoint: "https://api.devnet.solana.com" }, 901);
    assert.equal(overflow.fees - short.fees, 5_000, "a partial last upload still needs a transaction fee");
    await assert.rejects(sessionBudget({ endpoint: "unused" }, 0), /Invalid program byte count/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const { DEFAULT_CAPTURE_SETTINGS, settingsFromEffective, simpleCaptureSettings, needsProControls, clampSettings } =
    await import("../src/capture/model.ts");
  // Moving either exposure dial makes Camera2 hold BOTH values; restoring only the requested
  // dial made the companion read Auto and change unexpectedly after reopening the camera.
  const manualCapture = { ...DEFAULT_CAPTURE_SETTINGS, manualExposure: true,
    iso: 320, shutterNs: 8_000_000, whiteBalance: "daylight", focus: 1.5 };
  const heldCapture = settingsFromEffective(manualCapture);
  assert.equal(heldCapture.iso, 320);
  assert.equal(heldCapture.shutterNs, 8_000_000);
  assert.equal(needsProControls(heldCapture), true);
  assert.equal("manualExposure" in heldCapture, false);
  // Simple releases manual exposure/locks without losing the photographer's colour or focus.
  const simpleCapture = simpleCaptureSettings({ ...heldCapture, aeLock: true, awbLock: true });
  assert.equal(needsProControls(simpleCapture), false);
  assert.equal(simpleCapture.iso, "auto");
  assert.equal(simpleCapture.shutterNs, "auto");
  assert.equal(simpleCapture.whiteBalance, "daylight");
  assert.equal(simpleCapture.focus, 1.5);
  assert.equal(heldCapture.iso, 320, "switching modes must not mutate the saved settings");
  assert.deepEqual(settingsFromEffective({ ...DEFAULT_CAPTURE_SETTINGS, manualExposure: false }),
    DEFAULT_CAPTURE_SETTINGS, "automatic exposure must never store a metered ISO or shutter");
  assert.equal(needsProControls({ ...DEFAULT_CAPTURE_SETTINGS, awbLock: true }), true);
  const captureCaps = { manualSensor: true, iso: { min: 50, max: 6400 },
    shutterNs: { min: 100_000, max: 30_000_000_000 }, ev: { min: -6, max: 6, step: 1 / 3 },
    aeLock: true, awbLock: true, awbModes: ["auto", "daylight"], focus: "unavailable" };
  const preciseExposure = { ...DEFAULT_CAPTURE_SETTINGS, iso: 317, shutterNs: 8_234_567 };
  const changedColour = clampSettings({ ...preciseExposure, whiteBalance: "daylight" }, captureCaps);
  assert.equal(changedColour.iso, preciseExposure.iso,
    "changing white balance must not snap a metered companion ISO to the dial ladder");
  assert.equal(changedColour.shutterNs, preciseExposure.shutterNs);

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
  console.log("runtime checks ok — legacy publication metadata, devnet rent/upload budget, capture modes/exposure, collect links, malformed URLs, editor debounce/cancellation, bounded photo loading, serialized storage");
}
