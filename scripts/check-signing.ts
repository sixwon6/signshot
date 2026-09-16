/**
 * Build gate: the committed build.gradle carries the signing plugin's output, and the plugin still
 * fits the Expo template.
 *
 *   npx tsx scripts/check-signing.ts
 *
 * No network, device or Gradle. Checks that `plugins/withDappStoreSigning.js`'s anchors match
 * `node_modules/expo/template.tgz`; that the committed build.gradle has every plugin block verbatim
 * and not the template's debug release signing; that the plugin is idempotent over it; and that
 * gradle.properties carries the plugin's ABI list exactly once.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readTemplateMember } from "./expoTemplate";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

type PropertiesItem =
  | { type: "property"; key: string; value: string }
  | { type: "comment"; value: string }
  | { type: "empty" };
type Plugin = {
  applySigning: (contents: string) => string;
  applyArchitectures: (props: PropertiesItem[]) => PropertiesItem[];
  MARKER: string;
  WRITTEN_BLOCKS: string[];
  TEMPLATE_RELEASE_SIGNING: string;
};

const plugin = require(resolve(ROOT, "plugins/withDappStoreSigning.js")) as Plugin;

const lf = (s: string): string => s.replace(/\r\n/g, "\n");

function main(): void {
  const problems: string[] = [];

  // 1. Anchors still fit the template (applySigning throws when one is missing or doubled).
  const template = lf(readTemplateMember("android/app/build.gradle"));
  const overTemplate = lf(plugin.applySigning(template));
  for (const block of plugin.WRITTEN_BLOCKS) {
    if (!overTemplate.includes(lf(block))) problems.push("plugin output over the template lacks one of its own blocks");
  }
  if (overTemplate.includes(lf(plugin.TEMPLATE_RELEASE_SIGNING))) {
    problems.push("plugin output over the template still signs release with signingConfigs.debug");
  }

  // 2. The committed file is in the applied state, verbatim.
  const committed = lf(readFileSync(resolve(ROOT, "android/app/build.gradle"), "utf8"));
  if (!committed.includes(lf(plugin.MARKER))) {
    problems.push(
      "android/app/build.gradle has no signing marker: a prebuild ran without\n" +
        "    plugins/withDappStoreSigning.js in app.json, or the file was replaced by hand. Its release\n" +
        "    variant is the template's, which signs with the committed debug key. Re-run\n" +
        "    `npx expo prebuild -p android` with the plugin registered.",
    );
  }
  for (const block of plugin.WRITTEN_BLOCKS) {
    if (!committed.includes(lf(block))) {
      const firstLine = lf(block).trim().split("\n")[0];
      problems.push(
        `android/app/build.gradle does not carry the plugin's block starting \`${firstLine}\`\n` +
          "    verbatim. Do not hand-edit build.gradle: change the plugin and re-run\n" +
          "    `npx expo prebuild -p android`.",
      );
    }
  }
  if (committed.includes(lf(plugin.TEMPLATE_RELEASE_SIGNING))) {
    problems.push("android/app/build.gradle: the release variant signs with signingConfigs.debug (the template default).");
  }

  // 3. Idempotent over the committed file.
  if (lf(plugin.applySigning(committed)) !== committed) {
    problems.push("plugins/withDappStoreSigning.js is not idempotent over the committed build.gradle.");
  }

  // ABI list, exactly once.
  const props = lf(readFileSync(resolve(ROOT, "android/gradle.properties"), "utf8"));
  const wanted = plugin.applyArchitectures([]).find((p) => p.type === "property");
  if (wanted?.type !== "property") throw new Error("applyArchitectures wrote no property");
  const line = `${wanted.key}=${wanted.value}`;
  const count = props.split("\n").filter((l) => l.trim() === line).length;
  if (count !== 1) problems.push(`android/gradle.properties should carry exactly one \`${line}\` line (found ${count}).`);

  if (problems.length > 0) {
    console.error(`\nsigning check FAILED (${problems.length}):\n`);
    for (const p of problems) console.error(`  - ${p}\n`);
    process.exit(1);
  }
  console.log(
    "signing check ok — plugin fits the Expo template; build.gradle carries its blocks verbatim; idempotent; ABI list present",
  );
}

try {
  main();
} catch (e: unknown) {
  console.error(`signing check FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
