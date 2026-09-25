/**
 * Gate for the public collect page (`site/`). Runs in `npm test`, needs no network.
 *
 * What it holds still:
 *   - the page's wording for the device row, derived through the SAME reader the app uses, on the
 *     synthetic attestation fixture: the verified line, the set-aside line and the plain-document
 *     line, so a wording change is a reviewed change;
 *   - the two copies of the collect page's Content-Security-Policy (`_headers` and the <meta>)
 *     say the same thing, so a hosting change cannot leave the page with no policy;
 *   - `.well-known/assetlinks.json` is byte-identical to the file Android verified the App Link
 *     against, and names the release certificate in `dapp-store/signing-certificate.json`;
 *   - the collect sources never assign markup (`innerHTML`, `outerHTML`, `insertAdjacentHTML`,
 *     `document.write`), which the CSP's Trusted Types directive would turn into a runtime throw;
 *   - the bundle builds, carries the trusted programs, reads no `process.env`, and includes no
 *     React Native module (the build's own guards, exercised here so `npm test` runs them).
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, type JcsValue } from "../src/jcs";
import { readAttestationBundle, type AttestationBundle } from "../publications/core/attestation";
import { readPhotoMetadata } from "../publications/core/metadataDocument";
import { metadata } from "../publications/core/protocol";
import type { CoreMetadata } from "../publications/types";
import { deviceLine, deviceProblem, GENESIS_LINE, NO_DEVICE, sol } from "../site/collect/summary";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const site = resolve(root, "site");

let failures = 0;
function ok(name: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failures += 1;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// --- The device row, through the app's reader ---------------------------------------------------
const fixture = JSON.parse(readFileSync(resolve(here, "fixtures", "attestation-sample.json"), "utf8")) as AttestationBundle & { note: string; syntheticRootKey: string };
const { note: _note, syntheticRootKey, ...bundle } = fixture;
const commitment = bundle.manifest;
const { summary } = readAttestationBundle(bundle, commitment, [syntheticRootKey]);
ok("verified attestation renders the app's Proof sheet line",
  deviceLine(summary) === "Signed on a Solana Seeker · StrongBox hardware key · verified boot, bootloader locked");
ok("an unlocked bootloader is said, never hidden",
  deviceLine({ ...summary, deviceLocked: false }) === "Signed on a Solana Seeker · StrongBox hardware key · boot verified, bootloader unlocked");
ok("a TEE key on another device is named as such",
  deviceLine({ ...summary, securityLevel: "tee", manufacturer: "Google", model: "Pixel 9" }) === "Signed on a Google Pixel 9 · TEE hardware key · verified boot, bootloader locked");

const e: CoreMetadata = {
  cluster: commitment.cluster, program: commitment.program, edition: commitment.edition,
  collection: commitment.collection, creator: commitment.creator, nonce: commitment.nonce,
  title: "Sample", supply: 3, image: "https://arweave.net/" + "A".repeat(43), imageHash: commitment.imageHash,
  width: 2448, height: 3264, description: "",
};
// The document as the app composes it (`metadata()` cannot write a synthetic chain, so by hand).
const attributes = [
  { trait_type: "Device", value: "Solana Seeker" },
  { trait_type: "Attestation", value: "StrongBox hardware key" },
];
const doc = { name: e.title, description: e.description, image: e.image, attributes, properties: { seedshot: bundle } };
const serialized = canonicalize(doc as unknown as JcsValue);
const attested = readPhotoMetadata(JSON.parse(serialized), e, serialized);
ok("a five-key document loads through the page's reader (the old page refused it)", attested.image === e.image);
ok("evidence the reader set aside renders as set aside, with the reason",
  attested.attestation === undefined && !!attested.attestationProblem
    && deviceProblem(attested.attestationProblem) === "Device attestation not accepted: the chain does not end at a Google attestation root");
const plain = readPhotoMetadata(JSON.parse(canonicalize(metadata(e) as unknown as JcsValue)), e);
ok("a plain three-key document renders the no-attestation line",
  plain.attestation === undefined && plain.attestationProblem === undefined && NO_DEVICE === "No device attestation.");
// The Genesis Token row: the page's five lines are the app's own (`proof.genesisStanding`), and a
// document that names a mint reaches the page as a claim for it to check.
const appCopy = readFileSync(resolve(root, "src", "ui", "copy.ts"), "utf8");
ok("the Genesis Token row says what the app's Proof sheet says",
  Object.values(GENESIS_LINE).length === 5 && Object.values(GENESIS_LINE).every((line) => appCopy.includes(`"${line}"`)));
const genesisDoc = canonicalize(metadata({ ...e, genesisMint: "So11111111111111111111111111111111111111112" }) as unknown as JcsValue);
ok("a document that names a Genesis Token loads through the page's reader with the claimed mint",
  readPhotoMetadata(JSON.parse(genesisDoc), e, genesisDoc).genesisMint === "So11111111111111111111111111111111111111112");
ok("no page wording overclaims", !/authentic|camera-verified|proves? the (scene|photo)/i.test(
  [deviceLine(summary), NO_DEVICE, deviceProblem("x"), ...Object.values(GENESIS_LINE), readFileSync(resolve(site, "public", "collect", "index.html"), "utf8"), readFileSync(resolve(site, "collect", "page.ts"), "utf8"), readFileSync(resolve(site, "collect", "core.ts"), "utf8")].join("\n")));

// --- Money wording --------------------------------------------------------------------------------
ok("lamports render exactly", sol(1_000_000n) === "0.001" && sol(1_500_000_000n) === "1.5" && sol(0n) === "0" && sol(1n) === "0.000000001" && sol(2_000_000_000n) === "2");

// --- The CSP travels with the document -----------------------------------------------------------
const headers = readFileSync(resolve(site, "public", "_headers"), "utf8");
const rule = headers.split(/\r?\n/).findIndex((line) => line.trim() === "/collect/*");
const headerCsp = headers.split(/\r?\n/).slice(rule + 1).find((line) => /^\s+Content-Security-Policy:/.test(line))?.replace(/^\s+Content-Security-Policy:\s*/, "").trim();
const html = readFileSync(resolve(site, "public", "collect", "index.html"), "utf8");
const metaCsp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
ok("collect/index.html <meta> CSP equals the _headers rule minus frame-ancestors",
  !!headerCsp && !!metaCsp && headerCsp.replace(/;\s*frame-ancestors 'none'/, "") === metaCsp);
ok("the CSP requires Trusted Types and allows no policy", !!metaCsp && /require-trusted-types-for 'script'; trusted-types 'none'/.test(metaCsp));
ok("the bundle is a same-origin module script and nothing is inline",
  /<script type="module" src="\.\/collect\.js"><\/script>/.test(html) && !/<script(?![^>]*src=)/.test(html) && !/ style=/.test(html) && !/<style/.test(html));

// --- The App Link association ------------------------------------------------------------------------
const assetlinks = readFileSync(resolve(site, "public", ".well-known", "assetlinks.json"));
ok("assetlinks.json is byte-identical to the verified file",
  sha256(assetlinks) === "cf53cd9431f8c4214e9813b098476fa1903f3d11144271896ffb735f07e84279");
const cert = JSON.parse(readFileSync(resolve(root, "dapp-store", "signing-certificate.json"), "utf8")) as { packageName: string; sha256: string };
const links = JSON.parse(assetlinks.toString("utf8")) as { target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
ok("assetlinks.json names the release package and certificate",
  links.length === 1 && links[0].target.package_name === cert.packageName
    && links[0].target.sha256_cert_fingerprints.map((f) => f.replace(/:/g, "").toLowerCase()).join() === cert.sha256);
const wk = headers.split(/\r?\n/).findIndex((line) => line.trim() === "/.well-known/*");
ok("_headers labels /.well-known/* as JSON", wk >= 0 && /Content-Type: application\/json/.test(headers.split(/\r?\n/)[wk + 1] ?? ""));

// --- No markup sinks in the page ------------------------------------------------------------------
const sources = readdirSync(resolve(site, "collect")).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(site, "collect", f), "utf8")).join("\n");
ok("collect sources never assign markup", !/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|createContextualFragment/.test(sources));
ok("the router refuses steering parameters and the retired routes",
  /REFUSED = \["print", "album", "rpc", "endpoint", "program", "url", "api"\]/.test(sources));
ok("the page never takes an endpoint or program from the link",
  /params\.get\("(rpc|endpoint|program|url|api)"\)/.test(sources) === false);

// --- The build and its guards ------------------------------------------------------------------------
const build = spawnSync(process.execPath, [resolve(site, "build.mjs")], { cwd: root, encoding: "utf8" });
ok("site build succeeds", build.status === 0 && /Collector bundle built/.test(build.stdout));
if (build.status !== 0) console.error(build.stdout + build.stderr);
const dist = resolve(site, "dist");
const bundled = build.status === 0 ? readFileSync(resolve(dist, "collect", "collect.js"), "utf8") : "";
ok("bundle carries the trusted devnet programs and reads no process.env",
  bundled.includes("7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU") && bundled.includes("BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq") && !bundled.includes("process.env"));
ok("bundle knows the attested document schema", bundled.includes("seedshot-attestation/1"));
ok("bundle knows the Genesis Token claim and Solana Mobile's three addresses",
  bundled.includes("seedshot-genesis/1") && bundled.includes("GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4") && bundled.includes("GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te"));
const proxy = readFileSync(resolve(site, "functions", "api", "solana.ts"), "utf8");
ok("the mainnet proxy allows both methods the Genesis Token check calls",
  /ALLOWED=new Set\(\[[^\]]*'getAccountInfo'[^\]]*'getTokenAccountsByOwner'[^\]]*\]\)/.test(proxy));

/**
 * Every origin the bundle could open a connection to must be allowed by `connect-src`, or the
 * browser refuses it silently at runtime. Mobile Wallet Adapter's browser transport is the case
 * this exists for: after the `solana-wallet://` hand-off it opens
 * `ws://localhost:<port>/solana-wallet` (mobile-wallet-adapter-protocol, index.browser.js), and a
 * policy written for the page's HTTPS calls never matches localhost. Hosts that appear in the
 * bundle but are never connection targets are listed with the reason.
 */
const NOT_CONNECTIONS: Record<string, string> = {
  "https://erashot.app": "the collect URL the page prints and encodes into QR codes; same origin in production anyway",
  "https://explorer.solana.com": "navigation links (View the Solana publication / transaction), not fetches",
  "https://sola.na": "@solana/kit invariant-violation error text ('please file an issue at …')",
  "https://developer.mozilla.org": "@solana/kit error text pointing at MDN",
  "https://github.com": "library error text pointing at an issue tracker",
};
const connectSrc = (metaCsp ?? "").split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "))?.split(/\s+/).slice(1) ?? [];
const allowsOrigin = (origin: string) => {
  const url = new URL(origin);
  return connectSrc.some((source) => {
    if (source === "'self'") return url.origin === "https://erashot.app";
    if (source.endsWith(":*")) return `${url.protocol}//${url.hostname}` === source.slice(0, -2);
    return source === origin;
  });
};
const literals = new Set<string>();
for (const m of bundled.matchAll(/\b(wss?|https):\/\/([A-Za-z0-9.-]+)(:(\d+|\$\{[^}]*\}))?/g)) {
  const host = m[2];
  if (!host.includes(".") && host !== "localhost") continue; // template fragments, not hosts
  const port = m[4] && /^\d+$/.test(m[4]) ? `:${m[4]}` : m[4] ? ":*" : "";
  literals.add(`${m[1]}://${host}${port}`);
}
const unexplained = [...literals].filter((origin) => {
  const bare = origin.replace(/:\*$/, "");
  if (NOT_CONNECTIONS[bare]) return false;
  return !allowsOrigin(origin.endsWith(":*") ? bare + ":1" : origin);
});
ok(`every connection origin in the bundle is allowed by connect-src (${[...literals].sort().join(", ")})`, unexplained.length === 0);
if (unexplained.length) console.error("  not allowed and not explained:", unexplained.join(", "));
ok("MWA's localhost WebSocket is allowed", literals.has("ws://localhost:*") && connectSrc.includes("ws://localhost:*"));
ok("dist carries the static routes the app and wallets depend on",
  ["_headers", ".well-known/assetlinks.json", "icon.png", "privacy.html", "index.html", "collect/index.html", "collect/collect.css", "collect/collect.js.LEGAL.txt"]
    .every((p) => { try { return statSync(resolve(dist, p)).isFile(); } catch { return false; } }));
ok("dist ships no preview gate", (() => { try { statSync(resolve(dist, "functions")); return false; } catch { return true; } })()
  && (() => { try { statSync(resolve(site, "functions", "_middleware.ts")); return false; } catch { return true; } })());
ok("dist assetlinks.json is the verified file", build.status === 0 && sha256(readFileSync(resolve(dist, ".well-known", "assetlinks.json"))) === sha256(assetlinks));

console.log(failures ? `\n${failures} site check(s) failed.` : "\nsite check passed.");
process.exit(failures ? 1 : 0);
