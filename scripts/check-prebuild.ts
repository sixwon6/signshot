/**
 * Build gate: the committed `android/` prebuild output says what app.json and the plugins say.
 *
 *   npx tsx scripts/check-prebuild.ts
 *
 * No device, network or Gradle. Checks:
 *   1. Manifest permissions are the Expo template's set (from `node_modules/expo/template.tgz`) plus
 *      `expo.android.permissions`, with `blockedPermissions` as `tools:node="remove"` entries (which
 *      also remove library-merged permissions), sorted as prebuild sorts them.
 *   2. `sharing_provider_paths.xml` is exactly what `plugins/withSharingProviderPaths.js` writes, and
 *      the plugin is registered; without it the library resource exposes all of `filesDir`.
 *   3. `proguard-rules.pro` is what prebuild would produce from `extraProguardRules` and
 *      `plugins/withProguardRules.js`.
 *
 * `android/` is prebuild output: the Expo template plus what app.json and `plugins/` make of it.
 * Template residue that looks dead (the commented-out `react { }` options,
 * `// add(MyReactNativePackage())`, `// setTheme(R.style.AppTheme);`) stays as
 * `npx expo prebuild --clean` writes it, so the tree matches the next prebuild.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readTemplateMember } from "./expoTemplate";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const MANIFEST = "android/app/src/main/AndroidManifest.xml";
const PROGUARD = "android/app/proguard-rules.pro";

type SharingPlugin = { PATHS_XML: string; RELATIVE_PATH: string };
type ProguardPlugin = { stripDeadRules: (contents: string) => string; DEAD_RULE: string };
type BuildProperties = {
  updateAndroidProguardRules: (
    contents: string,
    rules: string | null,
    mode: "append" | "overwrite",
  ) => string;
};

export type AppJson = {
  expo?: {
    android?: { permissions?: unknown; blockedPermissions?: unknown };
    plugins?: unknown;
  };
};

export type Permission = { name: string; attrs: Record<string, string> };

export const lf = (s: string): string => s.replace(/\r\n/g, "\n");

/** `<uses-permission .../>` entries in document order, with every attribute they carry. */
function parseUsesPermissions(xml: string): Permission[] {
  const out: Permission[] = [];
  for (const element of xml.matchAll(/<uses-permission\b([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const attr of element[1].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[attr[1]] = attr[2];
    const name = attrs["android:name"];
    if (name === undefined) continue;
    const rest = { ...attrs };
    delete rest["android:name"];
    out.push({ name, attrs: rest });
  }
  return out;
}

/** The permission list a `prebuild` would write, from app.json over the bare template's own. */
function expectedPermissions(app: AppJson, templateManifest: string): Permission[] {
  const byName = new Map<string, Record<string, string>>();
  for (const p of parseUsesPermissions(templateManifest)) byName.set(p.name, p.attrs);

  const declared = Array.isArray(app.expo?.android?.permissions) ? app.expo.android.permissions : [];
  for (const raw of declared) {
    const name = qualify(String(raw));
    if (!byName.has(name)) byName.set(name, {});
  }
  const blocked = Array.isArray(app.expo?.android?.blockedPermissions)
    ? app.expo.android.blockedPermissions
    : [];
  // `ensureBlockedPermission` drops whatever the entry carried and pushes `tools:node="remove"`.
  for (const raw of blocked) byName.set(qualify(String(raw)), { "tools:node": "remove" });

  return [...byName.entries()]
    .map(([name, attrs]) => ({ name, attrs }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** `prefixAndroidPermissionsIfNecessary`: a bare `CAMERA` means `android.permission.CAMERA`. */
function qualify(permission: string): string {
  return permission.includes(".") ? permission : `android.permission.${permission}`;
}

function describe(p: Permission): string {
  const attrs = Object.entries(p.attrs)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  return `${p.name}${attrs}`;
}

function permissionProblems(app: AppJson, manifest: string, template: string): string[] {
  const problems: string[] = [];
  const actual = parseUsesPermissions(manifest);
  const expected = expectedPermissions(app, template);

  const seen = new Set<string>();
  for (const p of actual) {
    if (seen.has(p.name)) problems.push(`${MANIFEST} declares ${p.name} more than once.`);
    seen.add(p.name);
  }

  const actualNames = actual.map((p) => p.name);
  const expectedNames = expected.map((p) => p.name);
  for (const name of expectedNames) {
    if (!actualNames.includes(name)) {
      const want = expected.find((p) => p.name === name)!;
      problems.push(`${MANIFEST} is missing \`${describe(want)}\`, which app.json implies.`);
    }
  }
  for (const p of actual) {
    if (!expectedNames.includes(p.name)) {
      problems.push(
        `${MANIFEST} declares \`${describe(p)}\`, which app.json does not imply.\n` +
          `    Add it to expo.android.permissions if it is wanted, or to expo.android.blockedPermissions\n` +
          `    if it is not — a permission nothing in the app requests still shows in the store listing\n` +
          `    and in the install UI.`,
      );
    }
  }
  for (const want of expected) {
    const got = actual.find((p) => p.name === want.name);
    if (got && JSON.stringify(got.attrs) !== JSON.stringify(want.attrs)) {
      problems.push(
        `${MANIFEST}: ${want.name} carries the wrong attributes.\n` +
          `    expected  ${describe(want)}\n` +
          `    found     ${describe(got)}`,
      );
    }
  }
  if (problems.length === 0 && actualNames.join(",") !== expectedNames.join(",")) {
    problems.push(
      `${MANIFEST}: the permission list is not in the order a prebuild writes it.\n` +
        `    expected  ${expectedNames.join(", ")}\n` +
        `    found     ${actualNames.join(", ")}`,
    );
  }
  return problems;
}

/** Whether app.json registers plugin `id`, as a string or a `[name, options]` pair. */
function pluginRegistered(app: AppJson, id: string): boolean {
  const plugins = Array.isArray(app.expo?.plugins) ? app.expo.plugins : [];
  return plugins.some((entry) => (Array.isArray(entry) ? entry[0] : entry) === id);
}

function providerPathsProblems(
  app: AppJson,
  onDisk: string | null,
  wanted: string,
): string[] {
  const problems: string[] = [];
  if (!pluginRegistered(app, "./plugins/withSharingProviderPaths.js")) {
    problems.push(
      "app.json does not register ./plugins/withSharingProviderPaths.js, so the next prebuild\n" +
        "    drops the narrowed FileProvider roots and expo-sharing's own `files-path .` — the whole\n" +
        "    of filesDir, captures included — becomes addressable again.",
    );
  }
  if (onDisk === null) {
    problems.push(
      "android/app/src/main/res/xml/sharing_provider_paths.xml is missing. Without it the\n" +
        "    expo-sharing library resource applies and every full-size capture can be handed to another\n" +
        "    app through a grant that is never revoked.",
    );
  } else if (lf(onDisk) !== lf(wanted)) {
    problems.push(
      "android/app/src/main/res/xml/sharing_provider_paths.xml is not what\n" +
        "    plugins/withSharingProviderPaths.js writes. Change the plugin, not the generated file.",
    );
  }
  return problems;
}

function proguardProblems(
  app: AppJson,
  onDisk: string,
  rules: string | null,
  bp: BuildProperties,
  strip: (contents: string) => string,
  deadRule: string,
): string[] {
  const problems: string[] = [];
  if (!pluginRegistered(app, "./plugins/withProguardRules.js")) {
    problems.push(
      "app.json does not register ./plugins/withProguardRules.js, so the next prebuild restores\n" +
        `    the template's dead \`${deadRule}\` keep rule.`,
    );
  }
  const contents = lf(onDisk);
  // What a prebuild produces: purge the previous generated section, append app.json's rules,
  // then let the plugin strip the dead template rules. Over the committed file this is identity.
  const regenerated = strip(
    bp.updateAndroidProguardRules(
      bp.updateAndroidProguardRules(contents, "", "overwrite"),
      rules === null ? null : lf(rules),
      "append",
    ),
  );
  if (regenerated !== contents) {
    problems.push(
      `${PROGUARD} is not what a prebuild would write from app.json.\n` +
        "    Either the @generated expo-build-properties section does not match\n" +
        "    expo.plugins[expo-build-properties].android.extraProguardRules, or a rule this project\n" +
        "    removes on purpose has come back. Edit app.json (to add) or plugins/withProguardRules.js\n" +
        "    (to remove), never the generated file.",
    );
  }
  if (contents.includes(deadRule)) {
    problems.push(
      `${PROGUARD} still carries \`${deadRule}\`. react-native-reanimated is not a dependency of\n` +
        "    this project; the rule is template residue.",
    );
  }
  return problems;
}

function main(): void {
  const app = JSON.parse(readFileSync(resolve(ROOT, "app.json"), "utf8")) as AppJson;
  const sharing = require(resolve(ROOT, "plugins/withSharingProviderPaths.js")) as SharingPlugin;
  const proguard = require(resolve(ROOT, "plugins/withProguardRules.js")) as ProguardPlugin;
  const bp = require(
    resolve(ROOT, "node_modules/expo-build-properties/build/android.js"),
  ) as BuildProperties;

  const problems: string[] = [];

  problems.push(
    ...permissionProblems(
      app,
      readFileSync(resolve(ROOT, MANIFEST), "utf8"),
      readTemplateMember("android/app/src/main/AndroidManifest.xml"),
    ),
  );

  const pathsFile = resolve(ROOT, "android", ...sharing.RELATIVE_PATH.split("/"));
  problems.push(
    ...providerPathsProblems(
      app,
      existsSync(pathsFile) ? readFileSync(pathsFile, "utf8") : null,
      sharing.PATHS_XML,
    ),
  );

  const plugins = Array.isArray(app.expo?.plugins) ? app.expo.plugins : [];
  const buildProps = plugins.find((e) => Array.isArray(e) && e[0] === "expo-build-properties") as
    | [string, { android?: { extraProguardRules?: unknown } }]
    | undefined;
  const extra = buildProps?.[1]?.android?.extraProguardRules;
  problems.push(
    ...proguardProblems(
      app,
      readFileSync(resolve(ROOT, PROGUARD), "utf8"),
      typeof extra === "string" ? extra : null,
      bp,
      proguard.stripDeadRules,
      proguard.DEAD_RULE,
    ),
  );

  if (problems.length > 0) {
    console.error(`\nprebuild check FAILED (${problems.length}):\n`);
    for (const p of problems) console.error(`  - ${p}\n`);
    console.error(
      "app.json and plugins/ are the source of truth. After changing them run\n" +
        "  `npx expo prebuild -p android` so the committed android/ tree follows.",
    );
    process.exit(1);
  }

  const app_ = app.expo?.android;
  const blocked = Array.isArray(app_?.blockedPermissions) ? app_.blockedPermissions.length : 0;
  console.log(
    `prebuild check ok — manifest permissions match app.json (${blocked} blocked), ` +
      "sharing_provider_paths.xml is the narrowed one, proguard-rules.pro matches extraProguardRules",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (e: unknown) {
    console.error(`prebuild check FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
