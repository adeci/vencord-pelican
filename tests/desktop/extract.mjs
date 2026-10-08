import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

// The immutable upstream asset stays in the Nix store, never in this repository.
const [asset, pluginPath, output] = process.argv.slice(2);
const source = await readFile(asset, "utf8");
const plugin = await readFile(pluginPath, "utf8");
const start = plugin.indexOf("  patches: [");
const end = plugin.indexOf("\n  preflight(", start);
assert(
  start >= 0 && end > start,
  "production patch declarations must be found",
);
const patches = Function(
  `return (${plugin
    .slice(start + "  patches: ".length, end)
    .trim()
    .replace(/,$/, "")})`,
)();
const modules = [
  [518960, 382287],
  [392553, 579940],
];
assert.equal(patches.length, modules.length);
const patched = modules.map(([id, next], index) => {
  const begin = source.indexOf(`${id}(e,t,n){`);
  const finish = source.indexOf(`,${next}(e,t,n){`, begin);
  assert(begin >= 0 && finish > begin, `pinned Discord module ${id}`);
  let text = source.slice(begin, finish);
  const patch = patches[index];
  assert(text.includes(patch.find), `Discord module ${id} patch anchor`);
  for (const replacement of patch.replacement) {
    const regex = new RegExp(
      replacement.match.source.replaceAll("\\i", "(?:[A-Za-z_$][\\w$]*)"),
      "g",
    );
    assert.equal(
      [...text.matchAll(regex)].length,
      1,
      `exactly one ${id} patch match: ${regex}`,
    );
    text = text.replace(
      regex,
      replacement.replace.replaceAll("$self", "plugin"),
    );
  }
  Function("plugin", `return ({${text}})[${id}]`);
  return text;
});
await writeFile(
  output,
  `// Generated from pinned Discord factories and current production patches.\nexport const patchMatches = 4;\nexport function createUploadFactory(plugin) { return ({${patched[0]}})[518960]; }\n`,
);
console.log(
  "Both real Discord factories compile; all four production patches match exactly once.",
);
