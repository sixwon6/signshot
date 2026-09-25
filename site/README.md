# site/ — erashot.app

The public collect page and the static site, built and deployed from THIS repository. The page
reads editions through the app's own reader (`publications/core/*`), so the web and the phone
accept exactly the same documents — including the five-key `seedshot-attestation/1` document a
Seeker publishes — and trust exactly the programs committed in `publications/deployments.ts`.

Until 2026-09-17 the site was deployed by Cloudflare Pages' Git integration from the predecessor
repository (`sixwon6/seeker-cam`, root `site`). That bundle was built from an older copy of the
reader and refused attested editions. Nothing is deployed from that repository any more; see
"Deploying" for the one-time switch.

## Layout

- `public/` — static files uploaded verbatim: `index.html` (home), `privacy.html` (the policy the
  dApp Store listing and the app's Settings row point at, served extensionless at `/privacy`),
  `404.html`, `icon.png` (also the Mobile Wallet Adapter identity icon, `src/solana/appIdentity.ts`),
  `brand/`, `_headers` (Cloudflare Pages response headers, incl. the collect page's CSP), and
  `.well-known/assetlinks.json` — the Android App Link association for package `app.seekershot`.
  **That file must keep serving byte-identical** (sha256
  `cf53cd9431f8c4214e9813b098476fa1903f3d11144271896ffb735f07e84279`); Android re-verifies it only
  on install/update, and a wrong file silently turns collect links back into browser links.
  `scripts/check-site.ts` pins the digest and checks it names `dapp-store/signing-certificate.json`.
- `public/collect/` — the collect page's document and stylesheet. No inline script, no inline style.
- `public/terms/index.html` — the terms (the EULA) at `/terms/`. Its "Version N" is `TERMS_VERSION`
  in `src/moderation/core.ts`; raise both together when people must agree again, and the app and
  the collect page ask before the next publish or collect.
- `public/moderation.json` — the owner's moderation list at `/moderation.json`, edited by hand:
  `{"version":1,"hiddenEditions":[…],"hiddenCreators":[…]}`, edition and publisher addresses the
  app and the collect page show as "Hidden". Any other shape is ignored and everything shows, so
  run `npm test` (it parses the file) before deploying an edit.
- `collect/` — the page's TypeScript: `browser.ts` (router), `page.ts` (DOM, wallets, quoting,
  durable attempt, confirmation, device row, open-in-app, share card), `core.ts` (the adapter over
  the reader: load, receipt check, program check, `collect` vs `buy`), `mwa.ts` (Mobile Wallet
  Adapter's registration and the Trusted Types policy for its dialogs), `summary.ts` (pure
  wording, also used by the gate), `qr.ts`. Imports go straight to `../../publications/...`; Metro never sees this
  directory because nothing under `index.js` imports it, and `tsc --noEmit` typechecks it.
- `functions/api/solana.ts` — the read-only Solana JSON-RPC proxy the page uses **on mainnet only**
  (a Pages Function at `/api/solana`; devnet links go straight to `api.devnet.solana.com`). Its
  upstream is the Production-only `SOLANA_RPC_URL` secret (see "Cloudflare state that is not in a
  file"); without it the proxy forwards to Solana's public `https://api.mainnet.solana.com`, which
  is rate-limited and "not intended for production applications"
  (https://solana.com/docs/references/clusters). Wrangler uploads a `functions/` directory found
  in the working directory it is run from, so deploy from `site/`.
- `functions/api/attestation-status.ts` — Google's attestation revocation list, same-origin at
  `/api/attestation-status` (GET only, bounded, re-serialised, held an hour in the Cache API) for
  the device row, on every network. Needs no secret.
- `cloudflare/rate-limit-rule.json` — the abuse control on `/api/solana`, in the shape the
  Cloudflare Rulesets API accepts. See "Cloudflare state that is not in a file".
- `build.mjs` — esbuild: `collect/browser.ts` → `dist/collect/collect.js` (ESM, minified,
  `chrome120`/`safari17`), then copies `public/` into `dist/`. Refuses to ship a bundle that trusts
  no program, still reads `process.env`, lacks its own trusted program strings, or pulled in a
  React Native module; regenerates `collect.js.LEGAL.txt` from the esbuild metafile (every bundled
  package's licence text, or the build fails).
- `dev-server.mjs` — local preview of `dist/` on http://127.0.0.1:4181 with the `_headers` rules
  applied; `/api/*` answers 503 rather than faking a Solana service.
- `dist/` — build output, git-ignored, rebuilt on every deploy. Never edited by hand.

There is no `functions/_middleware.ts` here on purpose: the old repository's HTTP Basic preview
gate is what made every page answer 401. Do not bring it back.

## Commands

```sh
npm run build:site        # site/dist
npm run preview:site      # http://127.0.0.1:4181, after a build
npm test                  # includes scripts/check-site.ts: wording, CSP copies, assetlinks, build guards
```

Open a devnet link locally after a build:
`http://127.0.0.1:4181/collect/?core=DtKx1JsmiUeDGXFkJMhyE1r2RyB9A1hiwAbsoYyUjQ9w&cluster=devnet`
(a plain three-key edition with a priced offer). The page only talks to `api.devnet.solana.com`
and the Arweave gateways, so the preview shows real chain state.

## What the page does

`/collect/?core=<edition>[&cluster=devnet]`. Exactly one `core`; `print`, `album`, `rpc`,
`endpoint`, `program`, `url` and `api` are refused; other parameters are ignored. The RPC endpoint
and the trusted programs come from the build, never from the link.

It shows the hash-checked photograph, title, creator, caption, copies available, the price of the
remaining copies (or "free"), the explorer links, and a **Device** row derived from the
certificate chain inside the document after the reader verified it to Google's attestation roots
and `deviceVerdict` checked the release app, the boot state, Google's revocation list (through
`functions/api/attestation-status.ts`, since Google's endpoint sends no CORS header) and every
certificate's dates at the edition's on-chain publication time: "Signed on a Solana Seeker ·
StrongBox hardware key · verified boot, bootloader locked", or "Device attestation not accepted:
<reason>", or "Couldn’t check." when the list or the publication time is out of reach, or "No
device attestation." The row names the device, the key and the boot state. It never says
"camera-verified" or "authentic", and the fine print under it says it does not describe the scene.

**Open in Signshot**: on Android the control is an `intent://erashot.app/collect/...#Intent;
scheme=https;package=app.seekershot;S.browser_fallback_url=...;end` link, which Chrome resolves to
the installed app and otherwise sends to the site home; elsewhere it is a QR of the page's link
for a phone to scan. The page URL itself is the app's verified App Link, so a tap from another app
already opens Signshot.

**Collect / buy** in a browser wallet, always through Wallet Standard: desktop wallets register
themselves, and on Android `mwa.ts` registers Mobile Wallet Adapter with
`@solana-mobile/wallet-standard-mobile` (pinned; 0.5 and later ask for Chrome's Local Network
Access permission, without which MWA signing silently fails). Before quoting, the adapter refuses
a program whose deployed bytes or upgrade authority are not the reviewed ones
(`publications/programImage.ts`), re-reads the `Offer` account and builds `collect` when it is
free or `buy(number, price, revision)` when priced, exactly as the app does
(`src/prints/collect.ts`); the estimate is measured by simulating the collector's own transaction;
the attempt is written to `localStorage` before the wallet opens; success is proved only by the
permanent claim receipt. If the creator changes the price between estimate and approval the
program refuses the purchase (`OfferChanged`) and a fresh estimate is shown.

The photograph and its document are read from `https://arweave.net/raw/<id>`, then
`https://turbo-gateway.com/raw/<id>`; the bare `arweave.net/<id>` redirects to a per-item
subdomain the CSP does not allow. The on-chain `uri` stays `https://arweave.net/<id>`.

## Deploying

Target: Cloudflare Pages project `erashot` (`erashot.pages.dev`), custom domain `erashot.app`
(proxied apex CNAME; `.app` is HSTS-preloaded, HTTPS only). The zone's rate-limit rule and the
`SOLANA_RPC_URL` secret stay exactly where they are; nothing about DNS changes.

One-time switch away from the old repository (dashboard, project `erashot`):

1. **Settings → Builds & deployments → disable automatic deployments** (or disconnect the Git
   integration). Cloudflare accepts Wrangler direct uploads to a Git-connected project once
   automatic builds are off; drag-and-drop is not available for such a project
   (https://developers.cloudflare.com/pages/get-started/direct-upload/).
2. **Settings → Environment variables → delete `SITE_PASSWORD`** (Production). The gate itself is
   gone because `_middleware.ts` is not shipped; deleting the secret removes the temptation.

Every deploy:

```sh
npm test && npm run build:site
cd site && npx wrangler pages deploy dist --project-name erashot --branch main --commit-dirty=true
```

`--branch main` makes it the Production deployment (the project's production branch is `main`).
Run from `site/` so Wrangler picks up `site/functions/` for `/api/solana`. `--commit-dirty=true`
skips Wrangler's interactive prompt about uncommitted changes in the git workspace (`dist/` is
git-ignored, so the workspace is always "dirty" from its point of view).

Known limitations, left as they are for now: the durable attempt in `localStorage` is keyed per
edition and cluster, not per wallet, so two wallets used in one browser share one record; and the
`cluster` parameter is strict (`devnet` or absent for mainnet), so a link carrying any other value
is refused rather than guessed.

Post-deploy checks (all from a shell; the last two from the Seeker in Chrome):

```sh
curl -sI "https://erashot.app/collect/?core=DtKx1JsmiUeDGXFkJMhyE1r2RyB9A1hiwAbsoYyUjQ9w&cluster=devnet" | grep -ci "content-security-policy"   # exactly 1
curl -s https://erashot.app/.well-known/assetlinks.json | sha256sum   # cf53cd9431f8c4214e9813b098476fa1903f3d11144271896ffb735f07e84279
curl -sI https://erashot.app/.well-known/assetlinks.json | grep -i content-type   # application/json
curl -sI https://erashot.app/icon.png | head -1 ; curl -sI https://erashot.app/privacy | head -1   # 200, 200
curl -sI https://erashot.app/ | head -1   # 200, no WWW-Authenticate
```

Then open the devnet link above in desktop Chrome (photograph, price line, QR, device row "No
device attestation…"), and on the Seeker in Chrome (the "Open in Signshot" control must hand off
to the app; "Connect wallet to buy" → "Seed Vault / Android wallet" shows MWA's local network
permission dialog once, then Chrome's own prompt, then opens the wallet). When a device-attested edition exists, open its link and confirm the Device row, and
run `npm run verify:attestation -- --edition <address> --cluster devnet` beside it.

## Cloudflare state that is not in a file

`_headers` is the only configuration Cloudflare Pages reads from the upload. Everything else —
the `SOLANA_RPC_URL` secret and its scope, and the abuse control on `/api/solana` — is dashboard
or API state, written down here so it can be re-applied exactly.

**`SOLANA_RPC_URL`** (Settings → Variables and Secrets, Production, type Secret) is the mainnet
upstream of `/api/solana`: the full HTTPS URL of a dedicated provider endpoint, key included. It
never reaches the browser. When it is unset or deleted the proxy falls back to
`https://api.mainnet.solana.com`, Solana's public endpoint, which rate-limits per IP and may block
high-traffic sites without notice; a live mainnet page should always have it set. On the fallback
every answer carries `X-Upstream: public`, so `curl -sI -X POST https://erashot.app/api/solana`
shows a lost secret.

**Why `/api/solana` needs a rate limit.** It is an unauthenticated proxy in front of a paid RPC
provider. It refuses cross-origin and `Origin`-less callers, allows only the read-only methods
the page calls, holds the account, token-account, history and transaction reads to the exact
params the page sends, and bounds sizes — but `Origin` is forgeable, and `simulateTransaction` (needed
for an honest estimate) executes attacker-chosen program code at the provider. The rule bounds
that residual. Rate limiting rules are available on the Free plan
(https://developers.cloudflare.com/waf/rate-limiting-rules/).

**The rule** (zone `erashot.app` → Security → Security rules → Rate limiting rules), mirrored in
`cloudflare/rate-limit-rule.json`:

| Field | Value |
| --- | --- |
| Rule name | `era-shot rpc proxy cap` |
| Expression | `(http.request.uri.path eq "/api/solana" and http.request.method eq "POST")` |
| Characteristics | IP (`ip.src`); `cf.colo.id` is added implicitly, never in the expression |
| Rate | 120 requests / 10 seconds |
| Action | Block, 10 seconds |
| Cached assets | off (`requests_to_origin: false`) |

Free-plan constraints fix those numbers (one rule per zone, `ip.src` only, 10 s period and
timeout). A mainnet collector now peaks at about 30 requests per 10 s: loading the page with its
Genesis Token row (3) and device row (up to 5), then a quote with the program check (4, two of
them ELF chunks) and the confirmation poll. 120 leaves room for about four collectors behind one
NAT while capping one abusive IP at 12 rps. Raised from 60 on 2026-09-25; the live rule still
says 60 until the file is applied again.

**Verify it is live at no provider cost** (`getProgramAccounts` is not allowlisted, so every
request is refused with 400 before anything is forwarded):

```sh
for i in $(seq 1 100); do echo 'url = "https://erashot.app/api/solana"'; done > /tmp/urls.cfg
curl --parallel --parallel-max 25 -s -o /dev/null -w '%{http_code}\n' -K /tmp/urls.cfg -X POST \
  -H 'Content-Type: application/json' -H 'Origin: https://erashot.app' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getProgramAccounts","params":[]}' | sort | uniq -c
```

Expect a run of `400`s and then `429`s. Also: a POST with **no** `Origin` must answer `403`, and
`curl -sI -X POST https://erashot.app/api/solana` must carry `x-content-type-options: nosniff`,
`referrer-policy: no-referrer` and `x-frame-options: DENY` (`_headers` does not apply to Functions).

**Not covered:** `*.pages.dev` preview URLs are outside the zone and inherit no rule — keep
`SOLANA_RPC_URL` bound to Production only, with preview deployments disabled; and a caller spread
across many IPs is not bounded by a per-IP counter (Bot Fight Mode or Turnstile would be next;
neither is configured).

### Operator record

| Item | Value | Last confirmed |
| --- | --- | --- |
| Zone `erashot.app` | Cloudflare Registrar; nameservers `albert`/`melinda.ns.cloudflare.com` | 12 Sep 2026 |
| Rate limiting rule | applied by API: ruleset `f90462456c6749d196bd419346b02e93`, rule `0caace9a4c4f4abab833dc629dd39aff`; probe passed (100 parallel, 30 × 429) | 12 Sep 2026 |
| `SOLANA_RPC_URL` | Production only, encrypted `secret_text`; Preview holds no variables, preview deployments disabled | 12 Sep 2026 |
| Pages project | `erashot` (`erashot.pages.dev`); custom domain `erashot.app` via proxied apex CNAME | 12 Sep 2026 |
| Deployment source | Wrangler direct upload from this repository's `site/`; the Git integration to `sixwon6/seeker-cam` remains attached but automatic production and preview deployments are disabled | 18 Sep 2026 |
| Site password gate | removed: the middleware is not in this repository, the first direct upload (deployment `8e5dfc63`) replaced it, and the `SITE_PASSWORD` secret is deleted | 18 Sep 2026 | |
| Bot Fight Mode / Turnstile | not configured | — |
