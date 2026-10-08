import { ChatBarButton } from "@api/ChatButtons";
import type { ChatBarButtonFactory } from "@api/ChatButtons";
import { Button } from "@components/Button";
import type { ReactNode } from "react";
import { copyToClipboard } from "@utils/clipboard";
import definePlugin from "@utils/types";
import type { IconComponent, PluginNative } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import {
  Forms,
  Modal,
  openModal,
  SelectedChannelStore,
  UserStore,
  useEffect,
  useState,
  useStateFromStores,
} from "@webpack/common";

import { AttachmentFlow } from "./attachmentFlow";
import type {
  Batch,
  PreparedAttachment,
  PreflightContext,
} from "./attachmentFlow";
import type * as NativeExports from "./native";
import { settings } from "./settings";

const Native = VencordNative.pluginHelpers.Pelican as PluginNative<
  typeof NativeExports
>;
// These are the same Slate lookup contracts used by Vencord's reviewDB editor.
const Transforms = findByPropsLazy("insertNodes", "textToText");
const Editor = findByPropsLazy("start", "end", "toSlateRange");
const ApplicationCommandStore = findStoreLazy("ApplicationCommandStore");
type Point = { path: number[]; offset: number };
interface SlateEditor {
  selection: { anchor: Point; focus: Point } | null;
  composition?: unknown;
}
interface ChannelEditor {
  props: {
    channel: { id: string };
    type: { drafts: { type: number } };
    disabled?: boolean;
    useSlate?: boolean;
  };
  state: { submitting?: boolean };
  getSlateEditor(): SlateEditor | null;
}
const editors = new Map<ChannelEditor, string | undefined>();
const listeners = new Set<() => void>();
let modalOpen = false;
let statusTimer: number | undefined;
let polling = false;

function changed() {
  for (const listener of listeners) listener();
}
function useBatch() {
  const [, render] = useState(0);
  useEffect(() => {
    const update = () => render((value) => value + 1);
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  const userId = useStateFromStores(
    [UserStore],
    () => UserStore.getCurrentUser()?.id,
  );
  return { batch: flow.batch, userId };
}

function appendToOriginalDraft(batch: Batch, text: string) {
  if (SelectedChannelStore.getChannelId() !== batch.channelId)
    return "Return to the original channel, then choose Add to message.";
  const matching = [...editors].filter(
    ([instance, userId]) =>
      userId === batch.userId &&
      instance.props.channel.id === batch.channelId &&
      instance.props.type.drafts.type === 0 &&
      !instance.props.disabled &&
      !instance.state.submitting &&
      instance.props.useSlate,
  );
  if (matching.length !== 1)
    return "Open the original channel's message box, then choose Add to message.";
  const editor = matching[0][0].getSlateEditor();
  if (
    !editor ||
    ApplicationCommandStore.getActiveCommand(batch.channelId) ||
    editor.composition
  )
    return "Finish typing or exit the slash command, then choose Add to message.";
  // Read the live mounted editor, never the throttled DraftStore. An explicit
  // end point appends without replacing a selected range or targeting a modal.
  // Inserting text at that point does not move any pre-existing document paths.
  const selection = editor.selection && {
    anchor: {
      path: [...editor.selection.anchor.path],
      offset: editor.selection.anchor.offset,
    },
    focus: {
      path: [...editor.selection.focus.path],
      offset: editor.selection.focus.offset,
    },
  };
  Editor.withoutNormalizing(editor, () => {
    Transforms.insertText(editor, text, { at: Editor.end(editor, []) });
    if (selection) Transforms.select(editor, selection);
  });
  return undefined;
}

function DialogActions({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        flexWrap: "wrap",
        gap: 8,
        marginTop: 8,
      }}
    >
      {children}
    </div>
  );
}

function Confirmation(
  props: RenderModalProps & { batch: Batch; settle(value: boolean): void },
) {
  useEffect(() => () => props.settle(false), []);
  return (
    <Modal
      {...props}
      title="Upload with Pelican?"
      onClose={() => {
        props.settle(false);
        props.onClose();
      }}
      size="md"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Forms.FormText>
          <span style={{ display: "block", overflowWrap: "anywhere" }}>
            Upload to {props.batch.serverUrl || "your Zipline server"}
          </span>
          <span style={{ color: "var(--text-muted)", fontSize: 14 }}>
            Anyone with the link can view.
          </span>
        </Forms.FormText>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {props.batch.files.map(({ file }, index) => (
            <Forms.FormText key={index}>
              <span
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 16,
                }}
              >
                <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>
                  {file.name}
                </span>
                <span
                  style={{ whiteSpace: "nowrap", color: "var(--text-muted)" }}
                >
                  {(file.size / 1048576).toFixed(1)} MiB
                </span>
              </span>
            </Forms.FormText>
          ))}
        </div>
        <DialogActions>
          <Button
            size="small"
            variant="dangerSecondary"
            onClick={() => {
              props.settle(false);
              props.onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            size="small"
            onClick={() => {
              props.settle(true);
              props.onClose();
            }}
          >
            Upload
          </Button>
        </DialogActions>
      </div>
    </Modal>
  );
}

function confirm(batch: Batch) {
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  let settled = false;
  const settle = (value: boolean) => {
    if (settled) return;
    settled = true;
    modalOpen = false;
    resolve(value);
  };
  modalOpen = true;
  try {
    openModal((props) => (
      <Confirmation {...props} batch={batch} settle={settle} />
    ));
  } catch (error) {
    modalOpen = false;
    reject(error);
  }
  return promise;
}

const flow = new AttachmentFlow({
  native: Native,
  userId: () => UserStore.getCurrentUser()?.id,
  serverUrl: () => settings.store.serverUrl,
  apiToken: () => settings.store.apiToken,
  confirm,
  append: appendToOriginalDraft,
  changed,
  show: showStatus,
});

function describe(batch?: Batch) {
  if (!batch) return "Pelican: oversized attachment uploads";
  if (batch.phase === "confirming") return "Pelican: waiting for confirmation";
  if (batch.phase === "starting") return "Pelican: preparing upload";
  if (batch.phase === "uploading") {
    const state = batch.state;
    return state
      ? `Pelican: ${state.phase === "processing" ? "saving to storage" : "uploading"} ${state.index}/${state.count} — ${state.file}`
      : "Pelican: uploading";
  }
  if (batch.phase === "complete") return "Pelican: upload complete";
  if (batch.phase === "cancelled")
    return "Pelican: cancelled — completed links kept";
  return "Pelican: upload failed — click for details";
}

function statusTitle(batch?: Batch) {
  if (!batch) return "Pelican";
  switch (batch.phase) {
    case "complete":
      return "Upload complete";
    case "cancelled":
      return "Upload cancelled";
    case "failed":
      return "Upload failed";
    case "confirming":
      return "Waiting for confirmation";
    case "starting":
      return "Preparing upload…";
    case "uploading":
      return batch.state?.phase === "processing" ? "Saving…" : "Uploading…";
  }
}

function StatusModal(props: RenderModalProps) {
  const { batch, userId } = useBatch();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  useEffect(() => setCopyStatus("idle"), [batch]);
  useEffect(
    () => () => {
      modalOpen = false;
    },
    [],
  );
  const owned = batch?.userId === userId;
  const active = batch?.running === true;
  // Reserve the progress layout before the first native status poll so the
  // action row does not move underneath an in-flight click.
  const fileIndex = batch?.state?.index ?? 1;
  const file = batch?.files[fileIndex - 1]?.file;
  const size = batch?.state?.size ?? file?.size ?? 0;
  const sent = batch?.state?.sent ?? 0;
  return (
    <Modal {...props} title={owned ? statusTitle(batch) : "Pelican"} size="md">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {!batch && (
          <Forms.FormText>Attach a file to get started.</Forms.FormText>
        )}
        {batch && !owned ? (
          <Forms.FormText>
            Return to the original account to view this upload.
          </Forms.FormText>
        ) : (
          <>
            {batch && active && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Forms.FormText>
                  <span style={{ display: "block", overflowWrap: "anywhere" }}>
                    {batch.state?.file ?? file?.name}
                  </span>
                  <span style={{ color: "var(--text-muted)", fontSize: 14 }}>
                    File {fileIndex} of {batch.files.length}
                  </span>
                </Forms.FormText>
                <progress
                  aria-label="Current file upload progress"
                  value={sent}
                  max={Math.max(size, 1)}
                  tabIndex={-1}
                  style={{
                    width: "100%",
                    accentColor: "var(--brand-500)",
                    pointerEvents: "none",
                    userSelect: "none",
                  }}
                />
                <Forms.FormText>
                  {(sent / 1048576).toFixed(1)} / {(size / 1048576).toFixed(1)}{" "}
                  MiB
                </Forms.FormText>
              </div>
            )}
            {batch?.error && <Forms.FormText>{batch.error}</Forms.FormText>}
            {batch?.insertionNotice && (
              <Forms.FormText>{batch.insertionNotice}</Forms.FormText>
            )}
            {!!batch?.state?.urls.length && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {batch.state.urls.map((url, index) => (
                  <Forms.FormText key={index}>
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: "var(--text-link)",
                        textDecoration: "underline",
                        textUnderlineOffset: 3,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {batch.files[index]?.file.name || url}
                    </a>
                  </Forms.FormText>
                ))}
                {copyStatus === "failed" && (
                  <Forms.FormText role="alert">
                    Could not copy. Copy the link manually.
                  </Forms.FormText>
                )}
              </div>
            )}
            {batch &&
              (batch.phase === "failed" || batch.phase === "cancelled") && (
                <Forms.FormText>
                  Check Zipline before retrying; uploaded files may still be
                  stored.
                </Forms.FormText>
              )}
          </>
        )}
        <DialogActions>
          {active && (
            <Button
              size="small"
              variant="dangerSecondary"
              onClick={() => {
                void flow.cancel();
              }}
            >
              Cancel upload
            </Button>
          )}
          <Button size="small" variant="secondary" onClick={props.onClose}>
            Close
          </Button>
          {batch && !active && batch.phase !== "confirming" && (
            <Button
              size="small"
              variant="secondary"
              title="Clear this list without deleting uploaded files"
              onClick={() => {
                void flow.dismiss().then(() => {
                  if (!flow.batch) props.onClose();
                });
              }}
            >
              Clear upload
            </Button>
          )}
          {owned && !active && !!batch?.state?.urls.length && (
            <Button
              size="small"
              variant="secondary"
              onClick={async () => {
                try {
                  await copyToClipboard(batch.state!.urls.join("\n"));
                  setCopyStatus("copied");
                } catch {
                  setCopyStatus("failed");
                }
              }}
            >
              {copyStatus === "copied"
                ? "Copied"
                : batch.state.urls.length === 1
                  ? "Copy link"
                  : "Copy links"}
            </Button>
          )}
          {owned &&
            !active &&
            !!batch?.state?.urls.length &&
            !batch.insertionUncertain && (
              <Button
                size="small"
                onClick={() => {
                  flow.insert();
                }}
              >
                Add to message
              </Button>
            )}
        </DialogActions>
      </div>
    </Modal>
  );
}
function showStatus() {
  if (modalOpen) return;
  modalOpen = true;
  try {
    openModal((props) => <StatusModal {...props} />);
  } catch (error) {
    modalOpen = false;
    throw error;
  }
}

const PelicanIcon: IconComponent = ({ height = 20, width = 20, className }) => (
  <svg
    aria-hidden="true"
    width={width}
    height={height}
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />
  </svg>
);
const PelicanButton: ChatBarButtonFactory = ({ isMainChat, disabled }) => {
  const { batch, userId } = useBatch();
  if (!isMainChat || disabled || !batch) return null;
  const visible = batch?.userId === userId ? batch : undefined;
  return (
    <ChatBarButton
      tooltip={describe(visible)}
      buttonProps={{ "aria-haspopup": "dialog" }}
      onClick={showStatus}
    >
      <span
        style={{
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          width: 32,
          height: 28,
          flexShrink: 0,
          gap: 1,
          lineHeight: 1,
          verticalAlign: "middle",
        }}
      >
        <PelicanIcon height={16} width={16} />
        {visible && (
          <span
            style={{
              fontSize: 9,
              lineHeight: "10px",
              whiteSpace: "nowrap",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {visible.phase === "uploading"
              ? visible.state?.phase === "processing"
                ? "Saving…"
                : `${Math.round((100 * (visible.state?.sent ?? 0)) / Math.max(visible.state?.size ?? 1, 1))}%`
              : visible.phase === "failed"
                ? "!"
                : visible.phase === "complete"
                  ? "Ready"
                  : "…"}
          </span>
        )}
      </span>
    </ChatBarButton>
  );
};

export default definePlugin({
  name: "Pelican",
  description:
    "Upload oversized files to your Zipline server. Adds links to your draft without sending.",
  authors: [{ name: "adeci", id: 0n }],
  settings,
  dependencies: ["ChatInputButtonAPI"],
  chatBarButton: { icon: PelicanIcon, render: PelicanButton },
  patches: [
    {
      // Discord module 518960: compression and metadata alignment have already
      // finished here; untouched prepared objects continue through addFiles.
      find: '"Unexpected mismatch between files and file metadata"',
      group: true,
      replacement: [
        {
          match:
            /(async function \i\(\i,(\i),(\i)\)\{let\{filesMetadata:\i,requireConfirm:(\i)=!0,isThumbnail:(\i)=!1,origin:\i\}=arguments\.length>3&&void 0!==arguments\[3\]\?arguments\[3\]:\{\};)/,
          replace:
            "$1const __pelicanContext={channel:$2,draftType:$3,requireConfirm:$4,isThumbnail:$5};",
        },
        {
          match:
            /(\i)=await Promise\.all\((\i)\.map\((\i)\.(\i)\)\),(\i)=\1\.map\((\i)=>\6\.file\);if\(\(0,(\i)\.(\i)\)\(\{files:\5,guildId:(\i)\}\)\)/,
          replace:
            "$1=await $self.preflight(await Promise.all($2.map($3.$4)),__pelicanContext,file=>(0,$7.$8)({files:[file],guildId:$9,canDeferSizeChecks:!1})),$5=$1.map($6=>$6.file);if(!$1.length)return;if((0,$7.$8)({files:$5,guildId:$9}))",
        },
      ],
    },
    {
      // Register mounted channel editors, not the last global INSERT_TEXT
      // subscriber (which may be an edit modal or another channel).
      find: '"ChannelEditor.tsx"',
      group: true,
      replacement: [
        {
          match:
            /componentDidMount\(\)\{(?=this\.props\.focused&&requestAnimationFrame)/,
          replace: "$&$self.mountEditor(this);",
        },
        {
          match: /componentWillUnmount\(\)\{(?=this\.saveCurrentText\(\))/,
          replace: "$&$self.unmountEditor(this);",
        },
      ],
    },
  ],
  preflight(
    files: PreparedAttachment[],
    context: PreflightContext,
    exceeds: (file: File) => boolean,
  ) {
    return flow.preflight(files, context, exceeds);
  },
  mountEditor(instance: ChannelEditor) {
    editors.set(instance, UserStore.getCurrentUser()?.id);
  },
  unmountEditor(instance: ChannelEditor) {
    editors.delete(instance);
  },
  start() {
    statusTimer = window.setInterval(() => {
      const batch = flow.batch;
      if (!batch?.running || !batch.jobId || polling) return;
      if (UserStore.getCurrentUser()?.id !== batch.userId) {
        void flow.cancel();
        return;
      }
      polling = true;
      void flow
        .refresh(batch)
        .catch(() => {
          batch.error =
            "Could not read native upload progress. Open Pelican for completed links or cancel the upload; check Zipline before trying again.";
          changed();
        })
        .finally(() => {
          polling = false;
        });
    }, 400);
  },
  stop() {
    clearInterval(statusTimer);
    void flow.cancel();
    editors.clear();
  },
});
