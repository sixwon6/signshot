/**
 * Build gate: app.json and android/app/build.gradle state the same version.
 *
 *   npx tsx scripts/check-version.ts
 *
 * app.json is the source of truth: prebuild rewrites build.gradle from it (defaulting versionCode
 * to 1 when absent), so a hand bump is silently reverted. Checks, with no device or network:
 *   1. `versionName` in build.gradle === `expo.version`
 *   2. `versionCode` in build.gradle === `expo.android.versionCode` (which must exist)
 *   3. `expo.android.versionCode` exceeds every versionCode in `dapp-store/releases.json`; the dApp
 *      Store rejects an update that does not increase it.
 *
 * Only accepted submissions belong in the record: a versionCode built but never uploaded is still free.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_JSON = resolve(ROOT, "app.json");
const BUILD_GRADLE = resolve(ROOT, "android/app/build.gradle");
const RELEASES = resolve(ROOT, "dapp-store/releases.json");

const REMEDY =
  "app.json is the source of truth. To change the version, edit app.json and run\n" +
  "  `npx expo prebuild -p android` so android/app/build.gradle follows it. Never bump only\n" +
  "  build.gradle: the next prebuild overwrites it from app.json.";

export type AppJson = {
  expo?: { version?: unknown; android?: { versionCode?: unknown } };
};

/** One submitted APK. Every field is required; `releaseProblems` states the rule for each. */
export type Release = {
  versionName?: unknown;
  versionCode?: unknown;
  apkSha256?: unknown;
  certFingerprint?: unknown;
  date?: unknown;
  cluster?: unknown;
};
type Releases = { releases?: unknown };

const SHA256 = /^[0-9a-f]{64}$/;
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLUSTERS = ["mainnet-beta", "devnet"];

/**
 * Check 3, plus the record's shape. Entries must be complete: a partial one would raise the
 * versionCode floor without binding the listing to an APK file and signing key.
 */
function releaseProblems(app: AppJson, record: Releases): string[] {
  const problems: string[] = [];
  const releases = record.releases;
  if (!Array.isArray(releases)) {
    return ["dapp-store/releases.json: `releases` is missing or not an array."];
  }

  const codes: number[] = [];
  releases.forEach((entry: Release, i: number) => {
    const at = `dapp-store/releases.json releases[${i}]`;
    if (typeof entry !== "object" || entry === null) {
      problems.push(`${at} is not an object.`);
      return;
    }
    if (typeof entry.versionName !== "string" || entry.versionName.length === 0) {
      problems.push(`${at}: versionName must be a non-empty string.`);
    }
    if (
      typeof entry.versionCode !== "number" ||
      !Number.isInteger(entry.versionCode) ||
      entry.versionCode < 1
    ) {
      problems.push(`${at}: versionCode must be a positive integer.`);
    } else {
      codes.push(entry.versionCode);
    }
    if (typeof entry.apkSha256 !== "string" || !SHA256.test(entry.apkSha256)) {
      problems.push(`${at}: apkSha256 must be 64 lowercase hex characters.`);
    }
    if (typeof entry.certFingerprint !== "string" || !FINGERPRINT.test(entry.certFingerprint)) {
      problems.push(
        `${at}: certFingerprint must be 32 uppercase hex bytes separated by colons,\n` +
          "    exactly as `apksigner verify --print-certs` and `keytool -list -v` print it.",
      );
    }
    if (typeof entry.date !== "string" || !DATE.test(entry.date)) {
      problems.push(`${at}: date must be YYYY-MM-DD.`);
    }
    if (typeof entry.cluster !== "string" || !CLUSTERS.includes(entry.cluster)) {
      problems.push(`${at}: cluster must be one of ${CLUSTERS.join(", ")}.`);
    }
  });

  // One key for the life of the app: the dApp Store upload key cannot be rotated without losing
  // the ability to update the listing at all.
  const fingerprints = new Set(
    releases
      .map((e: Release) => e.certFingerprint)
      .filter((f): f is string => typeof f === "string" && FINGERPRINT.test(f)),
  );
  if (fingerprints.size > 1) {
    problems.push(
      "dapp-store/releases.json records more than one signing certificate:\n" +
        `    ${[...fingerprints].join("\n    ")}\n` +
        "    Every update must be signed with the key used for the first release.",
    );
  }

  const highest = codes.length === 0 ? 0 : Math.max(...codes);
  const appVersionCode = app.expo?.android?.versionCode;
  if (
    typeof appVersionCode === "number" &&
    Number.isInteger(appVersionCode) &&
    appVersionCode <= highest
  ) {
    problems.push(
      `versionCode ${appVersionCode} has already been submitted (highest recorded: ${highest}).\n` +
        "    Every dApp Store update must carry a strictly greater versionCode\n" +
        "    (docs.solanamobile.com/dapp-store/submit-an-update). Bump expo.android.versionCode in\n" +
        `    app.json to ${highest + 1} or more, then re-run the prebuild so build.gradle follows.`,
    );
  }
  return problems;
}

/** Exactly one match, or the file is not shaped the way this gate assumes. */
function soleMatch(source: string, re: RegExp, what: string): string {
  const found = [...source.matchAll(re)];
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one ${what} in android/app/build.gradle, found ${found.length}. ` +
        `The gate cannot tell which one ships; fix the file or fix this script.`,
    );
  }
  return found[0][1];
}

function main(): void {
  const app = JSON.parse(readFileSync(APP_JSON, "utf8")) as AppJson;
  const gradle = readFileSync(BUILD_GRADLE, "utf8");

  const problems: string[] = [];

  const appVersion = app.expo?.version;
  const appVersionCode = app.expo?.android?.versionCode;

  if (typeof appVersion !== "string" || appVersion.length === 0) {
    problems.push(`app.json: expo.version is missing or not a string (got ${String(appVersion)}).`);
  }
  if (typeof appVersionCode !== "number" || !Number.isInteger(appVersionCode)) {
    problems.push(
      `app.json: expo.android.versionCode is missing or not an integer (got ` +
        `${String(appVersionCode)}). It must live here — prebuild defaults it to 1 otherwise,\n` +
        `    which reverts every bump and gets the next store update rejected.`,
    );
  }

  const gradleVersionName = soleMatch(gradle, /^\s*versionName\s+"([^"]*)"\s*$/gm, "versionName");
  const gradleVersionCode = soleMatch(gradle, /^\s*versionCode\s+(\d+)\s*$/gm, "versionCode");

  if (typeof appVersion === "string" && gradleVersionName !== appVersion) {
    problems.push(
      `versionName disagrees.\n` +
        `    app.json  expo.version   ${appVersion}\n` +
        `    gradle    versionName    ${gradleVersionName}`,
    );
  }
  if (typeof appVersionCode === "number" && Number(gradleVersionCode) !== appVersionCode) {
    problems.push(
      `versionCode disagrees.\n` +
        `    app.json  expo.android.versionCode   ${appVersionCode}\n` +
        `    gradle    versionCode                ${gradleVersionCode}`,
    );
  }

  const record = JSON.parse(readFileSync(RELEASES, "utf8")) as Releases;
  problems.push(...releaseProblems(app, record));

  if (problems.length > 0) {
    console.error(`\nversion check FAILED (${problems.length}):\n`);
    for (const p of problems) console.error(`  - ${p}\n`);
    console.error(REMEDY);
    process.exit(1);
  }

  const submitted = Array.isArray(record.releases) ? record.releases.length : 0;
  console.log(
    `version check ok — ${String(appVersion)} (${String(appVersionCode)}) in app.json and ` +
      `build.gradle, ahead of ${submitted} recorded submitted release${submitted === 1 ? "" : "s"}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (e: unknown) {
    console.error(`version check FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
