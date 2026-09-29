/**
 * Builds the public collect page: `site/collect/browser.ts` → `site/dist/collect/collect.js`,
 * then copies `site/public/` into `site/dist/`, the git-ignored directory `wrangler pages deploy`
 * uploads (see `site/README.md`).
 *
 * The bundle uses the app's own reader (`publications/core/*`), so the page and the phone accept
 * exactly the same documents, and trusts the program table in `publications/deployments.ts`.
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const site = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(site, "..");
const dist = resolve(site, "dist");

/**
 * `publications/deployments.ts` reads two overrides as literal `process.env.NAME` accesses, the
 * only form Metro inlines. A browser has no `process`, so both are replaced at build time, with
 * `undefined`: the page trusts only the reviewed table and its build cannot point it elsewhere.
 */
export const DEFINE = {
  "process.env.EXPO_PUBLIC_EDITIONS_DEVNET_PROGRAM": "undefined",
  "process.env.EXPO_PUBLIC_EDITIONS_MAINNET_PROGRAM": "undefined",
};

/**
 * What this build will trust, resolved the way the bundle resolves it: the real registry module,
 * bundled with the same `DEFINE`, then imported. An empty `TRUSTED` would refuse every link
 * without anything else noticing, so it fails the build instead.
 */
const registry = await build({
  entryPoints: [resolve(root, "publications", "deployments.ts")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  define: DEFINE,
});
const { TRUSTED, PROGRAM_IMAGES } = await import(
  "data:text/javascript;base64," + Buffer.from(registry.outputFiles[0].text, "utf8").toString("base64")
);
const clusters = Object.entries(TRUSTED).filter(([, programs]) => programs.length);
if (!clusters.length)
  throw new Error(
    "The collector would trust no program on any cluster and would refuse every link. Commit a " +
      "reviewed address to DEPLOYMENTS or HISTORICAL in publications/deployments.ts (see site/README.md).",
  );
// A trusted program with no reviewed image is refused at every collect and buy
// (`publications/programImage.ts`), so it is a broken page rather than a stricter one.
for (const [cluster, programs] of clusters)
  for (const program of programs) {
    const image = PROGRAM_IMAGES[cluster]?.[program];
    if (!image || !/^[0-9a-f]{64}$/.test(image.sha256) || !(image.bytes > 0) || image.upgradeAuthority === undefined)
      throw new Error(
        `The ${cluster} program ${program} is trusted but has no PROGRAM_IMAGES record (digest, length ` +
          "and upgrade authority) in publications/deployments.ts, so the page would refuse every collect.",
      );
  }

// A clean output directory: a file removed from `public/` must not linger in the next deploy.
await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "collect"), { recursive: true });

const outfile = resolve(dist, "collect", "collect.js");
const bundle = await build({
  entryPoints: [resolve(site, "collect", "browser.ts")],
  outfile,
  bundle: true,
  minify: true,
  platform: "browser",
  format: "esm",
  target: ["chrome120", "safari17"],
  legalComments: "eof",
  metafile: true,
  define: DEFINE,
});

// A surviving `process.env` would be a runtime crash on a real phone, not a warning here.
const bundled = await readFile(outfile, "utf8");
if (bundled.includes("process.env"))
  throw new Error("The collector bundle still reads process.env; add its name to DEFINE.");

// The resolved table above must be the one that actually shipped, not a parallel calculation.
for (const [cluster, programs] of clusters)
  for (const program of programs)
    if (!bundled.includes(program))
      throw new Error(`The collector bundle does not carry its own trusted ${cluster} program ${program}.`);

// Nothing React Native may reach a browser bundle. The reader is platform-neutral by design;
// this is the tripwire for a future import that is not.
for (const input of Object.keys(bundle.metafile.inputs))
  if (/node_modules\/(react-native|expo|@expo|@wallet-ui|react-native-)/.test(input))
    throw new Error(`The collector bundle pulled in a React Native module: ${input}`);

/**
 * The third-party licence notice that ships beside the bundle. `collect.js` redistributes
 * substantial portions of every package in it, and MIT and Apache-2.0 §4(a)/(b) require their
 * licence and notices to travel with it, which minified code alone does not do. Generated from
 * the metafile, never a hand-kept list; a bundled package whose licence cannot be read fails.
 */
const LICENCE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "license", "license.md", "license.txt", "COPYING"];
const emitted = Object.values(bundle.metafile.outputs).find((o) => o.entryPoint);
const packageDirs = new Set();
for (const [input, { bytesInOutput }] of Object.entries(emitted.inputs)) {
  if (!bytesInOutput) continue;
  const at = input.lastIndexOf("node_modules/");
  if (at < 0) continue;
  const parts = input.slice(at + "node_modules/".length).split("/");
  const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  packageDirs.add(input.slice(0, at + "node_modules/".length) + name);
}
const notices = [];
for (const dir of [...packageDirs].sort()) {
  const manifest = JSON.parse(await readFile(resolve(root, dir, "package.json"), "utf8"));
  let text = null;
  for (const file of LICENCE_FILES) {
    text = await readFile(resolve(root, dir, file), "utf8").catch(() => null);
    if (text !== null) break;
  }
  const licence = manifest.license ?? manifest.licenses?.[0]?.type ?? null;
  if (!licence)
    throw new Error(
      `${manifest.name} is bundled into site/dist/collect/collect.js and declares no license in ${dir}/package.json. ` +
        "Code with no stated licence cannot be redistributed from erashot.app.",
    );
  const copyright = text
    ?.split(/\r?\n/)
    .find((line) => /copyright/i.test(line) && /\d{4}|\(c\)/i.test(line));
  notices.push({
    name: manifest.name,
    version: manifest.version,
    licence,
    copyright: copyright?.trim() ?? "",
    text: text === null ? null : text.replace(/\r\n/g, "\n").trimEnd(),
    borrowed: "",
  });
}
if (!notices.length)
  throw new Error("The collector bundle reported no third-party packages, which cannot be right.");
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
notices.sort((a, b) => order(a.name, b.name) || order(a.version, b.version));

// A package that declares a licence but ships no file: reproduce the standard text from another
// bundled package under the SAME licence, and say so. No source at all fails the build.
for (const notice of notices) {
  if (notice.text !== null) continue;
  const same = notices.filter((other) => other.licence === notice.licence && other.text !== null);
  const source = same.find((other) => !other.copyright) ?? same[0];
  if (!source)
    throw new Error(
      `${notice.name} declares ${notice.licence} but ships no licence file, and no other bundled ` +
        "package carries that licence text to reproduce. Add the text before shipping this bundle.",
    );
  notice.text = source.text;
  notice.borrowed = `ships no licence file; ${notice.licence} text reproduced from ${source.name}`;
}

const byText = new Map();
for (const notice of notices) {
  if (!byText.has(notice.text)) byText.set(notice.text, []);
  byText.get(notice.text).push(notice);
}
const legal =
  [
    "Third-party license notices for collect.js",
    "",
    "GENERATED FILE — do not edit. `npm run build:site` (site/build.mjs) rewrites it from the",
    "esbuild metafile, so it lists exactly the packages this bundle carries.",
    "",
    "collect.js is a minified redistribution of substantial portions of the packages below. The",
    "licence text each one requires to travel with it follows.",
    "",
    "Packages in this bundle:",
    ...notices.map(
      ({ name, version, licence, copyright, borrowed }) =>
        `  ${name} ${version} — ${licence}${copyright ? ` — ${copyright}` : ""}${borrowed ? ` (${borrowed})` : ""}`,
    ),
  ].join("\n") +
  [...byText.values()]
    .map(
      (group) =>
        `\n\n${"=".repeat(78)}\n${group.map(({ name, version }) => `${name} ${version}`).join(", ")}\n${"=".repeat(78)}\n\n${group[0].text}\n`,
    )
    .join("");
await writeFile(resolve(dist, "collect", "collect.js.LEGAL.txt"), legal + "\n");

// The static site, verbatim. `_headers` and `.well-known/assetlinks.json` ride along; the App
// Link association must keep serving byte-identical or Android drops the verified link.
await cp(resolve(site, "public"), dist, { recursive: true });
for (const required of ["_headers", ".well-known/assetlinks.json", "icon.png", "privacy.html", "terms/index.html", "moderation.json", "collect/index.html", "collect/collect.css"])
  await stat(resolve(dist, required)).catch(() => {
    throw new Error(`site/dist is missing ${required}; the deploy would break a live route.`);
  });

console.log(
  `Collector bundle built (${bundled.length} bytes); trusted programs: ${clusters.map(([cluster, programs]) => `${cluster} ${programs.join(", ")}`).join("; ")}. ` +
    `License notices regenerated for ${notices.length} bundled packages. Output: site/dist`,
);
