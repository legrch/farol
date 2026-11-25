import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { confirmSeparateAppVerificationAttempt } from "../../../src/apps/desktop/connector-app-verification-attempt";
import { connectorVerificationProof } from "../../../src/apps/desktop/connector-verification-proof";
import { channels } from "../../../src/pkg/ipc/channels";
import {
  fixtureBuildId,
  fixtureWorkspaceId,
  guidedSettingsFixture,
} from "../../../tests/fixtures/guided-onboarding";
import { DesktopAdmission } from "../host/admission";
import { createConnectorVerify, type ConnectorVerifyPorts } from "./verify";

// The verification sequence over scripted owners. Every port reads `state` when
// it is called, so a test changes one field and the next read sees it. One
// ordered log records each effect, so a test can assert refusal order and call
// order together. No window, Go core, ChatGPT page, settings store or file runs.
// The single ChatGPT message is `send`: every refusal test asserts it was never
// called.
const challengeSha256 = "c".repeat(64);
const runtimeGeneration = "b".repeat(64);
const connectorMessages = [
  "CHATGPT_APP_SELECTION_MISSING",
  "CHATGPT_APP_SELECTION_AMBIGUOUS",
  "CHATGPT_APP_SELECTION_CONFLICT",
  "CHATGPT_APP_SELECTION_LOST",
  "CHATGPT_COMPOSER_DRAFT_PRESENT",
  "CHATGPT_TEMPORARY_CHAT_REQUIRED",
  "CHATGPT_INSTANT_MODEL_REQUIRED",
] as const;

afterEach(() => vi.restoreAllMocks());

type Options = Readonly<{ attached?: boolean }>;

function build(options: Options = {}) {
  const settings = guidedSettingsFixture();
  const connector = settings.connectors.secureMcp;
  const attachment = connector.attachment;
  connector.attachment = null;
  connector.appVerificationPending = true;
  connector.chatgptApp = {
    name: "Farol Dev",
    tunnelId: connector.tunnelId!,
    connectorGeneration: 1,
  };
  connector.challenge = {
    value: "00000000-0000-4000-8000-000000000003",
    challengeSha256,
    runtimeGeneration,
    computerGeneration: 1,
    buildId: fixtureBuildId,
    preparedAt: "2026-01-01T00:00:00.000Z",
  };
  settings.setup.connect.outcomeUnknown = true;
  if (options.attached) {
    connector.attachment = attachment;
    connector.challenge = null;
    connector.appVerificationPending = false;
    settings.setup.connect.outcomeUnknown = false;
  }
  const expected = {
    ownerAuthorized: true as const,
    appName: "Farol Dev",
    tunnelId: connector.tunnelId!,
    connectorGeneration: 1,
    computerGeneration: 1,
    runtimeGeneration,
    buildId: fixtureBuildId,
    workspaceId: fixtureWorkspaceId,
    challengeSha256,
  };
  const binding = {
    buildId: fixtureBuildId,
    profileId: "profile",
    backendGeneration: "backend",
    runtimeId: "runtime",
    connectorGeneration: "1",
  };
  const events: string[] = [];
  const state = {
    settings,
    status: "ready" as "ready" | "error",
    sent: false,
    observeError: null as unknown,
    preflight: { ready: true } as
      { ready: true } | { ready: false; stage: string },
    attemptExists: false as boolean | "throw",
    routeResult: { state: "receipt_confirmed" } as {
      state: string;
      code?: string;
    },
    confirm: 1,
    waitResult: "read" as "read" | "throw" | "null",
    checked: { ok: true, evidence: "checked" } as unknown,
    uuid: "00000000-0000-4000-8000-0000000000aa",
    taskId: "",
    embedded: true,
    ready: true,
    env: {} as Record<string, string | undefined>,
    stderr: [] as string[],
  };
  const snapshot = () =>
    state.status === "ready"
      ? { status: "ready" as const, settings: state.settings }
      : { status: "error" as const, error: "SETTINGS_READ_FAILED" };
  const makeConfiguration = () => ({
    snapshot: vi.fn(snapshot),
    recordSecureMcpAppPending: vi.fn(async (generation: string) => {
      events.push(`pending:${generation}`);
      return { ok: true };
    }),
    clearSecureMcpAppPendingBeforeSubmit: vi.fn(async () => {
      events.push("clear-pending");
      return { ok: true };
    }),
  });
  const owner = {
    configuration: makeConfiguration() as ReturnType<
      typeof makeConfiguration
    > | null,
  };
  const send = vi.fn();
  const makeRoute = () => ({
    loadState: vi.fn(() => "loaded" as const),
    runReadonlyTask: vi.fn(
      async (
        prompt: string,
        files: unknown[],
        hooks: {
          onDispatchIntent?: () => Promise<void>;
          readConnectorReceipt?: () => Promise<boolean>;
        },
        profile: string,
        target: { name: string },
      ) => {
        events.push(`route:${profile}:${target.name}`);
        expect(files).toEqual([]);
        void prompt;
        try {
          await hooks.onDispatchIntent?.();
        } catch {
          // The route reports a refused dispatch as a failure before submit.
          return { state: "failed_before_submit", code: "DISPATCH_REFUSED" };
        }
        if (state.routeResult.state === "receipt_confirmed") {
          send();
          state.sent = true;
        }
        return state.routeResult;
      },
    ),
  });
  const live = {
    route: makeRoute() as ReturnType<typeof makeRoute> | null,
    core: {
      observeComputerConnectorVerification: vi.fn(async () => {
        events.push("observe");
        if (state.observeError) throw state.observeError;
        return state.sent
          ? {
              binding,
              receipt: {
                challengeSha256,
                workspaceId: fixtureWorkspaceId,
                binding,
              },
            }
          : { binding };
      }),
    } as {
      observeComputerConnectorVerification: ReturnType<typeof vi.fn>;
    } | null,
    runtime: { isRunning: vi.fn(() => true) } as {
      isRunning: () => boolean;
    } | null,
    window: {
      isDestroyed: vi.fn(() => false),
      webContents: {
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      },
    } as {
      isDestroyed: Mock<() => boolean>;
      webContents: {
        isDestroyed: Mock<() => boolean>;
        send: ReturnType<typeof vi.fn>;
      };
    } | null,
  };
  const admission = new DesktopAdmission({
    chatGptReadonlyTask: () => false,
    directChatStart: () => false,
    chatGptAttachmentTask: () => false,
    workspaceEdit: () => false,
    computer: () => false,
    codexAgent: () => false,
    hostCheck: () => false,
    connectorStart: () => false,
  });
  const reserved: string[] = [];
  const reserveAdmitted = admission.reserveAdmitted.bind(admission);
  vi.spyOn(admission, "reserveAdmitted").mockImplementation((kind, purpose) => {
    reserved.push(kind);
    return reserveAdmitted(kind, purpose);
  });
  const showMessageBox = vi.fn(async (_owner: unknown, _options: unknown) => {
    events.push("dialog");
    return { response: state.confirm };
  });
  const check = {
    testConnectionCommand: vi.fn(async (..._args: unknown[]) => state.checked),
    checkSecureMcpAttachment: vi.fn(async (..._args: unknown[]) => {
      events.push("attachment-check");
      return state.checked;
    }),
  };
  const sample = vi.fn(async () => ({ sampled: true }));
  const status = vi.fn();
  const prepareAttempt = vi.fn(
    async (
      root: string,
      sha: string,
      record: () => Promise<boolean>,
      separate?: unknown,
    ) => {
      events.push("attempt");
      void root;
      void separate;
      expect(sha).toBe(challengeSha256);
      await record();
    },
  );
  const ports = {
    configuration: () => owner.configuration,
    chatGptRoute: () => live.route,
    secureMcpConnectorRuntime: () => live.runtime,
    desktopGoCore: () => live.core,
    window: () => live.window,
    selectedTaskId: () => state.taskId,
    desktopAdmission: admission,
    buildIdentity: { buildId: fixtureBuildId },
    runtimeEnvironment: "test",
    env: state.env,
    pid: 4242,
    writeStderr: (text: string) => {
      state.stderr.push(text);
    },
    randomUUID: () => state.uuid,
    statePaths: () => ({ secureMcpLaunch: "/synthetic-no-filesystem" }),
    configurationFailure: (error: string) => ({ ok: false, error }),
    embeddedBrowserEnabled: () => state.embedded,
    chatGptTaskAdmissionReady: () => state.ready,
    showMessageBox,
    connectorCheck: () => check,
    connectorConnection: { sample },
    currentConnectionStatus: status,
    connectorVerificationProof,
    connectorAppVerificationAttemptExists: vi.fn(async () => {
      events.push("attempt-exists");
      if (state.attemptExists === "throw") throw new Error("unreadable");
      return state.attemptExists;
    }),
    confirmSeparateAppVerificationAttempt,
    prepareConnectorAppVerificationAttempt: prepareAttempt,
    prepareConnectorCheckDocument: vi.fn(
      async (_route: unknown, current: () => boolean) => {
        events.push(`document:${current()}`);
        return state.preflight;
      },
    ),
    waitForConnectorAppReceipt: vi.fn(
      async (
        read: () => Promise<unknown>,
        matches: (probe: never) => boolean,
      ) => {
        events.push("wait");
        if (state.waitResult === "throw") throw new Error("unreadable");
        if (state.waitResult === "null") return null;
        const probe = await read();
        return probe !== null && matches(probe as never) ? probe : probe;
      },
    ),
  };
  const verify = createConnectorVerify(
    ports as unknown as ConnectorVerifyPorts,
  );
  return {
    ...verify,
    ports,
    state,
    settings,
    connector,
    expected,
    binding,
    events,
    owner,
    live,
    admission,
    reserved,
    send,
    check,
    sample,
    status,
    showMessageBox,
    prepareAttempt,
    makeRoute,
    makeConfiguration,
    snapshot,
  };
}

type Built = ReturnType<typeof build>;
const free = (f: Built) =>
  expect([
    f.admission.occupied("chatgpt-task"),
    f.admission.occupied("connector-task"),
  ]).toEqual([false, false]);

describe("refusals before any ChatGPT message", () => {
  const refusals: ReadonlyArray<readonly [string, string, (f: Built) => void]> =
    [
      [
        "the embedded browser is unavailable",
        "CONNECTOR_APP_VERIFICATION_UNAVAILABLE",
        (f) => {
          f.state.embedded = false;
        },
      ],
      [
        "settings are not built",
        "SETTINGS_UNAVAILABLE",
        (f) => {
          f.owner.configuration = null;
        },
      ],
      [
        "the ChatGPT route is not built",
        "SETTINGS_UNAVAILABLE",
        (f) => {
          f.live.route = null;
        },
      ],
      [
        "the connector runtime is not built",
        "SETTINGS_UNAVAILABLE",
        (f) => {
          f.live.runtime = null;
        },
      ],
      [
        "a ChatGPT task is running",
        "CHATGPT_TASK_IN_PROGRESS",
        (f) => {
          f.admission.reserveAdmitted("chatgpt-task");
        },
      ],
      [
        "a connector task is running",
        "CHATGPT_TASK_IN_PROGRESS",
        (f) => {
          f.admission.reserveAdmitted("connector-task");
        },
      ],
      [
        "the Go core is not built",
        "CONNECTOR_APP_VERIFICATION_NOT_READY",
        (f) => {
          f.live.core = null;
        },
      ],
      [
        "settings cannot be read once both routes are held",
        "SETTINGS_UNAVAILABLE",
        (f) => {
          let reads = 0;
          f.owner.configuration!.snapshot.mockImplementation(() =>
            ++reads === 1
              ? f.snapshot()
              : { status: "error" as const, error: "SETTINGS_READ_FAILED" },
          );
          f.state.status = "ready";
        },
      ],
      [
        "no ChatGPT app is selected",
        "CONNECTOR_APP_TARGET_REQUIRED",
        (f) => {
          f.connector.chatgptApp = null;
        },
      ],
      [
        "task admission is not ready",
        "CONNECTOR_APP_VERIFICATION_NOT_READY",
        (f) => {
          f.state.ready = false;
        },
      ],
      [
        "the connector is not running",
        "CONNECTOR_APP_VERIFICATION_NOT_READY",
        (f) => {
          f.live.runtime = { isRunning: () => false };
        },
      ],
      [
        "the runtime was built for another generation",
        "CONNECTOR_APP_VERIFICATION_NOT_READY",
        (f) => {
          f.connector.runtime!.runtimeGeneration = "f".repeat(64);
        },
      ],
      [
        "there is no challenge",
        "CONNECTOR_APP_VERIFICATION_NOT_READY",
        (f) => {
          f.connector.challenge = null;
        },
      ],
      [
        "the earlier outcome is unknown",
        "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
        () => {},
      ],
      [
        "the one attempt was already made",
        "CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED",
        (f) => {
          f.state.attemptExists = true;
          f.settings.setup.connect.outcomeUnknown = false;
        },
      ],
      [
        "the attempt record cannot be read",
        "CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE",
        (f) => {
          f.state.attemptExists = "throw";
          f.settings.setup.connect.outcomeUnknown = false;
        },
      ],
      [
        "the browser document is not ready",
        "CONNECTOR_APP_VERIFICATION_NOT_READY",
        (f) => {
          f.state.preflight = { ready: false, stage: "initial-readiness" };
          f.settings.setup.connect.outcomeUnknown = false;
        },
      ],
    ];

  it.each(refusals)(
    "refuses when %s with %s, sends nothing and releases both routes",
    async (_name, code, arrange) => {
      const f = build();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = f.owner.configuration!;
      const route = f.live.route!;
      arrange(f);
      const result = await f.verifySecureMcpApp();
      expect(result).toMatchObject({ ok: false, error: code });
      expect(f.send).not.toHaveBeenCalled();
      expect(route.runReadonlyTask).not.toHaveBeenCalled();
      expect(f.showMessageBox).not.toHaveBeenCalled();
      expect(service.recordSecureMcpAppPending).not.toHaveBeenCalled();
      expect(f.prepareAttempt).not.toHaveBeenCalled();
      if (code !== "CHATGPT_TASK_IN_PROGRESS") free(f);
    },
  );

  it("warns with the preflight stage and nothing else when the document is not ready", async () => {
    const f = build();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.settings.setup.connect.outcomeUnknown = false;
    f.state.preflight = { ready: false, stage: "temporary-navigation" };
    await f.verifySecureMcpApp();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `FAROL_CONNECTOR_CHECK_PREFLIGHT:${JSON.stringify({ schema: 1, stage: "temporary-navigation" })}`,
    );
  });

  it("refuses a closed desktop only after both routes are reserved", async () => {
    const f = build();
    f.admission.beginQuit();
    expect(await f.verifySecureMcpApp()).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_NOT_READY",
    });
    expect(f.reserved).toEqual(["chatgpt-task", "connector-task"]);
    expect(f.send).not.toHaveBeenCalled();
    free(f);
  });

  it("reserves the two routes in order, before the first await", async () => {
    const f = build();
    f.settings.setup.connect.outcomeUnknown = false;
    const pending = f.verifySecureMcpApp();
    // Both are held by the time the first await (the attempt record) starts.
    expect(f.reserved).toEqual(["chatgpt-task", "connector-task"]);
    expect(f.events).toEqual(["attempt-exists"]);
    await pending;
  });
});

describe("the separate-app check", () => {
  it("refuses a scope that is not current before it asks Go anything", async () => {
    const f = build();
    expect(
      await f.verifySecureMcpApp({ ...f.expected, connectorGeneration: 9 }),
    ).toMatchObject({ error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED" });
    expect(f.events).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([
    ["a receipt", { receipt: {} }],
    ["a catalogue receipt", { catalogueReceipt: {} }],
    ["a receipt digest", { receiptSha256: "d".repeat(64) }],
  ])("refuses when Go already holds %s", async (_name, extra) => {
    const f = build();
    f.live.core!.observeComputerConnectorVerification.mockResolvedValue({
      binding: f.binding,
      ...extra,
    });
    expect(await f.verifySecureMcpApp(f.expected)).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED",
    });
    expect(f.showMessageBox).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("refuses without a window to ask the owner in", async () => {
    const f = build();
    f.live.window = null;
    expect(await f.verifySecureMcpApp(f.expected)).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_OWNER_CONSENT_REQUIRED",
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("refuses a destroyed window the same way", async () => {
    const f = build();
    f.live.window!.isDestroyed.mockReturnValue(true);
    expect(await f.verifySecureMcpApp(f.expected)).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_OWNER_CONSENT_REQUIRED",
    });
  });

  it("asks the owner in the native dialog, which defaults to Cancel, and refuses a Cancel", async () => {
    const f = build();
    f.state.confirm = 0;
    expect(await f.verifySecureMcpApp(f.expected)).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_OWNER_CONSENT_REQUIRED",
    });
    expect(f.showMessageBox).toHaveBeenCalledTimes(1);
    expect(f.showMessageBox.mock.calls[0]?.[0]).toBe(f.live.window);
    expect(f.showMessageBox.mock.calls[0]?.[1]).toMatchObject({
      type: "question",
      buttons: ["Cancel", "Test in ChatGPT"],
      defaultId: 0,
      cancelId: 0,
      message: "Test this connection in ChatGPT?",
      detail: expect.stringContaining("Farol Dev"),
    });
    expect(f.send).not.toHaveBeenCalled();
    free(f);
  });

  it("maps an unreadable Go observation to unavailable state", async () => {
    const f = build();
    f.state.observeError = new Error("closed");
    expect(await f.verifySecureMcpApp(f.expected)).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE",
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("claims, sends once and publishes the attachment check after owner consent", async () => {
    const f = build();
    expect(await f.verifySecureMcpApp(f.expected)).toEqual(f.state.checked);
    expect(f.events).toEqual([
      "observe",
      "dialog",
      "observe",
      "attempt-exists",
      "document:true",
      "route:temporary-instant:Farol Dev",
      `attempt`,
      `pending:${runtimeGeneration}`,
      "wait",
      "observe",
      "attachment-check",
    ]);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.check.checkSecureMcpAttachment).toHaveBeenCalledExactlyOnceWith(
      fixtureWorkspaceId,
      expect.objectContaining({
        challengeSha256,
        workspaceId: fixtureWorkspaceId,
        appName: "Farol Dev",
        buildId: fixtureBuildId,
      }),
    );
    free(f);
  });

  it("keeps the earlier unknown outcome for a legacy Test, with no dialog", async () => {
    const f = build();
    expect(await f.verifySecureMcpApp()).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
    });
    expect(f.showMessageBox).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe("a check that is already attached", () => {
  it("goes to the explicit connection check with the selected task read at the call", async () => {
    const f = build({ attached: true });
    f.state.taskId = "task-7";
    expect(await f.verifySecureMcpApp()).toEqual(f.state.checked);
    expect(f.check.testConnectionCommand).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "connector.test-connection",
        operationId: f.state.uuid,
        taskId: "task-7",
      },
      "setup",
    );
    expect(f.reserved).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
    expect(
      f.owner.configuration?.recordSecureMcpAppPending,
    ).not.toHaveBeenCalled();
  });

  it("is not taken for a separate check", async () => {
    const f = build({ attached: true });
    expect(await f.verifySecureMcpApp(f.expected)).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_NOT_READY",
    });
    expect(f.check.testConnectionCommand).not.toHaveBeenCalled();
  });
});

describe("the claim and the single message", () => {
  const fresh = () => {
    const f = build();
    f.settings.setup.connect.outcomeUnknown = false;
    return f;
  };

  it("sends one message, naming the app, the challenge and the workspace", async () => {
    const f = fresh();
    await f.verifySecureMcpApp();
    const [prompt] = f.live.route!.runReadonlyTask.mock.calls[0]!;
    expect(prompt).toBe(
      `Use the selected Farol Dev app to call farol_connector_verify once with challenge "00000000-0000-4000-8000-000000000003" and workspaceId "${fixtureWorkspaceId}". Do not read file contents. Reply briefly with the result.`,
    );
    expect(f.live.route!.runReadonlyTask).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("verifies the catalogue when no workspace is configured", async () => {
    const f = fresh();
    f.settings.computer.workspaces = [];
    f.live.core!.observeComputerConnectorVerification.mockImplementation(
      async () =>
        f.state.sent
          ? {
              binding: f.binding,
              catalogueReceipt: {
                challengeSha256,
                workspaceCount: 0,
                binding: f.binding,
              },
            }
          : { binding: f.binding },
    );
    await f.verifySecureMcpApp();
    const [prompt] = f.live.route!.runReadonlyTask.mock.calls[0]!;
    expect(prompt).toBe(
      'Use the selected Farol Dev app to call farol_connector_verify_catalogue once with challenge "00000000-0000-4000-8000-000000000003". No workspace is configured. Do not read files or run commands. Reply briefly with the result.',
    );
  });

  it("records the pending evidence once, through the attempt, before the message", async () => {
    const f = fresh();
    await f.verifySecureMcpApp();
    expect(
      f.owner.configuration!.recordSecureMcpAppPending,
    ).toHaveBeenCalledExactlyOnceWith(runtimeGeneration);
    expect(f.prepareAttempt).toHaveBeenCalledTimes(1);
    expect(f.prepareAttempt.mock.calls[0]?.[0]).toBe(
      "/synthetic-no-filesystem",
    );
    expect(f.events.indexOf("attempt")).toBeLessThan(
      f.events.indexOf(`pending:${runtimeGeneration}`),
    );
  });

  it("does not claim, and so does not send, when the binding moves before dispatch", async () => {
    const f = fresh();
    f.live.route!.runReadonlyTask.mockImplementation(
      async (_prompt, _files, hooks) => {
        f.connector.generation++;
        await expect(hooks.onDispatchIntent?.()).rejects.toThrow(
          "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
        );
        return { state: "failed_before_submit", code: "SOMETHING" };
      },
    );
    expect(await f.verifySecureMcpApp()).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
    });
    expect(f.prepareAttempt).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("refuses to dispatch once the desktop is closed", async () => {
    const f = fresh();
    f.live.route!.runReadonlyTask.mockImplementation(
      async (_prompt, _files, hooks) => {
        f.admission.beginQuit();
        await expect(hooks.onDispatchIntent?.()).rejects.toThrow(
          "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
        );
        return { state: "failed_before_submit", code: "X" };
      },
    );
    await f.verifySecureMcpApp();
    expect(f.prepareAttempt).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("claims only once however many times dispatch is announced", async () => {
    const f = fresh();
    f.live.route!.runReadonlyTask.mockImplementation(
      async (_prompt, _files, hooks) => {
        await hooks.onDispatchIntent?.();
        await hooks.onDispatchIntent?.();
        f.send();
        f.state.sent = true;
        return { state: "receipt_confirmed" };
      },
    );
    await f.verifySecureMcpApp();
    expect(f.prepareAttempt).toHaveBeenCalledTimes(1);
  });

  it.each(connectorMessages)(
    "passes the pre-submit refusal %s through",
    async (code) => {
      const f = fresh();
      f.state.routeResult = { state: "failed_before_submit", code };
      expect(await f.verifySecureMcpApp()).toMatchObject({ error: code });
      expect(f.send).not.toHaveBeenCalled();
    },
  );

  it.each(["failed_before_submit", "not_authenticated"])(
    "names any other %s refusal as before-submit and leaves the outcome fence",
    async (kind) => {
      const f = fresh();
      f.state.routeResult = { state: kind, code: "CHATGPT_SOMETHING_ELSE" };
      expect(await f.verifySecureMcpApp()).toMatchObject({
        error: "CONNECTOR_APP_VERIFICATION_BEFORE_SUBMIT_FAILED",
      });
      expect(f.send).not.toHaveBeenCalled();
      expect(
        f.owner.configuration!.clearSecureMcpAppPendingBeforeSubmit,
      ).not.toHaveBeenCalled();
    },
  );

  it("withdraws its own pending evidence after a refusal before submit", async () => {
    const f = fresh();
    f.settings.setup.connect.outcomeUnknown = true;
    f.settings.setup.connect.outcomeUnknown = false;
    f.state.routeResult = { state: "failed_before_submit", code: "X" };
    f.live.route!.runReadonlyTask.mockImplementation(
      async (_prompt, _files, hooks) => {
        await hooks.onDispatchIntent?.();
        f.settings.setup.connect.outcomeUnknown = true;
        return { state: "failed_before_submit", code: "X" };
      },
    );
    await f.verifySecureMcpApp();
    expect(
      f.owner.configuration!.clearSecureMcpAppPendingBeforeSubmit,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        challengeSha256,
        workspaceId: fixtureWorkspaceId,
      }),
    );
  });

  it("keeps the unknown outcome when that withdrawal is refused", async () => {
    const f = fresh();
    f.live.route!.runReadonlyTask.mockImplementation(
      async (_prompt, _files, hooks) => {
        await hooks.onDispatchIntent?.();
        f.settings.setup.connect.outcomeUnknown = true;
        return { state: "failed_before_submit", code: "X" };
      },
    );
    f.owner.configuration!.clearSecureMcpAppPendingBeforeSubmit.mockResolvedValue(
      { ok: false },
    );
    expect(await f.verifySecureMcpApp()).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
    });
  });

  it("answers a pre-submit refusal after the binding moved with changed state", async () => {
    const f = fresh();
    f.live.route!.runReadonlyTask.mockImplementation(async () => {
      f.connector.generation++;
      return { state: "failed_before_submit", code: "X" };
    });
    expect(await f.verifySecureMcpApp()).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
    });
  });

  it.each([
    ["outcome_unknown", "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN"],
    ["completed", "CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE"],
  ])("answers an unclaimed %s with %s", async (kind, code) => {
    const f = fresh();
    f.live.route!.runReadonlyTask.mockImplementation(async () => ({
      state: kind,
    }));
    expect(await f.verifySecureMcpApp()).toMatchObject({ error: code });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("answers changed state when the binding moves after the claim", async () => {
    const f = fresh();
    f.live.route!.runReadonlyTask.mockImplementation(
      async (_prompt, _files, hooks) => {
        await hooks.onDispatchIntent?.();
        f.send();
        f.connector.generation++;
        return { state: "receipt_confirmed" };
      },
    );
    expect(await f.verifySecureMcpApp()).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
    });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.check.checkSecureMcpAttachment).not.toHaveBeenCalled();
  });

  it("never sends a second message while it waits for the receipt", async () => {
    const f = fresh();
    f.state.waitResult = "null";
    expect(await f.verifySecureMcpApp()).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
    });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.live.route!.runReadonlyTask).toHaveBeenCalledTimes(1);
  });

  it("answers an unreadable receipt wait as an unknown outcome", async () => {
    const f = fresh();
    f.state.waitResult = "throw";
    expect(await f.verifySecureMcpApp()).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
    });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("answers changed state when the binding moves while the receipt is awaited", async () => {
    const f = fresh();
    f.ports.waitForConnectorAppReceipt.mockImplementation(async (read) => {
      f.connector.generation++;
      return read();
    });
    expect(await f.verifySecureMcpApp()).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
    });
    expect(f.check.checkSecureMcpAttachment).not.toHaveBeenCalled();
  });

  it("is only read as the receipt of this challenge and workspace", async () => {
    const f = fresh();
    let matches!: (probe: never) => boolean;
    f.ports.waitForConnectorAppReceipt.mockImplementation(async (read, m) => {
      matches = m;
      return read();
    });
    await f.verifySecureMcpApp();
    expect(
      matches({
        state: "receipt",
        challengeSha256,
        workspaceId: fixtureWorkspaceId,
      } as never),
    ).toBe(true);
    expect(
      matches({
        state: "receipt",
        challengeSha256: "e".repeat(64),
        workspaceId: fixtureWorkspaceId,
      } as never),
    ).toBe(false);
    expect(
      matches({
        state: "receipt",
        challengeSha256,
        workspaceId: null,
      } as never),
    ).toBe(false);
    expect(matches({ state: "changed" } as never)).toBe(true);
  });

  it("releases both routes, samples twice and tells the renderer the route state", async () => {
    const f = fresh();
    await f.verifySecureMcpApp();
    free(f);
    await vi.waitFor(() => expect(f.status).toHaveBeenCalledTimes(1));
    expect(f.sample).toHaveBeenCalledTimes(2);
    expect(f.live.window!.webContents.send).toHaveBeenCalledExactlyOnceWith(
      channels.browserRouteState,
      { state: "loaded" },
    );
  });

  it("reports the check timing only in the dev profile", async () => {
    const f = fresh();
    expect(f.live.route!.runReadonlyTask.mock.calls.length).toBe(0);
    await f.verifySecureMcpApp();
    expect(f.live.route!.runReadonlyTask.mock.calls[0]?.[2]).not.toHaveProperty(
      "onConnectorTiming",
    );
    const dev = createConnectorVerify({
      ...f.ports,
      runtimeEnvironment: "dev",
    } as unknown as ConnectorVerifyPorts);
    const g = f;
    g.state.sent = false;
    g.live.route = g.makeRoute();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    g.live.route.runReadonlyTask.mockImplementation(
      async (_prompt, _files, hooks) => {
        (
          hooks as { onConnectorTiming?: (e: object) => void }
        ).onConnectorTiming?.({
          phase: "x",
        });
        return { state: "failed_before_submit", code: "X" };
      },
    );
    await dev.verifySecureMcpApp();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /^FAROL_CONNECTOR_CHECK_TIMING:\{"schema":1,"id":"[0-9a-f-]{36}"[^}]*"phase":"x"\}$/,
      ),
    );
  });
});

describe("owners are read at the moment of use, after every await", () => {
  const fresh = () => {
    const f = build();
    f.settings.setup.connect.outcomeUnknown = false;
    return f;
  };

  it("refuses when Go is replaced while it is observed during the separate check", async () => {
    const f = build();
    const other = {
      observeComputerConnectorVerification: vi.fn(async () => ({
        binding: f.binding,
      })),
    };
    f.live.core!.observeComputerConnectorVerification.mockImplementation(
      async () => {
        f.live.core = other;
        return { binding: f.binding };
      },
    );
    expect(await f.verifySecureMcpApp(f.expected)).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
    });
    expect(f.showMessageBox).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("refuses when Go is replaced while the owner decides", async () => {
    const f = build();
    f.showMessageBox.mockImplementation(async () => {
      f.live.core = {
        observeComputerConnectorVerification: vi.fn(async () => ({
          binding: f.binding,
        })),
      };
      return { response: 1 };
    });
    expect(await f.verifySecureMcpApp(f.expected)).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("refuses when Go reports another binding after the owner decides", async () => {
    const f = build();
    f.live
      .core!.observeComputerConnectorVerification.mockResolvedValueOnce({
        binding: f.binding,
      })
      .mockResolvedValueOnce({
        binding: { ...f.binding, backendGeneration: "changed" },
      });
    expect(await f.verifySecureMcpApp(f.expected)).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("refuses when the window is replaced while the owner decides", async () => {
    const f = build();
    f.showMessageBox.mockImplementation(async () => {
      f.live.window = {
        isDestroyed: vi.fn(() => false),
        webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
      };
      return { response: 1 };
    });
    expect(await f.verifySecureMcpApp(f.expected)).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("refuses when settings drift while the owner decides", async () => {
    const f = build();
    f.showMessageBox.mockImplementation(async () => {
      f.connector.generation++;
      return { response: 1 };
    });
    expect(await f.verifySecureMcpApp(f.expected)).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("reads the settings service afresh in the document check and in dispatch", async () => {
    const f = fresh();
    const later = f.makeConfiguration();
    later.snapshot.mockImplementation(() => ({
      status: "ready" as const,
      settings: {
        ...f.settings,
        computer: { ...f.settings.computer, generation: 99 },
      },
    }));
    f.ports.prepareConnectorCheckDocument.mockImplementation(
      async (_route, current) => {
        // The service is replaced while the readiness check awaits.
        f.owner.configuration = later;
        expect(current()).toBe(false);
        return { ready: true };
      },
    );
    await f.verifySecureMcpApp();
    // Dispatch read the replacement too: its binding is stale, so no claim.
    expect(await f.verifySecureMcpApp()).toMatchObject({
      ok: false,
    });
    expect(f.prepareAttempt).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(later.snapshot).toHaveBeenCalled();
  });

  it("reads the ChatGPT route after the attempt record, not before", async () => {
    const f = fresh();
    const second = f.makeRoute();
    const first = f.live.route!;
    f.ports.connectorAppVerificationAttemptExists.mockImplementation(
      async () => {
        f.live.route = second;
        return false;
      },
    );
    await f.verifySecureMcpApp();
    expect(first.runReadonlyTask).not.toHaveBeenCalled();
    expect(second.runReadonlyTask).toHaveBeenCalledTimes(1);
  });

  it("tells the window that is current when the check ends, not the one it began with", async () => {
    const f = fresh();
    const first = f.live.window!;
    const second = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
    };
    f.live.route!.runReadonlyTask.mockImplementation(async () => {
      f.live.window = second;
      return { state: "failed_before_submit", code: "X" };
    });
    await f.verifySecureMcpApp();
    expect(first.webContents.send).not.toHaveBeenCalled();
    expect(second.webContents.send).toHaveBeenCalledTimes(1);
  });

  it("stays silent toward a window that closed meanwhile", async () => {
    const f = fresh();
    f.live.route!.runReadonlyTask.mockImplementation(async () => {
      f.live.window!.webContents.isDestroyed.mockReturnValue(true);
      return { state: "failed_before_submit", code: "X" };
    });
    await expect(f.verifySecureMcpApp()).resolves.toMatchObject({ ok: false });
    expect(f.live.window!.webContents.send).not.toHaveBeenCalled();
  });

  it("does not let a failed renderer notice change the result", async () => {
    const f = fresh();
    f.live.window!.webContents.send.mockImplementation(() => {
      throw new Error("renderer gone");
    });
    f.live.route!.runReadonlyTask.mockImplementation(async () => ({
      state: "failed_before_submit",
      code: "CHATGPT_APP_SELECTION_MISSING",
    }));
    expect(await f.verifySecureMcpApp()).toMatchObject({
      error: "CHATGPT_APP_SELECTION_MISSING",
    });
  });

  it("does not read a receipt for a Go owner that was replaced while it ran", async () => {
    const f = fresh();
    let received: boolean | null = null;
    f.live.route!.runReadonlyTask.mockImplementation(
      async (_prompt, _files, hooks) => {
        await hooks.onDispatchIntent?.();
        f.state.sent = true;
        f.live.core = {
          observeComputerConnectorVerification: vi.fn(async () => ({
            binding: f.binding,
            receipt: {
              challengeSha256,
              workspaceId: fixtureWorkspaceId,
              binding: f.binding,
            },
          })),
        };
        received = (await hooks.readConnectorReceipt?.()) ?? null;
        return { state: "receipt_confirmed" };
      },
    );
    await f.verifySecureMcpApp();
    expect(received).toBe(false);
  });

  it("reads the receipt it was sent for, through the live Go owner", async () => {
    const f = fresh();
    let received: boolean | null = null;
    f.live.route!.runReadonlyTask.mockImplementation(
      async (_prompt, _files, hooks) => {
        expect(await hooks.readConnectorReceipt?.()).toBe(false);
        await hooks.onDispatchIntent?.();
        f.state.sent = true;
        received = (await hooks.readConnectorReceipt?.()) ?? null;
        return { state: "receipt_confirmed" };
      },
    );
    await f.verifySecureMcpApp();
    expect(received).toBe(true);
  });

  it("does not wait on a receipt once Go is replaced after the claim", async () => {
    const f = fresh();
    f.ports.waitForConnectorAppReceipt.mockImplementation(async (read) => {
      f.live.core = {
        observeComputerConnectorVerification: vi.fn(async () => ({
          binding: f.binding,
        })),
      };
      return read();
    });
    expect(await f.verifySecureMcpApp()).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
    });
  });
});
