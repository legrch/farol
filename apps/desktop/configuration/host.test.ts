import { describe, expect, it, vi } from "vitest";
import { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import { codexTaskRouteFailureCode } from "../../../src/apps/desktop/codex-task-route-error";
import { admissionFixture } from "../../../tests/support/desktop-admission";
import {
  fixtureBuildId,
  fixtureWorkspaceId,
  guidedSettingsFixture,
} from "../../../tests/fixtures/guided-onboarding";
import { describeTaskModels } from "../../../src/pkg/owner-config/contract";
import { CHATGPT_MODEL_ID } from "../../../src/pkg/model-route/contract";
import {
  ProductConfigurationResultSchema,
  ProductSettingsSchema,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import {
  createConfigurationHost,
  type ConfigurationHostPorts,
  type HostConfigurationCommand,
} from "./host";

// These scripted ports cover command routing, refusal order and admission
// handling only. They do not qualify a real Codex App Server, the shared proxy,
// a native filesystem, a live provider or a production profile.
const sha = (character: string) => character.repeat(64);
const verifiedAt = "2026-11-23T10:00:00.000Z";
const projectId = "00000000-0000-4000-8000-000000000003";
const threadId = "0e4b2463-5506-47d5-a1a0-b4b84e941301";

const hostRecord = {
  executablePath: "/fixture/codex",
  executableSha256: sha("a"),
  version: "1.0.0",
  protocol: "codex-app-server/v2",
  schemaSha256: sha("b"),
  verifiedAt,
  localVerification: {
    executableSha256: sha("a"),
    schemaSha256: sha("b"),
    buildId: fixtureBuildId,
    verifiedAt,
  },
  liveVerification: {
    model: "gpt-6-astra",
    executableSha256: sha("a"),
    schemaSha256: sha("b"),
    buildId: fixtureBuildId,
    dynamicTool: "farol_ping",
    verifiedAt,
  },
} as const;

const routeRecord = {
  transport: "codex-shared-proxy/v1",
  socketPath: "/fixture/codex.sock",
  expectedCodexHome: "/fixture/codex-home",
  workspaceId: fixtureWorkspaceId,
  projectId,
  projectRoot: "/fixture/project",
  projectIdentity: { device: "5", inode: "10" },
  gitCommonDirectory: "/fixture/project/.git",
  execution: { sandbox: "read-only", approvalPolicy: "on-request" },
  harness: "codex",
  computerGeneration: 1,
  hostGeneration: 1,
  approvedAt: verifiedAt,
  expiresAt: 4_102_444_800_000,
} as const;

type SettingsOptions = Readonly<{
  codex?: object | null;
  taskRoute?: object | null;
  revision?: number;
  workspace?: object;
}>;

function settings(options: SettingsOptions = {}) {
  const base = guidedSettingsFixture();
  return ProductSettingsSchema.parse({
    ...base,
    revision: options.revision ?? base.revision,
    computer: {
      ...base.computer,
      workspaces: [{ ...base.computer.workspaces[0], ...options.workspace }],
    },
    nativeHosts: {
      generation: 1,
      codex: options.codex === undefined ? hostRecord : options.codex,
      taskRoute: options.taskRoute === undefined ? null : options.taskRoute,
    },
  });
}

function ready(options?: SettingsOptions) {
  return { status: "ready", settings: settings(options) } as const;
}

type Snapshot = ReturnType<typeof ready> | { status: "error"; error: string };
const unavailableSnapshot: Snapshot = {
  status: "error",
  error: "SETTINGS_READ_FAILED",
};

function command(value: object): HostConfigurationCommand {
  return value as HostConfigurationCommand;
}

type Stat = Readonly<{
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  dev: bigint;
  ino: bigint;
}>;

class FakeProxy {
  request = vi.fn(async (..._arguments: unknown[]) => ({
    thread: { id: threadId, projectId, cwd: "/fixture/writer" },
  }));
  close = vi.fn(() => undefined);
  closeAndWait = vi.fn(async () => true);
}

// One scene scripts every port; tests change only what the branch under test
// reads. `events` records the call order of the effects that matter.
function scene() {
  const events: string[] = [];
  const state: {
    snapshot: Snapshot;
    agentActive: boolean;
    productSession: object | null;
    pendingTask: string | null;
    activeCheck: unknown;
    goCore: unknown;
    compiled: unknown;
    routeB: unknown;
  } = {
    snapshot: ready(),
    agentActive: false,
    productSession: null,
    pendingTask: null,
    activeCheck: null,
    goCore: null,
    compiled: null,
    routeB: null,
  };
  const failure = (error: string): ProductConfigurationResult =>
    ProductConfigurationResultSchema.parse({
      ok: false,
      error,
      snapshot:
        state.snapshot.status === "ready"
          ? state.snapshot
          : { status: "error", error: "SETTINGS_READ_FAILED" },
    });
  const okResult = (extra: object = {}) => ({
    ok: true,
    snapshot: state.snapshot,
    ...extra,
  });
  const proxy = new FakeProxy();
  const catalogueResult: { value: object } = {
    value: {
      status: "ready",
      source: "model/list",
      scope: "fixture-scope",
      observedAt: 1,
      models: [],
    },
  };
  const attach = vi.fn(async (input: unknown) => {
    events.push("attach");
    void input;
    return proxy;
  });
  const configuration = {
    snapshot: vi.fn(() => state.snapshot),
    resolveTaskModel: vi.fn(async (..._arguments: unknown[]) => ({
      status: "ready",
    })),
    recordCodexTaskRoute: vi.fn(async (..._arguments: unknown[]) => {
      events.push("recordCodexTaskRoute");
      return okResult();
    }),
    clearCodexTaskRoute: vi.fn(async () => okResult()),
    clearCodexHost: vi.fn(async () => okResult()),
    recordCodexHostFailure: vi.fn(async (..._arguments: unknown[]) => {
      events.push("recordCodexHostFailure");
      return okResult();
    }),
    recordCodexHost: vi.fn(async (..._arguments: unknown[]) => {
      events.push("recordCodexHost");
      return okResult();
    }),
    recordCodexHostLiveVerification: vi.fn(async (..._arguments: unknown[]) =>
      okResult(),
    ),
    recordCodexHostLiveFailure: vi.fn(async (..._arguments: unknown[]) =>
      okResult(),
    ),
    recordCodexAgentFailure: vi.fn(async (..._arguments: unknown[]) =>
      okResult(),
    ),
    recordCodexAgentVerification: vi.fn(async (..._arguments: unknown[]) =>
      okResult(),
    ),
  };
  const probeResult = {
    executablePath: "/fixture/codex",
    executableSha256: sha("a"),
    version: "1.0.0",
    protocol: "codex-app-server/v2",
    schemaSha256: sha("b"),
    taskSource: null,
  };
  const probeCodexHost = vi.fn(async (..._arguments: unknown[]) => {
    events.push("probe");
    return probeResult;
  });
  const client = { close: vi.fn(async () => undefined) };
  const launchCodexAppServer = vi.fn(async (..._arguments: unknown[]) => {
    events.push("launch");
    return client;
  });
  const selectedCodexExecutable = vi.fn(async () => "/fixture/picked");
  const verifyCodexExecutable = vi.fn(async (..._arguments: unknown[]) => {
    events.push("verify");
    return okResult();
  });
  const authority = {
    resolve: vi.fn(async (..._arguments: unknown[]) => true),
  };
  const grants: unknown[] = [];
  class Authority {
    constructor(grant: unknown) {
      grants.push(grant);
    }
    resolve = authority.resolve;
  }
  const catalogueConstructions: unknown[][] = [];
  class Catalogue {
    constructor(...constructionArguments: unknown[]) {
      catalogueConstructions.push(constructionArguments);
    }
    async read(options: unknown) {
      events.push("catalogue");
      void options;
      return catalogueResult.value;
    }
  }
  const fileSystem = {
    chmod: vi.fn(async (..._arguments: unknown[]) => undefined),
    lstat: vi.fn(async (..._arguments: unknown[]): Promise<Stat> => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      dev: 5n,
      ino: 10n,
    })),
    realpath: vi.fn(async (value: string) => value),
    mkdtemp: vi.fn(async (..._arguments: unknown[]) => "/fixture/scratch"),
    rm: vi.fn(async (..._arguments: unknown[]) => {
      events.push("rm");
    }),
  };
  const desktopAdmission = admissionFixture({}).desktopAdmission;
  const authorityTransitions = new AuthorityTransitionReservation();
  const hostCheckClients = new Set<unknown>();
  const dispose = vi.fn();
  const stderr: string[] = [];
  const setActiveCodexAgentCheck = vi.fn((value: unknown) => {
    state.activeCheck = value;
  });
  const boundary = {
    configuration: () => configuration,
    desktopGoCore: () => state.goCore,
    compiledGoCore: () => state.compiled,
    routeBRuntime: () => state.routeB,
    activeCodexAgentCheck: () => state.activeCheck,
    setActiveCodexAgentCheck,
    activeProductAgentSession: () => state.productSession,
    pendingProductAgentTaskId: () => state.pendingTask,
    hostCheckClients,
    buildIdentity: () => ({ buildId: fixtureBuildId, version: "9.9.9" }),
    desktopAdmission,
    authorityTransitions,
    configurationFailure: failure,
    transitionRefusal: () => failure("AUTHORITY_CHANGE_IN_PROGRESS"),
    codexAgentOperationActive: vi.fn(() => state.agentActive),
    selectedCodexExecutable,
    e2eCodexExecutable: vi.fn((): string | undefined => undefined),
    verifyCodexExecutable,
    reverifyDiscoveredCandidate: vi.fn(async (..._arguments: unknown[]) => ({
      path: "/fixture/candidate",
      sha256: sha("c"),
    })),
    discoverExecutables: vi.fn(async (..._arguments: unknown[]) => ({
      candidates: [],
      searched: ["/fixture/bin"],
    })),
    probeCodexHost,
    statePaths: () => ({
      codexHostProbe: "/fixture/probe",
      codexAgentAssignments: "/fixture/assignments",
    }),
    chatGptTaskAdmissionReady: vi.fn(() => true),
    runRouteBHostCheck: vi.fn(async (...routeArguments: unknown[]) => {
      events.push("route-b");
      const dependencies = routeArguments[1] as {
        launch: (input: unknown) => Promise<unknown>;
      };
      await dependencies.launch({ fixture: true });
      expect(hostCheckClients.size).toBe(1);
      return { status: "passed", deltaCount: 2, observedCharacters: 5 };
    }),
    runCodexChatGptHostRoute: vi.fn(async () => undefined),
    runCodexHostSmoke: vi.fn(async (..._arguments: unknown[]) => {
      events.push("smoke");
      return {
        model: "gpt-6-astra",
        threadState: "completed",
        dynamicToolCalls: 1,
      };
    }),
    runCodexNativeAgentCheck: vi.fn(async (..._arguments: unknown[]) => ({
      status: "failed",
      code: "FIXTURE",
    })),
    launchCodexAppServer,
    codexHostRuntimeRoot: vi.fn(async () => "/fixture/runtime"),
    codexHostProcessHomePath: vi.fn(async () => "/fixture/home"),
    codexHostHomeOption: vi.fn(async () => ({})),
    codexAgentCheckWorkspace: vi.fn(() => ({})),
    tempPath: () => "/fixture/temp",
    ROUTE_B_MODEL: CHATGPT_MODEL_ID,
    SharedCodexProxyHost: { attach },
    ReadCodexModelCatalogue: Catalogue,
    PhysicalCodexHandoffAuthority: Authority,
    exactProject: vi.fn(async (..._arguments: unknown[]) => true),
    CodexNativeAgentHost: class {
      dispose = dispose;
    },
    CodexAgentWorkspaceProbe: class {},
    PrivateAssignmentStore: class {},
    fileSystem,
    writeStderr: (text: string) => {
      stderr.push(text);
    },
  };
  // One test-only cast admits partial owners. A port a test did not script
  // fails when called instead of hiding an effect.
  const handler = createConfigurationHost(
    boundary as unknown as ConfigurationHostPorts,
  );
  const run = (value: object) => handler.configureAdmittedHost(command(value));
  return {
    run,
    events,
    state,
    boundary,
    configuration,
    proxy,
    attach,
    probeCodexHost,
    launchCodexAppServer,
    client,
    authority,
    grants,
    catalogueResult,
    catalogueConstructions,
    fileSystem,
    desktopAdmission,
    authorityTransitions,
    hostCheckClients,
    stderr,
    selectedCodexExecutable,
    verifyCodexExecutable,
    okResult,
    setActiveCodexAgentCheck,
    dispose,
  };
}

type Scene = ReturnType<typeof scene>;

async function occupied(s: Scene) {
  return s.desktopAdmission.reserveAdmitted("codex-host-task");
}

describe("host.select-codex", () => {
  it("refuses first while a Codex task is active", async () => {
    const s = scene();
    s.state.agentActive = true;
    expect(await s.run({ kind: "host.select-codex" })).toMatchObject({
      ok: false,
      error: "CODEX_HOST_TASK_IN_PROGRESS",
    });
    expect(s.selectedCodexExecutable).not.toHaveBeenCalled();
  });

  it.each([
    ["cancelled", "CODEX_HOST_PICKER_CANCELLED"],
    ["invalid", "CODEX_HOST_SELECTION_INVALID"],
  ] as const)(
    "stops a %s selection before verification",
    async (kind, code) => {
      const s = scene();
      s.selectedCodexExecutable.mockResolvedValue(kind as never);
      expect(await s.run({ kind: "host.select-codex" })).toMatchObject({
        ok: false,
        error: code,
      });
      expect(s.verifyCodexExecutable).not.toHaveBeenCalled();
    },
  );

  it("verifies exactly the selected executable and returns its result", async () => {
    const s = scene();
    const result = await s.run({ kind: "host.select-codex" });
    expect(result).toMatchObject({ ok: true });
    expect(s.verifyCodexExecutable).toHaveBeenCalledExactlyOnceWith(
      "/fixture/picked",
    );
  });
});

describe("host.discover-codex", () => {
  it("refuses an invalid E2E executable without discovering", async () => {
    const s = scene();
    s.boundary.e2eCodexExecutable.mockReturnValue("invalid");
    expect(await s.run({ kind: "host.discover-codex" })).toMatchObject({
      ok: false,
      error: "CODEX_HOST_SELECTION_INVALID",
    });
    expect(s.boundary.discoverExecutables).not.toHaveBeenCalled();
  });

  it("reports an empty discovery for the E2E seam without scanning the host", async () => {
    const s = scene();
    s.boundary.e2eCodexExecutable.mockReturnValue("/fixture/e2e-codex");
    expect(await s.run({ kind: "host.discover-codex" })).toMatchObject({
      ok: true,
      evidence: {
        kind: "host.codex-discovery",
        candidates: [],
        searched: [],
      },
    });
    expect(s.boundary.discoverExecutables).not.toHaveBeenCalled();
  });

  it("returns read-only discovery evidence without verifying anything", async () => {
    const s = scene();
    expect(await s.run({ kind: "host.discover-codex" })).toMatchObject({
      ok: true,
      evidence: { searched: ["/fixture/bin"] },
    });
    expect(s.boundary.discoverExecutables).toHaveBeenCalledExactlyOnceWith(
      "codex",
    );
    expect(s.verifyCodexExecutable).not.toHaveBeenCalled();
  });

  it("classifies a discovery failure", async () => {
    const s = scene();
    s.boundary.discoverExecutables.mockRejectedValue(new Error("boom"));
    expect(await s.run({ kind: "host.discover-codex" })).toMatchObject({
      ok: false,
      error: "CODEX_HOST_DISCOVERY_FAILED",
    });
  });
});

describe("host.select-discovered-codex", () => {
  const select = { kind: "host.select-discovered-codex", path: "/fixture/x" };

  it("refuses first while a Codex task is active", async () => {
    const s = scene();
    s.state.agentActive = true;
    expect(await s.run(select)).toMatchObject({
      error: "CODEX_HOST_TASK_IN_PROGRESS",
    });
    expect(s.boundary.reverifyDiscoveredCandidate).not.toHaveBeenCalled();
  });

  it.each([
    ["stale", "CODEX_HOST_DISCOVERY_CANDIDATE_STALE"],
    ["declined", "CODEX_HOST_PICKER_CANCELLED"],
  ] as const)("refuses a %s candidate", async (outcome, code) => {
    const s = scene();
    s.boundary.reverifyDiscoveredCandidate.mockResolvedValue(outcome as never);
    expect(await s.run(select)).toMatchObject({ ok: false, error: code });
    expect(s.verifyCodexExecutable).not.toHaveBeenCalled();
  });

  it("treats a candidate without a digest as stale", async () => {
    const s = scene();
    s.boundary.reverifyDiscoveredCandidate.mockResolvedValue({
      path: "/fixture/candidate",
    } as never);
    expect(await s.run(select)).toMatchObject({
      error: "CODEX_HOST_DISCOVERY_CANDIDATE_STALE",
    });
    expect(s.verifyCodexExecutable).not.toHaveBeenCalled();
  });

  it("verifies the re-verified candidate bound to its digest", async () => {
    const s = scene();
    expect(await s.run(select)).toMatchObject({ ok: true });
    expect(s.boundary.reverifyDiscoveredCandidate).toHaveBeenCalledWith(
      "codex",
      "/fixture/x",
    );
    expect(s.verifyCodexExecutable).toHaveBeenCalledExactlyOnceWith(
      "/fixture/candidate",
      { canonicalPath: "/fixture/candidate", sha256: sha("c") },
    );
  });
});

describe("host.verify-codex", () => {
  it("refuses first while a Codex task is active", async () => {
    const s = scene();
    s.state.agentActive = true;
    expect(await s.run({ kind: "host.verify-codex" })).toMatchObject({
      error: "CODEX_HOST_TASK_IN_PROGRESS",
    });
    expect(s.configuration.snapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["unreadable settings", unavailableSnapshot],
    ["no selected host", ready({ codex: null })],
  ] as const)("refuses %s as not configured", async (_name, snapshot) => {
    const s = scene();
    s.state.snapshot = snapshot;
    expect(await s.run({ kind: "host.verify-codex" })).toMatchObject({
      error: "CODEX_HOST_NOT_CONFIGURED",
    });
    expect(s.verifyCodexExecutable).not.toHaveBeenCalled();
  });

  it("re-verifies the saved executable path", async () => {
    const s = scene();
    expect(await s.run({ kind: "host.verify-codex" })).toMatchObject({
      ok: true,
    });
    expect(s.verifyCodexExecutable).toHaveBeenCalledExactlyOnceWith(
      "/fixture/codex",
    );
  });
});

describe("host.refresh-codex-task-models", () => {
  const refresh = { kind: "host.refresh-codex-task-models" };
  const routed = (options: SettingsOptions = {}) =>
    ready({ taskRoute: routeRecord, ...options });

  it.each([
    ["an occupied host lane", "lane"],
    ["an active Codex task", "agent"],
  ] as const)("refuses %s before reading settings", async (_name, kind) => {
    const s = scene();
    s.state.snapshot = routed();
    const held = kind === "lane" ? await occupied(s) : null;
    s.state.agentActive = kind === "agent";
    expect(await s.run(refresh)).toMatchObject({
      error: "CODEX_HOST_TASK_IN_PROGRESS",
    });
    expect(s.configuration.snapshot).not.toHaveBeenCalled();
    held?.release();
  });

  it("refuses unreadable settings", async () => {
    const s = scene();
    s.state.snapshot = unavailableSnapshot;
    expect(await s.run(refresh)).toMatchObject({
      error: "SETTINGS_UNAVAILABLE",
    });
  });

  it.each([
    [
      "no verified host",
      routed({ codex: { ...hostRecord, localVerification: null } }),
    ],
    ["no route", ready()],
    [
      "an expired route",
      ready({ taskRoute: { ...routeRecord, expiresAt: 1 } }),
    ],
    [
      "a route for another host generation",
      ready({ taskRoute: { ...routeRecord, hostGeneration: 2 } }),
    ],
    [
      "a route for another Computer generation",
      ready({ taskRoute: { ...routeRecord, computerGeneration: 2 } }),
    ],
  ] as const)(
    "refuses %s before touching the host",
    async (_name, snapshot) => {
      const s = scene();
      s.state.snapshot = snapshot;
      expect(await s.run(refresh)).toMatchObject({
        error: "CODEX_TASK_ROUTE_UNAVAILABLE",
      });
      expect(s.attach).not.toHaveBeenCalled();
      expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
    },
  );

  it("reads a fresh catalogue under the host lane, then cleans up in order", async () => {
    const s = scene();
    s.state.snapshot = routed();
    s.boundary.codexAgentOperationActive.mockImplementation(() => false);
    s.attach.mockImplementation(async (input: unknown) => {
      s.events.push("attach");
      expect(s.desktopAdmission.occupied("codex-host-task")).toBe(true);
      expect(input).toEqual({
        executablePath: "/fixture/codex",
        executableSha256: sha("a"),
        socketPath: "/fixture/codex.sock",
        cwd: "/fixture/scratch",
        expectedCodexHome: "/fixture/codex-home",
      });
      return s.proxy;
    });
    const result = await s.run(refresh);
    expect(result).toMatchObject({
      ok: true,
      evidence: {
        kind: "host.task-models",
        view: {
          harness: "codex",
          catalogue: { status: "ready", scope: "fixture-scope" },
        },
      },
    });
    expect(s.events).toEqual(["attach", "catalogue", "rm"]);
    expect(s.fileSystem.chmod).toHaveBeenCalledWith("/fixture/scratch", 0o700);
    expect(s.proxy.closeAndWait).toHaveBeenCalledOnce();
    expect(s.catalogueConstructions[0]?.[0]).toBe(s.proxy);
    expect(s.fileSystem.rm).toHaveBeenCalledWith("/fixture/scratch", {
      recursive: true,
      force: true,
    });
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
  });

  it("reports an unavailable catalogue when attach fails, and still releases", async () => {
    const s = scene();
    s.state.snapshot = routed();
    s.attach.mockRejectedValue(new Error("attach"));
    expect(await s.run(refresh)).toMatchObject({
      ok: true,
      evidence: {
        view: {
          catalogue: {
            status: "unavailable",
            code: "TASK_MODEL_CATALOG_UNAVAILABLE",
          },
        },
      },
    });
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
    expect(s.fileSystem.rm).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "a proxy that cannot confirm its exit",
      (s: Scene) => s.proxy.closeAndWait.mockResolvedValue(false),
    ],
    [
      "an unverified proxy cleanup",
      (s: Scene) =>
        s.attach.mockRejectedValue(new Error("CODEX_PROXY_CLEANUP_UNVERIFIED")),
    ],
    [
      "a settings revision that moved",
      (s: Scene) =>
        s.proxy.closeAndWait.mockImplementation(async () => {
          s.state.snapshot = ready({
            taskRoute: routeRecord,
            revision: 2,
          });
          return true;
        }),
    ],
  ] as const)(
    "marks the catalogue changed after %s",
    async (_name, arrange) => {
      const s = scene();
      s.state.snapshot = routed();
      arrange(s);
      expect(await s.run(refresh)).toMatchObject({
        ok: true,
        evidence: {
          view: {
            catalogue: {
              status: "unavailable",
              code: "TASK_MODEL_CATALOG_CHANGED",
            },
          },
        },
      });
      expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
    },
  );

  it("never removes scratch it could not verify closed", async () => {
    const s = scene();
    s.state.snapshot = routed();
    s.proxy.closeAndWait.mockResolvedValue(false);
    await s.run(refresh);
    expect(s.fileSystem.rm).not.toHaveBeenCalled();
  });

  describe("on a Go build", () => {
    const goView = (result: object) =>
      describeTaskModels(undefined, "codex", result as never);
    function core(s: Scene) {
      const describe = vi.fn(
        async (
          _revision: unknown,
          _tasks: unknown,
          _harness: unknown,
          result: unknown,
        ) => goView(result as object),
      );
      s.state.compiled = "go";
      s.state.goCore = { describeTaskModels: describe };
      return describe;
    }

    it("fails when the selected core is gone", async () => {
      const s = scene();
      s.state.snapshot = routed();
      s.state.compiled = "go";
      s.state.goCore = null;
      expect(await s.run(refresh)).toMatchObject({
        error: "CODEX_TASK_ROUTE_UNAVAILABLE",
      });
    });

    it("never falls back to the legacy policy when the core fails", async () => {
      const s = scene();
      s.state.snapshot = routed();
      core(s).mockRejectedValue(new Error("go"));
      expect(await s.run(refresh)).toMatchObject({
        error: "CODEX_TASK_ROUTE_UNAVAILABLE",
      });
    });

    it("refuses when the core or settings changed during description", async () => {
      const s = scene();
      s.state.snapshot = routed();
      core(s).mockImplementation(async (_r, _t, _h, result) => {
        s.state.goCore = { describeTaskModels: vi.fn() };
        return goView(result as object);
      });
      expect(await s.run(refresh)).toMatchObject({
        error: "CODEX_TASK_ROUTE_REFUSED",
      });
    });

    it("returns the core's view for the current revision", async () => {
      const s = scene();
      s.state.snapshot = routed();
      const describe = core(s);
      expect(await s.run(refresh)).toMatchObject({
        ok: true,
        evidence: { kind: "host.task-models", view: { harness: "codex" } },
      });
      expect(describe).toHaveBeenCalledExactlyOnceWith(
        1,
        undefined,
        "codex",
        expect.objectContaining({ status: "ready" }),
      );
    });
  });
});

describe("host.configure-codex-tasks", () => {
  const configure = {
    kind: "host.configure-codex-tasks",
    socketPath: "/fixture/codex.sock",
    expectedCodexHome: "/fixture/codex-home",
    workspaceId: fixtureWorkspaceId,
    projectId,
    projectRoot: "/fixture/project",
    sandbox: "read-only",
    approvalPolicy: "on-request",
  };
  const withGit = {
    gitMetadata: {
      gitDirectory: "/fixture/project/.git/worktrees/writer",
      commonDirectory: "/fixture/project/.git",
    },
  };
  const wired = (s: Scene, options: SettingsOptions = {}) => {
    s.state.snapshot = ready({ workspace: withGit, ...options });
  };

  it.each([
    ["an occupied host lane", "lane"],
    ["an active Codex task", "agent"],
  ] as const)("refuses %s first", async (_name, kind) => {
    const s = scene();
    wired(s);
    const held = kind === "lane" ? await occupied(s) : null;
    s.state.agentActive = kind === "agent";
    expect(await s.run(configure)).toMatchObject({
      error: "CODEX_HOST_TASK_IN_PROGRESS",
    });
    expect(s.configuration.resolveTaskModel).not.toHaveBeenCalled();
    held?.release();
  });

  it("refuses unreadable settings before the Go policy", async () => {
    const s = scene();
    s.state.snapshot = unavailableSnapshot;
    expect(await s.run(configure)).toMatchObject({
      error: "SETTINGS_UNAVAILABLE",
    });
    expect(s.configuration.resolveTaskModel).not.toHaveBeenCalled();
  });

  it("refuses a missing local verification after the policy and reports no route", async () => {
    const s = scene();
    wired(s, { codex: { ...hostRecord, localVerification: null } });
    expect(await s.run(configure)).toMatchObject({
      error: "CODEX_HOST_NOT_CONFIGURED",
    });
    expect(s.stderr).toEqual([]);
    expect(s.attach).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an unknown workspace",
      { workspaceId: "00000000-0000-4000-8000-0000000000ff" },
      undefined,
    ],
    ["a workspace without a measured root", {}, { rootIdentity: undefined }],
    ["a workspace without Git metadata", {}, { gitMetadata: undefined }],
    [
      "a write sandbox on a read workspace",
      { sandbox: "workspace-write" },
      undefined,
    ],
  ] as const)(
    "refuses %s as a workspace identity",
    async (_name, extra, workspace) => {
      const s = scene();
      wired(s);
      if (workspace)
        s.state.snapshot = ready({ workspace: { ...withGit, ...workspace } });
      const result = await s.run({ ...configure, ...extra });
      expect(result).toMatchObject({ error: "CODEX_TASK_ROUTE_REFUSED" });
      expect(s.stderr).toHaveLength(1);
      expect(s.stderr[0]).toContain("workspace_identity");
      expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
      expect(s.attach).not.toHaveBeenCalled();
    },
  );

  it("refuses a project root that is not a plain directory", async () => {
    const s = scene();
    wired(s);
    s.fileSystem.lstat.mockResolvedValueOnce({
      isDirectory: () => false,
      isSymbolicLink: () => false,
      dev: 5n,
      ino: 10n,
    });
    expect(await s.run(configure)).toMatchObject({
      error: "CODEX_TASK_ROUTE_REFUSED",
    });
    expect(s.stderr[0]).toContain("project_root");
    expect(s.attach).not.toHaveBeenCalled();
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
  });

  it("refuses a writer root that is a symbolic link", async () => {
    const s = scene();
    wired(s);
    s.fileSystem.lstat
      .mockResolvedValueOnce({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        dev: 5n,
        ino: 10n,
      })
      .mockResolvedValueOnce({
        isDirectory: () => true,
        isSymbolicLink: () => true,
        dev: 5n,
        ino: 11n,
      });
    expect(await s.run(configure)).toMatchObject({
      error: "CODEX_TASK_ROUTE_REFUSED",
    });
    expect(s.stderr[0]).toContain("workspace_identity");
    expect(s.grants).toHaveLength(0);
  });

  it("refuses an unconfirmed Git identity before creating scratch", async () => {
    const s = scene();
    wired(s);
    s.authority.resolve.mockResolvedValue(false);
    expect(await s.run(configure)).toMatchObject({
      error: "CODEX_TASK_ROUTE_REFUSED",
    });
    expect(s.stderr[0]).toContain("git_identity");
    expect(s.fileSystem.mkdtemp).not.toHaveBeenCalled();
    expect(s.attach).not.toHaveBeenCalled();
  });

  it("binds the frozen writer and project witnesses into the authority", async () => {
    const s = scene();
    wired(s);
    await s.run(configure);
    expect(s.grants[0]).toEqual({
      workspaceId: fixtureWorkspaceId,
      writerRoot: "/tmp/farol-onboarding-fixture",
      writerIdentity: { device: "5", inode: "10" },
      projectRoot: "/fixture/project",
      projectIdentity: { device: "5", inode: "10" },
      gitCommonDirectory: "/fixture/project/.git",
      execution: { sandbox: "read-only", approvalPolicy: "on-request" },
    });
  });

  it("refuses a project that the catalogue does not list, and cleans up", async () => {
    const s = scene();
    wired(s);
    s.boundary.exactProject.mockResolvedValue(false);
    expect(await s.run(configure)).toMatchObject({
      error: "CODEX_TASK_ROUTE_REFUSED",
    });
    expect(s.stderr[0]).toContain("project_catalogue");
    expect(s.proxy.close).toHaveBeenCalledOnce();
    expect(s.fileSystem.rm).toHaveBeenCalledOnce();
    expect(s.configuration.recordCodexTaskRoute).not.toHaveBeenCalled();
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
  });

  it("refuses a writer folder replaced while the proxy attached", async () => {
    const s = scene();
    wired(s);
    s.fileSystem.lstat.mockImplementation(async () => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      dev: 5n,
      ino: 10n,
    }));
    s.attach.mockImplementation(async () => {
      s.fileSystem.lstat.mockResolvedValue({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        dev: 5n,
        ino: 99n,
      });
      return s.proxy;
    });
    expect(await s.run(configure)).toMatchObject({
      error: "CODEX_TASK_ROUTE_REFUSED",
    });
    expect(s.stderr[0]).toContain("workspace_identity");
    expect(s.configuration.recordCodexTaskRoute).not.toHaveBeenCalled();
    expect(s.proxy.close).toHaveBeenCalledOnce();
  });

  it("classifies a thrown failure from the exact route error and logs its record", async () => {
    const s = scene();
    wired(s);
    const failure = new Error("attach failed");
    s.attach.mockRejectedValue(failure);
    expect(await s.run(configure)).toMatchObject({
      ok: false,
      error: codexTaskRouteFailureCode(failure),
    });
    expect(s.stderr).toHaveLength(1);
    expect(s.stderr[0]).toMatch(/^farol-codex-task-route /u);
    expect(s.fileSystem.rm).toHaveBeenCalledOnce();
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
  });

  it("saves the route only after the policy, proxy and identity checks, in order", async () => {
    const s = scene();
    wired(s);
    s.configuration.resolveTaskModel.mockImplementation(async () => {
      s.events.push("policy");
      return { status: "ready" };
    });
    expect(await s.run(configure)).toMatchObject({ ok: true });
    expect(s.events).toEqual([
      "policy",
      "attach",
      "recordCodexTaskRoute",
      "rm",
    ]);
    expect(
      s.configuration.recordCodexTaskRoute,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        transport: "codex-shared-proxy/v1",
        workspaceId: fixtureWorkspaceId,
        harness: "codex",
        computerGeneration: 1,
        hostGeneration: 1,
      }),
      1,
    );
  });
});

describe("host.clear-codex-tasks", () => {
  it("refuses while the host lane is occupied", async () => {
    const s = scene();
    const held = await occupied(s);
    expect(await s.run({ kind: "host.clear-codex-tasks" })).toMatchObject({
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
    });
    expect(s.configuration.clearCodexTaskRoute).not.toHaveBeenCalled();
    held.release();
  });

  it("clears the route and returns the parsed result", async () => {
    const s = scene();
    expect(await s.run({ kind: "host.clear-codex-tasks" })).toMatchObject({
      ok: true,
    });
    expect(s.configuration.clearCodexTaskRoute).toHaveBeenCalledOnce();
  });
});

describe("host.run-route-b-check", () => {
  const check = { kind: "host.run-route-b-check" };
  const routeB = (calls: () => number) => ({
    endpoint: { baseUrl: "http://127.0.0.1:1", token: "fixture" },
    provider: { diagnostics: () => ({ toolCalls: calls() }) },
  });

  it.each([
    ["an occupied host lane", "lane"],
    ["an active Codex task", "agent"],
  ] as const)("refuses %s first", async (_name, kind) => {
    const s = scene();
    const held = kind === "lane" ? await occupied(s) : null;
    s.state.agentActive = kind === "agent";
    expect(await s.run(check)).toMatchObject({
      error: "CODEX_HOST_TASK_IN_PROGRESS",
    });
    expect(s.configuration.snapshot).not.toHaveBeenCalled();
    held?.release();
  });

  it("refuses unreadable settings and a missing host", async () => {
    const s = scene();
    s.state.snapshot = unavailableSnapshot;
    expect(await s.run(check)).toMatchObject({ error: "SETTINGS_UNAVAILABLE" });
    s.state.snapshot = ready({ codex: null });
    expect(await s.run(check)).toMatchObject({
      error: "CODEX_HOST_NOT_CONFIGURED",
    });
    expect(s.probeCodexHost).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a probe that fails",
      (s: Scene) => s.probeCodexHost.mockRejectedValue(new Error("x")),
    ],
    [
      "a changed executable digest",
      (s: Scene) =>
        s.probeCodexHost.mockResolvedValue({
          executablePath: "/fixture/codex",
          executableSha256: sha("f"),
          version: "1.0.0",
          protocol: "codex-app-server/v2",
          schemaSha256: sha("b"),
          taskSource: null,
        }),
    ],
  ] as const)(
    "invalidates host readiness on %s before refusing",
    async (_name, arrange) => {
      const s = scene();
      arrange(s);
      expect(await s.run(check)).toMatchObject({
        error: "CODEX_HOST_RECHECK_REQUIRED",
      });
      expect(
        s.configuration.recordCodexHostFailure,
      ).toHaveBeenCalledExactlyOnceWith("unreachable");
      expect(s.boundary.chatGptTaskAdmissionReady).not.toHaveBeenCalled();
      expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
    },
  );

  it("returns a failed invalidation instead of the refusal", async () => {
    const s = scene();
    s.probeCodexHost.mockRejectedValue(new Error("x"));
    s.configuration.recordCodexHostFailure.mockResolvedValue({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      snapshot: s.state.snapshot,
    } as never);
    expect(await s.run(check)).toMatchObject({
      error: "SETTINGS_WRITE_FAILED",
    });
  });

  it("refuses a ChatGPT connection that is not verified", async () => {
    const s = scene();
    s.boundary.chatGptTaskAdmissionReady.mockReturnValue(false);
    expect(await s.run(check)).toMatchObject({
      error: "CHATGPT_CONNECTION_NOT_VERIFIED",
    });
    expect(s.boundary.runRouteBHostCheck).not.toHaveBeenCalled();
  });

  it("refuses when Route B is unavailable", async () => {
    const s = scene();
    s.state.routeB = null;
    expect(await s.run(check)).toMatchObject({ error: "ROUTE_B_UNAVAILABLE" });
    expect(s.boundary.runRouteBHostCheck).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", "ROUTE_B_HOST_START_FAILED"],
    ["outcome_unknown", "ROUTE_B_OUTCOME_UNKNOWN"],
  ] as const)("maps a %s check without retrying", async (status, code) => {
    const s = scene();
    s.state.routeB = routeB(() => 0);
    s.boundary.runRouteBHostCheck.mockResolvedValue({ status } as never);
    expect(await s.run(check)).toMatchObject({ ok: false, error: code });
    expect(s.boundary.runRouteBHostCheck).toHaveBeenCalledOnce();
    expect(s.hostCheckClients.size).toBe(0);
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
  });

  it("refuses a check during which a tool was used", async () => {
    const s = scene();
    let calls = 0;
    s.state.routeB = routeB(() => calls);
    s.boundary.runRouteBHostCheck.mockImplementation(async () => {
      calls += 1;
      return { status: "passed", deltaCount: 1, observedCharacters: 1 };
    });
    expect(await s.run(check)).toMatchObject({
      error: "ROUTE_B_CHECK_TOOL_USED",
    });
  });

  it("proves the route under the host lane and forgets its clients afterwards", async () => {
    const s = scene();
    s.state.routeB = routeB(() => 0);
    expect(await s.run(check)).toMatchObject({
      ok: true,
      evidence: {
        kind: "host.route-b",
        provider: "farol",
        model: CHATGPT_MODEL_ID,
        deltaCount: 2,
        observedCharacters: 5,
      },
    });
    expect(s.events).toEqual(["probe", "route-b", "launch"]);
    expect(s.boundary.runRouteBHostCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: "/fixture/codex",
        runtimeRoot: "/fixture/runtime",
        homePath: "/fixture/home",
        tempPath: "/fixture/temp",
        clientVersion: "9.9.9",
      }),
      expect.anything(),
    );
    expect(s.hostCheckClients.size).toBe(0);
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
  });
});

describe("host.run-codex-smoke", () => {
  const smoke = { kind: "host.run-codex-smoke" };

  it.each([
    ["an occupied host lane", "lane"],
    ["an active Codex task", "agent"],
  ] as const)("refuses %s first", async (_name, kind) => {
    const s = scene();
    const held = kind === "lane" ? await occupied(s) : null;
    s.state.agentActive = kind === "agent";
    expect(await s.run(smoke)).toMatchObject({
      error: "CODEX_HOST_TASK_IN_PROGRESS",
    });
    held?.release();
  });

  it("refuses unreadable settings and a missing host", async () => {
    const s = scene();
    s.state.snapshot = unavailableSnapshot;
    expect(await s.run(smoke)).toMatchObject({ error: "SETTINGS_UNAVAILABLE" });
    s.state.snapshot = ready({ codex: null });
    expect(await s.run(smoke)).toMatchObject({
      error: "CODEX_HOST_NOT_CONFIGURED",
    });
    expect(s.probeCodexHost).not.toHaveBeenCalled();
  });

  it("returns a failed contract record without launching", async () => {
    const s = scene();
    s.configuration.recordCodexHost.mockResolvedValue({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      snapshot: s.state.snapshot,
    } as never);
    expect(await s.run(smoke)).toMatchObject({
      error: "SETTINGS_WRITE_FAILED",
    });
    expect(s.launchCodexAppServer).not.toHaveBeenCalled();
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
  });

  it("records the probed contract, then refuses a changed one without launching", async () => {
    const s = scene();
    s.probeCodexHost.mockResolvedValue({
      executablePath: "/fixture/codex",
      executableSha256: sha("f"),
      version: "1.0.0",
      protocol: "codex-app-server/v2",
      schemaSha256: sha("b"),
      taskSource: null,
    });
    expect(await s.run(smoke)).toMatchObject({
      error: "CODEX_HOST_RECHECK_REQUIRED",
    });
    expect(s.events).toEqual(["recordCodexHost"]);
    expect(s.probeCodexHost).toHaveBeenCalledOnce();
    expect(s.launchCodexAppServer).not.toHaveBeenCalled();
  });

  it("verifies live under the lane and removes its client when done", async () => {
    const s = scene();
    expect(await s.run(smoke)).toMatchObject({
      ok: true,
      evidence: {
        kind: "host.codex-live",
        model: "gpt-6-astra",
        executableSha256: sha("a"),
        schemaSha256: sha("b"),
      },
    });
    expect(s.events).toEqual(["probe", "recordCodexHost", "launch", "smoke"]);
    expect(s.boundary.runCodexHostSmoke).toHaveBeenCalledWith(
      s.client,
      expect.objectContaining({
        model: "gpt-6-astra",
        cwd: "/fixture/runtime",
        timeoutMs: 120_000,
      }),
    );
    expect(s.client.close).toHaveBeenCalledOnce();
    expect(s.hostCheckClients.size).toBe(0);
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
  });

  it("returns a failed live record unchanged", async () => {
    const s = scene();
    s.configuration.recordCodexHostLiveVerification.mockResolvedValue({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      snapshot: s.state.snapshot,
    } as never);
    expect(await s.run(smoke)).toMatchObject({
      error: "SETTINGS_WRITE_FAILED",
    });
  });

  it.each([
    [
      "CODEX_HOST_MODEL_UNAVAILABLE",
      "model_unavailable",
      "CODEX_HOST_MODEL_UNAVAILABLE",
    ],
    [
      "CODEX_APP_SERVER_EXITED",
      "outcome_unknown",
      "CODEX_HOST_LIVE_OUTCOME_UNKNOWN",
    ],
    [
      "CODEX_HOST_SMOKE_TIMEOUT",
      "outcome_unknown",
      "CODEX_HOST_LIVE_OUTCOME_UNKNOWN",
    ],
    ["SOMETHING_ELSE", "failed", "CODEX_HOST_LIVE_FAILED"],
  ] as const)("classifies %s as %s", async (thrown, state, code) => {
    const s = scene();
    s.boundary.runCodexHostSmoke.mockRejectedValue(new Error(thrown));
    expect(await s.run(smoke)).toMatchObject({ ok: false, error: code });
    expect(
      s.configuration.recordCodexHostLiveFailure,
    ).toHaveBeenCalledExactlyOnceWith(state);
    expect(s.boundary.runCodexHostSmoke).toHaveBeenCalledOnce();
    expect(s.client.close).toHaveBeenCalledOnce();
    expect(s.hostCheckClients.size).toBe(0);
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
  });

  it("returns a failed failure-record before the classified refusal", async () => {
    const s = scene();
    s.boundary.runCodexHostSmoke.mockRejectedValue(new Error("x"));
    s.configuration.recordCodexHostLiveFailure.mockResolvedValue({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      snapshot: s.state.snapshot,
    } as never);
    expect(await s.run(smoke)).toMatchObject({
      error: "SETTINGS_WRITE_FAILED",
    });
  });
});

describe("host.run-codex-agent-check", () => {
  const agent = { kind: "host.run-codex-agent-check" };
  const lineage = {
    kind: "host.codex-agent-lineage",
    model: "gpt-6-astra",
    executableSha256: sha("a"),
    schemaSha256: sha("b"),
    buildId: fixtureBuildId,
    workspaceId: fixtureWorkspaceId,
    computerGeneration: 1,
    transport: "codex-native-agent/spawn-prompt-sha256-v1",
    authorityRole: "agent",
    hostRole: null,
    delegationDigest: sha("1"),
    parentThreadSha256: sha("2"),
    childThreadSha256: sha("3"),
    boundedRunning: true,
    modelTurnsSubmitted: 1,
    fallbackAllowed: false,
    descendantCount: 0,
    resultRefProtocol: "codex-app-server",
    resultRetention: "durable",
    parentDelivery: "acknowledged",
    workspaceEnforcement: "verified",
  } as const;

  it.each([
    ["an occupied host lane", "lane"],
    ["an active Product Agent session", "session"],
    ["a pending Product Agent task", "pending"],
  ] as const)("refuses %s first", async (_name, kind) => {
    const s = scene();
    const held = kind === "lane" ? await occupied(s) : null;
    if (kind === "session") s.state.productSession = {};
    if (kind === "pending") s.state.pendingTask = "task-1";
    expect(await s.run(agent)).toMatchObject({
      error: "CODEX_HOST_TASK_IN_PROGRESS",
    });
    expect(s.configuration.snapshot).not.toHaveBeenCalled();
    held?.release();
  });

  it("refuses unreadable settings and a missing host", async () => {
    const s = scene();
    s.state.snapshot = unavailableSnapshot;
    expect(await s.run(agent)).toMatchObject({ error: "SETTINGS_UNAVAILABLE" });
    s.state.snapshot = ready({ codex: null });
    expect(await s.run(agent)).toMatchObject({
      error: "CODEX_HOST_NOT_CONFIGURED",
    });
  });

  it.each([
    ["no live verification", { ...hostRecord, liveVerification: null }],
    [
      "a live verification for another build",
      {
        ...hostRecord,
        liveVerification: { ...hostRecord.liveVerification, buildId: sha("9") },
      },
    ],
  ] as const)("requires a recheck for %s", async (_name, codex) => {
    const s = scene();
    s.state.snapshot = ready({ codex });
    expect(await s.run(agent)).toMatchObject({
      error: "CODEX_HOST_RECHECK_REQUIRED",
    });
    expect(s.authorityTransitions.current()).toBeNull();
  });

  it("records an unverified workspace and refuses", async () => {
    const s = scene();
    s.state.snapshot = ready({
      workspace: { workspaceId: "00000000-0000-4000-8000-0000000000ee" },
    });
    expect(await s.run(agent)).toMatchObject({
      error: "CODEX_AGENT_WORKSPACE_NOT_VERIFIED",
    });
    expect(
      s.configuration.recordCodexAgentFailure,
    ).toHaveBeenCalledExactlyOnceWith("workspace_not_verified");
  });

  it("returns a failed record of the unverified workspace", async () => {
    const s = scene();
    s.state.snapshot = ready({
      workspace: { workspaceId: "00000000-0000-4000-8000-0000000000ee" },
    });
    s.configuration.recordCodexAgentFailure.mockResolvedValue({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      snapshot: s.state.snapshot,
    } as never);
    expect(await s.run(agent)).toMatchObject({
      error: "SETTINGS_WRITE_FAILED",
    });
  });

  it("refuses a check for a different key while another check is held", async () => {
    const s = scene();
    s.state.activeCheck = { key: "another" };
    expect(await s.run(agent)).toMatchObject({
      error: "CODEX_HOST_TASK_IN_PROGRESS",
    });
    expect(s.authorityTransitions.current()).toBeNull();
  });

  it("refuses with the transition message while another transition holds the reservation", async () => {
    const s = scene();
    const other = s.authorityTransitions.tryReserve("authority-change");
    expect(await s.run(agent)).toMatchObject({
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
    });
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
    other?.release();
  });

  it("releases the transition when settings moved after they were read", async () => {
    const s = scene();
    let reads = 0;
    s.configuration.snapshot.mockImplementation(() => {
      reads += 1;
      return reads === 1 ? s.state.snapshot : ready({ revision: 5 });
    });
    expect(await s.run(agent)).toMatchObject({
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
    });
    expect(s.authorityTransitions.current()).toBeNull();
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
    expect(s.launchCodexAppServer).not.toHaveBeenCalled();
  });

  it("records an unknown outcome and still releases when launching throws", async () => {
    const s = scene();
    s.probeCodexHost.mockRejectedValue(new Error("probe"));
    expect(await s.run(agent)).toMatchObject({
      error: "CODEX_AGENT_LIVE_FAILED",
    });
    expect(
      s.configuration.recordCodexAgentFailure,
    ).toHaveBeenCalledExactlyOnceWith("failed");
    expect(s.authorityTransitions.current()).toBeNull();
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
  });

  it.each([
    [
      "a refused contract record",
      (s: Scene) =>
        s.configuration.recordCodexHost.mockResolvedValue({
          ok: false,
          error: "SETTINGS_WRITE_FAILED",
          snapshot: s.state.snapshot,
        } as never),
      "SETTINGS_WRITE_FAILED",
    ],
    [
      "a changed contract",
      (s: Scene) =>
        s.probeCodexHost.mockResolvedValue({
          executablePath: "/fixture/codex",
          executableSha256: sha("f"),
          version: "1.0.0",
          protocol: "codex-app-server/v2",
          schemaSha256: sha("b"),
          taskSource: null,
        }),
      "CODEX_HOST_RECHECK_REQUIRED",
    ],
    [
      "settings that became unreadable",
      (s: Scene) =>
        s.configuration.recordCodexHost.mockResolvedValue({
          ok: true,
          snapshot: unavailableSnapshot,
        } as never),
      "SETTINGS_UNAVAILABLE",
    ],
  ] as const)(
    "refuses %s before any launch and releases both reservations",
    async (_name, arrange, code) => {
      const s = scene();
      arrange(s);
      expect(await s.run(agent)).toMatchObject({ error: code });
      expect(s.launchCodexAppServer).not.toHaveBeenCalled();
      expect(s.boundary.runCodexNativeAgentCheck).not.toHaveBeenCalled();
      expect(s.setActiveCodexAgentCheck).not.toHaveBeenCalled();
      expect(s.authorityTransitions.current()).toBeNull();
      expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
    },
  );

  it("launches under the transition, activates the session, then closes it after a completed check", async () => {
    const s = scene();
    s.boundary.runCodexNativeAgentCheck.mockImplementation(async () => {
      // The transition reservation closed when the session became active.
      expect(s.authorityTransitions.current()).toBeNull();
      expect(s.desktopAdmission.occupied("codex-host-task")).toBe(true);
      expect(s.setActiveCodexAgentCheck).toHaveBeenCalledOnce();
      return { status: "completed", evidence: lineage } as never;
    });
    expect(await s.run(agent)).toMatchObject({
      ok: true,
      evidence: { kind: "host.codex-agent-lineage" },
    });
    expect(s.events).toEqual(["probe", "recordCodexHost", "launch"]);
    expect(
      s.configuration.recordCodexAgentVerification,
    ).toHaveBeenCalledExactlyOnceWith(
      (({ kind: _kind, ...rest }) => rest)(lineage),
    );
    expect(s.dispose).toHaveBeenCalledOnce();
    expect(s.client.close).toHaveBeenCalledOnce();
    expect(s.state.activeCheck).toBeNull();
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
  });

  it("keeps a still-running session for the next poll", async () => {
    const s = scene();
    s.boundary.runCodexNativeAgentCheck.mockResolvedValue({
      status: "running",
      code: "RUNNING",
    } as never);
    expect(await s.run(agent)).toMatchObject({
      error: "CODEX_AGENT_STILL_RUNNING",
    });
    expect(
      s.configuration.recordCodexAgentFailure,
    ).toHaveBeenCalledExactlyOnceWith("running");
    expect(s.dispose).not.toHaveBeenCalled();
    expect(s.client.close).not.toHaveBeenCalled();
    expect(s.state.activeCheck).toMatchObject({ boundedRunningObserved: true });
    expect(s.authorityTransitions.current()).toBeNull();
    expect(s.desktopAdmission.occupied("codex-host-task")).toBe(false);
  });

  it("resumes the held session without launching and reports the bounded observation", async () => {
    const s = scene();
    const dispose = vi.fn();
    const host = { dispose };
    // The key is the saved selection's identity for this build and workspace.
    const probeKey = JSON.stringify([
      "/fixture/codex",
      sha("a"),
      sha("b"),
      fixtureBuildId,
      guidedSettingsFixture().computer.computerId,
      1,
      fixtureWorkspaceId,
    ]);
    s.state.activeCheck = {
      key: probeKey,
      client: s.client,
      host,
      boundedRunningObserved: true,
    };
    s.boundary.runCodexNativeAgentCheck.mockResolvedValue({
      status: "completed",
      evidence: lineage,
    } as never);
    expect(await s.run(agent)).toMatchObject({ ok: true });
    expect(s.launchCodexAppServer).not.toHaveBeenCalled();
    expect(s.boundary.runCodexNativeAgentCheck).toHaveBeenCalledWith(
      expect.objectContaining({ host, boundedRunningObserved: true }),
    );
    expect(dispose).toHaveBeenCalledOnce();
    expect(s.state.activeCheck).toBeNull();
  });

  it.each([
    [
      "workspace_not_verified",
      "workspace_not_verified",
      "CODEX_AGENT_WORKSPACE_NOT_VERIFIED",
    ],
    ["outcome_unknown", "outcome_unknown", "CODEX_AGENT_LIVE_OUTCOME_UNKNOWN"],
    ["failed", "failed", "CODEX_AGENT_LIVE_FAILED"],
  ] as const)(
    "records a %s check and closes its session",
    async (status, recorded, code) => {
      const s = scene();
      s.boundary.runCodexNativeAgentCheck.mockResolvedValue({
        status,
        code: "X",
      } as never);
      expect(await s.run(agent)).toMatchObject({ ok: false, error: code });
      expect(
        s.configuration.recordCodexAgentFailure,
      ).toHaveBeenCalledExactlyOnceWith(recorded);
      expect(s.boundary.runCodexNativeAgentCheck).toHaveBeenCalledOnce();
      expect(s.client.close).toHaveBeenCalledOnce();
      expect(s.state.activeCheck).toBeNull();
    },
  );

  it("never turns a check that threw after activation into a retryable failure", async () => {
    const s = scene();
    s.boundary.runCodexNativeAgentCheck.mockRejectedValue(new Error("poll"));
    expect(await s.run(agent)).toMatchObject({
      error: "CODEX_AGENT_LIVE_OUTCOME_UNKNOWN",
    });
    expect(
      s.configuration.recordCodexAgentFailure,
    ).toHaveBeenCalledExactlyOnceWith("outcome_unknown");
    expect(s.boundary.runCodexNativeAgentCheck).toHaveBeenCalledOnce();
    expect(s.client.close).toHaveBeenCalledOnce();
    expect(s.state.activeCheck).toBeNull();
  });

  it("returns a failed verification record and still closes the session", async () => {
    const s = scene();
    s.boundary.runCodexNativeAgentCheck.mockResolvedValue({
      status: "completed",
      evidence: lineage,
    } as never);
    s.configuration.recordCodexAgentVerification.mockResolvedValue({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      snapshot: s.state.snapshot,
    } as never);
    expect(await s.run(agent)).toMatchObject({
      error: "SETTINGS_WRITE_FAILED",
    });
    expect(s.client.close).toHaveBeenCalledOnce();
    expect(s.state.activeCheck).toBeNull();
  });
});

describe("host.remove-codex", () => {
  it("refuses while a Codex task is active", async () => {
    const s = scene();
    s.state.agentActive = true;
    expect(await s.run({ kind: "host.remove-codex" })).toMatchObject({
      error: "CODEX_HOST_TASK_IN_PROGRESS",
    });
    expect(s.configuration.clearCodexHost).not.toHaveBeenCalled();
  });

  it("clears the saved host and returns the parsed result", async () => {
    const s = scene();
    expect(await s.run({ kind: "host.remove-codex" })).toMatchObject({
      ok: true,
    });
    expect(s.configuration.clearCodexHost).toHaveBeenCalledOnce();
  });
});
