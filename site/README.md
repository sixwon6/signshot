# site/: erashot.app

Static files the app links to. There are no Functions and no script bundle: `public/` is copied
as-is. The co-signer at `cosign.erashot.app` is a separate Worker (`../worker/`).

## Files

| Path | Served at | What |
|---|---|---|
| `public/index.html` | `/` | home |
| `public/terms/index.html` | `/terms/` | terms. "Version N" matches `TERMS_VERSION` in `src/moderation/core.ts`; change both together |
| `public/privacy.html` | `/privacy` | privacy policy |
| `public/moderation.json` | `/moderation.json` | `{"version":1,"hiddenEditions":[…],"hiddenCreators":[…]}`, read by the app. Any other shape hides nothing |
| `public/.well-known/assetlinks.json` | same | App Links for `app.signshot` and the release key's SHA-256 fingerprint |
| `public/collect/index.html` | `/collect/?core=<edition>[&cluster=devnet]` | fallback when the App Link doesn't open the app. One inline script builds an `intent://` "Open in Signshot" link and fetches nothing |
| `public/404.html` | | not found |
| `public/icon.png` | `/icon.png` | also the MWA identity icon (`src/solana/appIdentity.ts`) |
| `public/brand/` | | shared mark and stylesheet |
| `public/_headers` | | security headers and a `default-src 'none'` CSP per page |

- **`assetlinks.json`:** keep it byte-identical across deploys. Android re-verifies it only on
  install or update.
- **Collect page script:** after editing it, put its new sha256 in both `_headers` and the page's
  `<meta>` CSP.

## Build and preview

```sh
npm run build:site      # copies public/ to site/dist/ (git-ignored); fails if a live route's file is missing
npm run preview:site    # serves dist/ at http://127.0.0.1:4181 with _headers applied
```

## Deploy

Cloudflare Pages project `erashot`, custom domain `erashot.app`, by Wrangler direct upload. Git
deployments are off.

```sh
npm test && npm run build:site
cd site && npx wrangler pages deploy dist --project-name erashot --branch main --commit-dirty=true
```

Checks after a deploy, from the repo root:

```sh
curl -s https://erashot.app/.well-known/assetlinks.json | cmp - site/public/.well-known/assetlinks.json   # no output
curl -sI https://erashot.app/.well-known/assetlinks.json | grep -i content-type                        # application/json
curl -sI "https://erashot.app/collect/?core=11111111111111111111111111111111" | grep -ci content-security-policy   # 1
for p in / /terms/ /privacy /moderation.json /icon.png; do curl -so /dev/null -w "%{http_code} $p\n" https://erashot.app$p; done   # all 200
```

Then open a devnet collect link in Chrome on the Seeker. "Open in Signshot" should hand off to the
app's Collect sheet.
