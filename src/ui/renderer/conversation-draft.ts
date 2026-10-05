import type { ReadConversationView } from "../../pkg/product-settings/chat-conversation";

type Draft = Readonly<{
  text: string;
  edit: number;
  selectionStart: number;
  selectionEnd: number;
}>;
const empty: Draft = Object.freeze({
  text: "",
  edit: 0,
  selectionStart: 0,
  selectionEnd: 0,
});

export function conversationDraftKey(
  view: ReadConversationView | null,
): string | null {
  if (!view) return null;
  const b = view.binding;
  return JSON.stringify([
    view.operationId,
    b.profileId,
    b.backendGeneration,
    b.ownerId,
    b.sessionId,
    b.taskId,
    b.taskEpoch,
    b.participantId,
  ]);
}

/** One window's unsent text, never a backend handle or permission to Send.
 * No persistence or IPC: another window/incarnation starts with an empty draft.
 */
export class ConversationDraftStore {
  private held: { key: string; value: Draft } | null = null;
  private readonly listeners = new Set<() => void>();
  private edit = 0;
  private closed = false;
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  read(key: string | null): Draft {
    return key !== null && this.held?.key === key ? this.held.value : empty;
  }
  capture(
    key: string | null,
    text: string,
    start: number,
    end: number,
    edited = true,
  ): void {
    if (this.closed || key === null) return;
    const before = this.read(key);
    const selectionStart = Math.max(0, Math.min(text.length, start));
    const selectionEnd = Math.max(selectionStart, Math.min(text.length, end));
    if (
      !edited &&
      before.text === text &&
      before.selectionStart === selectionStart &&
      before.selectionEnd === selectionEnd
    )
      return;
    this.held = {
      key,
      value: Object.freeze({
        text,
        edit: edited ? ++this.edit : before.edit,
        selectionStart,
        selectionEnd,
      }),
    };
    for (const listener of this.listeners) listener();
  }
  selection(key: string | null, start: number, end: number): void {
    if (this.held?.key !== key) return;
    this.capture(key, this.held.value.text, start, end, false);
  }
  clearSubmitted(key: string | null, edit: number): void {
    if (this.held?.key !== key || this.held.value.edit !== edit) return;
    this.capture(key, "", 0, 0);
  }
  dispose(): void {
    this.closed = true;
    this.held = null;
    this.listeners.clear();
  }
}
