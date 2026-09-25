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
 *   - Mobile Wallet Adapter is registered through `@solana-mobile/wallet-standard-mobile`, and the
 *     one Trusted Types policy and the `style-src` hashes admit exactly its dialogs, recomputed
 *     from the installed package;
 *   - the RPC proxy's upstream is its `SOLANA_RPC_URL` binding, or Solana's public mainnet with
 *     `X-Upstream: public` on every answer; its allowlist equals the methods the page sends, every
 *     request the page's own callers send passes it byte for byte and near misses are refused, and
 *     an upstream body with no Content-Length is cut off at the cap as it streams;
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
import { admitMwaMarkup, MWA_FONTS, MWA_MARKUP } from "../site/collect/mwa";
import { ALLOWED, MAX_UPSTREAM as RPC_MAX_UPSTREAM, onRequestPost, PUBLIC_MAINNET } from "../site/functions/api/solana";
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, none, some } from "@solana/kit";
import { extension, getMintEncoder } from "@solana-program/token-2022";
import { addresses, loadTrustedEdition } from "../publications/core/protocol";
import { MAINNET_GENESIS_HASH, SGT_GROUP_ADDRESS, SGT_METADATA_ADDRESS, verifyGenesisToken } from "../publications/core/genesisToken";
import { publicationTime } from "../publications/core/attestationCheck";
import { assertReviewedProgram } from "../publications/programImage";
import { LEGACY_WITHOUT_PUBLISHED_AT, PROGRAM_IMAGES } from "../publications/deployments";
import { confirmTransaction, prepareTransaction, request } from "../publications/rpc";
import { checkAttempt } from "../publications/lifecycle";

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
const directive = (name: string) =>
  (metaCsp ?? "").split(";").map((d) => d.trim().split(/\s+/)).find(([key]) => key === name)?.slice(1) ?? [];
ok("the CSP requires Trusted Types and allows only the default policy",
  directive("require-trusted-types-for").join(" ") === "'script'" && directive("trusted-types").join(" ") === "default");
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

// --- Mobile Wallet Adapter, through Wallet Standard ---------------------------------------------
/**
 * The page signs through `@solana-mobile/wallet-standard-mobile`'s registered wallet, never the
 * protocol's `transact`. That library assigns its own dialog templates to `innerHTML` and writes its
 * own `<style>` blocks, and the page admits exactly those: the Trusted Types `default` policy by
 * SHA-256 (`site/collect/mwa.ts`) and `style-src` by CSP hash. Both are recomputed here from the
 * installed package, and every `innerHTML` and style write in it must be one of those read below,
 * so a version change cannot slip a new sink or template past the policy.
 */
const mwaSource = readFileSync(resolve(site, "collect", "mwa.ts"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
const mwaDir = resolve(root, "node_modules", "@solana-mobile", "wallet-standard-mobile");
const mwaVersion = (JSON.parse(readFileSync(resolve(mwaDir, "package.json"), "utf8")) as { version: string }).version;
ok("wallet-standard-mobile is pinned to the exact version installed (0.5.0 or later handles Local Network Access)",
  manifest.devDependencies["@solana-mobile/wallet-standard-mobile"] === mwaVersion && /^0\.(?:[5-9]|\d{2,})\.\d+$/.test(mwaVersion));
ok("the page no longer calls the protocol's transact directly",
  !/mobile-wallet-adapter-protocol-kit|\btransact\(/.test(sources));
ok("MWA is registered as the recipe says, for the link's one chain and with no remote association",
  /registerMwa\(\{[\s\S]*appIdentity:[\s\S]*authorizationCache:[\s\S]*chains: \[chain\],[\s\S]*chainSelector: createDefaultChainSelector\(\),[\s\S]*onWalletNotFound: createDefaultWalletNotFoundHandler\(\),[\s\S]*\}\);/.test(mwaSource)
    && !/remoteHostAuthority|nostrRelay/.test(mwaSource) && /registerMobileWallet\(chain, location\.origin\)/.test(sources));

const library = readFileSync(resolve(mwaDir, "lib", "esm", "index.browser.js"), "utf8").replace(/\r\n/g, "\n");
const escapeRegExp = (s: string) => s.replace(/[$.*+?^{}()|[\]\\]/g, "\\$&");
/** A module-level constant of the library: a template or string literal with no substitution. */
function constant(name: string): string {
  const template = new RegExp(`\\bconst ${escapeRegExp(name)} = \`([^\`\\\\]*)\`;`).exec(library)?.[1];
  const quoted = new RegExp(`\\bconst ${escapeRegExp(name)} = "([^"\\\\]*)";`).exec(library)?.[1];
  const value = template ?? quoted;
  if (value === undefined || value.includes("${")) throw new Error(`wallet-standard-mobile ${mwaVersion}: ${name} is not a plain constant`);
  return value;
}
ok("wallet-standard-mobile assigns exactly the seven innerHTML values the policy was written for",
  JSON.stringify([...library.matchAll(/\.innerHTML = ([^;\n]+);/g)].map((m) => m[1])) === JSON.stringify([
    "modalHtml$1", "this.contentHtml", "fonts", "WALLET_NOT_FOUND_ERROR_MESSAGE", "BROWSER_NOT_SUPPORTED_ERROR_MESSAGE",
    "`An unexpected error occurred: ${error.message}`", "modalHtml",
  ]) && !/outerHTML|insertAdjacentHTML|document\.write|srcdoc|DOMParser|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe/.test(library));
ok("its style blocks are the modal frame's plus each dialog's, and the spinner's",
  JSON.stringify([...library.matchAll(/\.textContent = ([^;\n]+);/g)].map((m) => m[1])) === JSON.stringify(["css$6 + this.contentStyles", "css$1"]));
/** Which template and stylesheet each local-wallet dialog class carries. */
const dialog = (name: string, css: string, html: string) =>
  new RegExp(`var ${name} = class extends EmbeddedModal \\{\\s*contentStyles = ${escapeRegExp(css)};\\s*contentHtml = ${escapeRegExp(html)};`).test(library);
const blocked = /var LoopbackPermissionBlockedModal = class extends EmbeddedModal \{\s*contentStyles = css\$3;\s*get contentHtml\(\) \{\s*const instructions = getIsPwaLaunchedAsApp\(\) \? "([^"]*)" : "([^"]*)";\s*return ErrorDialogHtml\$1\.replace\("\{\{PERMISSION_INSTRUCTION_DETAIL\}\}", instructions\);/.exec(library);
ok("each local-wallet dialog pairs the template and stylesheet read here",
  dialog("ErrorModal", "css$5", "ErrorDialogHtml$3") && dialog("LocalConnectionModal", "css$4", "ErrorDialogHtml$2")
    && dialog("LoopbackPermissionModal", "css$2", "ErrorDialogHtml") && !!blocked);
const utf8Hash = (text: string, encoding: "hex" | "base64") => createHash("sha256").update(text, "utf8").digest(encoding);
const admitted = [
  constant("modalHtml$1"), constant("modalHtml"), constant("ErrorDialogHtml$3"), constant("ErrorDialogHtml$2"),
  constant("ErrorDialogHtml$1").replace("{{PERMISSION_INSTRUCTION_DETAIL}}", blocked?.[1] ?? ""),
  constant("ErrorDialogHtml$1").replace("{{PERMISSION_INSTRUCTION_DETAIL}}", blocked?.[2] ?? ""),
  constant("ErrorDialogHtml"), constant("WALLET_NOT_FOUND_ERROR_MESSAGE"), constant("BROWSER_NOT_SUPPORTED_ERROR_MESSAGE"),
];
const fonts = constant("fonts");
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const recomputed = admitted.map((text) => utf8Hash(text, "hex"));
ok("the Trusted Types policy admits exactly the library's dialog templates",
  sameSet(MWA_MARKUP, recomputed) && sameSet(MWA_FONTS, [utf8Hash(fonts, "hex")]));
if (!sameSet(MWA_MARKUP, recomputed)) console.error("  MWA_MARKUP should be:", recomputed.join(", "));
ok("the policy returns each template unchanged, the font links as nothing, and refuses everything else",
  admitted.every((text) => admitMwaMarkup(text) === text) && admitMwaMarkup(fonts) === ""
    && admitMwaMarkup("An unexpected error occurred: <img src=x onerror=alert(1)>") === null
    && admitMwaMarkup(admitted[0] + " ") === null && admitMwaMarkup("") === null);
const styleHashes = [
  constant("css$6") + constant("css$5"), constant("css$6") + constant("css$4"), constant("css$6") + constant("css$3"),
  constant("css$6") + constant("css$2"), constant("css$1"),
].map((css) => `'sha256-${utf8Hash(css, "base64")}'`);
ok("style-src allows the same origin and exactly the dialogs' five style blocks",
  directive("style-src")[0] === "'self'" && sameSet(directive("style-src").slice(1), styleHashes));
if (!sameSet(directive("style-src").slice(1), styleHashes)) console.error("  style-src hashes should be:", styleHashes.join(" "));
ok("connect-src allows MWA's Local Network Access request and the gateways' own hosts, nothing wider",
  directive("connect-src").includes("http://localhost") && directive("connect-src").every((source) => !source.includes("*.")));

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
ok("bundle reads both gateways at /raw/ and carries MWA's Local Network Access handling",
  bundled.includes("https://arweave.net/raw/") && bundled.includes("https://turbo-gateway.com/raw/") && bundled.includes("loopback-network"));

/** One request through the proxy, same-origin, against an upstream that answers with `upstream`. */
async function viaProxy(body: string, upstream: () => Response, env: { SOLANA_RPC_URL?: string } = {}) {
  const realFetch = globalThis.fetch;
  let target: string | null = null;
  globalThis.fetch = (async (input: string | URL | Request) => { target = String(input); return upstream(); }) as typeof fetch;
  try {
    const response = await onRequestPost({
      env,
      request: new Request("https://erashot.app/api/solana", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://erashot.app" },
        body,
      }),
    });
    return { response, target: target as string | null };
  } finally {
    globalThis.fetch = realFetch;
  }
}
const rpcAnswer = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { headers: { "Content-Type": "application/json" } });
const heightCall = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockHeight", params: [] });

/** The proxy's upstream: the `SOLANA_RPC_URL` binding when set, Solana's public mainnet otherwise, said in a header. */
async function upstreamChecks() {
  const fallback = await viaProxy(heightCall, rpcAnswer);
  const bound = await viaProxy(heightCall, rpcAnswer, { SOLANA_RPC_URL: "https://rpc.example/key" });
  ok("the proxy forwards to SOLANA_RPC_URL when bound and to https://api.mainnet.solana.com otherwise",
    PUBLIC_MAINNET === "https://api.mainnet.solana.com" && fallback.response.ok && fallback.target === PUBLIC_MAINNET
      && bound.response.ok && bound.target === "https://rpc.example/key");
  const refused = await viaProxy(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [] }), rpcAnswer);
  ok("on the public fallback every answer, refusals included, carries X-Upstream: public; with the secret, none does",
    fallback.response.headers.get("X-Upstream") === "public" && refused.response.status === 400
      && refused.response.headers.get("X-Upstream") === "public" && bound.response.headers.get("X-Upstream") === null);
}

/**
 * Every request the collect page sends `/api/solana`, recorded from the page's own callers against a
 * stubbed chain and kept byte for byte: the edition read (`loadTrustedEdition`, whose `account` also
 * serves `hasCollected` and the offer), the program check's sliced reads (`assertReviewedProgram`,
 * through both ELF chunks), the Genesis Token check (`verifyGenesisToken`), the device row's time
 * (`publicationTime`: a recorded `published_at`, and a legacy deployment's receipt history over two
 * pages), the quote (`prepareTransaction`), the attempt check
 * (`checkAttempt`), the confirmation (`confirmTransaction`) and the block height `collect` reads
 * before the wallet opens (`site/collect/page.ts`).
 */
async function pageRequests(): Promise<string[]> {
  const ENDPOINT = "https://erashot.app/api/solana";
  const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
  // A legacy program: its Edition records no publication time, so the page walks the receipt's history.
  const [program, image] = Object.entries(PROGRAM_IMAGES.devnet).find(([key]) => LEGACY_WITHOUT_PUBLISHED_AT.includes(key))!;
  const [programData] = await getProgramDerivedAddress({
    programAddress: address(LOADER), seeds: [getAddressEncoder().encode(address(program))],
  });
  const mint = "21Q8vbf36J9vJ6DDkUBjC29BKYMQdKZ5fs9LcJZQY4qH", holder = "BSuFrMcYhSKS5dkprGtC17nVbP4VSFNvZzncnRtkVLpT";
  const sgt = new Uint8Array(getMintEncoder().encode({
    mintAuthority: none(), supply: 1n, decimals: 0, isInitialized: true, freezeAuthority: none(),
    extensions: some([
      extension("MetadataPointer", { authority: none(), metadataAddress: some(address(SGT_METADATA_ADDRESS)) }),
      extension("TokenGroupMember", { mint: address(mint), group: address(SGT_GROUP_ADDRESS), memberNumber: 7n }),
    ]),
  }));
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const held = (owner: string, bytes: Uint8Array, space = bytes.length) =>
    ({ owner, executable: owner === LOADER, lamports: 1, rentEpoch: 0, space, data: [base64(bytes), "base64"] });
  const SIG = "5".repeat(88);
  const context = { slot: 100 };
  // The device row's time: a current Edition with `published_at` and `seeker_only` (8 + 302 bytes),
  // and one without either (8 + 293) under the legacy program, whose receipt history is walked.
  const NONCE = "cd".repeat(32);
  const RECORDING = getAddressDecoder().decode(new Uint8Array(32).fill(7));
  const recordedEdition = (await addresses(RECORDING, holder, NONCE)).edition;
  const legacyEdition = (await addresses(program, holder, NONCE)).edition;
  const editionAccount = (publishedAt: bigint | null) => {
    const text = (s: string) => { const b = new TextEncoder().encode(s); return [u32(b.length), b]; };
    const time = new Uint8Array(publishedAt === null ? 0 : 8);
    if (publishedAt !== null) new DataView(time.buffer).setBigInt64(0, publishedAt, true);
    const parts = [createHash("sha256").update("account:Edition").digest().subarray(0, 8),
      getAddressEncoder().encode(address(holder)), Buffer.from(NONCE, "hex"), new Uint8Array(96),
      new Uint8Array([1, 0, 1, 0, 255]), time, new Uint8Array(publishedAt === null ? 0 : 1),
      ...text("Sample"), ...text(`https://arweave.net/${"A".repeat(43)}`)];
    const out = new Uint8Array(publishedAt === null ? 301 : 310);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  };
  const answer = (method: string, params: any[]): unknown => {
    switch (method) {
      case "getAccountInfo": {
        const slice = params[1]?.dataSlice as { offset: number; length: number } | undefined;
        if (params[0] === program) return { context, value: held(LOADER, new Uint8Array([...u32(2), ...getAddressEncoder().encode(programData)])) };
        if (params[0] === programData) {
          // The header with no authority, then zeros: every chunk is read before the hash refuses.
          const bytes = new Uint8Array(slice!.length);
          if (slice!.offset === 0) bytes.set(u32(3));
          return { context, value: held(LOADER, bytes, 45 + image.bytes) };
        }
        if (params[0] === mint) return { context, value: held("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", sgt) };
        if (params[0] === recordedEdition) return { context, value: held(RECORDING, editionAccount(1_790_000_000n)) };
        if (params[0] === legacyEdition) return { context, value: held(program, editionAccount(null)) };
        return { context, value: null };
      }
      case "getGenesisHash": return MAINNET_GENESIS_HASH;
      case "getTokenAccountsByOwner": return { context, value: [] };
      // A full first page, so the second asks with `before`.
      case "getSignaturesForAddress": return params[1]?.before ? [] : Array.from({ length: 1000 }, () => ({ signature: SIG, err: null, slot: 7 }));
      case "getTransaction": return null;
      case "getLatestBlockhash": return { context, value: { blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 200 } };
      case "simulateTransaction":
        return { context, value: { err: null, logs: [], unitsConsumed: 50_000, returnData: null,
          accounts: [{ lamports: 9_000_000_000, owner: "11111111111111111111111111111111", executable: false, rentEpoch: 0, space: 0, data: ["", "base64"] }] } };
      case "getRecentPrioritizationFees": return [];
      case "getFeeForMessage": return { context, value: 5_000 };
      case "getBalance": return { context, value: 10_000_000_000 };
      case "getSignatureStatuses": return { context, value: [null] };
      case "getBlockHeight": return 1_000;
      default: throw new Error(`the page is not expected to call ${method}`);
    }
  };
  const realFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const text = String(init?.body);
    bodies.push(text);
    const { id, method, params } = JSON.parse(text);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: answer(method, params) }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await loadTrustedEdition(ENDPOINT, holder, "mainnet-beta").catch(() => undefined);
    await assertReviewedProgram(ENDPOINT, program, "devnet").catch(() => undefined);
    await verifyGenesisToken(ENDPOINT, mint, holder);
    await publicationTime(ENDPOINT, RECORDING, recordedEdition);
    await publicationTime(ENDPOINT, program, legacyEdition).catch(() => undefined);
    await prepareTransaction(ENDPOINT, holder, [{ programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [], data: new Uint8Array([1]) }]);
    await checkAttempt(ENDPOINT, { lastValidBlockHeight: "10", signature: SIG }, { operation: "collect" });
    await confirmTransaction(ENDPOINT, SIG, 10n).catch(() => undefined);
    await request(ENDPOINT, "getBlockHeight", [{ commitment: "confirmed" }]);
  } finally {
    globalThis.fetch = realFetch;
  }
  return bodies;
}

/** The allowlist and the per-method shapes, held to the page's own requests and to near misses. */
async function shapeChecks() {
  const bodies = await pageRequests();
  const methods = new Set(bodies.map((body) => JSON.parse(body).method as string));
  ok(`the proxy allowlist equals the methods the page sends (${[...methods].sort().join(", ")})`,
    methods.size === ALLOWED.size && [...methods].every((method) => ALLOWED.has(method)));
  const shapes = (method: string) => bodies.filter((body) => JSON.parse(body).method === method).map((body) => JSON.stringify(JSON.parse(body).params));
  ok("the recording reached the sliced ELF chunks, the paged history and the mint-filtered token read",
    shapes("getAccountInfo").some((params) => params.includes('"dataSlice":{"offset":262144,"length":')) &&
    shapes("getSignaturesForAddress").some((params) => params.includes('"before"')) && shapes("getTokenAccountsByOwner").length === 1);
  const passed = await Promise.all(bodies.map(async (body) => (await viaProxy(body, rpcAnswer)).response.status));
  const failed = bodies.filter((_, index) => passed[index] !== 200);
  ok(`every request the page sends passes the proxy, byte for byte (${bodies.length} requests)`, failed.length === 0);
  if (failed.length) console.error("  refused:", failed.join("\n  "));

  const OWNER = "BSuFrMcYhSKS5dkprGtC17nVbP4VSFNvZzncnRtkVLpT", MINT = "21Q8vbf36J9vJ6DDkUBjC29BKYMQdKZ5fs9LcJZQY4qH", SIG = "5".repeat(88);
  const call = (method: string, params: unknown[]) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const nearMisses: [string, string][] = [
    ["token accounts by program, not by mint", call("getTokenAccountsByOwner", [OWNER, { programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }, { encoding: "jsonParsed", commitment: "confirmed" }])],
    ["token accounts with a second filter key", call("getTokenAccountsByOwner", [OWNER, { mint: MINT, programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }, { encoding: "jsonParsed", commitment: "confirmed" }])],
    ["token accounts as base64", call("getTokenAccountsByOwner", [OWNER, { mint: MINT }, { encoding: "base64", commitment: "confirmed" }])],
    ["token accounts with no options", call("getTokenAccountsByOwner", [OWNER, { mint: MINT }])],
    ["token accounts with a data slice", call("getTokenAccountsByOwner", [OWNER, { mint: MINT }, { encoding: "jsonParsed", commitment: "confirmed", dataSlice: { offset: 0, length: 1 } }])],
    ["a history of 1001 signatures", call("getSignaturesForAddress", [OWNER, { limit: 1001, commitment: "confirmed" }])],
    ["a history bounded by `until`", call("getSignaturesForAddress", [OWNER, { limit: 1000, commitment: "confirmed", until: SIG }])],
    ["a history with no limit", call("getSignaturesForAddress", [OWNER, { commitment: "confirmed" }])],
    ["a history before something that is not a signature", call("getSignaturesForAddress", [OWNER, { limit: 10, commitment: "confirmed", before: "x" }])],
    ["a transaction as base64", call("getTransaction", [SIG, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }])],
    ["a transaction with no version", call("getTransaction", [SIG, { encoding: "jsonParsed", commitment: "confirmed" }])],
    ["a transaction with no options", call("getTransaction", [SIG])],
    ["a transaction by something that is not a signature", call("getTransaction", [OWNER + "!", { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }])],
    ["an account as jsonParsed", call("getAccountInfo", [OWNER, { encoding: "jsonParsed", commitment: "confirmed" }])],
    ["an account as base64+zstd", call("getAccountInfo", [OWNER, { encoding: "base64+zstd", commitment: "confirmed" }])],
    ["an account slice wider than one ELF chunk", call("getAccountInfo", [OWNER, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 262_145 } }])],
    ["an account slice with no length", call("getAccountInfo", [OWNER, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0 } }])],
    ["an account with an extra option", call("getAccountInfo", [OWNER, { encoding: "base64", commitment: "confirmed", minContextSlot: 1 }])],
    ["an account option named after Object.prototype", call("getAccountInfo", [OWNER, { encoding: "base64", commitment: "confirmed", toString: 1 }])],
    ["an account read with a third param", call("getAccountInfo", [OWNER, { encoding: "base64", commitment: "confirmed" }, {}])],
    ["accounts in a batch the page never sends", call("getMultipleAccounts", [[OWNER], { encoding: "base64", commitment: "confirmed" }])],
  ];
  const refusedStatus = await Promise.all(nearMisses.map(async ([, body]) => {
    const { response, target } = await viaProxy(body, rpcAnswer);
    return response.status === 400 && target === null;
  }));
  const through = nearMisses.filter((_, index) => !refusedStatus[index]).map(([name]) => name);
  ok(`the proxy refuses what the page never sends, before forwarding (${nearMisses.length} near misses)`, through.length === 0);
  if (through.length) console.error("  forwarded:", through.join("; "));
}

/**
 * The upstream body is counted as it streams: an answer with no Content-Length is cut off at the
 * cap and its stream cancelled, not read to the end.
 */
async function streamChecks() {
  let pulled = 0, cancelled = false;
  const endless = () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(65_536).fill(0x20)); },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "application/json" } });
  const over = await viaProxy(heightCall, endless);
  ok(`an undeclared upstream body past 1 MB is refused and its stream cancelled, not read to the end (${pulled} chunks)`,
    over.response.status === 502 && cancelled && pulled <= Math.ceil(RPC_MAX_UPSTREAM / 65_536) + 2);
  const padded = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(RPC_MAX_UPSTREAM - 64) });
  const within = await viaProxy(heightCall, () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { const bytes = new TextEncoder().encode(padded); for (let at = 0; at < bytes.length; at += 65_536) controller.enqueue(bytes.slice(at, at + 65_536)); controller.close(); },
  })));
  ok("an undeclared upstream body within 1 MB is read and forwarded", within.response.status === 200 && (await within.response.text()).length === padded.length);
  const declared = await viaProxy(heightCall, () => new Response("{}", { headers: { "Content-Length": String(RPC_MAX_UPSTREAM + 1) } }));
  ok("a declared oversize upstream body is refused unread", declared.response.status === 502);
}
// One after the other: each swaps the global `fetch`. The summary below waits for it.
const proxyChecked = upstreamChecks()
  .then(() => shapeChecks())
  .then(() => streamChecks())
  .catch((error: unknown) => {
    console.error(error);
    ok("the proxy checks ran", false);
  });

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
  "http://www.w3.org": "SVG namespace URIs in the page's QR and in MWA's dialog markup, not fetches",
  "https://solanamobile.com": "MWA's wallet listing: the wallet's `url` and the Find a wallet navigation, not fetches",
  "https://fonts.googleapis.com": "MWA's font links, which the Trusted Types policy (`mwa.ts`) replaces with nothing",
  "https://fonts.gstatic.com": "MWA's font links, which the Trusted Types policy (`mwa.ts`) replaces with nothing",
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
for (const m of bundled.matchAll(/\b(wss?|https?):\/\/([A-Za-z0-9.-]+)(:(\d+|\$\{[^}]*\}))?/g)) {
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
ok("MWA's localhost WebSocket and permission request are allowed",
  literals.has("ws://localhost:*") && connectSrc.includes("ws://localhost:*")
    && literals.has("http://localhost") && connectSrc.includes("http://localhost"));
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
    // A key no serial is looked up by drops that entry, not the list.
    google(JSON.stringify({ entries: {
      "2c8cdddfd5e03bfc": { status: "REVOKED" },
      "2C8CDDDFD5E03BFD": { status: "REVOKED" },
      "serial-1": { status: "SUSPENDED" },
      "9": { status: "SUSPENDED" },
    } }));
    const odd = await call();
    await Promise.all(pending);
    ok("an entry under an odd key is dropped and the rest is served",
      odd.status === 200 && await odd.text() === JSON.stringify({ entries: {
        "9": { status: "SUSPENDED" },
        "2c8cdddfd5e03bfc": { status: "REVOKED" },
      } }));
    store.clear();
    const refusals: [string, string, ResponseInit | undefined][] = [
      ["unavailable at Google", "unavailable", { status: 503 }],
      ["declared larger than the bound", "{}", { headers: { "Content-Length": String(MAX_UPSTREAM + 1) } }],
      ["not JSON", "<html></html>", undefined],
      ["not the documented shape: no entries", JSON.stringify({ list: {} }), undefined],
      ["not the documented shape: an entry without a status", JSON.stringify({ entries: { ab: { reason: "KEY_COMPROMISE" } } }), undefined],
      ["not the documented shape: an entry without a status, under an odd key", JSON.stringify({ entries: { AB: { reason: "KEY_COMPROMISE" } } }), undefined],
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

// One after the other: each swaps the global `fetch`.
void proxyChecked
  .then(() => moderationFetch())
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
