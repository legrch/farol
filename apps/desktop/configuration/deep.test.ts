import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupDeepFixtures,
  deepFixture,
  sendRequested,
  type DeepFixture,
  type DeepObserver,
  type DeepRouteResult,
} from "../../../tests/support/deep-test-fixture";
import {
  fixtureBuildId,
  fixtureWorkspaceId,
} from "../../../tests/fixtures/guided-onboarding";

// These scripted ports cover refusal order, the layout wait, journal order and
// result handling only. The journal is real and disposable; the route, connector
// and every main-owned helper are scripted. They do not qualify a ChatGPT page,
// a live provider, a native connector or an installation.
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  consoleError.mockRestore();
  vi.useRealTimers();
  await cleanupDeepFixtures();
});

const inProgress = { ok: false, error: "CHATGPT_TASK_IN_PROGRESS" };
const notReady = { ok: false, error: "CONNECTOR_APP_VERIFICATION_NOT_READY" };
const journalFailed = { ok: false, error: "CHATGPT_TASK_JOURNAL_FAILED" };

function expectNoSend(f: DeepFixture) {
  expect(f.send).not.toHaveBeenCalled();
  expect(f.route.runReadonlyTask).not.toHaveBeenCalled();
}

async function phase(f: DeepFixture, id: string) {
  return (await f.journal(id).load())?.phase ?? null;
}

type Settings = DeepFixture["settings"];
function connector(f: DeepFixture) {
  return f.settings.connectors.secureMcp as Settings["connectors"]["secureMcp"];
}

describe("runManualDeepTest", () => {
  it("rejects a malformed operation id before touching any owner", async () => {
    const f = await deepFixture();
    expect(await f.run("not an id", "")).toEqual({
      ok: false,
      error: "SETTINGS_INPUT_INVALID",
    });
    expect(f.route.captureManualTaskTarget).not.toHaveBeenCalled();
    expectNoSend(f);
  });

  it("sends the deep prompt once, retains the result and releases both admissions", async () => {
    const f = await deepFixture();
    const id = randomUUID();
    expect(await f.run(id, "")).toMatchObject({
      ok: true,
      evidence: {
        kind: "chatgpt.deep-test-result",
        operationId: id,
        state: "send_requested",
        code: null,
      },
    });
    expect(f.send).toHaveBeenCalledTimes(1);
    const prompt = f.send.mock.calls[0]![0];
    expect(prompt).toContain("Run a manual Deep test using the selected Farol");
    expect(prompt).toContain(`farol-deep-test-${id}.txt`);
    expect(f.route.runReadonlyTask).toHaveBeenCalledWith(
      prompt,
      [],
      expect.objectContaining({
        manualDeepTest: true,
        manualSubmissionOnly: true,
      }),
      "ordinary",
      { name: "Farol" },
    );
    expect(await f.journal(id).load()).toMatchObject({
      phase: "result_retained",
      result: { state: "send_requested", code: null },
    });
    expect(f.state.recoverable.map((record) => record.operationId)).toEqual([
      id,
    ]);
    expect(f.admission.occupied("chatgpt-task")).toBe(false);
    expect(f.admission.occupied("connector-task")).toBe(false);
  });

  it("sends the connection prompt without file operations", async () => {
    const f = await deepFixture();
    expect(await f.run(randomUUID(), "", "connection")).toMatchObject({
      ok: true,
    });
    const prompt = f.send.mock.calls[0]![0];
    expect(prompt).toContain("computer_connection_status");
    expect(prompt).toContain("do not read or change files");
    expect(prompt).not.toContain("computer_workspace_write");
  });

  it("holds both host admissions, as a manual diagnostic, through the in-flight request", async () => {
    const f = await deepFixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (entered = resolve));
    f.route.runReadonlyTask.mockImplementationOnce(async (_p, _a, observer) => {
      await (observer as DeepObserver).onDispatchIntent();
      entered();
      await gate;
      return sendRequested;
    });
    const pending = f.run();
    await reached;
    expect(f.admission.occupied("chatgpt-task")).toBe(true);
    expect(f.admission.occupied("connector-task")).toBe(true);
    expect(f.admission.connectorTaskAdmissionPurpose).toBe("manual-diagnostic");
    release();
    await pending;
    expect(f.admission.occupied("chatgpt-task")).toBe(false);
    expect(f.admission.occupied("connector-task")).toBe(false);
  });

  describe("route and surface refusals", () => {
    it("refuses a different selected task before any wait", async () => {
      const f = await deepFixture();
      f.state.selectedTaskId = "task-a";
      expect(await f.run(randomUUID(), "")).toEqual({
        ok: false,
        error: "CHATGPT_ROUTE_UNAVAILABLE",
      });
      expectNoSend(f);
    });

    it("refuses a missing home route or live task route", async () => {
      const f = await deepFixture();
      f.state.route = null;
      expect(await f.run(randomUUID(), "")).toEqual({
        ok: false,
        error: "CHATGPT_ROUTE_UNAVAILABLE",
      });
      const g = await deepFixture();
      g.state.selectedTaskId = "task-a";
      expect(await g.run(randomUUID(), "task-a")).toEqual({
        ok: false,
        error: "CHATGPT_ROUTE_UNAVAILABLE",
      });
    });

    it("refuses when the route has no capturable target", async () => {
      const f = await deepFixture();
      f.route.captureManualTaskTarget.mockReturnValueOnce(
        undefined as never as () => boolean,
      );
      expect(await f.run(randomUUID(), "")).toEqual({
        ok: false,
        error: "CHATGPT_ROUTE_UNAVAILABLE",
      });
      expect(f.state.browserHome).toBe(true);
    });

    it("treats a loaded home document as the open home surface", async () => {
      const f = await deepFixture();
      f.state.browserHome = false;
      expect(await f.run(randomUUID(), "")).toMatchObject({ ok: true });
      expect(f.state.browserHome).toBe(true);
    });

    it("does not need the home surface for a live task route", async () => {
      const f = await deepFixture();
      f.state.browserHome = false;
      f.state.selectedTaskId = "task-a";
      f.state.liveRoutes.set("task-a", f.route);
      expect(await f.run(randomUUID(), "task-a")).toMatchObject({ ok: true });
      expect(f.state.browserHome).toBe(false);
    });

    const refusals: [string, (f: DeepFixture) => unknown][] = [
      ["no configuration owner", (f) => void (f.state.owner = null)],
      ["no go core", (f) => void (f.state.core = null)],
      ["backend unavailable", (f) => void (f.state.backendAvailable = false)],
      ["no connector runtime", (f) => void (f.state.connector = null)],
      ["no connector binding", (f) => void (f.state.binding = null as never)],
      [
        "settings not ready",
        (f) =>
          void (f.state.snapshot = {
            status: "error",
            error: "SETTINGS_READ_FAILED",
          }),
      ],
      ["recovery not ready", (f) => void (f.state.recoveryReady = false)],
      ["desktop closed", (f) => f.admission.beginQuit()],
      [
        "chatgpt task occupied",
        (f) => void f.admission.reserveAdmitted("chatgpt-task"),
      ],
      [
        "connector task occupied",
        (f) => void f.admission.reserveAdmitted("connector-task"),
      ],
      [
        "pending readonly task",
        (f) => void (f.state.pendingReadonly = { pending: true }),
      ],
      [
        "pending attachment task",
        (f) => void (f.state.pendingAttachment = { pending: true }),
      ],
      [
        "recoverable task",
        (f) => void (f.state.recoverableTask = { recoverable: true }),
      ],
      [
        "connector start in flight",
        (f) => void (f.state.connectorStart = Promise.resolve()),
      ],
      ["connector not running", (f) => void (f.state.running = false)],
      [
        "tunnel observation",
        (f) => void (f.state.tunnelObservation = { observed: true }),
      ],
      [
        "unresolved connector effect",
        (f) => void (f.state.unresolvedEffect = true),
      ],
      ["page not visible", (f) => void (f.state.pageVisible = false)],
      ["not the browser section", (f) => void (f.state.section = "computer")],
      [
        "a shell overlay",
        (f) => void (f.state.shellOverlay = "quick-switcher"),
      ],
      ["captured target gone", (f) => void (f.state.targetValid = false)],
    ];
    it.each(refusals)(
      "refuses with %s and logs the refusal",
      async (_name, arrange) => {
        const f = await deepFixture();
        arrange(f);
        expect(await f.run(randomUUID(), "")).toEqual(inProgress);
        expectNoSend(f);
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("FAROL_DEEP_TEST_REFUSED"),
        );
        expect(await fs.readdir(f.stateRoot)).toEqual([]);
        expect(f.admission.occupied("chatgpt-task")).toBe(
          _name === "chatgpt task occupied",
        );
      },
    );

    it("returns the conversation admission failure unchanged", async () => {
      const f = await deepFixture();
      const failure = {
        ok: false,
        error: "CHATGPT_CONVERSATION_REVIEW_REQUIRED",
      };
      f.state.conversationFailure = failure;
      expect(await f.run(randomUUID(), "")).toBe(failure);
      expectNoSend(f);
    });

    it.each([
      [
        "a pending workspace edit",
        (s: Settings) =>
          void ((s.computer as { pendingEdit: unknown }).pendingEdit = {}),
      ],
      [
        "an unknown computer outcome",
        (s: Settings) => void (s.setup.computer.outcomeUnknown = true),
      ],
    ])("refuses %s in the settings", async (_name, mutate) => {
      const f = await deepFixture();
      mutate(f.settings);
      expect(await f.run(randomUUID(), "")).toEqual(inProgress);
      expectNoSend(f);
    });

    it("refuses an uncertain connector runtime and an unheld fence", async () => {
      const f = await deepFixture();
      f.state.runtimeUncertain = true;
      expect(await f.run(randomUUID(), "")).toEqual(inProgress);
      f.state.runtimeUncertain = false;
      f.state.fenceAdmissible = false;
      expect(await f.run(randomUUID(), "")).toEqual(inProgress);
      expectNoSend(f);
    });
  });

  describe("the layout wait", () => {
    it("waits for the overlay to close and reads the live state each iteration", async () => {
      const f = await deepFixture();
      f.state.shellOverlay = "task-menu";
      const pending = f.run();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(f.send).not.toHaveBeenCalled();
      setTimeout(() => (f.state.shellOverlay = "none"), 30);
      expect(await pending).toMatchObject({
        ok: true,
        evidence: { state: "send_requested" },
      });
      expect(f.send).toHaveBeenCalledTimes(1);
    });

    it("stops waiting at the 1500 ms deadline and refuses a still-open overlay", async () => {
      const f = await deepFixture();
      vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
      f.state.shellOverlay = "task-menu";
      let settled = false;
      const pending = f.run().then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(1400);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(await pending).toEqual(inProgress);
      expectNoSend(f);
    });

    it("sees a selected task that changed while waiting", async () => {
      const f = await deepFixture();
      f.state.shellOverlay = "task-menu";
      const pending = f.run();
      await new Promise((resolve) => setTimeout(resolve, 5));
      f.state.selectedTaskId = "task-b";
      f.state.shellOverlay = "none";
      expect(await pending).toEqual(inProgress);
      expectNoSend(f);
    });

    it("stops waiting when the section leaves the browser", async () => {
      const f = await deepFixture();
      f.state.shellOverlay = "task-menu";
      const pending = f.run();
      await new Promise((resolve) => setTimeout(resolve, 5));
      f.state.section = "computer";
      expect(await pending).toEqual(inProgress);
      expectNoSend(f);
    });

    it("stops waiting when the desktop closes", async () => {
      const f = await deepFixture();
      f.state.shellOverlay = "task-menu";
      const pending = f.run();
      await new Promise((resolve) => setTimeout(resolve, 5));
      f.admission.beginQuit();
      expect(await pending).toEqual(inProgress);
      expectNoSend(f);
    });

    it("sees a home surface that closed while waiting", async () => {
      const f = await deepFixture();
      f.state.shellOverlay = "task-menu";
      const pending = f.run();
      await new Promise((resolve) => setTimeout(resolve, 5));
      f.state.browserHome = false;
      f.state.shellOverlay = "none";
      expect(await pending).toEqual(inProgress);
      expectNoSend(f);
    });

    it("refuses when the captured document changed while waiting", async () => {
      const f = await deepFixture();
      f.state.shellOverlay = "task-menu";
      const pending = f.run();
      f.state.targetValid = false;
      f.state.shellOverlay = "none";
      expect(await pending).toEqual(inProgress);
      expectNoSend(f);
    });
  });

  describe("connector verification", () => {
    it("refuses without a selected ChatGPT app", async () => {
      const f = await deepFixture();
      f.state.appName = null;
      expect(await f.run()).toEqual(notReady);
      expectNoSend(f);
    });

    it.each([
      [
        "a runtime that is not ready",
        (f: DeepFixture) =>
          void ((connector(f).runtime as { state: string }).state = "stopped"),
      ],
      [
        "no tunnel",
        (f: DeepFixture) =>
          void ((connector(f) as { tunnelId: string | null }).tunnelId = null),
      ],
      [
        "a pending app verification",
        (f: DeepFixture) =>
          void ((
            connector(f) as { appVerificationPending: boolean }
          ).appVerificationPending = true),
      ],
      [
        "a different build",
        (f: DeepFixture) =>
          void (f.state.binding = {
            buildId: "other",
            connectorGeneration: "1",
          }),
      ],
      [
        "a different connector generation",
        (f: DeepFixture) =>
          void (f.state.binding = {
            buildId: fixtureBuildId,
            connectorGeneration: "2",
          }),
      ],
    ])("refuses %s without minting a challenge", async (_name, arrange) => {
      const f = await deepFixture();
      arrange(f);
      expect(await f.run()).toEqual(notReady);
      expect(f.recordSecureMcpChallenge).not.toHaveBeenCalled();
      expectNoSend(f);
    });

    it("refuses when the challenge cannot be issued", async () => {
      const f = await deepFixture();
      f.state.attachment = null;
      expect(await f.run()).toEqual(notReady);
      expect(f.recordSecureMcpChallenge).toHaveBeenCalledTimes(1);
      expectNoSend(f);
    });

    it("refuses an issued snapshot that is not ready or carries no matching challenge", async () => {
      const f = await deepFixture();
      f.state.attachment = null;
      f.recordSecureMcpChallenge.mockResolvedValueOnce({
        ok: true,
        snapshot: { status: "error" },
      });
      expect(await f.run()).toEqual(notReady);
      f.recordSecureMcpChallenge.mockResolvedValueOnce({
        ok: true,
        snapshot: { status: "ready", settings: f.settings },
      });
      expect(await f.run()).toEqual(notReady);
      expectNoSend(f);
    });

    it("mints the one-time challenge and binds the check to it", async () => {
      const f = await deepFixture();
      f.state.attachment = null;
      const runtime = connector(f).runtime!;
      const issuedSettings = {
        ...f.settings,
        connectors: {
          ...f.settings.connectors,
          secureMcp: {
            ...connector(f),
            challenge: {
              value: "challenge-value",
              challengeSha256: "e".repeat(64),
              runtimeGeneration: runtime.runtimeGeneration,
              computerGeneration: runtime.computerGeneration,
              buildId: runtime.buildId,
              preparedAt: "2026-11-24T10:00:00.000Z",
            },
            attachment: null,
          },
        },
      };
      f.recordSecureMcpChallenge.mockResolvedValueOnce({
        ok: true,
        snapshot: { status: "ready", settings: issuedSettings },
      });
      expect(await f.run()).toMatchObject({ ok: true });
      expect(f.recordSecureMcpChallenge).toHaveBeenCalledWith({
        challenge: expect.any(String),
        runtimeGeneration: runtime.runtimeGeneration,
        computerGeneration: runtime.computerGeneration,
        buildId: runtime.buildId,
      });
      expect(f.bindingCurrent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          challengeSha256: "e".repeat(64),
          tunnelId: "tunnel_ui_fixture",
          appName: "Farol",
        }),
      );
      expect(f.send).toHaveBeenCalledTimes(1);
    });

    it("binds the attachment's workspace, else the verified one", async () => {
      const f = await deepFixture();
      f.state.attachment = {
        challengeSha256: "c".repeat(64),
        workspaceId: "attached-workspace",
      };
      await f.run();
      expect(f.bindingCurrent).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ workspaceId: "attached-workspace" }),
      );
      const g = await deepFixture();
      g.state.attachment = {
        challengeSha256: "c".repeat(64),
        workspaceId: null,
      };
      g.state.workspaceSelection = undefined;
      await g.run();
      expect(g.bindingCurrent).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ workspaceId: fixtureWorkspaceId }),
      );
    });
  });

  describe("journal and dispatch order", () => {
    it("prepares, marks intent, then retains the result, each under the promotion lease", async () => {
      const f = await deepFixture();
      const id = randomUUID();
      const seen: (string | null)[] = [];
      f.route.runReadonlyTask.mockImplementationOnce(
        async (_p, _a, observer) => {
          seen.push(await phase(f, id));
          await (observer as DeepObserver).onDispatchIntent();
          seen.push(await phase(f, id));
          return sendRequested;
        },
      );
      expect(await phase(f, id)).toBeNull();
      expect(await f.run(id)).toMatchObject({ ok: true });
      seen.push(await phase(f, id));
      expect(seen).toEqual(["prepared", "dispatch_intent", "result_retained"]);
      expect(f.events).toEqual(["lease", "lease"]);
    });

    it("refuses before preparing when the promotion lease is held", async () => {
      const f = await deepFixture();
      const id = randomUUID();
      f.state.leaseRefused = true;
      expect(await f.run(id)).toEqual(journalFailed);
      expect(await phase(f, id)).toBeNull();
      expect(f.state.recoveryReady).toBe(true);
      expectNoSend(f);
      expect(f.admission.occupied("chatgpt-task")).toBe(false);
      expect(f.admission.occupied("connector-task")).toBe(false);
    });

    it("refuses before preparing when the binding changed after admission", async () => {
      const f = await deepFixture();
      const id = randomUUID();
      f.state.bindingCurrent = false;
      expect(await f.run(id)).toEqual(journalFailed);
      expect(await phase(f, id)).toBeNull();
      expectNoSend(f);
    });

    it("keeps a known pre-submit refusal without claiming an intent", async () => {
      const f = await deepFixture();
      const id = randomUUID();
      f.route.runReadonlyTask.mockImplementationOnce(async () => ({
        state: "failed_before_submit",
        code: "CHATGPT_COMPOSER_DRAFT_PRESENT",
        deltaCount: 0,
        observedCharacters: 0,
      }));
      expect(await f.run(id)).toMatchObject({
        ok: true,
        evidence: {
          state: "failed_before_submit",
          code: "CHATGPT_COMPOSER_DRAFT_PRESENT",
        },
      });
      expect(await f.journal(id).load()).toMatchObject({
        phase: "result_retained",
        result: { state: "failed_before_submit" },
      });
      expect(f.events).toEqual(["lease"]);
    });

    it("retains a refusal after intent when the binding changes before the click", async () => {
      const f = await deepFixture();
      const id = randomUUID();
      f.route.runReadonlyTask.mockImplementationOnce(
        async (_p, _a, observer) => {
          await (observer as DeepObserver).onDispatchIntent();
          f.state.bindingCurrent = false;
          expect((observer as DeepObserver).beforeSend()).toBe(false);
          return {
            state: "failed_before_submit",
            code: "CHATGPT_SUBMIT_UNAVAILABLE",
            deltaCount: 0,
            observedCharacters: 0,
          } satisfies DeepRouteResult;
        },
      );
      expect(await f.run(id)).toMatchObject({
        ok: true,
        evidence: { state: "failed_before_submit" },
      });
      expect(f.send).not.toHaveBeenCalled();
      expect(await f.journal(id).load()).toMatchObject({
        phase: "result_retained",
      });
      expect(f.events).toEqual(["lease", "lease"]);
    });

    it("refuses the dispatch intent when the state changed after preparation", async () => {
      const f = await deepFixture();
      const id = randomUUID();
      f.route.runReadonlyTask.mockImplementationOnce(
        async (_p, _a, observer) => {
          f.state.shellOverlay = "task-menu";
          await (observer as DeepObserver).onDispatchIntent();
          return sendRequested;
        },
      );
      expect(await f.run(id)).toEqual({
        ok: false,
        error: "CHATGPT_CONVERSATION_UNCONFIRMED",
      });
      expect(await phase(f, id)).toBe("prepared");
      expect(f.state.recoveryReady).toBe(false);
      expect(f.send).not.toHaveBeenCalled();
      expect(f.admission.occupied("chatgpt-task")).toBe(false);
    });

    it("retains an unknown outcome and never re-sends the same operation", async () => {
      const f = await deepFixture();
      const id = randomUUID();
      f.route.runReadonlyTask.mockImplementationOnce(
        async (_p, _a, observer) => {
          await (observer as DeepObserver).onDispatchIntent();
          return {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_ERROR",
            deltaCount: 0,
            observedCharacters: 0,
          };
        },
      );
      expect(await f.run(id)).toMatchObject({
        ok: true,
        evidence: { state: "outcome_unknown", code: "CHATGPT_TASK_ERROR" },
      });
      expect(await f.journal(id).load()).toMatchObject({
        phase: "result_retained",
        result: { state: "outcome_unknown" },
      });
      expect(await f.run(id)).toEqual(journalFailed);
      expect(f.route.runReadonlyTask).toHaveBeenCalledTimes(1);
      expect(await f.journal(id).load()).toMatchObject({
        result: { state: "outcome_unknown" },
      });
    });

    it("stops the module after a failure behind a prepared journal", async () => {
      const f = await deepFixture();
      const id = randomUUID();
      f.route.runReadonlyTask.mockRejectedValueOnce(new Error("route failed"));
      expect(await f.run(id)).toEqual({
        ok: false,
        error: "CHATGPT_CONVERSATION_UNCONFIRMED",
      });
      expect(f.state.recoveryReady).toBe(false);
      expect(await phase(f, id)).toBe("prepared");
      expect(f.admission.occupied("chatgpt-task")).toBe(false);
      expect(f.admission.occupied("connector-task")).toBe(false);
      expect(await f.run()).toEqual(inProgress);
      expect(f.route.runReadonlyTask).toHaveBeenCalledTimes(1);
    });
  });
});

describe("deepTestStatus", () => {
  it("fails without an owner or while recovery is not ready", async () => {
    const f = await deepFixture();
    f.state.recoveryReady = false;
    expect(f.deep.deepTestStatus()).toEqual(journalFailed);
    const g = await deepFixture();
    g.state.owner = null;
    expect(g.deep.deepTestStatus()).toEqual(journalFailed);
  });

  it("lists only attempts whose result is retained", async () => {
    const f = await deepFixture();
    const id = randomUUID();
    await f.run(id);
    const retained = f.state.recoverable[0]!;
    f.state.recoverable = [
      retained,
      { ...retained, operationId: randomUUID(), phase: "dispatch_intent" },
      { ...retained, operationId: randomUUID(), result: null },
    ];
    expect(f.deep.deepTestStatus()).toMatchObject({
      ok: true,
      evidence: {
        kind: "chatgpt.deep-test-status",
        attempts: [{ operationId: id, state: "send_requested", code: null }],
      },
    });
  });
});

describe("acknowledgeDeepTest", () => {
  it.each([
    [
      "a chat task",
      (f: DeepFixture) => f.admission.reserveAdmitted("chatgpt-task"),
    ],
    [
      "a connector task",
      (f: DeepFixture) => f.admission.reserveAdmitted("connector-task"),
    ],
    [
      "unready recovery",
      (f: DeepFixture) => void (f.state.recoveryReady = false),
    ],
  ])("refuses while %s is active", async (_name, arrange) => {
    const f = await deepFixture();
    const id = randomUUID();
    await f.run(id);
    arrange(f);
    expect(await f.deep.acknowledgeDeepTest(id)).toEqual(inProgress);
    expect(await phase(f, id)).toBe("result_retained");
  });

  it("reports an unknown or not-retained attempt as not found", async () => {
    const f = await deepFixture();
    const id = randomUUID();
    await f.run(id);
    expect(await f.deep.acknowledgeDeepTest(randomUUID())).toEqual({
      ok: false,
      error: "CHATGPT_TASK_RESULT_NOT_FOUND",
    });
    f.state.recoverable = f.state.recoverable.map((record) => ({
      ...record,
      phase: "dispatch_intent" as const,
    }));
    expect(await f.deep.acknowledgeDeepTest(id)).toEqual({
      ok: false,
      error: "CHATGPT_TASK_RESULT_NOT_FOUND",
    });
  });

  it("acknowledges delivery, drops the record and returns the status", async () => {
    const f = await deepFixture();
    const first = randomUUID();
    await f.run(first);
    f.events.length = 0;
    const result = await f.deep.acknowledgeDeepTest(first);
    expect(result).toMatchObject({
      ok: true,
      evidence: { kind: "chatgpt.deep-test-status", attempts: [] },
    });
    expect(f.events).toEqual(["lease"]);
    expect(await phase(f, first)).toBe("delivery_acknowledged");
    expect(f.state.recoverable).toEqual([]);
  });

  it("stops recovery when the acknowledgement cannot be written", async () => {
    const f = await deepFixture();
    const id = randomUUID();
    await f.run(id);
    f.state.leaseRefused = true;
    expect(await f.deep.acknowledgeDeepTest(id)).toEqual({
      ok: false,
      error: "CHATGPT_CONVERSATION_UNCONFIRMED",
    });
    expect(f.state.recoveryReady).toBe(false);
    expect(await phase(f, id)).toBe("result_retained");
    expect(f.state.recoverable).toHaveLength(1);
  });
});
