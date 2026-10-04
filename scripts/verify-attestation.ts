/**
 * Off-device verifier for `seedshot-attestation/1`. Everything the phone cannot honestly claim
 * about itself is checked here, from the published bytes alone:
 *
 *   1. The document (from Arweave by edition, or a local file) and, by edition, that its bytes
 *      hash to the on-chain `metadata_hash`.
 *   2. The bundle, through the app's own reader: manifest names this edition, challenge is the
 *      manifest's SHA-256, signature verifies under the leaf key, key is hardware-backed.
 *   3. The certificate chain: each certificate signed by the next, dates valid, and the last
 *      one's public key equal to one of Google's published attestation roots.
 *   4. Revocation: no certificate serial on https://android.googleapis.com/attestation/status
 *      (skipped with --offline).
 *   5. The attested app: package name and signer digest against `RELEASE_APP`, the pin from
 *      dapp-store/signing-certificate.json (a debug build fails this one; reported, not hidden).
 *   6. The verdict: what the app's Proof sheet says for these inputs
 *      (`deviceVerdict`), so a disagreement with the checks above shows here.
 *
 * Usage:
 *   npx tsx scripts/verify-attestation.ts --edition <address> [--cluster devnet|mainnet-beta] [--rpc <url>]
 *   npx tsx scripts/verify-attestation.ts --file <document.json> [--at <ISO date>] [--offline]
 *
 * Certificate validity is judged at publication time (see `validAt`); `--at` overrides it, also
 * with `--edition`, and the `chain` line names which time was used.
 *
 * Exit code 0 only when every check passes: a hardware-protected key on a device Google's
 * attestation chain vouches for signed this publication's manifest. That does not mean the camera
 * sensor produced the image.
 */

import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  deviceName,
  deviceVerdict,
  readAttestationBundle,
  RELEASE_APP,
  revocationHits,
  securityLevelName,
  type ManifestCommitment,
  type RevocationList,
} from "../publications/core/attestation";
import { GOOGLE_STATUS_URL as STATUS_URL, publicationTime, readRevocationList } from "../publications/core/attestationCheck";
import { parseCertificate } from "../src/seeker/keyAttestation";
import { loadEdition } from "../publications/editions";
import { CANDY_MACHINE_PROGRAM } from "../publications/candy/programs";
import { arweaveBytes } from "../publications/rpc";
import type { Cluster } from "../publications/types";

const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); };

function pinnedRootKeys(): string[] {
  const pem = readFileSync(resolve(here, "attestation-roots.pem"), "utf8");
  return [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)]
    .map((m) => new X509Certificate(m[0]).publicKey.export({ type: "spki", format: "der" }).toString("hex"));
}

/**
 * When the chain must have been valid. Google's device and intermediate attestation certificates
 * are short-lived (a Seeker's StrongBox certificate lives 13 days), so a chain is judged at
 * PUBLICATION time, never "now": by edition, its `published_at`, or on a legacy deployment the
 * block time of the transaction that created the publisher's claim receipt (`publicationTime`,
 * which the app uses too); by file, `--at <ISO date>` or, failing that, now.
 */
let validAt: { time: Date; source: string } = { time: new Date(), source: "now (no publication time known)" };
if (arg("at")) {
  const t = new Date(arg("at")!);
  if (Number.isNaN(t.getTime())) throw new Error("--at needs an ISO date");
  validAt = { time: t, source: "--at" };
}

async function publishedAt(rpc: string, program: string, edition: string): Promise<void> {
  if (arg("at")) return;
  const source = "block time of the transaction that created the candy machine";
  try {
    validAt = { time: await publicationTime(rpc, program, edition), source };
  } catch (error) {
    throw new Error(`publication time: ${error instanceof Error ? error.message : String(error)} (use an archival --rpc, or pass --at)`);
  }
}

async function loadDocument(): Promise<{ json: unknown; expected: ManifestCommitment | null }> {
  const file = arg("file");
  if (file) {
    let json: unknown = JSON.parse(readFileSync(file, "utf8"));
    // A bare bundle (like scripts/fixtures/attestation-sample.json) is wrapped as a document.
    if ((json as Record<string, unknown>).schema === "seedshot-attestation/1") {
      const { schema, manifest, signature, certificates } = json as Record<string, unknown>;
      json = { properties: { seedshot: { schema, manifest, signature, certificates } } };
    }
    const o = json as Record<string, unknown>;
    // A local file cannot be checked against chain state; the manifest is taken as the commitment.
    const manifest = ((o.properties as Record<string, unknown> | undefined)?.seedshot as Record<string, unknown> | undefined)?.manifest as ManifestCommitment | undefined;
    if (!manifest) throw new Error("the file has no properties.seedshot.manifest");
    check("chain-state", false, "a local file was given: on-chain commitment NOT checked (use --edition)");
    return { json, expected: manifest };
  }
  const edition = arg("edition");
  if (!edition) throw new Error("give --edition <address> or --file <document.json>");
  const cluster = (arg("cluster") ?? "devnet") as Cluster;
  const rpc = arg("rpc") ?? (cluster === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet.solana.com");
  const verdict = await loadEdition(rpc, edition);
  if (!verdict.ok) throw new Error(`edition ${edition}: ${verdict.reason}`);
  const program = CANDY_MACHINE_PROGRAM;
  await publishedAt(rpc, program, edition);
  const bytes = await arweaveBytes(verdict.uri.split("/").pop()!);
  check("chain-state", true, `document read from the edition's URI ${verdict.uri}`);
  const json = JSON.parse(new TextDecoder().decode(bytes));
  const nonce = json?.properties?.seedshot?.manifest?.nonce ?? "";
  const imageHash = Array.from(verdict.imageSha256, (x: number) => x.toString(16).padStart(2, "0")).join("");
  return {
    json,
    expected: { cluster, program, edition, collection: verdict.collection, creator: verdict.publisher, nonce, imageHash },
  };
}

async function main() {
  const { json, expected } = await loadDocument();
  const doc = json as Record<string, unknown>;
  const bundleValue = (doc.properties as Record<string, unknown> | undefined)?.seedshot;
  if (!bundleValue) throw new Error("this document carries no attestation");

  // 2. The app's reader: manifest, challenge, signature, hardware level, and the chain to a
  // Google root with the app's own pure-JS verifier (Node's X.509 check below is the second
  // opinion). A document the app would set aside stops here.
  const { bundle, summary } = readAttestationBundle(bundleValue, expected!);
  check("bundle", true, `${arg("file") ? "manifest taken from the file, NOT checked against chain state" : "manifest names the edition"}; challenge and signature verify; ${securityLevelName(summary)}; the app's chain check reached a Google root`);
  check("device", true, `${deviceName(summary)} (${summary.manufacturer} / ${summary.model} / ${summary.brand})`);
  check("boot", summary.verifiedBoot === "verified" && summary.deviceLocked,
    `verified boot: ${summary.verifiedBoot}, bootloader ${summary.deviceLocked ? "locked" : "unlocked"}`);

  // 3. The chain.
  const ders = bundle.certificates.map((b64) => Buffer.from(b64, "base64"));
  const certs = ders.map((der) => new X509Certificate(der));
  const at = validAt.time;
  let chainOk = certs.length >= 2;
  const notes: string[] = certs.length >= 2 ? [] : ["a chain needs at least two certificates"];
  for (let i = 0; i < certs.length; i += 1) {
    const cert = certs[i];
    const last = i === certs.length - 1;
    const issuer = last ? cert : certs[i + 1];
    // `checkIssued` is not redundant with `verify`: OpenSSL's X509_check_issued behind it also
    // enforces the issuer's CA basic constraint, keyCertSign and name/key-id matching.
    const signed = cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
    const dated = new Date(cert.validFrom) <= at && at <= new Date(cert.validTo);
    if (!signed) notes.push(last ? `the last certificate is not self-signed` : `certificate ${i} is not issued and signed by certificate ${i + 1}`);
    if (!dated) notes.push(`certificate ${i} was not valid at ${at.toISOString()} (${cert.validFrom} to ${cert.validTo})`);
    chainOk &&= signed && dated;
  }
  check("chain", chainOk, `${notes.length ? notes.join("; ") : `${certs.length} certificates, each issued and signed by the next`}; validity judged at ${at.toISOString()} (${validAt.source})`);
  const rootKey = certs[certs.length - 1].publicKey.export({ type: "spki", format: "der" }).toString("hex");
  const roots = pinnedRootKeys();
  check("root", roots.includes(rootKey), roots.includes(rootKey)
    ? "Node's X.509 check agrees: the chain ends at a Google attestation root (scripts/attestation-roots.pem)"
    : "the chain does NOT end at a Google attestation root");
  // The leaf through the app's parser and through Node's: both must read the same public key,
  // so a parser disagreement cannot let a different key's signature pass the app.
  const leaf = parseCertificate(new Uint8Array(ders[0]));
  const jwk = certs[0].publicKey.export({ format: "jwk" });
  const nodeKey = "04" + Buffer.from(String(jwk.x), "base64url").toString("hex") + Buffer.from(String(jwk.y), "base64url").toString("hex");
  const appKey = leaf.publicKey.kind === "ec" ? bytesToHex(leaf.publicKey.point) : "";
  check("leaf-key", appKey === nodeKey,
    `app and Node parsers agree on the leaf key; attestation version ${leaf.keyDescription?.attestationVersion}, OS ${leaf.keyDescription?.osVersion ?? "?"}, patch ${leaf.keyDescription?.osPatchLevel ?? "?"}`);

  // 4. Revocation, through the readers' own parser and lookup: the documented key is lowercase
  // hex without leading zeros, but the live list keys more than half its entries by DECIMAL
  // serial, so both spellings are looked up (`revocationHits`). The serials are the app parser's;
  // Node's must agree, or the lookup would be asked about the wrong numbers.
  let list: RevocationList | null = null;
  const serialsAgree = certs.every((c, i) => c.serialNumber.toLowerCase().replace(/^0+(?=.)/, "") === summary.certificates[i]?.serial);
  if (!serialsAgree) check("serials", false, "the app's parser and Node's disagree on a certificate serial");
  if (flag("offline")) check("revocation", false, "skipped (--offline)");
  else {
    list = await readRevocationList(STATUS_URL);
    const hits = revocationHits(summary, list);
    check("revocation", hits.length === 0, hits.length
      ? hits.map(([key, status]) => `serial ${key}: ${status} ${list!.get(key)?.reason ?? ""}`.trim()).join("; ")
      : `none of the ${certs.length} certificate serials (hex or decimal) is on ${STATUS_URL} (${list.size} entries)`);
  }

  // 5. The app. The keystore attests every package of the calling UID and every signer, so the
  // sets must be exactly the release package and exactly its key: a shared-UID neighbour or a
  // second signer would otherwise ride along.
  const appOk = summary.packageNames.length === 1 && summary.packageNames[0] === RELEASE_APP.packageName
    && summary.signerDigests.length === 1 && summary.signerDigests[0] === RELEASE_APP.signerDigest;
  check("app", appOk, appOk
    ? `attested app is exactly ${RELEASE_APP.packageName} signed by exactly the release key`
    : `attested packages [${summary.packageNames.join(", ")}] / signers [${summary.signerDigests.join(", ")}] are not exactly the release build (${RELEASE_APP.packageName} / ${RELEASE_APP.signerDigest})`);

  // 6. What the app says for exactly these inputs.
  const verdict = deviceVerdict(summary, validAt.time, list);
  check("verdict", verdict.status === "verified", verdict.status === "verified"
    ? `readers show "Signed on a ${deviceName(summary)}"`
    : verdict.status === "refused"
      ? `readers show "Not accepted: ${verdict.reason}"`
      : `readers show "Couldn't check." (no revocation list)`);

  console.log(`manifest sha256 ${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(bundle.manifest))))} (informational)`);
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(12)} ${c.detail}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length
    ? `\n${failed.length} check(s) failed.`
    : "\nAll checks passed: a hardware-protected key on a Google-attested device signed this publication's manifest. That is not camera-origin evidence.");
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(12)} ${c.detail}`);
  console.error(`\nERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
