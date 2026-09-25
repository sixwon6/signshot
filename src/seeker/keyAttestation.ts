/**
 * Android key attestation, read and checked from the certificate chain the phone's keystore
 * produced. Runtime-free on purpose: the app reads every edition it shows through this, and the
 * off-device verifier in `scripts/verify-attestation.ts` reads the same bytes with the same code.
 *
 * What is done here, in pure JavaScript:
 *  - X.509 parsing: public key (P-256, P-384 or RSA), names, validity, basic constraints, the
 *    signature, and the key attestation extension (OID 1.3.6.1.4.1.11129.2.1.17) — security
 *    level, challenge, root of trust, attested device identity, calling app.
 *  - Chain verification: each certificate issued and signed by the next (ECDSA P-256/P-384 with
 *    SHA-256/384, or RSA PKCS#1 v1.5 with SHA-256/384), issuers marked CA, the last one
 *    self-signed and its public key one of Google's published attestation roots (pinned below by
 *    SPKI SHA-256; the PEM is in `scripts/attestation-roots.pem`).
 *
 * What is NOT done here: certificate validity windows and revocation. Both need a reference time
 * (Google's device and intermediate certificates live for days) and the network; every reader
 * applies them through `deviceVerdict` (`publications/core/attestation.ts`), at the edition's
 * on-chain publication time, before it names a device.
 *
 * Every read is a bounded DER walk that refuses indefinite lengths, truncated values and
 * anything not exactly where X.509 puts it; anything malformed throws an `Error` whose message
 * begins `attestation:`. https://source.android.com/docs/security/features/keystore/attestation
 */

import { p256, p384 } from "@noble/curves/nist.js";
import { sha256, sha384 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { hasUnsafeText } from "../../publications/core/details";

const KEY_ATTESTATION_OID = "1.3.6.1.4.1.11129.2.1.17";
const BASIC_CONSTRAINTS_OID = "2.5.29.19";
const EC_PUBLIC_KEY_OID = "1.2.840.10045.2.1";
const RSA_ENCRYPTION_OID = "1.2.840.113549.1.1.1";
const P256_OID = "1.2.840.10045.3.1.7";
const P384_OID = "1.3.132.0.34";

/**
 * Google's Android key attestation roots, as SHA-256 of their SubjectPublicKeyInfo DER. The
 * four RSA roots published over the years share one key; the EC root began signing in 2026.
 * `scripts/check-attestation.ts` asserts these equal the PEM file's keys.
 */
export const GOOGLE_ATTESTATION_ROOT_KEYS: readonly string[] = [
  "feb2ea7551ee316ed4bb443c8293b884dbfdea40b603ee3e4f4a897e4580fbae", // RSA-4096, serial f92009e853b6b045
  "3ee44512a1af2beb39c889490c60ea3f82e43f5d5a5532f5ab9419f676cd07ec", // P-384, Key Attestation CA1
];

/** A parsed DER element. `content` is the value bytes; `raw` includes the tag and length. */
interface Der {
  cls: 0 | 1 | 2 | 3;
  constructed: boolean;
  tag: number;
  content: Uint8Array;
  raw: Uint8Array;
}

function fail(what: string): never {
  throw new Error(`attestation: ${what}`);
}

/** Parse one element at `offset`; returns it and the offset after it. */
function element(bytes: Uint8Array, offset: number): [Der, number] {
  if (offset >= bytes.length) fail("truncated element");
  const first = bytes[offset];
  const cls = (first >> 6) as 0 | 1 | 2 | 3;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  let i = offset + 1;
  if (tag === 0x1f) {
    tag = 0;
    let more = true, count = 0;
    while (more) {
      if (i >= bytes.length || count++ > 4) fail("bad tag");
      const b = bytes[i++];
      if (count === 1 && b === 0x80) fail("non-minimal tag");
      tag = tag * 128 + (b & 0x7f);
      more = (b & 0x80) !== 0;
    }
    if (tag < 0x1f) fail("non-minimal tag");
  }
  if (i >= bytes.length) fail("truncated length");
  let length = bytes[i++];
  if (length === 0x80) fail("indefinite length");
  if (length > 0x80) {
    const n = length & 0x7f;
    if (n > 4 || i + n > bytes.length || bytes[i] === 0) fail("bad length");
    length = 0;
    for (let k = 0; k < n; k += 1) length = length * 256 + bytes[i++];
    if (length < 0x80) fail("non-minimal length");
  }
  const end = i + length;
  if (end > bytes.length) fail("truncated value");
  return [
    { cls, constructed, tag, content: bytes.subarray(i, end), raw: bytes.subarray(offset, end) },
    end,
  ];
}

/** Every element inside a constructed value, in order. */
function children(der: Der): Der[] {
  if (!der.constructed) fail("expected a constructed value");
  const out: Der[] = [];
  let offset = 0;
  while (offset < der.content.length) {
    const [child, next] = element(der.content, offset);
    out.push(child);
    offset = next;
  }
  return out;
}

/** The one element a byte string holds, with nothing after it. */
function whole(bytes: Uint8Array, what: string): Der {
  const [d, end] = element(bytes, 0);
  if (end !== bytes.length) fail(`trailing bytes after ${what}`);
  return d;
}

const isUniversal = (d: Der, tag: number) => d.cls === 0 && d.tag === tag;
const expect = (d: Der | undefined, tag: number, what: string) => {
  if (!d || !isUniversal(d, tag)) fail(`expected ${what}`);
  return d;
};

function oid(der: Der): string {
  expect(der, 6, "an OID");
  const b = der.content;
  if (b.length === 0 || b.length > 32 || (b[b.length - 1] & 0x80) !== 0) fail("bad OID");
  const parts: number[] = [];
  let value = 0, start = true;
  for (let i = 0; i < b.length; i += 1) {
    if (start && b[i] === 0x80) fail("non-minimal OID");
    start = false;
    value = value * 128 + (b[i] & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER) fail("OID arc too large");
    if ((b[i] & 0x80) === 0) {
      if (parts.length === 0) {
        const first = value < 40 ? 0 : value < 80 ? 1 : 2;
        parts.push(first, value - first * 40);
      } else parts.push(value);
      value = 0;
      start = true;
    }
  }
  return parts.join(".");
}

/** A non-negative INTEGER or ENUMERATED that fits in a safe integer. */
function integer(der: Der): number {
  if (!(isUniversal(der, 2) || isUniversal(der, 10))) fail("expected an integer");
  const b = der.content;
  if (b.length === 0 || b.length > 6 || (b[0] & 0x80) !== 0) fail("unsupported integer");
  let value = 0;
  for (const byte of b) value = value * 256 + byte;
  return value;
}

/** A non-negative INTEGER of any size (RSA moduli). */
function bigInteger(der: Der, maxBytes: number): bigint {
  expect(der, 2, "an integer");
  const b = der.content;
  if (b.length === 0 || b.length > maxBytes || (b[0] & 0x80) !== 0) fail("unsupported big integer");
  return BigInt("0x" + bytesToHex(b));
}

function boolean(der: Der): boolean {
  expect(der, 1, "a boolean");
  if (der.content.length !== 1) fail("bad boolean");
  return der.content[0] !== 0;
}

function octets(der: Der): Uint8Array {
  return expect(der, 4, "an octet string").content;
}

/** The content of a BIT STRING with no unused bits. */
function bitString(der: Der): Uint8Array {
  const b = expect(der, 3, "a bit string").content;
  if (b.length < 2 || b[0] !== 0) fail("bad bit string");
  return b.subarray(1);
}

/**
 * UTF-8 text from an OCTET STRING. Refuses control, bidi, zero-width and other characters this
 * project keeps out of every published string, because this text reaches screens and wallets.
 */
function text(der: Der): string {
  const b = octets(der);
  if (b.length > 128) fail("device identifier too long");
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    fail("device identifier is not UTF-8");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value) || hasUnsafeText(value)) fail("device identifier has unsafe characters");
  return value;
}

/** Explicitly tagged [n] members of an AuthorizationList, by tag number. */
function taggedMembers(list: Der): Map<number, Der> {
  expect(list, 16, "an authorization list");
  const out = new Map<number, Der>();
  for (const member of children(list)) {
    if (member.cls !== 2 || !member.constructed) fail("bad authorization member");
    if (out.has(member.tag)) fail("repeated authorization member");
    const inner = children(member);
    if (inner.length !== 1) fail("bad explicit tag");
    out.set(member.tag, inner[0]);
  }
  return out;
}

export type VerifiedBoot = "verified" | "self-signed" | "unverified" | "failed";
export type SecurityLevel = "software" | "tee" | "strongbox";

const SECURITY_LEVELS: readonly SecurityLevel[] = ["software", "tee", "strongbox"];
const BOOT_STATES: readonly VerifiedBoot[] = ["verified", "self-signed", "unverified", "failed"];

/** The attested device identity, present only when the keystore included device properties. */
export interface AttestedDevice {
  brand: string;
  device: string;
  product: string;
  manufacturer: string;
  model: string;
}

export interface KeyDescription {
  attestationVersion: number;
  attestationSecurityLevel: SecurityLevel;
  keymasterVersion: number;
  keymasterSecurityLevel: SecurityLevel;
  /** The bytes the caller passed to `setAttestationChallenge`. */
  challenge: Uint8Array;
  rootOfTrust: { deviceLocked: boolean; verifiedBootState: VerifiedBoot } | null;
  /** Read from the hardware-enforced list only; software claims are not device evidence. */
  hardwareDevice: AttestedDevice | null;
  osVersion: number | null;
  osPatchLevel: number | null;
  /** The calling app, as the keystore daemon asserted it (software-enforced by design). */
  application: { packages: { name: string; version: number }[]; signerDigests: string[] } | null;
}

export type PublicKey =
  | { kind: "ec"; curve: "p256" | "p384"; point: Uint8Array }
  | { kind: "rsa"; modulus: bigint; exponent: bigint };

export interface ParsedCertificate {
  publicKey: PublicKey;
  /** SHA-256 of the SubjectPublicKeyInfo DER: what root pinning compares. */
  spkiHash: string;
  /** Serial number as lowercase hex without leading zeros. */
  serialHex: string;
  notBefore: Date;
  notAfter: Date;
  /** Whether basic constraints mark this certificate as a CA. */
  isCa: boolean;
  keyDescription: KeyDescription | null;
  /** For chain verification: what was signed, how, and the signature. */
  tbs: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  signatureAlgorithm: string;
  signature: Uint8Array;
}

function time(der: Der): Date {
  const s = new TextDecoder().decode(der.content);
  let m: RegExpMatchArray | null;
  let year: number;
  if (isUniversal(der, 23) && (m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    const yy = Number(m[1]);
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
  } else if (isUniversal(der, 24) && (m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    year = Number(m[1]);
  } else fail("bad certificate time");
  const [month, day, hour, minute, second] = m.slice(2).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
    fail("bad certificate time");
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) fail("bad certificate time");
  return date;
}

function readDevice(members: Map<number, Der>): AttestedDevice | null {
  const ids = [710, 711, 712, 716, 717].map((tag) => members.get(tag));
  if (ids.every((d) => d === undefined)) return null;
  if (ids.some((d) => d === undefined)) fail("partial device identity");
  const [brand, device, product, manufacturer, model] = ids.map((d) => text(d!));
  return { brand, device, product, manufacturer, model };
}

function readApplication(members: Map<number, Der>): KeyDescription["application"] {
  const raw = members.get(709);
  if (!raw) return null;
  const seq = whole(octets(raw), "the application id");
  const parts = children(expect(seq, 16, "an application id"));
  if (parts.length !== 2) fail("bad application id");
  const packages = children(expect(parts[0], 17, "a package set")).map((p) => {
    const fields = children(expect(p, 16, "a package"));
    if (fields.length !== 2) fail("bad package");
    return { name: text(fields[0]), version: integer(fields[1]) };
  });
  if (packages.length === 0 || packages.length > 16) fail("bad package set");
  const signerDigests = children(expect(parts[1], 17, "a digest set")).map((d) => bytesToHex(octets(d)));
  if (signerDigests.length === 0 || signerDigests.length > 16) fail("bad digest set");
  return { packages, signerDigests };
}

function readKeyDescription(bytes: Uint8Array): KeyDescription {
  const seq = whole(bytes, "the key description");
  const f = children(expect(seq, 16, "a key description"));
  if (f.length !== 8) fail("bad key description");
  const level = (d: Der) => {
    const n = integer(d);
    if (n >= SECURITY_LEVELS.length) fail("unknown security level");
    return SECURITY_LEVELS[n];
  };
  const software = taggedMembers(f[6]);
  const hardware = taggedMembers(f[7]);
  let rootOfTrust: KeyDescription["rootOfTrust"] = null;
  const rot = hardware.get(704);
  if (rot) {
    const r = children(expect(rot, 16, "a root of trust"));
    if (r.length < 3) fail("bad root of trust");
    const state = integer(r[2]);
    if (state >= BOOT_STATES.length) fail("unknown boot state");
    rootOfTrust = { deviceLocked: boolean(r[1]), verifiedBootState: BOOT_STATES[state] };
  }
  // The keystore daemon asserts the calling app, so the schema puts it in the software list. A
  // hardware copy is not expected; one that disagrees is refused rather than chosen between.
  const application = readApplication(software);
  const hardwareApplication = readApplication(hardware);
  if (hardwareApplication && JSON.stringify(hardwareApplication) !== JSON.stringify(application))
    fail("conflicting application ids");
  const osVersion = hardware.get(705), osPatchLevel = hardware.get(706);
  return {
    attestationVersion: integer(f[0]),
    attestationSecurityLevel: level(f[1]),
    keymasterVersion: integer(f[2]),
    keymasterSecurityLevel: level(f[3]),
    challenge: octets(f[4]),
    rootOfTrust,
    hardwareDevice: readDevice(hardware),
    osVersion: osVersion ? integer(osVersion) : null,
    osPatchLevel: osPatchLevel ? integer(osPatchLevel) : null,
    application,
  };
}

function readPublicKey(spki: Der): PublicKey {
  const parts = children(expect(spki, 16, "a public key"));
  if (parts.length !== 2) fail("bad public key");
  const alg = children(expect(parts[0], 16, "a key algorithm"));
  if (alg.length !== 2) fail("bad key algorithm");
  const algorithm = oid(alg[0]);
  if (algorithm === EC_PUBLIC_KEY_OID) {
    const curveOid = oid(alg[1]);
    const curve = curveOid === P256_OID ? "p256" : curveOid === P384_OID ? "p384" : fail("unsupported curve");
    const point = bitString(parts[1]);
    if (point.length !== (curve === "p256" ? 65 : 97) || point[0] !== 4) fail("bad EC point");
    return { kind: "ec", curve, point };
  }
  if (algorithm === RSA_ENCRYPTION_OID) {
    if (!isUniversal(alg[1], 5)) fail("bad RSA parameters");
    const key = children(expect(whole(bitString(parts[1]), "the RSA key"), 16, "an RSA key"));
    if (key.length !== 2) fail("bad RSA key");
    const modulus = bigInteger(key[0], 513), exponent = bigInteger(key[1], 4);
    if (modulus < (1n << 2047n) || exponent < 3n) fail("weak RSA key");
    return { kind: "rsa", modulus, exponent };
  }
  fail("unsupported public key algorithm");
}

/** Parse one X.509 certificate's DER. Throws on anything malformed. */
export function parseCertificate(der: Uint8Array): ParsedCertificate {
  if (der.length > 8192) fail("certificate too large");
  const cert = whole(der, "the certificate");
  const top = children(expect(cert, 16, "a certificate"));
  if (top.length !== 3) fail("bad certificate");
  const tbsDer = expect(top[0], 16, "a TBS certificate");
  const tbs = children(tbsDer);
  const at = (n: number) => tbs[n] ?? fail("short TBS certificate");
  let i = 0;
  if (at(i).cls === 2 && at(i).tag === 0) i += 1; // version
  const serial = expect(at(i++), 2, "a serial number");
  const innerAlgorithm = children(expect(at(i++), 16, "a signature algorithm"));
  const issuer = expect(at(i++), 16, "an issuer name");
  const validity = children(expect(at(i++), 16, "a validity"));
  if (validity.length !== 2) fail("bad validity");
  const subject = expect(at(i++), 16, "a subject name");
  const spki = at(i++);
  const publicKey = readPublicKey(spki);
  let keyDescription: KeyDescription | null = null;
  let isCa = false;
  for (; i < tbs.length; i += 1) {
    const d = tbs[i];
    if (d.cls !== 2 || d.tag !== 3) continue;
    const exts = children(d);
    if (exts.length !== 1) fail("bad extensions");
    for (const ext of children(expect(exts[0], 16, "an extension list"))) {
      const parts = children(expect(ext, 16, "an extension"));
      if (parts.length < 2 || parts.length > 3) fail("bad extension");
      const id = oid(parts[0]);
      const value = octets(parts[parts.length - 1]);
      if (id === KEY_ATTESTATION_OID) {
        if (keyDescription) fail("repeated attestation extension");
        keyDescription = readKeyDescription(value);
      } else if (id === BASIC_CONSTRAINTS_OID) {
        const bc = children(expect(whole(value, "basic constraints"), 16, "basic constraints"));
        isCa = bc.length > 0 && isUniversal(bc[0], 1) && boolean(bc[0]);
      }
    }
  }
  const outerAlgorithm = children(expect(top[1], 16, "a signature algorithm"));
  if (innerAlgorithm.length === 0 || outerAlgorithm.length === 0 || oid(innerAlgorithm[0]) !== oid(outerAlgorithm[0]))
    fail("signature algorithm mismatch");
  return {
    publicKey,
    spkiHash: bytesToHex(sha256(spki.raw)),
    serialHex: bytesToHex(serial.content).replace(/^0+(?=.)/, ""),
    notBefore: time(validity[0]),
    notAfter: time(validity[1]),
    isCa,
    keyDescription,
    tbs: tbsDer.raw,
    issuer: issuer.raw,
    subject: subject.raw,
    signatureAlgorithm: oid(outerAlgorithm[0]),
    signature: bitString(top[2]),
  };
}

// ---------------------------------------------------------------------------------------------
// Signatures

/** DigestInfo prefixes for RSA PKCS#1 v1.5 (RFC 8017 §9.2 note 1). */
const DIGEST_INFO = {
  sha256: "3031300d060960864801650304020105000420",
  sha384: "3041300d060960864801650304020205000430",
} as const;

const SIGNATURE_ALGORITHMS: Record<string, { kind: "ec" | "rsa"; hash: "sha256" | "sha384" }> = {
  "1.2.840.10045.4.3.2": { kind: "ec", hash: "sha256" },
  "1.2.840.10045.4.3.3": { kind: "ec", hash: "sha384" },
  "1.2.840.113549.1.1.11": { kind: "rsa", hash: "sha256" },
  "1.2.840.113549.1.1.12": { kind: "rsa", hash: "sha384" },
};

const digest = (hash: "sha256" | "sha384", message: Uint8Array) =>
  hash === "sha256" ? sha256(message) : sha384(message);

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n, b = base % modulus, e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/** RSASSA-PKCS1-v1_5 verification, constant-structure: the recovered encoding must be exact. */
function rsaVerify(key: { modulus: bigint; exponent: bigint }, hash: "sha256" | "sha384", message: Uint8Array, signature: Uint8Array): boolean {
  const k = Math.ceil(key.modulus.toString(16).length / 2);
  if (signature.length !== k) return false;
  const s = BigInt("0x" + bytesToHex(signature));
  if (s >= key.modulus) return false;
  const em = modPow(s, key.exponent, key.modulus).toString(16).padStart(k * 2, "0");
  const t = DIGEST_INFO[hash] + bytesToHex(digest(hash, message));
  const psLength = k * 2 - 6 - t.length;
  if (psLength < 16) return false;
  return em === "0001" + "f".repeat(psLength) + "00" + t;
}

function ecVerify(key: { curve: "p256" | "p384"; point: Uint8Array }, hash: "sha256" | "sha384", message: Uint8Array, signature: Uint8Array): boolean {
  const curve = key.curve === "p256" ? p256 : p384;
  try {
    // `lowS: false`: Android's keystore and OpenSSL do not normalise S, so half of all genuine
    // signatures are high-S. Malleability is irrelevant here; the signature is not an id.
    return curve.verify(signature, digest(hash, message), key.point, { prehash: false, format: "der", lowS: false });
  } catch {
    return false;
  }
}

/** Does `signature` (DER ECDSA over SHA-256) sign `message` under the certificate's P-256 key? */
export function verifySignature(cert: ParsedCertificate, message: Uint8Array, signature: Uint8Array): boolean {
  return cert.publicKey.kind === "ec" && cert.publicKey.curve === "p256"
    && ecVerify(cert.publicKey, "sha256", message, signature);
}

/** Was `cert` signed by `issuer`'s key with the algorithm `cert` declares? */
export function verifyIssued(cert: ParsedCertificate, issuer: ParsedCertificate): boolean {
  const alg = SIGNATURE_ALGORITHMS[cert.signatureAlgorithm];
  if (!alg || alg.kind !== issuer.publicKey.kind) return false;
  if (bytesToHex(cert.issuer) !== bytesToHex(issuer.subject)) return false;
  return issuer.publicKey.kind === "rsa"
    ? rsaVerify(issuer.publicKey, alg.hash, cert.tbs, cert.signature)
    : ecVerify(issuer.publicKey, alg.hash, cert.tbs, cert.signature);
}

/**
 * Check a chain, leaf first: every certificate issued and signed by the next, every issuer a
 * CA, the last self-signed and its key one of `trustedRootKeys`. Throws naming the first link
 * that fails. Validity windows and revocation are deliberately not checked here (see the header).
 * `trustedRootKeys` is for tests only; `scripts/check-release-config.ts` compares the default with
 * Google's live root list.
 */
export function verifyChain(chain: ParsedCertificate[], trustedRootKeys: readonly string[] = GOOGLE_ATTESTATION_ROOT_KEYS): void {
  if (chain.length < 2) fail("a chain needs at least two certificates");
  for (let i = 0; i < chain.length; i += 1) {
    const last = i === chain.length - 1;
    const issuer = last ? chain[i] : chain[i + 1];
    if (!issuer.isCa) fail(`certificate ${i + (last ? 0 : 1)} is not a CA`);
    if (!verifyIssued(chain[i], issuer))
      fail(last ? "the last certificate is not self-signed" : `certificate ${i} is not signed by certificate ${i + 1}`);
  }
  if (!trustedRootKeys.includes(chain[chain.length - 1].spkiHash))
    fail("the chain does not end at a Google attestation root");
}

/** The one binding this protocol relies on: the keystore challenge IS the manifest's SHA-256. */
export function challengeMatches(cert: ParsedCertificate, message: Uint8Array): boolean {
  const k = cert.keyDescription;
  return !!k && bytesToHex(k.challenge) === bytesToHex(sha256(message));
}
