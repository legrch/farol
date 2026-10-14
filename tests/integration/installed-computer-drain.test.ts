import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrivateExecutionFence } from "../../src/modules/computer/infra/mcp/execution-fence";
import { PrivateCodexHandoffJournal } from "../../src/modules/chat/infra/repo/private-codex-handoff-journal";
import { PrivateWorkspaceMutationStore } from "../../src/modules/computer/infra/repo/private-workspace-mutation-store";
import type { HandoffRecord } from "../../src/modules/chat/app/service/persistent-codex-handoff";
import type { StoredWorkspaceMutation } from "../../src/modules/computer/app/port/workspace-mutation-repository";
import {
  drainInstalledComputerWork,
  type ComputerUpdateDrainPorts,
} from "../../src/apps/desktop/installed-computer-drain";
import type { HandoffStatusResult } from "../../src/modules/chat/app/service/persistent-codex-handoff";

const settled: HandoffStatusResult = {
  status: "known",
  dispatchId: "dispatch",
  threadId: "thread",
  turnId: "turn",
  turnStatus: "completed",
  threadRuntime: {
    state: "idle",
    scope: "thread",
    source: "thread/read",
    snapshot: "non-atomic",
  },
};
function fixture() {
  const events: string[] = [];
  const reader = {
    status: vi.fn(async () => settled),
    close: vi.fn(async () => true),
  };
  const ports: ComputerUpdateDrainPorts = {
    routeConfigured: true,
    exclusive: async (work) => {
      events.push("fenced");
      try {
        return await work();
      } finally {
        events.push("released");
      }
    },
    desktopWorkSettled: vi.fn(async () => true),
    mutationsSettled: vi.fn(async () => true),
    taskKeys: vi.fn(async () => []),
    openTaskReader: vi.fn(async () => reader),
    stillCurrent: vi.fn(() => true),
    stopOwnedClients: vi.fn(async () => {
      events.push("drained");
    }),
  };
  return { ports, reader, events };
}
describe("installed Computer drain (injected clients, no live provider)", () => {
  it("preserves the connector when the durable Desktop report is not settled", async () => {
    const f = fixture();
    vi.mocked(f.ports.desktopWorkSettled).mockImplementation(async () => {
      expect(f.events).toEqual(["fenced"]);
      return false;
    });
    await expect(drainInstalledComputerWork(f.ports)).resolves.toEqual({
      ok: false,
      code: "UPDATE_WORK_PENDING",
    });
    expect(f.ports.mutationsSettled).not.toHaveBeenCalled();
    expect(f.ports.openTaskReader).not.toHaveBeenCalled();
    expect(f.ports.stopOwnedClients).not.toHaveBeenCalled();
    expect(f.events).toEqual(["fenced", "released"]);
  });
  it("preserves the connector if the durable Desktop read throws", async () => {
    const f = fixture();
    vi.mocked(f.ports.desktopWorkSettled).mockRejectedValue(
      new Error("fixture"),
    );
    expect((await drainInstalledComputerWork(f.ports)).ok).toBe(false);
    expect(f.ports.stopOwnedClients).not.toHaveBeenCalled();
    expect(f.events).toEqual(["fenced", "released"]);
  });
  it("drains a configured idle connector without opening a proxy or changing its route", async () => {
    const f = fixture();
    await expect(drainInstalledComputerWork(f.ports)).resolves.toEqual({
      ok: true,
    });
    expect(f.events).toEqual(["fenced", "drained", "released"]);
    expect(f.ports.desktopWorkSettled).toHaveBeenCalledOnce();
    expect(f.ports.openTaskReader).not.toHaveBeenCalled();
    expect(f.ports.routeConfigured).toBe(true);
  });
  it("checks completed persistent work before draining the NEW clients", async () => {
    const f = fixture();
    vi.mocked(f.ports.taskKeys).mockResolvedValue(["dispatch"]);
    await expect(drainInstalledComputerWork(f.ports)).resolves.toEqual({
      ok: true,
    });
    expect(f.reader.status).toHaveBeenCalledWith("dispatch");
    expect(f.reader.close).toHaveBeenCalledOnce();
    expect(f.ports.stopOwnedClients).toHaveBeenCalledOnce();
  });
  it("refuses normal-Quit task acquisition before an unfenced proxy can launch", async () => {
    const f = fixture();
    vi.mocked(f.ports.taskKeys).mockResolvedValue(["original-dispatch"]);
    await expect(
      drainInstalledComputerWork({ ...f.ports, taskReaderAvailable: false }),
    ).resolves.toEqual({ ok: false, code: "UPDATE_TASK_ROUTE_NEEDS_DRAIN" });
    expect(f.ports.openTaskReader).not.toHaveBeenCalled();
    expect(f.ports.stopOwnedClients).not.toHaveBeenCalled();
  });
  it("normal Quit with no retained task does not need a new proxy", async () => {
    const f = fixture();
    await expect(
      drainInstalledComputerWork({ ...f.ports, taskReaderAvailable: false }),
    ).resolves.toEqual({ ok: true });
    expect(f.ports.openTaskReader).not.toHaveBeenCalled();
    expect(f.ports.stopOwnedClients).toHaveBeenCalledOnce();
  });
  it("an expired Quit fence after journal observation never opens a task reader", async () => {
    const f = fixture();
    let current = true;
    vi.mocked(f.ports.stillCurrent).mockImplementation(() => current);
    vi.mocked(f.ports.taskKeys).mockImplementation(async () => {
      current = false;
      return ["original-dispatch"];
    });
    await expect(drainInstalledComputerWork(f.ports)).resolves.toEqual({
      ok: false,
      code: "UPDATE_STATE_UNREADABLE",
    });
    expect(f.ports.openTaskReader).not.toHaveBeenCalled();
    expect(f.ports.stopOwnedClients).not.toHaveBeenCalled();
  });
  it("a reader that opens late is closed without starting another provider observation", async () => {
    const f = fixture();
    let current = true;
    vi.mocked(f.ports.stillCurrent).mockImplementation(() => current);
    vi.mocked(f.ports.taskKeys).mockResolvedValue(["original-dispatch"]);
    vi.mocked(f.ports.openTaskReader).mockImplementation(async () => {
      current = false;
      return f.reader;
    });
    await expect(drainInstalledComputerWork(f.ports)).resolves.toEqual({
      ok: false,
      code: "UPDATE_TASK_ROUTE_NEEDS_DRAIN",
    });
    expect(f.reader.status).not.toHaveBeenCalled();
    expect(f.reader.close).toHaveBeenCalledOnce();
    expect(f.ports.stopOwnedClients).not.toHaveBeenCalled();
  });
  it.each([
    "inProgress",
    "unknown",
    "active",
    "notLoaded",
    "unavailable",
    "systemError",
  ])("keeps %s work running without restart", async (state) => {
    const f = fixture();
    vi.mocked(f.ports.taskKeys).mockResolvedValue(["dispatch"]);
    f.reader.status.mockResolvedValue(
      state === "unknown"
        ? { status: "outcome_unknown", dispatchId: "dispatch" }
        : ({
            ...settled,
            turnStatus: state === "inProgress" ? "inProgress" : "completed",
            threadRuntime: {
              ...settled.threadRuntime,
              state: state === "inProgress" ? "idle" : state,
              ...(state === "active"
                ? { activeFlags: ["waitingOnApproval"] }
                : {}),
            },
          } as HandoffStatusResult),
    );
    expect((await drainInstalledComputerWork(f.ports)).ok).toBe(false);
    expect(f.ports.stopOwnedClients).not.toHaveBeenCalled();
    expect(f.reader.close).toHaveBeenCalledOnce();
  });
  it("leaves connector running for an unresolved file mutation", async () => {
    const f = fixture();
    vi.mocked(f.ports.mutationsSettled).mockResolvedValue(false);
    expect((await drainInstalledComputerWork(f.ports)).ok).toBe(false);
    expect(f.ports.stopOwnedClients).not.toHaveBeenCalled();
    expect(f.ports.openTaskReader).not.toHaveBeenCalled();
  });
  it("requires a recognized terminal turn even if the thread reports idle", async () => {
    const f = fixture();
    vi.mocked(f.ports.taskKeys).mockResolvedValue(["dispatch"]);
    f.reader.status.mockResolvedValue({ ...settled, turnStatus: "queued" });
    expect((await drainInstalledComputerWork(f.ports)).ok).toBe(false);
    expect(f.ports.stopOwnedClients).not.toHaveBeenCalled();
    expect(f.reader.close).toHaveBeenCalledOnce();
  });
  it("fails closed on an unreadable journal or failed cleanup", async () => {
    const f = fixture();
    vi.mocked(f.ports.taskKeys).mockRejectedValue(new Error("fixture"));
    expect((await drainInstalledComputerWork(f.ports)).ok).toBe(false);
    expect(f.ports.stopOwnedClients).not.toHaveBeenCalled();
    vi.mocked(f.ports.taskKeys).mockResolvedValue(["dispatch"]);
    f.reader.close.mockResolvedValue(false);
    expect((await drainInstalledComputerWork(f.ports)).ok).toBe(false);
    expect(f.ports.stopOwnedClients).not.toHaveBeenCalled();
  });
  it.each(["idle", "busy"])(
    "keeps unconfirmed reader shutdown separate from %s task admission",
    async (state) => {
      const f = fixture();
      vi.mocked(f.ports.taskKeys).mockResolvedValue(["dispatch"]);
      f.reader.status.mockResolvedValue({
        ...settled,
        turnStatus: state === "idle" ? "completed" : "inProgress",
      });
      f.reader.close.mockResolvedValue(false);
      expect(await drainInstalledComputerWork(f.ports)).toEqual({
        ok: false,
        code: "UPDATE_WORK_DRAIN_UNCONFIRMED",
      });
      expect(f.ports.openTaskReader).toHaveBeenCalledOnce();
      expect(f.reader.close).toHaveBeenCalledOnce();
      expect(f.ports.stopOwnedClients).not.toHaveBeenCalled();
    },
  );
  it("rechecks binding after awaited reads and preserves unknown drain failure", async () => {
    const f = fixture();
    vi.mocked(f.ports.stillCurrent).mockReturnValue(false);
    expect((await drainInstalledComputerWork(f.ports)).ok).toBe(false);
    expect(f.ports.stopOwnedClients).not.toHaveBeenCalled();
    vi.mocked(f.ports.stillCurrent).mockReturnValue(true);
    vi.mocked(f.ports.stopOwnedClients).mockRejectedValue(new Error("fixture"));
    expect((await drainInstalledComputerWork(f.ports)).ok).toBe(false);
  });
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-update-idle-")),
  );
  roots.push(value);
  return value;
}
const key = "019b0000-0000-4000-8000-000000000017";
const reservation: HandoffRecord = {
  requestDigest: "a".repeat(64),
  workspaceId: "workspace",
  projectId: "project",
  threadIntent: false,
  turnIntent: false,
  workspace: {
    root: "/fixture",
    device: "1",
    inode: "2",
    gitCommonDirectory: "/fixture/.git",
    project: {
      root: "/fixture",
      device: "1",
      inode: "2",
      gitCommonDirectory: "/fixture/.git",
    },
    execution: { sandbox: "read-only", approvalPolicy: "untrusted" },
  },
};
const mutation: StoredWorkspaceMutation = {
  identity: {
    operationId: "mutation",
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    taskEpoch: 1,
    participantId: "main",
  },
  workspaceId: "workspace",
  requestDigest: "a".repeat(64),
  phase: "prepared",
  outcome: null,
};

describe("physical update admission (disposable roots, no live endpoint)", () => {
  it("refuses active read/write leases without stopping them, then excludes new work during drain", async () => {
    const directory = await root();
    const desktop = new PrivateExecutionFence({ root: directory });
    const connector = new PrivateExecutionFence({ root: directory });
    const current = await connector.acquireAdmission();
    if (!current.admitted) throw new Error(current.code);
    const drain = vi.fn();
    try {
      await expect(desktop.withUpdateDrain(drain)).rejects.toThrow();
    } finally {
      await current.release();
    }
    expect(drain).not.toHaveBeenCalled();
    await desktop.withUpdateDrain(async () => {
      expect((await connector.acquireAdmission()).admitted).toBe(false);
      await expect(
        connector.withUpdateDrain(async () => undefined),
      ).rejects.toThrow();
    });
    const after = await connector.acquireAdmission();
    expect(after.admitted).toBe(true);
    if (after.admitted) await after.release();
  });
  it("preserves unknown shell markers, summary fences and dispatch locks", async () => {
    const directory = await root();
    const owner = new PrivateExecutionFence({ root: directory });
    const desktop = new PrivateExecutionFence({ root: directory });
    const current = await owner.acquireAdmission();
    if (!current.admitted) throw new Error(current.code);
    await owner.reserveShell("owned-shell");
    await current.release();
    await expect(
      desktop.withUpdateDrain(async () => undefined),
    ).rejects.toThrow();
    await owner.clearShell("owned-shell");
    await owner.raise({ operationId: "summary", taskId: "task" });
    await expect(
      desktop.withUpdateDrain(async () => undefined),
    ).rejects.toThrow();
    await owner.lower("summary");
    const lock = path.join(directory, "execution-fence-mutation.lock");
    await fs.mkdir(lock, { mode: 0o700 });
    await expect(
      desktop.withUpdateDrain(async () => undefined),
    ).rejects.toThrow();
    expect((await fs.lstat(lock)).isDirectory()).toBe(true);
  });
  it("does not create absent journals or mistake saved preferences for issued tasks", async () => {
    const directory = path.join(await root(), "journal");
    const journal = new PrivateCodexHandoffJournal(directory);
    expect(await journal.updateTaskKeys()).toEqual([]);
    await expect(fs.lstat(directory)).rejects.toHaveProperty("code", "ENOENT");
    await journal.rememberProjectPreference(key, {
      projectId: "project",
      project: reservation.workspace.project,
    });
    expect(await journal.updateTaskKeys()).toEqual([]);
    await journal.reserve(key, reservation);
    expect(await journal.updateTaskKeys()).toEqual([]);
    await journal.claimThread(key);
    expect(await journal.updateTaskKeys()).toEqual([key]);
  });
  it("returns issued handles for provider readback and refuses unacknowledged steer", async () => {
    const journal = new PrivateCodexHandoffJournal(
      path.join(await root(), "journal"),
    );
    await journal.reserve(key, reservation);
    await journal.claimThread(key);
    await journal.recordThread(key, "thread");
    await journal.claimTurn(key);
    await journal.recordTurn(key, "turn");
    expect(await journal.updateTaskKeys()).toEqual([key]);
    await journal.claimMessage(
      key,
      "019b0000-0000-4000-8000-000000000018",
      "b".repeat(64),
    );
    await expect(journal.updateTaskKeys()).rejects.toThrow();
    await journal.recordMessage(
      key,
      "019b0000-0000-4000-8000-000000000018",
      "turn",
    );
    expect(await journal.updateTaskKeys()).toEqual([key]);
  });
  it.each([
    ["thread-intent.json", "null"],
    ["message-intent.json", "null"],
    ["unknown-operation.json", "{}"],
    ["thread-intent.json.temporary.tmp", "{}"],
  ])(
    "does not treat an invalid %s record as absent work",
    async (name, value) => {
      const directory = path.join(await root(), "journal");
      const journal = new PrivateCodexHandoffJournal(directory);
      await journal.reserve(key, reservation);
      const file = path.join(directory, key, name);
      await fs.writeFile(file, value, { mode: 0o600 });
      await expect(journal.updateTaskKeys()).rejects.toThrow();
      expect(await fs.readFile(file, "utf8")).toBe(value);
    },
  );
  it.each(["turn", "different-turn"])(
    "blocks an orphan message receipt for %s before provider reads or drain",
    async (turn) => {
      const directory = path.join(await root(), "journal");
      const journal = new PrivateCodexHandoffJournal(directory);
      await journal.reserve(key, reservation);
      await journal.claimThread(key);
      await journal.recordThread(key, "thread");
      await journal.claimTurn(key);
      await journal.recordTurn(key, "turn");
      const file = path.join(directory, key, "message.json");
      await fs.writeFile(file, JSON.stringify(turn), { mode: 0o600 });
      const f = fixture();
      const ports = { ...f.ports, taskKeys: () => journal.updateTaskKeys() };
      expect((await drainInstalledComputerWork(ports)).ok).toBe(false);
      expect(f.ports.openTaskReader).not.toHaveBeenCalled();
      expect(f.ports.stopOwnedClients).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toBe(turn);
    },
  );
  it("refuses incomplete reservations, symlinked task directories and FIFO records within the test deadline", async () => {
    const directory = path.join(await root(), "journal");
    const journal = new PrivateCodexHandoffJournal(directory);
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.mkdir(path.join(directory, key), { mode: 0o700 });
    await expect(journal.updateTaskKeys()).rejects.toThrow();
    execFileSync(
      "/usr/bin/mkfifo",
      [path.join(directory, key, "reservation.json")],
      { timeout: 1000 },
    );
    await expect(journal.updateTaskKeys()).rejects.toThrow();
    await fs.rm(path.join(directory, key), { recursive: true });
    await fs.symlink(directory, path.join(directory, key));
    await expect(journal.updateTaskKeys()).rejects.toThrow();
  }, 3000);
  it.each(["prepared", "outcome_unknown", "completed", "failed"] as const)(
    "classifies mutation %s from its actual durable record",
    async (phase) => {
      const store = new PrivateWorkspaceMutationStore({ root: await root() });
      expect(await store.settledForUpdate()).toBe(true);
      await store.admit(mutation);
      if (phase === "outcome_unknown")
        await store.save({
          ...mutation,
          phase,
          outcome: {
            code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
            source: "native-workspace",
          },
        });
      if (phase === "failed")
        await store.save({
          ...mutation,
          phase,
          outcome: { code: "WORKSPACE_NOT_FOUND", source: "native-workspace" },
        });
      if (phase === "completed")
        await store.save({
          ...mutation,
          phase,
          outcome: {
            receipt: {
              kind: "workspace.mutation",
              operation: "write",
              relativePath: "test.txt",
              bytes: 1,
              replacements: 0,
              beforeSha256: null,
              afterSha256: "b".repeat(64),
            },
          },
        });
      expect(await store.settledForUpdate()).toBe(
        phase === "completed" || phase === "failed",
      );
    },
  );
  it("does not hang on a mutation FIFO or remove an incomplete temporary record", async () => {
    const directory = await root();
    const store = new PrivateWorkspaceMutationStore({ root: directory });
    const records = path.join(directory, "mutations");
    await fs.mkdir(records, { mode: 0o700 });
    const fifo = path.join(records, `${"a".repeat(64)}.json`);
    execFileSync("/usr/bin/mkfifo", [fifo], { timeout: 1000 });
    await expect(store.settledForUpdate()).rejects.toThrow();
    await fs.unlink(fifo);
    const pending = path.join(records, ".pending.tmp");
    await fs.writeFile(pending, "1", { mode: 0o600 });
    expect(await store.settledForUpdate()).toBe(false);
    expect(await fs.readFile(pending, "utf8")).toBe("1");
  }, 3000);
});
