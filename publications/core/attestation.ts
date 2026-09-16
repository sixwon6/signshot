/**
 * The device-attestation part of a published document (`seedshot-attestation/1`).
 *
 * At publish time the phone's keystore generates a fresh hardware-backed key whose attestation
 * challenge is the SHA-256 of a canonical MANIFEST naming this exact publication (edition PDA,
 * creator, nonce, image fingerprint, capture fingerprints), signs the manifest with that key, and
 * the certificate chain plus signature go into the document under `properties.seedshot`. The
 * document's own hash is on chain, so the evidence is committed with the publication and cannot
 * be transplanted: a certificate from another key, phone or publication carries a different
 * challenge and fails here.
 *
 * What the reader checks, on the phone, from the document alone: the manifest names this
 * publication; the leaf certificate's challenge is the manifest's hash; the manifest signature
 * verifies under the leaf key; the key is hardware-backed with an attested device identity; and
 * the chain is signed down from one of Google's published attestation roots. What it does not
 * check, because both need a reference time and the network: certificate validity windows and
 * revocation. That is the off-device verifier's job (`scripts/verify-attestation.ts`).
 *
 * What none of it says: that the camera sensor produced the image, or anything about the scene.
 */

import { getBase64Encoder } from "@solana/kit";
import { canonicalize, type JcsValue } from "../../src/jcs";
import {
  challengeMatches,
  parseCertificate,
  verifyChain,
  verifySignature,
} from "../../src/seeker/keyAttestation";
import type { AttestationSummary, Cluster } from "../types";

export type { AttestationSummary };

export const ATTESTATION_SCHEMA = "seedshot-attestation/1" as const;

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
  /** The public print's SHA-256; the on-chain `image_hash`. */
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

export const isSeeker = (s: AttestationSummary) =>
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
 * explorer shows the device without parsing certificates. Derived, and re-derived on read: a
 * document whose attributes disagree with its certificate is refused.
 */
export function attestationAttributes(s: AttestationSummary): { trait_type: string; value: string }[] {
  return [
    { trait_type: "Device", value: deviceName(s) },
    { trait_type: "Attestation", value: securityLevelName(s) },
  ];
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

/** The `attributes` a document must carry for this summary, or a refusal. */
export function checkAttributes(value: unknown, summary: AttestationSummary) {
  const expected = attestationAttributes(summary);
  if (!Array.isArray(value) || canonicalize(value as JcsValue) !== canonicalize(expected as unknown as JcsValue))
    fail("attributes do not match the certificate");
}
