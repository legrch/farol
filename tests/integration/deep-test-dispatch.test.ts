import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { PrivateChatGptTaskJournal } from "../../src/apps/desktop/chatgpt-task-journal";
import { ChatGptTaskJournalOperationIdSchema } from "../../src/apps/desktop/chatgpt-task-journal-record";
import { readFlatDeepTestRecords } from "../../src/apps/desktop/legacy-activation-obligations";

// Exercises the actual main-process orchestration with disposable state and a scripted route.
// This does not qualify an Electron view, provider, native connector or installation.
const source = await fs.readFile("src/apps/desktop/main.ts", "utf8");
const start = source.indexOf("async function runManualDeepTest(");
const end = source.indexOf("function deepTestStatus()", start);
if (start < 0 || end < 0) throw Error("DEEP_TEST_HOST_MISSING");
const javascript = transformSync(source.slice(start, end), {
  loader: "ts",
  target: "es2022",
}).code;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture(stale = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-deep-dispatch-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "farol-state"), { mode: 0o700 });
  const binding = { buildId: "build", connectorGeneration: "1" };
  const core = {
    backendAvailable: true,
    currentComputerConnectorBinding: () => binding,
  };
  const connector = {
    isRunning: () => true,
    hasUnresolvedEffect: () => false,
    getTunnelObservation: () => null,
  };
  const settings = {
    setup: {
      chatgpt: { outcomeUnknown: false },
      computer: { outcomeUnknown: false },
    },
    computer: { generation: 1, pendingEdit: null },
    connectors: {
      secureMcp: {
        tunnelId: "tunnel",
        generation: 1,
        runtime: { runtimeGeneration: "runtime" },
      },
    },
  };
  const snapshot = { status: "ready", settings };
  const owner = { snapshot: () => snapshot };
  let changed = false;
  let targetValid = true;
  const send = vi.fn();
  const route = {
    captureManualTaskTarget: () => () => targetValid,
    runReadonlyTask: vi.fn(async (prompt, _attachments, observer) => {
      if (stale) changed = true;
      await observer.onDispatchIntent();
      if (!observer.beforeSend())
        return {
          state: "failed_before_submit",
          code: "CHATGPT_SUBMIT_UNAVAILABLE",
          deltaCount: 0,
          observedCharacters: 0,
        } as never;
      send(prompt);
      return {
        state: "completed",
        code: null,
        deltaCount: 1,
        observedCharacters: 10,
      };
    }),
  };
  const context = {
    ChatGptTaskJournalOperationIdSchema,
    PrivateChatGptTaskJournal,
    readFlatDeepTestRecords,
    path,
    app: { getPath: () => root },
    configuration: owner,
    desktopGoCore: core,
    secureMcpConnectorRuntime: connector,
    selectedTaskId: "",
    chatGptRoute: route,
    liveTaskRoutes: new Map(),
    deepTestRecoveryReady: true,
    recoverableDeepTests: [],
    quitInProgress: false,
    installedUpdateAdmission: false,
    chatGptTaskAdmission: false,
    connectorTaskAdmission: false,
    pendingChatGptReadonlyTask: null,
    pendingChatGptAttachmentTask: null,
    recoverableChatGptTask: null,
    chatGptConversationAdmissionFailure: () => null,
    connectorRuntimeUncertain: () => false,
    computerConnectorAdmission: () => ({ admissible: true }),
    summaryFenceRecovery: {},
    connectorStartInFlight: null,
    browserHomeSurfaceOpen: true,
    section: "browser",
    shellOverlay: "none",
    chatGptTaskAdmissionReady: () => true,
    currentSurfaceLayout: () => ({ pageVisible: true }),
    currentConnectorAttachment: () => ({
      challengeSha256: "hash",
      workspaceId: null,
    }),
    selectedConnectorApp: () => "Farol",
    connectorAppBindingCurrent: () => !changed,
    buildIdentity: { buildId: "build" },
    journalUnderPromotionLease: async (
      _registry: unknown,
      work: () => Promise<unknown>,
    ) => work(),
    liveTaskRegistry: {},
    configurationFailure: (error: string) => ({ ok: false, error }),
    ProductConfigurationResultSchema: { parse: (value: unknown) => value },
    performance,
    setTimeout,
  };
  const run = vm.runInNewContext(
    `${javascript}\nrunManualDeepTest`,
    context,
  ) as (
    id: string,
    taskId: string,
  ) => Promise<{
    ok: boolean;
    error?: string;
    evidence?: { state: string; code: string | null };
  }>;
  return {
    root,
    run,
    route,
    send,
    context,
    invalidateTarget: () => {
      targetValid = false;
    },
    invalidateConnector: () => {
      changed = true;
    },
  };
}
it("sends the bounded prompt once and retains the exact result", async () => {
  const f = await fixture();
  const id = randomUUID();
  expect(await f.run(id, "")).toMatchObject({
    ok: true,
    evidence: { state: "completed" },
  });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]![0]).toContain(`farol-deep-test-${id}`);
  const journal = new PrivateChatGptTaskJournal({
    root: path.join(f.root, "farol-state"),
    deepTestOperationId: id,
  });
  expect(await journal.load()).toMatchObject({
    phase: "result_retained",
    result: { state: "completed" },
  });
  expect((await f.run(id, "")).ok).toBe(false);
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("refuses a changed connector binding before any send", async () => {
  const f = await fixture(true);
  const id = randomUUID();
  expect((await f.run(id, "")).ok).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
});
it("retains a known refusal when the connector changes after intent but before click", async () => {
  const f = await fixture();
  f.route.runReadonlyTask.mockImplementationOnce(
    async (_prompt, _attachments, observer) => {
      await observer.onDispatchIntent();
      f.invalidateConnector();
      if (!observer.beforeSend())
        return {
          state: "failed_before_submit",
          code: "CHATGPT_SUBMIT_UNAVAILABLE",
          deltaCount: 0,
          observedCharacters: 0,
        } as never;
      throw Error("unexpected send");
    },
  );
  const id = randomUUID();
  expect(await f.run(id, "")).toMatchObject({
    ok: true,
    evidence: { state: "failed_before_submit" },
  });
  expect(f.send).not.toHaveBeenCalled();
  expect(
    await new PrivateChatGptTaskJournal({
      root: path.join(f.root, "farol-state"),
      deepTestOperationId: id,
    }).load(),
  ).toMatchObject({ result: { state: "failed_before_submit" } });
});
it("waits for the original overlay dismissal before sending exactly once", async () => {
  const f = await fixture();
  f.context.shellOverlay = "task-menu";
  const pending = f.run(randomUUID(), "");
  expect(f.send).not.toHaveBeenCalled();
  setTimeout(() => {
    f.context.shellOverlay = "none";
  }, 30);
  expect(await pending).toMatchObject({
    ok: true,
    evidence: { state: "completed" },
  });
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("refuses if the captured document changes while waiting for layout", async () => {
  const f = await fixture();
  f.context.shellOverlay = "task-menu";
  const pending = f.run(randomUUID(), "");
  f.invalidateTarget();
  f.context.shellOverlay = "none";
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
        state: "completed",
        code: null,
        deltaCount: 0,
        observedCharacters: 0,
      };
    },
  );
  const pending = f.run(randomUUID(), "");
  await entered;
  expect(f.context.chatGptTaskAdmission).toBe(true);
  expect(f.context.connectorTaskAdmission).toBe(true);
  release();
  await pending;
  expect(f.context.chatGptTaskAdmission).toBe(false);
  expect(f.context.connectorTaskAdmission).toBe(false);
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
        } as never;
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
    expect(
      await new PrivateChatGptTaskJournal({
        root: path.join(f.root, "farol-state"),
        deepTestOperationId: id,
      }).load(),
    ).toMatchObject({
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
      } as never;
    },
  );
  const id = randomUUID();
  expect(await f.run(id, "")).toMatchObject({
    ok: true,
    evidence: { state: "outcome_unknown" },
  });
  expect(
    await new PrivateChatGptTaskJournal({
      root: path.join(f.root, "farol-state"),
      deepTestOperationId: id,
    }).load(),
  ).toMatchObject({ result: { state: "outcome_unknown" } });
  expect((await f.run(id, "")).ok).toBe(false);
  expect(f.route.runReadonlyTask).toHaveBeenCalledTimes(1);
  const freshId = randomUUID();
  expect(await f.run(freshId, "")).toMatchObject({
    ok: true,
    evidence: { state: "completed" },
  });
  expect(f.route.runReadonlyTask).toHaveBeenCalledTimes(2);
  expect(
    await new PrivateChatGptTaskJournal({
      root: path.join(f.root, "farol-state"),
      deepTestOperationId: id,
    }).load(),
  ).toMatchObject({ result: { state: "outcome_unknown" } });
});
