import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeQuitReceipt } from "../../src/apps/desktop/quit-receipt.ts";
import {
  MAX_RUN_MARKER_BYTES,
  writeRunMarker,
} from "../../src/apps/desktop/run-marker.ts";
import { MAX_LIVE_TASK_BYTES } from "../../src/apps/desktop/live-task-record.ts";
import {
  activationObligations,
  assertActivationDrained,
  promotionUserData,
} from "../../tooling/promotion-obligations.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function userData() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-userdata-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "farol-next-state", "live-tasks"), {
    recursive: true,
  });
  await fs.mkdir(path.join(root, "farol-next-state", "chatgpt-task-journal"), {
    recursive: true,
  });
  return root;
}

// Every real writer of this state (live-task-store.ts, the quit receipt,
// product-configuration.ts) creates its file owner-only; F3-3's reader now
// insists on that too, so fixtures must earn the same mode a default
// `fs.writeFile` under this machine's umask would not reliably give them.
async function writeFile(file, content) {
  await fs.writeFile(file, content, { mode: 0o600 });
}

// S35-03/1: the real store (live-task-store.ts) requires every one of these
// fields — `ProductTaskSchema` is a strict object — so a fixture that skips
// one is not "a smaller idle task", it is exactly the malformed record the
// owning store would refuse. Keep this in sync with `fixtureTask()` in
// promotion-flow.test.mjs; both stand in for the one real schema.
function task(overrides = {}) {
  return {
    taskId: "task-a",
    sessionId: "task-a",
    turnId: "turn-a",
    label: "Task",
    provider: "chatgpt",
    requestedModel: null,
    observedModel: null,
    requestedMode: null,
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle: "idle",
    conversationUrl: null,
    ...overrides,
  };
}

// A complete `ProductTaskAgentSchema`, since the real schema requires
// `workspaceId`, `workspaceEnforcement` and `resultAvailable` alongside the
// two fields this module's obligations logic actually reads.
function agent(overrides = {}) {
  return {
    phase: "running",
    workspaceId: "workspace-a",
    parentDelivery: "not_applicable",
    workspaceEnforcement: "not_applicable",
    resultAvailable: false,
    ...overrides,
  };
}

// A complete journal record (chatgpt-task-journal.ts's `recordSchema`):
// `operationId` must be UUID-shaped and `result` is a required (nullable)
// key, not an optional one.
function journal(overrides = {}) {
  return {
    schema: 1,
    operationId: "00000000-0000-4000-8000-000000000abc",
    kind: "readonly",
    phase: "prepared",
    createdAt: "2026-09-18T16:00:00.000Z",
    updatedAt: "2026-09-18T16:00:00.000Z",
    result: null,
    ...overrides,
  };
}

// The desktop's receipt, byte for byte (`serializeQuitReceipt` is what
// `main.ts`'s `recordQuitReceipt` writes); a fixture that invents its own
// shape is how the reader and the writer drifted apart in the first place.
const RECEIPT_AT = "2026-09-20T10:00:00.000Z";
async function writeQuitReceipt(root, drained, unconfirmed = []) {
  await writeFile(
    path.join(root, "farol-next-state", "last-quit.json"),
    serializeQuitReceipt({ drained, unconfirmed }, RECEIPT_AT),
  );
}

// Any whole-second epoch instant: the marker tests inject the boot probe,
// so they never depend on the machine's real boot time, which a sandbox
// may refuse to report.
const BOOT = 1_758_000_000_000;

async function writeTasks(root, tasks, overrides = {}) {
  await writeFile(
    path.join(root, "farol-next-state", "live-tasks", "live-tasks.json"),
    JSON.stringify({
      schema: 1,
      revision: 1,
      tasks,
      updatedAt: "2026-09-18T16:00:00.000Z",
      ...overrides,
    }),
  );
}

describe("Q-08 activation obligations", () => {
  it("finds nothing to drain in a fresh or idle user-data root", async () => {
    const fresh = await userData();
    await expect(activationObligations(fresh)).resolves.toMatchObject({
      obligations: [],
      unreadable: [],
      drained: true,
    });
    await writeTasks(fresh, [
      task(),
      task({
        taskId: "task-b",
        sessionId: "task-b",
        turnId: "turn-b",
        lifecycle: "completed",
      }),
    ]);
    await writeQuitReceipt(fresh, true);
    const drained = await activationObligations(fresh);
    expect(drained.drained).toBe(true);
    expect(() => assertActivationDrained(drained)).not.toThrow();
  });

  it("refuses while a task runs or its outcome is unknown, an Agent runs or its result is undelivered, a ChatGPT turn is undelivered, or a quit did not confirm", async () => {
    const root = await userData();
    await writeTasks(root, [
      task({ lifecycle: "running" }),
      task({
        taskId: "task-b",
        sessionId: "task-b",
        turnId: "turn-b",
        lifecycle: "outcome_unknown",
      }),
      task({
        taskId: "task-c",
        sessionId: "task-c",
        turnId: "turn-c",
        agent: agent({ phase: "running", parentDelivery: "not_applicable" }),
      }),
      task({
        taskId: "task-d",
        sessionId: "task-d",
        turnId: "turn-d",
        agent: agent({ phase: "completed", parentDelivery: "pending" }),
      }),
    ]);
    await writeFile(
      path.join(
        root,
        "farol-next-state",
        "chatgpt-task-journal",
        "chatgpt-task-journal.json",
      ),
      JSON.stringify(journal({ phase: "dispatch_intent" })),
    );
    await writeQuitReceipt(root, false, ["route-b"]);
    const report = await activationObligations(root);
    expect(report).toMatchObject({
      drained: false,
      unreadable: [],
      obligations: [
        "TASK_RUNNING:1",
        "TASK_OUTCOME_UNKNOWN:1",
        "AGENT_RUNNING:1",
        "AGENT_RESULT_UNDELIVERED:1",
        "CHATGPT_DELIVERY_PENDING:dispatch_intent",
        "QUIT_UNCONFIRMED:route-b",
      ],
    });
    expect(() => assertActivationDrained(report)).toThrow(
      /^PROMOTION_DRAIN_REQUIRED:TASK_RUNNING:1,/u,
    );
  });

  it("fails closed on state it cannot read, and admits the same root once its obligations are gone", async () => {
    const root = await userData();
    await writeFile(
      path.join(root, "farol-next-state", "live-tasks", "live-tasks.json"),
      "{not json",
    );
    const unreadable = await activationObligations(root);
    expect(unreadable).toMatchObject({
      drained: false,
      unreadable: ["live-tasks:CORRUPT"],
    });
    expect(() => assertActivationDrained(unreadable)).toThrow(
      "PROMOTION_STATE_UNREADABLE:live-tasks:CORRUPT",
    );
    await writeTasks(root, [task({ lifecycle: "running" })]);
    expect((await activationObligations(root)).obligations).toEqual([
      "TASK_RUNNING:1",
    ]);
    // The turn settled and the app quit cleanly: nothing is owed any more.
    await writeTasks(root, [task({ lifecycle: "completed" })]);
    await writeQuitReceipt(root, true);
    await expect(activationObligations(root)).resolves.toMatchObject({
      drained: true,
    });
  });

  it("HR-012/F1 treats a present record that is not the shape its owner writes as unreadable, never as nothing owed", async () => {
    const root = await userData();
    const tasksFile = path.join(
      root,
      "farol-next-state",
      "live-tasks",
      "live-tasks.json",
    );
    const journalFile = path.join(
      root,
      "farol-next-state",
      "chatgpt-task-journal",
      "chatgpt-task-journal.json",
    );
    const invalidTasks = {
      "missing task list": [{ schema: 1, revision: 1 }, "MALFORMED"],
      "task list that is an object": [
        {
          schema: 1,
          revision: 1,
          tasks: { a: task({ lifecycle: "running" }) },
        },
        "MALFORMED",
      ],
      "top-level array": [[task({ lifecycle: "running" })], "MALFORMED"],
      "null task entry": [
        { schema: 1, revision: 1, tasks: [null] },
        "MALFORMED",
      ],
      "future schema": [
        { schema: 2, revision: 1, tasks: [] },
        "UNKNOWN_VERSION",
      ],
      "unknown lifecycle": [
        { schema: 1, revision: 1, tasks: [task({ lifecycle: "paused" })] },
        "MALFORMED",
      ],
      "agent without a delivery state": [
        {
          schema: 1,
          revision: 1,
          tasks: [task({ agent: { phase: "completed" } })],
        },
        "MALFORMED",
      ],
      "more tasks than the store holds": [
        {
          schema: 1,
          revision: 1,
          tasks: Array.from({ length: 6 }, (_, index) =>
            task({ taskId: `task-${index}` }),
          ),
        },
        "MALFORMED",
      ],
    };
    for (const [name, [value, reason]] of Object.entries(invalidTasks)) {
      await writeFile(tasksFile, JSON.stringify(value));
      const report = await activationObligations(root);
      expect(report, name).toMatchObject({
        drained: false,
        obligations: [],
        unreadable: [`live-tasks:${reason}`],
      });
      expect(() => assertActivationDrained(report), name).toThrow(
        `PROMOTION_STATE_UNREADABLE:live-tasks:${reason}`,
      );
    }
    await fs.rm(tasksFile);
    const invalidJournals = {
      "journal without a phase": [
        { schema: 1, operationId: "op-1" },
        "MALFORMED",
      ],
      "journal with an unknown phase": [
        { schema: 1, phase: "sent" },
        "MALFORMED",
      ],
      "journal with a future schema": [
        { schema: 2, phase: "prepared" },
        "UNKNOWN_VERSION",
      ],
      "journal that is an array": [
        [{ schema: 1, phase: "prepared" }],
        "MALFORMED",
      ],
    };
    for (const [name, [value, reason]] of Object.entries(invalidJournals)) {
      await writeFile(journalFile, JSON.stringify(value));
      const report = await activationObligations(root);
      expect(report, name).toMatchObject({
        drained: false,
        obligations: [],
        unreadable: [`chatgpt-task-journal:${reason}`],
      });
    }
    await fs.rm(journalFile);
    const quitFile = path.join(root, "farol-next-state", "last-quit.json");
    for (const value of [
      { schema: 1, at: RECEIPT_AT, drained: "yes", unconfirmed: [] },
      { schema: 1, at: RECEIPT_AT, drained: true },
      { schema: 1, at: RECEIPT_AT, drained: true, unconfirmed: [1] },
      // The reader's former shape, with no `at`: the desktop never wrote it.
      { schema: 1, drained: true, unconfirmed: [] },
      { schema: 1, at: "2026-09-20T10:00:00Z", drained: true, unconfirmed: [] },
      { schema: 1, at: RECEIPT_AT, drained: true, unconfirmed: [], extra: 1 },
    ]) {
      await writeFile(quitFile, JSON.stringify(value));
      expect(await activationObligations(root)).toMatchObject({
        drained: false,
        unreadable: ["last-quit:MALFORMED"],
      });
    }
    await writeFile(
      quitFile,
      JSON.stringify({
        schema: 2,
        at: RECEIPT_AT,
        drained: true,
        unconfirmed: [],
      }),
    );
    expect(await activationObligations(root)).toMatchObject({
      drained: false,
      unreadable: ["last-quit:UNKNOWN_VERSION"],
    });
    await fs.rm(quitFile);
    // Valid, settled records with every classification field admit.
    await writeTasks(root, [
      task({ lifecycle: "completed" }),
      task({
        taskId: "task-b",
        sessionId: "task-b",
        turnId: "turn-b",
        lifecycle: "idle",
        agent: agent({ phase: "completed", parentDelivery: "acknowledged" }),
      }),
    ]);
    await writeFile(
      journalFile,
      JSON.stringify(journal({ phase: "delivery_acknowledged" })),
    );
    await writeQuitReceipt(root, true);
    await expect(activationObligations(root)).resolves.toMatchObject({
      drained: true,
      obligations: [],
      unreadable: [],
    });
  });

  it("S35-03/1 refuses a live-task record the owning store itself would refuse, never reads it as nothing running", async () => {
    const root = await userData();
    const tasksFile = path.join(
      root,
      "farol-next-state",
      "live-tasks",
      "live-tasks.json",
    );
    // The decisive negative control: a record with no `revision` and no
    // `updatedAt`. `live-task-store.ts`'s own `recordSchema` is a strict
    // object that requires both, so its `PrivateLiveTaskStore.load()` would
    // refuse this exact record with `LIVE_TASK_STATE_CORRUPT`. A promotion
    // that instead read `tasks: []` and called it "nothing is running" would
    // be weaker than the store whose data it is trusting.
    await writeFile(tasksFile, JSON.stringify({ schema: 1, tasks: [] }));
    const report = await activationObligations(root);
    expect(report).toMatchObject({
      drained: false,
      obligations: [],
      unreadable: ["live-tasks:MALFORMED"],
    });
    expect(() => assertActivationDrained(report)).toThrow(
      "PROMOTION_STATE_UNREADABLE:live-tasks:MALFORMED",
    );
    // Missing only `updatedAt` (a real, if incomplete, revision) is refused
    // the same way, not treated as a smaller-but-valid record.
    await writeFile(
      tasksFile,
      JSON.stringify({ schema: 1, revision: 1, tasks: [] }),
    );
    expect(await activationObligations(root)).toMatchObject({
      drained: false,
      unreadable: ["live-tasks:MALFORMED"],
    });
    // The complete record — the one the real store actually writes — is the
    // one that reads as nothing running.
    await writeTasks(root, []);
    await expect(activationObligations(root)).resolves.toMatchObject({
      drained: true,
      obligations: [],
      unreadable: [],
    });
  });

  it("HR-012/F2 refuses while a guarded edit recorded before it ran is still undelivered, whatever the tasks say", async () => {
    const root = await userData();
    const settingsFile = path.join(
      root,
      "farol-next-state",
      "product-settings.json",
    );
    // A complete `ProductSettingsSchema` record. `nativeHosts`, `connectors`
    // and `setup.journey` are omitted deliberately: the real schema defaults
    // them when the key is absent, exactly like a settings file saved before
    // that feature existed — `general` and every `setup.<step>` readiness
    // block are not defaulted and must be present in full.
    const readiness = () => ({
      visited: false,
      skipped: false,
      configured: false,
      reachable: "unknown",
      verified: null,
      needsAction: null,
      unavailable: null,
      outcomeUnknown: false,
    });
    const settings = (pendingEdit) => ({
      schema: 1,
      revision: 7,
      general: {
        openAtLaunch: "browser",
        sidebarDefault: "full",
        activityDetail: "summary",
      },
      computer: {
        computerId: "00000000-0000-4000-8000-000000000c01",
        generation: 3,
        name: "Test",
        commands: "none",
        workspaces: [],
        pendingEdit,
      },
      setup: {
        chatgpt: readiness(),
        computer: readiness(),
        connect: readiness(),
        hosts: readiness(),
        verify: readiness(),
      },
    });
    const pending = {
      operationId: "00000000-0000-4000-8000-0000000000aa",
      workspaceId: "00000000-0000-4000-8000-0000000000ee",
      relativePath: "README.md",
      computerGeneration: 3,
      submittedAt: "2026-09-18T16:00:00.000Z",
    };
    // Otherwise idle: settled tasks, a delivered turn, a clean quit.
    await writeTasks(root, [task({ lifecycle: "completed" })]);
    await writeQuitReceipt(root, true);
    await writeFile(settingsFile, JSON.stringify(settings(pending)));
    const report = await activationObligations(root);
    expect(report).toMatchObject({
      drained: false,
      unreadable: [],
      obligations: [
        "EDIT_DELIVERY_PENDING:00000000-0000-4000-8000-0000000000aa",
      ],
    });
    expect(() => assertActivationDrained(report)).toThrow(
      "PROMOTION_DRAIN_REQUIRED:EDIT_DELIVERY_PENDING:00000000-0000-4000-8000-0000000000aa",
    );
    // A restart changes nothing: the record is what it was.
    await expect(activationObligations(root)).resolves.toMatchObject({
      drained: false,
    });
    // A pending edit without its identity is not a settled one.
    await writeFile(
      settingsFile,
      JSON.stringify(settings({ relativePath: "README.md" })),
    );
    await expect(activationObligations(root)).resolves.toMatchObject({
      drained: false,
      unreadable: ["product-settings:MALFORMED"],
    });
    await writeFile(settingsFile, JSON.stringify({ schema: 2 }));
    await expect(activationObligations(root)).resolves.toMatchObject({
      drained: false,
      unreadable: ["product-settings:UNKNOWN_VERSION"],
    });
    // Only the acknowledgment of that exact operation clears it: the
    // configuration service writes null, and then nothing is owed.
    await writeFile(settingsFile, JSON.stringify(settings(null)));
    await expect(activationObligations(root)).resolves.toMatchObject({
      drained: true,
      obligations: [],
      unreadable: [],
    });
    // Settings written before the field existed carry no pending edit.
    const { pendingEdit: _absent, ...computer } = settings(null).computer;
    await writeFile(
      settingsFile,
      JSON.stringify({ ...settings(null), computer }),
    );
    await expect(activationObligations(root)).resolves.toMatchObject({
      drained: true,
    });
  });

  it("reads the product's own user-data directory for an owner home", () => {
    expect(promotionUserData("/Users/example")).toBe(
      "/Users/example/Library/Application Support/Farol Next Preview",
    );
    expect(() => promotionUserData("relative")).toThrow(
      "PROMOTION_HOME_NOT_ABSOLUTE",
    );
  });

  it("refuses a relative user-data path", async () => {
    await expect(activationObligations("relative")).rejects.toThrow(
      "PROMOTION_USER_DATA_NOT_ABSOLUTE",
    );
  });

  it("F3-3 refuses a symlink standing in for the state file, never follows it", async () => {
    const root = await userData();
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-outside-state-"),
    );
    roots.push(outside);
    // What an attacker or a race would want promotion to read instead: a
    // fully idle record living outside the state directory.
    await writeFile(
      path.join(outside, "live-tasks.json"),
      JSON.stringify({ schema: 1, revision: 1, tasks: [] }),
    );
    const tasksFile = path.join(
      root,
      "farol-next-state",
      "live-tasks",
      "live-tasks.json",
    );
    await fs.symlink(path.join(outside, "live-tasks.json"), tasksFile);
    const report = await activationObligations(root);
    expect(report).toMatchObject({
      drained: false,
      obligations: [],
      unreadable: ["live-tasks:SYMLINK"],
    });
    expect(() => assertActivationDrained(report)).toThrow(
      "PROMOTION_STATE_UNREADABLE:live-tasks:SYMLINK",
    );
  });

  it("F3-3 refuses state that is not a private, single-owner regular file", async () => {
    const root = await userData();
    const tasksFile = path.join(
      root,
      "farol-next-state",
      "live-tasks",
      "live-tasks.json",
    );
    await writeTasks(root, [task()]);
    await fs.chmod(tasksFile, 0o644);
    const report = await activationObligations(root);
    expect(report).toMatchObject({
      drained: false,
      obligations: [],
      unreadable: ["live-tasks:UNSAFE"],
    });
    await fs.chmod(tasksFile, 0o600);
    await expect(activationObligations(root)).resolves.toMatchObject({
      drained: true,
    });
  });
  it("refuses a state that changed while it was being read", async () => {
    const root = await userData();
    await writeTasks(root, [task()]);
    await writeQuitReceipt(root, true);
    // Idle when first read; a turn is admitted before the confirming read.
    const report = await activationObligations(root, {
      beforeConfirmation: () =>
        writeTasks(root, [task({ lifecycle: "running" })]),
    });
    expect(report).toMatchObject({ drained: false, changed: ["live-tasks"] });
    expect(() => assertActivationDrained(report)).toThrow(
      "PROMOTION_STATE_CHANGED:live-tasks",
    );
    // Held still, the same root is classified from what it now owes.
    await expect(activationObligations(root)).resolves.toMatchObject({
      changed: [],
      obligations: ["TASK_RUNNING:1"],
      drained: false,
    });
  });

  // N03/D1, the decisive case. `main.ts`'s `recordQuitReceipt` has always
  // written `{ schema: 1, at: <ISO>, ...receipt }`; the reader's strict
  // schema had no `at`, so every real receipt read as MALFORMED and
  // `--apply` was refused for good after the first clean quit. These are
  // the real bytes, spelled with the desktop's former inline expression and
  // with the shared serializer that replaces it, and both must be identical.
  it("N03/D1 reads the receipt bytes the desktop actually writes: drained as drained, undrained as QUIT_UNCONFIRMED", async () => {
    const root = await userData();
    const quitFile = path.join(root, "farol-next-state", "last-quit.json");
    const at = new Date().toISOString();
    const desktopBytes = (receipt) =>
      `${JSON.stringify({ schema: 1, at, ...receipt })}\n`;

    const drainedReceipt = { drained: true, unconfirmed: [] };
    expect(serializeQuitReceipt(drainedReceipt, at)).toBe(
      desktopBytes(drainedReceipt),
    );
    await writeFile(quitFile, desktopBytes(drainedReceipt));
    const drained = await activationObligations(root);
    expect(drained).toMatchObject({
      drained: true,
      obligations: [],
      unreadable: [],
    });
    expect(() => assertActivationDrained(drained)).not.toThrow();

    const undrainedReceipt = {
      drained: false,
      unconfirmed: ["route-b", "connector"],
    };
    expect(serializeQuitReceipt(undrainedReceipt, at)).toBe(
      desktopBytes(undrainedReceipt),
    );
    await writeFile(quitFile, desktopBytes(undrainedReceipt));
    const undrained = await activationObligations(root);
    expect(undrained).toMatchObject({
      drained: false,
      unreadable: [],
      obligations: ["QUIT_UNCONFIRMED:route-b,connector"],
    });
    expect(() => assertActivationDrained(undrained)).toThrow(
      "PROMOTION_DRAIN_REQUIRED:QUIT_UNCONFIRMED:route-b,connector",
    );
  });

  // N03/D3: the owner's decode bound applies here too. The store refuses a
  // file larger than 128 KiB before it parses it; a promotion that parsed
  // the same bytes would read a valid idle record and call it drained.
  it("N03/D3 refuses a live-tasks file past the store's decode bound even when its content is a valid idle record, never reading it as drained", async () => {
    const root = await userData();
    const tasksFile = path.join(
      root,
      "farol-next-state",
      "live-tasks",
      "live-tasks.json",
    );
    const idle = JSON.stringify({
      schema: 1,
      revision: 1,
      tasks: [task()],
      updatedAt: "2026-09-18T16:00:00.000Z",
    });
    await writeFile(
      tasksFile,
      `${" ".repeat(130 * 1_024 - Buffer.byteLength(idle))}${idle}`,
    );
    const report = await activationObligations(root);
    expect(report).toMatchObject({
      drained: false,
      obligations: [],
      unreadable: ["live-tasks:OVERSIZED"],
    });
    expect(() => assertActivationDrained(report)).toThrow(
      "PROMOTION_STATE_UNREADABLE:live-tasks:OVERSIZED",
    );
    // Exactly at the bound the same record reads.
    await writeFile(
      tasksFile,
      `${" ".repeat(MAX_LIVE_TASK_BYTES - Buffer.byteLength(idle))}${idle}`,
    );
    await expect(activationObligations(root)).resolves.toMatchObject({
      drained: true,
      unreadable: [],
    });
  });

  // N03/D2: the run marker. Present, it is either the running app (a live
  // pid written on this boot) or an unconfirmed stop (a dead pid, or a pid
  // from another boot); absent, it says nothing. The probes are injected
  // so the verdict never depends on this machine's uptime or on pid reuse.
  it("N03/D2 classifies the run marker: a live pid on this boot is APP_RUNNING, a dead pid or another boot is QUIT_UNCONFIRMED:crash, absent is nothing", async () => {
    const root = await userData();
    const state = path.join(root, "farol-next-state");
    await writeTasks(root, [task({ lifecycle: "completed" })]);
    await writeQuitReceipt(root, true);
    await expect(activationObligations(root)).resolves.toMatchObject({
      drained: true,
    });

    await writeRunMarker(state, { pid: 4242, now: 1_000, bootTime: BOOT });
    const running = await activationObligations(root, {
      bootTime: BOOT,
      isAlive: (pid) => pid === 4242,
    });
    expect(running).toMatchObject({
      drained: false,
      unreadable: [],
      obligations: ["APP_RUNNING:4242"],
    });
    expect(() => assertActivationDrained(running)).toThrow(
      "PROMOTION_DRAIN_REQUIRED:APP_RUNNING:4242",
    );

    // Same boot, pid gone: a stop that never confirmed its drain, and the
    // clean receipt beside it is the previous quit's, not this one's.
    const crashed = await activationObligations(root, {
      bootTime: BOOT,
      isAlive: () => false,
    });
    expect(crashed).toMatchObject({
      drained: false,
      unreadable: [],
      obligations: ["QUIT_UNCONFIRMED:crash"],
    });

    // Another boot: the pid is somebody else's now, alive or not.
    const rebooted = await activationObligations(root, {
      bootTime: BOOT + 3_600_000,
      isAlive: () => true,
    });
    expect(rebooted).toMatchObject({
      obligations: ["QUIT_UNCONFIRMED:crash"],
    });

    // The reader cannot establish its own boot: a live pid is not guessed.
    const unknown = await activationObligations(root, {
      bootTime: null,
      isAlive: () => true,
    });
    expect(unknown).toMatchObject({
      drained: false,
      obligations: [],
      unreadable: ["running:BOOT_UNKNOWN"],
    });
    // ... but a dead pid is a crash on any boot.
    await expect(
      activationObligations(root, { bootTime: null, isAlive: () => false }),
    ).resolves.toMatchObject({ obligations: ["QUIT_UNCONFIRMED:crash"] });

    // The marker names an undrained receipt's obligation alongside its own.
    await writeQuitReceipt(root, false, ["route-b"]);
    await expect(
      activationObligations(root, { bootTime: BOOT, isAlive: () => false }),
    ).resolves.toMatchObject({
      obligations: ["QUIT_UNCONFIRMED:route-b", "QUIT_UNCONFIRMED:crash"],
    });

    // Removed after a confirmed drain: nothing is owed from it any more.
    await fs.rm(path.join(state, "running.json"));
    await writeQuitReceipt(root, true);
    await expect(
      activationObligations(root, { bootTime: BOOT, isAlive: () => true }),
    ).resolves.toMatchObject({ drained: true });
  });

  it("N03/D2 treats a run marker it cannot read as unreadable, and notices one that appears between its two reads", async () => {
    const root = await userData();
    const state = path.join(root, "farol-next-state");
    const markerFile = path.join(state, "running.json");
    const valid = {
      schema: 1,
      pid: 4242,
      startedAt: "2026-09-20T10:00:00.000Z",
      bootTime: BOOT,
    };
    const probes = { bootTime: BOOT, isAlive: () => true };
    const cases = [
      ["CORRUPT", "{not json", 0o600],
      ["MALFORMED", JSON.stringify({ schema: 1, pid: 4242 }), 0o600],
      ["MALFORMED", JSON.stringify({ ...valid, extra: true }), 0o600],
      ["MALFORMED", JSON.stringify({ ...valid, pid: "4242" }), 0o600],
      ["UNKNOWN_VERSION", JSON.stringify({ ...valid, schema: 2 }), 0o600],
      ["UNSAFE", JSON.stringify(valid), 0o644],
      [
        "OVERSIZED",
        `${" ".repeat(MAX_RUN_MARKER_BYTES)}${JSON.stringify(valid)}`,
        0o600,
      ],
    ];
    for (const [reason, text, mode] of cases) {
      await fs.rm(markerFile, { force: true });
      await fs.writeFile(markerFile, text, { mode });
      const report = await activationObligations(root, probes);
      expect(report, reason).toMatchObject({
        drained: false,
        obligations: [],
        unreadable: [`running:${reason}`],
      });
      expect(() => assertActivationDrained(report), reason).toThrow(
        `PROMOTION_STATE_UNREADABLE:running:${reason}`,
      );
    }
    await fs.rm(markerFile, { force: true });
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-outside-marker-"),
    );
    roots.push(outside);
    await writeFile(path.join(outside, "running.json"), JSON.stringify(valid));
    await fs.symlink(path.join(outside, "running.json"), markerFile);
    await expect(activationObligations(root, probes)).resolves.toMatchObject({
      drained: false,
      unreadable: ["running:SYMLINK"],
    });
    await fs.rm(markerFile);

    // An app that starts between the two reads is a changed state.
    const report = await activationObligations(root, {
      ...probes,
      beforeConfirmation: () =>
        writeRunMarker(state, { pid: 4242, now: 1_000, bootTime: BOOT }),
    });
    expect(report).toMatchObject({ drained: false, changed: ["running"] });
    expect(() => assertActivationDrained(report)).toThrow(
      "PROMOTION_STATE_CHANGED:running",
    );
  });
});
