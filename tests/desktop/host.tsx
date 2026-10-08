import React, { useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import plugin from "./plugin/index";
import { Settings, useSettings } from "./upstream/api/Settings";
import { isPluginEnabled } from "./upstream/api/PluginManager";
import { openPluginModal } from "./upstream/components/settings/tabs/plugins/PluginModal";
import plugins from "./registry.mjs";
import { changed, fixture, ModalHost, useStateFromStores } from "./common";
import { createUploadFactory, patchMatches } from "./factories";

// Match PluginManager's registration before accessing definePluginSettings.
plugins.Pelican = plugin;
plugin.settings.pluginName = plugin.name;

// Only Discord dependencies are substituted. The production renderer, flow,
// settings and packaged Electron native helper are not replaced or copied.
let prepared = new Set<object>();
const modules: Record<number, object> = {
  367513: { A: { updateChatOpen() {} } },
  148494: {
    A: {
      sendMessage() {
        fixture.sent++;
        throw Error("Unexpected sendMessage: Pelican must never send");
      },
    },
  },
  608299: {
    A: {
      addFiles(value: {
        files: { file: File; description: string; spoiler: boolean }[];
      }) {
        fixture.ordinary.push(
          ...value.files.map((item) => ({
            name: item.file.name,
            description: item.description,
            spoiler: item.spoiler,
            identity: prepared.has(item),
          })),
        );
        changed();
      },
    },
  },
  494921: {
    openUploadError(value: unknown) {
      fixture.errors.push(JSON.stringify(value));
      changed();
    },
  },
  111542: {
    N: async (value: object) => {
      prepared.add(value);
      return value;
    },
  },
  795129: { _: async (file: File) => file.size },
  274652: { x: { WEB: 1 } },
  522602: { A: { getUploadCount: () => 0 } },
  382287: {
    fJ: ({ files }: { files: File[] }) =>
      files.some((file) => file.size > 10 * 1024 * 1024),
  },
  652215: { XgB: 10, rbe: { GUILD_VOICE: 2, GUILD_STAGE_VOICE: 13 } },
};
const requireModule = Object.assign((id: number) => modules[id] ?? {}, {
  d(target: object, entries: Record<string, () => unknown>) {
    for (const [key, get] of Object.entries(entries))
      Object.defineProperty(target, key, { get });
  },
});
const exports: {
  R?: (
    files: File[],
    channel: object,
    draftType: number,
    options: object,
  ) => Promise<void>;
} = {};
createUploadFactory(plugin)({}, exports, requireModule);
if (!exports.R)
  throw Error("Pinned Discord attachment preflight export is missing");
const prompt = exports.R;
fixture.patchMatches = patchMatches;
if (isPluginEnabled(plugin.name)) plugin.start();

function Composer({ enabled }: { enabled: boolean }) {
  const channel = useStateFromStores([], () => fixture.channel);
  if (!fixture.drafts.has(channel))
    fixture.drafts.set(channel, { text: "", selection: null, textarea: null });
  const editor = fixture.drafts.get(channel)!;
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    editor.textarea = ref.current;
    const mounted = {
      props: {
        channel: { id: channel },
        type: { drafts: { type: 0 } },
        useSlate: true,
      },
      state: {},
      getSlateEditor: () => editor,
    };
    if (enabled) plugin.mountEditor(mounted);
    return () => {
      plugin.unmountEditor(mounted);
      editor.textarea = null;
    };
  }, [channel, enabled]);
  const selection = (element: HTMLTextAreaElement) => {
    editor.selection = {
      anchor: { path: [0, 0], offset: element.selectionStart },
      focus: { path: [0, 0], offset: element.selectionEnd },
    };
  };
  return (
    <textarea
      key={channel}
      ref={ref}
      id="composer"
      aria-label="Message draft"
      defaultValue={editor.text}
      onChange={(event) => {
        editor.text = event.target.value;
        selection(event.target);
      }}
      onSelect={(event) => selection(event.currentTarget)}
    />
  );
}
function Host() {
  useStateFromStores([], () => fixture.channel);
  const enabled = useSettings(["plugins.Pelican.enabled"]).plugins.Pelican
    .enabled;
  const StatusButton = plugin.chatBarButton.render;
  return (
    <main>
      <h1>Pelican packaged-desktop integration fixture</h1>
      <p>
        Controlled Discord-shaped UI, not a live Discord session. Real packaged
        Pelican IPC and local Zipline uploads.
      </p>
      <section aria-label={plugin.required ? "Required Plugins" : "Plugins"}>
        <label>
          <input
            id="enable-pelican"
            type="checkbox"
            checked={isPluginEnabled(plugin.name)}
            disabled={!!plugin.required}
            onChange={(event) => {
              Settings.plugins.Pelican.enabled = event.target.checked;
              if (event.target.checked) plugin.start();
              else plugin.stop();
            }}
          />
          Enable Pelican
        </label>
        <button id="plugin-settings" onClick={() => openPluginModal(plugin)}>
          Pelican settings
        </button>
      </section>
      <nav>
        <button
          onClick={() => {
            fixture.channel = "original-channel";
            changed();
          }}
        >
          Original channel
        </button>
        <button
          onClick={() => {
            fixture.channel = "other-channel";
            changed();
          }}
        >
          Other channel
        </button>
        <button
          onClick={() => {
            fixture.user = "other-user";
            changed();
          }}
        >
          Other account
        </button>
        <button
          onClick={() => {
            fixture.user = "fixture-user";
            changed();
          }}
        >
          Original account
        </button>
      </nav>
      <h2 id="channel">{fixture.channel}</h2>
      {/* Discord reloads when toggling a patched plugin; remount its editor here. */}
      <Composer key={String(enabled)} enabled={enabled} />
      <label>
        Attach files normally{" "}
        <input
          id="attachments"
          aria-label="Attachments"
          type="file"
          multiple
          disabled={!enabled}
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            prepared = new Set();
            const channel = {
              id: fixture.channel,
              type: 0,
              getGuildId: () => "fixture-guild",
            };
            void prompt(files, channel, 0, {
              filesMetadata: files.map((file) => ({
                description: `description:${file.name}`,
                spoiler: file.name.startsWith("SPOILER_"),
              })),
            })
              .then(() => {
                fixture.selections++;
                changed();
              })
              .catch((error) => {
                fixture.errors.push(String(error));
                changed();
              });
          }}
        />
      </label>
      <div id="status">
        {enabled && <StatusButton isMainChat={true} disabled={false} />}
      </div>
      <section>
        <h2>Ordinary Discord attachment queue</h2>
        <pre id="ordinary">{JSON.stringify(fixture.ordinary, null, 2)}</pre>
      </section>
      <ModalHost />
    </main>
  );
}
window.pelicanFixture = {
  snapshot() {
    return {
      ...fixture,
      enabled: isPluginEnabled(plugin.name),
      required: !!plugin.required,
      serverUrl: plugin.settings.store.serverUrl,
      // Deliberately omit apiToken: snapshots are diagnostic artifacts.
      drafts: Object.fromEntries(
        [...fixture.drafts].map(([id, editor]) => [
          id,
          { text: editor.text, selection: editor.selection },
        ]),
      ),
      errors: [...fixture.errors],
    };
  },
};
createRoot(document.getElementById("root")!).render(<Host />);
fixture.ready = true;
