# site/ — erashot.app

The static pages the app links to. No Functions and no script bundle: `public/` is the site.

## Layout

- `public/` — uploaded verbatim: `index.html` (home), `privacy.html` (the policy the dApp Store
  listing and the app's Settings row point at, served extensionless at `/privacy`), `404.html`,
  `icon.png` (also the Mobile Wallet Adapter identity icon, `src/solana/appIdentity.ts`),
  `brand/`, `_headers` (Cloudflare Pages response headers), and `.well-known/assetlinks.json` —
  the Android App Link association for package `app.seekershot`. **That file must keep serving
  byte-identical** (sha256 `cf53cd9431f8c4214e9813b098476fa1903f3d11144271896ffb735f07e84279`);
  Android re-verifies it only on install/update, and a wrong file silently turns collect links back
  into browser links. `scripts/check-site.ts` pins the digest and checks it names
  `dapp-store/signing-certificate.json`.
- `public/collect/index.html` — what `/collect/?core=<edition>[&cluster=devnet]` shows where the
  App Link did not open the app: the name and an "Open in Signshot" control, an
  `intent://erashot.app/collect/?core=…#Intent;scheme=https;package=app.seekershot;S.browser_fallback_url=…;end`
  link rebuilt from a valid `core` and `cluster` (only `devnet` or none), which Chrome opens in the
  installed app and otherwise sends to the home page. Anything else shows only the name. One
  inline script, allowed by its hash in `_headers` and the page's <meta> CSP; it fetches nothing.
- `public/terms/index.html` — the terms (the EULA) at `/terms/`. Its "Version N" is `TERMS_VERSION`
  in `src/moderation/core.ts`; raise both together when people must agree again, and the app asks
  before the next publish or collect.
- `public/moderation.json` — the moderation list at `/moderation.json`, edited by hand:
  `{"version":1,"hiddenEditions":[…],"hiddenCreators":[…]}`, edition and publisher addresses the
  app shows as "Hidden". Any other shape is ignored and everything shows, so run `npm test` (it
  parses the file) before deploying an edit.
- `build.mjs` — copies `public/` into `dist/`.
- `dev-server.mjs` — local preview of `dist/` on http://127.0.0.1:4181 with the `_headers` rules
  applied.
- `dist/` — build output, git-ignored, rebuilt on every deploy. Never edited by hand.

## Commands

```sh
npm run build:site        # site/dist
npm run preview:site      # http://127.0.0.1:4181, after a build
npm test                  # includes scripts/check-site.ts
```

After an edit to the collect link page's script, `scripts/check-site.ts` fails and prints the hash to
put in `_headers` and the page's <meta>.

## Deploying

Target: Cloudflare Pages project `erashot` (`erashot.pages.dev`), custom domain `erashot.app`
(proxied apex CNAME; `.app` is HSTS-preloaded, HTTPS only). Deploys are Wrangler direct uploads;
the project's automatic Git deployments are off, which Cloudflare requires before it accepts direct
uploads to a Git-connected project
(https://developers.cloudflare.com/pages/get-started/direct-upload/). Each deploy:

```sh
npm test && npm run build:site
cd site && npx wrangler pages deploy dist --project-name erashot --branch main --commit-dirty=true
```

`--branch main` makes it the Production deployment (the project's production branch is `main`).
Wrangler uploads a `functions/` directory found in the working directory it is run from; `site/`
has none. `--commit-dirty=true` skips Wrangler's interactive prompt about uncommitted changes in
the git workspace (`dist/` is git-ignored, so the workspace is always "dirty" from its point of
view).

Post-deploy checks:

```sh
curl -sI "https://erashot.app/collect/?core=DtKx1JsmiUeDGXFkJMhyE1r2RyB9A1hiwAbsoYyUjQ9w&cluster=devnet" | grep -ci "content-security-policy"   # exactly 1
curl -s https://erashot.app/.well-known/assetlinks.json | sha256sum   # cf53cd9431f8c4214e9813b098476fa1903f3d11144271896ffb735f07e84279
curl -sI https://erashot.app/.well-known/assetlinks.json | grep -i content-type   # application/json
curl -sI https://erashot.app/icon.png | head -1 ; curl -sI https://erashot.app/privacy | head -1   # 200, 200
curl -sI https://erashot.app/terms/ | head -1 ; curl -sI https://erashot.app/moderation.json | head -1   # 200, 200
curl -sI https://erashot.app/ | head -1   # 200, no WWW-Authenticate
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://erashot.app/api/solana   # 404 or 405: no Function
```

Then open the devnet link above in Chrome on the Seeker: "Open in Signshot" must hand off to the
app's Collect sheet.

### Operator record

| Item | Value | Last confirmed |
| --- | --- | --- |
| Zone `erashot.app` | Cloudflare Registrar; nameservers `albert`/`melinda.ns.cloudflare.com` | 12 Sep 2026 |
| Pages project | `erashot` (`erashot.pages.dev`); custom domain `erashot.app` via proxied apex CNAME | 12 Sep 2026 |
| Deployment source | Wrangler direct upload from `site/`; automatic production and preview Git deployments disabled | 18 Sep 2026 |
| Password gate | none: no middleware is shipped and no `SITE_PASSWORD` secret exists | 18 Sep 2026 |
| Unused | the `SOLANA_RPC_URL` secret and the `era-shot rpc proxy cap` rate limiting rule (ruleset `f90462456c6749d196bd419346b02e93`, rule `0caace9a4c4f4abab833dc629dd39aff`) serve nothing; delete both in the dashboard | — |
