import { useEffect, useState } from "react";
import { DEVICE_REFUSAL, type AttestationSummary, type DeviceVerdict } from "../../publications/core/attestation";
import {
  checkDevice,
  GOOGLE_STATUS_URL,
  publicationTime,
  readRevocationList,
} from "../../publications/core/attestationCheck";
import type { CoreMetadata } from "../../publications/types";
import { RPC_ENDPOINT } from "../solana/cluster";
import { proof as copy } from "../ui/copy";

export type DeviceCheck = DeviceVerdict | { status: "checking" };

/**
 * Checks the attested device against Google's revocation list, as of the on-chain publication
 * time once `published`, otherwise now (the send path renews near-expiry chains). Null when the
 * document carries no accepted attestation.
 */
export function useDeviceVerdict(edition: CoreMetadata | null | undefined, published: boolean): DeviceCheck | null {
  const summary = edition?.attestation;
  const key = edition && summary
    ? `${edition.edition}:${published}:${summary.certificates.map((c) => c.serial).join()}`
    : null;
  const [check, setCheck] = useState<{ key: string; value: DeviceVerdict } | null>(null);

  useEffect(() => {
    if (!edition || !summary || !key) return;
    let live = true;
    checkDevice(summary, {
      revocationList: () => readRevocationList(GOOGLE_STATUS_URL),
      publishedAt: published
        ? () => publicationTime(RPC_ENDPOINT, edition.program, edition.edition)
        : async () => new Date(),
    }).then(
      (verdict) => {
        // A draft is judged now, not at publication.
        const value: DeviceVerdict = !published && verdict.status === "refused" && verdict.reason === DEVICE_REFUSAL.expired
          ? { status: "refused", reason: DEVICE_REFUSAL.expiredDraft }
          : verdict;
        if (live) setCheck({ key, value });
      },
      () => {
        if (live) setCheck({ key, value: { status: "unchecked" } });
      },
    );
    return () => {
      live = false;
    };
    // `key` covers every input; the objects themselves are re-created on every read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return null;
  return check?.key === key ? check.value : { status: "checking" };
}

export function deviceValue(
  edition: CoreMetadata,
  check: DeviceCheck | null,
  verified: (summary: AttestationSummary) => string,
): string {
  const summary = edition.attestation;
  if (!summary)
    return edition.attestationProblem ? copy.attestationProblem(edition.attestationProblem) : copy.attestationNone;
  if (!check || check.status === "checking") return copy.attestationChecking;
  if (check.status === "verified") return verified(summary);
  if (check.status === "refused") return copy.attestationProblem(check.reason);
  return copy.attestationUnchecked;
}
