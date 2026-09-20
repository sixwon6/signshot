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
  const { DEFAULT_CAPTURE_SETTINGS, settingsFromEffective, clampSettings } =
    await import("../src/capture/model.ts");
  const { captureModeOf, heldBeyondAuto, autoModeSettings, programSettings, manualSettings, displayIn, nextDisplay,
    settingsLeavingAuto, withBrightnessCarried, parseCaptureChrome, chromeHolding, DEFAULT_CAPTURE_CHROME,
    turnDial, holdsExposure, rememberedMode, rememberedFor } =
    await import("../src/capture/mode.ts");
  // Moving either exposure dial makes Camera2 hold BOTH values; restoring only the requested
  // dial made the companion read Auto and change unexpectedly after reopening the camera.
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
  // Seen on the Seeker with the lens covered: the meter read ISO 20000 over a manual range ending
  // at 11470, and M held 11470 at the same shutter, most of a stop darker. The shutter takes it up.
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
  // The stored chrome: the record from before DISP, garbage, and a held value it would hide.
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
  console.log("runtime checks ok — legacy publication metadata, devnet rent/upload budget, capture modes/exposure, collect links, malformed URLs, editor debounce/cancellation, bounded photo loading, serialized storage");
}
