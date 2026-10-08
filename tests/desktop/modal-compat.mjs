import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";

// Exercise the production lookup and Discord components, not the VM's Modal
// replacement. Layout primitives remain controlled; this is not a live login.
const [upstream, asset] = process.argv.slice(2);
const modalSource = await readFile(
  `${upstream}/src/webpack/common/modals.ts`,
  "utf8",
);
const boundary = modalSource.indexOf("// Modal key:");
if (boundary < 0)
  throw new Error("Cannot isolate upstream modal component exports");
const resolverPath = JSON.stringify(`${upstream}/src/webpack/webpack.ts`);
await writeFile(
  "modal-resolver.ts",
  `${modalSource.slice(0, boundary).replaceAll('"@webpack"', resolverPath)}\nexport { _initWebpack } from ${resolverPath};\n`,
);
execFileSync(
  "esbuild",
  [
    "modal-resolver.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--outfile=modal-resolver.cjs",
    "--define:IS_DEV=false",
    "--define:IS_REPORTER=false",
    "--define:IS_ANTI_CRASH_TEST=false",
    `--alias:@utils=${upstream}/src/utils`,
    `--alias:@debug=${upstream}/src/debug`,
    `--alias:@intrnl/xxhash64=${resolve("node_modules/@intrnl/xxhash64/src/index.js")}`,
    "--external:./common",
    "--external:@webpack/common",
  ],
  { stdio: "inherit" },
);

const element = React.createElement;
const dependencies = {
  477900: jsxRuntime,
  582128: React,
  224640: {
    d: (props) =>
      element("section", { "aria-label": props["aria-label"] }, props.children),
  },
  696208: {
    H: (props) =>
      element(
        "footer",
        null,
        props.leading,
        ...(props.actions ?? []).map((action, index) =>
          element(
            "button",
            {
              key: index,
              onClick: action.onClick,
            },
            action.text,
          ),
        ),
      ),
  },
  430993: {
    c: (props) => element("main", null, props.controls, props.children),
    y: () => false,
  },
  364840: { j: (props) => props.children },
  20742: {
    rQ: (props) => element("header", null, props.title, props.subtitle),
  },
  655053: { i: (props) => props.message ?? null },
  460890: {
    G9: () => ({
      i18n: { CANCEL: "Cancel", INLINE_NOTICE_GENERIC_ERROR: "Error" },
    }),
  },
};
const modules = {};
function requireDiscord(id) {
  if (id in modules) return modules[id].exports;
  if (id in dependencies) return dependencies[id];
  throw new Error(`Unexpected Discord dependency ${id}`);
}
requireDiscord.d = (exports, definitions) => {
  for (const [key, get] of Object.entries(definitions)) {
    Object.defineProperty(exports, key, { get, enumerable: true });
  }
};
const source = await readFile(asset, "utf8");
for (const [id, next] of [
  [189213, 696208],
  [732159, 772707],
]) {
  const start = source.indexOf(`${id}(e,t,n){`);
  const end = source.indexOf(`,${next}(e,t,n){`, start);
  if (start < 0 || end <= start)
    throw new Error(`Missing pinned Discord module ${id}`);
  const factory = Function(`return ({${source.slice(start, end)}})[${id}]`)();
  const module = (modules[id] = { id, loaded: true, exports: {} });
  factory(module, module.exports, requireDiscord);
}
globalThis.window = {};
globalThis.document = {};
const require = createRequire(import.meta.url);
const { _initWebpack, Modal, ConfirmModal } = require(
  resolve("modal-resolver.cjs"),
);
_initWebpack({ c: modules, m: {} });
// Vencord deliberately defers property access during the initial lazy-proxy tick.
await new Promise((resolve) => setTimeout(resolve, 0));
const settings = renderToStaticMarkup(
  element(
    Modal,
    {
      title: "Pelican settings",
      onClose() {},
      actions: [{ text: "Save", onClick() {} }],
    },
    "Zipline server URL",
  ),
);
assert.match(settings, /<section aria-label="Pelican settings">/);
assert.match(settings, /<main>Zipline server URL<\/main>/);
assert.match(settings, /<button>Save<\/button>/);
const confirmation = renderToStaticMarkup(
  element(
    ConfirmModal,
    {
      title: "Upload with Pelican?",
      confirmText: "Upload",
      onClose() {},
    },
    "Oversized file",
  ),
);
assert.match(confirmation, /<main>Oversized file<\/main>/);
assert.match(confirmation, /<button>Cancel<\/button><button>Upload<\/button>/);
console.log(
  "PASS production Modal and ConfirmModal lookups render real Discord components with mangled exports",
);
