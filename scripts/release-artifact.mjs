// Checks `release-apk.mjs` runs around Gradle, split out so `check-runtime-behavior.mjs` can test
// them on a synthetic zip. Plain Node, no dependencies.
import { crc32, inflateRawSync } from "node:zlib";

/** Same as `refusedEnvFiles` in `check-release-config.ts`, re-run right before Gradle bundles. */
export function refusedEnvFiles(names) {
  return names.filter((name) => /^\.env(?:\.production)?$|^\.env(?:\..+)?\.local$/.test(name)).sort();
}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/**
 * Entry `name` from a zip, inflated and CRC-checked, or `null`. Entries are located via the central
 * directory because an APK's signing block sits before it
 * (https://source.android.com/docs/security/features/apksigning/v2). Sizes come from the directory
 * (covers data descriptors); name/extra lengths from the local header (zipalign pads it).
 * Throws on zip64, encryption, or methods other than stored/deflated.
 */
export function readZipEntry(zip, name) {
  let end = -1;
  // 22 bytes, then a comment of at most 65,535.
  for (let at = zip.length - 22; at >= 0 && at >= zip.length - 22 - 0xffff; at--)
    if (zip.readUInt32LE(at) === END_OF_DIRECTORY && at + 22 + zip.readUInt16LE(at + 20) === zip.length) {
      end = at;
      break;
    }
  if (end < 0) throw new Error("not a zip");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error("zip64 is not supported");
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new Error("corrupt zip directory");
    const nameLength = zip.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (zip.toString("utf8", at + 46, at + 46 + nameLength) !== name) {
      at = next;
      continue;
    }
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const stored = zip.readUInt32LE(at + 20);
    const length = zip.readUInt32LE(at + 24);
    const local = zip.readUInt32LE(at + 42);
    if (flags & 1) throw new Error(`${name} is encrypted`);
    if (stored === 0xffffffff || length === 0xffffffff || local === 0xffffffff) throw new Error("zip64 is not supported");
    if (zip.readUInt32LE(local) !== LOCAL_HEADER) throw new Error("corrupt zip entry");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + stored);
    if (raw.length !== stored) throw new Error(`${name} is cut short`);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`${name} uses compression method ${method}`);
    if (data.length !== length || crc32(data) !== crc) throw new Error(`${name} does not match its checksum`);
    return data;
  }
  return null;
}

/**
 * Why the packaged JS bundle is not this build's, or `null`. Env values are not inputs of the RN
 * bundle task, so Gradle can treat a bundle built for another endpoint as up to date
 * (https://docs.gradle.org/current/userguide/incremental_build.html). Metro inlines EXPO_PUBLIC_*
 * as string literals and Hermes stores them verbatim, so a byte search finds this run's `nonce` and
 * RPC URL. Never echoes a value.
 */
export function bundleRefusal(bundle, { nonce, rpcUrl }) {
  const carries = (value) => bundle.includes(Buffer.from(value, "utf8"));
  if (!nonce || !carries(nonce)) return "the packaged bundle is not this build's: Gradle reused an earlier one.";
  if (rpcUrl && !carries(rpcUrl)) return "the packaged bundle does not carry this build's EXPO_PUBLIC_SOLANA_RPC_URL.";
  return null;
}
