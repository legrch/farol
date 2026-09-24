import { z } from "zod";

export const VisibleOutputChannelSchema = z.enum([
  "answer",
  "commentary",
  "status",
]);

const blockSchema = z.strictObject({
  id: z.string().min(1).max(256),
  position: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  channel: VisibleOutputChannelSchema,
  // Normalized public Markdown/text, never raw browser HTML or hidden state.
  text: z
    .string()
    .min(1)
    .max(256 * 1_024),
  complete: z.boolean(),
});

export const VisibleOutputSnapshotSchema = z.strictObject({
  sourceId: z.string().min(1).max(512),
  blocks: z.array(blockSchema).max(512),
  terminal: z.boolean(),
});

export type VisibleOutputBlock = Readonly<z.infer<typeof blockSchema>>;
export type VisibleOutputSnapshot = Readonly<
  z.infer<typeof VisibleOutputSnapshotSchema>
>;
export type VisibleOutputItem = Readonly<{
  sequence: number;
  id: string;
  channel: z.infer<typeof VisibleOutputChannelSchema>;
  text: string;
}>;

export type VisibleOutputErrorCode =
  | "CHATGPT_VISIBLE_OUTPUT_INVALID"
  | "CHATGPT_VISIBLE_OUTPUT_SOURCE_CHANGED"
  | "CHATGPT_VISIBLE_OUTPUT_ORDER_CHANGED"
  | "CHATGPT_VISIBLE_OUTPUT_COMMITTED_CHANGED"
  | "CHATGPT_VISIBLE_OUTPUT_PENDING_MISSING"
  | "CHATGPT_VISIBLE_OUTPUT_LIMIT"
  | "CHATGPT_VISIBLE_OUTPUT_CLOSED";

export class VisibleOutputError extends Error {
  constructor(readonly code: VisibleOutputErrorCode) {
    // Content-free: never put browser text or source identifiers in diagnostics.
    super(code);
    this.name = "VisibleOutputError";
  }
}

type Candidate = Readonly<{
  block: VisibleOutputBlock;
  changedAt: number;
}>;

function sameContent(a: VisibleOutputBlock, b: VisibleOutputBlock): boolean {
  return (
    a.id === b.id &&
    a.position === b.position &&
    a.channel === b.channel &&
    a.text === b.text
  );
}

/**
 * Turns partial public DOM observations into immutable, ordered output items.
 * The DOM adapter owns stable source IDs/positions and semantic completion.
 * A missing committed prefix is virtualization, not a request to emit it again.
 * A missing uncommitted block is retained and prevents later blocks overtaking it.
 * No timer or DOM access: callers supply monotonic observation time explicitly.
 */
export class ChatGptVisibleOutput {
  private readonly committed = new Map<string, VisibleOutputBlock>();
  private readonly pending = new Map<string, Candidate>();
  private lastVisible = new Set<string>();
  private sequence = 0;
  private lastPosition = -1;
  private lastObservedAt = -1;
  private terminal = false;
  private failure: VisibleOutputError | null = null;
  private answer = "";

  constructor(
    private readonly sourceId: string,
    private readonly stabilityMs = 500,
    private readonly maximumCharacters = 256 * 1_024,
    private readonly maximumBlocks = 512,
  ) {
    if (
      sourceId.length < 1 ||
      sourceId.length > 512 ||
      !Number.isFinite(stabilityMs) ||
      stabilityMs < 0 ||
      !Number.isSafeInteger(maximumCharacters) ||
      maximumCharacters < 1 ||
      !Number.isSafeInteger(maximumBlocks) ||
      maximumBlocks < 1 ||
      maximumBlocks > 512
    ) {
      throw new VisibleOutputError("CHATGPT_VISIBLE_OUTPUT_INVALID");
    }
  }

  answerText(): string {
    return this.answer;
  }

  observe(input: unknown, nowMs: number): readonly VisibleOutputItem[] {
    if (this.failure) throw this.failure;
    if (this.terminal) this.fail("CHATGPT_VISIBLE_OUTPUT_CLOSED");
    const parsed = VisibleOutputSnapshotSchema.safeParse(input);
    if (
      !parsed.success ||
      !Number.isFinite(nowMs) ||
      nowMs < 0 ||
      nowMs < this.lastObservedAt
    ) {
      this.fail("CHATGPT_VISIBLE_OUTPUT_INVALID");
    }
    const snapshot = parsed.data;
    if (snapshot.sourceId !== this.sourceId) {
      this.fail("CHATGPT_VISIBLE_OUTPUT_SOURCE_CHANGED");
    }

    const visible = new Set<string>();
    const positions = new Map<number, string>();
    for (const block of this.committed.values()) {
      positions.set(block.position, block.id);
    }
    for (const candidate of this.pending.values()) {
      positions.set(candidate.block.position, candidate.block.id);
    }
    let previousPosition = -1;
    for (const block of snapshot.blocks) {
      if (
        visible.has(block.id) ||
        block.position <= previousPosition ||
        (positions.has(block.position) &&
          positions.get(block.position) !== block.id)
      ) {
        this.fail("CHATGPT_VISIBLE_OUTPUT_ORDER_CHANGED");
      }
      visible.add(block.id);
      previousPosition = block.position;
      const committed = this.committed.get(block.id);
      if (committed && !sameContent(committed, block)) {
        this.fail("CHATGPT_VISIBLE_OUTPUT_COMMITTED_CHANGED");
      }
      if (!committed && block.position <= this.lastPosition) {
        this.fail("CHATGPT_VISIBLE_OUTPUT_ORDER_CHANGED");
      }
      const candidate = this.pending.get(block.id);
      if (candidate && candidate.block.position !== block.position) {
        this.fail("CHATGPT_VISIBLE_OUTPUT_ORDER_CHANGED");
      }
    }

    const nextPending = new Map(this.pending);
    for (const block of snapshot.blocks) {
      if (this.committed.has(block.id)) continue;
      const previous = nextPending.get(block.id);
      const unchanged =
        previous &&
        this.lastVisible.has(block.id) &&
        sameContent(previous.block, block) &&
        previous.block.complete === block.complete;
      nextPending.set(block.id, {
        block: { ...block },
        changedAt: unchanged ? previous.changedAt : nowMs,
      });
    }
    if (snapshot.terminal) {
      for (const id of nextPending.keys()) {
        if (!visible.has(id)) {
          this.fail("CHATGPT_VISIBLE_OUTPUT_PENDING_MISSING");
        }
      }
    }
    let characters = 0;
    let answerBlocks = 0;
    for (const block of this.committed.values()) {
      characters += block.text.length;
      if (block.channel === "answer") answerBlocks += 1;
    }
    for (const candidate of nextPending.values()) {
      characters += candidate.block.text.length;
      if (candidate.block.channel === "answer") answerBlocks += 1;
    }
    // The normalized answer inserts separators; budget the actual retained
    // output rather than only the fragments supplied by the page.
    characters += Math.max(0, answerBlocks - 1) * 2;
    if (
      characters > this.maximumCharacters ||
      this.committed.size + nextPending.size > this.maximumBlocks
    ) {
      this.fail("CHATGPT_VISIBLE_OUTPUT_LIMIT");
    }

    this.lastObservedAt = nowMs;
    this.lastVisible = visible;
    this.pending.clear();
    for (const [id, candidate] of nextPending) this.pending.set(id, candidate);
    const items: VisibleOutputItem[] = [];
    const ordered = [...this.pending.values()].sort(
      (a, b) => a.block.position - b.block.position,
    );
    for (const candidate of ordered) {
      const block = candidate.block;
      if (
        !visible.has(block.id) ||
        (!snapshot.terminal &&
          (!block.complete || nowMs - candidate.changedAt < this.stabilityMs))
      ) {
        break;
      }
      this.sequence += 1;
      items.push({
        sequence: this.sequence,
        id: block.id,
        channel: block.channel,
        text: block.text,
      });
      this.committed.set(block.id, block);
      this.pending.delete(block.id);
      this.lastPosition = block.position;
      if (block.channel === "answer") {
        this.answer += `${this.answer ? "\n\n" : ""}${block.text}`;
      }
    }
    this.terminal = snapshot.terminal;
    return items;
  }

  private fail(code: VisibleOutputErrorCode): never {
    this.failure = new VisibleOutputError(code);
    throw this.failure;
  }
}
