export interface AttachmentDescriptor {
  name: string;
  size: number;
}

export type NativeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface StartReply {
  jobId: string;
  chunkSize: number;
  origin: string;
  protocolVersion: 2;
}

export interface ChunkAck {
  // The acknowledged file, not the index of the next file in the batch.
  fileIndex: number;
  nextOffset: number;
  // True only after every file's URL is validated and processing has completed.
  done: boolean;
}

export interface UploadState {
  jobId: string;
  phase: "uploading" | "processing" | "complete" | "cancelled" | "failed";
  file: string;
  index: number;
  count: number;
  sent: number;
  size: number;
  urls: string[];
  error?: string;
}
