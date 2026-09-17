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

type HostModel = "farol-next/mind" | "farol-next/drive";

type TurnObservation = {
  itemId: string | null;
  outputText: string;
  deltaCount: number;
  terminal: z.infer<typeof turnCompletedSchema> | null;
  error: Error | null;
};

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

export async function continueCodexChatGptHostThread(
  peer: CodexChatGptHostPeer,
  input: Readonly<{
    model: HostModel;
    threadId: string;
    prompt: string;
    timeoutMs: number;
  }>,
): Promise<
  Readonly<{
    threadId: string;
    turnId: string;
    deltaCount: number;
    observedCharacters: number;
    retainedResult: true;
  }>
> {
  if (
    input.threadId.length < 1 ||
    input.threadId.length > 160 ||
    input.threadId.includes("\0") ||
    input.prompt.length < 1 ||
    input.prompt.length > MAX_PROMPT_CHARACTERS ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1
  ) {
    throw routeError("CODEX_CHATGPT_ROUTE_INPUT_INVALID");
  }

  const observations = new Map<string, TurnObservation>();
  let expectedTurnId: string | null = null;
  let settled = false;
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
  const observation = (turnId: string): TurnObservation | null => {
    const existing = observations.get(turnId);
    if (existing) return existing;
    if (observations.size >= 32) return null;
    const created: TurnObservation = {
      itemId: null,
      outputText: "",
      deltaCount: 0,
      terminal: null,
      error: null,
    };
    observations.set(turnId, created);
    return created;
  };
  const settle = (turnId: string): void => {
    if (settled || turnId !== expectedTurnId) return;
    const candidate = observations.get(turnId);
    if (!candidate) return;
    if (candidate.error) {
      settled = true;
      rejectTerminal(candidate.error);
    } else if (candidate.terminal) {
      settled = true;
      resolveTerminal(candidate.terminal);
    }
  };
  const fail = (candidate: TurnObservation, code: string): void => {
    candidate.error ??= routeError(code);
  };

  const removeDeltaHandler = peer.handleNotification(
    "item/agentMessage/delta",
    (params) => {
      const parsed = agentDeltaSchema.safeParse(params);
      if (!parsed.success || parsed.data.threadId !== input.threadId) return;
      if (expectedTurnId !== null && parsed.data.turnId !== expectedTurnId) {
        return;
      }
      const candidate = observation(parsed.data.turnId);
      if (!candidate) return;
      if (
        candidate.terminal !== null ||
        (candidate.itemId !== null && candidate.itemId !== parsed.data.itemId)
      ) {
        fail(candidate, "CODEX_CHATGPT_HOST_CORRELATION_INVALID");
      } else if (
        candidate.outputText.length + parsed.data.delta.length >
        MAX_RESULT_CHARACTERS
      ) {
        fail(candidate, "CODEX_CHATGPT_HOST_RESULT_TOO_LARGE");
      } else {
        candidate.itemId = parsed.data.itemId;
        candidate.outputText += parsed.data.delta;
        candidate.deltaCount += 1;
      }
      settle(parsed.data.turnId);
    },
  );
  const removeTerminalHandler = peer.handleNotification(
    "turn/completed",
    (params) => {
      const parsed = turnCompletedSchema.safeParse(params);
      if (!parsed.success || parsed.data.threadId !== input.threadId) return;
      if (expectedTurnId !== null && parsed.data.turn.id !== expectedTurnId) {
        return;
      }
      const candidate = observation(parsed.data.turn.id);
      if (!candidate) return;
      if (candidate.terminal !== null) {
        fail(candidate, "CODEX_CHATGPT_HOST_CORRELATION_INVALID");
      } else {
        candidate.terminal = parsed.data;
      }
      settle(parsed.data.turn.id);
    },
  );

  const deadline = Date.now() + input.timeoutMs;
  try {
    const startedTurn = turnStartSchema.safeParse(
      await withTimeout(
        peer.request("turn/start", {
          threadId: input.threadId,
          effort: "low",
          input: [{ type: "text", text: input.prompt }],
        }),
        remaining(deadline),
      ),
    );
    if (!startedTurn.success) {
      throw routeError("CODEX_CHATGPT_HOST_PROTOCOL_INVALID");
    }
    expectedTurnId = startedTurn.data.turn.id;
    for (const turnId of observations.keys()) {
      if (turnId !== expectedTurnId) observations.delete(turnId);
    }
    observation(expectedTurnId);
    settle(expectedTurnId);

    const completed = await withTimeout(terminal, remaining(deadline));
    const observed = observations.get(expectedTurnId);
    if (!observed) {
      throw routeError("CODEX_CHATGPT_HOST_CORRELATION_INVALID");
    }
    if (observed.error) throw observed.error;
    if (completed.turn.status !== "completed") {
      throw routeError(
        completed.turn.status === "failed"
          ? "CODEX_CHATGPT_HOST_FAILED"
          : "CODEX_CHATGPT_HOST_INTERRUPTED",
      );
    }
    if (
      observed.deltaCount < 1 ||
      observed.outputText.length < 1 ||
      observed.itemId === null
    ) {
      throw routeError("CODEX_CHATGPT_INCREMENTAL_DELIVERY_MISSING");
    }

    const retained = retainedThreadSchema.safeParse(
      await withTimeout(
        peer.request("thread/read", {
          threadId: input.threadId,
          includeTurns: true,
        }),
        remaining(deadline),
      ),
    );
    if (
      !retained.success ||
      retained.data.thread.id !== input.threadId ||
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
          item.data.id === observed.itemId &&
          item.data.text === observed.outputText,
      );
    if (retainedTurn?.status !== "completed" || !retainedMessage?.success) {
      throw routeError("CODEX_CHATGPT_RETAINED_RESULT_INVALID");
    }

    return {
      threadId: input.threadId,
      turnId: expectedTurnId,
      deltaCount: observed.deltaCount,
      observedCharacters: observed.outputText.length,
      retainedResult: true,
    };
  } finally {
    removeTerminalHandler();
    removeDeltaHandler();
  }
}

export async function runCodexChatGptHostRoute(
  peer: CodexChatGptHostPeer,
  input: Readonly<{
    model: HostModel;
    cwd: string;
    prompt: string;
    timeoutMs: number;
    dynamicTools?: readonly unknown[];
  }>,
) {
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

  const startedThread = threadStartSchema.safeParse(
    await withTimeout(
      peer.request("thread/start", {
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
      input.timeoutMs,
    ),
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
  const result = await continueCodexChatGptHostThread(peer, {
    model: input.model,
    threadId: startedThread.data.thread.id,
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
  });
  return {
    requestedProvider: "farol_next" as const,
    observedProvider: "farol_next" as const,
    requestedModel: input.model,
    observedModel: input.model,
    ...result,
  };
}
