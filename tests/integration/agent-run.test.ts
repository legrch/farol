import { describe, expect, it } from "vitest";
import type {
  AgentHost,
  AgentSpawnReceipt,
  AgentWaitReceipt,
} from "../../src/modules/agent/app/port/agent-host";
import { RunAgentAssignment } from "../../src/modules/agent/app/service/run-agent-assignment";
import type {
  AssignmentIdentity,
  ChildCorrelation,
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
  ownerId: identity.ownerId,
  generation: identity.generation,
  childId: "child-preview-a",
};

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

    const receipt = await new RunAgentAssignment(host).execute(identity);

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

  it("rejects a foreign child result without spawning or waiting again", async () => {
    const host = new AgentHostDouble(
      { status: "started", correlation: exactChild },
      {
        status: "completed",
        correlation: { ...exactChild, ownerId: "foreign-owner" },
        resultRef: "foreign-result",
      },
    );

    const receipt = await new RunAgentAssignment(host).execute(identity);

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

    const receipt = await new RunAgentAssignment(host).execute(identity);

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
      await expect(
        new RunAgentAssignment(host).execute(identity),
      ).resolves.toMatchObject({
        ok: true,
        value: { assignment: { phase, terminal: true }, resultRef: null },
      });
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
    await expect(
      new RunAgentAssignment(host).execute(identity),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_CORRELATION", retry: "never" },
    });
    expect(host.spawnCalls).toBe(1);
    expect(host.waitCalls).toBe(0);
  });
});
