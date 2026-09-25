/**
 * Builds the public collect page: `site/collect/browser.ts` → `site/dist/collect/collect.js`,
 * then copies `site/public/` (the static pages, `_headers`, `.well-known/`) into `site/dist/`.
 * `site/dist/` is the directory `wrangler pages deploy` uploads (see `site/README.md`); it is
 * git-ignored and rebuilt on every deploy, so nothing in it is ever edited by hand.
 *
 * The bundle is built from the app's OWN reader (`publications/core/*`), so the web page and the
 * phone accept exactly the same documents — including the five-key `seedshot-attestation/1`
 * document — and the trusted program table is the one committed in `publications/deployments.ts`.
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const site = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(site, "..");
const dist = resolve(site, "dist");

/**
 * `publications/deployments.ts` reads its two overrides through literal `process.env.NAME`
 * member accesses, because that is the only form Metro can inline for the mobile app. A browser
 * bundle has no `process` at all, so both expressions must be replaced at build time or the page
 * throws `process is not defined` before it can even render an error.
 *
 * Production replaces both with `undefined`: the public page reads whatever the reviewed
 * deployment table holds and can never be pointed at another program by its own build.
 */
export const DEFINE = {
  "process.env.EXPO_PUBLIC_EDITIONS_DEVNET_PROGRAM": "undefined",
  "process.env.EXPO_PUBLIC_EDITIONS_MAINNET_PROGRAM": "undefined",
};

/**
 * What this build will trust, resolved exactly the way the bundle resolves it: the real registry
 * module, bundled with the same `DEFINE`, then imported.
 *
 * An empty `TRUSTED` is not an inert build, it is a broken one — the page would refuse every
 * `?core=` link with "not from a reviewed deployment on this network" and nothing else would
 * notice. So the emptiness fails here instead of shipping.
 */
const registry = await build({
  entryPoints: [resolve(root, "publications", "deployments.ts")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  define: DEFINE,
});
const { TRUSTED } = await import(
  "data:text/javascript;base64," + Buffer.from(registry.outputFiles[0].text, "utf8").toString("base64")
);
const clusters = Object.entries(TRUSTED).filter(([, programs]) => programs.length);
if (!clusters.length)
  throw new Error(
    "The collector would trust no program on any cluster and would refuse every link. Commit a " +
      "reviewed address to DEPLOYMENTS or HISTORICAL in publications/deployments.ts (see site/README.md).",
  );

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
 * The third-party licence notice that ships beside the bundle.
 *
 * `collect.js` is a redistribution of substantial portions of every package esbuild pulled into
 * it. MIT requires that the copyright and permission notice "shall be included in all copies or
 * substantial portions of the Software"; Apache-2.0 §4(a)/(b) require giving recipients a copy
 * of the License and retaining the attribution notices. Minified code satisfies neither on its
 * own, so the notice file is the copy recipients get. It is generated from the metafile — the
 * exact set of files esbuild put in this bundle — never from a hand-kept list. A package the
 * bundle carries but whose licence cannot be read FAILS the build.
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
