/**
 * Pure wording helpers shared by the page, the adapter and `scripts/check-site.ts`. No DOM, no
 * network: this module must stay importable under Node so the gate can assert the exact strings
 * the page renders.
 */
import { deviceName, securityLevelName } from "../../publications/core/attestation";
import type { GenesisLine } from "../../publications/core/genesisToken";
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

/**
 * The Genesis Token row, in the app's own words (`proof.genesisStanding` in `src/ui/copy.ts`),
 * keyed by `genesisDisplay`. The document only claims a mint; these are what the page says once
 * mainnet has been asked, or could not be. The mint address is shown under the line whatever the
 * answer.
 */
export const GENESIS_LINE: Record<GenesisLine, string> = {
  checking: "Checking…",
  held: "Held by the publishing wallet.",
  "not-held": "Not held by the publishing wallet.",
  "not-held-now": "Not held by the publishing wallet now.",
  "not-genesis": "Not a Seeker Genesis Token.",
  unavailable: "Couldn’t check.",
};

/** Under the Genesis Token row for a mainnet seal whose mint mainnet still finds to be an SGT. */
export const GENESIS_SEALED = "Verified and sealed by the edition program at publish.";

/**
 * Terms, reports and blocks, in the app's own words (`moderation` in `src/ui/copy.ts`). `hidden`
 * and `blocked` stand in for the picture's title when the publication is veiled.
 */
export const MODERATION_WORDS = {
  terms: "Terms",
  agree: "Agree",
  report: "Report",
  block: "Block",
  unblock: "Unblock",
  blocked: "Blocked",
  hidden: "Hidden",
} as const;

/** What the device row says for a plain document that carries no attestation. */
export const NO_DEVICE = "No device attestation.";
/** The device row when the document carries evidence the reader set aside. */
export const deviceProblem = (problem: string) => `Device attestation not accepted: ${problem}`;
