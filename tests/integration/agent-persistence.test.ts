import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import {
  RunAgentAssignment,
  type AgentAssignmentCommand,
} from "../../src/modules/agent/app/service/run-agent-assignment";
import { AcknowledgeAgentResult } from "../../src/modules/agent/app/service/acknowledge-agent-result";
import {
  completeAssignment,
  createAssignment,
  markChildOutcomeUnknown,
  startAssignment,
  type AssignmentAuthority,
  type ChildCorrelation,
} from "../../src/modules/agent/domain/assignment";
import { PrivateAssignmentStore } from "../../src/modules/agent/infra/repo/private-assignment-store";

const command: AgentAssignmentCommand = {
  identity: {
    assignmentId: "assignment-durable-a",
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

const authority: DelegatedAgentAuthority = {
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
  capabilities: ["workspace.read", "workspace.write"],
  network: "none",
  commands: "none",
  expiresAt: 10_000,
};

const assignmentAuthority: AssignmentAuthority = {
  authorityId: authority.authorityId,
  participantId: authority.participantId,
  parentParticipantId: authority.parentParticipantId,
  role: authority.role,
  mutationOwnership: authority.mutationOwnership,
};

const child: ChildCorrelation = {
  ...command.identity,
  authorityId: authority.authorityId,
  participantId: authority.participantId,
  role: authority.role,
  parentThreadId: "parent-thread-durable-a",
  childId: "child-durable-a",
  hostRole: "agent",
  delegationDigest: "a".repeat(64),
};

function preparedRecord() {
  return {
    assignment: createAssignment(command.identity, assignmentAuthority),
    resultRef: null,
    parentDelivery: "not_applicable" as const,
    workspaceEnforcement: "not_applicable" as const,
  };
}

function runningRecord() {
  const running = startAssignment(preparedRecord().assignment, child);
  if (!running.ok) throw new Error(running.error.code);
  return {
    assignment: running.value,
    resultRef: null,
    parentDelivery: "not_applicable" as const,
    workspaceEnforcement: "not_applicable" as const,
  };
}

class AuthorityDouble implements AgentAuthorityPort {
  async delegate() {
    return { ok: true as const, value: authority };
  }
}

class RejoinHost implements AgentHost {
  spawnCalls = 0;
  waitCalls = 0;

  async spawn(_request: AgentSpawnRequest): Promise<AgentSpawnReceipt> {
    this.spawnCalls += 1;
    throw new Error("DUPLICATE_SPAWN");
  }

  async wait(correlation: ChildCorrelation): Promise<AgentWaitReceipt> {
    this.waitCalls += 1;
    expect(correlation).toEqual(child);
    return {
      status: "completed",
      correlation,
      resultRef: "result-durable-a",
      workspaceEnforcement: "verified",
    };
  }
}

async function descendants(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name);
      if (!entry.isDirectory()) return [target];
      return [target, ...(await descendants(target))];
    }),
  );
  return nested.flat();
}

describe("private Agent assignment persistence", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function stateRoot(): Promise<string> {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-agent-state-"),
    );
    roots.push(root);
    return root;
  }

  it("survives a new store instance with exact identity and private modes", async () => {
    const root = await stateRoot();
    const first = new PrivateAssignmentStore({ root });
    await expect(first.admit(preparedRecord())).resolves.toMatchObject({
      status: "admitted",
    });
    await first.save(runningRecord());

    const restarted = new PrivateAssignmentStore({ root });
    await expect(restarted.admit(preparedRecord())).resolves.toEqual({
      status: "existing",
      record: runningRecord(),
    });

    for (const target of [root, ...(await descendants(root))]) {
      const stat = await fs.lstat(target);
      expect(stat.mode & 0o077).toBe(0);
      expect(stat.mode & 0o700).toBe(stat.isDirectory() ? 0o700 : 0o600);
    }
  });

  it("rejoins and retains the same child result across runtime restarts", async () => {
    const root = await stateRoot();
    const first = new PrivateAssignmentStore({ root });
    await first.admit(preparedRecord());
    await first.save(runningRecord());

    const host = new RejoinHost();
    const restarted = new RunAgentAssignment(
      host,
      new PrivateAssignmentStore({ root }),
      new AuthorityDouble(),
    );
    await expect(restarted.execute(command)).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "completed", childId: child.childId },
        resultRef: "result-durable-a",
      },
    });
    expect(host.spawnCalls).toBe(0);
    expect(host.waitCalls).toBe(1);

    await expect(
      new AcknowledgeAgentResult(new PrivateAssignmentStore({ root })).execute({
        correlation: child,
        parentParticipantId: assignmentAuthority.parentParticipantId,
        resultRef: "result-durable-a",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { parentDelivery: "acknowledged" },
    });

    const retainedHost = new RejoinHost();
    await expect(
      new RunAgentAssignment(
        retainedHost,
        new PrivateAssignmentStore({ root }),
        new AuthorityDouble(),
      ).execute(command),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "completed", childId: child.childId },
        resultRef: "result-durable-a",
        parentDelivery: "acknowledged",
        resultRetention: "durable",
      },
    });
    expect(retainedHost.spawnCalls).toBe(0);
    expect(retainedHost.waitCalls).toBe(0);
  });

  it("keeps the previous durable phase when replacement is interrupted", async () => {
    const root = await stateRoot();
    const stable = new PrivateAssignmentStore({ root });
    await stable.admit(preparedRecord());
    const running = runningRecord();
    await stable.save(running);
    const completed = completeAssignment(running.assignment, child);
    if (!completed.ok) throw new Error(completed.error.code);

    const interrupted = new PrivateAssignmentStore(
      { root },
      {
        beforeCommit: async () => {
          throw new Error("SYNTHETIC_ASSIGNMENT_RENAME_INTERRUPTION");
        },
      },
    );
    await expect(
      interrupted.save({
        assignment: completed.value,
        resultRef: "result-durable-a",
        parentDelivery: "pending",
        workspaceEnforcement: "verified",
      }),
    ).rejects.toThrow("SYNTHETIC_ASSIGNMENT_RENAME_INTERRUPTION");
    await expect(stable.admit(preparedRecord())).resolves.toEqual({
      status: "existing",
      record: running,
    });
    expect(
      (await descendants(root)).some((target) =>
        path.basename(target).includes(".tmp-"),
      ),
    ).toBe(false);
  });

  it("does not expose a partial record when first admission is interrupted", async () => {
    const root = await stateRoot();
    const interrupted = new PrivateAssignmentStore({ root }, {
      beforeAdmissionCommit: async () => {
        throw new Error("SYNTHETIC_ASSIGNMENT_ADMISSION_INTERRUPTION");
      },
    } as never);

    await expect(interrupted.admit(preparedRecord())).rejects.toThrow(
      "SYNTHETIC_ASSIGNMENT_ADMISSION_INTERRUPTION",
    );
    await expect(
      new PrivateAssignmentStore({ root }).admit(preparedRecord()),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(
      (await descendants(root)).some((target) =>
        path.basename(target).includes(".tmp-"),
      ),
    ).toBe(false);
  });

  it("serializes competing terminal writes instead of accepting stale overwrite", async () => {
    const root = await stateRoot();
    const stable = new PrivateAssignmentStore({ root });
    await stable.admit(preparedRecord());
    const running = runningRecord();
    await stable.save(running);
    const completed = completeAssignment(running.assignment, child);
    const uncertain = markChildOutcomeUnknown(running.assignment, child);
    if (!completed.ok) throw new Error(completed.error.code);
    if (!uncertain.ok) throw new Error(uncertain.error.code);

    let enterCommit!: () => void;
    let releaseCommit!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterCommit = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const delayed = new PrivateAssignmentStore(
      { root },
      {
        beforeCommit: async () => {
          enterCommit();
          await release;
        },
      },
    );
    let enterCompetingCommit!: () => void;
    const competingEntered = new Promise<void>((resolve) => {
      enterCompetingCommit = resolve;
    });
    const competing = new PrivateAssignmentStore(
      { root },
      {
        beforeCommit: async () => {
          enterCompetingCommit();
        },
      },
    );
    const stale = delayed.save({
      assignment: uncertain.value,
      resultRef: null,
      parentDelivery: "not_applicable",
      workspaceEnforcement: "not_applicable",
    });
    await entered;
    const winner = competing.save({
      assignment: completed.value,
      resultRef: "result-durable-a",
      parentDelivery: "pending",
      workspaceEnforcement: "verified",
    });
    const concurrentState = await Promise.race([
      competingEntered.then(() => "entered" as const),
      new Promise<"blocked">((resolve) => {
        setTimeout(() => resolve("blocked"), 25);
      }),
    ]);
    releaseCommit();

    const outcomes = await Promise.allSettled([stale, winner]);
    expect(concurrentState).toBe("blocked");
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    await expect(stable.load(command.identity)).resolves.toMatchObject({
      assignment: { terminal: true },
    });
  });

  it("rejects stale, rebound and terminal rewrites", async () => {
    const root = await stateRoot();
    const store = new PrivateAssignmentStore({ root });
    await store.admit(preparedRecord());
    const running = runningRecord();
    await store.save(running);

    await expect(store.save(preparedRecord())).rejects.toThrow(
      "AGENT_ASSIGNMENT_STALE_WRITE",
    );
    await expect(
      store.save({
        ...running,
        assignment: {
          ...running.assignment,
          authority: {
            ...running.assignment.authority,
            participantId: "foreign-participant",
          },
        },
      }),
    ).rejects.toThrow("AGENT_ASSIGNMENT_BINDING_MISMATCH");
    await expect(
      store.save({
        ...running,
        assignment: {
          ...running.assignment,
          childId: "foreign-child",
        },
      }),
    ).rejects.toThrow("AGENT_ASSIGNMENT_CHILD_MISMATCH");
    await expect(
      store.save({
        ...running,
        assignment: {
          ...running.assignment,
          delegationDigest: "b".repeat(64),
        },
      }),
    ).rejects.toThrow("AGENT_ASSIGNMENT_CHILD_MISMATCH");

    const completed = completeAssignment(running.assignment, child);
    if (!completed.ok) throw new Error(completed.error.code);
    const terminal = {
      assignment: completed.value,
      resultRef: "result-durable-a",
      parentDelivery: "pending" as const,
      workspaceEnforcement: "verified" as const,
    };
    await store.save(terminal);
    await expect(store.save(terminal)).resolves.toBeUndefined();
    const uncertain = markChildOutcomeUnknown(running.assignment, child);
    if (!uncertain.ok) throw new Error(uncertain.error.code);
    await expect(
      store.save({
        assignment: uncertain.value,
        resultRef: null,
        parentDelivery: "not_applicable",
        workspaceEnforcement: "not_applicable",
      }),
    ).rejects.toThrow("AGENT_ASSIGNMENT_TERMINAL_IMMUTABLE");
  });

  it("bounds records and rejects a file that is no longer private", async () => {
    const root = await stateRoot();
    const undersized = new PrivateAssignmentStore({
      root,
      maximumRecordBytes: 128,
    });
    await expect(undersized.admit(preparedRecord())).rejects.toThrow(
      "AGENT_ASSIGNMENT_STATE_OVERSIZED",
    );

    const store = new PrivateAssignmentStore({ root });
    await store.admit(preparedRecord());
    const recordFile = (await descendants(root)).find((target) =>
      target.endsWith(".json"),
    );
    if (!recordFile) throw new Error("ASSIGNMENT_FILE_MISSING");
    await fs.chmod(recordFile, 0o644);
    await expect(store.admit(preparedRecord())).rejects.toThrow(
      "AGENT_ASSIGNMENT_STATE_UNSAFE",
    );
  });

  it("rejects corrupt and unsupported durable records without spawning", async () => {
    const root = await stateRoot();
    const store = new PrivateAssignmentStore({ root });
    await store.admit(preparedRecord());
    const recordFile = (await descendants(root)).find((target) =>
      target.endsWith(".json"),
    );
    if (!recordFile) throw new Error("ASSIGNMENT_FILE_MISSING");

    await fs.writeFile(recordFile, "{not-json", { mode: 0o600 });
    await expect(store.admit(preparedRecord())).rejects.toThrow(
      "AGENT_ASSIGNMENT_STATE_CORRUPT",
    );

    await fs.writeFile(
      recordFile,
      JSON.stringify({ schemaVersion: 99, kind: "agent_assignment" }),
      { mode: 0o600 },
    );
    await expect(store.admit(preparedRecord())).rejects.toThrow(
      "AGENT_ASSIGNMENT_STATE_UNSUPPORTED",
    );
  });
});
