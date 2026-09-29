/**
 * Read one file out of the Expo bare template that `npx expo prebuild` generates `android/` from.
 *
 * `node_modules/expo/template.tgz` is the archive Expo's prebuild unpacks, so it answers "what
 * would a fresh prebuild write here?" without running one. `check-signing.ts` and
 * `check-prebuild.ts` both ask, through this one reader.
 *
 * Gzipped POSIX tar, read with no tar binary: 512-byte headers, name in bytes 0..100, an optional
 * long-path prefix in 345..500, and an octal size in 124..136.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = resolve(ROOT, "node_modules/expo/template.tgz");

/** Read `wanted` (a full archive path, e.g. `package/android/app/build.gradle`) from a .tgz. */
function readTarMember(tgz: Buffer, wanted: string): string {
  const tar = gunzipSync(tgz);
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive blocks
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/s, "");
    const size = parseInt(header.toString("utf8", 124, 136).replace(/\0.*$/s, "").trim(), 8);
    const full = prefix ? `${prefix}/${name}` : name;
    const start = off + 512;
    if (full === wanted) return tar.toString("utf8", start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} not found in node_modules/expo/template.tgz`);
}

/** The same, addressed by the path inside the generated project (`android/app/build.gradle`). */
export function readTemplateMember(projectPath: string): string {
  return readTarMember(readFileSync(TEMPLATE), `package/${projectPath}`);
}
