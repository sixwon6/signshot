/**
 * The device-attestation part of a published document (`signshot-attestation/1`).
 *
 * At publish time the phone's keystore generates a fresh hardware-backed key whose attestation
 * challenge is the SHA-256 of a canonical MANIFEST naming this exact publication (edition address,
 * creator, nonce, image fingerprint, capture fingerprints), signs the manifest with that key, and
 * the certificate chain plus signature go into the document under `properties.signshot`. The
 * manifest names the candy machine and the image hash it holds, so the evidence cannot be
 * transplanted: a certificate from another key, phone or publication carries a different
 * challenge and fails here.
 *
 * What the reader checks, from the document alone: the manifest names this publication; the leaf
 * certificate's challenge is the manifest's hash; the manifest signature verifies under the leaf
 * key; the key is hardware-backed with an attested device identity; and the chain is signed down
 * from one of Google's published attestation roots. That is structure, not yet a device claim.
 *
 * A screen names the device only after `deviceVerdict` has also found: the attested app is
 * exactly the release package signed by exactly the release key; verified boot with a locked
 * bootloader; every certificate valid at the edition's on-chain publication time; and no
 * certificate on Google's revocation list. The last two need the network
 * (`attestationCheck.ts`), and a reader that cannot reach it says so rather than guessing.
 *
 * What none of it says: that the camera sensor produced the image, or anything about the scene.
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
/** Chains seen on the Seeker are five certificates; a bound keeps a hostile document small. */
const MAX_CERTIFICATES = 8;
/** The parser's 8192-byte certificate cap, as base64. */
const MAX_CERTIFICATE_BASE64 = 10924;
const MAX_SIGNATURE_BASE64 = 128;
/**
 * The largest bundle the app will write. Turbo's free tier takes a 100 KiB data item and a real
 * bundle is about 6 KB, so this only stops a freak chain from making a photograph unpublishable.
 */
export const MAX_BUNDLE_BYTES = 32 * 1024;

/** The signed claim. Every value is a string or a safe integer, so the JCS subset applies. */
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

/** What the document carries. `certificates[0]` is the attestation key's own certificate. */
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
 * The Metaplex-standard `attributes` a document carries beside the evidence, so a wallet or
 * explorer shows the device without parsing certificates: the Device trait, and only when the full
 * device verdict passed as the document was sealed (`deviceVerdict`: the release app and signer,
 * verified boot on a locked bootloader, no certificate revoked, every one valid then). A wallet
 * shows its traits as fact, so otherwise there are none. Re-derived on read (`checkAttributes`).
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
 * Read and check a bundle against verified chain state. Returns what a screen may say. Throws
 * on any structural problem, a manifest that names a different publication, a challenge that is
 * not the manifest's hash, a signature that does not verify, a software-only key, or a chain
 * that does not reach a Google attestation root. `trustedRootKeys` is for tests only.
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
 * The `attributes` a document may carry for this summary, or a refusal. A document
 * (`metadata()`) carries none, or the Device trait; the reader cannot re-run the network half of
 * the verdict, so it holds the trait to the half it can: a chain from another app, or from a
 * phone without verified boot and a locked bootloader, never names a device.
 */
export function checkAttributes(value: unknown, summary: AttestationSummary) {
  const allowed = deviceVerdict(summary, null, null).status === "refused"
    ? [attestationAttributes(summary, false)]
    : [attestationAttributes(summary, false), attestationAttributes(summary, true)];
  if (!Array.isArray(value) ||
      !allowed.some((expected) => canonicalize(value as JcsValue) === canonicalize(expected as unknown as JcsValue)))
    fail("attributes do not match the certificate");
}

// ---------------------------------------------------------------------------------------------
// The verdict: what a screen may say about a chain the reader accepted

/**
 * The release build, from `dapp-store/signing-certificate.json` (the key the dApp Store APK and
 * `.well-known/assetlinks.json` are signed with). The one pin the verifier and the app compare the
 * attested app against; a debug or test build attests another signer.
 */
export const RELEASE_APP: { readonly packageName: string; readonly signerDigest: string } = {
  packageName: signingCertificate.packageName,
  signerDigest: signingCertificate.sha256,
};

/**
 * Google's revocation list, by the dictionary key it files a serial under: the documented key is
 * lowercase hex without leading zeros, and the live list also keys entries by DECIMAL serial
 * (977 of 1,755 keys were digits only as of 2026-09-24), so both spellings are looked up.
 * `parseRevocationList` skips an entry filed under any other key.
 */
export type RevocationList = ReadonlyMap<string, { status: string; reason?: string }>;

/**
 * Every entry the list holds for this chain, as `[key, status]`. `serial` is the reader's own
 * lowercase hex (`serialHex` in `src/seeker/keyAttestation.ts`), so its decimal spelling is exact.
 */
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

/** The short reasons a screen puts after "Not accepted:". Labels, not explanations. */
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

/**
 * `verified`: every rule holds and the device may be named. `refused`: one definitely does not.
 * `unchecked`: nothing refused, but the publication time or the revocation list was out of reach,
 * so nothing is claimed ("Couldn't check.").
 */
export type DeviceVerdict =
  | { status: "verified" }
  | { status: "refused"; reason: string }
  | { status: "unchecked" };

/**
 * Whether a screen may name the attested device. `summary` is what `readAttestationBundle`
 * accepted (structure, challenge, signature, hardware key, a pinned Google root). On top of that:
 *
 *  - the attested app is exactly `RELEASE_APP`: one package, one signer. The keystore attests
 *    every package of the calling UID and every signer, so a shared-UID neighbour or a second
 *    signer would otherwise ride along;
 *  - verified boot and a locked bootloader;
 *  - every certificate valid at `at`, the edition's ON-CHAIN publication time (`publicationTime`),
 *    or now for a draft not yet sent. Never the capture time, which the phone asserts. Google:
 *    "It's critical ... that Remote Key Provisioning (RKP) certificates continue to have their
 *    validity period checked"; the Seeker's RKP device certificate lives 13 days. Checked for
 *    every chain, including the RSA root's, which is stricter than Google asks for pre-2021
 *    factory keys, none of which is a Seeker;
 *  - no certificate on Google's revocation list, for EITHER root. Leaked factory keyboxes chain
 *    to the RSA root, and Google's docs say to check "the status of each certificate in an
 *    attestation chain"; they do not exempt chains ending at Key Attestation CA1, and Google's
 *    own verifier (github.com/android/keyattestation) checks the list on every path.
 *
 * "verified" then names the device the hardware list attests (`deviceName`): the Seeker line only
 * for Solana Mobile Inc. / Seeker. `at` or `list` null means it could not be fetched. A definite
 * refusal from any rule that could run wins over "unchecked".
 * https://developer.android.com/privacy-and-security/security-key-attestation
 */
export function deviceVerdict(s: AttestationSummary, at: Date | null, list: RevocationList | null): DeviceVerdict {
  const refused = (reason: string): DeviceVerdict => ({ status: "refused", reason });
  if (s.packageNames.length !== 1 || s.packageNames[0] !== RELEASE_APP.packageName ||
      s.signerDigests.length !== 1 || s.signerDigests[0] !== RELEASE_APP.signerDigest)
    return refused(DEVICE_REFUSAL.app);
  if (!s.deviceLocked) return refused(DEVICE_REFUSAL.unlocked);
  if (s.verifiedBoot !== "verified") return refused(DEVICE_REFUSAL.boot);
  // The reader never returns fewer than two; a summary without its chain is nothing to vouch for.
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
 * How close to expiry a draft's chain may be when its document goes into a transaction. A draft's
 * attestation is made when the draft is built and the draft is reused, while the device and
 * intermediate certificates live days to weeks; a document sealed after they expire would fail
 * `deviceVerdict` forever. Inside this margin the send path attests again (`src/prints/creator.ts`).
 */
export const ATTESTATION_RENEW_MS = 24 * 60 * 60 * 1000;

/** Has any certificate expired, or will it within `margin` of `now`? */
export function attestationExpiring(s: AttestationSummary, now = Date.now(), margin = ATTESTATION_RENEW_MS): boolean {
  return s.certificates.some((c) => c.notAfter - margin <= now);
}
