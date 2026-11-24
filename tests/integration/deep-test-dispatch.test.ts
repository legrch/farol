import { admissionFixture } from "../support/desktop-admission";
import { scriptedChatgptPorts } from "../support/chatgpt-configuration-ports";
import {
  cleanupDeepFixtures,
  deepFixture,
  type DeepObserver,
} from "../support/deep-test-fixture";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readFlatDeepTestRecords } from "../../src/apps/desktop/legacy-activation-obligations";
import { createConfigurationChatgpt } from "../../apps/desktop/configuration/chatgpt";

// Exercises the production deep-test host module against a real journal in a
// disposable directory and a scripted route. This does not qualify an Electron
// view, provider, native connector or installation.
afterEach(cleanupDeepFixtures);
const fixture = deepFixture;

it("sends a connection prompt without file operations", async () => {
  const f = await fixture();
  expect(await f.run(randomUUID(), "", "connection")).toMatchObject({
    ok: true,
    evidence: { state: "send_requested" },
  });
  expect(f.send).toHaveBeenCalledTimes(1);
  const prompt = f.send.mock.calls[0]![0];
  expect(prompt).toContain("computer_connection_status");
  expect(prompt).toContain("do not read or change files");
  expect(prompt).not.toContain("computer_workspace_write");
});

it("admits a new request after 256 acknowledged records while retaining unknown history and no-replay", async () => {
  const f = await fixture();
  const root = f.stateRoot;
  const original = randomUUID();
  const unknown = {
    state: "outcome_unknown",
    code: "CHATGPT_TASK_TIMEOUT",
    deltaCount: 0,
    observedCharacters: 0,
    attachmentCount: 0,
    totalBytes: 0,
    stagingCleanup: null,
  };
  const writeRecord = async (id: string, phase: string) => {
    const record = {
      schema: 1,
      operationId: id,
      kind: "readonly",
      phase,
      createdAt: "2026-11-02T00:00:00.000Z",
      updatedAt: "2026-11-02T00:00:00.000Z",
      result: unknown,
    };
    await fs.writeFile(
      path.join(root, `deep-test-${id}.json`),
      JSON.stringify(record),
      { mode: 0o600 },
    );
  };
  await Promise.all(
    Array.from({ length: 256 }, () =>
      writeRecord(randomUUID(), "delivery_acknowledged"),
    ),
  );
  await writeRecord(original, "result_retained");
  const originalBytes = await fs.readFile(
    path.join(root, `deep-test-${original}.json`),
  );
  expect(await f.run(randomUUID(), "", "connection")).toMatchObject({
    ok: true,
    evidence: { state: "send_requested" },
  });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect((await f.run(original, "")).ok).toBe(false);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(
    await fs.readFile(path.join(root, `deep-test-${original}.json`)),
  ).toEqual(originalBytes);
});

it("refuses a new send when 256 original results remain unacknowledged", async () => {
  const f = await fixture();
  const root = f.stateRoot;
  const record = (id: string) => ({
    schema: 1,
    operationId: id,
    kind: "readonly",
    phase: "dispatch_intent",
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    result: null,
  });
  await Promise.all(
    Array.from({ length: 256 }, async () => {
      const id = randomUUID();
      await fs.writeFile(
        path.join(root, `deep-test-${id}.json`),
        JSON.stringify(record(id)),
        { mode: 0o600 },
      );
    }),
  );
  expect((await f.run(randomUUID(), "", "connection")).ok).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.route.runReadonlyTask).not.toHaveBeenCalled();
  expect((await readFlatDeepTestRecords(root)).status).toBe("read");
});
it("sends the bounded prompt once and retains the exact result", async () => {
  const f = await fixture();
  const id = randomUUID();
  expect(await f.run(id, "")).toMatchObject({
    ok: true,
    evidence: { state: "send_requested" },
  });
  expect(f.send).toHaveBeenCalledTimes(1);
  const prompt = f.send.mock.calls[0]![0];
  expect(prompt).toContain(`farol-deep-test-${id}.txt`);
  expect(prompt).toContain("expectedSha256: null (create-only)");
  expect(prompt).toContain(
    "Do not list or read that nonexistent test path before creating it",
  );
  expect(prompt).toContain("Never clean up after an unknown effect");
  expect(prompt).toContain("For shell smoke");
  expect(prompt).toContain("Treat cleanup as a separate case");
  expect(prompt).toContain("write:true and pinned /bin/rm");
  expect(prompt).toContain("do not use globs or recursive removal");
  expect(prompt).toContain("not an atomic compare-and-delete");
  expect(await f.journal(id).load()).toMatchObject({
    phase: "result_retained",
    result: { state: "send_requested" },
  });
  expect((await f.run(id, "")).ok).toBe(false);
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("refuses a changed connector binding before any send", async () => {
  const f = await fixture();
  f.route.runReadonlyTask.mockImplementationOnce(async (_p, _a, observer) => {
    f.state.bindingCurrent = false;
    await (observer as DeepObserver).onDispatchIntent();
    return {
      state: "send_requested",
      code: null,
      deltaCount: 0,
      observedCharacters: 0,
    };
  });
  expect((await f.run(randomUUID(), "")).ok).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
});
it("retains a known refusal when the connector changes after intent but before click", async () => {
  const f = await fixture();
  f.route.runReadonlyTask.mockImplementationOnce(
    async (_prompt, _attachments, observer) => {
      await observer.onDispatchIntent();
      f.state.bindingCurrent = false;
      if (!observer.beforeSend())
        return {
          state: "failed_before_submit",
          code: "CHATGPT_SUBMIT_UNAVAILABLE",
          deltaCount: 0,
          observedCharacters: 0,
        };
      throw Error("unexpected send");
    },
  );
  const id = randomUUID();
  expect(await f.run(id, "")).toMatchObject({
    ok: true,
    evidence: { state: "failed_before_submit" },
  });
  expect(f.send).not.toHaveBeenCalled();
  expect(await f.journal(id).load()).toMatchObject({
    result: { state: "failed_before_submit" },
  });
});
it("waits for the original overlay dismissal before sending exactly once", async () => {
  const f = await fixture();
  f.state.shellOverlay = "task-menu";
  const pending = f.run(randomUUID(), "");
  expect(f.send).not.toHaveBeenCalled();
  setTimeout(() => {
    f.state.shellOverlay = "none";
  }, 30);
  expect(await pending).toMatchObject({
    ok: true,
    evidence: { state: "send_requested" },
  });
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("refuses if the captured document changes while waiting for layout", async () => {
  const f = await fixture();
  f.state.shellOverlay = "task-menu";
  const pending = f.run(randomUUID(), "");
  f.state.targetValid = false;
  f.state.shellOverlay = "none";
  expect((await pending).ok).toBe(false);
  expect(f.route.runReadonlyTask).not.toHaveBeenCalled();
});
it("holds both host admissions through the original in-flight request", async () => {
  const f = await fixture();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.route.runReadonlyTask.mockImplementationOnce(
    async (_prompt, _attachments, observer) => {
      await observer.onDispatchIntent();
      started();
      await gate;
      return {
        state: "send_requested",
        code: null,
        deltaCount: 0,
        observedCharacters: 0,
      };
    },
  );
  const pending = f.run(randomUUID(), "");
  await entered;
  expect(f.admission.occupied("chatgpt-task")).toBe(true);
  expect(f.admission.occupied("connector-task")).toBe(true);
  release();
  await pending;
  expect(f.admission.occupied("chatgpt-task")).toBe(false);
  expect(f.admission.occupied("connector-task")).toBe(false);
});
it.each([false, true])(
  "retains a known pre-submit refusal after intent=%s without claiming a send",
  async (intent) => {
    const f = await fixture();
    f.route.runReadonlyTask.mockImplementationOnce(
      async (_prompt, _attachments, observer) => {
        if (intent) await observer.onDispatchIntent();
        return {
          state: "failed_before_submit",
          code: "CHATGPT_COMPOSER_DRAFT_PRESENT",
          deltaCount: 0,
          observedCharacters: 0,
        };
      },
    );
    const id = randomUUID();
    expect(await f.run(id, "")).toMatchObject({
      ok: true,
      evidence: {
        state: "failed_before_submit",
        code: "CHATGPT_COMPOSER_DRAFT_PRESENT",
      },
    });
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.journal(id).load()).toMatchObject({
      phase: "result_retained",
      result: { state: "failed_before_submit" },
    });
  },
);
it("retains an unknown result without re-sending", async () => {
  const f = await fixture();
  f.route.runReadonlyTask.mockImplementationOnce(
    async (_prompt, _attachments, observer) => {
      await observer.onDispatchIntent();
      return {
        state: "outcome_unknown",
        code: "CHATGPT_TASK_ERROR",
        deltaCount: 0,
        observedCharacters: 0,
      };
    },
  );
  const id = randomUUID();
  expect(await f.run(id, "")).toMatchObject({
    ok: true,
    evidence: { state: "outcome_unknown" },
  });
  expect(await f.journal(id).load()).toMatchObject({
    result: { state: "outcome_unknown" },
  });
  expect((await f.run(id, "")).ok).toBe(false);
  expect(f.route.runReadonlyTask).toHaveBeenCalledTimes(1);
  const freshId = randomUUID();
  expect(await f.run(freshId, "")).toMatchObject({
    ok: true,
    evidence: { state: "send_requested" },
  });
  expect(f.route.runReadonlyTask).toHaveBeenCalledTimes(2);
  expect(await f.journal(id).load()).toMatchObject({
    result: { state: "outcome_unknown" },
  });
});

// The production ChatGPT command handler with a controlled journal refusal: no Send.
it.each(["chatgpt.submit-attachment-task", "chatgpt.submit-readonly-task"])(
  "reserves the chat lane before dispatch-intent preparation for %s",
  async (kind) => {
    let reached!: () => void;
    const journalReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let reject!: (error: Error) => void;
    const journalWait = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const verification = { controlled: true };
    const pending = {
      operationId: "controlled-operation",
      expiresAt: Date.now() + 60_000,
      chatGptVerification: verification,
      workspaceId: "controlled-workspace",
      computerGeneration: 1,
      prompt: "controlled prompt",
      attachments: { attachments: [] },
    };
    const route = { runReadonlyTask: vi.fn() };
    const context = admissionFixture({
      pendingChatGptAttachmentTask:
        kind === "chatgpt.submit-attachment-task" ? pending : null,
      pendingChatGptReadonlyTask:
        kind === "chatgpt.submit-readonly-task" ? pending : null,
    });
    const snapshot = {
      status: "ready",
      settings: {
        setup: {
          chatgpt: { outcomeUnknown: false, verified: verification },
          computer: {
            verified: {
              workspaceId: pending.workspaceId,
              configRevision: 1,
            },
          },
        },
        computer: {
          generation: 1,
          workspaces: [{ workspaceId: pending.workspaceId }],
        },
      },
    };
    const journal = {
      markDispatchIntent: () => {
        reached();
        return journalWait;
      },
    };
    const handler = createConfigurationChatgpt(
      scriptedChatgptPorts({
        chatGptRoute: () => route as never,
        desktopAdmission: context.desktopAdmission,
        pendingChatGptAttachmentTask: () =>
          (kind === "chatgpt.submit-attachment-task" ? pending : null) as never,
        pendingChatGptReadonlyTask: () =>
          (kind === "chatgpt.submit-readonly-task" ? pending : null) as never,
        configuration: () => ({ snapshot: () => snapshot }) as never,
        verifyStagedChatGptAttachments: async () => {},
        chatGptTaskJournal: () => journal as never,
        liveTaskRegistry: {
          withPromotionLease: async (
            work: (fence: () => Promise<void>) => Promise<unknown>,
          ) => ({
            ok: true,
            value: await work(async () => {}),
          }),
        } as never,
        configurationFailure: (error: string) =>
          ({ ok: false, error }) as never,
      }),
    );
    const submit = (command: { kind: string; operationId: string }) =>
      handler.configureAdmittedChatgpt(command as never);
    const first = submit({ kind, operationId: pending.operationId });
    await Promise.race([
      journalReached,
      first.then(() => {
        throw Error("Journal barrier not reached");
      }),
    ]);
    const competingCheck = context.desktopAdmission.acquire("chatgpt-task");
    try {
      expect(competingCheck).toBeNull();
    } finally {
      competingCheck?.release();
      reject(new Error("controlled journal refusal"));
      await expect(first).resolves.toEqual({
        ok: false,
        error: "CHATGPT_TASK_JOURNAL_FAILED",
      });
    }
    expect(route.runReadonlyTask).not.toHaveBeenCalled();
    expect(context.desktopAdmission.occupied("chatgpt-task")).toBe(false);
  },
);
