import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
import { PrivateAssignmentStore } from "../../src/modules/agent/infra/repo/private-assignment-store";
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

  it("LIF-07 keeps the lineage a crashed spawn recorded and reports it after restart", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-agent-lineage-"),
    );
    let releaseCrashed!: () => void;
    const crashed = new Promise<void>((resolve) => {
      releaseCrashed = resolve;
    });
    let first: Promise<unknown> = Promise.resolve();
    try {
      const store = () =>
        new PrivateAssignmentStore({ root: path.join(root, "assignments") });
      // The host records the parent thread and turn, then its process dies.
      const crashing: AgentHost = {
        spawn: async (_request, progress) => {
          await progress?.lineage({
            parentThreadId: "parent-thread-crash",
            parentTurnId: null,
            childId: null,
          });
          await progress?.lineage({
            parentThreadId: "parent-thread-crash",
            parentTurnId: "parent-turn-crash",
            childId: null,
          });
          // The dead process never answers; releasing it at the end only
          // lets this test's in-memory execution finish.
          await crashed;
          throw new Error("PROCESS_GONE");
        },
        wait: async () => {
          throw new Error("UNEXPECTED_WAIT");
        },
        cancel: async () => {
          throw new Error("UNEXPECTED_CANCEL");
        },
      };
      first = createRunner(crashing, store()).execute(command);
      await vi.waitFor(async () =>
        expect(
          (await store().load(command.identity))?.assignment.parentTurnId,
        ).toBe("parent-turn-crash"),
      );

      // A restarted process has a fresh service module: nothing of the dead
      // spawn survives in memory, only what it recorded.
      vi.resetModules();
      const restartedModule =
        await import("../../src/modules/agent/app/service/run-agent-assignment");
      const restarted = new AgentHostDouble(new Error("must not spawn"), null);
      await expect(
        new restartedModule.RunAgentAssignment(
          restarted,
          store(),
          new AuthorityDouble(),
          commandDigester,
        ).execute(command),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          assignment: {
            phase: "outcome_unknown",
            parentThreadId: "parent-thread-crash",
            parentTurnId: "parent-turn-crash",
            childId: null,
            terminalReason: {
              code: "AGENT_SPAWN_INTERRUPTED_WITH_LINEAGE",
              source: "recovery",
            },
          },
        },
      });
      expect(restarted.spawnCalls).toBe(0);
    } finally {
      releaseCrashed();
      await first;
      await fs.rm(root, { recursive: true, force: true });
    }
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

  // The test above proves explicit `admission: "rejoin"` reattaches a
  // still-running child, but its `InMemoryAssignments` repository and
  // `RunAgentAssignment` instance are the SAME objects the "before" state
  // was written through, in the same process — a same-process replay, not
  // a restart. Table: {same-process replay (above), genuine restart
  // (below)} x {still-running child, explicit rejoin}. The restart cell,
  // mirroring LIF-07's own restart proof earlier in this file, was the
  // empty one: nothing here proved `task.rejoin-agent` reattaches the same
  // child when the parent process actually died and came back.
  it("rejoins the exact running child through a fresh service and store after a genuine restart", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-agent-rejoin-restart-"),
    );
    try {
      const store = () => new PrivateAssignmentStore({ root });
      const running = startAssignment(
        createAssignment(
          command.identity,
          assignmentAuthority,
          agentAssignmentCommandFingerprint(command, commandDigester),
        ),
        exactChild,
      );
      if (!running.ok) throw new Error("RUNNING_FIXTURE_INVALID");
      // A first process admits and starts the child, then "dies": nothing
      // but what it wrote under `root` crosses into the next process.
      await store().admit({
        assignment: createAssignment(
          command.identity,
          assignmentAuthority,
          agentAssignmentCommandFingerprint(command, commandDigester),
        ),
        resultRef: null,
        parentDelivery: "not_applicable",
      });
      await store().save({
        assignment: running.value,
        resultRef: null,
        parentDelivery: "not_applicable",
      });

      // A restarted process has a fresh service module (same technique as
      // LIF-07 above) and a fresh store instance: the rejoin below reads
      // the running child's identity from disk, never from a closure this
      // test still holds.
      vi.resetModules();
      const restartedModule =
        await import("../../src/modules/agent/app/service/run-agent-assignment");
      const restartedHost = new AgentHostDouble(new Error("must not spawn"), {
        status: "completed",
        correlation: exactChild,
        resultRef: "result-preview-rejoined-restart",
        workspaceEnforcement: "verified",
      });
      await expect(
        new restartedModule.RunAgentAssignment(
          restartedHost,
          store(),
          new AuthorityDouble(),
          commandDigester,
        ).execute({ ...command, admission: "rejoin" }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          assignment: { phase: "completed", terminal: true },
          resultRef: "result-preview-rejoined-restart",
        },
      });
      expect(restartedHost.spawnCalls).toBe(0);
      expect(restartedHost.waitCalls).toBe(1);

      // Negative control: a request whose identity no longer correlates
      // with the stored record must still be refused after the very same
      // restart, proving the fresh instance discriminates on identity
      // rather than rejoining whatever it finds under the same admission
      // key. (The record IS found by assignment id, which is why this
      // fails closed one check later, at the authority correlation, not at
      // "no record" — a different but equally decisive refusal.)
      const foreignHost = new AgentHostDouble(
        new Error("must not spawn"),
        new Error("must not wait"),
      );
      await expect(
        new restartedModule.RunAgentAssignment(
          foreignHost,
          store(),
          new AuthorityDouble(),
          commandDigester,
        ).execute({
          ...command,
          identity: { ...command.identity, taskId: "task-foreign-restart" },
          admission: "rejoin",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "AGENT_AUTHORITY_CORRELATION" },
      });
      expect(foreignHost.spawnCalls).toBe(0);
      expect(foreignHost.waitCalls).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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
    // A thrown wait is no longer terminal (LIF-05): the known child stays
    // running and observable; see "LIF-05 and LIF-06 observing the same
    // child again".
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

describe("LIF-05 and LIF-06 observing the same child again", () => {
  it("keeps a child observable after a failed wait and recovers its result without a second child", async () => {
    const rejoins: unknown[] = [];
    let waits = 0;
    const host: AgentHost & { spawnCalls: number } = {
      spawnCalls: 0,
      async spawn() {
        this.spawnCalls += 1;
        return {
          status: "started",
          correlation: exactChild,
          authorityProof: "proof-preview-a",
        };
      },
      async wait(correlation, rejoin) {
        waits += 1;
        rejoins.push(rejoin);
        if (waits === 1) throw new Error("TRANSPORT_LOST");
        return {
          status: "completed",
          correlation,
          resultRef: "result-preview-observed",
          workspaceEnforcement: "verified" as const,
        };
      },
      async cancel() {
        throw new Error("UNEXPECTED_CANCEL");
      },
    };
    const repository = new InMemoryAssignments();

    await expect(
      createRunner(host, repository).execute(command),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "running", terminal: false },
        observation: "unavailable",
        resultRef: null,
      },
    });
    // A later rejoin, possibly from a new process, observes the same child.
    await expect(
      createRunner(host, repository).execute({
        ...command,
        admission: "rejoin",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "completed", terminal: true },
        observation: "current",
        resultRef: "result-preview-observed",
      },
    });
    expect(host.spawnCalls).toBe(1);
    expect(rejoins[1]).toEqual({
      request: {
        identity: command.identity,
        authority: delegatedAuthority,
        focus: command.focus,
        intent: command.intent,
      },
      authorityProof: "proof-preview-a",
    });
  });
});
