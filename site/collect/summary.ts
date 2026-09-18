/**
 * Pure wording helpers shared by the page, the adapter and `scripts/check-site.ts`. No DOM, no
 * network: this module must stay importable under Node so the gate can assert the exact strings
 * the page renders.
 */
import { deviceName, securityLevelName } from "../../publications/core/attestation";
import type { AttestationSummary } from "../../publications/types";

/** Lamports as a SOL string with no float arithmetic and no trailing-zero noise. */
export function sol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * The one sentence the page says about the device, in the app's own words (`ProofSheet.tsx`).
 * The certificate names the device, the key's security level and the boot state. It says
 * nothing about what was in front of the lens, and the page never claims otherwise.
 */
export function deviceLine(a: AttestationSummary): string {
  const boot =
    a.verifiedBoot === "verified" && a.deviceLocked
      ? "verified boot, bootloader locked"
      : `boot ${a.verifiedBoot}${a.deviceLocked ? ", bootloader locked" : ", bootloader unlocked"}`;
  return `Signed on a ${deviceName(a)} · ${securityLevelName(a)} · ${boot}`;
}

/** What the device row says for a plain document that carries no attestation. */
export const NO_DEVICE = "No device attestation was recorded for this publication.";
/** The device row when the document carries evidence the reader set aside. */
export const deviceProblem = (problem: string) => `The recorded device attestation was set aside: ${problem}`;
