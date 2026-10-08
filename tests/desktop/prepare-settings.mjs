import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Copy pinned implementations, not parallel implementations of their contracts.
// Discord's runtime primitives remain controlled by common.tsx. Contributor
// navigation is outside this fixture and fails loudly if unexpectedly invoked.
const [source] = process.argv.slice(2);
const pluginDir = "components/settings/tabs/plugins";
async function emit(path, text) {
  const output = join("upstream", path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, text);
}
for (const path of [
  "api/Settings.ts",
  "shared/SettingsStore.ts",
  "shared/debounce.ts",
  "utils/types.ts",
  "utils/clipboard.ts",
  "utils/Logger.ts",
  "utils/mergeDefaults.ts",
  "utils/css.ts",
  "utils/lazy.ts",
  "utils/lazyReact.tsx",
  "utils/margins.ts",
  "components/margins.ts",
  "utils/text.ts",
  "components/BaseText.tsx",
  "components/Heading.tsx",
  "components/Paragraph.tsx",
  "components/Button.tsx",
  "components/Icons.tsx",
  "components/Link.tsx",
  "components/ErrorBoundary.tsx",
  "utils/guards.ts",
  "components/ErrorCard.tsx",
  `${pluginDir}/PluginModal.tsx`,
  `${pluginDir}/components/TextSetting.tsx`,
  `${pluginDir}/components/Common.tsx`,
]) {
  const text = await readFile(join(source, "src", path), "utf8");
  await emit(path, text);
  for (const [, css] of text.matchAll(/import "(\.\/[^"\n]+\.css)";/g)) {
    const cssPath = join(dirname(path), css);
    await emit(cssPath, await readFile(join(source, "src", cssPath), "utf8"));
  }
}
// These adjacent pure functions are the exact manager predicates used by the
// real modal and plugin list. Do not pull in Vencord's entire patching runtime.
const manager = await readFile(
  join(source, "src/api/PluginManager.ts"),
  "utf8",
);
const begin = manager.indexOf("export function isPluginEnabled(");
const end = manager.indexOf("export function addPatch(", begin);
assert(begin >= 0 && end > begin, "pinned manager predicate boundaries");
await emit(
  "api/PluginManager.ts",
  `import { Settings } from "./Settings";\nimport Plugins from "~plugins";\n${manager.slice(begin, end)}`,
);
await emit(
  `${pluginDir}/components/index.ts`,
  `import { OptionType } from "@utils/types";\nimport { TextSetting } from "./TextSetting";\nexport const OptionComponentMap = { [OptionType.STRING]: TextSetting };\n`,
);
const unsupported = (name) =>
  `export function ${name}() { throw new Error("Fixture does not implement contributor navigation: ${name}"); }\n`;
await emit(
  `${pluginDir}/ContributorModal.tsx`,
  unsupported("openContributorModal"),
);
await emit(
  `${pluginDir}/PluginModalButtons.tsx`,
  ["FavoriteButton", "GithubButton", "WebsiteButton"].map(unsupported).join(""),
);
await emit(
  "shared/vencordUserAgent.ts",
  'export const gitRemote = "Vendicated/Vencord";\n',
);
