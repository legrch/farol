import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentHost } from "../../src/modules/agent/app/port/agent-host";
import type { AssignmentRepository } from "../../src/modules/agent/app/port/assignment-repository";
import { CancelAgentAssignment } from "../../src/modules/agent/app/service/cancel-agent-assignment";
import {
  createAssignment,
  completeAssignment,
  cancelChildAssignment,
  startAssignment,
  type ChildCorrelation,
} from "../../src/modules/agent/domain/assignment";
import { InMemoryAssignments } from "../../src/modules/agent/infra/repo/in-memory-assignments";
import { PrivateAssignmentStore } from "../../src/modules/agent/infra/repo/private-assignment-store";

const disposableRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    disposableRoots.splice(0).map((root) => fs.rm(root, { recursive: true })),
  );
});

const identity = {
  assignmentId: "assignment-cancel-a",
  ownerId: "owner-cancel-a",
  sessionId: "session-cancel-a",
  taskId: "task-cancel-a",
  taskEpoch: 3,
  generation: 1,
} as const;

const correlation: ChildCorrelation = {
  ...identity,
  authorityId: "authority-cancel-a",
  participantId: "agent-cancel-a",
  role: "agent",
  parentThreadId: "parent-cancel-a",
  childId: "child-cancel-a",
  parentTurnId: "parent-turn-cancel-a",
  childTurnId: "child-turn-cancel-a",
  hostRole: "default",
  delegationDigest: "a".repeat(64),
};

async function runningRepository(): Promise<InMemoryAssignments> {
  const repository = new InMemoryAssignments();
  const running = startAssignment(
    createAssignment(identity, {
      authorityId: correlation.authorityId,
      participantId: correlation.participantId,
      parentParticipantId: "main-cancel-a",
      role: correlation.role,
      mutationOwnership: "none",
    }),
    correlation,
  );
  if (!running.ok) throw new Error(running.error.code);
  await repository.admit({
    assignment: running.value,
    resultRef: null,
    parentDelivery: "not_applicable",
    workspaceEnforcement: "not_applicable",
  });
  return repository;
}

function preparedRecord() {
  return {
    assignment: createAssignment(identity, {
      authorityId: correlation.authorityId,
      participantId: correlation.participantId,
      parentParticipantId: "main-cancel-a",
      role: correlation.role,
      mutationOwnership: "none" as const,
    }),
    resultRef: null,
    parentDelivery: "not_applicable" as const,
    workspaceEnforcement: "not_applicable" as const,
  };
}

function host(
  receipt: Awaited<ReturnType<AgentHost["cancel"]>>,
): AgentHost & { cancel: ReturnType<typeof vi.fn> } {
  return {
    spawn: vi.fn(async () => {
      throw new Error("unexpected spawn");
    }),
    wait: vi.fn(async () => {
      throw new Error("unexpected wait");
    }),
    cancel: vi.fn(async () => receipt),
  };
}

describe("Agent cancellation", () => {
  async function durableRepository() {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-cancel-recovery-"),
    );
    disposableRoots.push(root);
    const repository = new PrivateAssignmentStore({ root });
    const initial = await (await runningRepository()).load(identity);
    if (!initial) throw new Error("SYNTHETIC_ASSIGNMENT_MISSING");
    await repository.admit(initial);
    return { root, repository };
  }

  it("retains cancellation intent across journal recreation after lost ack and failed save", async () => {
    const { root, repository } = await durableRepository();
    const native = host({ status: "cancelled", correlation });
    native.cancel.mockRejectedValue(new Error("SYNTHETIC_ACK_LOST"));
    const saveFailure: AssignmentRepository = {
      admit: repository.admit.bind(repository),
      load: repository.load.bind(repository),
      claimCancellation: repository.claimCancellation.bind(repository),
      save: vi.fn(async () => {
        throw new Error("SYNTHETIC_SAVE_FAILURE");
      }),
    };
    await expect(
      new CancelAgentAssignment(native, saveFailure).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "outcome_unknown" },
        assignmentRetention: "memory_only",
      },
    });
    await expect(
      new CancelAgentAssignment(
        native,
        new PrivateAssignmentStore({ root }),
      ).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "outcome_unknown",
          terminalReason: { retry: "never" },
        },
        assignmentRetention: "memory_only",
      },
    });
    expect(native.cancel).toHaveBeenCalledTimes(1);
    expect(native.spawn).not.toHaveBeenCalled();
    expect(native.wait).not.toHaveBeenCalled();
    await expect(repository.load(identity)).resolves.toMatchObject({
      assignment: { phase: "running" },
    });
  });

  it("does not send after a crash between durable intent and the host boundary", async () => {
    const { root, repository } = await durableRepository();
    expect(await repository.claimCancellation(identity, correlation)).toBe(
      true,
    );
    const native = host({ status: "cancelled", correlation });
    await expect(
      new CancelAgentAssignment(
        native,
        new PrivateAssignmentStore({ root }),
      ).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "outcome_unknown" },
        assignmentRetention: "memory_only",
      },
    });
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it("blocks a second durable service while the cancellation owner is in flight", async () => {
    const { root, repository } = await durableRepository();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredHost = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const native = host({ status: "cancelled", correlation });
    native.cancel.mockImplementation(async () => {
      entered();
      await pending;
      return { status: "cancelled", correlation };
    });
    const first = new CancelAgentAssignment(native, repository).execute(
      identity,
    );
    await enteredHost;
    try {
      await expect(
        new CancelAgentAssignment(
          native,
          new PrivateAssignmentStore({ root }),
        ).execute(identity),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          assignment: { phase: "outcome_unknown" },
          assignmentRetention: "memory_only",
        },
      });
      await expect(repository.load(identity)).resolves.toMatchObject({
        assignment: { phase: "running" },
      });
    } finally {
      release();
    }
    await expect(first).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "cancelled" },
        assignmentRetention: "durable",
      },
    });
    expect(native.cancel).toHaveBeenCalledTimes(1);
  });

  it("permits only one cancellation claim from two independent native processes", async () => {
    const { root } = await durableRepository();
    const bundle = path.join(root, "fixture-store.cjs");
    await build({
      entryPoints: [
        path.resolve(
          "src/modules/agent/infra/repo/private-assignment-store.ts",
        ),
      ],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
    });
    const program = `
      const { PrivateAssignmentStore } = require(process.argv[1]);
      const store = new PrivateAssignmentStore({ root: process.argv[2] });
      store.claimCancellation(JSON.parse(process.argv[3]), JSON.parse(process.argv[4]))
        .then(result => process.stdout.write(JSON.stringify(result)))
        .catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
    `;
    const run = () =>
      promisify(execFile)(
        process.execPath,
        [
          "-e",
          program,
          bundle,
          root,
          JSON.stringify(identity),
          JSON.stringify(correlation),
        ],
        { timeout: 10_000, maxBuffer: 4_096 },
      );
    const settled = await Promise.allSettled([run(), run()]);
    const outcomes = settled.map((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      return outcome.value;
    });
    expect(
      outcomes.map((outcome) => JSON.parse(outcome.stdout)).sort(),
    ).toEqual([false, true]);
    expect(outcomes.map((outcome) => outcome.stderr)).toEqual(["", ""]);
  });

  it("never overwrites a completed result with a stale terminal cancel from another process", async () => {
    const { root, repository } = await durableRepository();
    const initial = await repository.load(identity);
    if (!initial) throw new Error("SYNTHETIC_ASSIGNMENT_MISSING");
    const cancelled = cancelChildAssignment(initial.assignment, correlation);
    const completed = completeAssignment(initial.assignment, correlation);
    if (!cancelled.ok || !completed.ok)
      throw new Error("SYNTHETIC_TERMINAL_FAILURE");
    const bundle = path.join(root, "fixture-store.cjs");
    await build({
      entryPoints: [
        path.resolve(
          "src/modules/agent/infra/repo/private-assignment-store.ts",
        ),
      ],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
    });
    const program = `
      const { PrivateAssignmentStore } = require(process.argv[1]);
      const store = new PrivateAssignmentStore({ root: process.argv[2] }, {
        beforeCommit: async () => {
          process.stdout.write('ready\\n');
          await new Promise(resolve => process.stdin.once('data', resolve));
        }
      });
      store.save(JSON.parse(process.argv[3]))
        .then(() => { process.stdout.write('saved'); process.stdin.destroy(); })
        .catch(error => { process.stdout.write(error.message); process.stdin.destroy(); });
    `;
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    let validated!: () => void;
    const atValidation = new Promise<void>((resolve) => {
      validated = resolve;
    });
    const completionStore = new PrivateAssignmentStore(
      { root },
      {
        afterSaveValidation: async () => {
          validated();
          await completionGate;
        },
      },
    );
    const completion = completionStore.save({
      assignment: completed.value,
      resultRef: "fixture-completed-result",
      parentDelivery: "pending",
      workspaceEnforcement: "verified",
    });
    const completionSettled = Promise.allSettled([completion]);
    await atValidation;
    const stale = promisify(execFile)(
      process.execPath,
      [
        "-e",
        program,
        bundle,
        root,
        JSON.stringify({
          assignment: cancelled.value,
          resultRef: null,
          parentDelivery: "not_applicable",
          workspaceEnforcement: "not_applicable",
        }),
      ],
      { timeout: 10_000, maxBuffer: 4_096 },
    );
    const settled = Promise.allSettled([stale]);
    try {
      await new Promise<void>((resolve, reject) => {
        stale.child.stdout!.once("data", () => resolve());
        stale.child.once("error", reject);
        stale.child.once("close", () =>
          reject(new Error("SYNTHETIC_STALE_CHILD_EARLY_EXIT")),
        );
      });
      releaseCompletion();
      await completion;
    } finally {
      releaseCompletion();
      stale.child.stdin!.end("commit");
      const [outcomes] = await Promise.all([settled, completionSettled]);
      if (outcomes[0]!.status === "rejected") throw outcomes[0]!.reason;
    }
    await expect(repository.load(identity)).resolves.toMatchObject({
      assignment: { phase: "completed" },
      resultRef: "fixture-completed-result",
    });
  });

  it("preserves raced durable completion before submitting a claimed cancel", async () => {
    const repository = await runningRepository();
    const initial = await repository.load(identity);
    if (!initial) throw new Error("SYNTHETIC_ASSIGNMENT_MISSING");
    const completed = completeAssignment(initial.assignment, correlation);
    if (!completed.ok) throw new Error(completed.error.code);
    const store: AssignmentRepository = {
      admit: repository.admit.bind(repository),
      load: repository.load.bind(repository),
      save: repository.save.bind(repository),
      claimCancellation: async () => {
        await repository.save({
          assignment: completed.value,
          resultRef: "fixture-result",
          parentDelivery: "pending",
          workspaceEnforcement: "verified",
        });
        return true;
      },
    };
    const native = host({ status: "cancelled", correlation });
    await expect(
      new CancelAgentAssignment(native, store).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "completed" },
        resultRef: "fixture-result",
        assignmentRetention: "durable",
      },
    });
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it("refuses an unsupported intent store without invoking the host", async () => {
    const repository = await runningRepository();
    const native = host({ status: "cancelled", correlation });
    const legacy: AssignmentRepository = {
      admit: repository.admit.bind(repository),
      load: repository.load.bind(repository),
      save: repository.save.bind(repository),
    };
    await expect(
      new CancelAgentAssignment(native, legacy).execute(identity),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_CANCELLATION_UNAVAILABLE" },
    });
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it("refuses if cancellation intent cannot be durably claimed", async () => {
    const repository = await runningRepository();
    const native = host({ status: "cancelled", correlation });
    const broken: AssignmentRepository = {
      admit: repository.admit.bind(repository),
      load: repository.load.bind(repository),
      save: repository.save.bind(repository),
      claimCancellation: async () => {
        throw new Error("SYNTHETIC_INTENT_FAILURE");
      },
    };
    await expect(
      new CancelAgentAssignment(native, broken).execute(identity),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AGENT_CANCELLATION_UNAVAILABLE" },
    });
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it("leaves an existing intent unknown when its terminal receipt cannot be read", async () => {
    const repository = await runningRepository();
    const initial = await repository.load(identity);
    if (!initial) throw new Error("SYNTHETIC_ASSIGNMENT_MISSING");
    const native = host({ status: "cancelled", correlation });
    let claimed = false;
    const broken: AssignmentRepository = {
      admit: repository.admit.bind(repository),
      save: vi.fn(repository.save.bind(repository)),
      load: async () => {
        if (!claimed) return initial;
        throw new Error("SYNTHETIC_RECEIPT_UNAVAILABLE");
      },
      claimCancellation: async () => {
        claimed = true;
        return false;
      },
    };
    await expect(
      new CancelAgentAssignment(native, broken).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "outcome_unknown" },
        assignmentRetention: "memory_only",
      },
    });
    expect(native.cancel).not.toHaveBeenCalled();
    expect(broken.save).not.toHaveBeenCalled();
  });

  it.each(["unreadable", "foreign-child"] as const)(
    "refuses %s state after a cancellation claim",
    async (fault) => {
      const repository = await runningRepository();
      const initial = await repository.load(identity);
      if (!initial) throw new Error("SYNTHETIC_ASSIGNMENT_MISSING");
      const native = host({ status: "cancelled", correlation });
      let claimed = false;
      const broken: AssignmentRepository = {
        admit: repository.admit.bind(repository),
        save: repository.save.bind(repository),
        load: async () => {
          if (!claimed) return initial;
          if (fault === "unreadable") throw new Error("SYNTHETIC_LOAD_FAILURE");
          return {
            ...initial,
            assignment: { ...initial.assignment, childId: "foreign-child" },
          };
        },
        claimCancellation: async () => {
          claimed = true;
          return true;
        },
      };
      await expect(
        new CancelAgentAssignment(native, broken).execute(identity),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code:
            fault === "unreadable"
              ? "AGENT_CANCELLATION_UNAVAILABLE"
              : "AGENT_CORRELATION",
        },
      });
      expect(native.cancel).not.toHaveBeenCalled();
    },
  );

  it("rejects a different child before publishing cancellation intent", async () => {
    const { root, repository } = await durableRepository();
    await expect(
      repository.claimCancellation(identity, {
        ...correlation,
        childId: "foreign-child",
      }),
    ).rejects.toThrow("AGENT_CANCELLATION_BINDING_MISMATCH");
    expect(
      (await fs.readdir(path.join(root, "assignments"))).some((entry) =>
        entry.endsWith(".cancel-intent"),
      ),
    ).toBe(false);
    await expect(
      repository.claimCancellation(identity, correlation),
    ).resolves.toBe(true);
  });

  it("keeps even a corrupt intent fail closed and never repairs it by another cancel", async () => {
    const { root, repository } = await durableRepository();
    await repository.claimCancellation(identity, correlation);
    const directory = path.join(root, "assignments");
    const filename = (await fs.readdir(directory)).find((entry) =>
      entry.endsWith(".cancel-intent"),
    );
    if (!filename) throw new Error("SYNTHETIC_INTENT_MISSING");
    const intent = path.join(directory, filename);
    expect((await fs.stat(intent)).mode & 0o777).toBe(0o600);
    await fs.writeFile(intent, "corrupt fixture intent");
    const native = host({ status: "cancelled", correlation });
    await expect(
      new CancelAgentAssignment(
        native,
        new PrivateAssignmentStore({ root }),
      ).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "outcome_unknown" },
        assignmentRetention: "memory_only",
      },
    });
    expect(native.cancel).not.toHaveBeenCalled();
    expect(await fs.readFile(intent, "utf8")).toBe("corrupt fixture intent");
  });

  it("never resubmits cancellation after an acknowledgement and failed tombstone", async () => {
    const stable = await runningRepository();
    const unavailable: AssignmentRepository = {
      admit: stable.admit.bind(stable),
      load: stable.load.bind(stable),
      claimCancellation: stable.claimCancellation.bind(stable),
      save: vi.fn(async () => {
        throw new Error("SYNTHETIC_SAVE_FAILURE");
      }),
    };
    const native = host({ status: "cancelled", correlation });
    await new CancelAgentAssignment(native, unavailable).execute(identity);
    await new CancelAgentAssignment(native, unavailable).execute(identity);
    expect(native.cancel).toHaveBeenCalledTimes(1);
  });

  it("allows only one concurrent cancellation from separate service objects", async () => {
    const repository = await runningRepository();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let admitted!: () => void;
    const entered = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const native = host({ status: "cancelled", correlation });
    native.cancel.mockImplementation(async () => {
      admitted();
      await pending;
      return { status: "cancelled", correlation };
    });
    const first = new CancelAgentAssignment(native, repository).execute(
      identity,
    );
    await entered;
    const second = new CancelAgentAssignment(native, repository).execute(
      identity,
    );
    release();
    await Promise.all([first, second]);
    expect(native.cancel).toHaveBeenCalledTimes(1);
  });

  it("durably tombstones an exactly acknowledged child interruption", async () => {
    const repository = await runningRepository();
    const native = host({ status: "cancelled", correlation });
    const service = new CancelAgentAssignment(native, repository);

    await expect(service.execute(identity)).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "cancelled",
          terminal: true,
          terminalReason: { code: "AGENT_CANCELLED", retry: "never" },
        },
        assignmentRetention: "durable",
      },
    });
    await expect(repository.load(identity)).resolves.toMatchObject({
      assignment: { phase: "cancelled", terminal: true },
    });
    await expect(service.execute(identity)).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "cancelled", terminal: true },
        assignmentRetention: "durable",
      },
    });
    expect(native.cancel).toHaveBeenCalledExactlyOnceWith(correlation);
  });

  it("preserves an unconfirmed interruption as outcome unknown", async () => {
    const repository = await runningRepository();
    const native = host({
      status: "outcome_unknown",
      correlation,
      code: "AGENT_WAIT_ACK_LOST",
    });

    await expect(
      new CancelAgentAssignment(native, repository).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "outcome_unknown", terminal: true },
        assignmentRetention: "durable",
      },
    });
  });

  it("retains a raced completion instead of rewriting it as cancellation", async () => {
    const repository = await runningRepository();
    const native = host({
      status: "completed",
      correlation,
      resultRef: "codex-app-server://thread/child-cancel-a/turn/turn-a",
      workspaceEnforcement: "verified",
    });

    await expect(
      new CancelAgentAssignment(native, repository).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "completed", terminal: true },
        resultRef: "codex-app-server://thread/child-cancel-a/turn/turn-a",
        parentDelivery: "pending",
        assignmentRetention: "durable",
      },
    });
  });

  it("fails closed when durable state is missing or unreadable", async () => {
    const native = host({ status: "cancelled", correlation });
    const missing = new InMemoryAssignments();
    const unreadable: AssignmentRepository = {
      admit: vi.fn(async (record) => ({ status: "admitted" as const, record })),
      load: vi.fn(async () => {
        throw new Error("SYNTHETIC_LOAD_FAILURE");
      }),
      save: vi.fn(async () => undefined),
    };

    await expect(
      new CancelAgentAssignment(native, missing).execute(identity),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_CANCELLATION_UNAVAILABLE", retry: "never" },
    });
    await expect(
      new CancelAgentAssignment(native, unreadable).execute(identity),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_CANCELLATION_UNAVAILABLE", retry: "never" },
    });
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it("tombstones a prepared assignment as outcome unknown without guessing a child", async () => {
    const repository = new InMemoryAssignments();
    await repository.admit(preparedRecord());
    const native = host({ status: "cancelled", correlation });

    await expect(
      new CancelAgentAssignment(native, repository).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "outcome_unknown",
          terminal: true,
          terminalReason: {
            code: "AGENT_CANCEL_WITHOUT_CHILD_CORRELATION",
            source: "native-host-transport",
            retry: "never",
          },
        },
      },
    });
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it("fails closed on an impossible nonterminal durable phase", async () => {
    const repository = new InMemoryAssignments();
    await repository.admit({
      ...preparedRecord(),
      assignment: {
        ...preparedRecord().assignment,
        phase: "completed",
      },
    });

    await expect(
      new CancelAgentAssignment(
        host({ status: "cancelled", correlation }),
        repository,
      ).execute(identity),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_ALREADY_STARTED", retry: "never" },
    });
  });

  it("maps a lost cancel acknowledgement to outcome unknown", async () => {
    const repository = await runningRepository();
    const native: AgentHost = {
      ...host({ status: "cancelled", correlation }),
      cancel: vi.fn(async () => {
        throw new Error("SYNTHETIC_CANCEL_TRANSPORT_FAILURE");
      }),
    };

    await expect(
      new CancelAgentAssignment(native, repository).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "outcome_unknown",
          terminalReason: {
            code: "AGENT_WAIT_ACK_LOST",
            source: "native-host-transport",
          },
        },
      },
    });
  });

  it("refuses a cancellation receipt for a different child", async () => {
    const repository = await runningRepository();

    await expect(
      new CancelAgentAssignment(
        host({
          status: "cancelled",
          correlation: { ...correlation, childId: "foreign-child" },
        }),
        repository,
      ).execute(identity),
    ).resolves.toEqual({
      ok: false,
      error: { code: "AGENT_CORRELATION", retry: "never" },
    });
    await expect(repository.load(identity)).resolves.toMatchObject({
      assignment: { phase: "running", terminal: false },
    });
  });

  it("retains an acknowledged child failure with native-host provenance", async () => {
    const repository = await runningRepository();

    await expect(
      new CancelAgentAssignment(
        host({ status: "failed", correlation, code: "AGENT_CHILD_FAILED" }),
        repository,
      ).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: {
          phase: "failed",
          terminal: true,
          terminalReason: {
            code: "AGENT_CHILD_FAILED",
            source: "native-host",
            retry: "never",
          },
        },
      },
    });
  });

  it("reports memory-only retention when the terminal tombstone cannot persist", async () => {
    const stable = await runningRepository();
    const unavailable: AssignmentRepository = {
      admit: stable.admit.bind(stable),
      load: stable.load.bind(stable),
      claimCancellation: stable.claimCancellation.bind(stable),
      save: vi.fn(async () => {
        throw new Error("SYNTHETIC_SAVE_FAILURE");
      }),
    };

    await expect(
      new CancelAgentAssignment(
        host({ status: "cancelled", correlation }),
        unavailable,
      ).execute(identity),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        assignment: { phase: "cancelled", terminal: true },
        assignmentRetention: "memory_only",
      },
    });
    await expect(stable.load(identity)).resolves.toMatchObject({
      assignment: { phase: "running", terminal: false },
    });
  });
});
