import { z } from "zod";
import {
  ChatGptVisibleOutput,
  VisibleOutputChannelSchema,
  type VisibleOutputItem,
} from "./chatgpt-visible-output";

export const PublicTurnFrameSchema = z.strictObject({
  userId: z.string().min(1).max(256),
  messages: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(256),
        parentId: z
          .string()
          .min(1)
          .max(256)
          .nullable()
          .optional()
          .default(null),
        channel: VisibleOutputChannelSchema,
        text: z
          .string()
          .min(1)
          .max(256 * 1_024)
          .nullable(),
        complete: z.boolean(),
      }),
    )
    .max(512),
  terminal: z.boolean(),
});

/**
 * Message IDs, not DOM indices, anchor this conservative source profile.
 * Within-message blocks stay buffered: no global range can be inferred from a
 * paragraph's current array index. New suffixes require overlap with the last
 * known message. A missing prefix is safe only after it has been emitted.
 */
export class ChatGptPublicTurn {
  private readonly output: ChatGptVisibleOutput;
  private readonly order: string[] = [];
  private readonly unresolved = new Set<string>();
  private readonly parents = new Map<string, string | null>();
  private failure: Error | null = null;

  constructor(
    private readonly userId: string,
    private readonly firstAssistantId: string,
    stabilityMs = 500,
  ) {
    this.output = new ChatGptVisibleOutput(userId, stabilityMs);
  }

  observe(
    candidate: unknown,
    nowMs: number,
  ): Readonly<{
    items: readonly VisibleOutputItem[];
    answer: string;
    completed: boolean;
  }> {
    if (this.failure) throw this.failure;
    try {
      const parsed = PublicTurnFrameSchema.safeParse(candidate);
      if (!parsed.success) throw new Error("CHATGPT_PUBLIC_SOURCE_INVALID");
      const frame = parsed.data;
      if (frame.userId !== this.userId)
        throw new Error("CHATGPT_PUBLIC_SOURCE_CHANGED");
      const ids = frame.messages.map((message) => message.id);
      if (new Set(ids).size !== ids.length)
        throw new Error("CHATGPT_PUBLIC_SOURCE_ORDER");
      if (!this.order.length && ids[0] !== this.firstAssistantId) {
        throw new Error("CHATGPT_PUBLIC_SOURCE_GAP");
      }
      let previous = -1;
      for (const id of ids) {
        let position = this.order.indexOf(id);
        if (position < 0) {
          if (this.order.length && previous !== this.order.length - 1) {
            throw new Error("CHATGPT_PUBLIC_SOURCE_GAP");
          }
          position = this.order.length;
          this.order.push(id);
          this.unresolved.add(id);
        }
        if (
          position <= previous ||
          (previous >= 0 && position !== previous + 1)
        ) {
          throw new Error("CHATGPT_PUBLIC_SOURCE_ORDER");
        }
        previous = position;
      }
      for (const message of frame.messages) {
        const parent = message.parentId;
        const parentPosition =
          parent === null ? -1 : this.order.indexOf(parent);
        if (
          (parent !== null &&
            parent !== this.userId &&
            (parentPosition < 0 ||
              parentPosition >= this.order.indexOf(message.id))) ||
          (this.parents.has(message.id) &&
            this.parents.get(message.id) !== parent)
        ) {
          throw new Error("CHATGPT_PUBLIC_SOURCE_PARENT_UNQUALIFIED");
        }
        this.parents.set(message.id, parent);
      }
      if (this.order.length > 512)
        throw new Error("CHATGPT_PUBLIC_SOURCE_LIMIT");
      if (frame.terminal) {
        for (const id of this.unresolved) {
          if (!ids.includes(id))
            throw new Error("CHATGPT_PUBLIC_PENDING_MISSING");
        }
        const last = frame.messages.at(-1);
        if (
          !last ||
          last.id !== this.order.at(-1) ||
          last.channel !== "answer" ||
          frame.messages.some(
            (message) => !message.complete || message.text === null,
          )
        ) {
          throw new Error("CHATGPT_PUBLIC_TERMINAL_UNQUALIFIED");
        }
      }
      // A pending citation/code/table has no valid Markdown yet. Truncate here
      // so later display cannot overtake it; keep its durable in-memory anchor.
      const ready = [];
      for (const message of frame.messages) {
        if (message.text === null) break;
        ready.push({
          id: message.id,
          channel: message.channel,
          complete: message.complete,
          text: message.text,
          position: this.order.indexOf(message.id),
        });
      }
      // An unresolved prefix may be temporarily absent, but must not be skipped.
      const first = ready[0];
      const missingPrefix =
        first &&
        [...this.unresolved].some(
          (id) => this.order.indexOf(id) < first.position && !ids.includes(id),
        );
      const items = this.output.observe(
        {
          sourceId: this.userId,
          blocks: missingPrefix ? [] : ready,
          terminal: frame.terminal,
        },
        nowMs,
      );
      for (const item of items) this.unresolved.delete(item.id);
      return {
        items,
        answer: this.output.answerText(),
        completed: frame.terminal,
      };
    } catch (error) {
      this.failure =
        error instanceof Error
          ? error
          : new Error("CHATGPT_PUBLIC_SOURCE_INVALID");
      throw this.failure;
    }
  }
}

/** Browser-only function; serialized with its explicit Markdown dependency. */
export function readPublicAssistantMessages(
  assistants: readonly Element[],
  visible: (element: Element) => boolean,
  markdown: (
    element: Element,
    visible: (element: Element) => boolean,
  ) => string,
  controlVisible: (element: Element) => boolean = visible,
): z.infer<typeof PublicTurnFrameSchema>["messages"] {
  if (assistants.length > 512) throw new Error("CHATGPT_PUBLIC_SOURCE_LIMIT");
  let totalCharacters = 0;
  return assistants.map((assistant) => {
    const id = assistant
      .closest("[data-message-id]")
      ?.getAttribute("data-message-id");
    if (!id) throw new Error("CHATGPT_PUBLIC_SOURCE_UNANCHORED");
    const parentId =
      assistant
        .closest("[data-parent-message-id]")
        ?.getAttribute("data-parent-message-id") ?? null;
    // Only explicitly public channels are admitted. Never traverse an analysis
    // message, infer a tool execution, or use model/browser internal state.
    const declared = assistant.getAttribute("data-message-channel");
    if (
      declared !== "final" &&
      declared !== "commentary" &&
      declared !== "status"
    ) {
      throw new Error("CHATGPT_PUBLIC_CHANNEL_UNSUPPORTED");
    }
    const channel =
      declared === "commentary" || declared === "status" ? declared : "answer";
    const roots = [...assistant.querySelectorAll(".markdown")].filter(visible);
    if (roots.length === 0)
      return { id, parentId, channel, text: null, complete: false };
    if (roots.length > 1)
      throw new Error("CHATGPT_PUBLIC_MARKDOWN_UNQUALIFIED");
    // A turn-local copy action is stronger evidence than a global Send/Stop
    // toggle. Refuse an article containing several messages: its action is not
    // attributable to any one of them. This profile still needs native/live
    // qualification before its controls can be claimed as provider evidence.
    const article = assistant.closest("article");
    const scopedAction =
      article &&
      article.querySelectorAll('[data-message-author-role="assistant"]')
        .length === 1 &&
      [
        ...article.querySelectorAll('[data-testid="copy-turn-action-button"]'),
      ].some(controlVisible);
    const complete =
      Boolean(scopedAction) &&
      assistant.getAttribute("data-is-streaming") !== "true";
    let text: string | null;
    try {
      text = markdown(roots[0]!, visible) || null;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "CHATGPT_MARKDOWN_PENDING_LINK" ||
          error.message === "CHATGPT_MARKDOWN_PENDING_CODE" ||
          (!complete && error.message === "CHATGPT_MARKDOWN_TABLE_UNSUPPORTED"))
      )
        text = null;
      else throw error;
    }
    totalCharacters += text?.length ?? 0;
    if (totalCharacters > 256 * 1_024)
      throw new Error("CHATGPT_PUBLIC_SOURCE_LIMIT");
    return { id, parentId, channel, text, complete: complete && text !== null };
  });
}

/** Public content may have no own box (BR/display:contents), unlike a button. */
export function publicContentVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  for (
    let ancestor: HTMLElement | null = element;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    if (ancestor.hidden || ancestor.getAttribute("aria-hidden") === "true")
      return false;
    const style = getComputedStyle(ancestor);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.opacity === "0" ||
      style.contentVisibility === "hidden"
    )
      return false;
  }
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return (
    element.tagName === "BR" ||
    style.display === "contents" ||
    (box.width > 0 && box.height > 0)
  );
}
