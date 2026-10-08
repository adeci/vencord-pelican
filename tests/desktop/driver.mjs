import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const { values } = parseArgs({
  options: {
    cdp: { type: "string", default: "http://127.0.0.1:9222" },
    control: { type: "string", default: "http://127.0.0.1:3003" },
    "token-file": { type: "string", default: "/run/pelican/token" },
    phase: { type: "string", default: "run" },
    artifacts: { type: "string", default: "/tmp/pelican-artifacts" },
  },
});
const artifacts = values.artifacts;
await mkdir(artifacts, { recursive: true });
const scenarios = [],
  downloads = [],
  diagnostics = [];
const originalToken = (await readFile(values["token-file"], "utf8")).trim();
assert(originalToken, "driver-only token fixture must not be empty");
assert(["configure", "run"].includes(values.phase), "known driver phase");
const configuring = values.phase === "configure";
const serverInput = 'input[aria-label="Zipline server URL"]';
const tokenInput = 'input[aria-label="Zipline API token"]';
const invalidToken = "invalid-pelican-vm-user-token";
const redact = (text) =>
  String(text)
    .replaceAll(originalToken, "[redacted]")
    .replaceAll(invalidToken, "[redacted]");
let socket;
const pending = new Map();
let sequence = 0;
async function eventually(read, description, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw Error(`Timed out: ${description}`);
}
function call(method, params = {}) {
  const id = ++sequence;
  const { promise, resolve, reject } = Promise.withResolvers();
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(Error(`CDP timeout: ${method}`));
  }, 30000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
  return promise;
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw Error(redact(JSON.stringify(result.exceptionDetails)));
  return result.result.value;
}
const snapshot = () => evaluate("window.pelicanFixture.snapshot()");
async function control(path, method = "GET") {
  const response = await fetch(values.control + path, { method });
  assert(response.ok, `proxy control ${path}: ${response.status}`);
  return response.json();
}
const uploadRequests = (state) =>
  state.requests.filter(
    (request) =>
      request.method === "POST" && request.path.startsWith("/api/upload"),
  );
async function click({ text, selector }) {
  const point = await evaluate(`(() => {
    const element = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : `[...document.querySelectorAll('button:not([aria-label="Close modal"])')].find(button => button.textContent.trim() === ${JSON.stringify(text)})`};
    if (!element || element.disabled) throw Error('Missing or disabled interaction target');
    element.scrollIntoView({block:'center'}); const bounds = element.getBoundingClientRect();
    return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};
  })()`);
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...point,
  });
}
async function typeText(selector, text, replace = true) {
  // Focus the actual settings input before sending real keyboard events.
  const { root } = await call("DOM.getDocument");
  const { nodeId } = await call("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  await call("DOM.scrollIntoViewIfNeeded", { nodeId });
  await call("DOM.focus", { nodeId });
  if (replace) {
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    });
  }
  await call("Input.insertText", { text });
}
async function selectFiles(files) {
  const { root } = await call("DOM.getDocument");
  const { nodeId } = await call("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#attachments",
  });
  await call("DOM.setFileInputFiles", { nodeId, files });
  await eventually(
    () =>
      evaluate(
        `[...document.querySelectorAll('[role=dialog] button')].some(button => button.textContent.trim() === 'Upload' && !button.disabled)`,
      ),
    "confirmation modal",
  );
}
async function assertToken(expected, description) {
  await eventually(
    () =>
      evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(tokenInput)});
        return !!input && input.type === 'password' && !input.disabled &&
          input.value === ${JSON.stringify(expected)} &&
          (window.fixtureNative.settings.get().plugins.Pelican.apiToken ?? "") === ${JSON.stringify(expected)};
      })()`),
    description,
  );
}
async function screenshot(name) {
  // Fail closed if a regression renders either test credential as plain text.
  const safe = await evaluate(`(() => {
    const tokens = ${JSON.stringify([originalToken, invalidToken])};
    return !tokens.some(token => document.body.innerText.includes(token) ||
      [...document.querySelectorAll('input, textarea')].some(input =>
        input.value.includes(token) && input.type !== 'password'));
  })()`);
  assert(safe, "screenshot requires masked credentials");
  const { data } = await call("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(join(artifacts, name + ".png"), Buffer.from(data, "base64"));
}
async function status(phase) {
  await eventually(
    () =>
      evaluate(
        `document.querySelector('#status button')?.getAttribute('aria-label')?.includes(${JSON.stringify(phase)})`,
      ),
    phase,
  );
}
async function openStatus() {
  await click({ selector: "#status button" });
}
async function clearUpload() {
  await eventually(
    () =>
      evaluate(
        `[...document.querySelectorAll('[role=dialog] button')].some(button => button.textContent.trim() === 'Clear upload')`,
      ),
    "clearable stopped upload",
  );
  await click({ text: "Clear upload" });
  await eventually(
    () => evaluate('!document.querySelector("[role=dialog]")'),
    "cleared upload dialog",
  );
  assert.equal(
    await evaluate(`document.querySelector('#status button') === null`),
    true,
    "Clear upload removes the retained batch",
  );
}
async function assertNoSend() {
  const current = await snapshot();
  assert.equal(current.sent, 0, "Discord sendMessage must never be called");
  assert.deepEqual(
    current.errors,
    [],
    "normal Discord attachment path must not error",
  );
}
async function verifyDownload(url, file) {
  assert.equal(new URL(url).origin, "https://shares.example.test");
  const response = await fetch(url, { redirect: "error" });
  assert.equal(response.status, 200, "real Zipline download");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  const sha256 = hash.digest("hex");
  assert.equal(bytes, file.bytes);
  assert.equal(
    sha256,
    file.sha256,
    "downloaded bytes equal selected attachment",
  );
  downloads.push({
    url,
    downloadUrl: response.url,
    name: file.name,
    bytes,
    sha256,
  });
}
const links = (text) =>
  text.match(/https:\/\/shares\.example\.test\/[^\s|]+/g) ?? [];
try {
  const target = await eventually(async () => {
    try {
      return (await (await fetch(values.cdp + "/json/list")).json()).find(
        (item) =>
          item.type === "page" &&
          /^https:\/\/discord\.com(?:\/|$)/.test(item.url),
      );
    } catch {
      return undefined;
    }
  }, "real Vesktop Discord main page");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  const opened = Promise.withResolvers();
  socket.addEventListener("open", opened.resolve, { once: true });
  socket.addEventListener("error", opened.reject, { once: true });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error)
        request.reject(Error(redact(JSON.stringify(message.error))));
      else request.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown")
      diagnostics.push(JSON.parse(redact(JSON.stringify(message.params))));
  });
  await opened.promise;
  await call("Runtime.enable");
  await call("Page.enable");
  await call("DOM.enable");
  await eventually(async () => {
    const state = await evaluate(
      "({error:window.fixtureError, ready:window.pelicanFixture?.snapshot().ready})",
    );
    if (state.error) throw Error(state.error);
    return state.ready;
  }, "actual packaged native preload and fixture renderer");
  assert.equal(await evaluate("location.origin"), "https://discord.com");
  assert.equal((await snapshot()).patchMatches, 4);
  assert.equal((await snapshot()).required, false);
  assert.equal((await snapshot()).enabled, !configuring);
  if (configuring) {
    assert.equal((await snapshot()).serverUrl, "");
    assert.equal(
      await evaluate(`document.querySelector('#enable-pelican').disabled`),
      false,
      "optional plugin toggle is interactive",
    );
    assert.equal(
      await evaluate(
        `document.querySelector('[aria-label="Required Plugins"]') === null`,
      ),
      true,
      "Pelican is not in Required Plugins",
    );
    await click({ selector: "#enable-pelican" });
    await eventually(
      async () => (await snapshot()).enabled,
      "enable optional Pelican",
    );
    await click({ selector: "#enable-pelican" });
    await eventually(
      async () => !(await snapshot()).enabled,
      "disable optional Pelican",
    );
    await click({ selector: "#enable-pelican" });
    await eventually(
      async () => (await snapshot()).enabled,
      "re-enable optional Pelican",
    );
  }
  await click({ selector: "#plugin-settings" });
  await assertToken(
    configuring ? "" : originalToken,
    configuring
      ? "ordinary editable password setting starts empty"
      : "masked API token survives full application restart",
  );
  if (configuring) {
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(serverInput)}).value`,
      ),
      "",
    );
    await typeText(serverInput, "https://zipline.example.com");
    await eventually(
      async () =>
        (await snapshot()).serverUrl === "https://zipline.example.com",
      "real TextSetting writes configurable server URL through Vencord SettingsStore",
    );
    // Explicit test-only destination: production renderer has no server default.
    await typeText(serverInput, "https://shares.example.test");
    await eventually(
      async () =>
        (await snapshot()).serverUrl === "https://shares.example.test",
      "configured local TLS Zipline origin",
    );
    await typeText(tokenInput, originalToken);
    await assertToken(originalToken, "real TextSetting accepts the API token");
  } else {
    assert.equal(
      (await snapshot()).serverUrl,
      "https://shares.example.test",
      "server URL survives full application restart",
    );
  }
  await screenshot("plugin-settings");
  await click({ selector: '[aria-label="Close modal"]' });
  await click({ selector: "#plugin-settings" });
  await assertToken(
    originalToken,
    "masked API token survives reopening settings",
  );
  assert.equal(
    await evaluate(
      `document.querySelector(${JSON.stringify(serverInput)}).value`,
    ),
    "https://shares.example.test",
    "server URL survives closing and reopening the real settings modal",
  );
  await click({ selector: '[aria-label="Close modal"]' });
  scenarios.push(
    "optional plugin enable/disable; real pinned PluginModal and ordinary settings; URL and masked API token persist after modal reopen and application restart",
  );
  scenarios.push(
    "real packaged native bridge; ordinary settings credentials; four pinned Discord patch matches",
  );
  if (configuring) {
    await eventually(
      () =>
        evaluate(
          `window.fixtureNative.settings.get().plugins.Pelican.apiToken === ${JSON.stringify(originalToken)}`,
        ),
      "native settings receive the token before application restart",
    );
    await writeFile(
      join(artifacts, "configured.json"),
      JSON.stringify({ ok: true, maskedSettingsEntered: true }),
    );
  } else {
    const files = [];
    for (const [name, fill] of [
      ["large-a.bin", 0x51],
      ["SPOILER_large-b.bin", 0xa7],
    ]) {
      const bytes = Buffer.alloc(16 * 1024 * 1024 + 7, fill);
      bytes.fill(fill ^ 0xff, 16 * 1024 * 1024);
      const path = join(artifacts, name);
      await writeFile(path, bytes);
      files.push({
        name,
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const small = join(artifacts, "ordinary.txt");
    await writeFile(small, "ordinary Discord attachment\n");

    // Declining the real confirmation must make zero native HTTP uploads, while
    // leaving the ordinary prepared object's metadata and identity intact.
    await typeText("#composer", "original draft");
    const beforeDecline = uploadRequests(await control("/state")).length;
    await selectFiles([small, files[0].path]);
    assert(
      await evaluate(
        `document.querySelector('[role="dialog"]').textContent.includes('https://shares.example.test')`,
      ),
      "confirmation identifies the configured destination",
    );
    await screenshot("confirmation");
    await delay(500);
    assert.equal(
      uploadRequests(await control("/state")).length,
      beforeDecline,
      "no upload before consent",
    );
    await click({ text: "Cancel" });
    await eventually(
      async () => (await snapshot()).selections === 1,
      "declined normal selection",
    );
    assert.equal(
      uploadRequests(await control("/state")).length,
      beforeDecline,
      "decline does not upload",
    );
    assert.deepEqual((await snapshot()).ordinary, [
      {
        name: "ordinary.txt",
        description: "description:ordinary.txt",
        spoiler: false,
        identity: true,
      },
    ]);
    assert.equal(
      (await snapshot()).drafts["original-channel"].text,
      "original draft",
    );
    await assertNoSend();
    scenarios.push(
      "decline and no upload before consent; ordinary metadata and object identity preserved",
    );

    // Hold a REAL network request at the proxy, type in the original mounted
    // editor, then add completed links explicitly without replacing selection.
    await control("/pause", "POST");
    await selectFiles(files.map((file) => file.path));
    assert.equal(uploadRequests(await control("/state")).length, beforeDecline);
    await click({ text: "Upload" });
    await eventually(
      async () => (await control("/state")).pendingUploads > 0,
      "real native upload blocked at local TLS proxy",
    );
    await openStatus();
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('[role=dialog] button')].some(button => ['Add to message', 'Clear upload'].includes(button.textContent.trim()))`,
      ),
      false,
      "running uploads cannot be inserted or cleared",
    );
    await eventually(
      () =>
        evaluate(`(() => {
        const progress = document.querySelector('[role=dialog] progress');
        return progress && progress.value > 0 && progress.value < 16 * 1024 * 1024;
      })()`),
      "payload progress is visible before the paused first chunk is accepted",
    );
    scenarios.push(
      "intra-chunk payload progress reaches the dialog while the first upload request remains paused",
    );
    const progressPoint = await evaluate(`(() => {
      const progress = document.querySelector('[role=dialog] progress');
      const bounds = progress.getBoundingClientRect();
      return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};
    })()`);
    await call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...progressPoint,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...progressPoint,
    });
    assert.deepEqual(
      await evaluate(`(() => {
        const progress = document.querySelector('[role=dialog] progress');
        return {hover:progress.matches(':hover'), active:progress.matches(':active'),
          focused:document.activeElement === progress};
      })()`),
      { hover: false, active: false, focused: false },
      "hovering and pressing the read-only meter cannot activate interactive styling or focus",
    );
    await screenshot("upload-progress-pointer-held");
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...progressPoint,
    });
    scenarios.push(
      "upload progress ignores pointer hover and press without focus",
    );
    await screenshot("upload-progress");
    await click({ text: "Close" });
    assert(
      (await control("/state")).pendingUploads > 0,
      "Close hides the dialog without cancelling the upload",
    );
    await click({ selector: "#plugin-settings" });
    await typeText(serverInput, "https://zipline.example.com");
    await typeText(tokenInput, invalidToken);
    await assertToken(
      invalidToken,
      "changing future credentials during an active upload",
    );
    await eventually(
      async () =>
        (await snapshot()).serverUrl === "https://zipline.example.com",
      "changing future destination during an active upload",
    );
    await click({ selector: '[aria-label="Close modal"]' });
    await typeText("#composer", " typed during upload", false);
    for (const [key, code, windowsVirtualKeyCode, modifiers, count] of [
      ["Home", "Home", 36, 2, 1],
      ["ArrowRight", "ArrowRight", 39, 0, 2],
      ["ArrowRight", "ArrowRight", 39, 8, 7],
    ]) {
      for (let index = 0; index < count; index++) {
        await call("Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
          code,
          windowsVirtualKeyCode,
          modifiers,
        });
        await call("Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
          code,
          windowsVirtualKeyCode,
          modifiers,
        });
      }
    }
    const live = (await snapshot()).drafts["original-channel"];
    assert.equal(live.text, "original draft typed during upload");
    assert.deepEqual(live.selection, {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 9 },
    });
    await control("/release", "POST");
    await status("upload complete");
    assert.deepEqual(
      (await snapshot()).drafts["original-channel"],
      live,
      "completed multi-file upload leaves the live draft and selection untouched",
    );
    await openStatus();
    const fileLinks = await evaluate(
      `[...document.querySelectorAll('[role=dialog] a[href]')].map(anchor => ({
        name:anchor.textContent.trim(), href:anchor.href, target:anchor.target,
        rel:[...anchor.relList].sort()
      }))`,
    );
    assert.deepEqual(
      fileLinks.map(({ name }) => name),
      files.map(({ name }) => name),
      "completed files are filename links",
    );
    for (const link of fileLinks) {
      assert.equal(link.target, "_blank", "file link opens separately");
      assert.deepEqual(link.rel, ["noopener", "noreferrer"]);
    }
    await screenshot("completed-ready");
    await call("Browser.grantPermissions", {
      origin: "https://discord.com",
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await click({ text: "Copy links" });
    await eventually(
      () =>
        evaluate(
          `[...document.querySelectorAll('[role=dialog] button')].some(button => button.textContent.trim() === 'Copied')`,
        ),
      "clipboard success is acknowledged",
    );
    assert.equal(
      await evaluate("navigator.clipboard.readText()"),
      fileLinks.map(({ href }) => href).join("\n"),
      "copy writes every completed URL, one per line, to the real clipboard",
    );
    assert.deepEqual(
      (await snapshot()).drafts["original-channel"],
      live,
      "copying does not change the draft or selection",
    );
    await screenshot("completed-copied");
    scenarios.push(
      "completed links copied to real clipboard without draft mutation",
    );
    await click({ text: "Close" });
    await openStatus();
    assert.deepEqual(
      (await snapshot()).drafts["original-channel"],
      live,
      "reopening completed uploads does not insert links",
    );
    await click({ text: "Add to message" });
    const completed = (await snapshot()).drafts["original-channel"];
    const allLinks = links(completed.text);
    assert.equal(allLinks.length, 2);
    assert.equal(
      completed.text,
      `${live.text}\n${allLinks[0]}\n||${allLinks[1]}||\n`,
    );
    assert.deepEqual(completed.selection, live.selection);
    assert.deepEqual(
      fileLinks.map(({ href }) => href),
      allLinks,
      "filename anchors point to the completed upload URLs",
    );
    assert.equal(
      (await snapshot()).ordinary.length,
      1,
      "all-big batch does not add empty Discord attachments",
    );
    for (let index = 0; index < files.length; index++)
      await verifyDownload(allLinks[index], files[index]);
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('[role=dialog] button')].some(button => button.textContent.trim() === 'Add to message' && !button.disabled)`,
      ),
      true,
      "completed links remain available after the first explicit insertion",
    );
    await assertNoSend();
    await screenshot("completed-added");
    await click({ text: "Close" });
    await openStatus();
    assert.deepEqual(
      (await snapshot()).drafts["original-channel"],
      completed,
      "reopening after insertion preserves the draft without duplicates",
    );
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('[role=dialog] button')].some(button => button.textContent.trim() === 'Add to message' && !button.disabled)`,
      ),
      true,
      "reopened upload remains available for another explicit insertion",
    );
    await click({ text: "Add to message" });
    const repeated = (await snapshot()).drafts["original-channel"];
    assert.equal(
      repeated.text,
      `${completed.text}\n${allLinks[0]}\n||${allLinks[1]}||\n`,
      "a second explicit action appends both links without replacing selected text",
    );
    assert.deepEqual(
      repeated.selection,
      live.selection,
      "repeated insertion preserves the selected range",
    );
    await assertNoSend();
    await click({ text: "Close" });
    await openStatus();
    assert.deepEqual(
      (await snapshot()).drafts["original-channel"],
      repeated,
      "close and reopen after repeated insertion do not mutate the draft",
    );
    await clearUpload();
    await assertNoSend();
    scenarios.push(
      "all-big multi-file consent; completion and reopen preserve draft and selection; filename links match downloadable URLs; repeated explicit insertion preserves selected text and spoiler markup without autosend; SHA256 downloads",
    );
    await click({ selector: "#plugin-settings" });
    await typeText(serverInput, "https://shares.example.test");
    await typeText(tokenInput, originalToken);
    await assertToken(
      originalToken,
      "restoring credentials for the next batch",
    );
    await eventually(
      async () =>
        (await snapshot()).serverUrl === "https://shares.example.test",
      "restoring fixture destination for the next batch",
    );
    await click({ selector: '[aria-label="Close modal"]' });
    scenarios.push(
      "server and API token setting changes during upload do not redirect or reauthenticate the active multi-file job",
    );

    // Completing while another channel is selected cannot mutate either draft.
    await typeText("#composer", "mixed original draft");
    await control("/pause", "POST");
    await selectFiles([small, files[0].path]);
    await click({ text: "Upload" });
    await eventually(
      async () => (await control("/state")).pendingUploads > 0,
      "mixed upload paused",
    );
    await click({ text: "Other channel" });
    await typeText("#composer", "other draft untouched");
    await control("/release", "POST");
    await status("upload complete");
    let current = await snapshot();
    assert.equal(
      current.drafts["original-channel"].text,
      "mixed original draft",
    );
    assert.equal(current.drafts["other-channel"].text, "other draft untouched");
    assert.deepEqual(current.ordinary[1], {
      name: "ordinary.txt",
      description: "description:ordinary.txt",
      spoiler: false,
      identity: true,
    });
    assert.equal(current.ordinary.length, 2);
    await openStatus();
    const draftBeforeCopy = (await snapshot()).drafts;
    const singleUrl = await evaluate(
      `document.querySelector('[role=dialog] a[href]').href`,
    );
    await click({ text: "Copy link" });
    await eventually(
      () =>
        evaluate(
          `[...document.querySelectorAll('[role=dialog] button')].some(button => button.textContent.trim() === 'Copied')`,
        ),
      "single-link copy completes",
    );
    assert.equal(await evaluate("navigator.clipboard.readText()"), singleUrl);
    assert.deepEqual(
      (await snapshot()).drafts,
      draftBeforeCopy,
      "single-link copy in another channel leaves every draft unchanged",
    );
    await click({ text: "Add to message" });
    current = await snapshot();
    assert.equal(
      current.drafts["original-channel"].text,
      "mixed original draft",
      "explicit insertion in another channel cannot mutate the original draft",
    );
    assert.equal(
      current.drafts["other-channel"].text,
      "other draft untouched",
      "explicit insertion cannot target the selected wrong channel",
    );
    await click({ text: "Close" });
    await click({ text: "Original channel" });
    await click({ text: "Other account" });
    await openStatus();
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('[role=dialog] button')].some(button => button.textContent.trim() === 'Add to message')`,
      ),
      false,
      "another account cannot insert the original account's completed links",
    );
    assert.equal(
      await evaluate(
        `document.querySelector('[role=dialog]').textContent.includes(${JSON.stringify(files[0].name)})`,
      ),
      false,
      "another account cannot view the original account's uploaded files",
    );
    assert.equal(
      (await snapshot()).drafts["original-channel"].text,
      "mixed original draft",
      "switching accounts does not insert retained links",
    );
    await click({ text: "Close" });
    await click({ text: "Original account" });
    await openStatus();
    await click({ text: "Add to message" });
    current = await snapshot();
    const mixedLinks = links(current.drafts["original-channel"].text);
    assert.equal(mixedLinks.length, 1);
    assert.equal(
      current.drafts["original-channel"].text,
      `mixed original draft\n${mixedLinks[0]}\n`,
    );
    assert.equal(current.drafts["other-channel"].text, "other draft untouched");
    await verifyDownload(mixedLinks[0], files[0]);
    await clearUpload();
    await assertNoSend();
    scenarios.push(
      "mixed attachments; Add to message enforces original channel and account after navigation; no autosend",
    );

    const draftBeforeCancel = (await snapshot()).drafts["original-channel"]
      .text;
    await control("/pause", "POST");
    await selectFiles([files[0].path]);
    await click({ text: "Upload" });
    await eventually(
      async () => (await control("/state")).pendingUploads > 0,
      "cancellable real network request",
    );
    await openStatus();
    await click({ text: "Cancel upload" });
    await control("/release", "POST");
    await status("cancelled");
    assert.equal(
      (await snapshot()).drafts["original-channel"].text,
      draftBeforeCancel,
      "cancellation does not insert links",
    );
    await click({ text: "Close" });
    await openStatus();
    assert.equal(
      (await snapshot()).drafts["original-channel"].text,
      draftBeforeCancel,
      "reopening a cancelled upload does not insert links",
    );
    await clearUpload();
    assert.equal(
      (await snapshot()).drafts["original-channel"].text,
      draftBeforeCancel,
    );
    await assertNoSend();
    scenarios.push(
      "cancel in-flight real native upload; no completed link fabricated; selected files releasable",
    );

    const requestsBeforeInvalid = uploadRequests(
      await control("/state"),
    ).length;
    await click({ selector: "#plugin-settings" });
    await typeText(tokenInput, invalidToken);
    await assertToken(
      invalidToken,
      "invalid credential entered through ordinary settings",
    );
    await click({ selector: '[aria-label="Close modal"]' });
    await selectFiles([files[0].path]);
    await click({ text: "Upload" });
    await status("upload failed");
    await openStatus();
    const rejected = uploadRequests(await control("/state")).slice(
      requestsBeforeInvalid,
    );
    assert.equal(rejected.length, 1);
    assert.equal(
      rejected[0].status,
      401,
      "real Zipline rejects the edited token",
    );
    assert.equal(
      (await snapshot()).drafts["original-channel"].text,
      draftBeforeCancel,
    );
    await delay(600);
    assert.equal(
      uploadRequests(await control("/state")).length,
      requestsBeforeInvalid + 1,
      "invalid token is not retried",
    );
    await screenshot("invalid-credentials");
    await clearUpload();
    await click({ selector: "#plugin-settings" });
    await typeText(tokenInput, originalToken);
    await assertToken(
      originalToken,
      "valid credential restored through ordinary settings",
    );
    await click({ selector: '[aria-label="Close modal"]' });
    await assertNoSend();
    scenarios.push(
      "invalid API token setting causes genuine HTTP 401 without retry or draft mutation",
    );

    // Settings are ordinary Vencord inputs and require no Pelican native helper.
    await call("Page.navigate", {
      url: `${target.url.split("?")[0]}?missing-native=1`,
    });
    await eventually(
      () =>
        evaluate(
          `location.search.includes('missing-native') && window.pelicanFixture?.snapshot().ready && !!document.querySelector('#plugin-settings')`,
        ),
      "renderer without the Pelican native helper",
    );
    await click({ selector: "#plugin-settings" });
    await assertToken(
      originalToken,
      "persisted masked settings load without Pelican helper",
    );
    await typeText(serverInput, "https://zipline.example.com");
    await typeText(tokenInput, invalidToken);
    await assertToken(
      invalidToken,
      "API token remains editable without Pelican helper",
    );
    await eventually(
      async () =>
        (await snapshot()).serverUrl === "https://zipline.example.com",
      "server URL remains editable with missing native helper",
    );
    await screenshot("missing-native-settings");
    await click({ selector: '[aria-label="Close modal"]' });
    await click({ selector: "#plugin-settings" });
    await assertToken(
      invalidToken,
      "API token edit survives reopen without Pelican helper",
    );
    await typeText(tokenInput, originalToken);
    await assertToken(
      originalToken,
      "restoring masked token without Pelican helper",
    );
    await click({ selector: '[aria-label="Close modal"]' });
    scenarios.push(
      "ordinary URL and masked API token settings remain editable and retained without the Pelican native helper",
    );

    const requests = uploadRequests(await control("/state"));
    assert(
      requests.length >= 8,
      "multiple real partial/chunk upload requests observed",
    );
    assert(
      requests.some((request) =>
        request.path.startsWith("/api/upload/partial"),
      ),
      "real partial upload protocol used",
    );
    for (const request of requests) {
      assert.equal(request.protocol, "https:");
      assert.equal(request.host, "shares.example.test");
    }
    const result = {
      ok: true,
      scenarios,
      downloads,
      network: {
        uploadRequests: requests.length,
        hosts: [...new Set(requests.map((request) => request.host))],
        protocols: [...new Set(requests.map((request) => request.protocol))],
      },
      limitation:
        "Pinned Vencord PluginModal, settings controls/store, error boundary, Forms and Button components with their upstream CSS run with a representative fixture palette and controlled Discord Modal/TextInput/User primitives and plugin-list host. Actual packaged native bridge and pinned attachment factories; not live Discord compatibility, live theme or login.",
    };
    await writeFile(
      join(artifacts, "result.json"),
      redact(JSON.stringify(result, null, 2)),
    );
    console.log(redact(JSON.stringify(result)));
  }
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      await screenshot("failure");
    } catch {}
    try {
      await writeFile(
        join(artifacts, "failure-state.json"),
        redact(JSON.stringify(await snapshot(), null, 2)),
      );
    } catch {}
    // The VM also captures the whole desktop on failure. Clear its surface if
    // a broken input or error boundary could have rendered a credential.
    try {
      await call("Page.navigate", { url: "about:blank" });
    } catch {}
  }
  await writeFile(
    join(artifacts, "diagnostics.json"),
    redact(JSON.stringify(diagnostics, null, 2)),
  );
  throw Error(redact(error?.stack ?? error));
} finally {
  try {
    await control("/release", "POST");
  } catch {}
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(Error("CDP driver closing"));
  }
  socket?.close();
}
