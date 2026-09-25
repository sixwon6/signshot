/**
 * Gate for the public collect page (`site/`). Runs in `npm test`, needs no network.
 *
 * What it holds still:
 *   - the page's wording for the device row, derived through the SAME reader and verdict the app
 *     uses, on the synthetic attestation fixture: the verified line only when the release app,
 *     the boot state, revocation and the dates at publication all hold, the refusal for each, the
 *     "Couldn't check." line, the set-aside line and the plain-document line, so a wording change
 *     is a reviewed change;
 *   - `functions/api/attestation-status.ts`, against a stubbed Google and Cache API: the list is
 *     re-served same-origin, bounded, reshaped and cached, and anything else is a 502;
 *   - the two copies of the collect page's Content-Security-Policy (`_headers` and the <meta>)
 *     say the same thing, so a hosting change cannot leave the page with no policy;
 *   - `.well-known/assetlinks.json` is byte-identical to the file Android verified the App Link
 *     against, and names the release certificate in `dapp-store/signing-certificate.json`;
 *   - the collect sources never assign markup (`innerHTML`, `outerHTML`, `insertAdjacentHTML`,
 *     `document.write`), which the CSP's Trusted Types directive would turn into a runtime throw;
 *   - the bundle builds, carries the trusted programs, reads no `process.env`, and includes no
 *     React Native module (the build's own guards, exercised here so `npm test` runs them);
 *   - terms, Report, Block and the moderation list (`src/moderation/core.ts`): the strict parse,
 *     failing open, the veil, the report email, the terms page's §10.6 clauses and its headers, and
 *     the app and the page asking for agreement before a first publish or collect.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, type JcsValue } from "../src/jcs";
import {
  deviceVerdict,
  readAttestationBundle,
  RELEASE_APP,
  type AttestationBundle,
  type AttestationSummary,
  type RevocationList,
} from "../publications/core/attestation";
import { readPhotoMetadata } from "../publications/core/metadataDocument";
import { metadata } from "../publications/core/protocol";
import type { CoreMetadata } from "../publications/types";
import {
  DEVICE_LINE,
  deviceLine,
  deviceProblem,
  deviceVerdictRow,
  GENESIS_LINE,
  MODERATION_WORDS,
  NO_DEVICE,
  sol,
} from "../site/collect/summary";
import {
  MAX_BLOCKED, MODERATION_MAX_BYTES, MODERATION_MAX_ENTRIES, MODERATION_URL, TERMS_URL, TERMS_VERSION,
  fetchModerationList, parseModerationList, readBlockList, reportMailto, termsAgreed, veilOf, withBlocked,
} from "../src/moderation/core";
import { MAX_UPSTREAM, onRequestGet as attestationStatus, UPSTREAM } from "../site/functions/api/attestation-status";

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
ok("a TEE key on another device is named as such",
  deviceLine({ ...summary, securityLevel: "tee", manufacturer: "Google", model: "Pixel 9" }) === "Signed on a Google Pixel 9 · TEE hardware key · verified boot, bootloader locked");

// The row for each gating path, as `showDevice` renders it: `deviceVerdictRow` over `deviceVerdict`.
// The release build's summary is the fixture's with the release signer; its chain is dated
// 2026-09-16 to 2046, so a publication on 2026-09-20 is in date.
const release: AttestationSummary = { ...summary, signerDigests: [RELEASE_APP.signerDigest] };
const publishedAt = new Date("2026-09-20T12:00:00Z");
const listed: RevocationList = new Map([[summary.certificates[1].serial, { status: "REVOKED", reason: "KEY_COMPROMISE" }]]);
const row = (s: AttestationSummary, at: Date | null, list: RevocationList | null) => deviceVerdictRow(deviceLine(s), deviceVerdict(s, at, list));
const seekerLine = "Signed on a Solana Seeker · StrongBox hardware key · verified boot, bootloader locked";
ok("release app, locked, in date, not revoked: the Seeker line",
  row(release, publishedAt, new Map()).text === seekerLine && row(release, publishedAt, new Map()).state === "device-ok");
ok("the 2026-09-16 test app with a debug signer no longer gets the Seeker line",
  row({ ...summary, packageNames: ["expo.modules.seekercamera.test"] }, publishedAt, new Map()).text === "Device attestation not accepted: another app");
ok("a build signed by another key: another app", row(summary, publishedAt, new Map()).text === "Device attestation not accepted: another app");
ok("an unlocked bootloader is said, never hidden, and never with the device line",
  row({ ...release, deviceLocked: false }, publishedAt, new Map()).text === "Device attestation not accepted: bootloader unlocked");
ok("a certificate on Google's list: revoked", row(release, publishedAt, listed).text === "Device attestation not accepted: revoked"
  && row(release, publishedAt, listed).state === "device-problem");
ok("the list out of reach: Couldn't check.", row(release, publishedAt, null).text === "Couldn’t check." && row(release, publishedAt, null).state === "device-none");
ok("published after the chain expired: expired at publication",
  row(release, new Date("2047-01-01T00:00:00Z"), new Map()).text === "Device attestation not accepted: expired at publication");
ok("no publication time: Couldn't check.", row(release, null, new Map()).text === "Couldn’t check.");
const appCopySource = readFileSync(resolve(root, "src", "ui", "copy.ts"), "utf8");
ok("the checking and couldn't-check lines are the app's own",
  appCopySource.includes(`attestationChecking: "${DEVICE_LINE.checking}"`) && appCopySource.includes(`attestationUnchecked: "${DEVICE_LINE.unavailable}"`));

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
// The Genesis Token row: the page's six lines are the app's own (`proof.genesisStanding`), and a
// document that names a mint reaches the page as a claim for it to check.
const appCopy = readFileSync(resolve(root, "src", "ui", "copy.ts"), "utf8");
ok("the Genesis Token row says what the app's Proof sheet says",
  Object.values(GENESIS_LINE).length === 6 && Object.values(GENESIS_LINE).every((line) => appCopy.includes(`"${line}"`)));
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

// --- Terms, Report, Block and the moderation list -------------------------------------------------
// The Publisher Policy asks a dApp with user content for user terms people agree to, an in-app
// report, moderation, and a block; the Developer Agreement (§2.1, §10.6) for a linked EULA that
// disclaims warranties and liability for the Solana Mobile Parties and says they are not a party.
const A = "So11111111111111111111111111111111111111112";
const B = "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const throws = (run: () => unknown) => { try { run(); return false; } catch { return true; } };
const served = parseModerationList(readFileSync(resolve(site, "public", "moderation.json"), "utf8"));
ok("the served moderation list parses and hides nothing", served.hiddenEditions.size === 0 && served.hiddenCreators.size === 0);
const moderated = parseModerationList(JSON.stringify({ version: 1, hiddenEditions: [A], hiddenCreators: [B] }));
ok("a moderation list names editions and creators", moderated.hiddenEditions.has(A) && moderated.hiddenCreators.has(B));
ok("the moderation list parse is strict: three keys, version 1, addresses, bounded", [
  "[]", "null", "{}", "{\"version\":1,\"hiddenEditions\":[]}",
  JSON.stringify({ version: 2, hiddenEditions: [], hiddenCreators: [] }),
  JSON.stringify({ version: "1", hiddenEditions: [], hiddenCreators: [] }),
  JSON.stringify({ version: 1, hiddenEditions: [], hiddenCreators: [], note: "" }),
  JSON.stringify({ version: 1, hiddenEditions: ["not an address"], hiddenCreators: [] }),
  JSON.stringify({ version: 1, hiddenEditions: [A.slice(0, 20)], hiddenCreators: [] }),
  JSON.stringify({ version: 1, hiddenEditions: [], hiddenCreators: [42] }),
  JSON.stringify({ version: 1, hiddenEditions: {}, hiddenCreators: [] }),
  JSON.stringify({ version: 1, hiddenEditions: Array(MODERATION_MAX_ENTRIES + 1).fill(A), hiddenCreators: [] }),
  " ".repeat(MODERATION_MAX_BYTES + 1),
].every((text) => throws(() => parseModerationList(text))));
ok("the list's edition or creator is Hidden, a blocked publisher is Blocked, and the list wins",
  veilOf(A, B, moderated, new Set()) === "hidden" && veilOf(B, B, moderated, new Set()) === "hidden"
  && veilOf(B, A, null, new Set([A])) === "blocked" && veilOf(A, B, moderated, new Set([B])) === "hidden"
  && veilOf(B, A, moderated, new Set()) === null && veilOf(A, B, null, new Set()) === null);
// tsx runs this file as CommonJS, which has no top-level await; the tail awaits this.
async function moderationFetch() {
  const answer = (body: string, init?: ResponseInit) => (async () => new Response(body, init)) as unknown as typeof fetch;
  const good = JSON.stringify({ version: 1, hiddenEditions: [A], hiddenCreators: [] });
  const fetched = await Promise.all([
    fetchModerationList(MODERATION_URL, answer(good)),
    fetchModerationList(MODERATION_URL, answer(good, { status: 404 })),
    fetchModerationList(MODERATION_URL, answer("<!doctype html>")),
    fetchModerationList(MODERATION_URL, answer(good, { headers: { "content-length": String(MODERATION_MAX_BYTES + 1) } })),
    fetchModerationList(MODERATION_URL, answer(" ".repeat(MODERATION_MAX_BYTES) + good)),
    fetchModerationList(MODERATION_URL, (async () => { throw new Error("offline"); }) as unknown as typeof fetch),
    fetchModerationList(MODERATION_URL, ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch, 20),
  ]);
  ok("the moderation list is fetched and parsed", fetched[0]?.hiddenEditions.has(A) === true);
  ok("a refused, malformed, oversized, unreachable or late list hides nothing (fails open)", fetched.slice(1).every((list) => list === null));
}
const many = Array.from({ length: MAX_BLOCKED + 5 }, (_, i) => "1".repeat(30) + B58[Math.floor(i / 58)] + B58[i % 58]);
ok("a stored block list keeps addresses only, once each, capped",
  readBlockList(JSON.stringify([A, A, "x", 3, B])).join() === `${A},${B}` && readBlockList("{").length === 0
    && readBlockList(null).length === 0 && readBlockList(JSON.stringify({ A })).length === 0
    && readBlockList(JSON.stringify(many)).length === MAX_BLOCKED);
ok("Block adds and Unblock removes exactly that publisher",
  withBlocked([A], B, true).join() === `${A},${B}` && withBlocked([A, B], A, false).join() === B && withBlocked([A], "junk", true).join() === A);
const link = `https://erashot.app/collect/?core=${A}&cluster=devnet`;
ok("Report is an email to support with the edition in the subject and the collect link in the body",
  reportMailto(A, link) === `mailto:support@erashot.app?subject=Report%20${A}&body=${encodeURIComponent(link)}`);
ok("only an agreement to the current terms counts",
  termsAgreed(String(TERMS_VERSION)) && !termsAgreed(String(TERMS_VERSION + 1)) && !termsAgreed(null) && !termsAgreed(""));
const appModeration = /export const moderation = \{([\s\S]*?)\} as const;/.exec(appCopy)?.[1] ?? "";
ok("the page says Terms, Agree, Report, Block, Unblock, Blocked and Hidden in the app's own words",
  Object.keys(MODERATION_WORDS).length === 7
    && Object.entries(MODERATION_WORDS).every(([key, word]) => new RegExp(`\\b${key}: "${word}",`).test(appModeration)));
ok("the collect page carries Report, Block, the veil, the one-time agreement and a Terms link",
  /<a id="report" href="mailto:support@erashot\.app">Report<\/a\s*><button id="block">Block<\/button>/.test(html)
    && /<div id="veil" class="photograph veil" hidden>/.test(html)
    && /<div id="agreement" class="agreement" hidden>\s*<a href="\/terms\/"[^>]*>Terms<\/a\s*><button id="agree">Agree<\/button>/.test(html)
    && /<a href="\/terms\/">Terms<\/a>/.test(html));
const pageSource = readFileSync(resolve(site, "collect", "page.ts"), "utf8");
ok("the page asks for the terms before a first collect, refuses a veiled one, and reads the list from its own origin",
  /if \(!agreed\) \{\s*el\("agreement"\)\.hidden = false;\s*return;/.test(pageSource)
    && /b\.disabled = [^;]*!!veil\(\);/.test(pageSource) && /if \(busy \|\| !loaded \|\| veil\(\)\) return;/.test(pageSource)
    && /new URL\(new URL\(MODERATION_URL\)\.pathname, location\.origin\)/.test(pageSource));
const prints = ["CollectSheet.tsx", "PrintSheet.tsx"].map((file) => readFileSync(resolve(root, "src", "prints", file), "utf8"));
ok("the app asks for the terms before a first publish and a first collect",
  prints.every((source) => /(terms|agreement)\.agreed !== true \? \(\s*<TermsAgreement /.test(source)));
ok("the Collect sheet reports, blocks and veils",
  /reportMailto\(target\.edition, collectUrl\(target\.edition, cluster\)\)/.test(prints[0])
    && /moderation\.setBlocked\(e\.creator, !blocked\)/.test(prints[0]) && /!!e && !veil && \(\s*<PhotoFrame/.test(prints[0]));
ok("Settings links the terms beside the privacy policy",
  /<LinkRow label=\{copy\.privacyLink\} onPress=\{onPrivacy\} \/>\s*<LinkRow label=\{copy\.termsLink\} onPress=\{onTerms\} \/>/
    .test(readFileSync(resolve(root, "src", "screens", "SettingsScreen.tsx"), "utf8")));
const termsPage = readFileSync(resolve(site, "public", "terms", "index.html"), "utf8").replace(/\s+/g, " ");
ok("the terms disclaim warranties and liability for the Solana Mobile Parties and say they are not a party (§10.6)",
  /PROVIDED “AS IS”, “WITH ALL FAULTS”/.test(termsPage) && /WE AND THE SOLANA MOBILE PARTIES MAKE NO, AND DISCLAIM ALL, REPRESENTATIONS, WARRANTIES AND CONDITIONS/.test(termsPage)
    && /MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT/.test(termsPage)
    && /ERROR-FREE, ACCURATE, RELIABLE, COMPLETE, SECURE OR UNINTERRUPTED/.test(termsPage)
    && /NEITHER WE NOR THE SOLANA MOBILE PARTIES SHALL BE LIABLE TO YOU FOR ANY CLAIM FOR ANY DIRECT, INDIRECT, SPECIAL, CONSEQUENTIAL, INCIDENTAL, PUNITIVE OR EXEMPLARY DAMAGES/.test(termsPage)
    && /SOLE AND EXCLUSIVE REMEDY IS TO STOP USING SIGNSHOT/.test(termsPage)
    && /“Solana Mobile Parties”\) are not a party to these terms and have no responsibility or liability to you in connection with Signshot/.test(termsPage));
ok("the terms carry the content rules, reporting, hiding, blocking, permanence and the contact address",
  /What you may not publish/.test(termsPage) && /sexually exploits or abuses children/.test(termsPage) && /intellectual property/.test(termsPage)
    && /hateful, harassing or threatening/.test(termsPage) && /real-world violence/.test(termsPage) && /violates someone’s privacy/.test(termsPage)
    && /Anyone can report a publication with Report/.test(termsPage) && /hide publications and creators from Signshot’s own views/.test(termsPage)
    && /cannot be deleted by anyone/.test(termsPage) && /Block hides a publisher’s photographs/.test(termsPage)
    && /<a href="mailto:support@erashot\.app">support@erashot\.app<\/a>/.test(termsPage) && /<a href="\/privacy">/.test(termsPage));
ok("the terms page names the version the app and the page ask agreement to, at the URL they link",
  termsPage.includes(`Version ${TERMS_VERSION} ·`) && TERMS_URL === "https://erashot.app/terms/" && MODERATION_URL === "https://erashot.app/moderation.json");
const privacyPage = readFileSync(resolve(site, "public", "privacy.html"), "utf8").replace(/\s+/g, " ");
ok("the privacy page says what a report sends and that blocks and the agreement stay on the device",
  /<td>Report a publication<\/td>/.test(privacyPage) && /names the edition's address and carries its collect link/.test(privacyPage)
    && /The publishers you block and your agreement to the <a href="\/terms\/">terms<\/a>/.test(privacyPage) && /Neither is ever sent to Signshot/.test(privacyPage)
    && /moderation list/.test(privacyPage));
const STATIC_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const headerLines = headers.split(/\r?\n/);
const ruleAfter = (path: string) => { const at = headerLines.findIndex((line) => line.trim() === path); return at < 0 ? "" : (headerLines[at + 1] ?? "").trim(); };
ok("_headers serves the terms under the static pages' policy and the list with a short cache",
  ["/privacy", "/terms", "/terms/", "/terms/index.html"].every((path) => ruleAfter(path) === `Content-Security-Policy: ${STATIC_CSP}`)
    && ruleAfter("/moderation.json") === "Cache-Control: public, max-age=300");

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
ok("bundle knows the Genesis Token claim, Solana Mobile's group and mainnet's genesis hash",
  bundled.includes("seedshot-genesis/1") && bundled.includes("GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te") && bundled.includes("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"));
ok("bundle carries the moderation list's address and the Blocked and Hidden words",
  bundled.includes(MODERATION_URL) && bundled.includes(`"${MODERATION_WORDS.blocked}"`) && bundled.includes(`"${MODERATION_WORDS.hidden}"`));
const proxy = readFileSync(resolve(site, "functions", "api", "solana.ts"), "utf8");
ok("the mainnet proxy allows the three methods the Genesis Token check calls",
  ["getGenesisHash", "getAccountInfo", "getTokenAccountsByOwner"].every((method) => new RegExp(`ALLOWED=new Set\\(\\[[^\\]]*'${method}'`).test(proxy)));
ok("the mainnet proxy allows the two reads the device row's publication time makes",
  /ALLOWED=new Set\(\[[^\]]*'getSignaturesForAddress'[^\]]*'getTransaction'[^\]]*\]\)/.test(proxy));
ok("the bundle reads the revocation list same-origin, never from Google (no CORS there)",
  bundled.includes("/api/attestation-status") && !bundled.includes("android.googleapis.com"));

/**
 * Every origin the bundle could open a connection to must be allowed by `connect-src`, or the
 * browser refuses it silently at runtime. Mobile Wallet Adapter's browser transport is the case
 * this exists for: after the `solana-wallet://` hand-off it opens
 * `ws://localhost:<port>/solana-wallet` (mobile-wallet-adapter-protocol, index.browser.js), and a
 * policy written for the page's HTTPS calls never matches localhost. Hosts that appear in the
 * bundle but are never connection targets are listed with the reason.
 */
const NOT_CONNECTIONS: Record<string, string> = {
  "https://erashot.app": "the collect URL the page prints and encodes into QR codes, and MODERATION_URL, which the page reads at its own origin; same origin in production anyway",
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
  ["_headers", ".well-known/assetlinks.json", "icon.png", "privacy.html", "terms/index.html", "moderation.json", "index.html", "collect/index.html", "collect/collect.css", "collect/collect.js.LEGAL.txt"]
    .every((p) => { try { return statSync(resolve(dist, p)).isFile(); } catch { return false; } }));
ok("dist ships no preview gate", (() => { try { statSync(resolve(dist, "functions")); return false; } catch { return true; } })()
  && (() => { try { statSync(resolve(site, "functions", "_middleware.ts")); return false; } catch { return true; } })());
ok("dist assetlinks.json is the verified file", build.status === 0 && sha256(readFileSync(resolve(dist, ".well-known", "assetlinks.json"))) === sha256(assetlinks));

// --- /api/attestation-status, against a stubbed Google and Cache API -------------------------------
async function attestationStatusChecks() {
  const realFetch = globalThis.fetch;
  const store = new Map<string, Response>();
  (globalThis as { caches?: unknown }).caches = {
    default: {
      match: async (request: Request) => store.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => { store.set(request.url, response); },
    },
  };
  let upstream = 0;
  const google = (body: string, init?: ResponseInit) => {
    globalThis.fetch = (async (url: unknown) => {
      upstream += 1;
      if (String(url) !== UPSTREAM) throw new Error(`unexpected fetch ${String(url)}`);
      return new Response(body, init);
    }) as typeof fetch;
  };
  const pending: Promise<unknown>[] = [];
  const call = (path = "/api/attestation-status") =>
    attestationStatus({ request: new Request(`https://erashot.app${path}`), waitUntil: (p) => { pending.push(p); } });
  try {
    google(JSON.stringify({ entries: {
      "2c8cdddfd5e03bfc": { status: "REVOKED", reason: "KEY_COMPROMISE", comment: "leaked keybox" },
      "1234567890": { status: "SUSPENDED" },
    } }));
    const first = await call();
    await Promise.all(pending);
    const text = await first.text();
    ok("the Function re-serves Google's list same-origin, reduced to status and reason",
      first.status === 200 && text === JSON.stringify({ entries: {
        "2c8cdddfd5e03bfc": { status: "REVOKED", reason: "KEY_COMPROMISE" },
        "1234567890": { status: "SUSPENDED" },
      } }) && first.headers.get("Content-Type") === "application/json"
        && first.headers.get("X-Content-Type-Options") === "nosniff" && first.headers.get("Cache-Control") === "public, max-age=3600");
    const again = await call("/api/attestation-status?bust=1");
    ok("a second request, with a query string or not, is served from the cache", again.status === 200 && upstream === 1);
    store.clear();
    const refusals: [string, string, ResponseInit | undefined][] = [
      ["unavailable at Google", "unavailable", { status: 503 }],
      ["declared larger than the bound", "{}", { headers: { "Content-Length": String(MAX_UPSTREAM + 1) } }],
      ["not JSON", "<html></html>", undefined],
      ["not the documented shape", JSON.stringify({ entries: { AB: { status: "REVOKED" } } }), undefined],
    ];
    for (const [name, body, init] of refusals) {
      google(body, init);
      const response = await call();
      ok(`the Function answers 502, uncached, when the list is ${name}`,
        response.status === 502 && response.headers.get("Cache-Control") === "no-store" && store.size === 0);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

void moderationFetch()
  .then(() =>
    attestationStatusChecks().catch((error: unknown) =>
      ok(`attestation-status checks ran (${error instanceof Error ? error.message : String(error)})`, false),
    ),
  )
  .then(
    () => {
      console.log(failures ? `\n${failures} site check(s) failed.` : "\nsite check passed.");
      process.exit(failures ? 1 : 0);
    },
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
