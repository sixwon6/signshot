import { useEffect, useState } from "react";
import { DEVICE_REFUSAL, type AttestationSummary, type DeviceVerdict } from "../../publications/core/attestation";
import {
  checkDevice,
  GOOGLE_STATUS_URL,
  publicationTime,
  readRevocationList,
} from "../../publications/core/attestationCheck";
import { addresses } from "../../publications/core/protocol";
import type { CoreMetadata } from "../../publications/types";
import { RPC_ENDPOINT } from "../solana/cluster";
import { proof as copy } from "../ui/copy";

export type DeviceCheck = DeviceVerdict | { status: "checking" };

/**
 * Whether a screen may name the device a draft's document attests (`deviceVerdict`), checked
 * against Google's revocation list, fetched directly, and at the right time: the block time of
 * the publication transaction once `published`, otherwise now, for a draft not yet sent (the send
 * path renews a chain close to expiry, `src/prints/creator.ts`). Null when the document carries
 * no accepted attestation.
 */
export function useDeviceVerdict(edition: CoreMetadata | null | undefined, published: boolean): DeviceCheck | null {
  const summary = edition?.attestation;
  // Everything the check reads: the edition, which time applies, and the chain itself.
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
        ? async () => {
            const { receipt } = await addresses(edition.program, edition.creator, edition.nonce);
            return publicationTime(RPC_ENDPOINT, edition.program, receipt);
          }
        : async () => new Date(),
    }).then(
      (verdict) => {
        // Judged now, a draft's dates are not yet "at publication".
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
    // `key` names everything the check reads; the objects behind it are re-created on every read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return null;
  return check?.key === key ? check.value : { status: "checking" };
}

/**
 * The Device value, in the app's words: `verified(summary)` only once the check says so; the
 * reason when the reader or the verdict refused; "Checking…" and "Couldn't check." otherwise.
 */
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
