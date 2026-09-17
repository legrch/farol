import { z } from "zod";

export type CodexHostCompactionPeer = Readonly<{
  request(method: string, params: unknown): Promise<unknown>;
  handleNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void;
}>;

export type CodexHostCompactionReceipt = Readonly<{
  threadId: string;
  turnId: string;
  itemId: string | null;
  signal: "turn_completed" | "thread_compacted";
}>;

const completionSchema = z.strictObject({
  threadId: z.string().min(1).max(160),
  turnId: z.string().min(1).max(160),
  completedAtMs: z.number().int().nonnegative(),
  item: z
    .object({
      id: z.string().min(1).max(160),
      type: z.literal("contextCompaction"),
    })
    .passthrough(),
});

const legacyCompletionSchema = z.strictObject({
  threadId: z.string().min(1).max(160),
  turnId: z.string().min(1).max(160),
});

const turnCompletionSchema = z.strictObject({
  threadId: z.string().min(1).max(160),
  turn: z
    .object({
      id: z.string().min(1).max(160),
      status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    })
    .passthrough(),
});

function compactionError(code: string): Error {
  return new Error(code);
}

function validThreadId(value: string): boolean {
  return value.length > 0 && value.length <= 160 && !value.includes("\0");
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(compactionError("CODEX_HOST_COMPACTION_TIMEOUT")),
      timeoutMs,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function compactCodexHostThread(
  peer: CodexHostCompactionPeer,
  input: Readonly<{ threadId: string; timeoutMs: number }>,
): Promise<CodexHostCompactionReceipt> {
  if (
    !validThreadId(input.threadId) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 120_000
  ) {
    throw compactionError("CODEX_HOST_COMPACTION_INPUT_INVALID");
  }

  let resolveCompletion: (receipt: CodexHostCompactionReceipt) => void = () =>
    undefined;
  let rejectCompletion: (error: Error) => void = () => undefined;
  let settled = false;
  let completedItem: Readonly<{ turnId: string; itemId: string }> | null = null;
  const completedTurns = new Map<
    string,
    z.infer<typeof turnCompletionSchema>["turn"]
  >();
  const completion = new Promise<CodexHostCompactionReceipt>(
    (resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    },
  );
  const resolve = (receipt: CodexHostCompactionReceipt): void => {
    if (settled) return;
    settled = true;
    resolveCompletion(receipt);
  };
  const reject = (code: string): void => {
    if (settled) return;
    settled = true;
    rejectCompletion(compactionError(code));
  };
  const settleExactTurn = (): void => {
    if (!completedItem) return;
    const turn = completedTurns.get(completedItem.turnId);
    if (!turn) return;
    if (turn.status !== "completed") {
      reject(
        turn.status === "failed"
          ? "CODEX_HOST_COMPACTION_FAILED"
          : "CODEX_HOST_COMPACTION_INTERRUPTED",
      );
      return;
    }
    resolve({
      threadId: input.threadId,
      turnId: completedItem.turnId,
      itemId: completedItem.itemId,
      signal: "turn_completed",
    });
  };
  const removeCompletionHandler = peer.handleNotification(
    "item/completed",
    (params) => {
      const candidate = completionSchema.safeParse(params);
      if (!candidate.success || candidate.data.threadId !== input.threadId) {
        return;
      }
      if (
        completedItem &&
        (completedItem.turnId !== candidate.data.turnId ||
          completedItem.itemId !== candidate.data.item.id)
      ) {
        reject("CODEX_HOST_COMPACTION_CORRELATION_INVALID");
        return;
      }
      completedItem = {
        turnId: candidate.data.turnId,
        itemId: candidate.data.item.id,
      };
      settleExactTurn();
    },
  );
  const removeTurnCompletionHandler = peer.handleNotification(
    "turn/completed",
    (params) => {
      const candidate = turnCompletionSchema.safeParse(params);
      if (!candidate.success || candidate.data.threadId !== input.threadId) {
        return;
      }
      if (completedTurns.has(candidate.data.turn.id)) {
        if (completedItem?.turnId === candidate.data.turn.id) {
          reject("CODEX_HOST_COMPACTION_CORRELATION_INVALID");
        }
        return;
      }
      if (completedTurns.size < 32) {
        completedTurns.set(candidate.data.turn.id, candidate.data.turn);
      }
      settleExactTurn();
    },
  );
  const removeLegacyCompletionHandler = peer.handleNotification(
    "thread/compacted",
    (params) => {
      const candidate = legacyCompletionSchema.safeParse(params);
      if (!candidate.success || candidate.data.threadId !== input.threadId) {
        return;
      }
      resolve({
        threadId: candidate.data.threadId,
        turnId: candidate.data.turnId,
        itemId: null,
        signal: "thread_compacted",
      });
    },
  );
  const deadline = Date.now() + input.timeoutMs;
  try {
    try {
      await withTimeout(
        peer.request("thread/compact/start", { threadId: input.threadId }),
        remaining(deadline),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "CODEX_HOST_COMPACTION_TIMEOUT"
      ) {
        throw error;
      }
      throw compactionError("CODEX_HOST_COMPACTION_REQUEST_FAILED");
    }
    return await withTimeout(completion, remaining(deadline));
  } finally {
    removeLegacyCompletionHandler();
    removeTurnCompletionHandler();
    removeCompletionHandler();
  }
}
