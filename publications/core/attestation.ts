/**
 * Device attestation in a published document (`signshot-attestation/1`, under `properties.signshot`).
 *
 * At publish time the keystore makes a fresh hardware-backed key whose attestation challenge is
 * SHA-256 of a canonical manifest naming this publication (edition, creator, nonce, image and
 * capture hashes), and signs the manifest with it. Evidence from another key, phone or
 * publication carries a different challenge and fails.
 *
 * `readAttestationBundle` checks structure only (manifest, challenge, signature, hardware key,
 * Google root). `deviceVerdict` adds release app/signer, locked verified boot, validity at the
 * on-chain publication time and revocation; the last two need the network (`attestationCheck.ts`).
 *
 * None of this says the camera sensor produced the image.
 */

import { getBase64Encoder } from "@solana/kit";
import signingCertificate from "../../dapp-store/signing-certificate.json";
import { canonicalize, type JcsValue } from "../../src/jcs";
import {
  challengeMatches,
  parseCertificate,
  verifyChain,
  verifySignature,
} from "../../src/seeker/keyAttestation";
import type { AttestationSummary, Cluster } from "../types";

export type { AttestationSummary };

export const ATTESTATION_SCHEMA = "signshot-attestation/1" as const;

const HEX32 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Seeker chains are five certificates; the bound keeps a hostile document small. */
const MAX_CERTIFICATES = 8;
/** The parser's 8192-byte certificate cap, as base64. */
const MAX_CERTIFICATE_BASE64 = 10924;
const MAX_SIGNATURE_BASE64 = 128;
/** Largest bundle the app writes. A real one is ~6 KB; Turbo's free tier caps a data item at 100 KiB. */
export const MAX_BUNDLE_BYTES = 32 * 1024;

/** The signed claim. Strings and safe integers only, so the JCS subset applies. */
export interface AttestationManifest {
  schema: typeof ATTESTATION_SCHEMA;
  cluster: Cluster;
  program: string;
  edition: string;
  collection: string;
  creator: string;
  nonce: string;
  /** The public print's SHA-256; the candy machine's hidden-settings hash. */
  imageHash: string;
  /** The private version the print was made from (a Develop edit, or the styled frame). */
  sourceHash: string;
  /** The private capture frames, as hashed at the shutter. */
  cleanHash: string;
  styledHash: string;
  capturedAtMs: number;
  width: number;
  height: number;
}

/** `certificates[0]` is the attestation key's own certificate. */
export interface AttestationBundle {
  schema: typeof ATTESTATION_SCHEMA;
  manifest: AttestationManifest;
  /** DER ECDSA (SHA-256) over the canonical manifest bytes, base64. */
  signature: string;
  /** DER certificates, base64, leaf first, ending at a Google root. */
  certificates: string[];
}

/** A plain JSON object, or null for anything else (arrays included). */
export const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>) : null;
/** Exactly these own keys, no more and no fewer. */
export const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
};

function fail(what: string): never {
  throw new Error(`attestation: ${what}`);
}

/** The manufacturer/model pair the Seeker's keystore attests. */
const SEEKER = { manufacturer: "Solana Mobile Inc.", model: "Seeker" } as const;

const isSeeker = (s: AttestationSummary) =>
  s.manufacturer === SEEKER.manufacturer && s.model === SEEKER.model;

/** The name a wallet shows for the attested device. */
export function deviceName(s: AttestationSummary): string {
  return isSeeker(s) ? "Solana Seeker" : `${s.manufacturer} ${s.model}`;
}

export function securityLevelName(s: AttestationSummary): string {
  return s.securityLevel === "strongbox" ? "StrongBox hardware key" : "TEE hardware key";
}

/**
 * Metaplex `attributes`: the Device trait, only when `deviceVerdict` passed at sealing time.
 * Wallets show traits as fact, so otherwise none. Re-derived on read (`checkAttributes`).
 */
export function attestationAttributes(s: AttestationSummary, verified: boolean): { trait_type: string; value: string }[] {
  return verified ? [{ trait_type: "Device", value: deviceName(s) }] : [];
}

export const manifestBytes = (manifest: AttestationManifest) =>
  new TextEncoder().encode(canonicalize(manifest as unknown as JcsValue));

const base64 = (value: unknown, max: number, what: string): Uint8Array => {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !BASE64.test(value))
    fail(`bad ${what}`);
  return new Uint8Array(getBase64Encoder().encode(value));
};

/** The fields a manifest must repeat exactly from verified chain state. */
export type ManifestCommitment = Pick<
  AttestationManifest,
  "cluster" | "program" | "edition" | "collection" | "creator" | "nonce" | "imageHash"
>;

const MANIFEST_KEYS = [
  "schema", "cluster", "program", "edition", "collection", "creator", "nonce",
  "imageHash", "sourceHash", "cleanHash", "styledHash", "capturedAtMs", "width", "height",
] as const;

function readManifest(value: unknown, expected: ManifestCommitment): AttestationManifest {
  const m = object(value);
  if (!m || !exactKeys(m, MANIFEST_KEYS)) fail("bad manifest");
  if (m.schema !== ATTESTATION_SCHEMA) fail("unknown manifest schema");
  for (const key of ["cluster", "program", "edition", "collection", "creator", "nonce", "imageHash"] as const)
    if (m[key] !== expected[key]) fail(`manifest ${key} does not match the publication`);
  for (const key of ["sourceHash", "cleanHash", "styledHash"] as const)
    if (typeof m[key] !== "string" || !HEX32.test(m[key] as string)) fail(`bad manifest ${key}`);
  for (const key of ["capturedAtMs", "width", "height"] as const)
    if (typeof m[key] !== "number" || !Number.isSafeInteger(m[key]) || (m[key] as number) <= 0)
      fail(`bad manifest ${key}`);
  return m as unknown as AttestationManifest;
}

/**
 * Check a bundle against verified chain state. Throws on bad structure, a manifest for another
 * publication, a wrong challenge or signature, a software key, or a chain not reaching a Google
 * root. `trustedRootKeys` is for tests only.
 */
export function readAttestationBundle(
  value: unknown,
  expected: ManifestCommitment,
  trustedRootKeys?: readonly string[],
): { bundle: AttestationBundle; summary: AttestationSummary } {
  const b = object(value);
  if (!b || !exactKeys(b, ["schema", "manifest", "signature", "certificates"])) fail("bad bundle");
  if (b.schema !== ATTESTATION_SCHEMA) fail("unknown bundle schema");
  const manifest = readManifest(b.manifest, expected);
  if (!Array.isArray(b.certificates) || b.certificates.length < 2 || b.certificates.length > MAX_CERTIFICATES)
    fail("bad certificate chain");
  const chain = (b.certificates as unknown[]).map((c) => parseCertificate(base64(c, MAX_CERTIFICATE_BASE64, "certificate")));
  const signature = base64(b.signature, MAX_SIGNATURE_BASE64, "signature");
  const leaf = chain[0];
  const k = leaf.keyDescription;
  if (!k) fail("the leaf certificate carries no key attestation");
  const message = manifestBytes(manifest);
  if (!challengeMatches(leaf, message)) fail("the attestation challenge is not this manifest");
  if (!verifySignature(leaf, message, signature)) fail("the manifest signature does not verify");
  if (k.attestationSecurityLevel === "software" || k.keymasterSecurityLevel === "software")
    fail("the attestation key is not hardware-backed");
  if (!k.hardwareDevice) fail("no hardware-attested device identity");
  if (!k.rootOfTrust) fail("no root of trust");
  verifyChain(chain, trustedRootKeys);
  const summary: AttestationSummary = {
    securityLevel: k.attestationSecurityLevel,
    manufacturer: k.hardwareDevice.manufacturer,
    model: k.hardwareDevice.model,
    brand: k.hardwareDevice.brand,
    verifiedBoot: k.rootOfTrust.verifiedBootState,
    deviceLocked: k.rootOfTrust.deviceLocked,
    packageNames: k.application?.packages.map((p) => p.name) ?? [],
    signerDigests: k.application?.signerDigests ?? [],
    certificates: chain.map((c) => ({
      serial: c.serialHex,
      notBefore: c.notBefore.getTime(),
      notAfter: c.notAfter.getTime(),
    })),
  };
  return {
    bundle: {
      schema: ATTESTATION_SCHEMA,
      manifest,
      signature: b.signature as string,
      certificates: b.certificates as string[],
    },
    summary,
  };
}

/**
 * Throws unless `attributes` is empty or the Device trait. The reader can only re-run the offline
 * half of the verdict, so the trait is refused only when that half refuses.
 */
export function checkAttributes(value: unknown, summary: AttestationSummary) {
  const allowed = deviceVerdict(summary, null, null).status === "refused"
    ? [attestationAttributes(summary, false)]
    : [attestationAttributes(summary, false), attestationAttributes(summary, true)];
  if (!Array.isArray(value) ||
      !allowed.some((expected) => canonicalize(value as JcsValue) === canonicalize(expected as unknown as JcsValue)))
    fail("attributes do not match the certificate");
}

// --- Device verdict ---

/** The release APK's package and signing key (also in `.well-known/assetlinks.json`). */
export const RELEASE_APP: { readonly packageName: string; readonly signerDigest: string } = {
  packageName: signingCertificate.packageName,
  signerDigest: signingCertificate.sha256,
};

/**
 * Google's revocation list by serial key. Documented as lowercase hex without leading zeros, but
 * the live list also uses decimal serials, so both spellings are looked up.
 */
export type RevocationList = ReadonlyMap<string, { status: string; reason?: string }>;

/** Every list entry for this chain, as `[key, status]`. `serial` is already lowercase hex. */
export function revocationHits(s: AttestationSummary, list: RevocationList): [string, string][] {
  const hits: [string, string][] = [];
  for (const { serial } of s.certificates) {
    const decimal = BigInt("0x" + serial).toString(10);
    for (const key of new Set([serial, decimal])) {
      const entry = list.get(key);
      if (entry) hits.push([key, entry.status]);
    }
  }
  return hits;
}

/** Shown after "Not accepted:". */
export const DEVICE_REFUSAL = {
  app: "another app",
  unlocked: "bootloader unlocked",
  boot: "boot not verified",
  revoked: "revoked",
  suspended: "suspended",
  expired: "expired at publication",
  early: "not yet valid at publication",
  /** A draft not yet sent is judged now; the send path renews it (`src/prints/creator.ts`). */
  expiredDraft: "expired",
} as const;

/** `unchecked`: nothing refused, but the publication time or revocation list was unavailable. */
export type DeviceVerdict =
  | { status: "verified" }
  | { status: "refused"; reason: string }
  | { status: "unchecked" };

/**
 * Whether a screen may name the attested device, on top of `readAttestationBundle`:
 *  - exactly one package and one signer, both `RELEASE_APP` (the keystore attests every package
 *    of the UID and every signer, so a shared-UID app or extra signer would ride along);
 *  - verified boot, locked bootloader;
 *  - every certificate valid at `at`: the on-chain publication time, or now for an unsent draft,
 *    never the phone-asserted capture time (RKP device certificates live ~13 days);
 *  - no certificate revoked, for either root (leaked keyboxes chain to the RSA root).
 * `at`/`list` null means unavailable; a definite refusal wins over "unchecked".
 * https://developer.android.com/privacy-and-security/security-key-attestation
 */
export function deviceVerdict(s: AttestationSummary, at: Date | null, list: RevocationList | null): DeviceVerdict {
  const refused = (reason: string): DeviceVerdict => ({ status: "refused", reason });
  if (s.packageNames.length !== 1 || s.packageNames[0] !== RELEASE_APP.packageName ||
      s.signerDigests.length !== 1 || s.signerDigests[0] !== RELEASE_APP.signerDigest)
    return refused(DEVICE_REFUSAL.app);
  if (!s.deviceLocked) return refused(DEVICE_REFUSAL.unlocked);
  if (s.verifiedBoot !== "verified") return refused(DEVICE_REFUSAL.boot);
  if (!Array.isArray(s.certificates) || s.certificates.length < 2) return { status: "unchecked" };
  if (at) {
    const t = at.getTime();
    if (s.certificates.some((c) => t > c.notAfter)) return refused(DEVICE_REFUSAL.expired);
    if (s.certificates.some((c) => t < c.notBefore)) return refused(DEVICE_REFUSAL.early);
  }
  if (list) {
    const hits = revocationHits(s, list);
    if (hits.length)
      return refused(hits.every(([, status]) => status === "SUSPENDED") ? DEVICE_REFUSAL.suspended : DEVICE_REFUSAL.revoked);
  }
  return at && list ? { status: "verified" } : { status: "unchecked" };
}

/**
 * A reused draft's chain may expire before send, and a document sealed with an expired chain fails
 * `deviceVerdict` forever; within this margin the send path re-attests (`src/prints/creator.ts`).
 */
export const ATTESTATION_RENEW_MS = 24 * 60 * 60 * 1000;

/** Has any certificate expired, or will it within `margin` of `now`? */
export function attestationExpiring(s: AttestationSummary, now = Date.now(), margin = ATTESTATION_RENEW_MS): boolean {
  return s.certificates.some((c) => c.notAfter - margin <= now);
}
