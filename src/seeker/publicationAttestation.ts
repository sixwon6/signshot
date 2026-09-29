/**
 * The publish-time side of `seedshot-attestation/1`: build the manifest for a draft, have the
 * keystore attest and sign it, and read the result back through the SAME reader every document
 * goes through, so nothing is written that this app could not later read. Never throws and never
 * waits forever: a phone that cannot attest, or does not answer in time, publishes a plain
 * document.
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

/** What happened, for a log line; the publication does not depend on it. */
export type AttestationOutcome =
  | { status: "attested"; attestation: PublicationAttestation }
  | { status: "unavailable"; reason: string };

/**
 * StrongBox key generation takes about a second; remote key provisioning can take longer and can
 * touch the network. Past this, the publication goes ahead without evidence rather than holding
 * the photo's lock and the export queue.
 */
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
    // Read back as a stranger would. A chain this reader refuses is not evidence worth writing.
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
