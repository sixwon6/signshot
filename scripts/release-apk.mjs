// The submission artifact. Release variant, arm64-v8a only (the Seeker is arm64; the emulator's
// x86_64 stays in gradle.properties for debug builds), R8 + resource shrinking on via
// gradle.properties.
//
// Signing: the dApp Store upload key, read by android/app/build.gradle from the four
// SEEDSHOT_UPLOAD_* properties in ~/.gradle/gradle.properties. There is no fallback — a machine
// without the key fails the packaging task with a message naming all four. The debug keystore is
// committed to this repository and the store rejects debug-signed APKs, so "it built something"
// is never good enough here: verify what came out with
//   apksigner verify --print-certs android/app/build/outputs/apk/release/app-release.apk
// and match dapp-store/signing-certificate.json. The existing key's subject predates the rename;
// its certificate fingerprint is the Android identity, not its display name. EAS is not the path for a store build
// (eas.json's dapp-store profile exists so that EAS could never sign with a key of its own).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { matchesUploadCertificate } from "./signing-certificate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const android = resolve(root, "android");
const wrapper = resolve(android, process.platform === "win32" ? "gradlew.bat" : "gradlew");

/**
 * `release:check` runs first: it resolves the cluster and program this bundle will hand a wallet,
 * refuses `.env*.local` files and unflagged devnet builds, and writes .expo/release/config.json.
 * Arguments pass through, e.g. `npm run release:apk -- --allow-cluster devnet`.
 */
const passthrough = process.argv.slice(2);
// Run under this same Node with explicit script paths rather than shelling out to npm: it works
// the same whether this file is invoked via `npm run release:apk` or directly with `node`, and
// it needs no shell (on Windows `npm` is `npm.cmd`, which Node refuses to spawn without one).
const TSX_CLI = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
const gate = spawnSync(
  process.execPath,
  [TSX_CLI, resolve(root, "scripts", "check-release-config.ts"), ...passthrough],
  { cwd: root, stdio: "inherit", shell: false },
);
if (gate.error || (gate.status ?? 1) !== 0) {
  console.error("\nrelease:apk refused — release:check failed. Fix it rather than skipping it.");
  process.exit(gate.status ?? 1);
}

// A failed build must not leave last time's APK sitting where a human would pick it up.
const APK = resolve(android, "app", "build", "outputs", "apk", "release", "app-release.apk");
rmSync(APK, { force: true });

const r = spawnSync(
  process.platform === "win32" ? `"${wrapper}"` : wrapper,
  [":app:assembleRelease", "-PreactNativeArchitectures=arm64-v8a"],
  { cwd: android, stdio: "inherit", shell: process.platform === "win32" },
);
if (r.error) console.error(`could not run ${wrapper}: ${r.error.message}`);
if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);

// The store's own check (docs.solanamobile.com/dapp-store/build-and-sign-an-apk), run here so
// no artifact leaves this script unverified: the signer must be the upload key, never the
// committed debug key.
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const toolsDir = sdk ? resolve(sdk, "build-tools") : null;
const newest = toolsDir && existsSync(toolsDir) ? readdirSync(toolsDir).sort().at(-1) : undefined;
const apksigner =
  toolsDir && newest
    ? resolve(toolsDir, newest, process.platform === "win32" ? "apksigner.bat" : "apksigner")
    : null;
if (!apksigner || !existsSync(apksigner)) {
  console.error("release:apk refused — apksigner not found under $ANDROID_HOME/build-tools.");
  rmSync(APK, { force: true });
  process.exit(1);
}
const v = spawnSync(process.platform === "win32" ? `"${apksigner}"` : apksigner, ["verify", "--print-certs", APK], {
  cwd: android,
  encoding: "utf8",
  shell: process.platform === "win32",
});
const certs = `${v.stdout ?? ""}${v.stderr ?? ""}`;
process.stdout.write(certs);
const uploadCertificate = JSON.parse(readFileSync(resolve(root, "dapp-store/signing-certificate.json"), "utf8"));
if ((v.status ?? 1) !== 0 || !matchesUploadCertificate(certs, uploadCertificate.sha256)) {
  console.error("\nrelease:apk refused — the APK is not signed by the Seedshot upload key. Deleted.");
  rmSync(APK, { force: true });
  process.exit(1);
}
console.log(`\nrelease:apk ok — ${APK}`);
