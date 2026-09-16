import { z } from "zod";

export type CodexAppServerPeer = Readonly<{
  request(method: string, params: unknown): Promise<unknown>;
  handleServerRequest(
    method: string,
    handler: (params: unknown) => Promise<unknown>,
  ): () => void;
  handleNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void;
}>;

const modelListSchema = z
  .object({
    data: z.array(z.object({ id: z.string() }).passthrough()),
    nextCursor: z.string().nullable().optional(),
  })
  .passthrough();

const threadStartSchema = z
  .object({
    model: z.string(),
    thread: z
      .object({
        id: z.string().min(1),
        parentThreadId: z.string().nullable().optional(),
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

const toolCallSchema = z.strictObject({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  namespace: z.string().nullable().optional(),
  tool: z.literal("farol_next_ping"),
  arguments: z.strictObject({ nonce: z.string().min(1).max(120) }),
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

function smokeError(code: string): Error {
  return new Error(code);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(smokeError("CODEX_HOST_SMOKE_TIMEOUT")),
      timeoutMs,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function runCodexHostSmoke(
  peer: CodexAppServerPeer,
  input: Readonly<{
    model: "gpt-6-astra";
    cwd: string;
    nonce: string;
    timeoutMs: number;
  }>,
): Promise<
  Readonly<{
    model: "gpt-6-astra";
    threadState: "completed";
    dynamicToolCalls: 1;
  }>
> {
  if (
    !input.cwd.startsWith("/") ||
    input.cwd.includes("\0") ||
    !/^[a-z0-9-]{1,120}$/u.test(input.nonce) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1
  ) {
    throw smokeError("CODEX_HOST_SMOKE_INPUT_INVALID");
  }

  let cursor: string | null | undefined;
  let modelAvailable = false;
  for (let page = 0; page < 4; page += 1) {
    const response = modelListSchema.safeParse(
      await peer.request("model/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (!response.success) throw smokeError("CODEX_HOST_PROTOCOL_INVALID");
    if (response.data.data.some((model) => model.id === input.model)) {
      modelAvailable = true;
      break;
    }
    cursor = response.data.nextCursor;
    if (!cursor) break;
  }
  if (!modelAvailable) throw smokeError("CODEX_HOST_MODEL_UNAVAILABLE");

  let expectedThreadId: string | null = null;
  let expectedTurnId: string | null = null;
  let observedToolTurnId: string | null = null;
  let dynamicToolCalls = 0;
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
  const fail = (code: string): never => {
    const error = smokeError(code);
    if (!fatalError) {
      fatalError = error;
      rejectTerminal(error);
    }
    throw error;
  };

  const removeToolHandler = peer.handleServerRequest(
    "item/tool/call",
    async (params) => {
      const parsed = toolCallSchema.safeParse(params);
      const call = parsed.success
        ? parsed.data
        : fail("CODEX_HOST_SMOKE_CORRELATION");
      if (
        call.threadId !== expectedThreadId ||
        call.arguments.nonce !== input.nonce ||
        dynamicToolCalls !== 0
      ) {
        fail("CODEX_HOST_SMOKE_CORRELATION");
      }
      observedToolTurnId = call.turnId;
      if (expectedTurnId && observedToolTurnId !== expectedTurnId) {
        fail("CODEX_HOST_SMOKE_CORRELATION");
      }
      dynamicToolCalls += 1;
      return {
        success: true,
        contentItems: [{ type: "inputText", text: "FAROL_NEXT_PING_OK" }],
      };
    },
  );
  const removeTerminalHandler = peer.handleNotification(
    "turn/completed",
    (params) => {
      const parsed = turnCompletedSchema.safeParse(params);
      if (!parsed.success) {
        rejectTerminal(smokeError("CODEX_HOST_PROTOCOL_INVALID"));
        return;
      }
      if (parsed.data.threadId !== expectedThreadId) return;
      terminalCandidate = parsed.data;
      if (expectedTurnId) {
        if (parsed.data.turn.id !== expectedTurnId) {
          rejectTerminal(smokeError("CODEX_HOST_SMOKE_CORRELATION"));
        } else {
          resolveTerminal(parsed.data);
        }
      }
    },
  );

  try {
    const thread = threadStartSchema.safeParse(
      await peer.request("thread/start", {
        model: input.model,
        allowProviderModelFallback: false,
        cwd: input.cwd,
        sandbox: "read-only",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        ephemeral: true,
        historyMode: "paginated",
        runtimeWorkspaceRoots: [],
        selectedCapabilityRoots: [],
        environments: [],
        dynamicTools: [
          {
            type: "function",
            name: "farol_next_ping",
            description:
              "Return the fixed Farol Next host verification marker for the exact supplied nonce.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: { nonce: { type: "string" } },
              required: ["nonce"],
            },
          },
        ],
        baseInstructions:
          "This is a bounded Farol Next native-host verification turn. Follow the user request exactly and do not inspect files or use any tool other than farol_next_ping.",
      }),
    );
    if (
      !thread.success ||
      thread.data.model !== input.model ||
      thread.data.thread.parentThreadId != null
    ) {
      throw smokeError("CODEX_HOST_PROTOCOL_INVALID");
    }
    expectedThreadId = thread.data.thread.id;

    const started = turnStartSchema.safeParse(
      await peer.request("turn/start", {
        threadId: expectedThreadId,
        effort: "low",
        input: [
          {
            type: "text",
            text: `Call farol_next_ping exactly once with nonce ${input.nonce}. Then reply only FAROL_NEXT_HOST_OK. Do not use any other tool.`,
          },
        ],
      }),
    );
    if (!started.success) throw smokeError("CODEX_HOST_PROTOCOL_INVALID");
    expectedTurnId = started.data.turn.id;
    if (observedToolTurnId && observedToolTurnId !== expectedTurnId) {
      throw smokeError("CODEX_HOST_SMOKE_CORRELATION");
    }
    const queuedTerminal = terminalCandidate as z.infer<
      typeof turnCompletedSchema
    > | null;
    if (queuedTerminal) {
      if (queuedTerminal.turn.id !== expectedTurnId) {
        throw smokeError("CODEX_HOST_SMOKE_CORRELATION");
      }
      resolveTerminal(queuedTerminal);
    }

    const completed = await withTimeout(terminal, input.timeoutMs);
    if (fatalError) throw fatalError;
    if (completed.turn.status !== "completed") {
      throw smokeError(
        completed.turn.status === "failed"
          ? "CODEX_HOST_SMOKE_FAILED"
          : "CODEX_HOST_SMOKE_INTERRUPTED",
      );
    }
    if (dynamicToolCalls !== 1) {
      throw smokeError("CODEX_HOST_SMOKE_TOOL_MISSING");
    }
    return {
      model: input.model,
      threadState: "completed",
      dynamicToolCalls: 1,
    };
  } finally {
    removeTerminalHandler();
    removeToolHandler();
  }
}
