import { describe, expect, it } from "vitest";

import type { CodexTaskRoute } from "../../src/modules/chat/contract/codex-task-route";
import { AdmittedCodexTaskRoute } from "../../src/modules/chat/infra/native/admitted-codex-task-route";

const request = {
  key: "41949674-c1e4-4a73-9098-4d31da6e7aaa",
  workspaceId: "writer",
  projectId: "saved-project",
  message: "Read README H1",
  model: "gpt-6-luna",
  reasoningEffort: "medium",
};

describe("separate Codex task admission", () => {
  it("refuses drift in project, workspace, model, effort or expiry before any host call", async () => {
    let calls = 0;
    const delegate: CodexTaskRoute = {
      async create(input) {
        calls += 1;
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
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        expiresAt: 2_000,
      },
      () => now,
    );
    for (const changed of [
      { workspaceId: "other" },
      { projectId: "other" },
      { model: "gpt-6-sol" },
      { reasoningEffort: "high" },
    ]) {
      await expect(route.create({ ...request, ...changed })).resolves.toEqual({
        status: "refused",
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      });
    }
    expect(calls).toBe(0);
    expect(await route.create(request)).toEqual({
      status: "outcome_unknown",
      dispatchId: request.key,
    });
    expect(calls).toBe(1);
    now = 2_000;
    await expect(route.create(request)).resolves.toEqual({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    expect(calls).toBe(1);
  });
});
