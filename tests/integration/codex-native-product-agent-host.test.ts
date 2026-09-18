import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { AgentComputer } from "../../src/modules/agent/app/port/computer";
import type { AgentSpawnRequest } from "../../src/modules/agent/app/port/agent-host";
import type { DelegatedAgentAuthority } from "../../src/modules/agent/app/port/execution-authority";
import {
  CodexNativeAgentHost,
  type CodexNativeAgentPeer,
} from "../../src/modules/agent/infra/native/codex-native-agent-host";

type RequestHandler = (params: unknown) => Promise<unknown>;
type NotificationHandler = (params: unknown) => void;

const authority: DelegatedAgentAuthority = {
  authorityId: "authority-product-a",
  participantId: "agent-product-a",
  parentParticipantId: "main-product-a",
  role: "agent",
  mutationOwnership: "none",
  ownerId: "owner-desktop",
  sessionId: "session-product-a",
  taskId: "task-product-a",
  taskEpoch: 7,
  computerId: "computer-product-a",
  computerGeneration: 9,
  workspaces: [
    {
      workspaceId: "workspace-product-a",
      mode: "subtree",
      root: "/workspace/product",
      access: "read",
    },
  ],
  excludedPaths: [
    {
      workspaceId: "workspace-product-a",
      path: "/workspace/product/private",
    },
  ],
  capabilities: ["workspace.list", "workspace.read", "workspace.search"],
  network: "none",
  commands: "none",
  expiresAt: 10_000,
};

const productObjective =
  "Find the delegated continuity marker and report the related file path.";

const request: AgentSpawnRequest = {
  identity: {
    assignmentId: "assignment-product-a",
    ownerId: "owner-desktop",
    sessionId: "session-product-a",
    taskId: "task-product-a",
    taskEpoch: 7,
    generation: 1,
  },
  authority,
  focus: { initialPaths: ["/workspace/product/README.md"] },
  intent: {
    kind: "product",
    objective: productObjective,
  },
};

class ProductPeer implements CodexNativeAgentPeer {
  readonly requests: Readonly<{ method: string; params: unknown }>[] = [];
  readonly handlers = new Map<string, RequestHandler>();
  readonly notifications = new Map<string, NotificationHandler>();
  childPrompt = "";
  completed = false;
  childCompleted = false;
  authorityCompleted = false;
  computerItems: unknown[] = [];
  runningChildItems: unknown[] = [];
  failReads = 0;
  extraChildItems: unknown[] = [];
  extraChildTurns: unknown[] = [];
  extraParentTurns: unknown[] = [];
  readonly interruptedThreads = new Set<string>();
  private authorityProof = "";

  handleServerRequest(method: string, handler: RequestHandler): () => void {
    this.handlers.set(method, handler);
    return () => this.handlers.delete(method);
  }

  handleNotification(method: string, handler: NotificationHandler): () => void {
    this.notifications.set(method, handler);
    return () => this.notifications.delete(method);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      return {
        model: "gpt-6-astra",
        thread: { id: "parent-product-a", parentThreadId: null },
      };
    }
    if (method === "turn/start") {
      const text = (params as { input?: readonly { text?: string }[] })
        .input?.[0]?.text;
      this.authorityProof =
        [...(text ?? "").matchAll(/proof ([a-z0-9-]+)/gu)].at(-1)?.[1] ?? "";
      this.childPrompt =
        /FAROL_CHILD_PROMPT_BEGIN\n([\s\S]*?)\nFAROL_CHILD_PROMPT_END/u.exec(
          text ?? "",
        )?.[1] ?? "";
      queueMicrotask(() => this.emitSpawn());
      return {
        turn: { id: "parent-turn-product-a", status: "inProgress", items: [] },
      };
    }
    if (method === "thread/read") {
      if (this.failReads > 0) {
        this.failReads -= 1;
        throw new Error("THREAD_READ_TRANSPORT_LOST");
      }
      const threadId = (params as { threadId?: string }).threadId;
      if (threadId === "child-product-a") return this.childRead();
      if (threadId === "parent-product-a") return this.parentRead();
    }
    if (method === "turn/interrupt") {
      const threadId = (params as { threadId?: string }).threadId;
      if (threadId) this.interruptedThreads.add(threadId);
      return {};
    }
    throw new Error(`UNEXPECTED_REQUEST:${method}`);
  }

  async finish(): Promise<void> {
    const handler = this.handlers.get("item/tool/call");
    if (!handler) throw new Error("TOOL_HANDLER_MISSING");
    const proof =
      /computer proof ([a-f0-9]{64})/u.exec(this.childPrompt)?.[1] ?? "";
    for (const [callId, operation] of [
      [
        "computer-search-a",
        {
          kind: "workspace.search",
          relativePath: ".",
          pattern: "continuity marker",
        },
      ],
      [
        "computer-read-a",
        {
          kind: "workspace.read",
          relativePath: "notes/continuity.md",
        },
      ],
    ] as const) {
      const argumentsValue = {
        assignmentId: request.identity.assignmentId,
        authorityId: authority.authorityId,
        participantId: authority.participantId,
        proof,
        workspaceId: "workspace-product-a",
        operation,
      };
      await expect(
        handler({
          threadId: "child-product-a",
          turnId: "child-turn-product-a",
          callId,
          tool: "farol_agent_computer",
          arguments: argumentsValue,
        }),
      ).resolves.toMatchObject({ success: true });
      this.computerItems.push({
        id: callId,
        type: "dynamicToolCall",
        tool: "farol_agent_computer",
        status: "completed",
        success: true,
        arguments: argumentsValue,
      });
    }

    await expect(
      handler({
        threadId: "parent-product-a",
        turnId: "parent-turn-product-a",
        callId: "authority-product-a",
        tool: "farol_agent_authority",
        arguments: {
          assignmentId: request.identity.assignmentId,
          authorityId: authority.authorityId,
          participantId: authority.participantId,
          role: authority.role,
          proof: this.authorityProof,
        },
      }),
    ).resolves.toMatchObject({ success: true });
    this.authorityCompleted = true;
    this.completed = true;
  }

  private emitSpawn(): void {
    this.notifications.get("item/completed")?.({
      threadId: "parent-product-a",
      turnId: "parent-turn-product-a",
      item: {
        id: "spawn-product-a",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "parent-product-a",
        receiverThreadIds: ["child-product-a"],
        agentsStates: {},
        model: "gpt-6-astra",
        prompt: this.childPrompt,
      },
    });
  }

  private childRead(): unknown {
    return {
      thread: {
        id: "child-product-a",
        parentThreadId: "parent-product-a",
        agentRole: "default",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "parent-product-a",
              depth: 1,
              agent_role: "default",
            },
          },
        },
        status: {
          type:
            this.completed ||
            this.childCompleted ||
            this.interruptedThreads.has("child-product-a")
              ? "idle"
              : "active",
        },
        turns: [
          {
            id: "child-turn-product-a",
            status: this.completed
              ? "completed"
              : this.childCompleted
                ? "completed"
                : this.interruptedThreads.has("child-product-a")
                  ? "interrupted"
                  : "inProgress",
            items: this.completed
              ? [
                  ...this.computerItems,
                  ...this.extraChildItems,
                  {
                    id: "answer-product-a",
                    type: "agentMessage",
                    text: "notes/continuity.md",
                  },
                ]
              : this.runningChildItems,
          },
          ...this.extraChildTurns,
        ],
      },
    };
  }

  private parentRead(): unknown {
    const items = this.completed
      ? [
          {
            id: "spawn-product-a",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "parent-product-a",
            receiverThreadIds: ["child-product-a"],
            agentsStates: {},
            prompt: this.childPrompt,
          },
          {
            id: "wait-product-a",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            senderThreadId: "parent-product-a",
            receiverThreadIds: ["child-product-a"],
            agentsStates: {},
          },
          ...(this.authorityCompleted
            ? [
                {
                  id: "authority-product-a",
                  type: "dynamicToolCall",
                  tool: "farol_agent_authority",
                  status: "completed",
                  success: true,
                  arguments: {
                    assignmentId: request.identity.assignmentId,
                    authorityId: authority.authorityId,
                    participantId: authority.participantId,
                    role: authority.role,
                    proof: this.authorityProof,
                  },
                },
              ]
            : []),
        ]
      : [];
    return {
      thread: {
        id: "parent-product-a",
        parentThreadId: null,
        agentRole: null,
        source: "appServer",
        status: {
          type:
            this.completed || this.interruptedThreads.has("parent-product-a")
              ? "idle"
              : "active",
        },
        turns: [
          {
            id: "parent-turn-product-a",
            status: this.completed
              ? "completed"
              : this.interruptedThreads.has("parent-product-a")
                ? "interrupted"
                : "inProgress",
            items,
          },
          ...this.extraParentTurns,
        ],
      },
    };
  }
}

describe("native Codex product Agent host", () => {
  it("interrupts the exact running child and parent before confirming cancellation", async () => {
    const peer = new ProductPeer();
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-product-a",
        now: () => 1,
      },
      { verify: async () => ({ status: "verified" }) },
      { execute: vi.fn() },
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    expect(spawned.correlation).toMatchObject({
      parentTurnId: "parent-turn-product-a",
      childTurnId: "child-turn-product-a",
    });

    await expect(host.cancel(spawned.correlation)).resolves.toEqual({
      status: "cancelled",
      correlation: spawned.correlation,
    });
    expect(
      peer.requests
        .filter(({ method }) => method === "turn/interrupt")
        .map(({ params }) => (params as { threadId: string }).threadId),
    ).toEqual(["child-product-a", "parent-product-a"]);
  });

  it("interrupts only the correlated turns when newer turns exist", async () => {
    const peer = new ProductPeer();
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-product-a",
        now: () => 1,
      },
      { verify: async () => ({ status: "verified" }) },
      { execute: vi.fn() },
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    peer.extraChildTurns.push({
      id: "child-turn-foreign",
      status: "inProgress",
      items: [],
    });
    peer.extraParentTurns.push({
      id: "parent-turn-foreign",
      status: "inProgress",
      items: [],
    });

    await expect(host.cancel(spawned.correlation)).resolves.toEqual({
      status: "cancelled",
      correlation: spawned.correlation,
    });
    expect(
      peer.requests
        .filter(({ method }) => method === "turn/interrupt")
        .map(({ params }) => params),
    ).toEqual([
      { threadId: "child-product-a", turnId: "child-turn-product-a" },
      { threadId: "parent-product-a", turnId: "parent-turn-product-a" },
    ]);
  });

  it("finishes an exact cancellation after a previously interrupted child", async () => {
    const peer = new ProductPeer();
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-product-a",
        now: () => 1,
      },
      { verify: async () => ({ status: "verified" }) },
      { execute: vi.fn() },
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    peer.interruptedThreads.add("child-product-a");

    await expect(host.cancel(spawned.correlation)).resolves.toEqual({
      status: "cancelled",
      correlation: spawned.correlation,
    });
    expect(
      peer.requests
        .filter(({ method }) => method === "turn/interrupt")
        .map(({ params }) => (params as { threadId: string }).threadId),
    ).toEqual(["parent-product-a"]);
  });

  it("interrupts the parent after the correlated child already completed", async () => {
    const peer = new ProductPeer();
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-product-a",
        now: () => 1,
      },
      { verify: async () => ({ status: "verified" }) },
      { execute: vi.fn() },
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    peer.childCompleted = true;

    await expect(host.cancel(spawned.correlation)).resolves.toEqual({
      status: "cancelled",
      correlation: spawned.correlation,
    });
    expect(
      peer.requests
        .filter(({ method }) => method === "turn/interrupt")
        .map(({ params }) => (params as { threadId: string }).threadId),
    ).toEqual(["parent-product-a"]);
  });

  it("aborts an in-flight Computer call before interrupt confirmation", async () => {
    const peer = new ProductPeer();
    let executionSignal: AbortSignal | undefined;
    const computer: AgentComputer = {
      execute: vi.fn<AgentComputer["execute"]>(
        (input) =>
          new Promise<never>((_, reject) => {
            executionSignal = input.signal;
            input.signal?.addEventListener(
              "abort",
              () => reject(new Error("COMPUTER_ABORTED")),
              { once: true },
            );
          }),
      ),
    };
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-product-a",
        now: () => 1,
      },
      { verify: async () => ({ status: "verified" }) },
      computer,
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    const handler = peer.handlers.get("item/tool/call");
    if (!handler) throw new Error("TOOL_HANDLER_MISSING");
    const proof =
      /computer proof ([a-f0-9]{64})/u.exec(peer.childPrompt)?.[1] ?? "";
    const inFlight = handler({
      threadId: "child-product-a",
      turnId: "child-turn-product-a",
      callId: "computer-cancel-a",
      tool: "farol_agent_computer",
      arguments: {
        assignmentId: request.identity.assignmentId,
        authorityId: authority.authorityId,
        participantId: authority.participantId,
        proof,
        workspaceId: "workspace-product-a",
        operation: { kind: "workspace.read", relativePath: "README.md" },
      },
    });
    await vi.waitFor(() => expect(executionSignal).toBeInstanceOf(AbortSignal));
    const rejectedComputerCall = expect(inFlight).rejects.toThrow(
      "CODEX_AGENT_COMPUTER_FAILED",
    );

    await expect(host.cancel(spawned.correlation)).resolves.toEqual({
      status: "cancelled",
      correlation: spawned.correlation,
    });
    expect(executionSignal?.aborted).toBe(true);
    await rejectedComputerCall;
  });

  it("runs a bounded product objective through inherited Computer authority", async () => {
    const peer = new ProductPeer();
    const computer: AgentComputer = {
      execute: vi.fn(async (input) =>
        input.operation.kind === "workspace.search"
          ? {
              status: "completed" as const,
              output: {
                kind: "workspace.matches" as const,
                matches: [
                  {
                    path: "notes/continuity.md",
                    line: 4,
                    text: "delegated continuity marker",
                    truncated: false,
                  },
                ],
                resultLimited: false,
                scanLimited: false,
              },
            }
          : {
              status: "completed" as const,
              output: {
                kind: "workspace.text" as const,
                text: "delegated continuity marker",
                bytes: 27,
              },
            },
      ),
    };
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-product-a",
        now: () => 1,
      },
      { verify: async () => ({ status: "verified" }) },
      computer,
    );

    const spawned = await host.spawn(request);
    expect(
      (
        peer.requests.find(({ method }) => method === "thread/start")
          ?.params as { dynamicTools?: readonly { name?: string }[] }
      ).dynamicTools?.map(({ name }) => name),
    ).toEqual(["farol_agent_authority", "farol_agent_computer"]);
    expect(peer.childPrompt).toContain("FAROL_NATIVE_AGENT_TASK_V2");
    expect(peer.childPrompt).toContain(productObjective);
    expect(peer.childPrompt).toContain('"mode":"subtree"');
    expect(peer.childPrompt).toContain('"root":"/workspace/product"');
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");

    await expect(host.wait(spawned.correlation)).resolves.toMatchObject({
      status: "running",
      correlation: spawned.correlation,
    });
    await peer.finish();
    await expect(host.wait(spawned.correlation)).resolves.toEqual({
      status: "completed",
      correlation: {
        ...spawned.correlation,
        delegationDigest: createHash("sha256")
          .update(peer.childPrompt)
          .digest("hex"),
      },
      resultRef:
        "codex-app-server://thread/child-product-a/turn/child-turn-product-a",
      workspaceEnforcement: "verified",
    });
    expect(computer.execute).toHaveBeenCalledTimes(2);
    expect(computer.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        identity: request.identity,
        authority,
        threadId: "child-product-a",
        callId: "computer-search-a",
        operation: {
          kind: "workspace.search",
          relativePath: ".",
          pattern: "continuity marker",
        },
      }),
    );
    expect(computer.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        operation: {
          kind: "workspace.read",
          relativePath: "notes/continuity.md",
        },
      }),
    );

    host.dispose();
    const rejoined = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "unused",
        now: () => 2,
      },
      { verify: async () => ({ status: "verified" }) },
      computer,
    );
    await expect(rejoined.wait(spawned.correlation)).resolves.toMatchObject({
      status: "completed",
      correlation: spawned.correlation,
    });
    expect(
      peer.requests.filter(({ method }) => method === "thread/start"),
    ).toHaveLength(1);
  });

  it("retains the exact completed child turn when newer history exists", async () => {
    const peer = new ProductPeer();
    const computer: AgentComputer = {
      execute: vi.fn(async (input) =>
        input.operation.kind === "workspace.search"
          ? {
              status: "completed" as const,
              output: {
                kind: "workspace.matches" as const,
                matches: [],
                resultLimited: false,
                scanLimited: false,
              },
            }
          : {
              status: "completed" as const,
              output: {
                kind: "workspace.text" as const,
                text: "marker",
                bytes: 6,
              },
            },
      ),
    };
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-product-a",
        now: () => 1,
      },
      { verify: async () => ({ status: "verified" }) },
      computer,
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    await peer.finish();
    peer.extraChildTurns.push({
      id: "child-turn-foreign-completed",
      status: "completed",
      items: [{ id: "foreign-answer", type: "agentMessage", text: "foreign" }],
    });

    await expect(host.wait(spawned.correlation)).resolves.toMatchObject({
      status: "completed",
      resultRef:
        "codex-app-server://thread/child-product-a/turn/child-turn-product-a",
    });
  });

  it("describes exact-file authority without promising subtree discovery", async () => {
    const peer = new ProductPeer();
    const exactAuthority: DelegatedAgentAuthority = {
      ...authority,
      workspaces: [
        {
          workspaceId: "workspace-product-a",
          mode: "exact",
          root: "/workspace/product",
          paths: ["/workspace/product/README.md"],
          access: "read",
        },
      ],
      capabilities: ["workspace.read"],
      commands: "none",
    };
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-product-a",
        now: () => 1,
      },
      { verify: async () => ({ status: "verified" }) },
      { execute: vi.fn() },
    );

    await expect(
      host.spawn({
        ...request,
        authority: exactAuthority,
        focus: { initialPaths: ["/workspace/product/README.md"] },
      }),
    ).resolves.toMatchObject({ status: "started" });
    expect(peer.childPrompt).toContain('"mode":"exact"');
    expect(peer.childPrompt).toContain(
      "Initial paths are the exact file authority boundary.",
    );
    expect(peer.childPrompt).toContain(
      "Use only these operations allowed by the supplied TaskGrant: workspace.read.",
    );
    expect(peer.childPrompt).toContain(
      "verification.run is not granted for this assignment.",
    );
    expect(peer.childPrompt).not.toContain("discover other relevant files");
  });

  it("rejects foreign Computer correlation before inherited authority runs", async () => {
    const peer = new ProductPeer();
    const computer: AgentComputer = { execute: vi.fn() };
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-product-a",
        now: () => 1,
      },
      { verify: async () => ({ status: "verified" }) },
      computer,
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    const handler = peer.handlers.get("item/tool/call");
    if (!handler) throw new Error("TOOL_HANDLER_MISSING");
    const proof =
      /computer proof ([a-f0-9]{64})/u.exec(peer.childPrompt)?.[1] ?? "";

    await expect(
      handler({
        threadId: "child-product-a",
        turnId: "child-turn-product-a",
        callId: "foreign-call-a",
        tool: "farol_agent_computer",
        arguments: {
          assignmentId: request.identity.assignmentId,
          authorityId: authority.authorityId,
          participantId: "foreign-agent",
          proof,
          workspaceId: "workspace-product-a",
          operation: { kind: "workspace.list", relativePath: "." },
        },
      }),
    ).rejects.toThrow("CODEX_AGENT_COMPUTER_CORRELATION");
    expect(computer.execute).not.toHaveBeenCalled();
    await expect(host.wait(spawned.correlation)).resolves.toMatchObject({
      status: "outcome_unknown",
      code: "AGENT_WAIT_ACK_LOST",
    });
  });

  it("rejects a Computer call from another turn in the correlated child", async () => {
    const peer = new ProductPeer();
    const computer: AgentComputer = { execute: vi.fn() };
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-product-a",
        now: () => 1,
      },
      { verify: async () => ({ status: "verified" }) },
      computer,
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    const handler = peer.handlers.get("item/tool/call");
    if (!handler) throw new Error("TOOL_HANDLER_MISSING");
    const proof =
      /computer proof ([a-f0-9]{64})/u.exec(peer.childPrompt)?.[1] ?? "";

    await expect(
      handler({
        threadId: "child-product-a",
        turnId: "child-turn-foreign",
        callId: "foreign-turn-call-a",
        tool: "farol_agent_computer",
        arguments: {
          assignmentId: request.identity.assignmentId,
          authorityId: authority.authorityId,
          participantId: authority.participantId,
          proof,
          workspaceId: "workspace-product-a",
          operation: { kind: "workspace.read", relativePath: "README.md" },
        },
      }),
    ).rejects.toThrow("CODEX_AGENT_COMPUTER_CORRELATION");
    expect(computer.execute).not.toHaveBeenCalled();
  });

  it("accepts only inherited fixed verification through Farol Computer", async () => {
    const peer = new ProductPeer();
    const verificationAuthority: DelegatedAgentAuthority = {
      ...authority,
      capabilities: [...authority.capabilities, "verification.run"],
      commands: "verification",
    };
    const verificationRequest: AgentSpawnRequest = {
      ...request,
      authority: verificationAuthority,
    };
    const computer: AgentComputer = {
      execute: vi.fn(async () => ({
        status: "completed" as const,
        output: {
          kind: "workspace.command" as const,
          command: "git.head" as const,
          relativePath: "." as const,
          exitCode: 0 as const,
          stdout: `${"a".repeat(40)}\n`,
          stderr: "" as const,
          outputBytes: 41,
          network: "none" as const,
          coverage: "head-commit" as const,
          layout: "primary" as const,
        },
      })),
    };
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-product-a",
        now: () => 1,
      },
      { verify: async () => ({ status: "verified" }) },
      computer,
    );
    const spawned = await host.spawn(verificationRequest);
    expect(spawned.status).toBe("started");
    const handler = peer.handlers.get("item/tool/call");
    if (!handler) throw new Error("TOOL_HANDLER_MISSING");
    const proof =
      /computer proof ([a-f0-9]{64})/u.exec(peer.childPrompt)?.[1] ?? "";

    await expect(
      handler({
        threadId: "child-product-a",
        turnId: "child-turn-product-a",
        callId: "computer-head-a",
        tool: "farol_agent_computer",
        arguments: {
          assignmentId: verificationRequest.identity.assignmentId,
          authorityId: verificationAuthority.authorityId,
          participantId: verificationAuthority.participantId,
          proof,
          workspaceId: "workspace-product-a",
          operation: {
            kind: "verification.run",
            command: "git.head",
            relativePath: ".",
          },
        },
      }),
    ).resolves.toMatchObject({ success: true });
    expect(computer.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: verificationAuthority,
        operation: {
          kind: "verification.run",
          command: "git.head",
          relativePath: ".",
        },
      }),
    );
  });

  it("C05-06 forwards a read window and Git status through inherited Computer authority", async () => {
    const peer = new ProductPeer();
    const verificationAuthority: DelegatedAgentAuthority = {
      ...authority,
      capabilities: [...authority.capabilities, "verification.run"],
      commands: "verification",
    };
    const verificationRequest: AgentSpawnRequest = {
      ...request,
      authority: verificationAuthority,
    };
    const computer: AgentComputer = {
      execute: vi.fn(async (input) =>
        input.operation.kind === "verification.run"
          ? {
              status: "completed" as const,
              output: {
                kind: "workspace.command" as const,
                command: "git.status" as const,
                relativePath: "." as const,
                exitCode: 0 as const,
                stdout: " M README.md\n",
                stderr: "" as const,
                outputBytes: 13,
                network: "none" as const,
                coverage: "tracked-files-only" as const,
                layout: "primary" as const,
              },
            }
          : {
              status: "completed" as const,
              output: {
                kind: "workspace.text" as const,
                text: "abcd",
                bytes: 4,
                page: { offset: 8, size: 300_000, nextOffset: 12 },
              },
            },
      ),
    };
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-product-a",
        now: () => 1,
      },
      { verify: async () => ({ status: "verified" }) },
      computer,
    );
    const spawned = await host.spawn(verificationRequest);
    expect(spawned.status).toBe("started");
    const computerTool = (
      peer.requests.find(({ method }) => method === "thread/start")?.params as {
        dynamicTools?: readonly { name?: string; inputSchema?: unknown }[];
      }
    ).dynamicTools?.find(({ name }) => name === "farol_agent_computer");
    expect(JSON.stringify(computerTool?.inputSchema)).toContain('"range"');
    const handler = peer.handlers.get("item/tool/call");
    if (!handler) throw new Error("TOOL_HANDLER_MISSING");
    const proof =
      /computer proof ([a-f0-9]{64})/u.exec(peer.childPrompt)?.[1] ?? "";
    const call = (callId: string, operation: unknown) =>
      handler({
        threadId: "child-product-a",
        turnId: "child-turn-product-a",
        callId,
        tool: "farol_agent_computer",
        arguments: {
          assignmentId: verificationRequest.identity.assignmentId,
          authorityId: verificationAuthority.authorityId,
          participantId: verificationAuthority.participantId,
          proof,
          workspaceId: "workspace-product-a",
          operation,
        },
      });

    const windowed = (await call("computer-window-a", {
      kind: "workspace.read",
      relativePath: "logs/large.log",
      range: { offset: 8, length: 4 },
    })) as { success: boolean; contentItems: { text: string }[] };
    expect(windowed.success).toBe(true);
    expect(JSON.parse(windowed.contentItems[0]?.text ?? "")).toEqual({
      status: "completed",
      output: {
        kind: "workspace.text",
        text: "abcd",
        bytes: 4,
        page: { offset: 8, size: 300_000, nextOffset: 12 },
      },
    });
    await expect(
      call("computer-status-a", {
        kind: "verification.run",
        command: "git.status",
        relativePath: ".",
      }),
    ).resolves.toMatchObject({ success: true });
    expect(computer.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        authority: verificationAuthority,
        operation: {
          kind: "workspace.read",
          relativePath: "logs/large.log",
          range: { offset: 8, length: 4 },
        },
      }),
    );
    expect(computer.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        operation: {
          kind: "verification.run",
          command: "git.status",
          relativePath: ".",
        },
      }),
    );

    // A window shorter than one UTF-8 character is refused before Computer.
    await expect(
      call("computer-window-b", {
        kind: "workspace.read",
        relativePath: "logs/large.log",
        range: { offset: 0, length: 3 },
      }),
    ).rejects.toThrow("CODEX_AGENT_COMPUTER_CORRELATION");
    expect(computer.execute).toHaveBeenCalledTimes(2);
  });

  it("rejects completed child history containing a direct native command", async () => {
    const peer = new ProductPeer();
    const computer: AgentComputer = {
      execute: vi.fn(async (input) =>
        input.operation.kind === "workspace.search"
          ? {
              status: "completed" as const,
              output: {
                kind: "workspace.matches" as const,
                matches: [],
                resultLimited: false,
                scanLimited: false,
              },
            }
          : {
              status: "completed" as const,
              output: {
                kind: "workspace.text" as const,
                text: "marker",
                bytes: 6,
              },
            },
      ),
    };
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-product-a",
        now: () => 1,
      },
      { verify: async () => ({ status: "verified" }) },
      computer,
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    peer.extraChildItems.push({
      id: "direct-command-a",
      type: "commandExecution",
      command: "cat private/secret.txt",
      status: "completed",
    });
    await peer.finish();

    await expect(host.wait(spawned.correlation)).resolves.toMatchObject({
      status: "outcome_unknown",
      code: "AGENT_WAIT_ACK_LOST",
    });
  });

  describe("LIF-03 an in-progress child tool call is running work", () => {
    function runningComputerItem(
      peer: ProductPeer,
      overrides: Readonly<Record<string, unknown>> = {},
    ): unknown {
      return {
        id: "computer-running-a",
        type: "dynamicToolCall",
        tool: "farol_agent_computer",
        status: "inProgress",
        success: null,
        arguments: {
          assignmentId: request.identity.assignmentId,
          authorityId: authority.authorityId,
          participantId: authority.participantId,
          proof:
            /computer proof ([a-f0-9]{64})/u.exec(peer.childPrompt)?.[1] ?? "",
          workspaceId: "workspace-product-a",
          operation: { kind: "workspace.read", relativePath: "README.md" },
          ...overrides,
        },
      };
    }

    const completingComputer: AgentComputer = {
      execute: vi.fn(async (input) =>
        input.operation.kind === "workspace.search"
          ? {
              status: "completed" as const,
              output: {
                kind: "workspace.matches" as const,
                matches: [],
                resultLimited: false,
                scanLimited: false,
              },
            }
          : {
              status: "completed" as const,
              output: {
                kind: "workspace.text" as const,
                text: "continuity marker\n",
                bytes: 18,
              },
            },
      ),
    };

    function host(
      peer: ProductPeer,
      computer: AgentComputer = { execute: vi.fn() },
    ): CodexNativeAgentHost {
      return new CodexNativeAgentHost(
        peer,
        {
          model: "gpt-6-astra",
          runtimeRoot: "/private/tmp/farol-agent-runtime",
          spawnTimeoutMs: 1_000,
          waitTimeoutMs: 5,
          pollIntervalMs: 1,
          nonce: () => "proof-product-a",
          now: () => 1,
        },
        { verify: async () => ({ status: "verified" }) },
        computer,
      );
    }

    it("reports running while the child's Computer call is in progress", async () => {
      const peer = new ProductPeer();
      const agentHost = host(peer);
      const spawned = await agentHost.spawn(request);
      if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
      peer.runningChildItems = [runningComputerItem(peer)];

      await expect(agentHost.wait(spawned.correlation)).resolves.toEqual({
        status: "running",
        correlation: spawned.correlation,
      });
    });

    it("still refuses an in-progress call carrying foreign authority", async () => {
      const peer = new ProductPeer();
      const agentHost = host(peer);
      const spawned = await agentHost.spawn(request);
      if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
      peer.runningChildItems = [
        runningComputerItem(peer, { assignmentId: "assignment-foreign" }),
      ];

      await expect(agentHost.wait(spawned.correlation)).resolves.toEqual({
        status: "outcome_unknown",
        correlation: spawned.correlation,
        code: "AGENT_WAIT_ACK_LOST",
      });
    });

    it("refuses a completed child turn that still holds an in-progress call", async () => {
      const peer = new ProductPeer();
      const agentHost = host(peer, completingComputer);
      const spawned = await agentHost.spawn(request);
      if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
      await peer.finish();
      peer.extraChildItems = [runningComputerItem(peer)];

      await expect(agentHost.wait(spawned.correlation)).resolves.toEqual({
        status: "outcome_unknown",
        correlation: spawned.correlation,
        code: "AGENT_WAIT_ACK_LOST",
      });
    });
  });

  describe("LIF-05 and LIF-06 a fresh host observes the same child", () => {
    const completingComputer: AgentComputer = {
      execute: vi.fn(async (input) =>
        input.operation.kind === "workspace.search"
          ? {
              status: "completed" as const,
              output: {
                kind: "workspace.matches" as const,
                matches: [],
                resultLimited: false,
                scanLimited: false,
              },
            }
          : {
              status: "completed" as const,
              output: {
                kind: "workspace.text" as const,
                text: "continuity marker\n",
                bytes: 18,
              },
            },
      ),
    };

    function productHost(
      peer: ProductPeer,
      computer: AgentComputer = completingComputer,
    ): CodexNativeAgentHost {
      return new CodexNativeAgentHost(
        peer,
        {
          model: "gpt-6-astra",
          runtimeRoot: "/private/tmp/farol-agent-runtime",
          spawnTimeoutMs: 1_000,
          waitTimeoutMs: 5,
          pollIntervalMs: 1,
          nonce: () => "proof-product-a",
          now: () => 1,
        },
        { verify: async () => ({ status: "verified" }) },
        computer,
      );
    }

    it("reports a transient read failure as unobserved, not unknown", async () => {
      const peer = new ProductPeer();
      const host = productHost(peer);
      const spawned = await host.spawn(request);
      if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
      peer.failReads = 1;

      await expect(host.wait(spawned.correlation)).resolves.toEqual({
        status: "unobserved",
        correlation: spawned.correlation,
      });
      await expect(host.wait(spawned.correlation)).resolves.toEqual({
        status: "running",
        correlation: spawned.correlation,
      });
    });

    it("serves the still-running child's calls and completes without a second spawn", async () => {
      const peer = new ProductPeer();
      const first = productHost(peer);
      const spawned = await first.spawn(request);
      if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
      expect(spawned.authorityProof).toBe("proof-product-a");
      const authorityProof = spawned.authorityProof;
      if (!authorityProof) throw new Error("PROOF_MISSING");
      // The first process is gone: its handlers went with it.
      first.dispose();

      const second = productHost(peer);
      const rejoin = { request, authorityProof };
      await expect(second.wait(spawned.correlation, rejoin)).resolves.toEqual({
        status: "running",
        correlation: spawned.correlation,
      });
      await peer.finish();
      await expect(
        second.wait(spawned.correlation, rejoin),
      ).resolves.toMatchObject({
        status: "completed",
        correlation: spawned.correlation,
      });
      expect(
        peer.requests.filter(({ method }) => method === "thread/start"),
      ).toHaveLength(1);
    });

    it("refuses to attach a rejoin whose request does not produce the recorded delegation", async () => {
      const peer = new ProductPeer();
      const first = productHost(peer);
      const spawned = await first.spawn(request);
      if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
      first.dispose();

      await expect(
        productHost(peer).wait(spawned.correlation, {
          request: {
            ...request,
            intent: { kind: "product", objective: "A different objective." },
          },
          authorityProof: spawned.authorityProof ?? "proof-product-a",
        }),
      ).resolves.toEqual({
        status: "outcome_unknown",
        correlation: spawned.correlation,
        code: "AGENT_WAIT_ACK_LOST",
      });
      expect(peer.handlers.has("item/tool/call")).toBe(false);
    });
  });
});
