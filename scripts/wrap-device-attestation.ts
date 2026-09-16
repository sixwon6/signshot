/**
 * Wraps a `PublicationAttestationTest` export (the native result: signature and certificates)
 * with the sample manifest into a `seedshot-attestation/1` bundle, for `verify-attestation.ts
 * --file`. Usage: npx tsx scripts/wrap-device-attestation.ts <native-result.json> <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: wrap-device-attestation.ts <native-result.json> <out.json>");
const native = JSON.parse(readFileSync(input, "utf8")) as { available: boolean; reason?: string; strongBox?: boolean; signature?: string; certificates?: string[] };
if (!native.available) throw new Error(`device reported attestation unavailable: ${native.reason}`);
const { manifest } = JSON.parse(readFileSync(resolve(here, "fixtures", "attestation-sample.json"), "utf8")) as { manifest: unknown };
writeFileSync(output, JSON.stringify({
  note: `Real device export (strongBox=${native.strongBox}); manifest is the synthetic sample.`,
  schema: "seedshot-attestation/1",
  manifest,
  signature: native.signature,
  certificates: native.certificates,
}, null, 2) + "\n");
console.log(`wrote ${output} (${native.certificates?.length} certificates, strongBox=${native.strongBox})`);
