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
  // Devnet acceptance deployments. Each is still upgradeable, so PROGRAM_IMAGES pins its reviewed
  // ELF digest and upgrade authority. A mainnet override naming one is refused.
  devnet: [
    "4Rk11vaKzxqJhX1kkScRuJ4PKuPnjik6LHwus4J67ipM",
    "BrRJzFDzJKg3zrvyYQ3wkhAQuJwbVZtGhqAox8RfjqC",
    "A1fnWjJD7LcHeksyVPiZrUhLoj6T78bEC24iGgf1SLAz",
    "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU",
    "BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq",
  ],
  "mainnet-beta": [],
};

/**
 * The reviewed image per address: the ELF digest and who may replace it. An upgradeable program's
 * bytes can change under the same address, and a signer's privileges reach every program it
 * calls, so publish, collect and buy refuse unless the deployed bytes hash to `sha256` and the
 * upgrade authority is `upgradeAuthority` (`programImage.ts`). Every trusted program needs one;
 * `npm test` refuses a trusted address without it.
 */
export type ProgramImage = {
  /**
   * SHA-256 of the ProgramData account's bytes after its 45-byte header, read from the deployed
   * account: the ELF alone only while the account's space is exactly 45 + the ELF's length.
   */
  sha256: string;
  /** The account's space − 45. */
  bytes: number;
  /** The ProgramData account's upgrade authority, or `null` for an immutable program. */
  upgradeAuthority: string | null;
  /** Where that digest was written down and by whom. */
  source: string;
};

export const PROGRAM_IMAGES: Record<Cluster, Record<string, ProgramImage>> = {
  devnet: {
    // The Seeker-only publish rule (6caa4a2, devnet-genesis build). Upgrade authority: the
    // in-memory payer of the devnet session that deployed it.
    "4Rk11vaKzxqJhX1kkScRuJ4PKuPnjik6LHwus4J67ipM": {
      sha256: "b4cdd1dbb6ec209f079b20ff574b83435d95e87ee1e9e19ca82bc81a404f67a0",
      bytes: 427_016,
      upgradeAuthority: "8v29m3t1Moi8mX1EZ73y1MAzjAoNr1bfRnz7N8nd4jyR",
      source: "2026-09-28 devnet acceptance build (Seeker-only publish rule), publications/devnet session",
    },
    // Locked royalties, Seeker-only claims and the creator rule (devnet-genesis build). Upgrade
    // authority: the in-memory payer of the devnet session that deployed it.
    BrRJzFDzJKg3zrvyYQ3wkhAQuJwbVZtGhqAox8RfjqC: {
      sha256: "81dc877aedb1cf4a575c86bab36596fab9a1aae03a19e2112f9f7e296a624f57",
      bytes: 428_552,
      upgradeAuthority: "5bdctsW1eaVUVq25ZWcz2vQN3aSDzaS4UJJmrbkicKQD",
      source: "2026-09-25 devnet acceptance build (royalties, Seeker-only), publications/devnet session",
    },
    // The Genesis Token accounts, the price floor and the recorded publication time
    // (devnet-genesis build). Upgrade authority: the devnet session's in-memory payer, discarded
    // when that session ended.
    A1fnWjJD7LcHeksyVPiZrUhLoj6T78bEC24iGgf1SLAz: {
      sha256: "2abe33410a1d5567715fba96d086364a366bf1865d4586a70d4a4e1ae926bead",
      bytes: 451_856,
      upgradeAuthority: "7Q49ptVZPvbfV5UyXyWuSbbCT727QgTr3Kkuu4einsJ8",
      source: "2026-09-25 devnet acceptance build, publications/devnet session",
    },
    // Paid sales. Authority read from its ProgramData account
    // (BrcFJBrcj18FcPGfFJFZnNJirnaV45LcoRLibm7hqQ2u).
    "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU": {
      sha256: "aa59dbe513a5628b2c8944e8d36d9a250a723ddbf525d9776b5b290562a1aacf",
      bytes: 438_912,
      upgradeAuthority: "6r7wvBV2WR8L1GHJ1FV41j4JrqBxYfxQN3Xj7L2dPAuv",
      source: "2026-09-16 devnet acceptance build, publications/devnet session",
    },
    // Predates paid sales. Authority read from its ProgramData account
    // (3mGafMt6aGVM9Hnxg1zsQ9bVGJKTX5FrwqqQYEPGC11C).
    BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq: {
      sha256: "c3566d45ef4bdd4ad03dc8ee4cf25ebdf74fe83033cdadfc5d16289626deb105",
      bytes: 391_960,
      upgradeAuthority: "7fuyVC4K1hifTmUJhCzdpzf6BpinehZRwNAKhCdXppPK",
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
 * Deployments that predate paid sales. Later builds added the `Offer` account, `set_offer` and
 * `buy`, and widened `collect` from seven accounts to eight; an account list is part of a program's
 * interface, so the old binary rejects both. A layout change ships to a new address (see the
 * pinned-length note in `core/protocol.ts`), so only earlier deployments are listed and a
 * deployment added later reads as `offers: true` with no entry here.
 */
export const LEGACY_WITHOUT_OFFERS: readonly string[] = [
  "BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq",
];

/**
 * Deployments that predate the Seeker Genesis Token accounts on `publish` and `publish_in_album`.
 * Later builds take two more accounts at the END of both instructions — the creator's Genesis
 * Token mint and their token account for it, or the program id in each place — verify them and
 * seal the mint into the collection's locked attributes (`seeker_genesis_token`). The instruction
 * data and the accounts before them are unchanged.
 */
export const LEGACY_WITHOUT_GENESIS: readonly string[] = [
  "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU",
  "BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq",
];

/**
 * Deployments whose `Edition` account predates `published_at`: 8 + 293 bytes, against 8 + 301 for
 * every build after them, which records the Clock's `unix_timestamp` at publish right after `bump`.
 * An edition of one of these has no recorded time, so its publication time is looked for in the
 * creator's claim receipt history instead (`publicationTime` in `core/attestationCheck.ts`).
 */
export const LEGACY_WITHOUT_PUBLISHED_AT: readonly string[] = [
  "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU",
  "BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq",
];

/**
 * Deployments that predate the creator's royalty and Seeker-only editions. Later builds take two
 * more ARGUMENTS at the end of `publish` and `publish_in_album` — `royalty_bps: u16` and
 * `seeker_only: bool` — seal a locked `Royalties` plugin into every new collection, append
 * `seeker_only` to the `Edition` account (8 + 302 bytes), and give `collect` and `buy` the two
 * Genesis Token accounts at the END of their lists, with the claim receipt keyed on the collector's
 * Genesis Token mint on a Seeker-only edition.
 */
export const LEGACY_WITHOUT_ROYALTIES_AND_SEEKER_ONLY: readonly string[] = [
  "A1fnWjJD7LcHeksyVPiZrUhLoj6T78bEC24iGgf1SLAz",
  "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU",
  "BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq",
];

/** What a given `era_editions` deployment can do. Garbage input answers all `true`, never throws. */
export function programFeatures(program: string): {
  offers: boolean;
  genesis: boolean;
  publishedAt: boolean;
  royaltiesAndSeekerOnly: boolean;
} {
  return {
    offers: !LEGACY_WITHOUT_OFFERS.includes(program),
    genesis: !LEGACY_WITHOUT_GENESIS.includes(program),
    publishedAt: !LEGACY_WITHOUT_PUBLISHED_AT.includes(program),
    royaltiesAndSeekerOnly: !LEGACY_WITHOUT_ROYALTIES_AND_SEEKER_ONLY.includes(program),
  };
}
