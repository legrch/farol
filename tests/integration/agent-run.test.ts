import { describe, expect, it } from "vitest";
import type {
  AgentHost,
  AgentSpawnReceipt,
  AgentWaitReceipt,
} from "../../src/modules/agent/app/port/agent-host";
import type { AssignmentRepository } from "../../src/modules/agent/app/port/assignment-repository";
import { RunAgentAssignment } from "../../src/modules/agent/app/service/run-agent-assignment";
import { InMemoryAssignments } from "../../src/modules/agent/infra/repo/in-memory-assignments";
import type {
  AssignmentIdentity,
  ChildCorrelation,
} from "../../src/modules/agent/domain/assignment";
import {
  createAssignment,
  startAssignment,
} from "../../src/modules/agent/domain/assignment";

const identity: AssignmentIdentity = {
  assignmentId: "assignment-preview-a",
  ownerId: "owner-preview",
  generation: 4,
};

class AgentHostDouble implements AgentHost {
  spawnCalls = 0;
  waitCalls = 0;

  constructor(
    private readonly spawned: AgentSpawnReceipt | Error,
    private readonly waited: AgentWaitReceipt | Error | null,
  ) {}

  async spawn(received: AssignmentIdentity): Promise<AgentSpawnReceipt> {
    this.spawnCalls += 1;
    expect(received).toEqual(identity);
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

const exactChild: ChildCorrelation = {
  assignmentId: identity.assignmentId,
  ownerId: identity.ownerId,
  generation: identity.generation,
  childId: "child-preview-a",
};

function createRunner(host: AgentHost): RunAgentAssignment {
  return new RunAgentAssignment(host, new InMemoryAssignments());
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

    const receipt = await createRunner(host).execute(identity);

    expect(receipt).toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "completed",
          childId: "child-preview-a",
          terminal: true,
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
      runner.execute(identity),
      runner.execute(identity),
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
    const runner = new RunAgentAssignment(host, repository);
    const first = await runner.execute(identity);
    const duplicate = await runner.execute(identity);

    expect(duplicate).toEqual(first);
    expect(host.spawnCalls).toBe(1);
    expect(host.waitCalls).toBe(1);
  });

  it("tombstones prepared and running records recovered without an in-flight owner", async () => {
    const preparedRepository = new InMemoryAssignments();
    await preparedRepository.admit({
      assignment: createAssignment(identity),
      resultRef: null,
    });
    const preparedHost = new AgentHostDouble(new Error("must not spawn"), null);
    await expect(
      new RunAgentAssignment(preparedHost, preparedRepository).execute(
        identity,
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { assignment: { phase: "outcome_unknown", terminal: true } },
    });
    expect(preparedHost.spawnCalls).toBe(0);

    const runningRepository = new InMemoryAssignments();
    const running = startAssignment(createAssignment(identity), exactChild);
    if (!running.ok) throw new Error("RUNNING_FIXTURE_INVALID");
    await runningRepository.admit({
      assignment: running.value,
      resultRef: null,
    });
    const runningHost = new AgentHostDouble(new Error("must not spawn"), null);
    await expect(
      new RunAgentAssignment(runningHost, runningRepository).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: { assignment: { phase: "outcome_unknown", terminal: true } },
    });
    expect(runningHost.spawnCalls).toBe(0);
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
      new RunAgentAssignment(host, repository).execute(identity),
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
      new RunAgentAssignment(host, new FailingSaveAssignments()).execute(
        identity,
      ),
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

    const receipt = await createRunner(host).execute(identity);

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

    const receipt = await createRunner(host).execute(identity);

    expect(receipt).toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "outcome_unknown", terminal: true },
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
      waitCalls: 0,
    },
    {
      name: "a lost spawn acknowledgement",
      host: () => new AgentHostDouble(new Error("lost spawn ack"), null),
      phase: "outcome_unknown",
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
      waitCalls: 1,
    },
  ])(
    "terminates $name without retry",
    async ({ host: createHost, phase, waitCalls }) => {
      const host = createHost();
      await expect(createRunner(host).execute(identity)).resolves.toMatchObject(
        {
          ok: true,
          value: { assignment: { phase, terminal: true }, resultRef: null },
        },
      );
      expect(host.spawnCalls).toBe(1);
      expect(host.waitCalls).toBe(waitCalls);
    },
  );

  it("rejects foreign spawn correlation before wait", async () => {
    const host = new AgentHostDouble(
      {
        status: "started",
        correlation: { ...exactChild, generation: identity.generation - 1 },
      },
      null,
    );
    await expect(createRunner(host).execute(identity)).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_CORRELATION", retry: "never" },
    });
    expect(host.spawnCalls).toBe(1);
    expect(host.waitCalls).toBe(0);
  });
});
