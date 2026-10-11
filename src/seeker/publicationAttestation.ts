/**
 * Builds and keystore-signs a `signshot-attestation/1` manifest, then reads it back through the
 * same reader every document uses. Never throws or hangs; failure means a plain document.
 */

import { SeekerCamera, type CaptureRecord } from "../../modules/seeker-camera";
import { canonicalize, type JcsValue } from "../jcs";
import {
  ATTESTATION_SCHEMA,
  MAX_BUNDLE_BYTES,
  readAttestationBundle,
  type AttestationBundle,
  type AttestationManifest,
  type AttestationSummary,
  type ManifestCommitment,
} from "../../publications/core/attestation";

export interface PublicationAttestation {
  bundle: AttestationBundle;
  summary: AttestationSummary;
}

/** For logging only; publication proceeds either way. */
export type AttestationOutcome =
  | { status: "attested"; attestation: PublicationAttestation }
  | { status: "unavailable"; reason: string };

/** StrongBox keygen ~1 s; remote key provisioning can take longer. Past this, publish without. */
const TIMEOUT_MS = 20_000;

export async function attestPublication(
  commitment: ManifestCommitment,
  record: CaptureRecord,
  print: { sourceHash: string; width: number; height: number },
): Promise<AttestationOutcome> {
  const manifest: AttestationManifest = {
    schema: ATTESTATION_SCHEMA,
    cluster: commitment.cluster,
    program: commitment.program,
    edition: commitment.edition,
    collection: commitment.collection,
    creator: commitment.creator,
    nonce: commitment.nonce,
    imageHash: commitment.imageHash,
    sourceHash: print.sourceHash,
    cleanHash: record.clean.sha256,
    styledHash: record.styled.sha256,
    capturedAtMs: record.capturedAtMs,
    width: print.width,
    height: print.height,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      SeekerCamera.attestPublication(canonicalize(manifest as unknown as JcsValue)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("attestation timed out")), TIMEOUT_MS);
      }),
    ]);
    if (!result.available) return { status: "unavailable", reason: result.reason };
    const bundle: AttestationBundle = {
      schema: ATTESTATION_SCHEMA,
      manifest,
      signature: result.signature,
      certificates: result.certificates,
    };
    const size = new TextEncoder().encode(canonicalize(bundle as unknown as JcsValue)).length;
    if (size > MAX_BUNDLE_BYTES) return { status: "unavailable", reason: `attestation bundle too large (${size} bytes)` };
    // Never write a chain the reader would refuse.
    const read = readAttestationBundle(bundle, commitment);
    return { status: "attested", attestation: read };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
