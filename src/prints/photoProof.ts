import type { CaptureRecord } from "../../modules/seeker-camera";
import type { Cluster, CoreDraft } from "../../publications/types";
import type { PhotoPublication } from "./photoPresentation";

type Confirmation =
  | "confirmed"
  | "cached"
  | "unconfirmed"
  | "unavailable"
  | "local";

interface ProofFacts {
  confirmation: Confirmation;
  publisher?: string;
  cluster?: Cluster;
  signature?: string;
  transactionUrl?: string;
  explorerUrl?: string;
  capturedHash?: string;
  capturedAtMs?: number;
  reason?: string;
  details: unknown;
}

export type PhotoProof = ProofFacts & (
  | { kind: "core"; draft: CoreDraft | null }
  | { kind: "local" }
);

function transactionUrl(signature: string | undefined, cluster: Cluster | undefined) {
  return signature && cluster
    ? `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${cluster === "devnet" ? "?cluster=devnet" : ""}`
    : undefined;
}

export function hasCorePublication(publication?: PhotoPublication): boolean {
  return !!publication && (!!publication.draft || publication.status !== "local");
}

/** Select a whole record before deriving its facts. */
export function selectPhotoProof(
  record: CaptureRecord,
  publication?: PhotoPublication,
): PhotoProof {
  if (publication && hasCorePublication(publication)) {
    const draft = publication.draft;
    const edition = draft?.edition;
    const view = publication.view;
    const confirmation: Confirmation = publication.status === "published"
      ? "confirmed"
      // A failed local address check can retain the raw draft but cannot justify cached proof.
      : view && draft?.confirmedAt !== undefined
        ? "cached"
        : publication.status === "unavailable"
          ? "unavailable"
          : "unconfirmed";
    const signature = draft?.attempt?.signature;
    // Only the validated view supplies edition links; a saved address alone cannot rebuild one
    // when draft or trust validation failed.
    return {
      kind: "core",
      draft,
      confirmation,
      publisher: edition?.creator,
      cluster: edition?.cluster,
      signature,
      transactionUrl: transactionUrl(signature, edition?.cluster),
      explorerUrl: view?.explorerUrl,
      // Capture facts come from the capture; the published record does not carry them.
      capturedHash: record.styled.sha256,
      capturedAtMs: record.capturedAtMs,
      reason: publication.reason,
      details: edition ?? { status: publication.status, reason: publication.reason },
    };
  }

  return {
    kind: "local",
    confirmation: "local",
    capturedHash: record.styled.sha256,
    capturedAtMs: record.capturedAtMs,
    details: { styledHash: record.styled.sha256, capturedAtMs: record.capturedAtMs },
  };
}
