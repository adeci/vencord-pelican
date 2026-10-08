import type { ChunkAck, NativeResult, StartReply, UploadState } from "./types";

export interface PreparedAttachment {
  file: File;
  spoiler?: boolean;
  [key: string]: unknown;
}
export interface PreflightContext {
  channel: { id: string };
  draftType: number;
  requireConfirm: boolean;
  isThumbnail: boolean;
}
interface NativePort {
  beginUpload(
    files: { name: string; size: number }[],
    serverUrl: string,
    apiToken: string,
  ): Promise<NativeResult<StartReply>>;
  uploadChunk(
    jobId: string,
    index: number,
    offset: number,
    bytes: ArrayBuffer,
  ): Promise<NativeResult<ChunkAck>>;
  status(jobId: string): Promise<UploadState | null>;
  cancel(jobId: string): Promise<void>;
  dismiss(jobId: string): Promise<void>;
}
export interface Batch {
  userId: string;
  channelId: string;
  serverUrl: string;
  apiToken: string;
  files: PreparedAttachment[];
  phase:
    | "confirming"
    | "starting"
    | "uploading"
    | "complete"
    | "cancelled"
    | "failed";
  jobId?: string;
  state?: UploadState;
  inserted: number;
  error: string;
  insertionNotice: string;
  insertionUncertain?: boolean;
  cancelRequested: boolean;
  running: boolean;
}
interface Ports {
  native: NativePort;
  userId(): string | undefined;
  serverUrl(): string;
  apiToken(): string;
  confirm(batch: Batch): Promise<boolean>;
  append(batch: Batch, text: string): string | undefined;
  changed(): void;
  show(): void;
}

export class AttachmentFlow {
  batch?: Batch;
  constructor(private readonly ports: Ports) {}

  async preflight(
    files: PreparedAttachment[],
    context: PreflightContext,
    exceeds: (file: File) => boolean,
  ) {
    if (
      context.draftType !== 0 ||
      context.isThumbnail ||
      !context.requireConfirm
    )
      return files;
    const oversized = files.filter((item) => exceeds(item.file));
    if (!oversized.length) return files;
    const userId = this.ports.userId();
    if (!userId) return files;
    // A completed batch whose links are already in the draft must not force a
    // manual dismissal before the next normal attachment selection.
    if (
      this.batch?.phase === "complete" &&
      !this.batch.running &&
      !this.batch.insertionUncertain &&
      this.batch.inserted === this.batch.state?.urls.length
    )
      await this.dismiss();
    // A second selection stays on Discord's original path instead of replacing
    // the first batch or silently discarding either selection.
    if (this.batch) {
      this.batch.error =
        "An upload is still open. Add its links or choose Clear upload before selecting more files.";
      this.ports.changed();
      this.ports.show();
      return files;
    }
    const batch: Batch = (this.batch = {
      userId,
      channelId: context.channel.id,
      serverUrl: this.ports.serverUrl(),
      apiToken: this.ports.apiToken(),
      files: oversized,
      phase: "confirming",
      inserted: 0,
      error: "",
      insertionNotice: "",
      cancelRequested: false,
      running: false,
    });
    this.ports.changed();
    if (!batch.serverUrl) {
      batch.phase = "failed";
      batch.error =
        "Configure your Zipline server's HTTPS origin in Pelican's plugin settings before uploading. No files were uploaded.";
      this.ports.changed();
      this.ports.show();
      return files;
    }
    let consent: boolean;
    try {
      consent = await this.ports.confirm(batch);
    } catch {
      batch.phase = "failed";
      batch.error =
        "Could not open confirmation. Clear this upload and select the files again.";
      this.ports.changed();
      return files;
    }
    if (this.ports.userId() !== userId) {
      batch.phase = "cancelled";
      batch.error =
        "The Discord account changed. Nothing was uploaded. Return to the original account and select the files again.";
      this.ports.changed();
      // Do not add even ordinary files to a different account's attachment store.
      return [];
    }
    if (consent && !batch.cancelRequested) {
      batch.phase = "starting";
      batch.running = true;
      void this.upload(batch);
    } else {
      this.batch = undefined;
    }
    this.ports.changed();
    const selected = new Set(oversized);
    // Keep Discord's already-compressed objects, including every metadata field.
    return files.filter((item) => !selected.has(item));
  }

  async refresh(batch = this.batch) {
    if (!batch?.jobId) return;
    const state = await this.ports.native.status(batch.jobId);
    if (!state || state.jobId !== batch.jobId)
      throw new Error(
        "Pelican lost this upload's native status. Restart Vesktop and check the Zipline dashboard before selecting the files again.",
      );
    // Progress polling can overlap the queue's acknowledgement refresh. Never
    // replace completed URLs with an older IPC snapshot.
    if (batch.state && state.urls.length < batch.state.urls.length) return;
    batch.state = state;
    this.ports.changed();
  }

  insert(batch = this.batch) {
    if (
      !batch?.state ||
      batch.running ||
      !batch.state.urls.length ||
      batch.insertionUncertain
    )
      return;
    if (this.ports.userId() !== batch.userId) {
      batch.insertionNotice =
        "Return to the original account and channel, then choose Add to message.";
      this.ports.changed();
      return;
    }
    const urls = batch.state.urls.map((url, index) => {
      const file = batch.files[index];
      return file?.spoiler || file?.file.name.startsWith("SPOILER_")
        ? `||${url}||`
        : url;
    });
    try {
      const reason = this.ports.append(batch, `\n${urls.join("\n")}\n`);
      if (reason) batch.insertionNotice = reason;
      else {
        batch.inserted = batch.state.urls.length;
        batch.insertionNotice = "";
      }
    } catch {
      // An editor mutation may have partially succeeded; do not duplicate it.
      batch.insertionUncertain = true;
      batch.insertionNotice =
        "Could not finish adding links. Check your draft, then copy any missing links below.";
    }
    this.ports.changed();
  }

  private async upload(batch: Batch) {
    try {
      const result = await this.ports.native.beginUpload(
        batch.files.map(({ file }) => ({ name: file.name, size: file.size })),
        batch.serverUrl,
        batch.apiToken,
      );
      if (!result.ok) throw new Error(result.error);
      batch.jobId = result.value.jobId;
      // A partial reload must not let an old helper ignore the supplied token.
      if (
        result.value.protocolVersion !== 2 ||
        result.value.origin !== new URL(batch.serverUrl).origin
      )
        throw new Error(
          "Pelican's native helper is outdated or did not confirm the configured server. Fully quit Vesktop, including its tray process, then reopen it.",
        );
      const chunkSize = result.value.chunkSize;
      if (
        !batch.jobId ||
        !Number.isSafeInteger(chunkSize) ||
        chunkSize < 1 ||
        chunkSize > 16 * 1024 * 1024
      )
        throw new Error(
          "Pelican returned an invalid upload session. Restart Vesktop before trying again.",
        );
      if (batch.cancelRequested) {
        await this.ports.native.cancel(batch.jobId);
        return;
      }
      batch.phase = "uploading";
      this.ports.changed();
      for (let index = 0; index < batch.files.length; index++) {
        const file = batch.files[index].file;
        for (let offset = 0; offset < file.size; ) {
          if (batch.cancelRequested) return;
          if (this.ports.userId() !== batch.userId)
            throw new Error(
              "The Discord account changed. Upload stopped; completed links remain available to the original account.",
            );
          const end = Math.min(offset + chunkSize, file.size);
          // Only one slice and one IPC request are in flight. Never buffer a file.
          const bytes = await file.slice(offset, end).arrayBuffer();
          if (batch.cancelRequested) return;
          if (this.ports.userId() !== batch.userId)
            throw new Error(
              "The Discord account changed. Upload stopped; completed links remain available to the original account.",
            );
          const reply = await this.ports.native.uploadChunk(
            batch.jobId,
            index,
            offset,
            bytes,
          );
          if (!reply.ok) throw new Error(reply.error);
          const final = index === batch.files.length - 1 && end === file.size;
          if (
            reply.value.fileIndex !== index ||
            reply.value.nextOffset !== end ||
            reply.value.done !== final
          )
            throw new Error(
              "Pelican received an unexpected chunk acknowledgement. Upload stopped. Check the Zipline dashboard before trying again.",
            );
          offset = end;
          await this.refresh(batch);
        }
      }
      batch.phase = "complete";
    } catch (error) {
      batch.phase = batch.cancelRequested ? "cancelled" : "failed";
      batch.error =
        error instanceof Error
          ? error.message
          : "Pelican's native uploader is unavailable. Restart the packaged Vesktop and check the Zipline dashboard before trying again.";
      if (batch.jobId) {
        try {
          await this.ports.native.cancel(batch.jobId);
          await this.refresh(batch);
        } catch {
          batch.error +=
            " Native cleanup/status could not be confirmed; check the Zipline dashboard.";
        }
      }
    } finally {
      if (batch.cancelRequested) batch.phase = "cancelled";
      batch.running = false;
      this.ports.changed();
    }
  }

  async cancel() {
    const batch = this.batch;
    if (!batch) return;
    batch.cancelRequested = true;
    batch.phase = "cancelled";
    try {
      if (batch.jobId) {
        await this.ports.native.cancel(batch.jobId);
        await this.refresh(batch);
      }
    } catch {
      batch.error =
        "Could not confirm cancellation with the native uploader. Check the Zipline dashboard. Completed links shown here have been kept.";
    }
    this.ports.changed();
  }

  async dismiss() {
    const batch = this.batch;
    if (!batch || batch.running || batch.phase === "confirming") return;
    try {
      if (batch.jobId) await this.ports.native.dismiss(batch.jobId);
      if (this.batch === batch) this.batch = undefined;
    } catch {
      batch.error =
        "Could not dismiss the native upload session. Restart Vesktop before starting another batch.";
    }
    this.ports.changed();
  }
}
