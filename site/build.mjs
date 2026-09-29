/**
 * Copies `site/public/` into `site/dist/`, the git-ignored directory `wrangler pages deploy`
 * uploads (see `site/README.md`). The site is static; there is nothing to compile.
 */
import { cp, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const site = fileURLToPath(new URL(".", import.meta.url));
const dist = resolve(site, "dist");

// A clean output directory: a file removed from `public/` must not linger in the next deploy.
await rm(dist, { recursive: true, force: true });
// `_headers` and `.well-known/assetlinks.json` ride along; the App Link association must keep
// serving byte-identical or Android drops the verified link.
await cp(resolve(site, "public"), dist, { recursive: true });
for (const required of ["_headers", ".well-known/assetlinks.json", "icon.png", "index.html", "404.html", "privacy.html", "terms/index.html", "moderation.json", "collect/index.html"])
  await stat(resolve(dist, required)).catch(() => {
    throw new Error(`site/dist is missing ${required}; the deploy would break a live route.`);
  });

console.log("Site copied to site/dist");
