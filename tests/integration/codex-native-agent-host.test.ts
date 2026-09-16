import { describe, expect, it } from "vitest";

import type { AgentSpawnRequest } from "../../src/modules/agent/app/port/agent-host";
import type { DelegatedAgentAuthority } from "../../src/modules/agent/app/port/execution-authority";
import {
  CodexNativeAgentHost,
  type CodexNativeAgentPeer,
} from "../../src/modules/agent/infra/native/codex-native-agent-host";

type RequestHandler = (params: unknown) => Promise<unknown>;
type NotificationHandler = (params: unknown) => void;
type AuthorityCall = Readonly<{
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: Readonly<{
    assignmentId: string;
    authorityId: string;
    participantId: string;
    role: string;
    proof: string;
  }>;
}>;

const authority: DelegatedAgentAuthority = {
  authorityId: "authority-agent-a",
  participantId: "critic-a",
  parentParticipantId: "main-a",
  role: "critic",
  mutationOwnership: "none",
  ownerId: "owner-a",
  sessionId: "session-a",
  taskId: "task-a",
  taskEpoch: 3,
  computerId: "computer-a",
  computerGeneration: 7,
  workspaces: [
    {
      workspaceId: "farol",
      mode: "subtree",
      root: "/workspace/farol",
      access: "read",
    },
  ],
  excludedPaths: [{ workspaceId: "farol", path: "/workspace/farol/private" }],
  capabilities: ["workspace.list", "workspace.read", "workspace.search"],
  network: "none",
  commands: "none",
  expiresAt: 10_000,
};

const request: AgentSpawnRequest = {
  identity: {
    assignmentId: "assignment-a",
    ownerId: "owner-a",
    sessionId: "session-a",
    taskId: "task-a",
    taskEpoch: 3,
    generation: 5,
  },
  authority,
  focus: { initialPaths: ["/workspace/farol/README.md"] },
};

class NativeAgentPeer implements CodexNativeAgentPeer {
  readonly requests: Readonly<{ method: string; params: unknown }>[] = [];
  readonly handlers = new Map<string, RequestHandler>();
  readonly notifications = new Map<string, NotificationHandler>();
  completed = false;
  failed = false;
  authorityCompleted = false;
  waitCompleted = false;
  private nonce = "";

  constructor(private readonly emitSpawnOnTurnStart = true) {}

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
      const input = params as {
        dynamicTools?: readonly { name?: string }[];
      };
      expect(input).toMatchObject({
        model: "gpt-6-astra",
        allowProviderModelFallback: false,
        sandbox: "read-only",
        approvalPolicy: "never",
        cwd: "/private/tmp/farol-agent-runtime",
        runtimeWorkspaceRoots: [],
        selectedCapabilityRoots: [],
        environments: [],
      });
      expect(input.dynamicTools).toEqual([
        expect.objectContaining({ name: "farol_agent_authority" }),
      ]);
      return {
        model: "gpt-6-astra",
        thread: { id: "parent-thread-a", parentThreadId: null },
      };
    }
    if (method === "turn/start") {
      const text = (params as { input?: readonly { text?: string }[] })
        .input?.[0]?.text;
      this.nonce = /proof ([a-z0-9-]+)/u.exec(text ?? "")?.[1] ?? "";
      if (this.emitSpawnOnTurnStart) queueMicrotask(() => this.emitSpawn());
      return {
        turn: { id: "parent-turn-a", status: "inProgress", items: [] },
      };
    }
    if (method === "thread/read") {
      const threadId = (params as { threadId?: string }).threadId;
      if (threadId === "child-thread-a") return this.childRead();
      if (threadId === "parent-thread-a") return this.parentRead();
    }
    throw new Error(`UNEXPECTED_REQUEST:${method}`);
  }

  async callAuthority(
    overrides: Partial<AuthorityCall> = {},
  ): Promise<unknown> {
    const handler = this.handlers.get("item/tool/call");
    if (!handler) throw new Error("AUTHORITY_HANDLER_MISSING");
    const result = await handler({
      threadId: "child-thread-a",
      turnId: "child-turn-a",
      callId: "authority-call-a",
      tool: "farol_agent_authority",
      arguments: {
        assignmentId: request.identity.assignmentId,
        authorityId: authority.authorityId,
        participantId: authority.participantId,
        role: authority.role,
        proof: this.nonce,
      },
      ...overrides,
    });
    this.authorityCompleted = true;
    return result;
  }

  async finish(
    options: Readonly<{
      authority?: boolean;
      wait?: boolean;
      failed?: boolean;
    }> = {},
  ): Promise<void> {
    if (options.authority !== false) {
      await expect(this.callAuthority()).resolves.toEqual({
        success: true,
        contentItems: [{ type: "inputText", text: "FAROL_AGENT_AUTHORITY_OK" }],
      });
    }
    this.completed = true;
    this.failed = options.failed ?? false;
    this.waitCompleted = options.wait ?? true;
    if (this.waitCompleted) {
      this.notifications.get("item/completed")?.({
        threadId: "parent-thread-a",
        turnId: "parent-turn-a",
        completedAtMs: 2,
        item: {
          id: "wait-a",
          type: "collabAgentToolCall",
          tool: "wait",
          status: "completed",
          senderThreadId: "parent-thread-a",
          receiverThreadIds: ["child-thread-a"],
          agentsStates: {
            "child-thread-a": {
              status: this.failed ? "failed" : "completed",
            },
          },
        },
      });
    }
    this.notifications.get("turn/completed")?.({
      threadId: "child-thread-a",
      turn: {
        id: "child-turn-a",
        status: this.failed ? "failed" : "completed",
        items: [],
      },
    });
    this.notifications.get("turn/completed")?.({
      threadId: "parent-thread-a",
      turn: { id: "parent-turn-a", status: "completed", items: [] },
    });
  }

  private authorityItem(): unknown {
    return {
      id: "authority-call-a",
      type: "dynamicToolCall",
      tool: "farol_agent_authority",
      status: "completed",
      success: true,
      arguments: {
        assignmentId: request.identity.assignmentId,
        authorityId: authority.authorityId,
        participantId: authority.participantId,
        role: authority.role,
        proof: this.nonce,
      },
    };
  }

  private emitSpawn(): void {
    this.notifications.get("item/completed")?.({
      threadId: "parent-thread-a",
      turnId: "parent-turn-a",
      completedAtMs: 1,
      item: {
        id: "spawn-a",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "parent-thread-a",
        receiverThreadIds: ["child-thread-a"],
        agentsStates: { "child-thread-a": { status: "running" } },
        model: "gpt-6-astra",
      },
    });
  }

  private childRead(): unknown {
    return {
      thread: {
        id: "child-thread-a",
        parentThreadId: "parent-thread-a",
        agentRole: "critic",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "parent-thread-a",
              depth: 1,
              agent_role: "critic",
            },
          },
        },
        status: { type: this.completed ? "idle" : "active", activeFlags: [] },
        turns: [
          {
            id: "child-turn-a",
            status: this.failed
              ? "failed"
              : this.completed
                ? "completed"
                : "inProgress",
            items: this.authorityCompleted ? [this.authorityItem()] : [],
          },
        ],
      },
    };
  }

  private parentRead(): unknown {
    return {
      thread: {
        id: "parent-thread-a",
        parentThreadId: null,
        agentRole: null,
        source: "appServer",
        status: { type: this.completed ? "idle" : "active", activeFlags: [] },
        turns: [
          {
            id: "parent-turn-a",
            status: this.completed ? "completed" : "inProgress",
            items: this.completed
              ? [
                  {
                    id: "spawn-a",
                    type: "collabAgentToolCall",
                    tool: "spawnAgent",
                    status: "completed",
                    senderThreadId: "parent-thread-a",
                    receiverThreadIds: ["child-thread-a"],
                    agentsStates: {},
                  },
                  ...(this.waitCompleted
                    ? [
                        {
                          id: "wait-a",
                          type: "collabAgentToolCall",
                          tool: "wait",
                          status: "completed",
                          senderThreadId: "parent-thread-a",
                          receiverThreadIds: ["child-thread-a"],
                          agentsStates: {},
                        },
                      ]
                    : []),
                ]
              : [],
          },
        ],
      },
    };
  }
}

describe("native Codex Agent host", () => {
  it("admits one real child, returns bounded running, then completes the same lineage", async () => {
    const peer = new NativeAgentPeer();
    const host = new CodexNativeAgentHost(peer, {
      model: "gpt-6-astra",
      runtimeRoot: "/private/tmp/farol-agent-runtime",
      spawnTimeoutMs: 1_000,
      waitTimeoutMs: 5,
      pollIntervalMs: 1,
      nonce: () => "proof-a",
      now: () => 1,
    });

    const spawned = await host.spawn(request);

    expect(spawned).toEqual({
      status: "started",
      correlation: {
        ...request.identity,
        authorityId: authority.authorityId,
        participantId: authority.participantId,
        role: authority.role,
        parentThreadId: "parent-thread-a",
        childId: "child-thread-a",
        hostRole: "critic",
      },
    });
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    await expect(host.wait(spawned.correlation)).resolves.toEqual({
      status: "running",
      correlation: spawned.correlation,
    });

    await peer.finish();
    await expect(host.wait(spawned.correlation)).resolves.toEqual({
      status: "completed",
      correlation: spawned.correlation,
      resultRef: "codex-app-server://thread/child-thread-a/turn/child-turn-a",
    });
  });

  it("rejoins a completed exact child without spawning another parent", async () => {
    const peer = new NativeAgentPeer();
    const first = new CodexNativeAgentHost(peer, {
      model: "gpt-6-astra",
      runtimeRoot: "/private/tmp/farol-agent-runtime",
      spawnTimeoutMs: 1_000,
      waitTimeoutMs: 5,
      pollIntervalMs: 1,
      nonce: () => "proof-a",
      now: () => 1,
    });
    const spawned = await first.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    await peer.finish();
    first.dispose();

    const rejoined = new CodexNativeAgentHost(peer, {
      model: "gpt-6-astra",
      runtimeRoot: "/private/tmp/farol-agent-runtime",
      spawnTimeoutMs: 1_000,
      waitTimeoutMs: 5,
      pollIntervalMs: 1,
      nonce: () => "unused",
      now: () => 2,
    });

    await expect(rejoined.wait(spawned.correlation)).resolves.toMatchObject({
      status: "completed",
      correlation: spawned.correlation,
    });
    expect(
      peer.requests.filter(({ method }) => method === "thread/start"),
    ).toHaveLength(1);
  });

  it("returns outcome unknown when spawn acknowledgement is not observed", async () => {
    const peer = new NativeAgentPeer(false);
    const host = new CodexNativeAgentHost(peer, {
      model: "gpt-6-astra",
      runtimeRoot: "/private/tmp/farol-agent-runtime",
      spawnTimeoutMs: 5,
      waitTimeoutMs: 5,
      pollIntervalMs: 1,
      nonce: () => "proof-a",
      now: () => 1,
    });

    await expect(host.spawn(request)).resolves.toEqual({
      status: "outcome_unknown",
      code: "AGENT_SPAWN_ACK_LOST",
    });
    expect(
      peer.requests.filter(({ method }) => method === "turn/start"),
    ).toHaveLength(1);
  });

  it("rejects terminal history without the exact authority evidence", async () => {
    const peer = new NativeAgentPeer();
    const host = new CodexNativeAgentHost(peer, {
      model: "gpt-6-astra",
      runtimeRoot: "/private/tmp/farol-agent-runtime",
      spawnTimeoutMs: 1_000,
      waitTimeoutMs: 5,
      pollIntervalMs: 1,
      nonce: () => "proof-a",
      now: () => 1,
    });
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    await peer.finish({ authority: false });

    await expect(host.wait(spawned.correlation)).resolves.toEqual({
      status: "outcome_unknown",
      correlation: spawned.correlation,
      code: "AGENT_WAIT_ACK_LOST",
    });
  });

  it("reports an exact child failure without retrying the assignment", async () => {
    const peer = new NativeAgentPeer();
    const host = new CodexNativeAgentHost(peer, {
      model: "gpt-6-astra",
      runtimeRoot: "/private/tmp/farol-agent-runtime",
      spawnTimeoutMs: 1_000,
      waitTimeoutMs: 5,
      pollIntervalMs: 1,
      nonce: () => "proof-a",
      now: () => 1,
    });
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    await peer.finish({ failed: true });

    await expect(host.wait(spawned.correlation)).resolves.toEqual({
      status: "failed",
      correlation: spawned.correlation,
      code: "AGENT_CHILD_FAILED",
    });
    expect(
      peer.requests.filter(({ method }) => method === "turn/start"),
    ).toHaveLength(1);
  });

  it("fails closed when a foreign child calls the authority tool", async () => {
    const peer = new NativeAgentPeer();
    const host = new CodexNativeAgentHost(peer, {
      model: "gpt-6-astra",
      runtimeRoot: "/private/tmp/farol-agent-runtime",
      spawnTimeoutMs: 1_000,
      waitTimeoutMs: 5,
      pollIntervalMs: 1,
      nonce: () => "proof-a",
      now: () => 1,
    });
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");

    await expect(
      peer.callAuthority({ threadId: "foreign-child" }),
    ).rejects.toThrow("CODEX_AGENT_AUTHORITY_CORRELATION");
    await expect(host.wait(spawned.correlation)).resolves.toEqual({
      status: "outcome_unknown",
      correlation: spawned.correlation,
      code: "AGENT_WAIT_ACK_LOST",
    });
  });

  it("refuses write, command, network, or expired authority before host admission", async () => {
    for (const incompatible of [
      { ...authority, mutationOwnership: "task" as const },
      {
        ...authority,
        capabilities: [...authority.capabilities, "workspace.write" as const],
      },
      {
        ...authority,
        workspaces: authority.workspaces.map((workspace) => ({
          ...workspace,
          access: "write" as const,
        })),
      },
      { ...authority, network: "approved" as const },
      { ...authority, commands: "verification" as const },
      { ...authority, expiresAt: 0 },
    ]) {
      const peer = new NativeAgentPeer();
      const host = new CodexNativeAgentHost(peer, {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-a",
        now: () => 1,
      });

      await expect(
        host.spawn({ ...request, authority: incompatible }),
      ).resolves.toEqual({
        status: "failed",
        code: "AGENT_SPAWN_REJECTED",
      });
      expect(peer.requests).toEqual([]);
    }
  });
});
