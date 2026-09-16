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
  RunAgentAssignment,
  type AgentAssignmentCommand,
} from "../../src/modules/agent/app/service/run-agent-assignment";
import { InMemoryAssignments } from "../../src/modules/agent/infra/repo/in-memory-assignments";
import type { ChildCorrelation } from "../../src/modules/agent/domain/assignment";
import {
  createAssignment,
  startAssignment,
} from "../../src/modules/agent/domain/assignment";

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

const exactChild: ChildCorrelation = {
  ...command.identity,
  authorityId: delegatedAuthority.authorityId,
  participantId: delegatedAuthority.participantId,
  childId: "child-preview-a",
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
}

function createRunner(
  host: AgentHost,
  repository: AssignmentRepository = new InMemoryAssignments(),
  authority: AgentAuthorityPort = new AuthorityDouble(),
): RunAgentAssignment {
  return new RunAgentAssignment(host, repository, authority);
}

describe("Agent app service", () => {
  it("spawns once, waits once and accepts only the same child result", async () => {
    const host = new AgentHostDouble(
      { status: "started", correlation: exactChild },
      {
        status: "completed",
        correlation: exactChild,
        resultRef: "result-preview-a",
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

  it("returns a stored terminal receipt without spawning again", async () => {
    const repository = new InMemoryAssignments();
    const host = new AgentHostDouble(
      { status: "started", correlation: exactChild },
      {
        status: "completed",
        correlation: exactChild,
        resultRef: "result-preview-a",
      },
    );
    const runner = createRunner(host, repository);
    const first = await runner.execute(command);
    const duplicate = await runner.execute(command);

    expect(duplicate).toEqual(first);
    expect(host.spawnCalls).toBe(1);
    expect(host.waitCalls).toBe(1);
  });

  it("tombstones a prepared record recovered without a known child", async () => {
    const preparedRepository = new InMemoryAssignments();
    await preparedRepository.admit({
      assignment: createAssignment(command.identity, assignmentAuthority),
      resultRef: null,
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

  it("rejoins the exact running child after restart without spawning again", async () => {
    const runningRepository = new InMemoryAssignments();
    const running = startAssignment(
      createAssignment(command.identity, assignmentAuthority),
      exactChild,
    );
    if (!running.ok) throw new Error("RUNNING_FIXTURE_INVALID");
    await runningRepository.admit({
      assignment: running.value,
      resultRef: null,
    });
    const runningHost = new AgentHostDouble(new Error("must not spawn"), {
      status: "completed",
      correlation: exactChild,
      resultRef: "result-preview-rejoined",
    });
    await expect(
      createRunner(runningHost, runningRepository).execute(command),
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

  it("fails closed before spawn when assignment admission is unavailable", async () => {
    const repository: AssignmentRepository = {
      admit: async () => {
        throw new Error("repository unavailable");
      },
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
      },
    );
    await expect(
      createRunner(host, new FailingSaveAssignments()).execute(command),
    ).resolves.toMatchObject({
      ok: true,
      value: { assignment: { phase: "completed" } },
    });
  });

  it("rejects a foreign child result without spawning or waiting again", async () => {
    const host = new AgentHostDouble(
      { status: "started", correlation: exactChild },
      {
        status: "completed",
        correlation: { ...exactChild, ownerId: "foreign-owner" },
        resultRef: "foreign-result",
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
