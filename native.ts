// Original Pelican implementation. Protocol: diced/zipline v4.8.0,
// src/server/routes/api/upload/partial.ts and api/user/files/incomplete.ts.
import type { IpcMainInvokeEvent } from "electron";
import { randomBytes } from "node:crypto";
import { type ClientRequest, validateHeaderValue } from "node:http";
import { request } from "node:https";
import { setTimeout as delay } from "node:timers/promises";

import type {
  AttachmentDescriptor,
  ChunkAck,
  NativeResult,
  StartReply,
  UploadState,
} from "./types";

const CHUNK_SIZE = 16 * 1024 * 1024;
const WRITE_SIZE = 64 * 1024;
const EMPTY_CHUNK = new ArrayBuffer(0);
const jobs = new Map<number, Job>();

type Endpoint =
  | "/api/upload"
  | "/api/upload/partial"
  | "/api/user/files/incomplete";
interface Job {
  controller: AbortController;
  origin: string;
  state: UploadState;
  files: AttachmentDescriptor[];
  token?: string;
  partialToken?: string;
  fileIndex: number;
  nextOffset: number;
  busy: boolean;
  detach: () => void;
}
interface UploadResponse {
  partialSuccess?: boolean;
  partialToken?: string;
  files?: { id: string; url: string; pending?: boolean }[];
}
interface MultipartBody {
  prefix: Buffer;
  bytes: Buffer;
  suffix: Buffer;
  length: number;
  boundary: string;
  headers: Record<string, string>;
}
class UploadError extends Error {}

function owner(event: IpcMainInvokeEvent) {
  // Only bytes already readable by the Discord main frame cross this boundary.
  const frame = event.senderFrame;
  if (
    event.sender.isDestroyed() ||
    !frame ||
    frame !== event.sender.mainFrame ||
    !/^https:\/\/(?:discord\.com|canary\.discord\.com|ptb\.discord\.com)(?:\/|$)/.test(
      frame.url,
    )
  )
    throw new UploadError(
      "Pelican is only available in the Discord main window.",
    );
  return event.sender.id;
}

function message(error: unknown) {
  return error instanceof UploadError
    ? error.message
    : "Upload failed. Check the connection and Zipline dashboard.";
}

function uploadToken(input: unknown): string {
  const error = "Enter a valid Zipline API token in Pelican settings.";
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > 64 * 1024)
    throw new UploadError(error);
  const token = input.trim();
  if (!token || /[\r\n]/.test(token)) throw new UploadError(error);
  try {
    validateHeaderValue("Authorization", token);
  } catch {
    throw new UploadError(error);
  }
  return token;
}

function serverOrigin(serverUrl: string): string {
  try {
    // Inspect the supplied syntax too: URL parsing normalizes dot paths and
    // silently accepts empty query/fragment markers and some malformed slashes.
    if (
      typeof serverUrl !== "string" ||
      serverUrl !== serverUrl.trim() ||
      !/^https:\/\/[^/?#@\\\s]+\/?$/i.test(serverUrl)
    )
      throw new Error();
    const url = new URL(serverUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new UploadError(
      "Configure an HTTPS Zipline origin in Pelican settings, without credentials, a path, query or fragment.",
    );
  }
}

function terminal(job: Job) {
  return (
    job.state.phase === "complete" ||
    job.state.phase === "cancelled" ||
    job.state.phase === "failed"
  );
}

function release(job: Job) {
  job.token = undefined;
  job.partialToken = undefined;
  job.files = [];
  job.busy = false;
}

function failed(job: Job, error: unknown) {
  if (job.controller.signal.aborted) job.state.phase = "cancelled";
  else {
    job.state.phase = "failed";
    job.state.error = message(error);
  }
  job.controller.abort();
  release(job);
}

function remove(id: number, job: Job) {
  if (jobs.get(id) !== job) return;
  if (!terminal(job)) {
    job.state.phase = "cancelled";
    job.controller.abort();
    release(job);
  }
  job.detach();
  jobs.delete(id);
}

function track(event: IpcMainInvokeEvent, id: number, job: Job) {
  const sender = event.sender;
  const abandon = () => remove(id, job);
  const navigation = (
    _event: Electron.Event,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    // Discord's client-side channel changes do not replace the owning document.
    if (isMainFrame && !isInPlace) abandon();
  };
  sender.on("destroyed", abandon);
  sender.on("render-process-gone", abandon);
  sender.on("did-start-navigation", navigation);
  job.detach = () => {
    sender.removeListener("destroyed", abandon);
    sender.removeListener("render-process-gone", abandon);
    sender.removeListener("did-start-navigation", navigation);
  };
}

async function writeMultipart(
  req: ClientRequest,
  job: Job,
  body: MultipartBody,
) {
  const start = job.nextOffset;
  const size = job.state.size;
  for (const part of [body.prefix, body.bytes, body.suffix]) {
    for (let offset = 0; offset < part.length; ) {
      if (req.destroyed || job.controller.signal.aborted || terminal(job))
        return;
      const end = Math.min(offset + WRITE_SIZE, part.length);
      // Await the actual write callback, not just buffer availability. Keeping
      // one bounded write in flight also respects transport backpressure.
      await new Promise<void>((resolve, reject) => {
        req.write(part.subarray(offset, end), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      if (req.destroyed || job.controller.signal.aborted || terminal(job))
        return;
      // Only payload bytes count; transport completion is not a server ACK.
      if (part === body.bytes) job.state.sent = Math.min(size, start + end);
      offset = end;
    }
  }
  req.end();
}

async function jsonRequest<T>(
  endpoint: Endpoint,
  job: Job,
  body?: MultipartBody,
): Promise<T> {
  job.controller.signal.throwIfAborted();
  // Node HTTPS neither follows redirects nor uses renderer cookies/proxies.
  // Authorization can therefore never follow a server-provided destination.
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const req = request(
    `${job.origin}${endpoint}`,
    {
      method: body ? "POST" : "GET",
      signal: job.controller.signal,
      headers: {
        Authorization: job.token!,
        Accept: "application/json",
        ...(body && {
          "Content-Type": `multipart/form-data; boundary=${body.boundary}`,
          "Content-Length": String(body.length),
          ...body.headers,
        }),
      },
    },
    (response) => {
      response.on("error", reject);
      // Stop rejected uploads immediately; their response bodies are not used.
      if (response.statusCode !== 200) {
        const error = new UploadError(
          `Zipline rejected the request (HTTP ${response.statusCode}). Check the token, quota and server limits.`,
        );
        req.destroy(error);
        reject(error);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          req.destroy(
            new UploadError("Zipline returned an oversized response."),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new UploadError("Zipline returned an invalid response."));
        }
      });
    },
  );
  req.setTimeout(120_000, () =>
    req.destroy(new UploadError("Zipline stopped responding.")),
  );
  req.on("error", reject);
  if (body) void writeMultipart(req, job, body).catch(reject);
  else req.end();
  try {
    return await promise;
  } finally {
    req.destroy();
  }
}

function uploadPart(job: Job, bytes: Buffer): Promise<UploadResponse> {
  const { name, size } = job.files[job.fileIndex];
  const start = job.nextOffset;
  const partial = size > CHUNK_SIZE;
  const end = start + bytes.length - 1;
  const boundary = `pelican-${randomBytes(18).toString("hex")}`;
  const safeName = name.replace(/[\r\n"\\]/g, "_");
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return jsonRequest(partial ? "/api/upload/partial" : "/api/upload", job, {
    // Multipart framing and payload use separate, zero-copy transport writes.
    prefix,
    bytes,
    suffix,
    boundary,
    length: prefix.length + bytes.length + suffix.length,
    headers: partial
      ? {
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "x-zipline-p-filename": encodeURIComponent(name),
          "x-zipline-p-content-type": "application/octet-stream",
          "x-zipline-p-content-length": String(size),
          "x-zipline-p-lastchunk": String(end === size - 1),
          ...(job.partialToken && { "x-zipline-p-token": job.partialToken }),
        }
      : {},
  });
}

async function waitUntilComplete(id: string, job: Job) {
  job.state.phase = "processing";
  const deadline = Date.now() + 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const records = await jsonRequest<unknown>(
      "/api/user/files/incomplete",
      job,
    );
    job.controller.signal.throwIfAborted();
    if (!Array.isArray(records))
      throw new UploadError("Zipline returned invalid processing status.");
    // The worker creates its record asynchronously. Absence is NOT success.
    const record = records.find((r) => r?.metadata?.file?.id === id);
    if (record?.status === "COMPLETE") return;
    if (record?.status === "FAILED")
      throw new UploadError("Zipline could not finish storing this file.");
    await delay(2000, undefined, { signal: job.controller.signal });
  }
  throw new UploadError(
    "Zipline processing timed out. Check the dashboard before uploading again.",
  );
}

export async function beginUpload(
  event: IpcMainInvokeEvent,
  files: AttachmentDescriptor[],
  serverUrl: string,
  apiToken: string,
): Promise<NativeResult<StartReply>> {
  let job: Job | undefined;
  try {
    const id = owner(event);
    if (jobs.has(id))
      throw new UploadError("An upload is already open in this window.");
    const origin = serverOrigin(serverUrl);
    const token = uploadToken(apiToken);
    if (
      !Array.isArray(files) ||
      !files.length ||
      files.some(
        (file) =>
          !file ||
          typeof file.name !== "string" ||
          !file.name ||
          !Number.isSafeInteger(file.size) ||
          file.size < 0,
      )
    )
      throw new UploadError("Invalid attachment metadata.");
    const descriptors = files.map(({ name, size }) => ({ name, size }));
    const jobId = randomBytes(24).toString("hex");
    job = {
      controller: new AbortController(),
      origin,
      token,
      files: descriptors,
      fileIndex: 0,
      nextOffset: 0,
      busy: false,
      detach: () => {},
      state: {
        jobId,
        phase: "uploading",
        file: descriptors[0].name,
        index: 1,
        count: descriptors.length,
        sent: 0,
        size: descriptors[0].size,
        urls: [],
      },
    };
    jobs.set(id, job);
    track(event, id, job);
    return {
      ok: true,
      value: { jobId, chunkSize: CHUNK_SIZE, origin, protocolVersion: 2 },
    };
  } catch (error) {
    if (job) {
      failed(job, error);
      // A failed begin never returned a job ID for the renderer to dismiss.
      remove(event.sender.id, job);
    }
    return {
      ok: false,
      error:
        job?.state.phase === "cancelled" ? "Upload cancelled." : message(error),
    };
  }
}

export async function uploadChunk(
  event: IpcMainInvokeEvent,
  jobId: string,
  fileIndex: number,
  offset: number,
  bytes: ArrayBuffer,
): Promise<NativeResult<ChunkAck>> {
  let active: Job | undefined;
  try {
    const job = jobs.get(owner(event));
    if (!job || job.state.jobId !== jobId || terminal(job))
      throw new UploadError("This upload is no longer active.");
    if (job.busy)
      throw new UploadError("An upload chunk is already being processed.");
    const file = job.files[job.fileIndex];
    const length = Math.min(CHUNK_SIZE, file.size - job.nextOffset);
    if (
      fileIndex !== job.fileIndex ||
      offset !== job.nextOffset ||
      !(bytes instanceof ArrayBuffer) ||
      bytes.byteLength !== length
    )
      throw new UploadError("Invalid upload chunk or sequence.");
    job.busy = true;
    active = job;
    const pending = uploadPart(job, Buffer.from(bytes));
    // Keep no renderer chunk reference while waiting for server processing.
    bytes = EMPTY_CHUNK;
    const response = await pending;
    job.controller.signal.throwIfAborted();
    const nextOffset = offset + length;
    if (file.size > CHUNK_SIZE) {
      if (response?.partialSuccess !== true)
        throw new UploadError("Zipline did not accept the chunk.");
      job.partialToken = response.partialToken;
      if (
        nextOffset < file.size &&
        (typeof job.partialToken !== "string" ||
          !job.partialToken ||
          /[\r\n]/.test(job.partialToken))
      )
        throw new UploadError("Zipline did not return the next chunk token.");
    }
    job.nextOffset = nextOffset;
    job.state.sent = nextOffset;
    if (nextOffset === file.size) {
      const uploaded = response?.files?.[0];
      if (
        !uploaded ||
        typeof uploaded.id !== "string" ||
        !uploaded.id ||
        typeof uploaded.url !== "string"
      )
        throw new UploadError("Zipline did not return an uploaded file.");
      let url: URL;
      try {
        url = new URL(uploaded.url);
      } catch {
        throw new UploadError("Zipline returned an invalid uploaded file URL.");
      }
      if (url.origin !== job.origin || url.username || url.password)
        throw new UploadError(
          "Zipline returned a URL outside the configured server. Check the server configuration.",
        );
      if (file.size > CHUNK_SIZE || uploaded.pending)
        await waitUntilComplete(uploaded.id, job);
      job.controller.signal.throwIfAborted();
      job.state.urls.push(url.href);
      job.fileIndex++;
      job.nextOffset = 0;
      job.partialToken = undefined;
      if (job.fileIndex === job.files.length) {
        job.state.phase = "complete";
        release(job);
      } else {
        const next = job.files[job.fileIndex];
        Object.assign(job.state, {
          phase: "uploading",
          file: next.name,
          index: job.fileIndex + 1,
          sent: 0,
          size: next.size,
        });
      }
    }
    return {
      ok: true,
      value: { fileIndex, nextOffset, done: job.state.phase === "complete" },
    };
  } catch (error) {
    if (active) failed(active, error);
    return {
      ok: false,
      error:
        active?.state.phase === "cancelled"
          ? "Upload cancelled."
          : message(error),
    };
  } finally {
    if (active) active.busy = false;
  }
}

export function status(
  event: IpcMainInvokeEvent,
  jobId: string,
): UploadState | null {
  try {
    const job = jobs.get(owner(event));
    return job?.state.jobId === jobId
      ? { ...job.state, urls: [...job.state.urls] }
      : null;
  } catch {
    return null;
  }
}

export function cancel(event: IpcMainInvokeEvent, jobId: string): void {
  try {
    const job = jobs.get(owner(event));
    if (job?.state.jobId !== jobId || terminal(job)) return;
    job.state.phase = "cancelled";
    job.controller.abort();
    release(job);
  } catch {
    // An unauthorized or destroyed renderer has no upload authority.
  }
}

export function dismiss(event: IpcMainInvokeEvent, jobId: string): void {
  try {
    const id = owner(event);
    const job = jobs.get(id);
    if (job?.state.jobId === jobId && terminal(job)) remove(id, job);
  } catch {
    // An unauthorized or destroyed renderer has no upload authority.
  }
}
