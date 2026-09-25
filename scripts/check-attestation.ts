/**
 * Self-test for `seedshot-attestation/1`: the DER parser, the chain verifier, the bundle reader,
 * the document reader and the device verdict (release app, boot state, revocation, dates at
 * publication, and the publication time itself), against the synthetic fixture in
 * `scripts/fixtures/attestation-sample.json` and against Google's real root certificates in
 * `scripts/attestation-roots.pem`. Runs in `npm test`, with no network: the revocation list and
 * the RPC are stubbed. Every negative case must be refused, because the reader runs on every
 * edition the app shows and a lenient reader would let a document claim a device its certificate
 * does not.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, type JcsValue } from "../src/jcs";
import {
  GOOGLE_ATTESTATION_ROOT_KEYS,
  parseCertificate,
  verifyChain,
  verifyIssued,
} from "../src/seeker/keyAttestation";
import {
  ATTESTATION_RENEW_MS,
  attestationAttributes,
  attestationExpiring,
  checkAttributes,
  DEVICE_REFUSAL,
  deviceVerdict,
  readAttestationBundle,
  RELEASE_APP,
  type AttestationBundle,
  type AttestationSummary,
  type DeviceVerdict,
  type RevocationList,
} from "../publications/core/attestation";
import {
  checkDevice,
  parseRevocationList,
  publicationTime,
  readRevocationList,
} from "../publications/core/attestationCheck";
import { readPhotoMetadata, readSavedPhotoMetadata } from "../publications/core/metadataDocument";
import { metadata } from "../publications/core/protocol";
import type { CoreMetadata } from "../publications/types";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(here, "fixtures", "attestation-sample.json"), "utf8")) as AttestationBundle & { note: string; syntheticRootKey: string };
const { note: _note, syntheticRootKey, ...bundle } = fixture;
const commitment = bundle.manifest;
const synthetic = [syntheticRootKey];

let failures = 0;
function ok(name: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failures += 1;
}
function refuses(name: string, fn: () => unknown, expectedMessage?: RegExp) {
  let threw: unknown = null;
  try { fn(); } catch (e) { threw = e; }
  const message = threw instanceof Error ? threw.message : "";
  ok(`refuses: ${name}`, threw instanceof Error && threw.message.startsWith("attestation: ") && (!expectedMessage || expectedMessage.test(message)));
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const der = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

// Google's real roots: the pinned key hashes match the PEM, and every root's self-signature
// verifies with the app's own RSA and ECDSA code.
const pem = readFileSync(resolve(here, "attestation-roots.pem"), "utf8");
const roots = [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)]
  .map((m) => parseCertificate(der(m[1].replace(/\s+/g, ""))));
ok("five Google roots parse (four RSA-4096, one P-384)", roots.length === 5
  && roots.filter((r) => r.publicKey.kind === "rsa").length === 4
  && roots.some((r) => r.publicKey.kind === "ec" && r.publicKey.curve === "p384"));
ok("pinned root keys are exactly the PEM's distinct keys",
  [...new Set(roots.map((r) => r.spkiHash))].sort().join() === [...GOOGLE_ATTESTATION_ROOT_KEYS].sort().join());
ok("every Google root is a CA and self-signed under the app's RSA/ECDSA verifier",
  roots.every((r) => r.isCa && verifyIssued(r, r)));
ok("a root does not verify under another root's key", !verifyIssued(roots[0], roots[1]));

// The synthetic leaf certificate itself.
const leaf = parseCertificate(der(bundle.certificates[0]));
const ca = parseCertificate(der(bundle.certificates[1]));
const k = leaf.keyDescription!;
ok("leaf carries a key description", k !== null);
ok("security level read", k.attestationSecurityLevel === "strongbox" && k.keymasterSecurityLevel === "strongbox");
ok("device identity read from the hardware list", k.hardwareDevice?.model === "Seeker" && k.hardwareDevice.manufacturer === "Solana Mobile Inc." && k.hardwareDevice.brand === "solanamobile");
ok("root of trust read", k.rootOfTrust?.verifiedBootState === "verified" && k.rootOfTrust.deviceLocked === true);
ok("OS version and patch read", k.osVersion === 160000 && k.osPatchLevel === 202608);
ok("application read", k.application?.packages[0]?.name === "app.seekershot" && k.application.signerDigests[0] === "ab".repeat(32));
ok("public key is an uncompressed P-256 point", leaf.publicKey.kind === "ec" && leaf.publicKey.curve === "p256" && leaf.publicKey.point.length === 65);
ok("validity dates parsed", leaf.notBefore < leaf.notAfter && leaf.notAfter > new Date());
ok("basic constraints read", !leaf.isCa && ca.isCa);

// The chain logic, with the synthetic root injected as trusted.
ok("leaf verifies under the synthetic CA", verifyIssued(leaf, ca));
ok("chain verifies when the synthetic root is trusted", (() => { verifyChain([leaf, ca], synthetic); return true; })());
refuses("the chain under Google's roots", () => verifyChain([leaf, ca]), /Google attestation root/);
refuses("a chain with the CA removed", () => verifyChain([leaf], synthetic), /two certificates/);
refuses("a chain with a non-CA issuer", () => verifyChain([ca, leaf], [leaf.spkiHash]), /not a CA/);

// The bundle reader.
const { summary } = readAttestationBundle(bundle, commitment, synthetic);
ok("summary names the Seeker", summary.manufacturer === "Solana Mobile Inc." && summary.model === "Seeker" && summary.securityLevel === "strongbox");
ok("summary carries the whole package and signer sets", summary.packageNames.join() === "app.seekershot" && summary.signerDigests.join() === "ab".repeat(32));
const attributes = attestationAttributes(summary);
ok("attributes are the device and the key level",
  canonicalize(attributes as unknown as JcsValue) === canonicalize([
    { trait_type: "Device", value: "Solana Seeker" },
    { trait_type: "Attestation", value: "StrongBox hardware key" },
  ]));

refuses("the bundle under Google's roots (a forged chain)", () => readAttestationBundle(bundle, commitment), /Google attestation root/);
refuses("a manifest with one changed field (signature and challenge both break)", () => {
  const b = clone(bundle); b.manifest.capturedAtMs += 1;
  readAttestationBundle(b, { ...commitment, ...b.manifest }, synthetic);
});
refuses("a manifest naming another edition", () =>
  readAttestationBundle(bundle, { ...commitment, edition: "SampLe9999999999999999999999999999999999999" }, synthetic));
refuses("a manifest naming another image", () =>
  readAttestationBundle(bundle, { ...commitment, imageHash: "ff".repeat(32) }, synthetic));
refuses("a tampered signature", () => {
  const b = clone(bundle);
  const sig = Buffer.from(b.signature, "base64"); sig[sig.length - 1] ^= 1;
  b.signature = sig.toString("base64");
  readAttestationBundle(b, commitment, synthetic);
});
refuses("a certificate whose challenge was edited", () => {
  const b = clone(bundle);
  const d = Buffer.from(b.certificates[0], "base64");
  const at = d.indexOf(Buffer.from(k.challenge));
  if (at < 0) throw new Error("fixture has no challenge");
  d[at] ^= 1;
  b.certificates[0] = d.toString("base64");
  readAttestationBundle(b, commitment, synthetic);
});
refuses("a leaf whose own signature was tampered", () => {
  const b = clone(bundle);
  const d = Buffer.from(b.certificates[0], "base64"); d[d.length - 1] ^= 1;
  b.certificates[0] = d.toString("base64");
  readAttestationBundle(b, commitment, synthetic);
}, /not signed by/);
refuses("a single-certificate chain", () => readAttestationBundle({ ...bundle, certificates: [bundle.certificates[0]] }, commitment, synthetic));
refuses("an empty chain", () => readAttestationBundle({ ...bundle, certificates: [] }, commitment, synthetic));
refuses("a certificate that is not base64", () => readAttestationBundle({ ...bundle, certificates: ["A", bundle.certificates[1]] }, commitment, synthetic));
refuses("an extra bundle key", () => readAttestationBundle({ ...bundle, extra: 1 }, commitment, synthetic));
refuses("a manifest with an extra key", () => {
  const b = clone(bundle); (b.manifest as unknown as Record<string, unknown>).serial = "x";
  readAttestationBundle(b, commitment, synthetic);
});
refuses("attributes that overclaim", () =>
  checkAttributes([{ trait_type: "Device", value: "Solana Seeker" }, { trait_type: "Attestation", value: "Camera sensor" }], summary));
refuses("attributes with an extra trait", () =>
  checkAttributes([...attributes, { trait_type: "Verified", value: "yes" }], summary));
refuses("a short TBS certificate, with an attestation error not a TypeError", () =>
  parseCertificate(new Uint8Array([0x30, 0x06, 0x30, 0x00, 0x30, 0x00, 0x30, 0x00])));

// The document, as written by the app and read back by a stranger. The app's writer runs the
// reader with Google's roots, so a synthetic chain cannot be written; the document is composed by
// hand here exactly as `metadata()` composes it.
const e: CoreMetadata = {
  cluster: commitment.cluster, program: commitment.program, edition: commitment.edition,
  collection: commitment.collection, creator: commitment.creator, nonce: commitment.nonce,
  title: "Sample", supply: 3, image: "https://arweave.net/" + "A".repeat(43), imageHash: commitment.imageHash,
  width: 2448, height: 3264, description: "",
};
refuses("writing a document whose chain is not Google's", () => metadata(e, bundle), /Google attestation root/);
const doc = { name: e.title, description: e.description, image: e.image, attributes, properties: { seedshot: bundle } };
const serialized = canonicalize(doc as unknown as JcsValue);
const read = readPhotoMetadata(JSON.parse(serialized), e, serialized);
ok("a document with a forged chain still loads, with the attestation set aside and a reason",
  read.attestation === undefined && /Google attestation root/.test(read.attestationProblem ?? "") && read.image === e.image);
ok("a non-canonical attested document is refused on the network path", (() => {
  try { readPhotoMetadata(JSON.parse(serialized), e, serialized + " "); return false; } catch { return true; }
})());
ok("plain document still reads without an attestation", (() => {
  const r = readPhotoMetadata(JSON.parse(canonicalize(metadata(e) as unknown as JcsValue)), e);
  return r.attestation === undefined && r.attestationProblem === undefined;
})());
const saved = readSavedPhotoMetadata(serialized, { ...e, attestation: summary });
ok("a saved draft's own claim is replaced by what the document supports (here: set aside)",
  saved.attestation === undefined && !!saved.attestationProblem);
ok("a document with attributes but no evidence is refused", (() => {
  try { readPhotoMetadata({ name: "Sample", description: "", image: e.image, attributes }, e); return false; } catch { return true; }
})());
ok("a document whose attributes disagree with its certificate is set aside", (() => {
  const d = JSON.parse(serialized) as { attributes: { value: string }[] };
  d.attributes[0].value = "iPhone";
  const r = readPhotoMetadata(d, e);
  // (The synthetic chain fails the root check first; the attribute check is covered above.)
  return r.attestation === undefined && !!r.attestationProblem;
})());

// --- The device verdict: what a screen may say about a chain the reader accepted ------------------
const signing = JSON.parse(readFileSync(resolve(here, "..", "dapp-store", "signing-certificate.json"), "utf8")) as { packageName: string; sha256: string };
ok("the release pin is dapp-store/signing-certificate.json, one constant for verifier, app and site",
  RELEASE_APP.packageName === signing.packageName && RELEASE_APP.signerDigest === signing.sha256 && /^[a-f0-9]{64}$/.test(RELEASE_APP.signerDigest));
ok("summary carries each certificate's serial and dates, leaf first",
  summary.certificates.length === 2 && summary.certificates[0].serial === leaf.serialHex
    && summary.certificates[1].notBefore === ca.notBefore.getTime() && summary.certificates[1].notAfter === ca.notAfter.getTime());

// Two chain shapes around the fixture's leaf, with the real roots' serials and dates: the Seeker's
// RKP chain as observed on 2026-09-16 (StrongBox certificate for 13 days → Droid CA3 → Droid CA2 →
// Key Attestation CA1) and a chain ending at the RSA root that leaked factory keyboxes chain to.
const ca1 = roots.find((r) => r.publicKey.kind === "ec")!;
const rsaRoot = roots.find((r) => r.publicKey.kind === "rsa" && r.notAfter.getTime() > Date.now())!;
const dated = (serial: string, from: string, to: string) => ({ serial, notBefore: Date.parse(from), notAfter: Date.parse(to) });
const rootEntry = (r: typeof ca1) => ({ serial: r.serialHex, notBefore: r.notBefore.getTime(), notAfter: r.notAfter.getTime() });
const seekerCa1: AttestationSummary = {
  ...summary,
  signerDigests: [RELEASE_APP.signerDigest],
  certificates: [
    summary.certificates[0],
    dated("5b3e0d9a41c7f2e8", "2026-09-09T00:00:00Z", "2026-09-22T00:00:00Z"),
    dated("7e21c4a09f3b6d15", "2026-08-17T00:00:00Z", "2026-10-26T00:00:00Z"),
    dated("1d94b7e3a6c05f28", "2026-02-09T00:00:00Z", "2029-02-08T00:00:00Z"),
    rootEntry(ca1),
  ],
};
const factoryRsa: AttestationSummary = {
  ...seekerCa1,
  certificates: [
    summary.certificates[0],
    dated("9c0f5e2b7a4d3816", "2025-06-01T00:00:00Z", "2035-06-01T00:00:00Z"),
    dated("e4a8b1c69d2f0735", "2025-01-01T00:00:00Z", "2035-01-01T00:00:00Z"),
    rootEntry(rsaRoot),
  ],
};
const at = new Date("2026-09-20T12:00:00Z"); // inside every window above
const none: RevocationList = new Map();
const listing = (key: string, status = "REVOKED"): RevocationList => new Map([[key, { status, reason: "KEY_COMPROMISE" }]]);
const is = (v: DeviceVerdict, status: DeviceVerdict["status"], reason?: string) =>
  v.status === status && (reason === undefined || (v.status === "refused" && v.reason === reason));
const rsaIntermediate = factoryRsa.certificates[1].serial;

ok("CA1 root: the Seeker's RKP chain, release app, locked, in date, not listed: verified", is(deviceVerdict(seekerCa1, at, none), "verified"));
ok("RSA root: the same rules, not listed: verified", is(deviceVerdict(factoryRsa, at, none), "verified"));
ok("wrong package (the 2026-09-16 test app): another app",
  is(deviceVerdict({ ...seekerCa1, packageNames: ["expo.modules.seekercamera.test"] }, at, none), "refused", DEVICE_REFUSAL.app));
ok("a second package on the calling UID: another app",
  is(deviceVerdict({ ...seekerCa1, packageNames: ["app.seekershot", "com.example.shared"] }, at, none), "refused", DEVICE_REFUSAL.app));
ok("wrong signer (the fixture's own, a stand-in for a debug key): another app",
  is(deviceVerdict({ ...seekerCa1, signerDigests: summary.signerDigests }, at, none), "refused", DEVICE_REFUSAL.app));
ok("a second signer beside the release key: another app",
  is(deviceVerdict({ ...seekerCa1, signerDigests: [RELEASE_APP.signerDigest, "cd".repeat(32)] }, at, none), "refused", DEVICE_REFUSAL.app));
ok("bootloader unlocked", is(deviceVerdict({ ...seekerCa1, deviceLocked: false }, at, none), "refused", DEVICE_REFUSAL.unlocked));
ok("boot not verified (self-signed OS on a locked bootloader)",
  is(deviceVerdict({ ...seekerCa1, verifiedBoot: "self-signed" }, at, none), "refused", DEVICE_REFUSAL.boot));
ok("RSA root: an intermediate on Google's list by hex serial: revoked",
  is(deviceVerdict(factoryRsa, at, listing(rsaIntermediate)), "refused", DEVICE_REFUSAL.revoked));
ok("RSA root: the same intermediate filed by DECIMAL serial: revoked",
  is(deviceVerdict(factoryRsa, at, listing(BigInt("0x" + rsaIntermediate).toString(10))), "refused", DEVICE_REFUSAL.revoked));
ok("RSA root: suspended", is(deviceVerdict(factoryRsa, at, listing(rsaIntermediate, "SUSPENDED")), "refused", DEVICE_REFUSAL.suspended));
ok("RSA root: list unreachable: Couldn't check", is(deviceVerdict(factoryRsa, at, null), "unchecked"));
ok("CA1 root: an RKP certificate on the list is refused too; no root is exempt",
  is(deviceVerdict(seekerCa1, at, listing(seekerCa1.certificates[1].serial)), "refused", DEVICE_REFUSAL.revoked));
ok("CA1 root: list unreachable: Couldn't check, since Google's docs exempt no root",
  is(deviceVerdict(seekerCa1, at, null), "unchecked"));
ok("expired at publication: published a day after the 13-day device certificate lapsed",
  is(deviceVerdict(seekerCa1, new Date("2026-09-23T00:00:00Z"), none), "refused", DEVICE_REFUSAL.expired));
ok("not yet valid at publication", is(deviceVerdict(seekerCa1, new Date("2026-09-08T00:00:00Z"), none), "refused", DEVICE_REFUSAL.early));
ok("missing publication time: Couldn't check", is(deviceVerdict(seekerCa1, null, none), "unchecked"));
ok("a definite refusal wins over what could not be fetched",
  is(deviceVerdict({ ...seekerCa1, deviceLocked: false }, null, null), "refused", DEVICE_REFUSAL.unlocked)
    && is(deviceVerdict(seekerCa1, new Date("2026-09-23T00:00:00Z"), null), "refused", DEVICE_REFUSAL.expired)
    && is(deviceVerdict(factoryRsa, null, listing(rsaIntermediate)), "refused", DEVICE_REFUSAL.revoked));
ok("a summary without its chain vouches for nothing", is(deviceVerdict({ ...seekerCa1, certificates: [] }, at, none), "unchecked"));

// Stale drafts: renewed inside a day of any certificate's expiry, and never outside it.
const lapse = seekerCa1.certificates[1].notAfter;
ok("a chain 25 h from expiry is kept", !attestationExpiring(seekerCa1, lapse - ATTESTATION_RENEW_MS - 3_600_000));
ok("a chain 23 h from expiry is renewed", attestationExpiring(seekerCa1, lapse - ATTESTATION_RENEW_MS + 3_600_000));
ok("an expired chain is renewed", attestationExpiring(seekerCa1, lapse + 1));
ok("margin 0 asks only whether it has expired", !attestationExpiring(seekerCa1, lapse - 1, 0) && attestationExpiring(seekerCa1, lapse, 0));

// The list's documented shape, and nothing else, reads as a list.
const parsed = parseRevocationList({ entries: {
  "2c8cdddfd5e03bfc": { status: "REVOKED", reason: "KEY_COMPROMISE" },
  "123456789012345678": { status: "SUSPENDED", expires: "2030-01-01", comment: "x" },
} });
ok("the documented shape parses, hex and decimal keys alike",
  parsed.size === 2 && parsed.get("2c8cdddfd5e03bfc")?.reason === "KEY_COMPROMISE" && parsed.get("123456789012345678")?.status === "SUSPENDED");
for (const [name, bad] of [
  ["no entries", {}],
  ["entries as an array", { entries: [] }],
  ["an entry without a status", { entries: { ab: { reason: "KEY_COMPROMISE" } } }],
  ["an upper-case key", { entries: { AB: { status: "REVOKED" } } }],
  ["a key that is not a serial", { entries: { "serial-1": { status: "REVOKED" } } }],
] as const)
  ok(`an unreadable list is refused, never read as empty: ${name}`, (() => {
    try { parseRevocationList(bad); return false; } catch { return true; }
  })());

// The network half, against stubbed endpoints.
const realFetch = globalThis.fetch;
const reply = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);
const SYSTEM = "11111111111111111111111111111111";
const PROGRAM = "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU";
const RECEIPT = "47WtZNkAdcuMKudNXEp6T5NhqQEGoXwRcU1xLUDN71uh";
/** A JSON-RPC endpoint that answers `getSignaturesForAddress` with `history` and `getTransaction` from `txs`. */
function chain(history: { signature: string; err: unknown }[] | ((before?: string) => { signature: string; err: unknown }[]), txs: Record<string, unknown>) {
  const calls: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: [string, { before?: string }] };
    calls.push(method);
    const result = method === "getSignaturesForAddress"
      ? typeof history === "function" ? history(params[1]?.before) : history
      : txs[params[0]] ?? null;
    return reply({ jsonrpc: "2.0", id: 1, result });
  }) as typeof fetch;
  return calls;
}
const systemIx = (type: string, info: Record<string, unknown>) => ({ programId: SYSTEM, parsed: { type, info } });
const tx = (blockTime: number, instructions: unknown[], err: unknown = null) =>
  ({ blockTime, meta: { err, innerInstructions: [{ instructions }] }, transaction: { message: { instructions: [] } } });
const rejects = async (p: Promise<unknown>) => p.then(() => false, () => true);

async function networkChecks() {
  // Publication time: the creating transaction, not the oldest mention.
  const PUBLISHED = 1_790_000_000;
  chain(
    [{ signature: "later", err: null }, { signature: "creation", err: null }, { signature: "mention", err: null }],
    {
      mention: tx(1_780_000_000, [systemIx("transfer", { source: "x", destination: RECEIPT, lamports: 1 })]),
      creation: tx(PUBLISHED, [systemIx("createAccount", { newAccount: RECEIPT, owner: PROGRAM, source: "x", lamports: 1, space: 106 })]),
      later: tx(1_800_000_000, []),
    },
  );
  ok("publication time is the block time of the receipt's creation, not an earlier mention that would backdate it",
    (await publicationTime("https://rpc.invalid/1", PROGRAM, RECEIPT)).getTime() === PUBLISHED * 1000);
  chain([{ signature: "prefunded", err: null }], { prefunded: tx(PUBLISHED, [systemIx("assign", { account: RECEIPT, owner: PROGRAM })]) });
  ok("a pre-funded receipt, created by allocate and assign, counts", (await publicationTime("https://rpc.invalid/2", PROGRAM, RECEIPT)).getTime() === PUBLISHED * 1000);
  chain([{ signature: "foreign", err: null }], { foreign: tx(PUBLISHED, [systemIx("createAccount", { newAccount: RECEIPT, owner: SYSTEM })]) });
  ok("an account created for another owner is not the publication", await rejects(publicationTime("https://rpc.invalid/3", PROGRAM, RECEIPT)));
  chain([{ signature: "failed", err: { InstructionError: [0, "Custom"] } }], {
    failed: tx(PUBLISHED, [systemIx("createAccount", { newAccount: RECEIPT, owner: PROGRAM })], { InstructionError: [0, "Custom"] }),
  });
  ok("a failed transaction is not the publication", await rejects(publicationTime("https://rpc.invalid/4", PROGRAM, RECEIPT)));
  chain([], {});
  ok("no history (not yet indexed, or pruned): no time, never a guess", await rejects(publicationTime("https://rpc.invalid/5", PROGRAM, RECEIPT)));
  const full = Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, err: null }));
  const paging = chain(() => full, {});
  ok("history past three pages is not walked", await rejects(publicationTime("https://rpc.invalid/6", PROGRAM, RECEIPT))
    && paging.filter((m) => m === "getSignaturesForAddress").length === 3 && !paging.includes("getTransaction"));

  // The revocation list: fetched once and held for its max-age; a failure is not held.
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return reply({ entries: { [rsaIntermediate]: { status: "REVOKED", reason: "KEY_COMPROMISE" } } }, { headers: { "Cache-Control": "public, max-age=86400" } });
  }) as typeof fetch;
  const first = await readRevocationList("https://status.invalid/held");
  const second = await readRevocationList("https://status.invalid/held");
  ok("the list is fetched once and held for its max-age", fetches === 1 && first === second && first.has(rsaIntermediate));
  let down = true;
  globalThis.fetch = (async () => (down ? new Response("unavailable", { status: 503 }) : reply({ entries: {} }))) as typeof fetch;
  const failed = await rejects(readRevocationList("https://status.invalid/down"));
  down = false;
  ok("an unreachable list is an error, and the next screen asks again", failed && (await readRevocationList("https://status.invalid/down")).size === 0);
  globalThis.fetch = (async () => new Response("{}", { headers: { "Content-Length": "4000001" } })) as typeof fetch;
  ok("a list declared larger than the bound is refused unread", await rejects(readRevocationList("https://status.invalid/large")));

  // `checkDevice`: offline rules first, then both fetches, and a failure of either is "unchecked".
  let asked = 0;
  const sources = (list: () => Promise<RevocationList>, time: () => Promise<Date>) => ({
    revocationList: () => { asked += 1; return list(); },
    publishedAt: () => { asked += 1; return time(); },
  });
  const up = () => Promise.resolve(none), when = () => Promise.resolve(at), fail = () => Promise.reject(new Error("offline"));
  ok("another app is refused without fetching anything",
    is(await checkDevice({ ...seekerCa1, packageNames: ["expo.modules.seekercamera.test"] }, sources(up, when)), "refused", DEVICE_REFUSAL.app) && asked === 0);
  ok("list and time reachable: verified", is(await checkDevice(seekerCa1, sources(up, when)), "verified"));
  ok("list unreachable: Couldn't check", is(await checkDevice(seekerCa1, sources(fail, when)), "unchecked"));
  ok("publication time unreachable: Couldn't check", is(await checkDevice(seekerCa1, sources(up, fail)), "unchecked"));
  ok("revoked, with the time unreachable: still revoked",
    is(await checkDevice(factoryRsa, sources(() => Promise.resolve(listing(rsaIntermediate)), fail)), "refused", DEVICE_REFUSAL.revoked));
  globalThis.fetch = realFetch;
}

async function finish() {
  await networkChecks().catch((error: unknown) => {
    globalThis.fetch = realFetch;
    ok(`network checks ran (${error instanceof Error ? error.message : String(error)})`, false);
  });

  // The verifier, end to end, on the synthetic fixture: it must fail, and for the right reasons.
  const verifier = spawnSync(process.execPath, [resolve(here, "..", "node_modules", "tsx", "dist", "cli.mjs"),
    resolve(here, "verify-attestation.ts"), "--file", resolve(here, "fixtures", "attestation-sample.json"), "--offline"], { encoding: "utf8" });
  const out = verifier.stdout + verifier.stderr;
  ok("verifier exits non-zero on the synthetic fixture", verifier.status === 2);
  ok("verifier's own reader refuses the synthetic chain", /ERROR attestation: the chain does not end at a Google attestation root/.test(out));

  console.log(failures ? `\n${failures} check(s) failed.` : "\nattestation self-test passed.");
  process.exit(failures ? 1 : 0);
}
void finish();
