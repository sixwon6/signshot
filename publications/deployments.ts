/**
 * Which `era_editions` program is trusted, per cluster. DEPLOYMENTS is the one program new
 * publications use (empty disables publishing); TRUSTED is every program whose records may still
 * be read. `EXPO_PUBLIC_EDITIONS_*` variables can only select an address already listed here.
 */

import { address, type Address } from "@solana/kit";
import type { Cluster } from "./types";
import { safeErrorText } from "../src/ui/errorText";

export const CLUSTERS: readonly Cluster[] = ["devnet", "mainnet-beta"];

/**
 * Build placeholder addresses that are never a real deployment; refused everywhere. The
 * `era_editions` entry is base58 of `sha256("era_editions placeholder 2026-09-08")`.
 */
export const PLACEHOLDER_PROGRAMS: readonly string[] = [
  // Anchor's default `declare_id!`.
  "Fg6PaFpoGXkYsidMpWxTWqkZzdBmPzQjQJYqKQUT8uJP",
  // An unused build identity: never a deployment.
  "DVHqqZ1fq64WpbvuyVPoEuNkg8qRcsJbaEqjea4XWXGu",
  // The `era_editions` build placeholder.
  "Ds4LT9zQ3a9V9ZxqKgwYQxskh1DgeYPhoCYz5iHjAizE",
];

/**
 * Reviewed deployments whose records may be read, transferred and recovered. Listing one here
 * does not enable publishing; that is `DEPLOYMENTS`.
 */
export const HISTORICAL: Record<Cluster, readonly string[]> = {
  // The devnet acceptance deployment. It is still upgradeable, so PROGRAM_IMAGES pins its
  // reviewed ELF digest. Devnet only: a mainnet override naming it is refused.
  devnet: [
    "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU",
    "BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq",
  ],
  "mainnet-beta": [],
};

/**
 * The reviewed ELF digest per address. An upgradeable program's bytes can change under the same
 * address; `programImage.ts` compares against this pin and only warns on a mismatch.
 */
type ProgramImage = {
  /** SHA-256 of the deployed ELF. */
  sha256: string;
  bytes: number;
  /** Where that digest was written down and by whom. */
  source: string;
};

export const PROGRAM_IMAGES: Record<Cluster, Record<string, ProgramImage>> = {
  devnet: {
    // Byte-verified current build with paid sales, deployed 2026-09-16.
    "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU": {
      sha256: "aa59dbe513a5628b2c8944e8d36d9a250a723ddbf525d9776b5b290562a1aacf",
      bytes: 438_912,
      source: "2026-09-16 devnet acceptance build, publications/devnet session",
    },
    // The devnet acceptance deployment.
    BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq: {
      sha256: "c3566d45ef4bdd4ad03dc8ee4cf25ebdf74fe83033cdadfc5d16289626deb105",
      bytes: 391_960,
      source: "devnet acceptance build",
    },
  },
  "mainnet-beta": {},
};

/** The reviewed image for `program`, on `cluster` or on any cluster that lists it. */
export function pinnedImage(program: string, cluster?: Cluster): ProgramImage | null {
  for (const candidate of cluster ? [cluster] : CLUSTERS) {
    const image = PROGRAM_IMAGES[candidate]?.[program];
    if (image) return image;
  }
  return null;
}

/** The configured program for a fresh publication. Empty disables publishing on that cluster. */
export const DEPLOYMENTS: Record<Cluster, string> = {
  // Unconfigured by default. A devnet build selects the HISTORICAL entry with
  // EXPO_PUBLIC_EDITIONS_DEVNET_PROGRAM.
  devnet: "",
  "mainnet-beta": "",
};

/** Metro inlines `EXPO_PUBLIC_*` only for a literal `process.env.NAME` access, so each is spelt out. */
const CONFIGURED: Record<Cluster, string | undefined> = {
  devnet: process.env.EXPO_PUBLIC_EDITIONS_DEVNET_PROGRAM,
  "mainnet-beta": process.env.EXPO_PUBLIC_EDITIONS_MAINNET_PROGRAM,
};

const VARIABLE: Record<Cluster, string> = {
  devnet: "EXPO_PUBLIC_EDITIONS_DEVNET_PROGRAM",
  "mainnet-beta": "EXPO_PUBLIC_EDITIONS_MAINNET_PROGRAM",
};

/** Every reviewed program for `cluster`: the configured default plus history, placeholders removed. */
function reviewedPrograms(cluster: Cluster): readonly string[] {
  const listed = [DEPLOYMENTS[cluster], ...HISTORICAL[cluster]];
  return [...new Set(listed.filter((v) => Boolean(v) && !PLACEHOLDER_PROGRAMS.includes(v)))];
}

/**
 * An override may only select an address already listed for the same cluster; anything else
 * throws at module load. `.env.local` is gitignored, so an unlisted value would never be reviewed.
 */
function selected(cluster: Cluster): string | undefined {
  const value = CONFIGURED[cluster];
  if (!value) return undefined;
  if (!reviewedPrograms(cluster).includes(value))
    throw new Error(
      `${VARIABLE[cluster]} names ${value}, which is not a reviewed ${cluster} deployment. ` +
        "An override may only select a program already listed in publications/deployments.ts.",
    );
  return value;
}

const OVERRIDES: Record<Cluster, string | undefined> = {
  devnet: selected("devnet"),
  "mainnet-beta": selected("mainnet-beta"),
};

function unavailable(): never {
  throw new Error(
    "Publishing an edition is not enabled on this network yet. You can still edit and save your photo.",
  );
}

/** A reviewed program address, or a readable refusal. */
export function programAddress(value?: string): Address {
  if (!value || PLACEHOLDER_PROGRAMS.includes(value)) unavailable();
  return address(value);
}

/** The program a NEW publication uses on `cluster`. Throws when publishing is unavailable. */
export function configuredProgram(cluster: Cluster): Address {
  return programAddress(OVERRIDES[cluster] || DEPLOYMENTS[cluster]);
}

/** Never throws: publishing availability is a screen state, not an error path. */
export function publishingAvailability(cluster: Cluster): {
  enabled: boolean;
  reason?: string;
} {
  try {
    configuredProgram(cluster);
    return { enabled: true };
  } catch (error) {
    return { enabled: false, reason: safeErrorText(error) };
  }
}

function trusted(cluster: Cluster): readonly string[] {
  const candidates = [OVERRIDES[cluster], ...reviewedPrograms(cluster)];
  const seen: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || PLACEHOLDER_PROGRAMS.includes(candidate) || seen.includes(candidate))
      continue;
    // A malformed configured address fails at module load, not when a transaction is sent.
    address(candidate);
    seen.push(candidate);
  }
  return seen;
}

/** Every program whose records this build will still read, per cluster. */
export const TRUSTED: Record<Cluster, readonly string[]> = {
  devnet: trusted("devnet"),
  "mainnet-beta": trusted("mainnet-beta"),
};

/** May this build read a record that names `program`? Garbage input answers `false`, never throws. */
export function isTrustedDeployment(cluster: Cluster, program: string): boolean {
  const list = TRUSTED[cluster];
  return Boolean(program) && Array.isArray(list) && list.includes(program);
}

/**
 * Deployments that predate paid sales, listed by address.
 *
 * `era_editions` gained the `Offer` account, `set_offer` and `buy` AFTER this program was deployed,
 * and the same change widened `collect` from seven accounts to eight. A Solana program's account
 * list is part of its interface, so sending the new eight-account `collect` to the old binary would
 * be rejected, and sending `set_offer` to it would hit an instruction it does not implement.
 *
 * The deployed devnet acceptance program is that old build. It is upgradeable, but the owner ships
 * the new build to a NEW address (a layout change must be a new address — see the pinned-length
 * note in `core/protocol.ts`), so every future entry in this file has offers and this list stays
 * exactly one address long. That is why the default answer is `offers: true`: a deployment added
 * later must not have to be remembered here to work.
 */
export const LEGACY_WITHOUT_OFFERS: readonly string[] = [
  "BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq",
];

/**
 * Deployments that predate the Seeker Genesis Token accounts on `publish` and `publish_in_album`.
 *
 * The build after these takes two more accounts at the END of both instructions — the creator's
 * Genesis Token mint and their token account for it, or the program id in each place — verifies
 * them and seals the mint into the collection's locked attributes (`seeker_genesis_token`). The
 * instruction data and the accounts before them are unchanged. Like `LEGACY_WITHOUT_OFFERS`, this
 * lists only what was deployed before, so a deployment added later needs no entry.
 */
export const LEGACY_WITHOUT_GENESIS: readonly string[] = [
  "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU",
  "BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq",
];

/** What a given `era_editions` deployment can do. Garbage input answers all `true`, never throws. */
export function programFeatures(program: string): { offers: boolean; genesis: boolean } {
  return {
    offers: !LEGACY_WITHOUT_OFFERS.includes(program),
    genesis: !LEGACY_WITHOUT_GENESIS.includes(program),
  };
}
