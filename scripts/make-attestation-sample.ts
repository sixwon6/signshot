/**
 * Regenerates `scripts/fixtures/attestation-sample.json`: a SYNTHETIC `seedshot-attestation/1`
 * bundle whose two-certificate chain (leaf, then a self-signed CA) is made by OpenSSL, the leaf
 * carrying a hand-built key attestation extension with the Seeker's attested properties. It
 * exercises the parser, the chain logic (with the synthetic root injected as trusted) and the
 * document reader end to end; it is NOT evidence of anything, and both the app's reader with
 * Google's roots and `verify-attestation.ts` rightly refuse it. Needs `openssl` on PATH.
 *
 *   npx tsx scripts/make-attestation-sample.ts
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalize, type JcsValue } from "../src/jcs";
import { parseCertificate } from "../src/seeker/keyAttestation";
import { ATTESTATION_SCHEMA, type AttestationManifest } from "../publications/core/attestation";
import { CANDY_MACHINE_PROGRAM } from "../publications/candy/programs";

const here = dirname(fileURLToPath(import.meta.url));

// --- a tiny DER encoder -------------------------------------------------------------------
const len = (n: number): number[] => n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
const tlv = (tag: number[], content: number[]): number[] => [...tag, ...len(content.length), ...content];
const bytes = (u: Uint8Array | number[]) => Array.from(u);
const SEQ = (...items: number[][]) => tlv([0x30], items.flat());
const SET = (...items: number[][]) => tlv([0x31], items.flat());
const INT = (n: number) => { const b: number[] = []; let v = n; do { b.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0); if (b[0] & 0x80) b.unshift(0); return tlv([0x02], b); };
const ENUM = (n: number) => tlv([0x0a], [n]);
const BOOL = (v: boolean) => tlv([0x01], [v ? 0xff : 0]);
const OCT = (b: Uint8Array | number[]) => tlv([0x04], bytes(b));
const STR = (s: string) => OCT(new TextEncoder().encode(s));
/** Context-specific EXPLICIT [n], high-tag-number form for n >= 31. */
const CTX = (n: number, inner: number[]) => {
  if (n < 31) return tlv([0xa0 | n], inner);
  const digits: number[] = [];
  let v = n;
  do { digits.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
  return tlv([0xbf, ...digits.map((d, i) => i < digits.length - 1 ? d | 0x80 : d)], inner);
};

// --- the manifest and its challenge ---------------------------------------------------------
const manifest: AttestationManifest = {
  schema: ATTESTATION_SCHEMA,
  cluster: "devnet",
  program: CANDY_MACHINE_PROGRAM,
  edition: "SampLe1111111111111111111111111111111111111",
  collection: "SampLe2222222222222222222222222222222222222",
  creator: "SampLe3333333333333333333333333333333333333",
  nonce: "11".repeat(32),
  imageHash: "22".repeat(32),
  sourceHash: "33".repeat(32),
  cleanHash: "44".repeat(32),
  styledHash: "55".repeat(32),
  capturedAtMs: 1789000000000,
  width: 2448,
  height: 3264,
};
const manifestJson = canonicalize(manifest as unknown as JcsValue);
const challenge = sha256(new TextEncoder().encode(manifestJson));

// --- KeyDescription, as https://source.android.com/docs/security/features/keystore/attestation
const application = SEQ(
  SET(SEQ(STR("app.seekershot"), INT(1))),
  SET(OCT(new Uint8Array(32).fill(0xab))),
);
const keyDescription = SEQ(
  INT(300), ENUM(2), INT(300), ENUM(2), // attestation v300, StrongBox, keymint v300, StrongBox
  OCT(challenge), OCT([]),
  SEQ(CTX(709, OCT(application))), // softwareEnforced: the calling app
  SEQ(                              // hardwareEnforced
    CTX(704, SEQ(OCT(new Uint8Array(32).fill(1)), BOOL(true), ENUM(0), OCT(new Uint8Array(32).fill(2)))),
    CTX(705, INT(160000)), CTX(706, INT(202608)),
    CTX(710, STR("solanamobile")), CTX(711, STR("seeker")), CTX(712, STR("seeker")),
    CTX(716, STR("Solana Mobile Inc.")), CTX(717, STR("Seeker")),
  ),
);

// --- OpenSSL: a synthetic P-256 CA, a leaf it signs (with the extension), a manifest signature
const dir = mkdtempSync(join(tmpdir(), "seedshot-attest-"));
try {
  const caKey = join(dir, "ca.key"), caCert = join(dir, "ca.der");
  const key = join(dir, "key.pem"), csr = join(dir, "leaf.csr"), cert = join(dir, "cert.der");
  const ext = join(dir, "leaf.cnf"), msg = join(dir, "manifest.json"), sig = join(dir, "sig.der");
  writeFileSync(msg, manifestJson);
  writeFileSync(ext, [
    "basicConstraints=CA:FALSE",
    "keyUsage=critical,digitalSignature",
    `1.3.6.1.4.1.11129.2.1.17=DER:${bytesToHex(new Uint8Array(keyDescription))}`,
    "",
  ].join("\n"));
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", caKey]);
  execFileSync("openssl", [
    "req", "-new", "-x509", "-key", caKey, "-subj", "/O=Seedshot synthetic/CN=Synthetic attestation CA",
    "-days", "7300", "-outform", "DER", "-out", caCert, "-addext", "basicConstraints=critical,CA:TRUE",
  ]);
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
  execFileSync("openssl", ["req", "-new", "-key", key, "-subj", "/CN=Android Keystore Key", "-out", csr]);
  execFileSync("openssl", [
    "x509", "-req", "-in", csr, "-CA", caCert, "-CAform", "DER", "-CAkey", caKey, "-days", "7300",
    "-extfile", ext, "-outform", "DER", "-out", cert,
  ]);
  execFileSync("openssl", ["dgst", "-sha256", "-sign", key, "-out", sig, msg]);
  const leaf = readFileSync(cert), ca = readFileSync(caCert);
  const fixture = {
    note: "SYNTHETIC. A leaf with a hand-built attestation extension, signed by a synthetic OpenSSL CA; exercises the parser and chain logic only. Regenerate with scripts/make-attestation-sample.ts.",
    syntheticRootKey: parseCertificate(new Uint8Array(ca)).spkiHash,
    schema: ATTESTATION_SCHEMA,
    manifest,
    signature: readFileSync(sig).toString("base64"),
    certificates: [leaf.toString("base64"), ca.toString("base64")],
  };
  const out = resolve(here, "fixtures", "attestation-sample.json");
  writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
