import React, {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { Heading } from "./upstream/components/Heading";
import { Paragraph } from "./upstream/components/Paragraph";
export { React, useEffect, useMemo, useState };
export { TextCompat as Text } from "./upstream/components/BaseText";
export { ButtonCompat as Button } from "./upstream/components/Button";
export type Point = { path: number[]; offset: number };
export type Slate = {
  text: string;
  selection: { anchor: Point; focus: Point } | null;
  textarea: HTMLTextAreaElement | null;
};
export const fixture = {
  channel: "original-channel",
  user: "fixture-user",
  command: null,
  sent: 0,
  errors: [] as string[],
  ordinary: [] as {
    name: string;
    description: string;
    spoiler: boolean;
    identity: boolean;
  }[],
  selections: 0,
  patchMatches: 0,
  ready: false,
  drafts: new Map<string, Slate>(),
};
const subscribers = new Set<() => void>();
let version = 0;
type ModalProps = { onClose(): void; transitionState: number };
let currentModal: ((props: ModalProps) => ReactNode) | null = null;
export function changed() {
  version++;
  for (const notify of subscribers) notify();
}
export function useStateFromStores<T>(_stores: unknown[], read: () => T): T {
  useSyncExternalStore(
    (notify) => {
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    },
    () => version,
  );
  return read();
}
class FixtureUser {
  id: string;
  username: string;
  constructor(data: { id: string; username?: string }) {
    this.id = data.id;
    this.username = data.username ?? "Fixture user";
  }
  getAvatarURL() {
    return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3C/svg%3E";
  }
}
export const UserStore = {
  getCurrentUser: () => new FixtureUser({ id: fixture.user }),
};
export const FluxDispatcher = { dispatch() {} };
export const UserUtils = {
  async getUser() {
    throw new Error("Fixture author lookup has no Discord network");
  },
};
let dummyId = 0;
export const generateId = () => String(--dummyId);
export const findCssClassesLazy = (...names: string[]) =>
  Object.fromEntries(names.map((name) => [name, name]));
export function getIntlMessage(key: string): never {
  throw new Error(`Fixture does not implement Discord localization: ${key}`);
}
export const classes = (...values: unknown[]) =>
  values.filter(Boolean).join(" ");
export const Clickable = (props: React.HTMLAttributes<HTMLDivElement>) => (
  <div {...props} />
);
export const UserSummaryItem = ({
  users,
  renderUser,
}: {
  users: FixtureUser[];
  renderUser(user: FixtureUser): ReactNode;
}) => (
  <div>
    {users.map((user) => (
      <React.Fragment key={user.id}>{renderUser(user)}</React.Fragment>
    ))}
  </div>
);
export const Tooltip = ({ children }: { children(props: object): ReactNode }) =>
  children({});
export const SelectedChannelStore = { getChannelId: () => fixture.channel };
export const Forms = {
  FormText: Paragraph,
  FormTitle: Heading,
};
export const TextInput = ({
  onChange,
  ...props
}: {
  onChange(value: string): void;
  value: string;
}) => <input {...props} onChange={(event) => onChange(event.target.value)} />;
export const TextArea = TextInput;
export function Modal({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  onClose(): void;
}) {
  return (
    <div className="overlay">
      <section
        role="dialog"
        aria-label={typeof title === "string" ? title : undefined}
      >
        <button aria-label="Close modal" onClick={onClose}>
          Close
        </button>
        <header>{title}</header>
        {subtitle}
        {children}
      </section>
    </div>
  );
}
export function openModal(factory: (props: ModalProps) => ReactNode) {
  currentModal = factory;
  changed();
}
export function ModalHost() {
  useStateFromStores([], () => version);
  return (
    currentModal?.({
      onClose() {
        currentModal = null;
        changed();
      },
      transitionState: 1,
    }) ?? null
  );
}
export function ChatBarButton({
  tooltip,
  buttonProps,
  onClick,
  children,
}: {
  tooltip: string;
  buttonProps: object;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      {...buttonProps}
      title={tooltip}
      aria-label={tooltip}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export const Editor = {
  end: (editor: Slate) => ({ path: [0, 0], offset: editor.text.length }),
  withoutNormalizing: (_editor: Slate, run: () => void) => run(),
};
export const Transforms = {
  insertText(editor: Slate, text: string, { at }: { at: Point }) {
    editor.text =
      editor.text.slice(0, at.offset) + text + editor.text.slice(at.offset);
    if (editor.textarea) editor.textarea.value = editor.text;
    editor.selection = null;
  },
  select(editor: Slate, selection: NonNullable<Slate["selection"]>) {
    editor.selection = selection;
    editor.textarea?.setSelectionRange(
      selection.anchor.offset,
      selection.focus.offset,
    );
  },
};
export const findByPropsLazy = (name: string) =>
  name === "insertNodes" ? Transforms : Editor;
export const findStoreLazy = () => ({
  getActiveCommand: () => fixture.command,
});
