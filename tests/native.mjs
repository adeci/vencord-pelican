import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configure, deferred, state } from "./fixture-runtime.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(process.argv[2] ?? join(HERE, ".."));
const runtime = await mkdtemp(join(tmpdir(), "pelican-native-test-"));
const apiToken = "fixture-api-token-no-production-access";
const alternateToken = "fixture-alternate-api-token";
const ORIGIN = "https://shares.example.test";
const ALTERNATE_ORIGIN = "https://zipline.example:8443";
const CHUNK = 16 * 1024 * 1024;
const shim = pathToFileURL(join(HERE, "fixture-runtime.mjs")).href;
const queue = [];
const received = [];
const serverErrors = [];
const owners = [];
const completedCases = [];
let nextOwner = 100;
let native;

function exact(source, from, to, label) {
  const matches =
    from instanceof RegExp
      ? (source.match(from) ?? []).length
      : source.split(from).length - 1;
  assert.equal(
    matches,
    1,
    `Source adapter mismatch (${label}); review the actual source before adapting. No production module has been imported.`,
  );
  return source.replace(from, to);
}

async function prepareActualModules() {
  let upload = await readFile(join(SOURCE, "native.ts"), "utf8");
  upload = exact(
    upload,
    'import { request } from "node:https";',
    `import { request } from ${JSON.stringify(shim)};`,
    "loopback-only HTTPS transport",
  );
  upload = exact(
    upload,
    'import { setTimeout as delay } from "node:timers/promises";',
    `import { setTimeout as delay } from ${JSON.stringify(shim)};`,
    "abortable timer observation",
  );
  await writeFile(
    join(runtime, "native.mjs"),
    stripTypeScriptTypes(upload, { mode: "strip" }),
  );
  return await import(pathToFileURL(join(runtime, "native.mjs")).href);
}

async function prepareAttachmentFlow() {
  const source = stripTypeScriptTypes(
    await readFile(join(SOURCE, "attachmentFlow.ts"), "utf8"),
    { mode: "transform" },
  );
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    )
  ).AttachmentFlow;
}

function owner(url = "https://discord.com/channels/@me") {
  const sender = new EventEmitter();
  sender.id = nextOwner++;
  sender.mainFrame = { url };
  sender.destroyed = false;
  sender.isDestroyed = () => sender.destroyed;
  const event = { sender, senderFrame: sender.mainFrame };
  owners.push(event);
  return event;
}
function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
function rejected(result, pattern) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.error, pattern);
  assert.equal(result.error.includes(apiToken), false);
  assert.equal(result.error.includes(alternateToken), false);
  return result.error;
}
function bytes(value) {
  return Uint8Array.from(value).buffer;
}
const smallBytes = bytes([0, 1, 2, 255]);
function digest(value) {
  return createHash("sha256").update(Buffer.from(value)).digest("hex");
}

function observeUpload(event, id, predicates = []) {
  assert.equal(state.writeObserver, undefined);
  const gates = predicates.map((matches) => ({
    matches,
    arrived: deferred(),
    reached: false,
  }));
  const samples = [];
  state.writeObserver = (write, resume) => {
    samples.push({ ...write, status: native.status(event, id) });
    const gate = gates.find((gate) => !gate.reached && gate.matches(write));
    if (gate) {
      gate.reached = true;
      gate.arrived.resolve({ write, resume });
    } else resume();
  };
  return { samples, checkpoints: gates.map((gate) => gate.arrived.promise) };
}

function assertPayloadProgress(observed, offset, size, length) {
  let payloadBytes = 0;
  for (const sample of observed.samples) {
    assert.equal(
      sample.status.sent,
      offset + sample.payloadOffset,
      "Only preceding completed payload writes contribute to progress",
    );
    assert.equal(sample.status.size, size);
    assert.equal(sample.status.phase, "uploading");
    assert.ok(sample.status.sent >= 0 && sample.status.sent <= size);
    assert.ok(sample.payloadBytes <= 64 * 1024, "Bounded payload writes");
    payloadBytes += sample.payloadBytes;
  }
  assert.equal(payloadBytes, length);
}
function fileReply(id, more = {}, origin = ORIGIN) {
  return { files: [{ id, url: `${origin}/u/${id}`, ...more }] };
}
async function start(
  event,
  files = [{ name: "fixture.bin", size: 4 }],
  serverUrl = ORIGIN,
  token = apiToken,
) {
  const reply = ok(await native.beginUpload(event, files, serverUrl, token));
  assert.equal(reply.chunkSize, CHUNK);
  assert.equal(reply.protocolVersion, 2);
  return reply.jobId;
}
function dismiss(event, id) {
  native.dismiss(event, id);
  assert.equal(native.status(event, id), null);
  assert.equal(event.sender.listenerCount("destroyed"), 0);
  assert.equal(event.sender.listenerCount("render-process-gone"), 0);
  assert.equal(event.sender.listenerCount("did-start-navigation"), 0);
}
function terminate(event, id) {
  native.cancel(event, id);
  dismiss(event, id);
}

function plan(path, options = {}) {
  const next = {
    path,
    method: path === "/api/user/files/incomplete" ? "GET" : "POST",
    ...options,
    arrived: deferred(),
    opened: deferred(),
    interrupted: deferred(),
    closed: deferred(),
    disconnected: deferred(),
  };
  queue.push(next);
  return next;
}

async function readMultipart(req) {
  let wireLength = 0;
  if (req.method === "GET") {
    for await (const chunk of req) wireLength += chunk.length;
    assert.equal(wireLength, 0);
    return { wireLength, dataLength: 0 };
  }
  const boundary = /boundary=([^;]+)/.exec(
    req.headers["content-type"] ?? "",
  )?.[1];
  assert.ok(boundary, "Actual multipart boundary required");
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  let header;
  let awaitingHeader = Buffer.alloc(0);
  let retained = Buffer.alloc(0);
  let dataLength = 0;
  const hash = createHash("sha256");
  function payload(chunk) {
    const available = Buffer.concat([retained, chunk]);
    const count = Math.max(0, available.length - suffix.length);
    hash.update(available.subarray(0, count));
    dataLength += count;
    retained = available.subarray(count);
  }
  for await (const chunk of req) {
    wireLength += chunk.length;
    if (header === undefined) {
      awaitingHeader = Buffer.concat([awaitingHeader, chunk]);
      const end = awaitingHeader.indexOf("\r\n\r\n");
      if (end < 0) {
        assert.ok(awaitingHeader.length < 16384);
        continue;
      }
      header = awaitingHeader.subarray(0, end + 4).toString("utf8");
      assert.ok(header.startsWith(`--${boundary}\r\n`));
      payload(awaitingHeader.subarray(end + 4));
      awaitingHeader = Buffer.alloc(0);
    } else payload(chunk);
  }
  assert.notEqual(header, undefined);
  assert.deepEqual(
    retained,
    suffix,
    "Multipart closing delimiter must be exact",
  );
  assert.equal(Number(req.headers["content-length"]), wireLength);
  return { wireLength, dataLength, hash: hash.digest("hex"), header };
}

const server = createServer((req, res) => {
  const next = queue.shift();
  if (next) res.once("close", () => next.closed.resolve());
  if (next?.allowAbort) {
    req.socket.once("close", () =>
      next.disconnected.resolve({ complete: req.complete }),
    );
  }
  void (async () => {
    assert.ok(next, `Unexpected HTTP ${req.method} ${req.url}`);
    assert.equal(req.url, next.path);
    assert.equal(req.method, next.method);
    assert.equal(req.headers.authorization, next.apiToken ?? apiToken);
    assert.equal(req.headers.cookie, undefined);
    next.opened.resolve();
    if (next.earlyResponse) {
      await next.earlyResponse.promise;
      res.writeHead(next.status ?? 500, {
        "content-type": "application/json",
      });
      res.end(next.raw ?? "{}");
      return;
    }
    const body = await readMultipart(req);
    const entry = { path: req.url, headers: req.headers, body };
    received.push(entry);
    if (next.inspect) next.inspect(entry);
    next.arrived.resolve(entry);
    if (next.hold) return;
    if (next.responseGate) await next.responseGate.promise;
    if (next.destroy) {
      req.socket.destroy();
      return;
    }
    res.writeHead(next.status ?? 200, {
      "content-type": "application/json",
      ...next.headers,
    });
    res.end(next.raw ?? JSON.stringify(next.json));
  })().catch((error) => {
    if (next?.allowAbort && req.aborted && error.code === "ECONNRESET") {
      next.interrupted.resolve();
      return;
    }
    serverErrors.push(error);
    next?.arrived.resolve({ error });
    if (!res.destroyed) {
      res.writeHead(500);
      res.end("fixture server assertion failed");
    }
  });
});

async function run(name, fn) {
  try {
    await fn();
    assert.deepEqual(serverErrors, [], "Loopback server assertions");
    assert.equal(
      queue.length,
      0,
      "Every planned HTTP request must actually occur",
    );
    completedCases.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

const watchdog = setTimeout(() => {
  console.error(
    "FAIL harness timeout: unresolved native operation or unmet fixture request",
  );
  for (const event of owners) event.sender.emit("render-process-gone");
  server.closeAllConnections();
  process.exit(1);
}, 60_000);
watchdog.unref();

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  configure({
    port: server.address().port,
    allowedOrigins: [ORIGIN, ALTERNATE_ORIGIN],
  });
  native = await prepareActualModules();
  const AttachmentFlow = await prepareAttachmentFlow();
  console.log(
    "SOURCE actual native.ts; stripTypeScriptTypes only; HTTPS explicitly remapped to 127.0.0.1",
  );

  await run(
    "API token validation: invalid values reject without requests or token disclosure and permit correction",
    async () => {
      const event = owner();
      const beforeRequests = state.requests.length;
      for (const token of [
        undefined,
        null,
        42,
        {},
        "",
        " \t ",
        `${apiToken}\rInjected: value`,
        `${apiToken}\nInjected: value`,
        `${apiToken}\0`,
        `${apiToken}\u0001`,
        `${apiToken}\u007f`,
        `${apiToken}\u2603`,
        apiToken.repeat(2048),
        "\u00e9".repeat(32769),
      ]) {
        const result = await native.beginUpload(
          event,
          [{ name: "fixture.bin", size: 4 }],
          ORIGIN,
          token,
        );
        rejected(result, /token/i);
        if (typeof token === "string" && token.trim())
          assert.equal(result.error.includes(token), false);
        assert.equal(state.requests.length, beforeRequests);
        assert.equal(event.sender.listenerCount("destroyed"), 0);
      }
      const id = await start(event, undefined, ORIGIN, `  ${apiToken}  `);
      plan("/api/upload", { json: fileReply("corrected-token") });
      assert.equal(
        ok(await native.uploadChunk(event, id, 0, 0, smallBytes)).done,
        true,
      );
      dismiss(event, id);
    },
  );

  await run(
    "server configuration: invalid origins reject before network",
    async () => {
      const event = owner();
      const beforeRequests = state.requests.length;
      for (const serverUrl of [
        undefined,
        null,
        42,
        {},
        "",
        "not a URL",
        "http://zipline.example",
        "ftp://zipline.example",
        "//zipline.example",
        "https:",
        "https:///zipline.example",
        "https://zipline.example:invalid",
        "https://user:secret@zipline.example",
        "https://@zipline.example",
        "https://zipline.example/api",
        "https://zipline.example//",
        "https://zipline.example/.",
        "https://zipline.example/path/..",
        "https://zipline.example?token=secret",
        "https://zipline.example?",
        "https://zipline.example/#fragment",
        "https://zipline.example/#",
        "https://zipline.example\\",
        " https://zipline.example",
        "https://zipline.example\n",
      ]) {
        const result = await native.beginUpload(
          event,
          [{ name: "fixture.bin", size: 4 }],
          serverUrl,
          apiToken,
        );
        rejected(result, /HTTPS Zipline origin/);
        assert.equal(result.error.includes("secret"), false);
        assert.equal(state.requests.length, beforeRequests);
        assert.equal(event.sender.listenerCount("destroyed"), 0);
      }
      terminate(event, await start(event));
    },
  );

  await run(
    "server configuration: captured alternate token and origin stay isolated from a concurrent default-origin job",
    async () => {
      const alternate = owner();
      const original = owner();
      const requestStart = state.requests.length;
      const alternateId = await start(
        alternate,
        undefined,
        "HTTPS://ZIPLINE.EXAMPLE:8443/",
        alternateToken,
      );
      const originalId = await start(original, undefined, `${ORIGIN}:443/`);
      plan("/api/upload", {
        apiToken: alternateToken,
        json: fileReply("alternate", {}, ALTERNATE_ORIGIN),
      });
      assert.equal(
        ok(await native.uploadChunk(alternate, alternateId, 0, 0, smallBytes))
          .done,
        true,
      );
      plan("/api/upload", { json: fileReply("original") });
      assert.equal(
        ok(await native.uploadChunk(original, originalId, 0, 0, smallBytes))
          .done,
        true,
      );
      assert.deepEqual(native.status(alternate, alternateId).urls, [
        `${ALTERNATE_ORIGIN}/u/alternate`,
      ]);
      assert.deepEqual(native.status(original, originalId).urls, [
        `${ORIGIN}/u/original`,
      ]);
      assert.deepEqual(
        state.requests
          .slice(requestStart)
          .map(({ origin, path }) => ({ origin, path })),
        [
          { origin: ALTERNATE_ORIGIN, path: "/api/upload" },
          { origin: ORIGIN, path: "/api/upload" },
        ],
      );
      dismiss(alternate, alternateId);
      dismiss(original, originalId);
    },
  );

  await run(
    "IPC ownership: only live Discord main frame; cross-window isolation",
    async () => {
      const event = owner();
      const id = await start(event);
      const other = owner();
      const invalid = [
        { ...event, senderFrame: { url: event.sender.mainFrame.url } },
        { ...event, senderFrame: null },
        owner("https://discord.com.attacker.invalid/channels/@me"),
        owner("https://attacker.invalid/"),
        owner("http://discord.com/channels/@me"),
        owner("https://discord.com:443/channels/@me"),
      ];
      const dead = owner();
      dead.sender.destroyed = true;
      invalid.push(dead);
      for (const bad of invalid) {
        rejected(
          await native.beginUpload(
            bad,
            [{ name: "x", size: 0 }],
            ORIGIN,
            apiToken,
          ),
          /Discord main window/,
        );
        rejected(
          await native.uploadChunk(bad, id, 0, 0, smallBytes),
          /Discord main window/,
        );
        assert.equal(native.status(bad, id), null);
        native.cancel(bad, id);
        native.dismiss(bad, id);
      }
      assert.equal(native.status(other, id), null);
      rejected(
        await native.uploadChunk(other, id, 0, 0, smallBytes),
        /no longer active/,
      );
      native.cancel(other, id);
      native.dismiss(other, id);
      assert.equal(native.status(event, id).phase, "uploading");
      terminate(event, id);
      for (const url of [
        "https://canary.discord.com/channels/@me",
        "https://ptb.discord.com/channels/@me",
        "https://discord.com",
      ]) {
        const allowed = owner(url);
        terminate(allowed, await start(allowed));
      }
    },
  );

  await run(
    "metadata and chunk validation: invalid indices/offsets/lengths/types reject without consuming job",
    async () => {
      const event = owner();
      for (const files of [
        null,
        [],
        [null],
        [{ name: "", size: 0 }],
        [{ name: 7, size: 0 }],
        [{ name: "x", size: -1 }],
        [{ name: "x", size: 0.5 }],
        [{ name: "x", size: Number.MAX_SAFE_INTEGER + 1 }],
      ]) {
        rejected(
          await native.beginUpload(event, files, ORIGIN, apiToken),
          /Invalid attachment metadata/,
        );
      }
      const id = await start(event);
      const before = state.requests.length;
      for (const [index, offset, data] of [
        [1, 0, smallBytes],
        [-1, 0, smallBytes],
        [0.5, 0, smallBytes],
        [0, 1, smallBytes],
        [0, -1, smallBytes],
        [0, 0, new ArrayBuffer(3)],
        [0, 0, new ArrayBuffer(5)],
        [0, 0, new Uint8Array(4)],
      ]) {
        rejected(
          await native.uploadChunk(event, id, index, offset, data),
          /Invalid upload chunk or sequence/,
        );
        assert.equal(native.status(event, id).phase, "uploading");
        assert.equal(native.status(event, id).sent, 0);
      }
      rejected(
        await native.uploadChunk(event, "stale", 0, 0, smallBytes),
        /no longer active/,
      );
      assert.equal(state.requests.length, before);
      plan("/api/upload", { json: fileReply("validated") });
      assert.equal(
        ok(await native.uploadChunk(event, id, 0, 0, smallBytes)).done,
        true,
      );
      dismiss(event, id);
    },
  );

  await run(
    "ordinary uploads: empty and binary small file use multipart /api/upload without range headers",
    async () => {
      const event = owner();
      const id = await start(event, [
        { name: "empty.bin", size: 0 },
        { name: 'small\r\n"\\.bin', size: 4 },
      ]);
      plan("/api/upload", {
        json: fileReply("empty"),
        inspect: ({ headers, body }) => {
          assert.equal(headers["content-range"], undefined);
          assert.equal(headers["x-zipline-p-token"], undefined);
          assert.equal(body.dataLength, 0);
          assert.equal(body.hash, digest(new ArrayBuffer(0)));
        },
      });
      assert.deepEqual(
        ok(await native.uploadChunk(event, id, 0, 0, new ArrayBuffer(0))),
        { fileIndex: 0, nextOffset: 0, done: false },
      );
      assert.deepEqual(native.status(event, id).urls, [`${ORIGIN}/u/empty`]);
      plan("/api/upload", {
        json: fileReply("small"),
        inspect: ({ headers, body }) => {
          assert.equal(headers["content-range"], undefined);
          assert.equal(body.dataLength, 4);
          assert.equal(body.hash, digest(smallBytes));
          assert.match(body.header, /filename="small____\.bin"/);
        },
      });
      assert.deepEqual(
        ok(await native.uploadChunk(event, id, 1, 0, smallBytes)),
        { fileIndex: 1, nextOffset: 4, done: true },
      );
      const result = native.status(event, id);
      assert.equal(result.phase, "complete");
      assert.deepEqual(result.urls, [`${ORIGIN}/u/empty`, `${ORIGIN}/u/small`]);
      result.urls.length = 0;
      assert.equal(
        native.status(event, id).urls.length,
        2,
        "Status snapshots must not mutate retained URLs",
      );
      dismiss(event, id);
    },
  );

  await run(
    "busy rejection: overlapping chunk and begin cannot replace an in-flight HTTP upload",
    async () => {
      const event = owner();
      const id = await start(event);
      const held = plan("/api/upload", { hold: true });
      const pending = native.uploadChunk(event, id, 0, 0, smallBytes);
      await held.arrived.promise;
      rejected(
        await native.uploadChunk(event, id, 0, 0, smallBytes),
        /already being processed/,
      );
      rejected(
        await native.beginUpload(
          event,
          [{ name: "replacement", size: 0 }],
          ORIGIN,
          apiToken,
        ),
        /already open/,
      );
      native.dismiss(event, id);
      assert.equal(native.status(event, id).phase, "uploading");
      native.cancel(event, id);
      rejected(await pending, /Upload cancelled/);
      await held.closed.promise;
      assert.equal(native.status(event, id).phase, "cancelled");
      dismiss(event, id);
    },
  );

  await run(
    "large upload: payload-only progress before acceptance, inclusive ranges, rotated tokens, hashes and unchanged processing requests",
    async () => {
      const event = owner();
      const size = CHUNK * 2 + 3;
      const name = "space snowman \u2603.bin";
      const requestStart = state.requests.length;
      const id = await start(event, [{ name, size }], ALTERNATE_ORIGIN);
      const big = new Uint8Array(CHUNK).fill(0x61).buffer;
      const bigHash = digest(big);
      const last = bytes([0, 255, 13]);
      const parts = [
        {
          offset: 0,
          data: big,
          token: undefined,
          next: "fixture-partial-token-A",
        },
        {
          offset: CHUNK,
          data: big,
          token: "fixture-partial-token-A",
          next: "fixture-partial-token-B",
        },
        {
          offset: CHUNK * 2,
          data: last,
          token: "fixture-partial-token-B",
          next: undefined,
        },
      ];
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        const final = index === 2;
        const responseGate = deferred();
        const observed = observeUpload(
          event,
          id,
          index === 0
            ? [
                (write) => write.wireOffset === 0,
                (write) => write.payloadBytes > 0,
                (write) => write.payloadBytes > 0,
                (write) => write.wireOffset > 0 && write.payloadBytes === 0,
              ]
            : [],
        );
        const uploaded = plan("/api/upload/partial", {
          responseGate,
          json: final
            ? {
                partialSuccess: true,
                ...fileReply("large-file", {}, ALTERNATE_ORIGIN),
              }
            : { partialSuccess: true, partialToken: part.next },
          inspect: ({ headers, body }) => {
            assert.equal(
              headers["content-range"],
              `bytes ${part.offset}-${part.offset + part.data.byteLength - 1}/${size}`,
            );
            assert.equal(headers["x-zipline-p-content-length"], String(size));
            assert.equal(
              headers["x-zipline-p-content-type"],
              "application/octet-stream",
            );
            assert.equal(
              headers["x-zipline-p-filename"],
              encodeURIComponent(name),
            );
            assert.equal(headers["x-zipline-p-token"], part.token);
            assert.equal(headers["x-zipline-p-lastchunk"], String(final));
            assert.equal(body.dataLength, part.data.byteLength);
            assert.equal(body.hash, final ? digest(last) : bigHash);
          },
        });
        if (final)
          plan("/api/user/files/incomplete", {
            json: [
              {
                id: "unrelated-top-level-id",
                status: "COMPLETE",
                metadata: { file: { id: "large-file" } },
              },
            ],
          });
        let acknowledged = false;
        const pending = native.uploadChunk(
          event,
          id,
          0,
          part.offset,
          part.data,
        );
        void pending.then(() => {
          acknowledged = true;
        });
        if (index === 0) {
          const prefix = await observed.checkpoints[0];
          assert.equal(native.status(event, id).sent, 0);
          assert.equal(prefix.write.payloadBytes, 0);
          prefix.resume();
          const first = await observed.checkpoints[1];
          assert.equal(
            native.status(event, id).sent,
            0,
            "Buffer availability is not write completion",
          );
          first.resume();
          const second = await observed.checkpoints[2];
          const during = native.status(event, id);
          assert.equal(during.sent, first.write.payloadBytes);
          assert.ok(during.sent > 0 && during.sent < CHUNK);
          assert.equal(during.phase, "uploading");
          assert.equal(acknowledged, false);
          assert.deepEqual(during.urls, []);
          second.resume();
          const suffix = await observed.checkpoints[3];
          assert.equal(native.status(event, id).sent, CHUNK);
          assert.equal(suffix.write.payloadBytes, 0);
          suffix.resume();
        }
        await uploaded.arrived.promise;
        const transmitted = native.status(event, id);
        assert.equal(transmitted.sent, part.offset + part.data.byteLength);
        assert.equal(transmitted.phase, "uploading");
        assert.deepEqual(transmitted.urls, []);
        assert.equal(
          acknowledged,
          false,
          "Only accepted chunks return offsets",
        );
        assert.equal(state.requests.length, requestStart + index + 1);
        responseGate.resolve();
        const ack = ok(await pending);
        assertPayloadProgress(
          observed,
          part.offset,
          size,
          part.data.byteLength,
        );
        assert.deepEqual(ack, {
          fileIndex: 0,
          nextOffset: part.offset + part.data.byteLength,
          done: final,
        });
      }
      assert.deepEqual(native.status(event, id).urls, [
        `${ALTERNATE_ORIGIN}/u/large-file`,
      ]);
      assert.deepEqual(
        state.requests
          .slice(requestStart)
          .map(({ origin, path }) => ({ origin, path })),
        [
          { origin: ALTERNATE_ORIGIN, path: "/api/upload/partial" },
          { origin: ALTERNATE_ORIGIN, path: "/api/upload/partial" },
          { origin: ALTERNATE_ORIGIN, path: "/api/upload/partial" },
          { origin: ALTERNATE_ORIGIN, path: "/api/user/files/incomplete" },
        ],
      );
      dismiss(event, id);
    },
  );

  await run(
    "ordinary progress: payload bounds and hashes survive nonempty, empty and sequential-file resets",
    async () => {
      const event = owner();
      const data = new Uint8Array(128 * 1024 + 3).fill(0x5a).buffer;
      const files = [
        { name: "progress.bin", data },
        { name: "empty.bin", data: new ArrayBuffer(0) },
        { name: "last.bin", data: smallBytes },
      ];
      const requestStart = state.requests.length;
      const id = await start(
        event,
        files.map(({ name, data }) => ({ name, size: data.byteLength })),
      );
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const before = native.status(event, id);
        assert.equal(before.file, file.name);
        assert.equal(before.index, index + 1);
        assert.equal(before.sent, 0, "Each file starts its own byte count");
        assert.equal(before.size, file.data.byteLength);
        const responseGate = deferred();
        const observed = observeUpload(event, id);
        const uploaded = plan("/api/upload", {
          responseGate,
          json: fileReply(`progress-${index}`),
          inspect: ({ headers, body }) => {
            assert.equal(headers["content-range"], undefined);
            assert.equal(headers["x-zipline-p-token"], undefined);
            assert.equal(body.dataLength, file.data.byteLength);
            assert.equal(body.hash, digest(file.data));
          },
        });
        const pending = native.uploadChunk(event, id, index, 0, file.data);
        await uploaded.arrived.promise;
        const sent = native.status(event, id);
        assert.equal(sent.sent, file.data.byteLength);
        assert.equal(sent.phase, "uploading");
        assert.deepEqual(
          sent.urls,
          files.slice(0, index).map((_, i) => `${ORIGIN}/u/progress-${i}`),
        );
        responseGate.resolve();
        assert.deepEqual(ok(await pending), {
          fileIndex: index,
          nextOffset: file.data.byteLength,
          done: index === files.length - 1,
        });
        assertPayloadProgress(
          observed,
          0,
          file.data.byteLength,
          file.data.byteLength,
        );
        if (index === 0)
          assert.ok(
            observed.samples.some(
              ({ status }) =>
                status.sent > 0 && status.sent < file.data.byteLength,
            ),
            "Ordinary uploads also expose progress within their one request",
          );
      }
      assert.equal(native.status(event, id).phase, "complete");
      assert.deepEqual(
        state.requests.slice(requestStart).map(({ path }) => path),
        ["/api/upload", "/api/upload", "/api/upload"],
      );
      dismiss(event, id);
    },
  );

  await run(
    "stalled transport: cancellation and early HTTP rejection freeze progress before late write callbacks",
    async () => {
      for (const mode of ["cancel", "reject"]) {
        const event = owner();
        const id = await start(event, [
          { name: "stalled.bin", size: CHUNK + 1 },
        ]);
        const requestStart = state.requests.length;
        const earlyResponse = mode === "reject" ? deferred() : undefined;
        const uploaded = plan("/api/upload/partial", {
          allowAbort: true,
          earlyResponse,
          status: 500,
        });
        const observed = observeUpload(event, id, [
          (write) => write.payloadOffset > 0 && write.payloadBytes > 0,
        ]);
        const pending = native.uploadChunk(
          event,
          id,
          0,
          0,
          new Uint8Array(CHUNK).fill(0x73).buffer,
        );
        const held = await observed.checkpoints[0];
        await uploaded.opened.promise;
        const during = native.status(event, id);
        assert.equal(during.phase, "uploading");
        assert.equal(during.sent, held.write.payloadOffset);
        assert.ok(during.sent > 0 && during.sent < CHUNK);
        if (mode === "cancel") native.cancel(event, id);
        else earlyResponse.resolve();
        rejected(
          await pending,
          mode === "cancel" ? /Upload cancelled/ : /HTTP 500/,
        );
        await uploaded.closed.promise;
        assert.equal((await uploaded.disconnected.promise).complete, false);
        if (mode === "cancel") await uploaded.interrupted.promise;
        const terminal = native.status(event, id);
        assert.equal(
          terminal.phase,
          mode === "cancel" ? "cancelled" : "failed",
        );
        assert.equal(terminal.sent, during.sent);
        assert.deepEqual(terminal.urls, []);
        const writeCount = observed.samples.length;
        held.resume();
        await nextTurn();
        assert.deepEqual(
          native.status(event, id),
          terminal,
          "A late successful write callback cannot change terminal progress",
        );
        assert.equal(
          observed.samples.length,
          writeCount,
          "No writes after termination",
        );
        assert.equal(state.requests.length, requestStart + 1);
        dismiss(event, id);
      }
    },
  );

  await run(
    "pending polling: unrelated COMPLETE and absent worker record cannot publish a URL; metadata.file.id completes",
    async () => {
      const event = owner();
      const id = await start(event);
      plan("/api/upload", {
        json: fileReply("pending-file", { pending: true }),
      });
      const wrong = plan("/api/user/files/incomplete", {
        json: [
          {
            id: "pending-file",
            status: "COMPLETE",
            metadata: { file: { id: "somebody-else" } },
          },
        ],
      });
      plan("/api/user/files/incomplete", { json: [] });
      plan("/api/user/files/incomplete", {
        json: [
          {
            id: "worker-not-file-id",
            status: "COMPLETE",
            metadata: { file: { id: "pending-file" } },
          },
        ],
      });
      const firstDelay = deferred();
      state.delayGate = firstDelay;
      const pending = native.uploadChunk(event, id, 0, 0, smallBytes);
      await wrong.arrived.promise;
      assert.equal((await firstDelay.promise).ms, 2000);
      assert.equal(native.status(event, id).phase, "processing");
      assert.deepEqual(native.status(event, id).urls, []);
      rejected(
        await native.uploadChunk(event, id, 0, 0, smallBytes),
        /already being processed/,
      );
      assert.equal(ok(await pending).done, true);
      assert.deepEqual(native.status(event, id).urls, [
        `${ORIGIN}/u/pending-file`,
      ]);
      dismiss(event, id);
    },
  );

  await run(
    "later failure retains earlier confirmed URL and redacts server body/token/path details",
    async () => {
      const event = owner();
      const id = await start(event, [
        { name: "first", size: 4 },
        { name: "later", size: 4 },
      ]);
      plan("/api/upload", { json: fileReply("keep-this") });
      assert.equal(
        ok(await native.uploadChunk(event, id, 0, 0, smallBytes)).done,
        false,
      );
      plan("/api/upload", {
        status: 500,
        raw: JSON.stringify({
          error: apiToken,
          path: "/private/fixture-server-path",
          stack: "sensitive-server-stack",
        }),
      });
      const error = rejected(
        await native.uploadChunk(event, id, 1, 0, smallBytes),
        /HTTP 500/,
      );
      assert.equal(error.includes("private"), false);
      assert.equal(error.includes("sensitive-server-stack"), false);
      const result = native.status(event, id);
      assert.equal(result.phase, "failed");
      assert.deepEqual(result.urls, [`${ORIGIN}/u/keep-this`]);
      assert.equal(result.error, error);
      dismiss(event, id);
    },
  );

  await run(
    "cancellation: active processing timer aborts; stale cancel/dismiss cannot touch replacement job",
    async () => {
      const event = owner();
      const oldId = await start(event);
      plan("/api/upload", {
        json: fileReply("cancel-pending", { pending: true }),
      });
      plan("/api/user/files/incomplete", { json: [] });
      const delay = deferred();
      state.delayGate = delay;
      const pending = native.uploadChunk(event, oldId, 0, 0, smallBytes);
      const waiting = await delay.promise;
      assert.equal(waiting.ms, 2000);
      const before = state.requests.length;
      native.cancel(event, "stale-id");
      native.dismiss(event, "stale-id");
      assert.equal(native.status(event, oldId).phase, "processing");
      native.cancel(event, oldId);
      assert.equal(waiting.signal.aborted, true);
      rejected(await pending, /Upload cancelled/);
      assert.equal(state.requests.length, before);
      assert.deepEqual(native.status(event, oldId).urls, []);
      native.dismiss(event, "stale-id");
      assert.equal(native.status(event, oldId).phase, "cancelled");
      dismiss(event, oldId);
      const current = await start(event);
      assert.notEqual(current, oldId);
      native.cancel(event, oldId);
      native.dismiss(event, oldId);
      assert.equal(native.status(event, current).phase, "uploading");
      rejected(
        await native.uploadChunk(event, oldId, 0, 0, smallBytes),
        /no longer active/,
      );
      terminate(event, current);
    },
  );

  await run(
    "cancellation: active processing HTTP GET is aborted and publishes no pending URL",
    async () => {
      const event = owner();
      const id = await start(event);
      plan("/api/upload", { json: fileReply("cancel-get", { pending: true }) });
      const held = plan("/api/user/files/incomplete", { hold: true });
      const pending = native.uploadChunk(event, id, 0, 0, smallBytes);
      await held.arrived.promise;
      native.cancel(event, id);
      rejected(await pending, /Upload cancelled/);
      await held.closed.promise;
      assert.equal(native.status(event, id).phase, "cancelled");
      assert.deepEqual(native.status(event, id).urls, []);
      dismiss(event, id);
    },
  );

  await run(
    "document lifetime: SPA/subframe navigation preserved; main navigation/destroy/crash abort and detach",
    async () => {
      for (const reason of ["navigation", "destroyed", "render-process-gone"]) {
        const event = owner();
        const id = await start(event);
        const held = plan("/api/upload", { hold: true });
        const pending = native.uploadChunk(event, id, 0, 0, smallBytes);
        await held.arrived.promise;
        event.sender.emit(
          "did-start-navigation",
          {},
          "https://discord.com/channels/another",
          true,
          true,
        );
        event.sender.emit(
          "did-start-navigation",
          {},
          "https://discord.com/embedded",
          false,
          false,
        );
        assert.equal(native.status(event, id).phase, "uploading");
        if (reason === "navigation")
          event.sender.emit(
            "did-start-navigation",
            {},
            "https://discord.com/reload",
            false,
            true,
          );
        else {
          if (reason === "destroyed") event.sender.destroyed = true;
          event.sender.emit(reason);
        }
        rejected(await pending, /Upload cancelled/);
        await held.closed.promise;
        assert.equal(native.status(event, id), null);
        assert.equal(event.sender.listenerCount("destroyed"), 0);
        assert.equal(event.sender.listenerCount("render-process-gone"), 0);
        assert.equal(event.sender.listenerCount("did-start-navigation"), 0);
      }
    },
  );

  await run(
    "redirects: HTTP 302 is rejected without following Location or forwarding Authorization",
    async () => {
      const event = owner();
      const id = await start(event, undefined, ALTERNATE_ORIGIN);
      const before = state.requests.length;
      plan("/api/upload", {
        status: 302,
        headers: { location: "https://attacker.invalid/steal" },
        raw: apiToken,
      });
      rejected(
        await native.uploadChunk(event, id, 0, 0, smallBytes),
        /HTTP 302/,
      );
      assert.equal(state.requests.length, before + 1);
      assert.deepEqual(native.status(event, id).urls, []);
      dismiss(event, id);
    },
  );

  await run(
    "returned URLs: foreign origin, HTTP downgrade, userinfo and malformed URL are rejected",
    async () => {
      for (const [serverUrl, url] of [
        [ORIGIN, "https://attacker.invalid/a"],
        [ORIGIN, "http://shares.example.test/a"],
        [ORIGIN, "https://shares.example.test.attacker.invalid/a"],
        [ORIGIN, "https://user:secret@shares.example.test/a"],
        [ORIGIN, "not an absolute URL"],
        [ORIGIN, `${ALTERNATE_ORIGIN}/a`],
        [ALTERNATE_ORIGIN, `${ORIGIN}/a`],
        [ALTERNATE_ORIGIN, "https://zipline.example/a"],
        [ALTERNATE_ORIGIN, "https://zipline.example:8444/a"],
        [ALTERNATE_ORIGIN, "https://user:secret@zipline.example:8443/a"],
      ]) {
        const event = owner();
        const id = await start(event, undefined, serverUrl);
        plan("/api/upload", { json: { files: [{ id: "bad-url", url }] } });
        rejected(
          await native.uploadChunk(event, id, 0, 0, smallBytes),
          /outside the configured server|invalid uploaded file URL/,
        );
        assert.equal(native.status(event, id).phase, "failed");
        assert.deepEqual(native.status(event, id).urls, []);
        dismiss(event, id);
      }
    },
  );

  await run(
    "sanitized failures: invalid JSON, socket failure and pending worker FAILED expose no untrusted data",
    async () => {
      for (const mode of ["json", "socket", "worker"]) {
        const event = owner();
        const id = await start(event);
        if (mode === "json")
          plan("/api/upload", { raw: "NOT JSON " + apiToken });
        if (mode === "socket") plan("/api/upload", { destroy: true });
        if (mode === "worker") {
          plan("/api/upload", {
            json: fileReply("failed-worker", { pending: true }),
          });
          plan("/api/user/files/incomplete", {
            json: [
              {
                status: "FAILED",
                metadata: { file: { id: "failed-worker" } },
                error: apiToken,
              },
            ],
          });
        }
        const error = rejected(
          await native.uploadChunk(event, id, 0, 0, smallBytes),
          /invalid response|Check the connection|could not finish storing/,
        );
        assert.equal(error.includes("127.0.0.1"), false);
        assert.equal(error.includes("ECONNRESET"), false);
        assert.equal(native.status(event, id).phase, "failed");
        assert.deepEqual(native.status(event, id).urls, []);
        dismiss(event, id);
      }
    },
  );

  await run(
    "completed links require explicit insertion and can be inserted again before the next selection",
    async () => {
      const event = owner();
      const stopped = Promise.withResolvers();
      const initialDraft = "Keep this unsent draft.";
      let draft = initialDraft;
      let insertions = 0;
      let consent = true;
      const flow = new AttachmentFlow({
        native: {
          beginUpload: (...args) => native.beginUpload(event, ...args),
          uploadChunk: (...args) => native.uploadChunk(event, ...args),
          status: (id) => native.status(event, id),
          cancel: (id) => native.cancel(event, id),
          dismiss: (id) => native.dismiss(event, id),
        },
        userId: () => "fixture-user",
        serverUrl: () => ORIGIN,
        apiToken: () => apiToken,
        confirm: async () => consent,
        append: (_batch, text) => {
          insertions++;
          draft += text;
        },
        changed: () => {
          if (
            flow.batch &&
            !flow.batch.running &&
            flow.batch.phase !== "confirming"
          )
            stopped.resolve();
        },
        show() {},
      });
      const context = {
        channel: { id: "channel" },
        draftType: 0,
        requireConfirm: true,
        isThumbnail: false,
      };
      plan("/api/upload", { json: fileReply("repeat-ordinary") });
      plan("/api/upload", { json: fileReply("repeat-spoiler") });
      const ordinary = { file: new File(["small"], "ordinary.txt") };
      const uploaded = [
        { file: new File(["first"], "large.bin") },
        { file: new File(["second"], "SPOILER_large.bin") },
      ];
      assert.deepEqual(
        await flow.preflight(
          [ordinary, ...uploaded],
          context,
          (file) => file !== ordinary.file,
        ),
        [ordinary],
      );
      await stopped.promise;
      assert.equal(flow.batch.phase, "complete");
      assert.deepEqual(flow.batch.state.urls, [
        `${ORIGIN}/u/repeat-ordinary`,
        `${ORIGIN}/u/repeat-spoiler`,
      ]);
      await flow.refresh();
      assert.equal(insertions, 0);
      assert.equal(draft, initialDraft);
      const links = `\n${ORIGIN}/u/repeat-ordinary\n||${ORIGIN}/u/repeat-spoiler||\n`;
      flow.insert();
      assert.equal(draft, initialDraft + links);
      assert.equal(insertions, 1);
      await flow.refresh();
      assert.equal(insertions, 1);
      draft += "Text typed between clicks.";
      flow.insert();
      assert.equal(
        draft,
        initialDraft + links + "Text typed between clicks." + links,
      );
      assert.equal(insertions, 2);
      assert.equal(flow.batch.phase, "complete");
      const previousJob = flow.batch.jobId;
      consent = false;
      assert.deepEqual(await flow.preflight(uploaded, context, () => true), []);
      assert.equal(native.status(event, previousJob), null);
      assert.equal(flow.batch, undefined);
      assert.equal(insertions, 2);
    },
  );

  await run(
    "explicit insertion preserves account, running, refusal and ambiguous-mutation guards",
    async () => {
      let userId = "fixture-user";
      let draft = "Original draft";
      let rejection;
      let ambiguous = false;
      let insertions = 0;
      const flow = new AttachmentFlow({
        native: {},
        userId: () => userId,
        append: (_batch, text) => {
          if (rejection) return rejection;
          insertions++;
          draft += text;
          if (ambiguous) throw new Error("Editor failed after mutation");
        },
        changed() {},
        show() {},
      });
      flow.batch = {
        userId,
        channelId: "original-channel",
        files: [{ file: new File(["fixture"], "fixture.bin"), spoiler: true }],
        phase: "failed",
        state: { urls: [`${ORIGIN}/u/partial-success`] },
        inserted: 0,
        insertionNotice: "",
        running: true,
      };
      flow.insert();
      assert.equal(insertions, 0);
      flow.batch.running = false;
      userId = "another-user";
      flow.insert();
      assert.equal(insertions, 0);
      userId = "fixture-user";
      rejection = "The original draft is unavailable";
      flow.insert();
      assert.equal(draft, "Original draft");
      assert.equal(flow.batch.insertionNotice, rejection);
      rejection = undefined;
      const links = `\n||${ORIGIN}/u/partial-success||\n`;
      flow.insert();
      assert.equal(draft, "Original draft" + links);
      assert.equal(insertions, 1);
      assert.equal(flow.batch.insertionNotice, "");
      userId = "another-user";
      flow.insert();
      assert.equal(insertions, 1);
      userId = "fixture-user";
      ambiguous = true;
      flow.insert();
      assert.equal(draft, "Original draft" + links + links);
      assert.equal(insertions, 2);
      assert.equal(flow.batch.insertionUncertain, true);
      flow.insert();
      assert.equal(insertions, 2);
      assert.equal(draft, "Original draft" + links + links);
      const uncertainBatch = flow.batch;
      uncertainBatch.phase = "complete";
      const nextFiles = [{ file: new File(["next"], "next.bin") }];
      assert.deepEqual(
        await flow.preflight(
          nextFiles,
          {
            channel: { id: "original-channel" },
            draftType: 0,
            requireConfirm: true,
            isThumbnail: false,
          },
          () => true,
        ),
        nextFiles,
      );
      assert.equal(flow.batch, uncertainBatch);
      assert.equal(insertions, 2);
    },
  );

  await run(
    "stale native helper cannot ignore the supplied API token",
    async () => {
      const stopped = Promise.withResolvers();
      let sentChunks = 0;
      let cancelled;
      const flow = new AttachmentFlow({
        native: {
          // An older helper can acknowledge the origin but ignore the token.
          beginUpload: async () => ({
            ok: true,
            value: {
              jobId: "old-native-job",
              chunkSize: CHUNK,
              origin: ALTERNATE_ORIGIN,
            },
          }),
          uploadChunk: async () => {
            sentChunks++;
          },
          cancel: async (jobId) => {
            cancelled = jobId;
          },
          status: async () => ({
            jobId: "old-native-job",
            phase: "cancelled",
            urls: [],
          }),
        },
        userId: () => "fixture-user",
        serverUrl: () => ALTERNATE_ORIGIN,
        apiToken: () => apiToken,
        confirm: async () => true,
        append: () => {
          assert.fail("A rejected destination must not alter the draft");
        },
        changed: () => {
          if (flow.batch?.phase === "failed" && !flow.batch.running)
            stopped.resolve();
        },
        show() {},
      });
      await flow.preflight(
        [{ file: new File(["disposable"], "attachment.bin") }],
        {
          channel: { id: "channel" },
          draftType: 0,
          requireConfirm: true,
          isThumbnail: false,
        },
        () => true,
      );
      await stopped.promise;
      assert.equal(sentChunks, 0);
      assert.equal(cancelled, "old-native-job");
      assert.match(flow.batch.error, /Fully quit Vesktop/);
    },
  );

  assert.deepEqual(serverErrors, []);
  assert.equal(queue.length, 0);
  assert.ok(
    state.requests.every((request) =>
      [ORIGIN, ALTERNATE_ORIGIN].includes(request.origin),
    ),
  );
  console.log(
    `EVIDENCE ${JSON.stringify({ cases: completedCases.length, loopbackRequests: received.length, multipartPayloadBytes: received.reduce((sum, item) => sum + item.body.dataLength, 0), inclusiveLargeRanges: received.filter((item) => item.headers["content-range"]).map((item) => item.headers["content-range"]), actualPollingDelayMs: [...new Set(state.delays)], sourceImplementationCopied: false, externalRequests: 0 })}`,
  );
  console.log("PASS ALL native fixture behavior proofs");
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  for (const event of owners) event.sender.emit("render-process-gone");
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(runtime, { recursive: true, force: true });
}
