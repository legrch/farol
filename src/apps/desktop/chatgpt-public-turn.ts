import { z } from "zod";
import {
  ChatGptVisibleOutput,
  VisibleOutputChannelSchema,
  type VisibleOutputItem,
} from "./chatgpt-visible-output";

const publicSegmentSchema = z.strictObject({
  id: z.string().min(1).max(256),
  text: z
    .string()
    .min(1)
    .max(256 * 1_024)
    .nullable(),
  complete: z.boolean(),
});

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
        // Local browser observation DTO, not a root wire/schema change.
        segments: z.array(publicSegmentSchema).max(512).optional(),
      }),
    )
    .max(512),
  terminal: z.boolean(),
});

/**
 * Message IDs, not DOM indices, anchor this conservative source profile.
 * Ordinary within-message blocks stay buffered. An explicitly selected source
 * profile may supply stable segment IDs with independent settlement evidence.
 * New suffixes require overlap; display indices never create identity. Missing
 * committed prefixes are safe, missing pending prefixes cannot be overtaken.
 */
export class ChatGptPublicTurn {
  private readonly output: ChatGptVisibleOutput;
  private readonly order: string[] = [];
  private readonly unresolved = new Set<string>();
  private readonly parents = new Map<string, string | null>();
  private readonly outputOrder: string[] = [];
  private readonly outputUnresolved = new Set<string>();
  private readonly outputOwners = new Map<string, string>();
  private readonly segmented = new Map<string, boolean>();
  private readonly projectionOrders = new Map<string, string[]>();
  private readonly committed = new Map<
    string,
    Pick<VisibleOutputItem, "text" | "channel">
  >();
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
      const allUnits = frame.messages.flatMap((message) => {
        // A not-yet-mounted Markdown root has no qualified projection shape.
        // Retain the message anchor without inventing a pending segment ID.
        if (message.segments === undefined && message.text === null) return [];
        const segmented = message.segments !== undefined;
        if (
          this.segmented.has(message.id) &&
          this.segmented.get(message.id) !== segmented
        )
          throw new Error("CHATGPT_PUBLIC_SEGMENTS_UNQUALIFIED");
        this.segmented.set(message.id, segmented);
        if (
          message.segments &&
          message.complete &&
          (!message.segments.length ||
            message.segments.some(
              (segment) => !segment.complete || segment.text === null,
            ))
        )
          throw new Error("CHATGPT_PUBLIC_TERMINAL_UNQUALIFIED");
        if (
          message.segments &&
          message.text !== null &&
          message.text !==
            message.segments.map((segment) => segment.text).join("\n\n")
        )
          throw new Error("CHATGPT_PUBLIC_SEGMENTS_UNQUALIFIED");
        const projection = message.segments ?? [message];
        const order = this.projectionOrders.get(message.id) ?? [];
        let previous = -1;
        for (const segment of projection) {
          let position = order.indexOf(segment.id);
          if (position < 0) {
            if (order.length && previous !== order.length - 1)
              throw new Error("CHATGPT_PUBLIC_SOURCE_GAP");
            position = order.length;
            order.push(segment.id);
          }
          if (
            position <= previous ||
            (previous >= 0 && position !== previous + 1)
          )
            throw new Error("CHATGPT_PUBLIC_SOURCE_ORDER");
          previous = position;
          if (
            this.outputOwners.has(segment.id) &&
            this.outputOwners.get(segment.id) !== message.id
          )
            throw new Error("CHATGPT_PUBLIC_SEGMENTS_UNQUALIFIED");
          this.outputOwners.set(segment.id, message.id);
          if (this.outputOwners.size > 512)
            throw new Error("CHATGPT_PUBLIC_SOURCE_LIMIT");
        }
        this.projectionOrders.set(message.id, order);
        return projection.map((segment) => ({
          id: segment.id,
          text: segment.text,
          complete: segment.complete,
          channel: message.channel,
          owner: message.id,
          segmented,
        }));
      });
      if (allUnits.length > 512) throw new Error("CHATGPT_PUBLIC_SOURCE_LIMIT");
      const allUnitIds = allUnits.map((unit) => unit.id);
      if (new Set(allUnitIds).size !== allUnitIds.length)
        throw new Error("CHATGPT_PUBLIC_SOURCE_ORDER");
      // Validation is independent of emission readiness. A blocked/missing
      // earlier root must never hide a visible committed mutation later on.
      for (const unit of allUnits) {
        const committed = this.committed.get(unit.id);
        if (
          committed &&
          (committed.text !== unit.text || committed.channel !== unit.channel)
        )
          throw new Error("CHATGPT_VISIBLE_OUTPUT_COMMITTED_CHANGED");
        if (committed && unit.segmented && !unit.complete)
          throw new Error("CHATGPT_PUBLIC_SEGMENT_CHANGED");
      }
      if (
        frame.terminal &&
        [...this.outputOwners.keys()].some(
          (id) => !this.committed.has(id) && !allUnitIds.includes(id),
        )
      )
        throw new Error("CHATGPT_PUBLIC_PENDING_MISSING");

      // Only a publishable owner prefix gets global positions. Later owners
      // retain their local anchors while an earlier reply is still growing.
      const units: typeof allUnits = [];
      const missingMessagePrefix =
        ids[0] !== undefined &&
        [...this.unresolved].some(
          (id) =>
            this.order.indexOf(id) < this.order.indexOf(ids[0]!) &&
            !ids.includes(id),
        );
      if (!missingMessagePrefix)
        for (const message of frame.messages) {
          const owned = allUnits.filter((unit) => unit.owner === message.id);
          const localOrder = this.projectionOrders.get(message.id) ?? [];
          const first = owned[0];
          if (
            first &&
            localOrder
              .slice(0, localOrder.indexOf(first.id))
              .some((id) => !this.committed.has(id))
          )
            break;
          units.push(...owned);
          const present = new Set(owned.map((unit) => unit.id));
          if (
            !message.complete ||
            localOrder.some((id) => !present.has(id) && !this.committed.has(id))
          )
            break;
        }
      const unitIds = units.map((unit) => unit.id);
      previous = -1;
      for (const unit of units) {
        if (
          this.outputOwners.has(unit.id) &&
          this.outputOwners.get(unit.id) !== unit.owner
        )
          throw new Error("CHATGPT_PUBLIC_SEGMENTS_UNQUALIFIED");
        let position = this.outputOrder.indexOf(unit.id);
        if (position < 0) {
          const lastOwner = this.outputOwners.get(
            this.outputOrder.at(-1) ?? "",
          );
          const afterClosedOwner =
            previous < 0 &&
            lastOwner !== undefined &&
            this.order.indexOf(unit.owner) > this.order.indexOf(lastOwner) &&
            !this.unresolved.has(lastOwner);
          if (
            this.outputOrder.length &&
            previous !== this.outputOrder.length - 1 &&
            !afterClosedOwner
          )
            throw new Error("CHATGPT_PUBLIC_SOURCE_GAP");
          position = this.outputOrder.length;
          this.outputOrder.push(unit.id);
          this.outputUnresolved.add(unit.id);
          this.outputOwners.set(unit.id, unit.owner);
        } else if (
          unit.segmented &&
          !this.outputUnresolved.has(unit.id) &&
          (!unit.complete || unit.text === null)
        ) {
          throw new Error("CHATGPT_PUBLIC_SEGMENT_CHANGED");
        }
        if (
          position <= previous ||
          (previous >= 0 && position !== previous + 1)
        )
          throw new Error("CHATGPT_PUBLIC_SOURCE_ORDER");
        previous = position;
      }
      if (this.outputOrder.length > 512)
        throw new Error("CHATGPT_PUBLIC_SOURCE_LIMIT");
      if (
        frame.terminal &&
        [...this.outputUnresolved].some((id) => !unitIds.includes(id))
      )
        throw new Error("CHATGPT_PUBLIC_PENDING_MISSING");
      // Pending Markdown blocks later output. Even fully settled segments of
      // an unfinished message cannot justify overtaking its reply boundary.
      const ready = [];
      for (const unit of units) {
        if (unit.text === null) break;
        ready.push({
          id: unit.id,
          channel: unit.channel,
          complete: unit.complete,
          text: unit.text,
          position: this.outputOrder.indexOf(unit.id),
        });
      }
      const first = ready[0];
      const missingPrefix =
        first &&
        ([...this.unresolved].some(
          (id) =>
            this.order.indexOf(id) <
              this.order.indexOf(this.outputOwners.get(first.id)!) &&
            !ids.includes(id),
        ) ||
          [...this.outputUnresolved].some(
            (id) =>
              this.outputOrder.indexOf(id) < first.position &&
              !unitIds.includes(id),
          ));
      const items = this.output.observe(
        {
          sourceId: this.userId,
          blocks: missingPrefix ? [] : ready,
          terminal: frame.terminal,
        },
        nowMs,
      );
      for (const item of items) {
        this.outputUnresolved.delete(item.id);
        this.committed.set(item.id, { text: item.text, channel: item.channel });
      }
      for (const message of frame.messages) {
        if (
          message.complete &&
          (this.projectionOrders.get(message.id) ?? []).every((id) =>
            this.committed.has(id),
          )
        )
          this.unresolved.delete(message.id);
      }
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
  includeSettledSegments = false,
): z.infer<typeof PublicTurnFrameSchema>["messages"] {
  if (assistants.length > 512) throw new Error("CHATGPT_PUBLIC_SOURCE_LIMIT");
  let totalCharacters = 0;
  let totalSegments = 0;
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
    const normalize = (
      root: Element,
      settled: boolean,
      strictSettled = false,
    ): string | null => {
      try {
        return markdown(root, visible) || null;
      } catch (error) {
        if (
          !(strictSettled && settled) &&
          error instanceof Error &&
          (error.message === "CHATGPT_MARKDOWN_PENDING_LINK" ||
            error.message === "CHATGPT_MARKDOWN_PENDING_CODE" ||
            (!settled &&
              error.message === "CHATGPT_MARKDOWN_TABLE_UNSUPPORTED"))
        )
          return null;
        throw error;
      }
    };
    const root = roots[0]!;
    const profile = includeSettledSegments
      ? root.getAttribute("data-farol-source-profile")
      : null;
    let segments: z.infer<typeof publicSegmentSchema>[] | undefined;
    if (profile !== null) {
      // Explicitly synthetic, immutable published segments. This is not a
      // discovered ChatGPT vendor profile or timing/paragraph-position proof.
      if (profile !== "farol-controlled-settled-segments-v1")
        throw new Error("CHATGPT_PUBLIC_SEGMENTS_UNQUALIFIED");
      segments = [];
      const ids = new Set<string>();
      for (const node of root.childNodes) {
        if (node.nodeType === 3 && !(node.nodeValue ?? "").trim()) continue;
        if (node.nodeType !== 1)
          throw new Error("CHATGPT_PUBLIC_SEGMENTS_UNQUALIFIED");
        const block = node as Element;
        if (!visible(block)) continue;
        const segmentId = block.getAttribute("data-segment-id");
        const state = block.getAttribute("data-segment-state");
        if (
          !segmentId ||
          segmentId.length > 256 ||
          ids.has(segmentId) ||
          /[\u0000-\u001f\u007f]/u.test(segmentId) ||
          (state !== "settled" && state !== "pending") ||
          ![
            "P",
            "PRE",
            "BLOCKQUOTE",
            "UL",
            "OL",
            "TABLE",
            "HR",
            "H1",
            "H2",
            "H3",
            "H4",
            "H5",
            "H6",
          ].includes(block.tagName) ||
          block.querySelectorAll("[data-segment-id]").length > 0
        )
          throw new Error("CHATGPT_PUBLIC_SEGMENTS_UNQUALIFIED");
        ids.add(segmentId);
        const text = normalize(block, state === "settled", true);
        if (state === "settled" && text === null)
          throw new Error("CHATGPT_PUBLIC_SEGMENTS_UNQUALIFIED");
        segments.push({
          id: segmentId,
          text,
          complete: state === "settled" && text !== null,
        });
        if (++totalSegments > 512)
          throw new Error("CHATGPT_PUBLIC_SOURCE_LIMIT");
      }
    }
    const text = segments
      ? segments.some((segment) => segment.text === null)
        ? null
        : segments.map((segment) => segment.text).join("\n\n") || null
      : normalize(root, complete);
    totalCharacters += segments
      ? segments.reduce(
          (sum, segment) => sum + (segment.text?.length ?? 0),
          0,
        ) +
        Math.max(0, segments.length - 1) * 2
      : (text?.length ?? 0);
    if (totalCharacters > 256 * 1_024)
      throw new Error("CHATGPT_PUBLIC_SOURCE_LIMIT");
    return {
      id,
      parentId,
      channel,
      text,
      complete:
        complete &&
        text !== null &&
        (!segments || segments.every((segment) => segment.complete)),
      ...(segments ? { segments } : {}),
    };
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
