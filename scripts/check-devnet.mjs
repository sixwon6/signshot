// Read-only checks against the app's devnet configuration. Never signs or sends a transaction.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadProjectEnv, setNodeEnv } from "@expo/env";

const requireOffers = process.argv.includes("--require-offers");
assert.ok(process.argv.slice(2).every(arg => arg === "--require-offers"),
  "Usage: npm run devnet:check -- [--require-offers]");
setNodeEnv("development");
loadProjectEnv(process.cwd());
assert.equal(process.env.EXPO_PUBLIC_SOLANA_CLUSTER, "devnet",
  "Set EXPO_PUBLIC_SOLANA_CLUSTER=devnet before checking this test build");

const { configuredProgram, programFeatures } = await import("../publications/deployments.ts");
const { deploymentStatus } = await import("../publications/programImage.ts");
const { request } = await import("../publications/rpc.ts");
const { MPL_CORE } = await import("../publications/core/protocol.ts");
const { APP_IDENTITY } = await import("../src/solana/appIdentity.ts");
const endpoint = "https://api.devnet.solana.com";
const checks = [];
async function check(name, run) {
  try {
    const details = await run();
    checks.push({ name, passed: true, details });
    console.log(`PASS ${name}: ${details}`);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    checks.push({ name, passed: false, details });
    console.error(`FAIL ${name}: ${details}`);
  }
}

// The hard-coded test endpoint is verified before any program/account checks.
await check("Devnet network", async () => {
  assert.equal(await request(endpoint, "getGenesisHash", []),
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  return "genesis verified; no transactions submitted";
});
let program;
await check("Configured program", async () => {
  program = String(configuredProgram("devnet"));
  return program;
});
if (checks.every(check => check.passed)) {
  await check("Executable program and reviewed bytes", async () => {
    const { value } = await request(endpoint, "getAccountInfo",
      [program, { encoding: "base64", commitment: "confirmed" }]);
    assert.equal(value?.executable, true, "Configured program is not executable");
    const status = await deploymentStatus(endpoint, program, "devnet");
    assert.equal(status.available, true, "Cannot read deployed program bytes");
    assert.equal(status.matchesPin, true, "Deployed bytes do not match the reviewed pin");
    return `${status.bytes} bytes; SHA-256 ${status.sha256}; ${status.upgradeable ? "upgradeable" : "immutable"}`;
  });
  await check("Metaplex Core", async () => {
    const { value } = await request(endpoint, "getAccountInfo",
      [MPL_CORE, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }]);
    assert.equal(value?.executable, true, "Metaplex Core is not executable on devnet");
    return "available";
  });
  await check("Paid editions", async () => {
    const supported = programFeatures(program).offers;
    if (requireOffers) assert.equal(supported, true,
      "This is the legacy program. Deploy and verify the current build before testing sales.");
    return supported ? "client recognizes offers; live buy/set_offer acceptance still required"
      : "legacy deployment: free editions only; sales unavailable";
  });
}

await check("Wallet identity icon", async () => {
  const response = await fetch(new URL(APP_IDENTITY.icon, `${APP_IDENTITY.uri}/`),
    { signal: AbortSignal.timeout(15_000) });
  try {
    assert.equal(response.status, 200, `Identity icon returned HTTP ${response.status}`);
    assert.match(response.headers.get("content-type") ?? "", /^image\//,
      "Identity icon URL does not serve an image");
    return "public image reachable";
  } finally {
    await response.body?.cancel();
  }
});
await check("Public photo page", async () => {
  const response = await fetch(`${APP_IDENTITY.uri}/collect/`,
    { signal: AbortSignal.timeout(15_000), redirect: "error" });
  try {
    assert.equal(response.status, 200,
      `Public photo page returned HTTP ${response.status}; shared links must open without a password`);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i,
      "Public photo page does not serve HTML");
    return "public collection page reachable without authentication";
  } finally {
    await response.body?.cancel();
  }
});
await check("Android App Links association", async () => {
  const response = await fetch(`${APP_IDENTITY.uri}/.well-known/assetlinks.json`,
    { signal: AbortSignal.timeout(15_000), redirect: "error" });
  assert.equal(response.status, 200, `Association returned HTTP ${response.status}`);
  const entries = await response.json();
  assert.ok(Array.isArray(entries) && entries.some(entry =>
    entry.target?.namespace === "android_app" && entry.target?.package_name === "app.seekershot" &&
    entry.relation?.includes("delegate_permission/common.handle_all_urls") &&
    entry.target?.sha256_cert_fingerprints?.length > 0),
    "No App Links association for app.seekershot with certificate fingerprints");
  return "package listed; compare release certificate and test collect links on phone";
});

mkdirSync(".expo", { recursive: true });
writeFileSync(".expo/devnet-check.json", JSON.stringify({ checkedAt: new Date().toISOString(),
  cluster: "devnet", program, requireOffers, checks,
  scope: "Read-only configuration checks. Does not verify wallet approval or transaction lifecycles." }, null, 2));
if (checks.some(check => !check.passed)) process.exitCode = 1;
