import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { CodexTaskRoute } from "../../src/modules/chat/contract/codex-task-route";
import type { HandoffRequest } from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { AdmittedCodexTaskRoute } from "../../src/modules/chat/infra/native/admitted-codex-task-route";
import { taskGrantPolicy } from "../fixtures/task-policy";

const request = {
  key: "41949674-c1e4-4a73-9098-4d31da6e7aaa",
  workspaceId: "writer",
  projectId: "saved-project",
  message: "Read README H1",
};

describe("separate Codex task admission", () => {
  it("resolves an exact policy snapshot and refuses project, workspace or expiry drift", async () => {
    let calls = 0;
    const creates: HandoffRequest[] = [];
    const delegate: CodexTaskRoute = {
      async observe(input) {
        calls += 1;
        return {
          status: "observed",
          threadId: input.threadId,
          title: null,
          model: null,
          turns: [],
          hasMoreTurns: false,
        };
      },
      async message(input) {
        calls += 1;
        return { status: "outcome_unknown", dispatchId: input.dispatchId };
      },
      async create(input) {
        calls += 1;
        creates.push(input as HandoffRequest);
        return { status: "outcome_unknown", dispatchId: input.key };
      },
      async status() {
        return { status: "unknown" };
      },
      async result() {
        return { status: "unknown" };
      },
    };
    let now = 1_000;
    const route = new AdmittedCodexTaskRoute(
      delegate,
      {
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        ...taskGrantPolicy(),
        expiresAt: 2_000,
      },
      () => now,
      { message: true },
    );
    for (const changed of [{ workspaceId: "other" }, { projectId: "other" }]) {
      await expect(route.create({ ...request, ...changed })).resolves.toEqual({
        status: "refused",
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      });
    }
    expect(calls).toBe(0);
    const selection = {
      threadId: randomUUID(),
      workspaceId: request.workspaceId,
      projectId: request.projectId,
    };
    expect(await route.observe({ ...selection, projectId: "other" })).toEqual({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    expect(calls).toBe(0);
    expect(await route.observe(selection)).toMatchObject({
      status: "observed",
      threadId: selection.threadId,
    });
    expect(calls).toBe(1);
    expect(await route.create(request)).toEqual({
      status: "outcome_unknown",
      dispatchId: request.key,
    });
    expect(calls).toBe(2);
    expect(creates[0]).toMatchObject({
      model: "gpt-6-luna",
      reasoningEffort: "medium",
      modelBinding: {
        selection: { harness: "codex", modelAlias: "luna" },
      },
    });
    const message = {
      key: randomUUID(),
      dispatchId: request.key,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      message: "One steer",
      model: "gpt-6-luna",
      reasoningEffort: "medium",
    };
    expect(
      await route.message({ ...message, projectId: "other" }),
    ).toMatchObject({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    expect(calls).toBe(2);
    expect(await route.message(message)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(calls).toBe(3);
    now = 2_000;
    expect(await route.observe(selection)).toEqual({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    await expect(route.create(request)).resolves.toEqual({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    expect(await route.message(message)).toMatchObject({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    expect(calls).toBe(3);
  });

  it("does not advertise unqualified task control from configured models", async () => {
    const route = new AdmittedCodexTaskRoute(
      {
        create: async (input) => ({
          status: "outcome_unknown",
          dispatchId: input.key,
        }),
        message: async () => {
          throw new Error("unqualified control reached host");
        },
        status: async () => ({ status: "unknown" }),
        result: async () => ({ status: "unknown" }),
      },
      {
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        ...taskGrantPolicy(),
        expiresAt: Date.now() + 60_000,
      },
    );
    expect(route.controlCapabilities.message).toBe(false);
    expect(route.controlCapabilities.continue).toBe(false);
    expect(
      await route.message({
        key: randomUUID(),
        dispatchId: request.key,
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        message: "One steer",
        model: "gpt-6-luna",
        reasoningEffort: "medium",
      }),
    ).toEqual({ status: "refused", code: "TASK_CONTROL_NOT_QUALIFIED" });
    expect(
      await route.continue({
        key: randomUUID(),
        dispatchId: request.key,
        message: "No control",
      }),
    ).toEqual({ status: "refused", code: "TASK_CONTROL_NOT_QUALIFIED" });
  });
});
