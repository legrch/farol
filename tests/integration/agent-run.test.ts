import { describe, expect, it } from "vitest";
import type {
  AgentHost,
  AgentSpawnReceipt,
  AgentSpawnRequest,
  AgentWaitReceipt,
} from "../../src/modules/agent/app/port/agent-host";
import type {
  AgentAuthorityPort,
  DelegatedAgentAuthority,
} from "../../src/modules/agent/app/port/execution-authority";
import type { AssignmentRepository } from "../../src/modules/agent/app/port/assignment-repository";
import {
  agentAssignmentCommandFingerprint,
  RunAgentAssignment,
  type AgentAssignmentCommand,
} from "../../src/modules/agent/app/service/run-agent-assignment";
import { InMemoryAssignments } from "../../src/modules/agent/infra/repo/in-memory-assignments";
import type { ChildCorrelation } from "../../src/modules/agent/domain/assignment";
import {
  createAssignment,
  startAssignment,
} from "../../src/modules/agent/domain/assignment";
import { Sha256AgentCommandDigester } from "../../src/modules/agent/infra/native/sha256-agent-command-digester";

const command: AgentAssignmentCommand = {
  identity: {
    assignmentId: "assignment-preview-a",
    ownerId: "owner-preview",
    sessionId: "session-preview-a",
    taskId: "task-preview-a",
    taskEpoch: 2,
    generation: 4,
  },
  delegation: {
    parentParticipantId: "main-preview-a",
    participantId: "agent-preview-a",
    role: "agent",
    mutationOwnership: "task",
  },
  focus: { initialPaths: ["/workspace/farol/README.md"] },
  intent: { kind: "compatibility" },
};

const delegatedAuthority: DelegatedAgentAuthority = {
  authorityId: "authority-preview-a",
  participantId: "agent-preview-a",
  parentParticipantId: "main-preview-a",
  role: "agent",
  mutationOwnership: "task",
  ownerId: command.identity.ownerId,
  sessionId: command.identity.sessionId,
  taskId: command.identity.taskId,
  taskEpoch: command.identity.taskEpoch,
  computerId: "computer-preview-a",
  computerGeneration: 7,
  workspaces: [
    {
      workspaceId: "farol",
      mode: "subtree",
      root: "/workspace/farol",
      access: "write",
    },
  ],
  excludedPaths: [],
  capabilities: [
    "workspace.read",
    "workspace.search",
    "verification.run",
    "workspace.write",
  ],
  network: "none",
  commands: "verification",
  expiresAt: 10_000,
};

const assignmentAuthority = {
  authorityId: delegatedAuthority.authorityId,
  participantId: delegatedAuthority.participantId,
  parentParticipantId: delegatedAuthority.parentParticipantId,
  role: delegatedAuthority.role,
  mutationOwnership: delegatedAuthority.mutationOwnership,
} as const;

const commandDigester = new Sha256AgentCommandDigester();

const exactChild: ChildCorrelation = {
  ...command.identity,
  authorityId: delegatedAuthority.authorityId,
  participantId: delegatedAuthority.participantId,
  role: delegatedAuthority.role,
  parentThreadId: "parent-thread-preview-a",
  childId: "child-preview-a",
  parentTurnId: "parent-turn-preview-a",
  childTurnId: "child-turn-preview-a",
  hostRole: "agent",
  delegationDigest: "a".repeat(64),
};

class AuthorityDouble implements AgentAuthorityPort {
  calls = 0;

  async delegate() {
    this.calls += 1;
    return { ok: true as const, value: delegatedAuthority };
  }
}

class AgentHostDouble implements AgentHost {
  spawnCalls = 0;
  waitCalls = 0;

  constructor(
    private readonly spawned: AgentSpawnReceipt | Error,
    private readonly waited: AgentWaitReceipt | Error | null,
  ) {}

  async spawn(received: AgentSpawnRequest): Promise<AgentSpawnReceipt> {
    this.spawnCalls += 1;
    expect(received.identity).toEqual(command.identity);
    expect(received.authority).toEqual(delegatedAuthority);
    expect(received.focus).toEqual(command.focus);
    expect(received.intent).toEqual(command.intent);
    if (this.spawned instanceof Error) throw this.spawned;
    return this.spawned;
  }

  async wait(received: ChildCorrelation): Promise<AgentWaitReceipt> {
    this.waitCalls += 1;
    expect(received.childId).toBe("child-preview-a");
    if (!this.waited) throw new Error("UNEXPECTED_WAIT");
    if (this.waited instanceof Error) throw this.waited;
    return this.waited;
  }

  async cancel(): Promise<never> {
    throw new Error("UNEXPECTED_CANCEL");
  }
}

function createRunner(
  host: AgentHost,
  repository: AssignmentRepository = new InMemoryAssignments(),
  authority: AgentAuthorityPort = new AuthorityDouble(),
): RunAgentAssignment {
  return new RunAgentAssignment(host, repository, authority, commandDigester);
}

describe("Agent app service", () => {
  it("rejects an empty product objective before authority resolution or spawn", async () => {
    const authority = new AuthorityDouble();
    const host = new AgentHostDouble(new Error("must not spawn"), null);

    await expect(
      createRunner(host, new InMemoryAssignments(), authority).execute({
        ...command,
        intent: { kind: "product", objective: "   " },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_ASSIGNMENT_INVALID", retry: "never" },
    });
    expect(authority.calls).toBe(0);
    expect(host.spawnCalls).toBe(0);
  });

  it("rejects malformed or duplicate focus paths before spawn", async () => {
    for (const initialPaths of [
      ["/workspace/farol/"],
      ["/workspace/farol/README.md", "/workspace/farol/README.md"],
    ]) {
      const host = new AgentHostDouble(new Error("must not spawn"), null);

      await expect(
        createRunner(host).execute({
          ...command,
          focus: { initialPaths },
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "AGENT_FOCUS_DENIED", retry: "never" },
      });
      expect(host.spawnCalls).toBe(0);
    }
  });

  it("rejects focus resolution through a malformed delegated root", async () => {
    const authority: AgentAuthorityPort = {
      delegate: async () => ({
        ok: true,
        value: {
          ...delegatedAuthority,
          workspaces: delegatedAuthority.workspaces.map((workspace) => ({
            ...workspace,
            root: `${workspace.root}/`,
          })),
        },
      }),
    };
    const host = new AgentHostDouble(new Error("must not spawn"), null);

    await expect(
      createRunner(host, new InMemoryAssignments(), authority).execute(command),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_FOCUS_DENIED", retry: "never" },
    });
    expect(host.spawnCalls).toBe(0);
  });

  it("spawns once, waits once and accepts only the same child result", async () => {
    const host = new AgentHostDouble(
      { status: "started", correlation: exactChild },
      {
        status: "completed",
        correlation: exactChild,
        resultRef: "result-preview-a",
        workspaceEnforcement: "verified",
      },
    );

    const receipt = await createRunner(host).execute(command);

    expect(receipt).toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "completed",
          childId: "child-preview-a",
          terminal: true,
          authority: assignmentAuthority,
        },
        resultRef: "result-preview-a",
        parentDelivery: "pending",
        resultRetention: "durable",
      },
    });
    expect(host.spawnCalls).toBe(1);
    expect(host.waitCalls).toBe(1);
  });

  it("atomically admits only one child for a duplicate assignment", async () => {
    const host = new AgentHostDouble(
      { status: "started", correlation: exactChild },
      {
        status: "completed",
        correlation: exactChild,
        resultRef: "result-preview-a",
        workspaceEnforcement: "verified",
      },
    );
    const runner = createRunner(host);

    const [first, duplicate] = await Promise.all([
      runner.execute(command),
      runner.execute(command),
    ]);

    expect(first).toEqual(duplicate);
    expect(host.spawnCalls).toBe(1);
    expect(host.waitCalls).toBe(1);
  });

  it("lets a second service instance follow the live prepared owner", async () => {
    let releaseSpawn!: () => void;
    let announceSpawn!: () => void;
    const spawnEntered = new Promise<void>((resolve) => {
      announceSpawn = resolve;
    });
    const spawnReleased = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const ownerHost: AgentHost & { spawnCalls: number; waitCalls: number } = {
      spawnCalls: 0,
      waitCalls: 0,
      async spawn() {
        this.spawnCalls += 1;
        announceSpawn();
        await spawnReleased;
        return { status: "started", correlation: exactChild };
      },
      async wait(correlation) {
        this.waitCalls += 1;
        return {
          status: "completed",
          correlation,
          resultRef: "result-preview-a",
          workspaceEnforcement: "verified" as const,
        };
      },
      async cancel() {
        throw new Error("UNEXPECTED_CANCEL");
      },
    };
    const repository = new InMemoryAssignments();
    const first = createRunner(ownerHost, repository).execute(command);
    await spawnEntered;

    const followerHost = new AgentHostDouble(new Error("must not spawn"), null);
    const follower = createRunner(followerHost, repository).execute(command);
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseSpawn();

    const [ownerResult, followerResult] = await Promise.all([first, follower]);
    expect(followerResult).toEqual(ownerResult);
    expect(ownerResult).toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "completed", terminal: true },
        resultRef: "result-preview-a",
        resultRetention: "durable",
      },
    });
    await expect(repository.load(command.identity)).resolves.toMatchObject({
      assignment: { phase: "completed", terminal: true },
      resultRef: "result-preview-a",
    });
    expect(ownerHost.spawnCalls).toBe(1);
    expect(ownerHost.waitCalls).toBe(1);
    expect(followerHost.spawnCalls).toBe(0);
    expect(followerHost.waitCalls).toBe(0);
  });

  it("rejects changed intent while the same assignment is in flight", async () => {
    let releaseSpawn!: () => void;
    let announceSpawn!: () => void;
    const spawnEntered = new Promise<void>((resolve) => {
      announceSpawn = resolve;
    });
    const spawnReleased = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const host: AgentHost & { spawnCalls: number } = {
      spawnCalls: 0,
      async spawn() {
        this.spawnCalls += 1;
        announceSpawn();
        await spawnReleased;
        return { status: "started", correlation: exactChild };
      },
      async wait(correlation) {
        return {
          status: "completed",
          correlation,
          resultRef: "result-preview-a",
          workspaceEnforcement: "verified" as const,
        };
      },
      async cancel() {
        throw new Error("UNEXPECTED_CANCEL");
      },
    };
    const runner = createRunner(host);
    const original = {
      ...command,
      intent: { kind: "product" as const, objective: "Inspect alpha" },
    };
    const first = runner.execute(original);
    await spawnEntered;

    const conflict = runner.execute({
      ...original,
      intent: { kind: "product", objective: "Inspect beta" },
    });
    releaseSpawn();

    await expect(conflict).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_ASSIGNMENT_CONFLICT", retry: "never" },
    });
    await expect(first).resolves.toMatchObject({
      ok: true,
      value: { assignment: { phase: "completed" } },
    });
    expect(host.spawnCalls).toBe(1);
  });

  it("returns a stored terminal receipt without spawning again", async () => {
    const repository = new InMemoryAssignments();
    const host = new AgentHostDouble(
      { status: "started", correlation: exactChild },
      {
        status: "completed",
        correlation: exactChild,
        resultRef: "result-preview-a",
        workspaceEnforcement: "verified",
      },
    );
    const runner = createRunner(host, repository);
    const first = await runner.execute(command);
    const duplicate = await runner.execute(command);

    expect(duplicate).toEqual(first);
    expect(host.spawnCalls).toBe(1);
    expect(host.waitCalls).toBe(1);
  });

  it("rejects changed focus or intent when replaying a durable assignment", async () => {
    const repository = new InMemoryAssignments();
    const host: AgentHost & { spawnCalls: number; waitCalls: number } = {
      spawnCalls: 0,
      waitCalls: 0,
      async spawn() {
        this.spawnCalls += 1;
        return { status: "started", correlation: exactChild };
      },
      async wait(correlation) {
        this.waitCalls += 1;
        return {
          status: "completed",
          correlation,
          resultRef: "result-preview-a",
          workspaceEnforcement: "verified" as const,
        };
      },
      async cancel() {
        throw new Error("UNEXPECTED_CANCEL");
      },
    };
    const original = {
      ...command,
      intent: { kind: "product" as const, objective: "Inspect alpha" },
    };
    await expect(
      createRunner(host, repository).execute(original),
    ).resolves.toMatchObject({
      ok: true,
      value: { assignment: { phase: "completed" } },
    });

    for (const changed of [
      {
        ...original,
        intent: { kind: "product" as const, objective: "Inspect beta" },
      },
      {
        ...original,
        focus: { initialPaths: ["/workspace/farol/package.json"] },
      },
    ]) {
      await expect(
        createRunner(
          new AgentHostDouble(new Error("must not spawn"), null),
          repository,
        ).execute(changed),
      ).resolves.toEqual({
        ok: false,
        error: { code: "AGENT_ASSIGNMENT_CONFLICT", retry: "never" },
      });
    }
    expect(host.spawnCalls).toBe(1);
    expect(host.waitCalls).toBe(1);
  });

  it("tombstones a prepared record recovered without a known child", async () => {
    const preparedRepository = new InMemoryAssignments();
    await preparedRepository.admit({
      assignment: createAssignment(
        command.identity,
        assignmentAuthority,
        agentAssignmentCommandFingerprint(command, commandDigester),
      ),
      resultRef: null,
      parentDelivery: "not_applicable",
    });
    const preparedHost = new AgentHostDouble(new Error("must not spawn"), null);
    await expect(
      createRunner(preparedHost, preparedRepository).execute(command),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "outcome_unknown",
          terminal: true,
        },
      },
    });
    expect(preparedHost.spawnCalls).toBe(0);
  });

  it("never admits a new child when a rejoin record is missing", async () => {
    const host = new AgentHostDouble(new Error("must not spawn"), null);
    const rejoinCommand = {
      ...command,
      admission: "rejoin" as const,
    } as AgentAssignmentCommand & { admission: "rejoin" };

    await expect(
      createRunner(host).execute(rejoinCommand),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_REJOIN_UNAVAILABLE", retry: "never" },
    });
    expect(host.spawnCalls).toBe(0);
    expect(host.waitCalls).toBe(0);
  });

  it("fails closed when the exact rejoin record cannot be read", async () => {
    const repository: AssignmentRepository = {
      admit: async () => {
        throw new Error("must not admit");
      },
      load: async () => {
        throw new Error("repository unavailable");
      },
      save: async () => {
        throw new Error("must not save");
      },
    };
    const host = new AgentHostDouble(new Error("must not spawn"), null);

    await expect(
      createRunner(host, repository).execute({
        ...command,
        admission: "rejoin",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_REJOIN_UNAVAILABLE", retry: "never" },
    });
    expect(host.spawnCalls).toBe(0);
    expect(host.waitCalls).toBe(0);
  });

  it("rejoins the exact running child after restart without spawning again", async () => {
    const runningRepository = new InMemoryAssignments();
    const running = startAssignment(
      createAssignment(
        command.identity,
        assignmentAuthority,
        agentAssignmentCommandFingerprint(command, commandDigester),
      ),
      exactChild,
    );
    if (!running.ok) throw new Error("RUNNING_FIXTURE_INVALID");
    await runningRepository.admit({
      assignment: running.value,
      resultRef: null,
      parentDelivery: "not_applicable",
    });
    const runningHost = new AgentHostDouble(new Error("must not spawn"), {
      status: "completed",
      correlation: exactChild,
      resultRef: "result-preview-rejoined",
      workspaceEnforcement: "verified",
    });
    await expect(
      createRunner(runningHost, runningRepository).execute({
        ...command,
        admission: "rejoin",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "completed",
          terminal: true,
        },
        resultRef: "result-preview-rejoined",
      },
    });
    expect(runningHost.spawnCalls).toBe(0);
    expect(runningHost.waitCalls).toBe(1);
  });

  it("rejects a foreign running correlation", async () => {
    const host = new AgentHostDouble(
      { status: "started", correlation: exactChild },
      {
        status: "running",
        correlation: { ...exactChild, childTurnId: "foreign-turn" },
      },
    );

    await expect(createRunner(host).execute(command)).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_CORRELATION", retry: "never" },
    });
    expect(host.spawnCalls).toBe(1);
    expect(host.waitCalls).toBe(1);
  });

  it("returns bounded running state and later rejoins the same child", async () => {
    let waits = 0;
    const host: AgentHost & { spawnCalls: number } = {
      spawnCalls: 0,
      async spawn() {
        this.spawnCalls += 1;
        return { status: "started", correlation: exactChild };
      },
      async wait(correlation) {
        waits += 1;
        return waits === 1
          ? { status: "running", correlation }
          : {
              status: "completed",
              correlation,
              resultRef: "result-preview-rejoined",
              workspaceEnforcement: "verified" as const,
            };
      },
      async cancel() {
        throw new Error("UNEXPECTED_CANCEL");
      },
    };
    const runner = createRunner(host);

    await expect(runner.execute(command)).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "running", terminal: false },
        resultRef: null,
        resultRetention: "not_applicable",
      },
    });
    await expect(runner.execute(command)).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "completed", terminal: true },
        resultRef: "result-preview-rejoined",
      },
    });
    expect(host.spawnCalls).toBe(1);
    expect(waits).toBe(2);
  });

  it("fails closed before spawn when assignment admission is unavailable", async () => {
    const repository: AssignmentRepository = {
      admit: async () => {
        throw new Error("repository unavailable");
      },
      load: async () => null,
      save: async () => undefined,
    };
    const host = new AgentHostDouble(new Error("must not spawn"), null);
    await expect(
      createRunner(host, repository).execute(command),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_ADMISSION_FAILED" },
    });
    expect(host.spawnCalls).toBe(0);
  });

  it("does not rewrite a known host result when evidence persistence fails", async () => {
    class FailingSaveAssignments extends InMemoryAssignments {
      override async save(): Promise<void> {
        throw new Error("evidence unavailable");
      }
    }
    const host = new AgentHostDouble(
      { status: "started", correlation: exactChild },
      {
        status: "completed",
        correlation: exactChild,
        resultRef: "result-preview-a",
        workspaceEnforcement: "verified",
      },
    );
    await expect(
      createRunner(host, new FailingSaveAssignments()).execute(command),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "completed" },
        parentDelivery: "pending",
        resultRetention: "memory_only",
      },
    });
  });

  it("rejects a foreign child result without spawning or waiting again", async () => {
    const host = new AgentHostDouble(
      { status: "started", correlation: exactChild },
      {
        status: "completed",
        correlation: { ...exactChild, ownerId: "foreign-owner" },
        resultRef: "foreign-result",
        workspaceEnforcement: "verified",
      },
    );

    const receipt = await createRunner(host).execute(command);

    expect(receipt).toMatchObject({
      ok: false,
      error: { code: "AGENT_CORRELATION" },
    });
    expect(JSON.stringify(receipt)).not.toContain("foreign-result");
    expect(host.spawnCalls).toBe(1);
    expect(host.waitCalls).toBe(1);
  });

  it("makes an uncertain spawn terminal and never retries or waits", async () => {
    const host = new AgentHostDouble(
      { status: "outcome_unknown", code: "AGENT_SPAWN_ACK_LOST" },
      null,
    );

    const receipt = await createRunner(host).execute(command);

    expect(receipt).toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "outcome_unknown",
          terminal: true,
          terminalReason: {
            code: "AGENT_SPAWN_ACK_LOST",
            source: "native-host-transport",
          },
        },
        resultRef: null,
      },
    });
    expect(host.spawnCalls).toBe(1);
    expect(host.waitCalls).toBe(0);
  });

  it.each([
    {
      name: "a rejected spawn",
      host: () =>
        new AgentHostDouble(
          { status: "failed", code: "AGENT_SPAWN_REJECTED" },
          null,
        ),
      phase: "failed",
      source: "native-host",
      waitCalls: 0,
    },
    {
      name: "a lost spawn acknowledgement",
      host: () => new AgentHostDouble(new Error("lost spawn ack"), null),
      phase: "outcome_unknown",
      source: "native-host-transport",
      waitCalls: 0,
    },
    {
      name: "a failed child",
      host: () =>
        new AgentHostDouble(
          { status: "started", correlation: exactChild },
          {
            status: "failed",
            correlation: exactChild,
            code: "AGENT_CHILD_FAILED",
          },
        ),
      phase: "failed",
      source: "native-host",
      waitCalls: 1,
    },
    {
      name: "a lost wait acknowledgement",
      host: () =>
        new AgentHostDouble(
          { status: "started", correlation: exactChild },
          {
            status: "outcome_unknown",
            correlation: exactChild,
            code: "AGENT_WAIT_ACK_LOST",
          },
        ),
      phase: "outcome_unknown",
      source: "native-host-transport",
      waitCalls: 1,
    },
    {
      name: "a thrown wait transport",
      host: () =>
        new AgentHostDouble(
          { status: "started", correlation: exactChild },
          new Error("lost wait ack"),
        ),
      phase: "outcome_unknown",
      source: "native-host-transport",
      waitCalls: 1,
    },
  ])(
    "terminates $name without retry",
    async ({ host: createHost, phase, source, waitCalls }) => {
      const host = createHost();
      await expect(createRunner(host).execute(command)).resolves.toMatchObject({
        ok: true,
        value: {
          assignment: {
            phase,
            terminal: true,
            terminalReason: { source, retry: "never" },
          },
          resultRef: null,
        },
      });
      expect(host.spawnCalls).toBe(1);
      expect(host.waitCalls).toBe(waitCalls);
    },
  );

  it("rejects foreign spawn correlation before wait", async () => {
    const host = new AgentHostDouble(
      {
        status: "started",
        correlation: {
          ...exactChild,
          authorityId: "foreign-authority",
        },
      },
      null,
    );
    await expect(createRunner(host).execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_CORRELATION", retry: "never" },
    });
    expect(host.spawnCalls).toBe(1);
    expect(host.waitCalls).toBe(0);
  });
});
