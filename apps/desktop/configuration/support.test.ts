import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedSupportPorts } from "../../../tests/support/support-configuration-ports";
import {
  fixtureBuildId,
  guidedSettingsFixture,
} from "../../../tests/fixtures/guided-onboarding";
import {
  ProductConfigurationResultSchema,
  ProductSettingsSchema,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import { DesktopAdmission } from "../host/admission";
import {
  createConfigurationSupport,
  supportRuntimeErrorCode,
  type ConfigurationSupportPorts,
  type SupportConfigurationCommand,
} from "./support";

// The completion predicate is the one pure collaborator these tests need to
// observe rather than re-derive: it records the context the handler builds and
// returns a scripted verdict. Its own rules have their own tests.
const completion = vi.hoisted(() => ({
  calls: [] as unknown[][],
  verdict: false,
}));
vi.mock("../../../src/ui/setup-completion", () => ({
  setupCompletionAllowed: (...args: unknown[]) => {
    completion.calls.push(args);
    return completion.verdict;
  },
}));

// These scripted ports cover command routing, refusal order, capture order and
// report assembly only. They do not qualify a real shell, a native save dialog,
// a native filesystem, a ChatGPT page, a live provider or a production profile.
beforeEach(() => {
  completion.calls = [];
  completion.verdict = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T10:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const readySnapshot = {
  status: "ready",
  settings: ProductSettingsSchema.parse(guidedSettingsFixture()),
} as const;
const errorSnapshot = {
  status: "error",
  error: "SETTINGS_READ_FAILED",
} as const;
type Snapshot = typeof readySnapshot | typeof errorSnapshot;

const buildIdentity = {
  schema: 1,
  product: "Farol",
  version: "9.9.9",
  bundleId: "io.github.legrch.farol",
  updateChannel: "local-preview-only",
  builtAt: "2026-11-24T09:00:00.000Z",
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
  sourceDirty: false,
  buildId: fixtureBuildId,
} as const;

const emptyOperations = {
  entries: [],
  corruptLines: 0,
  writeFailures: 0,
  unmappedCodes: 0,
  droppedEntries: 0,
  unrecordedUncertainEntries: 0,
  rejectedMetadata: 0,
  recentRejections: [],
};

function command(value: object): SupportConfigurationCommand {
  return value as SupportConfigurationCommand;
}

function failureOf(result: ProductConfigurationResult) {
  return result.ok ? null : result.error;
}

type Route = NonNullable<ReturnType<ConfigurationSupportPorts["chatGptRoute"]>>;

function scene(overrides: Partial<ConfigurationSupportPorts> = {}) {
  const events: string[] = [];
  const state: {
    snapshot: Snapshot;
    runtimeState: "starting" | "ready" | "offline" | "failed";
    runtimeError: string | null;
    runtime: { identity: string } | null;
    agentCapability: boolean;
    routeB: object | null;
    counts: { running: number; waiting: number; failed: number } | null;
    route: Route | null;
    signInCheck: ReturnType<ConfigurationSupportPorts["setupSignInCheck"]>;
    authorityKind: ReturnType<
      ConfigurationSupportPorts["activeAuthorityChangeKind"]
    >;
    target: string | null | Error;
    tasks: readonly unknown[];
  } = {
    snapshot: readySnapshot,
    runtimeState: "ready",
    runtimeError: null,
    runtime: { identity: "runtime-1" },
    agentCapability: true,
    routeB: {},
    counts: null,
    route: null,
    signInCheck: null,
    authorityKind: null,
    target: "/fixture/support.json",
    tasks: [{}, {}, {}],
  };
  const failure = (error: string): ProductConfigurationResult => {
    events.push(`failure:${error}`);
    return ProductConfigurationResultSchema.parse({
      ok: false,
      error,
      snapshot: errorSnapshot,
    });
  };
  const okParsable = (extra: object = {}) => ({
    ok: true,
    snapshot: state.snapshot,
    ...extra,
  });
  const configuration = {
    snapshot: vi.fn(() => {
      events.push("snapshot");
      return state.snapshot;
    }),
    updateGeneral: vi.fn(async (..._arguments: unknown[]) => {
      events.push("updateGeneral");
      return okParsable();
    }),
    setSetupJourney: vi.fn(
      async (
        _input: unknown,
        isComplete: (settings: unknown) => boolean,
      ): Promise<unknown> => {
        events.push("setSetupJourney");
        isComplete(readySnapshot.settings);
        return okParsable();
      },
    ),
  };
  const openExternal = vi.fn(async (_url: string) => {
    events.push("openExternal");
  });
  const selectedSupportExportTarget = vi.fn(async () => {
    events.push("target");
    if (state.target instanceof Error) throw state.target;
    return state.target;
  });
  const productTasksState = vi.fn(() => {
    events.push("tasks");
    return { tasks: state.tasks };
  });
  const operationsSnapshot = vi.fn(async () => {
    events.push("operations");
    return emptyOperations;
  });
  const writeSupportExport = vi.fn(
    async (..._arguments: unknown[]): Promise<unknown> => {
      events.push("write");
      return {
        fileName: "support.json",
        bytes: 123,
        sha256: "c".repeat(64),
      };
    },
  );
  const streamControllers = new Map<string, unknown>([["a", 1]]);
  const pendingComputer = new Map<string, unknown>([
    ["b", 1],
    ["c", 1],
  ]);
  const taskSurfaceFailures = new Map<string, string>();
  const observeSignInStatus = vi.fn(async () => {
    events.push("observe");
    return {
      state: "authenticated" as const,
      binding: { documentGeneration: 1, sequence: 2 },
    };
  });
  const isCurrentSignInStatus = vi.fn((..._arguments: unknown[]) => true);
  const route = {
    observeSignInStatus,
    isCurrentSignInStatus,
  } as unknown as Route;
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
  const ports = scriptedSupportPorts({
    configuration: () => configuration as never,
    configurationFailure: failure as never,
    openExternal,
    selectedSupportExportTarget,
    productTasksState,
    operationsStore: () => ({ snapshot: operationsSnapshot }) as never,
    writeSupportExport: writeSupportExport as never,
    buildIdentity,
    runtimeState: () => state.runtimeState,
    runtimeError: () => state.runtimeError,
    runtime: () => state.runtime,
    productAgentCapabilityAvailable: () => state.agentCapability,
    routeBRuntime: () => state.routeB,
    taskCountsBeforeRuntimeExit: () => state.counts,
    streamControllers,
    pendingComputer,
    taskSurfaceFailures,
    chatGptRoute: () => state.route,
    setupSignInCheck: () => state.signInCheck,
    desktopAdmission: admission,
    activeAuthorityChangeKind: () => state.authorityKind,
    ...overrides,
  });
  const handler = createConfigurationSupport(ports);
  return {
    events,
    state,
    configuration,
    openExternal,
    writeSupportExport,
    operationsSnapshot,
    route,
    observeSignInStatus,
    isCurrentSignInStatus,
    admission,
    handler,
    run: (value: object) => handler.configureAdmittedSupport(command(value)),
  };
}

describe("onboarding.open-help", () => {
  it.each([
    [
      "setup-guide",
      "https://github.com/legrch/farol/blob/main/docs/setup-connection.md",
    ],
    ["tunnels", "https://platform.openai.com/settings/organization/tunnels"],
    ["api-keys", "https://platform.openai.com/settings/organization/api-keys"],
    ["chatgpt", "https://chatgpt.com/plugins"],
  ])(
    "opens the fixed HTTPS destination for %s once",
    async (destination, url) => {
      const s = scene();
      const result = await s.run({ kind: "onboarding.open-help", destination });
      expect(result).toEqual({ ok: true, snapshot: readySnapshot });
      expect(s.openExternal).toHaveBeenCalledExactlyOnceWith(url);
      expect(s.events).toEqual(["openExternal", "snapshot"]);
    },
  );

  it("refuses an invalid destination without opening anything", async () => {
    const s = scene();
    const result = await s.run({
      kind: "onboarding.open-help",
      destination: "file:///arbitrary/document.html",
    });
    expect(failureOf(result)).toBe("ONBOARDING_HELP_OPEN_FAILED");
    expect(s.openExternal).not.toHaveBeenCalled();
    expect(s.events).toEqual(["failure:ONBOARDING_HELP_OPEN_FAILED"]);
  });

  it("reports a refused external open once, without a snapshot or retry", async () => {
    const s = scene({
      openExternal: vi.fn(async () => {
        throw new Error("refused");
      }),
    });
    const result = await s.run({
      kind: "onboarding.open-help",
      destination: "setup-guide",
    });
    expect(failureOf(result)).toBe("ONBOARDING_HELP_OPEN_FAILED");
    expect(s.events).toEqual(["failure:ONBOARDING_HELP_OPEN_FAILED"]);
  });
});

describe("general.update", () => {
  const update = {
    kind: "general.update",
    openAtLaunch: "activity",
    sidebarDefault: "compact",
    activityDetail: "detailed",
  };

  it("forwards exactly the three general fields once and returns the parsed result", async () => {
    const s = scene();
    const result = await s.run({ ...update, extra: "ignored" });
    expect(result).toEqual({ ok: true, snapshot: readySnapshot });
    expect(s.configuration.updateGeneral).toHaveBeenCalledExactlyOnceWith({
      openAtLaunch: "activity",
      sidebarDefault: "compact",
      activityDetail: "detailed",
    });
  });

  it("passes a service refusal through unchanged", async () => {
    const s = scene();
    s.configuration.updateGeneral.mockResolvedValueOnce({
      ok: false,
      error: "SETTINGS_INPUT_INVALID",
      snapshot: errorSnapshot,
    } as never);
    expect(failureOf(await s.run(update))).toBe("SETTINGS_INPUT_INVALID");
  });

  it("does not catch a service failure or retry it", async () => {
    const s = scene();
    s.configuration.updateGeneral.mockRejectedValueOnce(new Error("FIXTURE"));
    await expect(s.run(update)).rejects.toThrow("FIXTURE");
    expect(s.configuration.updateGeneral).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed service result instead of returning it", async () => {
    const s = scene();
    s.configuration.updateGeneral.mockResolvedValueOnce({ ok: "yes" } as never);
    await expect(s.run(update)).rejects.toThrow();
  });
});

describe("setup.progress", () => {
  const dismissed = {
    kind: "setup.progress",
    currentStep: "verify",
    dismissed: true,
  };

  function contextOf(call = 0) {
    return completion.calls[call]![1] as {
      buildId: string;
      current: boolean;
      signInObservation: unknown;
      signInCheck: unknown;
    };
  }

  it("records a step without reading the sign-in page when not dismissed", async () => {
    const s = scene();
    s.state.route = s.route;
    const result = await s.run({ ...dismissed, dismissed: false });
    expect(result).toEqual({ ok: true, snapshot: readySnapshot });
    expect(s.configuration.setSetupJourney).toHaveBeenCalledTimes(1);
    expect(s.configuration.setSetupJourney.mock.calls[0]![0]).toEqual({
      currentStep: "verify",
      dismissed: false,
    });
    expect(s.observeSignInStatus).not.toHaveBeenCalled();
    expect(contextOf()).toEqual({
      buildId: fixtureBuildId,
      current: false,
      signInObservation: null,
      signInCheck: null,
    });
  });

  it("reads the existing sign-in document once, before the journal write", async () => {
    const s = scene();
    s.state.route = s.route;
    s.state.signInCheck = {
      buildId: fixtureBuildId,
      binding: { documentGeneration: 1, sequence: 1 },
    };
    completion.verdict = true;
    await s.run(dismissed);
    expect(s.events).toEqual(["observe", "setSetupJourney"]);
    expect(s.observeSignInStatus).toHaveBeenCalledTimes(1);
    expect(contextOf()).toEqual({
      buildId: fixtureBuildId,
      current: true,
      signInObservation: {
        state: "authenticated",
        binding: { documentGeneration: 1, sequence: 2 },
        buildId: fixtureBuildId,
        pending: false,
      },
      signInCheck: s.state.signInCheck,
    });
    expect(s.isCurrentSignInStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "authenticated" }),
    );
  });

  it("returns the service result even when completion is refused", async () => {
    const s = scene();
    s.state.route = s.route;
    s.configuration.setSetupJourney.mockImplementationOnce(
      async (_input, isComplete) => {
        expect(isComplete(readySnapshot.settings)).toBe(false);
        return {
          ok: false,
          error: "SETUP_INCOMPLETE",
          snapshot: errorSnapshot,
        };
      },
    );
    expect(failureOf(await s.run(dismissed))).toBe("SETUP_INCOMPLETE");
  });

  it("treats a failed sign-in read as no observation and never current", async () => {
    const s = scene();
    s.state.route = s.route;
    s.observeSignInStatus.mockRejectedValueOnce(new Error("page"));
    await s.run(dismissed);
    expect(s.observeSignInStatus).toHaveBeenCalledTimes(1);
    expect(contextOf()).toMatchObject({
      current: false,
      signInObservation: null,
    });
    expect(s.isCurrentSignInStatus).not.toHaveBeenCalled();
  });

  it("has no observation and is never current without a route", async () => {
    const s = scene();
    await s.run(dismissed);
    expect(contextOf()).toMatchObject({
      current: false,
      signInObservation: null,
    });
  });

  it("captures the route and check before awaiting the observation", async () => {
    const s = scene();
    s.state.route = s.route;
    s.observeSignInStatus.mockImplementationOnce(async () => {
      s.state.route = {} as Route;
      return {
        state: "authenticated" as const,
        binding: { documentGeneration: 1, sequence: 2 },
      };
    });
    await s.run(dismissed);
    expect(contextOf().current).toBe(false);
    expect(s.isCurrentSignInStatus).not.toHaveBeenCalled();
  });

  it("is not current when the sign-in check changed after capture", async () => {
    const s = scene();
    s.state.route = s.route;
    s.state.signInCheck = null;
    s.observeSignInStatus.mockImplementationOnce(async () => {
      s.state.signInCheck = {
        buildId: fixtureBuildId,
        binding: { documentGeneration: 1, sequence: 3 },
      };
      return {
        state: "authenticated" as const,
        binding: { documentGeneration: 1, sequence: 4 },
      };
    });
    await s.run(dismissed);
    expect(contextOf().current).toBe(false);
  });

  it("is not current when the observation is no longer the route's current one", async () => {
    const s = scene();
    s.state.route = s.route;
    s.isCurrentSignInStatus.mockReturnValueOnce(false);
    await s.run(dismissed);
    expect(contextOf().current).toBe(false);
  });

  it.each([
    [
      "the runtime is not ready",
      (s: ReturnType<typeof scene>) => {
        s.state.runtimeState = "failed";
      },
    ],
    [
      "the desktop is closing",
      (s: ReturnType<typeof scene>) => {
        s.admission.beginQuit();
      },
    ],
    [
      "a connector task is admitted",
      (s: ReturnType<typeof scene>) => {
        s.admission.reserveAdmitted("connector-task");
      },
    ],
    [
      "a workspace mutation is admitted",
      (s: ReturnType<typeof scene>) => {
        s.admission.reserveAdmitted("workspace-mutation");
      },
    ],
    [
      "an authority change is active",
      (s: ReturnType<typeof scene>) => {
        s.state.authorityKind = "connector.start";
      },
    ],
  ])("is not current when %s", async (_label, disturb) => {
    const s = scene();
    s.state.route = s.route;
    disturb(s);
    await s.run(dismissed);
    expect(contextOf().current).toBe(false);
  });

  it("reads the live admission and authority state when the predicate runs", async () => {
    const s = scene();
    s.state.route = s.route;
    s.configuration.setSetupJourney.mockImplementationOnce(
      async (_input, isComplete) => {
        // The state moves after the observation was captured and before the
        // service evaluates the predicate under its own lock.
        s.state.runtimeState = "offline";
        isComplete(readySnapshot.settings);
        return { ok: true, snapshot: readySnapshot };
      },
    );
    await s.run(dismissed);
    expect(contextOf().current).toBe(false);
  });
});

type Report = Readonly<{
  operations: unknown;
  runtime: unknown;
  capabilities: unknown;
  tasks: unknown;
  configuration: unknown;
}>;

describe("support.export", () => {
  const exportCommand = { kind: "support.export" };

  function writtenReport(s: ReturnType<typeof scene>) {
    return s.writeSupportExport.mock.calls[0]![1] as Report;
  }

  it("refuses a cancelled save before reading tasks, settings or operations", async () => {
    const s = scene();
    s.state.target = null;
    const result = await s.run(exportCommand);
    expect(failureOf(result)).toBe("SUPPORT_EXPORT_CANCELLED");
    expect(s.events).toEqual(["target", "failure:SUPPORT_EXPORT_CANCELLED"]);
  });

  it("reports a failed target selection as an export failure", async () => {
    const s = scene();
    s.state.target = new Error("SUPPORT_EXPORT_E2E_TARGET_INVALID");
    const result = await s.run(exportCommand);
    expect(failureOf(result)).toBe("SUPPORT_EXPORT_FAILED");
    expect(s.writeSupportExport).not.toHaveBeenCalled();
  });

  it("reads target, tasks, settings and operations in order, then writes once", async () => {
    const s = scene();
    const result = await s.run(exportCommand);
    expect(s.events).toEqual([
      "target",
      "tasks",
      "snapshot",
      "operations",
      "write",
      "snapshot",
    ]);
    expect(result).toMatchObject({
      ok: true,
      evidence: {
        kind: "support.exported",
        fileName: "support.json",
        bytes: 123,
      },
    });
    expect(s.writeSupportExport).toHaveBeenCalledTimes(1);
    const [target, , workspaces] = s.writeSupportExport.mock.calls[0]!;
    expect(target).toBe("/fixture/support.json");
    expect(workspaces).toEqual(readySnapshot.settings.computer.workspaces);
  });

  it("assembles a content-free report from the live state", async () => {
    const s = scene();
    s.state.agentCapability = false;
    s.state.routeB = null;
    await s.run(exportCommand);
    const report = writtenReport(s);
    expect(report).toMatchObject({
      schema: 2,
      kind: "farol_support",
      generatedAt: "2026-11-24T10:00:00.000Z",
      build: buildIdentity,
      runtime: { state: "ready", errorCode: null, identity: "runtime-1" },
      capabilities: {
        nativeFilesystem: true,
        nativeAgent: false,
        liveProvider: false,
      },
      embedded: {
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        chrome: process.versions.chrome ?? null,
      },
      tasks: {
        total: 3,
        running: 1,
        waiting: 2,
        failed: 0,
        countsFrom: "current",
      },
    });
    expect(report.operations).toBeDefined();
  });

  it("reports a live provider route and a native agent when both exist", async () => {
    const s = scene();
    await s.run(exportCommand);
    expect(writtenReport(s).capabilities).toMatchObject({
      nativeAgent: true,
      liveProvider: true,
    });
  });

  it("maps the runtime error and a missing runtime identity", async () => {
    const s = scene();
    s.state.runtimeState = "offline";
    s.state.runtimeError = "RUNTIME_START_TIMEOUT";
    s.state.runtime = null;
    await s.run(exportCommand);
    expect(writtenReport(s).runtime).toEqual({
      state: "offline",
      errorCode: "start_timeout",
      identity: null,
    });
  });

  it("uses the counts taken before a runtime exit once the runtime failed", async () => {
    const s = scene();
    s.state.runtimeState = "failed";
    s.state.counts = { running: 4, waiting: 5, failed: 6 };
    await s.run(exportCommand);
    expect(writtenReport(s).tasks).toEqual({
      total: 3,
      running: 4,
      waiting: 5,
      failed: 6,
      countsFrom: "before_runtime_exit",
    });
  });

  it("falls back to the live counts when a failed runtime left none", async () => {
    const s = scene();
    s.state.runtimeState = "failed";
    s.state.counts = null;
    await s.run(exportCommand);
    expect(writtenReport(s).tasks).toMatchObject({ countsFrom: "current" });
  });

  it("ignores retained counts while the runtime has not failed", async () => {
    const s = scene();
    s.state.counts = { running: 4, waiting: 5, failed: 6 };
    await s.run(exportCommand);
    expect(writtenReport(s).tasks).toMatchObject({
      running: 1,
      countsFrom: "current",
    });
  });

  it("writes no workspace labels when settings are unavailable", async () => {
    const s = scene();
    s.state.snapshot = errorSnapshot;
    await s.run(exportCommand);
    expect(s.writeSupportExport.mock.calls[0]![2]).toEqual([]);
    expect(writtenReport(s).configuration).toEqual({
      status: "error",
      error: "SETTINGS_READ_FAILED",
    });
  });

  it("names an oversized report and nothing else", async () => {
    const s = scene();
    s.writeSupportExport.mockRejectedValueOnce(
      new Error("SUPPORT_EXPORT_TOO_LARGE"),
    );
    const result = await s.run(exportCommand);
    expect(failureOf(result)).toBe("SUPPORT_EXPORT_TOO_LARGE");
    expect(s.writeSupportExport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another error", new Error("SUPPORT_EXPORT_UNSAFE")],
    ["a non-error value", "SUPPORT_EXPORT_TOO_LARGE"],
  ])(
    "reports %s from the write as a generic failure",
    async (_label, thrown) => {
      const s = scene();
      s.writeSupportExport.mockRejectedValueOnce(thrown);
      const result = await s.run(exportCommand);
      expect(failureOf(result)).toBe("SUPPORT_EXPORT_FAILED");
      expect(s.writeSupportExport).toHaveBeenCalledTimes(1);
    },
  );

  it("reports a malformed write receipt as a failure instead of returning it", async () => {
    const s = scene();
    s.writeSupportExport.mockResolvedValueOnce({
      fileName: "nested/support.json",
      bytes: 123,
      sha256: "c".repeat(64),
    });
    const result = await s.run(exportCommand);
    expect(failureOf(result)).toBe("SUPPORT_EXPORT_FAILED");
  });

  it("reports an unreadable operations store without writing anything", async () => {
    const s = scene();
    s.operationsSnapshot.mockRejectedValueOnce(new Error("store"));
    const result = await s.run(exportCommand);
    expect(failureOf(result)).toBe("SUPPORT_EXPORT_FAILED");
    expect(s.writeSupportExport).not.toHaveBeenCalled();
  });
});

describe("supportRuntimeErrorCode", () => {
  it.each([
    [null, null],
    ["RUNTIME_PROCESS_EXITED", "process_exited"],
    ["RUNTIME_PROCESS_FAILED", "process_failed"],
    ["RUNTIME_START_TIMEOUT", "start_timeout"],
    ["RUNTIME_TASK_MANIFEST_MISMATCH", "manifest_mismatch"],
    ["RUNTIME_EXITED", "startup_failed"],
    ["RUNTIME_START_FAILED", "startup_failed"],
    ["RUNTIME_START_FAILED_-9", "startup_failed"],
    ["RUNTIME_START_FAILED_x", "other"],
    ["SOMETHING_ELSE", "other"],
  ] as const)("maps %s to %s", (error, code) => {
    expect(supportRuntimeErrorCode(error)).toBe(code);
  });
});
