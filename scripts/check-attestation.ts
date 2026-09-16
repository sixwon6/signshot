/**
 * Self-test for `seedshot-attestation/1`: the DER parser, the chain verifier, the bundle reader
 * and the document reader, against the synthetic fixture in `scripts/fixtures/attestation-sample.json`
 * and against Google's real root certificates in `scripts/attestation-roots.pem`. Runs in
 * `npm test`. Every negative case must be refused, because the reader runs on every edition the
 * app shows and a lenient reader would let a document claim a device its certificate does not.
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
  attestationAttributes,
  checkAttributes,
  readAttestationBundle,
  type AttestationBundle,
} from "../publications/core/attestation";
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

// The verifier, end to end, on the synthetic fixture: it must fail, and for the right reasons.
const verifier = spawnSync(process.execPath, [resolve(here, "..", "node_modules", "tsx", "dist", "cli.mjs"),
  resolve(here, "verify-attestation.ts"), "--file", resolve(here, "fixtures", "attestation-sample.json"), "--offline"], { encoding: "utf8" });
const out = verifier.stdout + verifier.stderr;
ok("verifier exits non-zero on the synthetic fixture", verifier.status === 2);
ok("verifier's own reader refuses the synthetic chain", /ERROR attestation: the chain does not end at a Google attestation root/.test(out));

console.log(failures ? `\n${failures} check(s) failed.` : "\nattestation self-test passed.");
process.exit(failures ? 1 : 0);
