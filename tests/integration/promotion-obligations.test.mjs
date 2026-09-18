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
        agent: { phase: "running" },
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
