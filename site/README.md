# site/ — erashot.app

The static files the app links to. No Functions and no script bundle: `public/` is uploaded as is.
The Seeker co-signer at `cosign.erashot.app` is a separate Worker (`worker/README.md`).

## Layout

- `public/index.html` — home.
- `public/privacy.html` — the privacy policy, served at `/privacy`.
- `public/404.html` — not found.
- `public/icon.png` — also the Mobile Wallet Adapter identity icon (`src/solana/appIdentity.ts`).
- `public/brand/` — the shared mark and stylesheet.
- `public/_headers` — response headers and CSPs.
- `public/.well-known/assetlinks.json` — the App Link association for `app.seekershot` and the
  release key's fingerprint in `dapp-store/signing-certificate.json`; **keep it byte-identical**
  (sha256 in the checks below): Android re-verifies it only on install or update.
- `public/collect/index.html` — what `/collect/?core=<edition>[&cluster=devnet]` shows when the
  App Link does not open the app: one inline script, allowed by its hash, builds
  `intent://erashot.app/collect/?core=…#Intent;scheme=https;package=app.seekershot;S.browser_fallback_url=…;end`
  from a valid `core` and `cluster` (`devnet` or none) and fetches nothing. The edition is the
  candy machine's address.
- `public/terms/index.html` — the terms at `/terms/`; "Version N" is `TERMS_VERSION` in
  `src/moderation/core.ts`, raised together.
- `public/moderation.json` — `{"version":1,"hiddenEditions":[…],"hiddenCreators":[…]}`; a list
  of any other shape hides nothing.
- `build.mjs` — copies `public/` into `dist/` and refuses a build missing a live route's file.
- `dev-server.mjs` — previews `dist/` on http://127.0.0.1:4181 with `_headers` applied.
- `dist/` — build output, git-ignored.

## Commands

```sh
npm run build:site        # site/dist
npm run preview:site      # http://127.0.0.1:4181, after a build
```

After an edit to the collect link page's script, put its new sha256 in both `_headers` and the
page's <meta> policy.

## Deploying

Target: Cloudflare Pages project `erashot` (`erashot.pages.dev`), custom domain `erashot.app`
(proxied apex CNAME; `.app` is HSTS-preloaded, HTTPS only), by Wrangler direct upload with
automatic Git deployments off (https://developers.cloudflare.com/pages/get-started/direct-upload/).
Each deploy:

```sh
npm test && npm run build:site
cd site && npx wrangler pages deploy dist --project-name erashot --branch main --commit-dirty=true
```

`--branch main` makes it the Production deployment; `--commit-dirty=true` skips Wrangler's prompt
about uncommitted changes. `site/` has no `functions/` directory for Wrangler to upload.

Post-deploy checks:

```sh
curl -sI "https://erashot.app/collect/?core=11111111111111111111111111111111&cluster=devnet" | grep -ci "content-security-policy"   # exactly 1
curl -s https://erashot.app/.well-known/assetlinks.json | sha256sum   # cf53cd9431f8c4214e9813b098476fa1903f3d11144271896ffb735f07e84279
curl -sI https://erashot.app/.well-known/assetlinks.json | grep -i content-type   # application/json
curl -sI https://erashot.app/icon.png | head -1 ; curl -sI https://erashot.app/privacy | head -1   # 200, 200
curl -sI https://erashot.app/terms/ | head -1 ; curl -sI https://erashot.app/moderation.json | head -1   # 200, 200
curl -sI https://erashot.app/ | head -1   # 200, no WWW-Authenticate
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://erashot.app/api/solana   # 404 or 405: no Function
```

Then open a devnet edition's collect link in Chrome on the Seeker: "Open in Signshot" must hand off
to the app's Collect sheet.

### Operator record

| Item | Value | Last confirmed |
| --- | --- | --- |
| Zone `erashot.app` | Cloudflare Registrar; nameservers `albert`/`melinda.ns.cloudflare.com` | 12 Sep 2026 |
| Pages project | `erashot` (`erashot.pages.dev`); custom domain `erashot.app` via proxied apex CNAME | 12 Sep 2026 |
| Deployment source | Wrangler direct upload from `site/`; automatic production and preview Git deployments disabled | 18 Sep 2026 |
| Password gate | none: no middleware is shipped and no `SITE_PASSWORD` secret exists | 18 Sep 2026 |
| Secrets and variables | none on either environment | 29 Sep 2026 |
| Rate limiting | none: the zone's `http_ratelimit` ruleset (`f90462456c6749d196bd419346b02e93`) holds no rules | 29 Sep 2026 |
| Mail | Email Routing on: `support@erashot.app` forwards to the owner's verified address; catch-all off; MX, SPF and DKIM records managed by Cloudflare | 29 Sep 2026 |
