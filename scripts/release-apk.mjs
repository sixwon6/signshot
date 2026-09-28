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
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { bundleRefusal, readZipEntry, refusedEnvFiles } from "./release-artifact.mjs";
import { matchesUploadCertificate } from "./signing-certificate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const android = resolve(root, "android");
const wrapper = resolve(android, process.platform === "win32" ? "gradlew.bat" : "gradlew");

/**
 * `release:check` runs first: it resolves the cluster and program this bundle will hand a wallet,
 * refuses env files and unflagged devnet builds, and writes .expo/release/config.json.
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

// The gate ran first, but Expo's bundler reads these files again when Gradle reaches it.
const envFiles = refusedEnvFiles(readdirSync(root));
if (envFiles.length) {
  console.error(`\nrelease:apk refused — ${envFiles.join(", ")} appeared after release:check. Move them and run again.`);
  process.exit(1);
}

// A failed build must not leave last time's APK sitting where a human would pick it up.
const APK = resolve(android, "app", "build", "outputs", "apk", "release", "app-release.apk");
rmSync(APK, { force: true });
// No environment value is an input of the bundle task, so Gradle would call an earlier build's
// bundle up to date. Without its outputs the task must run; the nonce then proves it did.
for (const kind of ["assets", "res"])
  rmSync(resolve(android, "app", "build", "generated", kind, "react", "release"), { recursive: true, force: true });
const nonce = randomBytes(16).toString("hex");

const r = spawnSync(
  process.platform === "win32" ? `"${wrapper}"` : wrapper,
  [":app:assembleRelease", "-PreactNativeArchitectures=arm64-v8a"],
  {
    cwd: android,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, EXPO_PUBLIC_BUILD_NONCE: nonce },
  },
);
if (r.error) console.error(`could not run ${wrapper}: ${r.error.message}`);
if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);

// The bundle inside the APK, against what the gate recorded and this run's environment.
let problem;
try {
  const { cluster } = JSON.parse(readFileSync(resolve(root, ".expo", "release", "config.json"), "utf8"));
  const bundle = readZipEntry(readFileSync(APK), "assets/index.android.bundle");
  problem = bundle
    ? bundleRefusal(bundle, {
        nonce,
        cluster,
        rpcUrl: process.env.EXPO_PUBLIC_SOLANA_RPC_URL,
        devnetPayer: process.env.EXPO_PUBLIC_DEVNET_TEST_PAYER,
      })
    : "the APK has no assets/index.android.bundle.";
} catch (error) {
  problem = `the APK's bundle could not be read (${error instanceof Error ? error.message : String(error)}).`;
}
if (problem) {
  console.error(`\nrelease:apk refused — ${problem} Deleted.`);
  rmSync(APK, { force: true });
  process.exit(1);
}

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
  console.error("\nrelease:apk refused — the APK is not signed by the Signshot upload key. Deleted.");
  rmSync(APK, { force: true });
  process.exit(1);
}
console.log(`\nrelease:apk ok — ${APK}`);
