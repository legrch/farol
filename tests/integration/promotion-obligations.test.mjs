import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function task(overrides = {}) {
  return {
    taskId: "task-a",
    sessionId: "task-a",
    turnId: "turn-a",
    label: "Task",
    provider: "chatgpt",
    lifecycle: "idle",
    ...overrides,
  };
}

async function writeTasks(root, tasks) {
  await fs.writeFile(
    path.join(root, "farol-next-state", "live-tasks", "live-tasks.json"),
    JSON.stringify({ schema: 1, revision: 1, tasks }),
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
    await fs.writeFile(
      path.join(fresh, "farol-next-state", "last-quit.json"),
      JSON.stringify({ schema: 1, drained: true, unconfirmed: [] }),
    );
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
        agent: { phase: "running", parentDelivery: "not_applicable" },
      }),
      task({
        taskId: "task-d",
        sessionId: "task-d",
        turnId: "turn-d",
        agent: { phase: "completed", parentDelivery: "pending" },
      }),
    ]);
    await fs.writeFile(
      path.join(
        root,
        "farol-next-state",
        "chatgpt-task-journal",
        "chatgpt-task-journal.json",
      ),
      JSON.stringify({ schema: 1, phase: "dispatch_intent" }),
    );
    await fs.writeFile(
      path.join(root, "farol-next-state", "last-quit.json"),
      JSON.stringify({ schema: 1, drained: false, unconfirmed: ["route-b"] }),
    );
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
    await fs.writeFile(
      path.join(root, "farol-next-state", "live-tasks", "live-tasks.json"),
      "{not json",
    );
    const unreadable = await activationObligations(root);
    expect(unreadable).toMatchObject({
      drained: false,
      unreadable: ["live-tasks"],
    });
    expect(() => assertActivationDrained(unreadable)).toThrow(
      "PROMOTION_STATE_UNREADABLE:live-tasks",
    );
    await writeTasks(root, [task({ lifecycle: "running" })]);
    expect((await activationObligations(root)).obligations).toEqual([
      "TASK_RUNNING:1",
    ]);
    // The turn settled and the app quit cleanly: nothing is owed any more.
    await writeTasks(root, [task({ lifecycle: "completed" })]);
    await fs.writeFile(
      path.join(root, "farol-next-state", "last-quit.json"),
      JSON.stringify({ schema: 1, drained: true, unconfirmed: [] }),
    );
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
      "missing task list": { schema: 1, revision: 1 },
      "task list that is an object": {
        schema: 1,
        revision: 1,
        tasks: { a: task({ lifecycle: "running" }) },
      },
      "top-level array": [task({ lifecycle: "running" })],
      "null task entry": { schema: 1, revision: 1, tasks: [null] },
      "future schema": { schema: 2, revision: 1, tasks: [] },
      "unknown lifecycle": {
        schema: 1,
        revision: 1,
        tasks: [task({ lifecycle: "paused" })],
      },
      "agent without a delivery state": {
        schema: 1,
        revision: 1,
        tasks: [task({ agent: { phase: "completed" } })],
      },
      "more tasks than the store holds": {
        schema: 1,
        revision: 1,
        tasks: Array.from({ length: 6 }, (_, index) =>
          task({ taskId: `task-${index}` }),
        ),
      },
    };
    for (const [name, value] of Object.entries(invalidTasks)) {
      await fs.writeFile(tasksFile, JSON.stringify(value));
      const report = await activationObligations(root);
      expect(report, name).toMatchObject({
        drained: false,
        obligations: [],
        unreadable: ["live-tasks"],
      });
      expect(() => assertActivationDrained(report), name).toThrow(
        "PROMOTION_STATE_UNREADABLE:live-tasks",
      );
    }
    await fs.rm(tasksFile);
    const invalidJournals = {
      "journal without a phase": { schema: 1, operationId: "op-1" },
      "journal with an unknown phase": { schema: 1, phase: "sent" },
      "journal with a future schema": { schema: 2, phase: "prepared" },
      "journal that is an array": [{ schema: 1, phase: "prepared" }],
    };
    for (const [name, value] of Object.entries(invalidJournals)) {
      await fs.writeFile(journalFile, JSON.stringify(value));
      const report = await activationObligations(root);
      expect(report, name).toMatchObject({
        drained: false,
        obligations: [],
        unreadable: ["chatgpt-task-journal"],
      });
    }
    await fs.rm(journalFile);
    const quitFile = path.join(root, "farol-next-state", "last-quit.json");
    for (const value of [
      { schema: 1, drained: "yes", unconfirmed: [] },
      { schema: 1, drained: true },
      { schema: 1, drained: true, unconfirmed: [1] },
    ]) {
      await fs.writeFile(quitFile, JSON.stringify(value));
      expect(await activationObligations(root)).toMatchObject({
        drained: false,
        unreadable: ["last-quit"],
      });
    }
    await fs.rm(quitFile);
    // Valid, settled records with every classification field admit.
    await writeTasks(root, [
      task({ lifecycle: "completed" }),
      task({
        taskId: "task-b",
        sessionId: "task-b",
        turnId: "turn-b",
        lifecycle: "idle",
        agent: { phase: "completed", parentDelivery: "acknowledged" },
      }),
    ]);
    await fs.writeFile(
      journalFile,
      JSON.stringify({ schema: 1, phase: "delivery_acknowledged" }),
    );
    await fs.writeFile(
      quitFile,
      JSON.stringify({ schema: 1, drained: true, unconfirmed: [] }),
    );
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
    const settings = (pendingEdit) => ({
      schema: 1,
      revision: 7,
      general: { openAtLaunch: "browser" },
      computer: {
        computerId: "computer-1",
        generation: 3,
        name: "Test",
        commands: "none",
        workspaces: [],
        pendingEdit,
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
    await fs.writeFile(
      path.join(root, "farol-next-state", "last-quit.json"),
      JSON.stringify({ schema: 1, drained: true, unconfirmed: [] }),
    );
    await fs.writeFile(settingsFile, JSON.stringify(settings(pending)));
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
    await fs.writeFile(
      settingsFile,
      JSON.stringify(settings({ relativePath: "README.md" })),
    );
    await expect(activationObligations(root)).resolves.toMatchObject({
      drained: false,
      unreadable: ["product-settings"],
    });
    await fs.writeFile(settingsFile, JSON.stringify({ schema: 2 }));
    await expect(activationObligations(root)).resolves.toMatchObject({
      drained: false,
      unreadable: ["product-settings"],
    });
    // Only the acknowledgment of that exact operation clears it: the
    // configuration service writes null, and then nothing is owed.
    await fs.writeFile(settingsFile, JSON.stringify(settings(null)));
    await expect(activationObligations(root)).resolves.toMatchObject({
      drained: true,
      obligations: [],
      unreadable: [],
    });
    // Settings written before the field existed carry no pending edit.
    const { pendingEdit: _absent, ...computer } = settings(null).computer;
    await fs.writeFile(
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
});
