// Expo config plugin: remove the template's react-native-reanimated keep rule from
// android/app/proguard-rules.pro; reanimated is not a dependency. Checked by `scripts/check-prebuild.ts`.

const { withDangerousMod } = require("expo/config-plugins");
const { promises: fs } = require("fs");
const path = require("path");

/** The template block this plugin removes, exactly as the template writes it. */
const DEAD_RULE = "-keep class com.swmansion.reanimated.** { *; }";
const DEAD_COMMENT = "# react-native-reanimated";

/** Relative to `android/`. */
const RELATIVE_PATH = "app/proguard-rules.pro";

/**
 * Remove the reanimated comment and keep rule, leaving everything else — including the
 * turbomodule rule that follows it and any `@generated` section — untouched.
 */
function stripDeadRules(contents) {
  return contents
    .split("\n")
    .filter((line) => line.trim() !== DEAD_RULE && line.trim() !== DEAD_COMMENT)
    .join("\n");
}

const withProguardRules = (config) =>
  withDangerousMod(config, [
    "android",
    async (config) => {
      const file = path.join(config.modRequest.platformProjectRoot, ...RELATIVE_PATH.split("/"));
      const contents = await fs.readFile(file, "utf8");
      const next = stripDeadRules(contents);
      if (next !== contents) await fs.writeFile(file, next, "utf8");
      return config;
    },
  ]);

module.exports = withProguardRules;
module.exports.stripDeadRules = stripDeadRules;
module.exports.DEAD_RULE = DEAD_RULE;
