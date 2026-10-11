// Builds the dApp Store APK: release variant, arm64-v8a only, R8 and resource shrinking on.
//
// Signed with the upload key from the SIGNSHOT_UPLOAD_* properties in ~/.gradle/gradle.properties.
// The debug keystore is committed and the store rejects debug-signed APKs, so the signer is
// verified against dapp-store/signing-certificate.json by SHA-256 fingerprint, not subject name.
// Store builds never go through EAS; eas.json's dapp-store profile only stops EAS signing.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { bundleRefusal, readZipEntry, refusedEnvFiles } from "./release-artifact.mjs";
import { matchesUploadCertificate } from "./signing-certificate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const android = resolve(root, "android");
const wrapper = resolve(android, process.platform === "win32" ? "gradlew.bat" : "gradlew");

// release:check runs first; arguments pass through (`npm run release:apk -- --allow-cluster devnet`).
const passthrough = process.argv.slice(2);
// tsx by path, not via npm: no shell needed (Windows `npm.cmd` cannot be spawned without one).
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

// Re-checked: Expo's bundler reads env files again when Gradle reaches it.
const envFiles = refusedEnvFiles(readdirSync(root));
if (envFiles.length) {
  console.error(`\nrelease:apk refused — ${envFiles.join(", ")} appeared after release:check. Move them and run again.`);
  process.exit(1);
}

// A failed build must not leave a stale APK behind.
const APK = resolve(android, "app", "build", "outputs", "apk", "release", "app-release.apk");
rmSync(APK, { force: true });
// Env values are not inputs of the bundle task, so Gradle may reuse a stale bundle. Deleting its
// outputs forces a rerun; the nonce proves it happened.
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

let problem;
try {
  const bundle = readZipEntry(readFileSync(APK), "assets/index.android.bundle");
  problem = bundle
    ? bundleRefusal(bundle, { nonce, rpcUrl: process.env.EXPO_PUBLIC_SOLANA_RPC_URL })
    : "the APK has no assets/index.android.bundle.";
} catch (error) {
  problem = `the APK's bundle could not be read (${error instanceof Error ? error.message : String(error)}).`;
}
if (problem) {
  console.error(`\nrelease:apk refused — ${problem} Deleted.`);
  rmSync(APK, { force: true });
  process.exit(1);
}

// The store's signer check (docs.solanamobile.com/dapp-store/build-and-sign-an-apk): upload key only.
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
console.log(`sha256 ${createHash("sha256").update(readFileSync(APK)).digest("hex")}`);
