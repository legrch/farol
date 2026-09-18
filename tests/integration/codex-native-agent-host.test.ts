import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { AgentSpawnRequest } from "../../src/modules/agent/app/port/agent-host";
import type { DelegatedAgentAuthority } from "../../src/modules/agent/app/port/execution-authority";
import type { AgentWorkspaceProbe } from "../../src/modules/agent/app/port/workspace-probe";
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
  intent: { kind: "compatibility" },
};

class NativeAgentPeer implements CodexNativeAgentPeer {
  readonly requests: Readonly<{ method: string; params: unknown }>[] = [];
  readonly handlers = new Map<string, RequestHandler>();
  readonly notifications = new Map<string, NotificationHandler>();
  completed = false;
  failed = false;
  authorityCompleted = false;
  workspaceCompleted = false;
  waitCompleted = false;
  childSpawnedDescendant = false;
  extraChildTurn = false;
  childPrompt = "";
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
        baseInstructions?: string;
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
        expect.objectContaining({ name: "farol_agent_workspace_probe" }),
      ]);
      expect(input.baseInstructions).not.toContain(
        "must use exactly one native child",
      );
      return {
        model: "gpt-6-astra",
        thread: { id: "parent-thread-a", parentThreadId: null },
      };
    }
    if (method === "turn/start") {
      const text = (params as { input?: readonly { text?: string }[] })
        .input?.[0]?.text;
      this.nonce =
        [...(text ?? "").matchAll(/proof ([a-z0-9-]+)/gu)].at(-1)?.[1] ?? "";
      this.childPrompt =
        /FAROL_CHILD_PROMPT_BEGIN\n([\s\S]*?)\nFAROL_CHILD_PROMPT_END/u.exec(
          text ?? "",
        )?.[1] ?? "";
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
      threadId: "parent-thread-a",
      turnId: "parent-turn-a",
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

  async callWorkspace(): Promise<unknown> {
    const handler = this.handlers.get("item/tool/call");
    if (!handler) throw new Error("WORKSPACE_HANDLER_MISSING");
    const proof =
      /workspace proof ([a-f0-9]{64})/u.exec(this.childPrompt)?.[1] ?? "";
    const result = await handler({
      threadId: "child-thread-a",
      turnId: "child-turn-a",
      callId: "workspace-call-a",
      tool: "farol_agent_workspace_probe",
      arguments: {
        assignmentId: request.identity.assignmentId,
        authorityId: authority.authorityId,
        participantId: authority.participantId,
        proof,
      },
    });
    this.workspaceCompleted = true;
    return result;
  }

  async finish(
    options: Readonly<{
      authority?: boolean;
      wait?: boolean;
      failed?: boolean;
    }> = {},
  ): Promise<void> {
    this.completed = true;
    this.failed = options.failed ?? false;
    if (!this.failed) {
      await expect(this.callWorkspace()).resolves.toEqual({
        success: true,
        contentItems: [{ type: "inputText", text: "FAROL_AGENT_WORKSPACE_OK" }],
      });
    }
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
    if (options.authority !== false) {
      await expect(this.callAuthority()).resolves.toEqual({
        success: true,
        contentItems: [{ type: "inputText", text: "FAROL_AGENT_AUTHORITY_OK" }],
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

  private workspaceItem(): unknown {
    return {
      id: "workspace-call-a",
      type: "dynamicToolCall",
      tool: "farol_agent_workspace_probe",
      status: "completed",
      success: true,
      arguments: {
        assignmentId: request.identity.assignmentId,
        authorityId: authority.authorityId,
        participantId: authority.participantId,
        proof:
          /workspace proof ([a-f0-9]{64})/u.exec(this.childPrompt)?.[1] ?? "",
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
        prompt: this.childPrompt,
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
            items: [
              ...(this.workspaceCompleted ? [this.workspaceItem()] : []),
              ...(this.childSpawnedDescendant
                ? [
                    {
                      id: "nested-spawn-a",
                      type: "collabAgentToolCall",
                      tool: "spawnAgent",
                      status: "completed",
                      senderThreadId: "child-thread-a",
                      receiverThreadIds: ["grandchild-thread-a"],
                      agentsStates: {},
                      prompt: "unauthorized nested assignment",
                    },
                  ]
                : []),
            ],
          },
          ...(this.extraChildTurn
            ? [
                {
                  id: "child-turn-foreign",
                  status: "inProgress",
                  items: [],
                },
              ]
            : []),
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
                    prompt: this.childPrompt,
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
                  ...(this.authorityCompleted ? [this.authorityItem()] : []),
                ]
              : [],
          },
        ],
      },
    };
  }
}

class SlowObservationPeer extends NativeAgentPeer {
  slowReads = false;
  readonly readTimeouts: (number | null)[] = [];

  override async request(
    method: string,
    params: unknown,
    options?: Readonly<{ timeoutMs?: number }>,
  ): Promise<unknown> {
    if (this.slowReads && method === "thread/read") {
      this.readTimeouts.push(options?.timeoutMs ?? null);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, (options?.timeoutMs ?? 80) + 2),
      );
      throw new Error("OBSERVATION_TIMEOUT");
    }
    return super.request(method, params);
  }
}

function verifiedWorkspaceProbe(): AgentWorkspaceProbe {
  return {
    verify: async () => ({ status: "verified" }),
  };
}

describe("native Codex Agent host", () => {
  it("rejects invalid host options before installing protocol handlers", () => {
    const peer = new NativeAgentPeer();

    expect(
      () =>
        new CodexNativeAgentHost(
          peer,
          {
            model: "gpt-6-astra",
            runtimeRoot: "relative/runtime",
            spawnTimeoutMs: 1_000,
            waitTimeoutMs: 5,
            pollIntervalMs: 1,
            nonce: () => "proof-a",
            now: () => 1,
          },
          verifiedWorkspaceProbe(),
        ),
    ).toThrow("CODEX_AGENT_OPTIONS_INVALID");
    expect(peer.handlers.size).toBe(0);
    expect(peer.notifications.size).toBe(0);
  });

  it("rejects a malformed proof nonce before starting a native thread", async () => {
    const peer = new NativeAgentPeer();
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "INVALID PROOF",
        now: () => 1,
      },
      verifiedWorkspaceProbe(),
    );

    await expect(host.spawn(request)).resolves.toEqual({
      status: "failed",
      code: "AGENT_SPAWN_REJECTED",
    });
    expect(peer.requests).toEqual([]);
  });

  it("admits one real child, returns bounded running, then completes the same lineage", async () => {
    const peer = new NativeAgentPeer();
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-a",
        now: () => 1,
      },
      verifiedWorkspaceProbe(),
    );

    const spawned = await host.spawn(request);

    const carriedGrant = JSON.parse(peer.childPrompt.split("\n")[1]!) as {
      authority: typeof authority;
      focus: typeof request.focus;
    };
    expect(carriedGrant.authority).toEqual(authority);
    expect(carriedGrant.focus).toEqual(request.focus);

    expect(spawned).toEqual({
      status: "started",
      correlation: {
        ...request.identity,
        authorityId: authority.authorityId,
        participantId: authority.participantId,
        role: authority.role,
        parentThreadId: "parent-thread-a",
        childId: "child-thread-a",
        parentTurnId: "parent-turn-a",
        childTurnId: "child-turn-a",
        hostRole: "critic",
        delegationDigest: createHash("sha256")
          .update(peer.childPrompt)
          .digest("hex"),
      },
      authorityProof: "proof-a",
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
      workspaceEnforcement: "verified",
    });
  });

  it("bounds each history read by the remaining observation budget", async () => {
    const peer = new SlowObservationPeer();
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 8,
        pollIntervalMs: 1,
        nonce: () => "proof-a",
        now: () => 1,
      },
      verifiedWorkspaceProbe(),
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    peer.slowReads = true;
    const startedAt = Date.now();

    await expect(host.wait(spawned.correlation)).resolves.toEqual({
      status: "running",
      correlation: spawned.correlation,
    });

    expect(Date.now() - startedAt).toBeLessThan(50);
    expect(peer.readTimeouts).toHaveLength(2);
    expect(peer.readTimeouts.every((timeout) => timeout !== null)).toBe(true);
    expect(
      peer.readTimeouts.every((timeout) => timeout !== null && timeout <= 8),
    ).toBe(true);
  });

  it("rejoins a completed exact child without spawning another parent", async () => {
    const peer = new NativeAgentPeer();
    const first = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-a",
        now: () => 1,
      },
      verifiedWorkspaceProbe(),
    );
    const spawned = await first.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    await peer.finish();
    first.dispose();

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
      verifiedWorkspaceProbe(),
    );

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
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 5,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-a",
        now: () => 1,
      },
      verifiedWorkspaceProbe(),
    );

    await expect(host.spawn(request)).resolves.toEqual({
      status: "outcome_unknown",
      code: "AGENT_SPAWN_ACK_LOST",
    });
    expect(
      peer.requests.filter(({ method }) => method === "turn/start"),
    ).toHaveLength(1);
  });

  it("returns outcome unknown when spawn resolves to more than one child turn", async () => {
    const peer = new NativeAgentPeer();
    peer.extraChildTurn = true;
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-a",
        now: () => 1,
      },
      verifiedWorkspaceProbe(),
    );

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
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-a",
        now: () => 1,
      },
      verifiedWorkspaceProbe(),
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    await peer.finish({ authority: false });

    await expect(host.wait(spawned.correlation)).resolves.toEqual({
      status: "outcome_unknown",
      correlation: spawned.correlation,
      code: "AGENT_WAIT_ACK_LOST",
    });
  });

  it("rejects terminal history when the durable child prompt was changed", async () => {
    const peer = new NativeAgentPeer();
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-a",
        now: () => 1,
      },
      verifiedWorkspaceProbe(),
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    peer.childPrompt = `${peer.childPrompt}\nworkspace.write`;
    await peer.finish();

    await expect(host.wait(spawned.correlation)).resolves.toEqual({
      status: "outcome_unknown",
      correlation: spawned.correlation,
      code: "AGENT_WAIT_ACK_LOST",
    });
  });

  it("rejects a child that delegated to an unauthorized descendant", async () => {
    const peer = new NativeAgentPeer();
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-a",
        now: () => 1,
      },
      verifiedWorkspaceProbe(),
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");
    peer.childSpawnedDescendant = true;
    await peer.finish();

    await expect(host.wait(spawned.correlation)).resolves.toEqual({
      status: "outcome_unknown",
      correlation: spawned.correlation,
      code: "AGENT_WAIT_ACK_LOST",
    });
  });

  it("reports an exact child failure without retrying the assignment", async () => {
    const peer = new NativeAgentPeer();
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-a",
        now: () => 1,
      },
      verifiedWorkspaceProbe(),
    );
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

  it("fails closed when the child calls the parent authority tool", async () => {
    const peer = new NativeAgentPeer();
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-a",
        now: () => 1,
      },
      verifiedWorkspaceProbe(),
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");

    await expect(
      peer.callAuthority({ threadId: "child-thread-a" }),
    ).rejects.toThrow("CODEX_AGENT_AUTHORITY_CORRELATION");
    await expect(host.wait(spawned.correlation)).resolves.toEqual({
      status: "outcome_unknown",
      correlation: spawned.correlation,
      code: "AGENT_WAIT_ACK_LOST",
    });
  });

  it("admits only one concurrent workspace probe call", async () => {
    const peer = new NativeAgentPeer();
    let probeCalls = 0;
    let enterProbe!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterProbe = resolve;
    });
    let releaseProbe!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-a",
        now: () => 1,
      },
      {
        verify: async () => {
          probeCalls += 1;
          if (probeCalls === 1) {
            enterProbe();
            await released;
          }
          return { status: "verified" };
        },
      },
    );
    const spawned = await host.spawn(request);
    if (spawned.status !== "started") throw new Error("SPAWN_FAILED");

    const first = peer.callWorkspace();
    await entered;
    const duplicate = await peer.callWorkspace().then(
      () => "resolved",
      (cause: unknown) => (cause instanceof Error ? cause.message : "unknown"),
    );
    releaseProbe();

    expect(duplicate).toBe("CODEX_AGENT_WORKSPACE_CORRELATION");
    await expect(first).resolves.toMatchObject({ success: true });
    expect(probeCalls).toBe(1);
    await expect(host.wait(spawned.correlation)).resolves.toMatchObject({
      status: "outcome_unknown",
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
      const host = new CodexNativeAgentHost(
        peer,
        {
          model: "gpt-6-astra",
          runtimeRoot: "/private/tmp/farol-agent-runtime",
          spawnTimeoutMs: 1_000,
          waitTimeoutMs: 5,
          pollIntervalMs: 1,
          nonce: () => "proof-a",
          now: () => 1,
        },
        verifiedWorkspaceProbe(),
      );

      await expect(
        host.spawn({ ...request, authority: incompatible }),
      ).resolves.toEqual({
        status: "failed",
        code: "AGENT_SPAWN_REJECTED",
      });
      expect(peer.requests).toEqual([]);
    }

    const peer = new NativeAgentPeer();
    const host = new CodexNativeAgentHost(
      peer,
      {
        model: "gpt-6-astra",
        runtimeRoot: "/private/tmp/farol-agent-runtime",
        spawnTimeoutMs: 1_000,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        nonce: () => "proof-a",
        now: () => 1,
      },
      verifiedWorkspaceProbe(),
    );
    await expect(
      host.spawn({ ...request, focus: { initialPaths: [] } }),
    ).resolves.toEqual({
      status: "failed",
      code: "AGENT_SPAWN_REJECTED",
    });
    expect(peer.requests).toEqual([]);
  });
});
