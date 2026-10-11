/** Copies `site/public/` into `site/dist/` for `wrangler pages deploy`. */
import { cp, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const site = fileURLToPath(new URL(".", import.meta.url));
const dist = resolve(site, "dist");

// Start clean so files removed from `public/` do not linger.
await rm(dist, { recursive: true, force: true });
// assetlinks.json must be served byte-identical or Android drops the verified App Link.
await cp(resolve(site, "public"), dist, { recursive: true });
for (const required of ["_headers", ".well-known/assetlinks.json", "icon.png", "index.html", "404.html", "privacy.html", "terms/index.html", "moderation.json", "collect/index.html"])
  await stat(resolve(dist, required)).catch(() => {
    throw new Error(`site/dist is missing ${required}; the deploy would break a live route.`);
  });

console.log("Site copied to site/dist");
