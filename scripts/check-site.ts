/**
 * Gate for erashot.app (`site/`), the static pages the app links to. Runs in `npm test` and needs
 * no network. It holds:
 *   - `.well-known/assetlinks.json` is byte-identical to the file Android verified the App Link
 *     against, names the release certificate in `dapp-store/signing-certificate.json`, and is
 *     served as JSON;
 *   - `_headers` gives every static page its policy, and the <meta> copies match;
 *   - the collect link page: its one inline script is the script `script-src` hashes, it fetches
 *     nothing, it says nothing but the name and "Open in Signshot", and the script turns exactly a
 *     link `collectUrl()` builds into an `intent://` for the app's package, and anything else into
 *     no control;
 *   - every erashot.app URL the app builds (terms, privacy, moderation list, collect and album
 *     links, the wallet identity icon) is a file in `site/public`;
 *   - terms, Report, Block and the moderation list (`src/moderation/core.ts`): the strict parse,
 *     failing open, the served list hiding nothing, the report email, the terms page's §10.6
 *     clauses, and agreement before a first publish or collect in the app;
 *   - the app's re-quote rule (`sameReviewedTransaction`, behind `refreshedQuote`);
 *   - the build copies `public/` verbatim and ships no Functions and no script file.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { address, type Instruction } from "@solana/kit";
import type { AttestationBundle } from "../publications/core/attestation";
import { albumUrl } from "../publications/core/album";
import { addresses, buyInstruction, collectInstruction, collectUrl } from "../publications/core/protocol";
import type { CoreMetadata } from "../publications/types";
import { prepareTransaction } from "../publications/rpc";
import {
  MAX_BLOCKED, MODERATION_MAX_BYTES, MODERATION_MAX_ENTRIES, MODERATION_URL, TERMS_URL, TERMS_VERSION,
  fetchModerationList, parseModerationList, readBlockList, reportMailto, termsAgreed, veilOf, withBlocked,
} from "../src/moderation/core";
import { sameReviewedTransaction } from "../src/prints/quoteRefresh";
import { APP_IDENTITY } from "../src/solana/appIdentity";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const site = resolve(root, "site");
const publicDir = resolve(site, "public");

let failures = 0;
function ok(name: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failures += 1;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };
const exists = (path: string) => { try { statSync(path); return true; } catch { return false; } };

const A = "So11111111111111111111111111111111111111112";
const B = "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// --- The App Link association ------------------------------------------------------------------------
const headers = readFileSync(resolve(publicDir, "_headers"), "utf8");
const headerLines = headers.split(/\r?\n/);
/** The first header line under an exact `_headers` path rule, or "". */
const ruleAfter = (path: string) => { const at = headerLines.findIndex((line) => line.trim() === path); return at < 0 ? "" : (headerLines[at + 1] ?? "").trim(); };

const assetlinks = readFileSync(resolve(publicDir, ".well-known", "assetlinks.json"));
ok("assetlinks.json is byte-identical to the verified file",
  sha256(assetlinks) === "cf53cd9431f8c4214e9813b098476fa1903f3d11144271896ffb735f07e84279");
const cert = JSON.parse(readFileSync(resolve(root, "dapp-store", "signing-certificate.json"), "utf8")) as { packageName: string; sha256: string };
const links = JSON.parse(assetlinks.toString("utf8")) as { target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
ok("assetlinks.json names the release package and certificate",
  links.length === 1 && links[0].target.package_name === cert.packageName
    && links[0].target.sha256_cert_fingerprints.map((f) => f.replace(/:/g, "").toLowerCase()).join() === cert.sha256);
ok("_headers labels /.well-known/* as JSON", ruleAfter("/.well-known/*") === "Content-Type: application/json");

// --- The static pages' policy --------------------------------------------------------------------------
const STATIC_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const metaCsp = (html: string) => /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
const withoutFrameAncestors = (csp: string) => csp.replace(/;\s*frame-ancestors 'none'/, "");
ok("_headers serves every static page under the static policy and the list with a short cache",
  ["/", "/index.html", "/privacy", "/privacy.html", "/terms", "/terms/", "/terms/index.html", "/404.html"]
    .every((path) => ruleAfter(path) === `Content-Security-Policy: ${STATIC_CSP}`)
    && ruleAfter("/moderation.json") === "Cache-Control: public, max-age=300");
ok("404.html <meta> CSP equals the static policy minus frame-ancestors",
  metaCsp(readFileSync(resolve(publicDir, "404.html"), "utf8")) === withoutFrameAncestors(STATIC_CSP));
const staticPages = ["index.html", "404.html", "privacy.html", join("terms", "index.html")].map((file) => readFileSync(resolve(publicDir, file), "utf8"));
ok("the static pages carry no script and no inline style",
  staticPages.every((html) => !/<script/i.test(html) && !/ style=/.test(html) && !/<style/i.test(html)));

// --- The collect link page ----------------------------------------------------------------------------
const collectPage = readFileSync(resolve(publicDir, "collect", "index.html"), "utf8").replace(/\r\n?/g, "\n");
const collectRule = headerLines.findIndex((line) => line.trim() === "/collect/*");
const headerCsp = collectRule < 0 ? "" : (headerLines[collectRule + 1] ?? "").trim().replace(/^Content-Security-Policy:\s*/, "");
const pageCsp = metaCsp(collectPage) ?? "";
const directive = (name: string) => pageCsp.split(";").map((d) => d.trim().split(/\s+/)).find(([key]) => key === name)?.slice(1) ?? [];
ok("collect/index.html <meta> CSP equals the _headers rule minus frame-ancestors",
  !!headerCsp && headerCsp.endsWith("; frame-ancestors 'none'") && withoutFrameAncestors(headerCsp) === pageCsp);
const scripts = [...collectPage.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
const inline = scripts[0]?.[2] ?? "";
const scriptHash = `'sha256-${createHash("sha256").update(inline, "utf8").digest("base64")}'`;
ok("the page has one inline script and script-src allows exactly its hash",
  scripts.length === 1 && scripts[0][1] === "" && directive("script-src").join(" ") === scriptHash);
if (directive("script-src").join(" ") !== scriptHash) console.error("  script-src should be:", scriptHash);
ok("the page fetches nothing and allows no Trusted Types policy",
  directive("default-src").join() === "'none'" && directive("connect-src").join() === "'none'"
    && directive("require-trusted-types-for").join() === "'script'" && directive("trusted-types").join() === "'none'"
    && directive("style-src").join() === "'self'" && !/ style=|<style/i.test(collectPage));
const words = collectPage.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<(title|head)[\s\S]*?<\/\1>/g, "")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
ok(`the page says "Open in Signshot" and nothing else (${words})`,
  words === "Open in Signshot" && /<a id="open" class="button primary" hidden>Open in Signshot<\/a>/.test(collectPage));

/** What the page's script makes of a query string: the control's href, or null when it stays hidden. */
function handoff(search: string): string | null {
  const open = { href: "", hidden: true };
  runInNewContext(inline, {
    URLSearchParams,
    location: { search },
    document: { getElementById: (id: string) => (id === "open" ? open : null) },
  });
  return open.hidden ? null : open.href;
}
const app = JSON.parse(readFileSync(resolve(root, "app.json"), "utf8")) as {
  expo: { android: { package: string; intentFilters: { data: { scheme: string; host: string; pathPrefix: string }[] }[] } };
};
const appLink = app.expo.android.intentFilters[0].data[0];
/** The intent for a link, as Chrome documents it: host and path, then the scheme and package in the fragment. */
const intentFor = (link: string) => {
  const url = new URL(link);
  return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=${url.protocol.slice(0, -1)};package=${app.expo.android.package};` +
    `S.browser_fallback_url=${encodeURIComponent(`${url.origin}/`)};end`;
};
ok("the intent names the app's package, the App Link's host and path, and the release certificate's package",
  app.expo.android.package === "app.seekershot" && cert.packageName === app.expo.android.package
    && appLink.scheme === "https" && appLink.host === "erashot.app" && appLink.pathPrefix === "/collect");
const mainnetLink = collectUrl(A, "mainnet-beta"), devnetLink = collectUrl(A, "devnet");
ok("a collect link, mainnet or devnet, opens exactly that link in the app",
  handoff(new URL(mainnetLink).search) === intentFor(mainnetLink) && handoff(new URL(devnetLink).search) === intentFor(devnetLink)
    && handoff(`?core=${B}&cluster=devnet`) === intentFor(collectUrl(B, "devnet"))
    && handoff(`?core=${"1".repeat(32)}`) === intentFor(collectUrl("1".repeat(32), "mainnet-beta")));
ok("parameters a messaging app adds are dropped, not handed on",
  handoff(`?utm_source=chat&core=${A}&fbclid=x`) === intentFor(mainnetLink));
const refused: [string, string][] = [
  ["no query", ""],
  ["an empty core", "?core="],
  ["two cores", `?core=${A}&core=${A}`],
  ["a cluster other than devnet", `?core=${A}&cluster=mainnet-beta`],
  ["testnet", `?core=${A}&cluster=testnet`],
  ["an empty cluster", `?core=${A}&cluster=`],
  ["two clusters", `?core=${A}&cluster=devnet&cluster=devnet`],
  ["a character outside base58", `?core=${A.slice(0, -1)}0`],
  ["too many bytes", `?core=${"z".repeat(44)}`],
  ["too few bytes", `?core=2${"1".repeat(31)}`],
  ["a core carrying an intent fragment", `?core=${A}${encodeURIComponent("#Intent;package=evil;end")}`],
  ["an album link", `?album=${A}&cluster=devnet`],
];
const shown = refused.filter(([, search]) => handoff(search) !== null).map(([name]) => name);
ok(`anything else shows no control (${refused.length} cases)`, shown.length === 0);
if (shown.length) console.error("  shown:", shown.join("; "));
const kitAccepts = (text: string) => { try { address(text); return true; } catch { return false; } };
ok("the page's address test agrees with @solana/kit's on the cores above",
  [A, B, "1".repeat(32)].every(kitAccepts) && [`${A.slice(0, -1)}0`, "z".repeat(44), `2${"1".repeat(31)}`].every((text) => !kitAccepts(text)));

// --- Every erashot.app URL the app builds is served ----------------------------------------------------
/** The file Cloudflare Pages answers a URL with: `/x/` is `x/index.html`; `/x` is `x`, `x.html` or `x/index.html`. */
function servedBy(link: string): string | null {
  const url = new URL(link);
  if (url.origin !== "https://erashot.app") return null;
  const path = decodeURIComponent(url.pathname);
  const candidates = path.endsWith("/") ? [`${path}index.html`] : [path, `${path}.html`, `${path}/index.html`];
  return candidates.map((candidate) => resolve(publicDir, `.${candidate}`)).find(isFile) ?? null;
}
const source = (...path: string[]) => readFileSync(resolve(root, ...path), "utf8");
const constant = (text: string, name: string) => new RegExp(`const ${name} = "([^"]+)";`).exec(text)?.[1] ?? "";
const linking = source("src", "navigators", "linking.ts");
const collectOrigin = constant(linking, "COLLECT_ORIGIN"), collectPath = constant(linking, "COLLECT_PATH");
const built: [string, string, string][] = [
  ["terms", TERMS_URL, "terms/index.html"],
  ["privacy", constant(source("src", "screens", "SettingsScreen.tsx"), "PRIVACY_URL"), "privacy.html"],
  ["moderation list", MODERATION_URL, "moderation.json"],
  ["wallet identity", APP_IDENTITY.uri, "index.html"],
  ["wallet identity icon", new URL(APP_IDENTITY.icon, `${APP_IDENTITY.uri}/`).href, "icon.png"],
  ["App Link route", `${collectOrigin}/${collectPath}/`, "collect/index.html"],
  ["mainnet collect link", mainnetLink, "collect/index.html"],
  ["devnet collect link", devnetLink, "collect/index.html"],
  ["album link", albumUrl(A, "devnet"), "collect/index.html"],
];
const unserved = built.filter(([, link, file]) => servedBy(link) !== resolve(publicDir, file)).map(([name, link]) => `${name} ${link}`);
ok(`every erashot.app URL the app builds is a file in site/public (${built.length})`, unserved.length === 0 && collectOrigin === "https://erashot.app");
if (unserved.length) console.error("  not served:", unserved.join("; "));
/** Every erashot.app literal in the app's sources, so a new one cannot go unchecked. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
}
const literals = new Map<string, string>();
for (const file of [...sources(resolve(root, "src")), ...sources(resolve(root, "publications"))])
  for (const match of readFileSync(file, "utf8").matchAll(/https:\/\/erashot\.app(\/[A-Za-z0-9._\/-]*)?/g))
    literals.set(match[0], relative(root, file));
const strays = [...literals].filter(([link]) => !servedBy(link)).map(([link, file]) => `${link} (${file})`);
ok(`no erashot.app literal in src/ or publications/ names a path the site does not serve (${literals.size})`, strays.length === 0);
if (strays.length) console.error("  not served:", strays.join("; "));

// --- Terms, Report, Block and the moderation list -------------------------------------------------
// The Publisher Policy asks a dApp with user content for user terms people agree to, an in-app
// report, moderation, and a block; the Developer Agreement (§2.1, §10.6) for a linked EULA that
// disclaims warranties and liability for the Solana Mobile Parties and says they are not a party.
const throws = (run: () => unknown) => { try { run(); return false; } catch { return true; } };
const served = parseModerationList(readFileSync(resolve(publicDir, "moderation.json"), "utf8"));
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
ok("Report is an email to support with the edition in the subject and the collect link in the body",
  reportMailto(A, devnetLink) === `mailto:support@erashot.app?subject=Report%20${A}&body=${encodeURIComponent(devnetLink)}`);
ok("only an agreement to the current terms counts",
  termsAgreed(String(TERMS_VERSION)) && !termsAgreed(String(TERMS_VERSION + 1)) && !termsAgreed(null) && !termsAgreed(""));
const prints = ["CollectSheet.tsx", "PrintSheet.tsx"].map((file) => source("src", "prints", file));
ok("the app asks for the terms before a first publish and a first collect",
  prints.every((text) => /(terms|agreement)\.agreed !== true \? \(\s*<TermsAgreement /.test(text)));
ok("the Collect sheet reports, blocks and veils",
  /reportMailto\(target\.edition, collectUrl\(target\.edition, cluster\)\)/.test(prints[0])
    && /moderation\.setBlocked\(e\.creator, !blocked\)/.test(prints[0]) && /!!e && !veil && \(\s*<PhotoFrame/.test(prints[0]));
ok("Settings links the terms beside the privacy policy",
  /<LinkRow label=\{copy\.privacyLink\} onPress=\{onPrivacy\} \/>\s*<LinkRow label=\{copy\.termsLink\} onPress=\{onTerms\} \/>/
    .test(source("src", "screens", "SettingsScreen.tsx")));
const termsPage = readFileSync(resolve(publicDir, "terms", "index.html"), "utf8").replace(/\s+/g, " ");
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
ok("the terms page names the version the app asks agreement to, at the URL it links",
  termsPage.includes(`Version ${TERMS_VERSION} ·`) && TERMS_URL === "https://erashot.app/terms/" && MODERATION_URL === "https://erashot.app/moderation.json");
const privacyPage = readFileSync(resolve(publicDir, "privacy.html"), "utf8").replace(/\s+/g, " ");
ok("the privacy page says blocks and the agreement stay on the phone and names erashot.app",
  /blocked publishers and your terms agreement are stored on your phone/.test(privacyPage)
    && /Signshot Android app/.test(privacyPage) && /erashot\.app/.test(privacyPage)
    && /Network services receive your IP address/.test(privacyPage));
ok("the email addresses are outside Cloudflare's email obfuscation, which the pages' CSP would leave unreadable",
  staticPages.every((page) => !page.includes("mailto:") || (page.includes("<!--email_off-->") && page.includes("<!--email_on-->"))));

// --- The app's re-quote rule --------------------------------------------------------------------------
/**
 * `refreshedQuote` re-prepares right before the wallet opens and accepts only the reviewed
 * transaction (`sameReviewedTransaction`): exact estimate and identical bytes but for the
 * blockhash. A claim's price, revision and copy number are in its bytes.
 */
async function requoteChecks() {
  const ENDPOINT = "https://rpc.invalid";
  const collector = "BSuFrMcYhSKS5dkprGtC17nVbP4VSFNvZzncnRtkVLpT";
  const { manifest: commitment } = JSON.parse(readFileSync(resolve(here, "fixtures", "attestation-sample.json"), "utf8")) as AttestationBundle;
  const keys = await addresses(commitment.program, commitment.creator, commitment.nonce);
  const priced: CoreMetadata = {
    cluster: commitment.cluster, program: commitment.program, edition: keys.edition, collection: keys.collection,
    creator: commitment.creator, nonce: commitment.nonce, title: "Sample", supply: 3,
    image: "https://arweave.net/" + "A".repeat(43), imageHash: commitment.imageHash, width: 2448, height: 3264, description: "",
  };
  const quoted = async (ix: Instruction, blockhash: string, spend = 1_000_000) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const { id, method } = JSON.parse(String(init?.body));
      const context = { slot: 100 };
      const result =
        method === "getLatestBlockhash" ? { context, value: { blockhash, lastValidBlockHeight: 1_150 } }
        : method === "simulateTransaction" ? { context, value: { err: null, logs: [], unitsConsumed: 50_000, returnData: null,
          accounts: [{ lamports: 10_000_000_000 - spend, owner: "11111111111111111111111111111111", executable: false, rentEpoch: 0, space: 0, data: ["", "base64"] }] } }
        : method === "getRecentPrioritizationFees" ? []
        : method === "getFeeForMessage" ? { context, value: 5_000 }
        : method === "getBalance" ? { context, value: 10_000_000_000 }
        : undefined;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      return await prepareTransaction(ENDPOINT, collector, [ix]);
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const [first, later] = ["EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn"];
  const reviewed = await quoted(await buyInstruction(priced, collector, 2, 5_000_000n, 1), first);
  const same = await quoted(await buyInstruction(priced, collector, 2, 5_000_000n, 1), later);
  ok("the same claim on a fresh blockhash is the reviewed transaction, and its lifetime is the fresh one",
    sameReviewedTransaction(reviewed, same) && same.lastValidBlockHeight === 1_150n
      && !Buffer.from(reviewed.transaction.messageBytes).equals(Buffer.from(same.transaction.messageBytes)));
  const changed: boolean[] = [];
  // One at a time: each swaps the global `fetch`.
  for (const [ix, spend] of [
    [await buyInstruction(priced, collector, 2, 6_000_000n, 1), undefined],
    [await buyInstruction(priced, collector, 2, 5_000_000n, 2), undefined],
    [await buyInstruction(priced, collector, 3, 5_000_000n, 1), undefined],
    [await collectInstruction(priced, collector, 2), undefined],
    [await buyInstruction(priced, collector, 2, 5_000_000n, 1), 1_000_001],
  ] as const)
    changed.push(!sameReviewedTransaction(reviewed, await quoted(ix, later, spend)));
  ok("a changed price, revision, copy number, a free collect or a changed estimate is not the reviewed transaction",
    changed.length === 5 && changed.every(Boolean));
}

// --- The build -----------------------------------------------------------------------------------------
const build = spawnSync(process.execPath, [resolve(site, "build.mjs")], { cwd: root, encoding: "utf8" });
ok("site build succeeds", build.status === 0);
if (build.status !== 0) console.error(build.stdout + build.stderr);
const dist = resolve(site, "dist");
/** Every file under `base`, as a slash-separated path relative to it. */
function files(base: string, dir = base): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(base, join(dir, entry.name)) : [relative(base, join(dir, entry.name)).replace(/\\/g, "/")]);
}
const shipped = build.status === 0 ? files(dist).sort() : [];
const published = files(publicDir).sort();
ok(`dist is public/, byte for byte (${shipped.length} files)`,
  shipped.length > 0 && shipped.join() === published.join()
    && shipped.every((file) => sha256(readFileSync(resolve(dist, file))) === sha256(readFileSync(resolve(publicDir, file)))));
ok("dist ships no Functions, no middleware and no script file",
  !exists(resolve(site, "functions")) && !exists(resolve(dist, "functions")) && !exists(resolve(dist, "_worker.js"))
    && shipped.every((file) => !/\.(m?js|ts)$/.test(file)));
ok("dist assetlinks.json is the verified file", build.status === 0 && sha256(readFileSync(resolve(dist, ".well-known", "assetlinks.json"))) === sha256(assetlinks));

// One after the other: each swaps the global `fetch`.
void moderationFetch()
  .then(() => requoteChecks())
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
