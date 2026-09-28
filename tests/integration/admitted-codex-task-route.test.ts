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
  it("keeps project resolution on the sealed selected ID and refuses drift or cancellation", async () => {
    const known = {
      status: "resolved" as const,
      workspaceId: "writer",
      writerRoot: "/fixture/writer",
      projectRoot: "/fixture/project",
      complete: true as const,
      pages: 1,
      matches: [{ projectId: "saved-project", name: null }],
      selectedProjectId: "saved-project",
      selection: "requested-id" as const,
    };
    let now = 1000;
    let mode = "known";
    let calls = 0;
    const controller = new AbortController();
    const seen: unknown[] = [];
    const delegate = {
      async resolveProject(input: unknown) {
        calls++;
        seen.push(input);
        if (mode === "expire") now = 2000;
        if (mode === "abort") controller.abort();
        return mode === "foreign"
          ? { ...known, selectedProjectId: "foreign" }
          : known;
      },
      async create(input: HandoffRequest) {
        return { status: "outcome_unknown" as const, dispatchId: input.key };
      },
      async message() {
        return { status: "refused" as const, code: "not-selected" };
      },
      async status() {
        return { status: "unknown" as const };
      },
      async result() {
        return { status: "unknown" as const };
      },
    };
    const admission = {
      workspaceId: "writer",
      projectId: "saved-project",
      ...taskGrantPolicy(),
      expiresAt: 2000,
    };
    const route = new AdmittedCodexTaskRoute(delegate, admission, () => now);
    expect(await route.resolveProject({ workspaceId: "writer" })).toEqual(
      known,
    );
    expect(seen).toEqual([
      { workspaceId: "writer", preferredProjectId: "saved-project" },
    ]);
    for (const input of [
      { workspaceId: "foreign" },
      { workspaceId: "writer", preferredProjectId: "other" },
    ])
      expect(await route.resolveProject(input)).toMatchObject({
        status: "refused",
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      });
    expect(calls).toBe(1);
    mode = "foreign";
    expect(await route.resolveProject({ workspaceId: "writer" })).toMatchObject(
      { status: "refused", code: "HANDOFF_PROJECT_RESOLVE_CORRELATION" },
    );
    mode = "abort";
    expect(
      await route.resolveProject(
        { workspaceId: "writer" },
        { signal: controller.signal },
      ),
    ).toMatchObject({
      status: "refused",
      code: "HANDOFF_PROJECT_READ_CANCELLED",
    });
    expect(
      await route.resolveProject(
        { workspaceId: "writer" },
        { signal: controller.signal },
      ),
    ).toMatchObject({
      status: "refused",
      code: "HANDOFF_PROJECT_READ_CANCELLED",
    });
    mode = "expire";
    expect(await route.resolveProject({ workspaceId: "writer" })).toMatchObject(
      { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" },
    );
    expect(await route.resolveProject({ workspaceId: "writer" })).toMatchObject(
      { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" },
    );
    const { resolveProject: _unused, ...without } = delegate;
    expect(
      await new AdmittedCodexTaskRoute(
        without,
        admission,
        () => 1000,
      ).resolveProject({ workspaceId: "writer" }),
    ).toMatchObject({
      status: "refused",
      code: "HANDOFF_PROJECT_RESOLVE_UNAVAILABLE",
    });
  });

  it("admits one selected native turn for a local read-only handle and rechecks expiry", async () => {
    const threadId = randomUUID();
    const turnId = randomUUID();
    let now = 1_000;
    let calls = 0;
    const route = new AdmittedCodexTaskRoute(
      {
        create: async (input) => ({
          status: "outcome_unknown",
          dispatchId: input.key,
        }),
        message: async () => {
          throw new Error("unexpected message");
        },
        adopt: async () => {
          calls += 1;
          return { status: "adopted", dispatchId: turnId };
        },
        status: async () => ({ status: "unknown" }),
        result: async () => ({ status: "unknown" }),
      },
      {
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        observeThreadId: threadId,
        ...taskGrantPolicy(),
        expiresAt: 2_000,
      },
      () => now,
    );
    const selection = {
      threadId,
      turnId,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
    };
    expect(await route.adopt({ ...selection, threadId: randomUUID() })).toEqual(
      {
        status: "refused",
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      },
    );
    expect(calls).toBe(0);
    expect(await route.adopt(selection)).toEqual({
      status: "adopted",
      dispatchId: turnId,
    });
    expect(calls).toBe(1);
    now = 2_000;
    expect(await route.adopt(selection)).toEqual({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    expect(calls).toBe(1);
  });

  it("resolves an exact policy snapshot and refuses project, workspace or expiry drift", async () => {
    let calls = 0;
    let now = 1_000;
    let expireOnObserve = false;
    const selectedThreadId = randomUUID();
    const creates: HandoffRequest[] = [];
    const delegate: CodexTaskRoute = {
      async observe(input) {
        calls += 1;
        if (expireOnObserve) now = 2_000;
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
    const route = new AdmittedCodexTaskRoute(
      delegate,
      {
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        observeThreadId: selectedThreadId,
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
      threadId: selectedThreadId,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
    };
    expect(await route.observe({ ...selection, projectId: "other" })).toEqual({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    expect(calls).toBe(0);
    expect(route.observeEnabled).toBe(true);
    expect(
      await route.observe({ ...selection, threadId: randomUUID() }),
    ).toEqual({
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
    expireOnObserve = true;
    expect(await route.observe(selection)).toEqual({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    expect(calls).toBe(4);
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
    expect(calls).toBe(4);
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
