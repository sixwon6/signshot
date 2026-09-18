/**
 * Local preview of `site/dist/` (run `npm run build:site` first). Serves the extensionless links
 * Cloudflare Pages serves (`/privacy`), answers 503 for `/api/*` instead of faking a Solana
 * service, and applies the `_headers` rules for the paths it knows so a CSP mistake shows up
 * here rather than in production. Binds to 127.0.0.1 only.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "dist");
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};
const port = Number(process.env.PORT ?? 4181);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Choose a local preview port between 1024 and 65535.");

/** `_headers`, parsed: an ordered list of [pattern, headers]. Only `*` suffix globs are used. */
async function loadHeaderRules() {
  const text = await readFile(resolve(root, "_headers"), "utf8").catch(() => "");
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) rules.push([raw.trim(), {}]);
    else if (rules.length) {
      const at = raw.indexOf(":");
      rules[rules.length - 1][1][raw.slice(0, at).trim()] = raw.slice(at + 1).trim();
    }
  }
  return rules;
}
const rules = await loadHeaderRules();
function headersFor(pathname) {
  const out = {};
  for (const [pattern, headers] of rules) {
    const match = pattern.endsWith("*")
      ? pathname.startsWith(pattern.slice(0, -1))
      : pathname === pattern;
    if (!match) continue;
    // Cloudflare joins duplicate headers from several matching rules; do the same here.
    for (const [k, v] of Object.entries(headers)) out[k] = out[k] ? `${out[k]}, ${v}` : v;
  }
  return out;
}

createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname.startsWith("/api/")) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ error: { message: "The local preview has no production Solana connection." } }),
      );
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      return res.end();
    }
    let path = resolve(root, "." + (pathname === "/privacy" ? "/privacy.html" : pathname));
    if (path !== root && !path.startsWith(root + sep)) {
      res.writeHead(403);
      return res.end();
    }
    if ((await stat(path)).isDirectory()) path = resolve(path, "index.html");
    const type = types[extname(path)];
    if (!type) {
      res.writeHead(404);
      return res.end();
    }
    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      ...headersFor(pathname),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404);
    res.end("Page not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Seedshot site preview: http://127.0.0.1:${port}`));
