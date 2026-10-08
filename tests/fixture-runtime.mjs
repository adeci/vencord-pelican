import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { setTimeout as realDelay } from "node:timers/promises";
export const state = {
  port: undefined,
  allowedOrigins: [],
  delayGate: undefined,
  delays: [],
  requests: [],
  writeObserver: undefined,
};

export function configure({
  port,
  allowedOrigins = ["https://shares.example.test"],
}) {
  state.port = port;
  state.allowedOrigins = [...allowedOrigins];
}

export function deferred() {
  return Promise.withResolvers();
}

// Keep native's configured-origin validation unchanged. Only explicitly allowed
// fixture origins are mapped to this process's loopback server before any socket.
export function request(input, options, callback) {
  const url = new URL(input);
  assert.ok(
    state.allowedOrigins.includes(url.origin),
    "BLOCKED nonfixture native request",
  );
  assert.ok(
    [
      "/api/upload",
      "/api/upload/partial",
      "/api/user/files/incomplete",
    ].includes(url.pathname),
  );
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.ok(Number.isInteger(state.port));
  state.requests.push({
    origin: url.origin,
    path: url.pathname,
    method: options.method,
  });
  const req = httpRequest(
    new URL(url.pathname, `http://127.0.0.1:${state.port}`),
    options,
    callback,
  );
  const observer = state.writeObserver;
  state.writeObserver = undefined;
  if (observer) {
    const write = req.write;
    const boundary = /boundary=([^;]+)/.exec(
      req.getHeader("content-type") ?? "",
    )?.[1];
    assert.ok(boundary, "Write observation requires a multipart upload");
    const suffixLength = Buffer.byteLength(`\r\n--${boundary}--\r\n`);
    const payloadEnd = Number(req.getHeader("content-length")) - suffixLength;
    let header = Buffer.alloc(0);
    let payloadStart;
    let wireOffset = 0;
    let payloadOffset = 0;
    req.write = function (chunk, encoding, callback) {
      if (typeof encoding === "function") {
        callback = encoding;
        encoding = undefined;
      }
      const buffer =
        typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;
      if (payloadStart === undefined) {
        header = Buffer.concat([
          header,
          buffer.subarray(0, Math.max(0, 16384 - header.length)),
        ]);
        const end = header.indexOf("\r\n\r\n");
        assert.ok(end >= 0 || header.length < 16384);
        if (end >= 0) {
          payloadStart = end + 4;
          header = Buffer.alloc(0);
        }
      }
      const payloadBytes =
        payloadStart === undefined
          ? 0
          : Math.max(
              0,
              Math.min(wireOffset + buffer.length, payloadEnd) -
                Math.max(wireOffset, payloadStart),
            );
      const entry = {
        wireOffset,
        wireBytes: buffer.length,
        payloadOffset,
        payloadBytes,
      };
      wireOffset += buffer.length;
      payloadOffset += payloadBytes;
      return write.call(this, chunk, encoding, (error) => {
        if (error) {
          callback?.(error);
          return;
        }
        // The real socket write has completed. Tests may delay delivery of its
        // callback, never invent a successful write or bypass backpressure.
        let resumed = false;
        observer(entry, () => {
          assert.equal(resumed, false, "A write callback is delivered once");
          resumed = true;
          callback?.();
        });
      });
    };
  }
  return req;
}

// Observe entry into actual abortable 2000ms waits; do not accelerate them.
export function setTimeout(ms, value, options) {
  state.delays.push(ms);
  const gate = state.delayGate;
  if (gate) {
    state.delayGate = undefined;
    gate.resolve({ ms, signal: options?.signal });
  }
  return realDelay(ms, value, options);
}
