import { parse } from "@babel/parser";
import { isDeepStrictEqual } from "node:util";
import { admissionFixture } from "../support/desktop-admission";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { PrivateChatGptTaskJournal } from "../../src/apps/desktop/chatgpt-task-journal";
import {
  ChatGptTaskJournalOperationIdSchema,
  MAX_CHATGPT_TASK_JOURNAL_BYTES,
  MAX_DEEP_TEST_HISTORY_BYTES,
  MAX_DEEP_TEST_HISTORY_RECORDS,
  MAX_DEEP_TEST_OUTSTANDING,
} from "../../src/apps/desktop/chatgpt-task-journal-record";
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
      expect(observer.manualSubmissionOnly).toBe(true);
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
        state: "send_requested",
        code: null,
        deltaCount: 0,
        observedCharacters: 0,
      };
    }),
  };
  const context = {
    ChatGptTaskJournalOperationIdSchema,
    MAX_CHATGPT_TASK_JOURNAL_BYTES,
    MAX_DEEP_TEST_HISTORY_BYTES,
    MAX_DEEP_TEST_HISTORY_RECORDS,
    MAX_DEEP_TEST_OUTSTANDING,
    PrivateChatGptTaskJournal,
    readFlatDeepTestRecords,
    path,
    app: { getPath: () => root },
    statePaths: () => ({ state: path.join(root, "farol-state") }),
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
    connectorTaskAdmissionPurpose: null,
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
    admissionFixture(context),
  ) as (
    id: string,
    taskId: string,
    test?: "connection" | "deep",
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
it("sends a connection prompt without file operations", async () => {
  const f = await fixture();
  expect(await f.run(randomUUID(), "", "connection")).toMatchObject({
    ok: true,
    evidence: { state: "send_requested" },
  });
  expect(f.send).toHaveBeenCalledTimes(1);
  const prompt = f.send.mock.calls[0]![0] as string;
  expect(prompt).toContain("computer_connection_status");
  expect(prompt).toContain("do not read or change files");
  expect(prompt).not.toContain("computer_workspace_write");
});

it("admits a new request after 256 acknowledged records while retaining unknown history and no-replay", async () => {
  const f = await fixture();
  const root = path.join(f.root, "farol-state");
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
  const root = path.join(f.root, "farol-state");
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
  expect(f.send.mock.calls[0]![0]).toContain(`farol-deep-test-${id}.txt`);
  expect(f.send.mock.calls[0]![0]).toContain(
    "expectedSha256: null (create-only)",
  );
  expect(f.send.mock.calls[0]![0]).toContain(
    "Do not list or read that nonexistent test path before creating it",
  );
  expect(f.send.mock.calls[0]![0]).toContain(
    "Never clean up after an unknown effect",
  );
  expect(f.send.mock.calls[0]![0]).toContain("For shell smoke");
  expect(f.send.mock.calls[0]![0]).toContain(
    "Treat cleanup as a separate case",
  );
  expect(f.send.mock.calls[0]![0]).toContain("write:true and pinned /bin/rm");
  expect(f.send.mock.calls[0]![0]).toContain(
    "do not use globs or recursive removal",
  );
  expect(f.send.mock.calls[0]![0]).toContain(
    "not an atomic compare-and-delete",
  );
  const journal = new PrivateChatGptTaskJournal({
    root: path.join(f.root, "farol-state"),
    deepTestOperationId: id,
  });
  expect(await journal.load()).toMatchObject({
    phase: "result_retained",
    result: { state: "send_requested" },
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
    evidence: { state: "send_requested" },
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
        state: "send_requested",
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
    evidence: { state: "send_requested" },
  });
  expect(f.route.runReadonlyTask).toHaveBeenCalledTimes(2);
  expect(
    await new PrivateChatGptTaskJournal({
      root: path.join(f.root, "farol-state"),
      deepTestOperationId: id,
    }).load(),
  ).toMatchObject({ result: { state: "outcome_unknown" } });
});

// Existing Main characterization seam: controlled journal refusal and no Send.
function submissionCase(kind: string): string {
  const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
  let selected: { start?: number | null; end?: number | null } | undefined;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if (
      node.type === "SwitchCase" &&
      (node.test as { value?: string })?.value === kind
    )
      selected = node;
    Object.values(node).forEach(visit);
  };
  visit(tree);
  if (selected?.start == null || selected.end == null)
    throw Error("Missing submission fixture seam");
  return transformSync(
    `async function submit(command) { switch(command.kind) { ${source.slice(selected.start, selected.end)} } } submit;`,
    { loader: "ts" },
  ).code;
}

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
      chatGptRoute: route,
      pendingChatGptAttachmentTask:
        kind === "chatgpt.submit-attachment-task" ? pending : null,
      pendingChatGptReadonlyTask:
        kind === "chatgpt.submit-readonly-task" ? pending : null,
      configuration: {
        snapshot: () => ({
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
        }),
      },
      isDeepStrictEqual,
      verifyStagedChatGptAttachments: async () => {},
      chatGptTaskJournal: {
        markDispatchIntent: () => {
          reached();
          return journalWait;
        },
      },
      journalUnderPromotionLease: async (
        _owner: unknown,
        work: () => Promise<unknown>,
      ) => work(),
      liveTaskRegistry: {},
      configurationFailure: (error: string) => ({ ok: false, error }),
      PromotionPendingRefusal: class extends Error {},
    });
    const submit = vm.runInNewContext(
      submissionCase(kind),
      context,
    ) as (command: { kind: string; operationId: string }) => Promise<unknown>;
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
