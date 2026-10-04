import { existsSync } from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * `wrangler deploy` resolves @solana/* through their `workerd` export condition (the
 * `index.node.mjs` build); the test pool resolves them to the browser build instead. Point the
 * tests at the build that ships.
 */
const solanaWorkerdBuild = (): Plugin => ({
  name: "solana-workerd-build",
  enforce: "pre",
  resolveId(id) {
    const match = /^(@solana\/[^/]+)$/.exec(id);
    if (!match) return null;
    const file = path.join(import.meta.dirname, "node_modules", match[1], "dist", "index.node.mjs");
    return existsSync(file) ? file : null;
  },
});

export default defineConfig({
  plugins: [
    solanaWorkerdBuild(),
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")) },
      },
    })),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
