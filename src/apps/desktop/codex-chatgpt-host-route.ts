import path from "node:path";
import { z } from "zod";

const MAX_PROMPT_CHARACTERS = 128 * 1_024;
const MAX_RESULT_CHARACTERS = 256 * 1_024;
const MAX_DYNAMIC_TOOLS = 128;

export type CodexChatGptHostPeer = Readonly<{
  request(method: string, params: unknown): Promise<unknown>;
  handleNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void;
}>;

const threadStartSchema = z
  .object({
    model: z.string(),
    thread: z
      .object({
        id: z.string().min(1),
        parentThreadId: z.string().nullable().optional(),
        modelProvider: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

const turnStartSchema = z
  .object({
    turn: z
      .object({
        id: z.string().min(1),
        status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
      })
      .passthrough(),
  })
  .passthrough();

const agentDeltaSchema = z.strictObject({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  delta: z.string().min(1).max(MAX_RESULT_CHARACTERS),
});

const turnCompletedSchema = z.strictObject({
  threadId: z.string().min(1),
  turn: z
    .object({
      id: z.string().min(1),
      status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    })
    .passthrough(),
});

const retainedThreadSchema = z
  .object({
    thread: z
      .object({
        id: z.string().min(1),
        model: z.string().nullable(),
        modelProvider: z.string().min(1),
        turns: z.array(
          z
            .object({
              id: z.string().min(1),
              status: z.enum([
                "completed",
                "interrupted",
                "failed",
                "inProgress",
              ]),
              items: z.array(z.unknown()),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();

const retainedMessageSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("agentMessage"),
    text: z.string().max(MAX_RESULT_CHARACTERS),
  })
  .passthrough();

function routeError(code: string): Error {
  return new Error(code);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(routeError("CODEX_CHATGPT_ROUTE_TIMEOUT")),
      timeoutMs,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function runCodexChatGptHostRoute(
  peer: CodexChatGptHostPeer,
  input: Readonly<{
    model: "farol-next/mind" | "farol-next/drive";
    cwd: string;
    prompt: string;
    timeoutMs: number;
    dynamicTools?: readonly unknown[];
  }>,
): Promise<
  Readonly<{
    requestedProvider: "farol_next";
    observedProvider: "farol_next";
    requestedModel: "farol-next/mind" | "farol-next/drive";
    observedModel: "farol-next/mind" | "farol-next/drive";
    threadId: string;
    turnId: string;
    deltaCount: number;
    observedCharacters: number;
    retainedResult: true;
  }>
> {
  const dynamicTools = input.dynamicTools ?? [];
  if (
    !path.isAbsolute(input.cwd) ||
    input.cwd.includes("\0") ||
    input.prompt.length < 1 ||
    input.prompt.length > MAX_PROMPT_CHARACTERS ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    dynamicTools.length > MAX_DYNAMIC_TOOLS
  ) {
    throw routeError("CODEX_CHATGPT_ROUTE_INPUT_INVALID");
  }

  let expectedThreadId: string | null = null;
  let expectedTurnId: string | null = null;
  let observedTurnId: string | null = null;
  let observedItemId: string | null = null;
  let outputText = "";
  let deltaCount = 0;
  let terminalCandidate: z.infer<typeof turnCompletedSchema> | null = null;
  let resolveTerminal: (
    value: z.infer<typeof turnCompletedSchema>,
  ) => void = () => undefined;
  let rejectTerminal: (error: Error) => void = () => undefined;
  const terminal = new Promise<z.infer<typeof turnCompletedSchema>>(
    (resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    },
  );
  let fatalError: Error | null = null;
  const fail = (code: string): void => {
    const error = routeError(code);
    if (!fatalError) {
      fatalError = error;
      rejectTerminal(error);
    }
  };

  const removeDeltaHandler = peer.handleNotification(
    "item/agentMessage/delta",
    (params) => {
      const parsed = agentDeltaSchema.safeParse(params);
      if (!parsed.success || parsed.data.threadId !== expectedThreadId) {
        fail("CODEX_CHATGPT_HOST_CORRELATION_INVALID");
        return;
      }
      if (
        (expectedTurnId !== null && parsed.data.turnId !== expectedTurnId) ||
        (observedTurnId !== null && parsed.data.turnId !== observedTurnId) ||
        (observedItemId !== null && parsed.data.itemId !== observedItemId) ||
        terminalCandidate !== null
      ) {
        fail("CODEX_CHATGPT_HOST_CORRELATION_INVALID");
        return;
      }
      if (
        outputText.length + parsed.data.delta.length >
        MAX_RESULT_CHARACTERS
      ) {
        fail("CODEX_CHATGPT_HOST_RESULT_TOO_LARGE");
        return;
      }
      observedTurnId = parsed.data.turnId;
      observedItemId = parsed.data.itemId;
      outputText += parsed.data.delta;
      deltaCount += 1;
    },
  );
  const removeTerminalHandler = peer.handleNotification(
    "turn/completed",
    (params) => {
      const parsed = turnCompletedSchema.safeParse(params);
      if (!parsed.success || parsed.data.threadId !== expectedThreadId) {
        fail("CODEX_CHATGPT_HOST_CORRELATION_INVALID");
        return;
      }
      if (terminalCandidate !== null) {
        fail("CODEX_CHATGPT_HOST_CORRELATION_INVALID");
        return;
      }
      terminalCandidate = parsed.data;
      if (expectedTurnId !== null) {
        if (parsed.data.turn.id !== expectedTurnId) {
          fail("CODEX_CHATGPT_HOST_CORRELATION_INVALID");
        } else {
          resolveTerminal(parsed.data);
        }
      }
    },
  );

  try {
    const startedThread = threadStartSchema.safeParse(
      await peer.request("thread/start", {
        model: input.model,
        modelProvider: "farol_next",
        allowProviderModelFallback: false,
        cwd: input.cwd,
        sandbox: "read-only",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        ephemeral: false,
        historyMode: "paginated",
        runtimeWorkspaceRoots: [],
        selectedCapabilityRoots: [],
        environments: [],
        dynamicTools: structuredClone(dynamicTools),
        baseInstructions:
          "This is an isolated Farol Next provider task. Keep every host tool under this task's native sandbox, approval policy, and exact active registry. Follow the user request without selecting another provider or model.",
      }),
    );
    if (!startedThread.success) {
      throw routeError("CODEX_CHATGPT_HOST_PROTOCOL_INVALID");
    }
    if (
      startedThread.data.model !== input.model ||
      startedThread.data.thread.modelProvider !== "farol_next"
    ) {
      throw routeError("CODEX_CHATGPT_PROVIDER_IDENTITY_CHANGED");
    }
    if (startedThread.data.thread.parentThreadId != null) {
      throw routeError("CODEX_CHATGPT_HOST_PROTOCOL_INVALID");
    }
    expectedThreadId = startedThread.data.thread.id;

    const startedTurn = turnStartSchema.safeParse(
      await peer.request("turn/start", {
        threadId: expectedThreadId,
        effort: "low",
        input: [{ type: "text", text: input.prompt }],
      }),
    );
    if (!startedTurn.success) {
      throw routeError("CODEX_CHATGPT_HOST_PROTOCOL_INVALID");
    }
    expectedTurnId = startedTurn.data.turn.id;
    if (observedTurnId !== null && observedTurnId !== expectedTurnId) {
      throw routeError("CODEX_CHATGPT_HOST_CORRELATION_INVALID");
    }
    const queuedTerminal = terminalCandidate as z.infer<
      typeof turnCompletedSchema
    > | null;
    if (queuedTerminal !== null) {
      if (queuedTerminal.turn.id !== expectedTurnId) {
        throw routeError("CODEX_CHATGPT_HOST_CORRELATION_INVALID");
      }
      resolveTerminal(queuedTerminal);
    }

    const completed = await withTimeout(terminal, input.timeoutMs);
    if (fatalError) throw fatalError;
    if (completed.turn.status !== "completed") {
      throw routeError(
        completed.turn.status === "failed"
          ? "CODEX_CHATGPT_HOST_FAILED"
          : "CODEX_CHATGPT_HOST_INTERRUPTED",
      );
    }
    if (deltaCount < 1 || outputText.length < 1 || observedItemId === null) {
      throw routeError("CODEX_CHATGPT_INCREMENTAL_DELIVERY_MISSING");
    }

    const retained = retainedThreadSchema.safeParse(
      await peer.request("thread/read", {
        threadId: expectedThreadId,
        includeTurns: true,
      }),
    );
    if (
      !retained.success ||
      retained.data.thread.id !== expectedThreadId ||
      retained.data.thread.model !== input.model ||
      retained.data.thread.modelProvider !== "farol_next"
    ) {
      throw routeError("CODEX_CHATGPT_RETAINED_RESULT_INVALID");
    }
    const retainedTurn = retained.data.thread.turns.find(
      (turn) => turn.id === expectedTurnId,
    );
    const retainedMessage = retainedTurn?.items
      .map((item) => retainedMessageSchema.safeParse(item))
      .find(
        (item) =>
          item?.success &&
          item.data.id === observedItemId &&
          item.data.text === outputText,
      );
    if (retainedTurn?.status !== "completed" || !retainedMessage?.success) {
      throw routeError("CODEX_CHATGPT_RETAINED_RESULT_INVALID");
    }

    return {
      requestedProvider: "farol_next",
      observedProvider: "farol_next",
      requestedModel: input.model,
      observedModel: input.model,
      threadId: expectedThreadId,
      turnId: expectedTurnId,
      deltaCount,
      observedCharacters: outputText.length,
      retainedResult: true,
    };
  } finally {
    removeTerminalHandler();
    removeDeltaHandler();
  }
}
