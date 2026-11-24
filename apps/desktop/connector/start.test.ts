import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import { ConnectorRuntimeEffectUnknown } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import { ConnectorHostError } from "../bridge/connector-host";
import { DesktopAdmission } from "../host/admission";
import { TUNNEL_CLIENT } from "../tunnel-client-contract";
import {
  createConnectorStart,
  reportConnectorTransport,
  type ConnectorStartPorts,
} from "./start";

// Partial Settings fixtures: schema validation is outside this sequencing test.
vi.mock("../../../src/pkg/product-settings/contract", async (original) => ({
  ...(await original<object>()),
  ProductConfigurationResultSchema: { parse: (result: unknown) => result },
}));

// The start sequence over scripted owners. Every port reads the fixture when it
// is called, so a test changes one field and the next read sees it. Each effect
// appends to one ordered log, so a test can assert refusal order and call order
// together. No process, tunnel, Go core, credential store or provider runs.
const directory = "/controlled/app";
const launchFile = "/controlled/launch/computer-go-launch.json";
const launchSha256 = "a".repeat(64);
const readyStart = { state: "ready", runtimeGeneration: "b".repeat(64) };
const phases = [
  "verify",
  "credential",
  "receipt-clear",
  "open",
  "prepare",
  "resources",
  "configure",
  "doctor",
  "start",
] as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

type Options = Readonly<{
  hooks?: Partial<Record<string, () => void | Promise<void>>>;
  startResult?: { state: string; runtimeGeneration: string };
  openError?: unknown;
  configureError?: unknown;
  doctorError?: unknown;
  startError?: unknown;
  verifyError?: unknown;
  credentialError?: unknown;
}>;

function build(options: Options = {}) {
  const events: string[] = [];
  const hooks = options.hooks ?? {};
  const step = async (name: string) => {
    events.push(name);
    await hooks[name]?.();
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
  const transitions = new AuthorityTransitionReservation();
  const settings = {
    revision: 10,
    computer: { generation: 7 },
    setup: { connect: { outcomeUnknown: false } },
    connectors: {
      secureMcp: {
        generation: 3,
        credential: "stored",
        tunnelId: "fixture-tunnel",
        appVerificationPending: false,
        tunnelClient: {
          executablePath: path.join(directory, TUNNEL_CLIENT.entry),
          executableSha256: TUNNEL_CLIENT.sha256 as string,
        },
        runtime: null as null | Record<string, unknown>,
        challenge: null as null | Record<string, unknown>,
        chatgptApp: undefined as undefined | Record<string, unknown>,
      },
    },
  };
  const snapshot = () => ({ status: "ready", settings });
  const state = {
    cancellation: null as AbortController | null,
    inFlight: null as Promise<void> | null,
    configuration: null as object | null,
    core: null as object | null,
    runtime: null as object | null,
    credentialStore: null as object | null,
    fence: { status: "reconciled" } as object | null,
    uuid: 0,
  };
  const owner = {
    snapshot: vi.fn(snapshot),
    recordSecureMcpStopped: vi.fn(async (..._args: unknown[]) => {
      await step("stopped");
      settings.connectors.secureMcp.runtime = null;
      return { ok: true, snapshot: snapshot() };
    }),
    recordSecureMcpRuntime: vi.fn(async (result: Record<string, unknown>) => {
      await step("record-runtime");
      settings.connectors.secureMcp.runtime = {
        ...result,
        connectorGeneration: 3,
      };
      return { ok: true, snapshot: snapshot() };
    }),
    recordSecureMcpChallenge: vi.fn(async (challenge: object) => {
      await step("challenge");
      settings.connectors.secureMcp.challenge = { ...challenge };
      return { ok: true, snapshot: snapshot() };
    }),
    recordSecureMcpCredential: vi.fn(async (..._args: unknown[]) => {
      await step("credential-missing");
      return { ok: true, snapshot: snapshot() };
    }),
    selectSecureMcpChatGptApp: vi.fn(async (selection: object) => {
      await step("select-app");
      settings.connectors.secureMcp.chatgptApp = { ...selection };
      return { ok: true, snapshot: snapshot() };
    }),
  };
  const runtime = {
    hasUnresolvedEffect: vi.fn(() => false),
    isRunning: vi.fn(() => false),
    configure: vi.fn(async (_input: object) => {
      await step("configure");
      if (options.configureError) throw options.configureError;
    }),
    doctor: vi.fn(async (_input: object) => {
      await step("doctor");
      if (options.doctorError) throw options.doctorError;
    }),
    start: vi.fn(async (_input: object) => {
      await step("start");
      if (options.startError) throw options.startError;
      return options.startResult ?? readyStart;
    }),
  };
  const core = {
    observeOriginalStop: vi.fn(async () => ({ restricted: false })),
    openComputerConnector: vi.fn(
      async (
        _runtimeId: string,
        _intent: string,
        _challenge: string,
        _root: string,
        _origin?: object,
      ) => {
        await step("open");
        if (options.openError) throw options.openError;
        return { launchFile, launchSha256 };
      },
    ),
  };
  const credentialStore = {
    reference: vi.fn(async () => {
      await step("credential");
      if (options.credentialError) throw options.credentialError;
      return "fixture-key-reference";
    }),
  };
  state.configuration = owner;
  state.core = core;
  state.runtime = runtime;
  state.credentialStore = credentialStore;
  const lifecycle = {
    prepare: vi.fn(async (_sha: string) => {
      await step("prepare");
    }),
  };
  const operations = { record: vi.fn(), begin: vi.fn(() => vi.fn()) };
  const ports = {
    configuration: () => state.configuration,
    connectorCredentialStore: () => state.credentialStore,
    secureMcpConnectorRuntime: () => state.runtime,
    desktopGoCore: () => state.core,
    summaryFenceRecovery: () => state.fence,
    connectorStartCancellation: () => state.cancellation,
    setConnectorStartCancellation: (value: AbortController | null) => {
      state.cancellation = value;
    },
    setConnectorStartInFlight: (value: Promise<void> | null) => {
      state.inFlight = value;
    },
    desktopAdmission: admission,
    authorityTransitions: transitions,
    buildIdentity: { buildId: "fixture-build" },
    randomUUID: () => `fixture-uuid-${++state.uuid}`,
    directory,
    installedUpdates: {
      resources: () => ({
        directory,
        executable: "/controlled/electron",
        recheck: () => step("resources"),
      }),
    },
    operationsStore: () => operations,
    statePaths: () => ({ secureMcpLaunch: "/controlled/launch" }),
    configurationFailure: (error: string, connectorAttempt?: object) => ({
      ok: false,
      error,
      ...(connectorAttempt ? { connectorAttempt } : {}),
    }),
    transitionRefusal: () => ({
      ok: false,
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
    }),
    stopAndConfirmComputerMcp: vi.fn(async () => {
      await step("close");
    }),
    computerMcpLifecycle: () => lifecycle,
    e2eTunnelClientExecutable: () => undefined,
    verifyTunnelClientExecutable: vi.fn(async (_path: string) => {
      await step("verify-bundled");
      settings.connectors.secureMcp.tunnelClient.executableSha256 =
        TUNNEL_CLIENT.sha256;
      return { ok: true };
    }),
    verifySelectedTunnelClient: vi.fn(async (_client: object) => {
      await step("verify");
      if (options.verifyError) throw options.verifyError;
    }),
    clearConnectorVerificationReceipt: vi.fn(async (_root: string) => {
      await step("receipt-clear");
    }),
    connectorAttemptGeneration: (input: { phase: string }) =>
      `attempt-${input.phase}`,
  };
  const start = createConnectorStart(ports as unknown as ConnectorStartPorts);
  /** The admitted owner the start requires its caller to hold. */
  const direct = async (
    args: {
      repair?: boolean;
      resume?: boolean;
      from?: object;
      guard?: (() => boolean) | undefined;
    } = {},
  ) => {
    const reservation = transitions.tryReserve("connector-start")!;
    const task = admission.reserveAdmitted("connector-task");
    try {
      return (await start.startAdmittedSecureMcpConnector(
        args.repair ?? false,
        args.resume ?? false,
        args.from as never,
        args.guard,
      )) as Record<string, unknown>;
    } finally {
      task.release();
      reservation.release();
    }
  };
  /** The same, observed the way Quit observes it, with the signal installed. */
  const observed = (args: Parameters<typeof direct>[0] = {}) => {
    const reservation = transitions.tryReserve("connector-start")!;
    const task = admission.reserveAdmitted("connector-task");
    return start
      .observeConnectorStart(() =>
        start.startAdmittedSecureMcpConnector(
          args.repair ?? false,
          args.resume ?? false,
        ),
      )
      .finally(() => {
        task.release();
        reservation.release();
      }) as Promise<Record<string, unknown>>;
  };
  return {
    start,
    ports,
    state,
    settings,
    owner,
    runtime,
    core,
    credentialStore,
    lifecycle,
    operations,
    admission,
    transitions,
    events,
    direct,
    observed,
  };
}
type Fixture = ReturnType<typeof build>;

const fail = (error: string) => ({ ok: false, error });
const unknownOpen = () =>
  new ConnectorHostError(
    "unknown",
    "connector_open_unconfirmed",
    "computer.connector.open",
    "fixture-open-request",
    "fixture-open-operation",
    "unknown",
  );

afterEach(() => vi.restoreAllMocks());

describe("reportConnectorTransport", () => {
  it("writes one content-free line from the captured identity only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportConnectorTransport(
      {
        binding: {
          profileId: "profile",
          backendGeneration: "backend",
          runtimeId: "runtime",
          buildId: "build",
          connectorGeneration: "3",
        },
        core: {
          computerConnectorClosureReceipt: () => ({
            result: { recovery: "settled" },
          }),
        },
        computerGeneration: 7,
        connectorGeneration: 3,
        // A capture's credentials-bearing owners never enter the line.
        owner: { secret: "must-not-appear" },
        connector: { secret: "must-not-appear" },
      } as never,
      "CLASSIFIED",
    );
    expect(warn).toHaveBeenCalledOnce();
    const line = String(warn.mock.calls[0]![0]);
    expect(line.startsWith("FAROL_CONNECTOR_TRANSPORT:")).toBe(true);
    const body = JSON.parse(line.slice("FAROL_CONNECTOR_TRANSPORT:".length));
    expect(body).toMatchObject({
      code: "CLASSIFIED",
      profileId: "profile",
      backendGeneration: "backend",
      runtimeId: "runtime",
      recoveryDisposition: "settled",
      computerGeneration: 7,
      connectorGeneration: 3,
      buildId: "build",
    });
    expect(line).not.toContain("must-not-appear");
  });
});

describe("recordConnectorRuntime", () => {
  it("refuses without a Settings owner and records nothing", async () => {
    const f = build();
    f.state.configuration = null;
    expect(await f.start.recordConnectorRuntime("ready", "g", 7)).toEqual(
      fail("SETTINGS_UNAVAILABLE"),
    );
    expect(f.owner.recordSecureMcpRuntime).not.toHaveBeenCalled();
  });

  it("records state, generation and this build, and returns null on success", async () => {
    const f = build();
    expect(
      await f.start.recordConnectorRuntime("outcome_unknown", "gen", 7),
    ).toBeNull();
    expect(f.owner.recordSecureMcpRuntime).toHaveBeenCalledExactlyOnceWith({
      state: "outcome_unknown",
      runtimeGeneration: "gen",
      computerGeneration: 7,
      buildId: "fixture-build",
    });
  });

  it("returns the owner's own refusal", async () => {
    const f = build();
    const refused = { ok: false, error: "SETTINGS_WRITE_FAILED" };
    f.owner.recordSecureMcpRuntime.mockResolvedValueOnce(refused as never);
    expect(await f.start.recordConnectorRuntime("ready", "g", 7)).toEqual(
      refused,
    );
  });
});

describe("observeConnectorStart", () => {
  it("publishes the cancellation signal and in-flight promise before the work runs", async () => {
    const f = build();
    const work = deferred<{ ok: true }>();
    let during: { cancellation: unknown; inFlight: unknown } | null = null;
    const pending = f.start.observeConnectorStart(() => {
      during = {
        cancellation: f.state.cancellation,
        inFlight: f.state.inFlight,
      };
      return work.promise as never;
    });
    expect(during!.cancellation).toBeInstanceOf(AbortController);
    expect(during!.inFlight).toBeInstanceOf(Promise);
    const inFlight = f.state.inFlight!;
    let settled = false;
    void inFlight.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    work.resolve({ ok: true });
    expect(await pending).toEqual({ ok: true });
    await inFlight;
    expect(f.state.inFlight).toBeNull();
    expect(f.state.cancellation).toBeNull();
  });

  it("clears both when the work throws and rethrows the original error", async () => {
    const f = build();
    const failure = new Error("WORK_FAILED");
    await expect(
      f.start.observeConnectorStart(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(f.state.inFlight).toBeNull();
    expect(f.state.cancellation).toBeNull();
  });

  it("does not clear a cancellation that another start installed meanwhile", async () => {
    const f = build();
    const other = new AbortController();
    await f.start.observeConnectorStart(async () => {
      f.state.cancellation = other;
      return { ok: true } as never;
    });
    expect(f.state.cancellation).toBe(other);
    expect(f.state.inFlight).toBeNull();
  });

  it("resolves the promise Quit waits on, then clears it", async () => {
    const f = build();
    let waiting!: Promise<void>;
    await f.start.observeConnectorStart(async () => {
      waiting = f.state.inFlight!;
      return { ok: true } as never;
    });
    await expect(waiting).resolves.toBeUndefined();
    expect(f.state.inFlight).toBeNull();
  });
});

describe("startSecureMcpConnector", () => {
  it.each([
    [false, false, "You", "connection.start"],
    [true, false, "You", "connection.repair"],
    [false, true, "Setup", "connection.start"],
  ] as const)(
    "observes repair=%s resume=%s as %s / %s",
    async (repair, resume, source, kind) => {
      const f = build();
      f.state.core = null; // refuses at the first Go read, after admission
      const result = await f.start.startSecureMcpConnector(repair, resume);
      expect(result).toEqual(fail("AUTHORITY_CHANGE_IN_PROGRESS"));
      expect(f.operations.begin).toHaveBeenCalledExactlyOnceWith({
        source,
        kind,
        target: {},
      });
    },
  );
});

describe("startSecureMcpConnectorObserved", () => {
  it("refuses a running connector task before taking the authority transition", async () => {
    const f = build();
    const held = f.admission.reserveAdmitted("connector-task");
    const reserve = vi.spyOn(f.transitions, "tryReserve");
    expect(await f.start.startSecureMcpConnectorObserved(false)).toEqual(
      fail("CONNECTOR_ALREADY_RUNNING"),
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(f.state.inFlight).toBeNull();
    held.release();
  });

  it("refuses with the transition refusal and never reserves connector admission", async () => {
    const f = build();
    const other = f.transitions.tryReserve("agent-admission" as never)!;
    const reserve = vi.spyOn(f.admission, "reserveAdmitted");
    expect(await f.start.startSecureMcpConnectorObserved(false)).toEqual(
      fail("AUTHORITY_CHANGE_IN_PROGRESS"),
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(f.core.observeOriginalStop).not.toHaveBeenCalled();
    other.release();
  });

  it("holds both reservations across the start and releases admission before the transition", async () => {
    const f = build();
    const released: string[] = [];
    const reserveAdmitted = f.admission.reserveAdmitted.bind(f.admission);
    vi.spyOn(f.admission, "reserveAdmitted").mockImplementation(
      (kind, purpose) => {
        const reservation = reserveAdmitted(kind, purpose);
        return {
          release: () => {
            released.push(`admission:${kind}`);
            reservation.release();
          },
        };
      },
    );
    const tryReserve = f.transitions.tryReserve.bind(f.transitions);
    vi.spyOn(f.transitions, "tryReserve").mockImplementation((kind) => {
      const reservation = tryReserve(kind);
      return reservation
        ? {
            kind,
            release: () => {
              released.push(`transition:${kind}`);
              reservation.release();
            },
          }
        : reservation;
    });
    let held: [boolean, string | null, boolean] | null = null;
    f.core.observeOriginalStop.mockImplementationOnce(async () => {
      held = [
        f.admission.occupied("connector-task"),
        f.transitions.current(),
        f.state.inFlight !== null,
      ];
      return { restricted: false };
    });
    const result = await f.start.startSecureMcpConnectorObserved(false);
    expect(result).toMatchObject({ ok: true });
    expect(held).toEqual([true, "connector-start", true]);
    expect(released).toEqual([
      "admission:connector-task",
      "transition:connector-start",
    ]);
    expect(f.admission.occupied("connector-task")).toBe(false);
    expect(f.transitions.current()).toBeNull();
    expect(f.state.inFlight).toBeNull();
  });

  it("releases both reservations and clears the start when the sequence throws", async () => {
    const f = build();
    f.owner.snapshot.mockImplementation(() => {
      throw new Error("SNAPSHOT_THREW");
    });
    await expect(
      f.start.startSecureMcpConnectorObserved(false),
    ).rejects.toThrow("SNAPSHOT_THREW");
    expect(f.admission.occupied("connector-task")).toBe(false);
    expect(f.transitions.current()).toBeNull();
    expect(f.state.inFlight).toBeNull();
    expect(f.state.cancellation).toBeNull();
    expect(f.core.openComputerConnector).not.toHaveBeenCalled();
  });
});

describe("startAdmittedSecureMcpConnector refusals, in precedence order", () => {
  it.each([[undefined], [() => false]])(
    "refuses a missing or false recovery guard before any IO (%s)",
    async (guard) => {
      const f = build();
      expect(await f.direct({ from: {}, guard })).toEqual(
        fail("AUTHORITY_CHANGE_IN_PROGRESS"),
      );
      expect(f.events).toEqual([]);
      expect(f.core.observeOriginalStop).not.toHaveBeenCalled();
      expect(f.owner.snapshot).not.toHaveBeenCalled();
    },
  );

  it("refuses without connector admission or without the authority transition", async () => {
    const f = build();
    // No reservation of either kind held by the caller.
    expect(await f.start.startAdmittedSecureMcpConnector(false)).toEqual(
      fail("AUTHORITY_CHANGE_IN_PROGRESS"),
    );
    const task = f.admission.reserveAdmitted("connector-task");
    expect(await f.start.startAdmittedSecureMcpConnector(false)).toEqual(
      fail("AUTHORITY_CHANGE_IN_PROGRESS"),
    );
    task.release();
    expect(f.core.observeOriginalStop).not.toHaveBeenCalled();
  });

  it("refuses a closed desktop before reading Go custody", async () => {
    const f = build();
    f.admission.beginQuit();
    expect(await f.direct()).toEqual(fail("CONNECTOR_START_FAILED"));
    expect(f.core.observeOriginalStop).not.toHaveBeenCalled();
  });

  it.each([
    ["restricted", async () => ({ restricted: true })],
    ["rejected", async () => Promise.reject(new Error("GO_DOWN"))],
  ])(
    "refuses while the original Stop is %s, before Settings are read",
    async (_name, observe) => {
      const f = build();
      f.core.observeOriginalStop.mockImplementation(observe as never);
      expect(await f.direct()).toEqual(fail("AUTHORITY_CHANGE_IN_PROGRESS"));
      expect(f.owner.snapshot).not.toHaveBeenCalled();
      expect(f.core.openComputerConnector).not.toHaveBeenCalled();
    },
  );

  it("refuses without a Go core as an original Stop it cannot read", async () => {
    const f = build();
    f.state.core = null;
    expect(await f.direct()).toEqual(fail("AUTHORITY_CHANGE_IN_PROGRESS"));
  });

  it("re-reads the cancellation after Go custody resolves and does not continue", async () => {
    const f = build();
    const admitted = deferred<{ restricted: boolean }>();
    f.core.observeOriginalStop.mockImplementation(() => admitted.promise);
    const cancellation = new AbortController();
    f.state.cancellation = cancellation;
    const pending = f.direct();
    cancellation.abort();
    admitted.resolve({ restricted: false });
    expect(await pending).toEqual(fail("CONNECTOR_START_FAILED"));
    expect(f.owner.snapshot).not.toHaveBeenCalled();
  });

  it.each(["configuration", "credentialStore", "runtime"] as const)(
    "refuses a missing %s owner as unavailable Settings",
    async (owner) => {
      const f = build();
      f.state[owner] = null;
      expect(await f.direct()).toEqual(fail("SETTINGS_UNAVAILABLE"));
      expect(f.core.openComputerConnector).not.toHaveBeenCalled();
    },
  );

  it("refuses an unresolved runtime effect as an unknown outcome", async () => {
    const f = build();
    f.runtime.hasUnresolvedEffect.mockReturnValue(true);
    expect(await f.direct()).toEqual(fail("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"));
    expect(f.owner.snapshot).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a recorded unknown runtime",
      (f: Fixture) => {
        f.settings.connectors.secureMcp.runtime = { state: "outcome_unknown" };
      },
    ],
    [
      "an unresolved Setup connect",
      (f: Fixture) => {
        f.settings.setup.connect.outcomeUnknown = true;
      },
    ],
  ])("refuses %s as retryable never", async (_name, mutate) => {
    const f = build();
    mutate(f);
    expect(await f.direct()).toEqual(fail("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"));
    expect(f.events).toEqual([]);
    expect(f.core.openComputerConnector).not.toHaveBeenCalled();
    expect(f.runtime.start).not.toHaveBeenCalled();
  });

  it("refuses an unheld summary fence with its own code", async () => {
    const f = build();
    f.state.fence = null;
    expect(await f.direct()).toEqual(fail("COMPUTER_FENCE_UNHELD"));
    expect(f.events).toEqual([]);
  });

  it("refuses a running connector unless this is a repair", async () => {
    const f = build();
    f.runtime.isRunning.mockReturnValue(true);
    expect(await f.direct()).toEqual(fail("CONNECTOR_ALREADY_RUNNING"));
    expect(f.ports.stopAndConfirmComputerMcp).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });

  it("does not continue a repair whose Stop is unconfirmed", async () => {
    const f = build();
    f.runtime.isRunning.mockReturnValue(true);
    f.ports.stopAndConfirmComputerMcp.mockRejectedValueOnce(new Error("X"));
    expect(await f.direct({ repair: true })).toEqual(
      fail("CONNECTOR_STOP_UNCONFIRMED"),
    );
    expect(f.owner.recordSecureMcpStopped).not.toHaveBeenCalled();
    expect(f.core.openComputerConnector).not.toHaveBeenCalled();
  });

  it.each([
    ["repair", { repair: true }],
    ["resume after Quit", { resume: true }],
  ] as [string, { repair?: boolean; resume?: boolean }][])(
    "withdraws the old live proof before any launch on %s",
    async (_name, args) => {
      const f = build();
      f.runtime.isRunning.mockReturnValue(args.repair === true);
      expect(await f.direct(args)).toMatchObject({ ok: true });
      expect(f.events.slice(0, args.repair ? 2 : 1)).toEqual(
        args.repair ? ["close", "stopped"] : ["stopped"],
      );
      expect(f.events.indexOf("stopped")).toBeLessThan(
        f.events.indexOf("open"),
      );
    },
  );

  it("returns the owner's refusal when the stopped publication is refused", async () => {
    const f = build();
    const refused = { ok: false, error: "SETTINGS_WRITE_FAILED" };
    f.owner.recordSecureMcpStopped.mockResolvedValueOnce(refused as never);
    expect(await f.direct({ resume: true })).toEqual(refused);
    expect(f.core.openComputerConnector).not.toHaveBeenCalled();
  });

  it("refuses without a Go core before Settings are re-read for the launch", async () => {
    const f = build();
    f.core.observeOriginalStop.mockImplementationOnce(async () => {
      f.state.core = null; // gone after custody was read
      return { restricted: false };
    });
    expect(await f.direct()).toEqual(fail("CONNECTOR_START_FAILED"));
  });

  it("refuses unavailable Settings after custody", async () => {
    const f = build();
    let calls = 0;
    f.owner.snapshot.mockImplementation((() => {
      calls += 1;
      return calls <= 1
        ? { status: "ready", settings: f.settings }
        : { status: "error" };
    }) as never);
    expect(await f.direct()).toEqual(fail("SETTINGS_UNAVAILABLE"));
  });

  it.each([
    [
      "tunnel client",
      (s: Fixture["settings"]) => {
        s.connectors.secureMcp.tunnelClient = null as never;
      },
    ],
    [
      "tunnel id",
      (s: Fixture["settings"]) => {
        s.connectors.secureMcp.tunnelId = null as never;
      },
    ],
  ])("refuses a missing %s as not configured", async (_name, mutate) => {
    const f = build();
    mutate(f.settings);
    expect(await f.direct()).toEqual(fail("CONNECTOR_CONFIGURE_FAILED"));
    expect(f.events).toEqual([]);
  });

  it("refuses a connector whose key reference is not committed", async () => {
    const f = build();
    f.settings.connectors.secureMcp.credential = "missing";
    expect(await f.direct()).toEqual(fail("CONNECTOR_CREDENTIAL_REQUIRED"));
    expect(f.credentialStore.reference).not.toHaveBeenCalled();
  });
});

describe("startAdmittedSecureMcpConnector tunnel client and credential", () => {
  it("rechecks the bundled client when the saved digest is stale at the same path", async () => {
    const f = build();
    f.settings.connectors.secureMcp.tunnelClient.executableSha256 = "c".repeat(
      64,
    );
    expect(await f.direct()).toMatchObject({ ok: true });
    expect(
      f.ports.verifyTunnelClientExecutable,
    ).toHaveBeenCalledExactlyOnceWith(
      path.join(directory, TUNNEL_CLIENT.entry),
    );
    expect(f.events.indexOf("verify-bundled")).toBeLessThan(
      f.events.indexOf("verify"),
    );
  });

  it("returns the bundled recheck's refusal and starts nothing", async () => {
    const f = build();
    f.settings.connectors.secureMcp.tunnelClient.executableSha256 = "c".repeat(
      64,
    );
    f.ports.verifyTunnelClientExecutable.mockResolvedValueOnce(
      fail("TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE") as never,
    );
    expect(await f.direct()).toEqual(
      fail("TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE"),
    );
    expect(f.ports.verifySelectedTunnelClient).not.toHaveBeenCalled();
    expect(f.core.openComputerConnector).not.toHaveBeenCalled();
  });

  it("refuses when Settings lose the tunnel client during the bundled recheck", async () => {
    const f = build();
    f.settings.connectors.secureMcp.tunnelClient.executableSha256 = "c".repeat(
      64,
    );
    f.ports.verifyTunnelClientExecutable.mockImplementationOnce((async () => {
      f.settings.connectors.secureMcp.tunnelClient = null as never;
      return { ok: true };
    }) as never);
    expect(await f.direct()).toEqual(fail("SETTINGS_UNAVAILABLE"));
  });

  it.each([
    ["a stale discovery candidate", "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE"],
    ["any other failure", "TUNNEL_CLIENT_EXECUTABLE_UNSAFE"],
  ] as const)("maps %s to %s", async (label, code) => {
    const f = build({
      verifyError: new Error(
        label === "any other failure"
          ? "SOMETHING_ELSE"
          : "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE",
      ),
    });
    expect(await f.direct()).toEqual(fail(code));
    expect(f.owner.recordSecureMcpStopped).not.toHaveBeenCalled();
    expect(f.credentialStore.reference).not.toHaveBeenCalled();
  });

  it("records a stopped runtime with the refusal only when resuming after Quit", async () => {
    const f = build({ verifyError: new Error("SOMETHING_ELSE") });
    expect(await f.direct({ resume: true })).toEqual(
      fail("TUNNEL_CLIENT_EXECUTABLE_UNSAFE"),
    );
    expect(f.owner.recordSecureMcpStopped.mock.calls).toEqual([
      [],
      ["TUNNEL_CLIENT_EXECUTABLE_UNSAFE"],
    ]);
  });

  it("returns the owner's refusal when that stopped record is refused", async () => {
    const f = build({ verifyError: new Error("SOMETHING_ELSE") });
    const refused = { ok: false, error: "SETTINGS_WRITE_FAILED" };
    f.owner.recordSecureMcpStopped
      .mockResolvedValueOnce({
        ok: true,
        snapshot: f.owner.snapshot(),
      } as never)
      .mockResolvedValueOnce(refused as never);
    expect(await f.direct({ resume: true })).toEqual(refused);
  });

  it("records a missing credential and asks for it again, without a retry", async () => {
    const f = build({
      credentialError: new Error("CONNECTOR_CREDENTIAL_MISSING"),
    });
    expect(await f.direct()).toEqual(fail("CONNECTOR_CREDENTIAL_REQUIRED"));
    expect(f.owner.recordSecureMcpCredential).toHaveBeenCalledExactlyOnceWith(
      "missing",
    );
    expect(f.credentialStore.reference).toHaveBeenCalledOnce();
    expect(f.core.openComputerConnector).not.toHaveBeenCalled();
  });

  it("reports any other credential store failure as such and records nothing", async () => {
    const f = build({ credentialError: new Error("DISK") });
    expect(await f.direct()).toEqual(fail("CONNECTOR_CREDENTIAL_STORE_FAILED"));
    expect(f.owner.recordSecureMcpCredential).not.toHaveBeenCalled();
  });
});

describe("startAdmittedSecureMcpConnector Go open", () => {
  it("clears the old receipt, opens once with a challenge digest, then prepares the launch contract", async () => {
    const f = build();
    expect(await f.direct()).toMatchObject({ ok: true });
    expect(f.events.slice(0, 5)).toEqual([
      "verify",
      "credential",
      "receipt-clear",
      "open",
      "prepare",
    ]);
    expect(f.ports.clearConnectorVerificationReceipt).toHaveBeenCalledWith(
      "/controlled/launch",
    );
    const [runtimeId, intent, challengeSha, root, origin] =
      f.core.openComputerConnector.mock.calls[0]!;
    expect(runtimeId).toBe("fixture-uuid-1");
    expect(challengeSha).toBe(
      createHash("sha256").update("fixture-uuid-2").digest("hex"),
    );
    expect(intent).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            buildId: "fixture-build",
            runtimeId,
            computerGeneration: 7,
            connectorGeneration: 3,
            challengeSha256: challengeSha,
          }),
        )
        .digest("hex"),
    );
    expect(root).toBe("/controlled/launch");
    expect(origin).toBeUndefined();
    expect(f.lifecycle.prepare).toHaveBeenCalledExactlyOnceWith(launchSha256);
  });

  it("passes the recovery origin to the one open", async () => {
    const f = build();
    const from = { runtimeId: "old" };
    expect(await f.direct({ from, guard: () => true })).toMatchObject({
      ok: true,
    });
    expect(f.core.openComputerConnector.mock.calls[0]![4]).toBe(from);
  });

  it("does not prepare after an open that returned no launch contract", async () => {
    const f = build();
    f.core.openComputerConnector.mockResolvedValueOnce({} as never);
    expect(await f.direct()).toEqual(fail("CONNECTOR_STOP_UNCONFIRMED"));
    expect(f.lifecycle.prepare).not.toHaveBeenCalled();
    expect(f.runtime.configure).not.toHaveBeenCalled();
  });

  it("records an unknown Go open as sticky and never opens again", async () => {
    const open = unknownOpen();
    const f = build({ openError: open });
    const result = await f.direct();
    expect(result).toEqual({
      ok: false,
      error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
      connectorAttempt: {
        method: "computer.connector.open",
        requestId: "fixture-open-request",
        operationId: "fixture-open-operation",
        outcome: "unknown",
      },
    });
    expect(f.core.openComputerConnector).toHaveBeenCalledOnce();
    expect(f.owner.recordSecureMcpRuntime).toHaveBeenCalledExactlyOnceWith({
      state: "outcome_unknown",
      runtimeGeneration: createHash("sha256")
        .update("fixture-open-request\0fixture-open-operation")
        .digest("hex"),
      computerGeneration: 7,
      buildId: "fixture-build",
    });
    expect(f.lifecycle.prepare).not.toHaveBeenCalled();
    expect(f.runtime.configure).not.toHaveBeenCalled();
    expect(f.runtime.start).not.toHaveBeenCalled();
  });

  it("returns the owner's refusal when the unknown record is refused, keeping the attempt", async () => {
    const f = build({ openError: unknownOpen() });
    f.owner.recordSecureMcpRuntime.mockResolvedValueOnce({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
    } as never);
    expect(await f.direct()).toEqual({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      connectorAttempt: expect.objectContaining({ outcome: "unknown" }),
    });
  });

  it("names a thrown unknown record as a failed write, keeping the attempt", async () => {
    const f = build({ openError: unknownOpen() });
    f.owner.recordSecureMcpRuntime.mockRejectedValueOnce(new Error("DISK"));
    expect(await f.direct()).toEqual({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      connectorAttempt: expect.objectContaining({ outcome: "unknown" }),
    });
    expect(f.core.openComputerConnector).toHaveBeenCalledOnce();
  });

  it("keeps a known refusal retryable only by a later owner command, never here", async () => {
    const f = build({
      openError: new ConnectorHostError(
        "refused",
        "connector_open_refused_before_publication",
        "computer.connector.open",
        "known-request",
        "known-operation",
        "known",
      ),
    });
    expect(await f.direct()).toEqual({
      ok: false,
      error: "CONNECTOR_START_FAILED",
      connectorAttempt: {
        method: "computer.connector.open",
        requestId: "known-request",
        operationId: "known-operation",
        outcome: "known",
      },
    });
    expect(f.core.openComputerConnector).toHaveBeenCalledOnce();
    expect(f.owner.recordSecureMcpRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ["COMPUTER_MCP_STOP_MARKER", "CONNECTOR_STOP_UNCONFIRMED"],
    ["SECURE_MCP_WORKSPACE_REQUIRED", "CONNECTOR_WORKSPACE_REQUIRED"],
    ["SECURE_MCP_WORKSPACE_LIMIT", "CONNECTOR_WORKSPACE_LIMIT"],
    ["ANYTHING_ELSE", "CONNECTOR_START_FAILED"],
  ])("maps a thrown %s to %s", async (code, expected) => {
    const f = build({ openError: new Error(code) });
    expect(await f.direct()).toEqual(fail(expected));
    expect(f.runtime.configure).not.toHaveBeenCalled();
  });

  it("maps a non-Error throw to a failed start", async () => {
    const f = build({ openError: "not-an-error" });
    expect(await f.direct()).toEqual(fail("CONNECTOR_START_FAILED"));
  });
});

describe("startAdmittedSecureMcpConnector configure, doctor and start", () => {
  it("runs the full sequence once, in order, and publishes a ready connector", async () => {
    const f = build();
    const result = await f.direct();
    expect(f.events).toEqual([...phases, "record-runtime", "challenge"]);
    expect(result).toEqual({
      ok: true,
      snapshot: expect.objectContaining({ status: "ready" }),
      evidence: {
        kind: "connector.runtime",
        state: "ready",
        runtimeGeneration: readyStart.runtimeGeneration,
        computerGeneration: 7,
        buildId: "fixture-build",
      },
    });
    for (const effect of [
      f.core.openComputerConnector,
      f.runtime.configure,
      f.runtime.doctor,
      f.runtime.start,
    ])
      expect(effect).toHaveBeenCalledOnce();
    expect(f.runtime.configure.mock.calls[0]![0]).toMatchObject({
      executablePath: path.join(directory, TUNNEL_CLIENT.entry),
      tunnelId: "fixture-tunnel",
      credentialReference: "fixture-key-reference",
      mcp: {
        electronPath: "/controlled/electron",
        entryPath: path.join(directory, "computer-mcp.cjs"),
        launchContractPath: launchFile,
      },
    });
    expect(f.runtime.start.mock.calls[0]![0]).toMatchObject({
      connectorGeneration: 3,
      computerGeneration: 7,
      buildId: "fixture-build",
      launchContractSha256: launchSha256,
    });
    expect(f.owner.recordSecureMcpChallenge).toHaveBeenCalledExactlyOnceWith({
      challenge: "fixture-uuid-2",
      runtimeGeneration: readyStart.runtimeGeneration,
      computerGeneration: 7,
      buildId: "fixture-build",
    });
  });

  it.each([
    [
      "a stopped effect",
      new ConnectorRuntimeEffectUnknown("X" as never),
      "outcome_unknown",
      "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
    ],
    [
      "a refused configure",
      new Error("CONFIGURE"),
      "unreachable",
      "CONNECTOR_CONFIGURE_FAILED",
    ],
  ])(
    "classifies %s as %s without doctor or start",
    async (_name, configureError, state, code) => {
      const f = build({ configureError });
      expect(await f.direct()).toEqual(fail(code));
      expect(f.owner.recordSecureMcpRuntime).toHaveBeenCalledExactlyOnceWith({
        state,
        runtimeGeneration: "attempt-configure",
        computerGeneration: 7,
        buildId: "fixture-build",
      });
      expect(f.runtime.doctor).not.toHaveBeenCalled();
      expect(f.runtime.start).not.toHaveBeenCalled();
    },
  );

  it("returns the owner's refusal when a failed configure cannot be recorded", async () => {
    const f = build({ configureError: new Error("CONFIGURE") });
    const refused = { ok: false, error: "SETTINGS_WRITE_FAILED" };
    f.owner.recordSecureMcpRuntime.mockResolvedValueOnce(refused as never);
    expect(await f.direct()).toEqual(refused);
  });

  it("classifies a failed doctor as unreachable and never starts", async () => {
    const f = build({ doctorError: new Error("DOCTOR") });
    expect(await f.direct()).toEqual(fail("CONNECTOR_DOCTOR_FAILED"));
    expect(f.owner.recordSecureMcpRuntime).toHaveBeenCalledExactlyOnceWith({
      state: "unreachable",
      runtimeGeneration: "attempt-doctor",
      computerGeneration: 7,
      buildId: "fixture-build",
    });
    expect(f.runtime.start).not.toHaveBeenCalled();
  });

  it("returns the owner's refusal when a failed doctor cannot be recorded", async () => {
    const f = build({ doctorError: new Error("DOCTOR") });
    const refused = { ok: false, error: "SETTINGS_WRITE_FAILED" };
    f.owner.recordSecureMcpRuntime.mockResolvedValueOnce(refused as never);
    expect(await f.direct()).toEqual(refused);
  });

  it("classifies a throwing start as unreachable and starts nothing a second time", async () => {
    const f = build({ startError: new Error("START") });
    expect(await f.direct()).toEqual(fail("CONNECTOR_START_FAILED"));
    expect(f.owner.recordSecureMcpRuntime).toHaveBeenCalledExactlyOnceWith({
      state: "unreachable",
      runtimeGeneration: "attempt-start",
      computerGeneration: 7,
      buildId: "fixture-build",
    });
    expect(f.runtime.start).toHaveBeenCalledOnce();
    expect(f.owner.recordSecureMcpChallenge).not.toHaveBeenCalled();
  });

  it("does not publish a withdrawn start as an unreachable one", async () => {
    const f = build({ startError: new Error("START") });
    f.state.cancellation = new AbortController();
    f.runtime.start.mockImplementationOnce((async () => {
      f.state.cancellation!.abort();
      throw new Error("START");
    }) as never);
    expect(await f.direct()).toEqual(fail("CONNECTOR_START_FAILED"));
    expect(f.owner.recordSecureMcpRuntime).not.toHaveBeenCalled();
  });

  it("returns the owner's refusal when a failed start cannot be recorded", async () => {
    const f = build({ startError: new Error("START") });
    const refused = { ok: false, error: "SETTINGS_WRITE_FAILED" };
    f.owner.recordSecureMcpRuntime.mockResolvedValueOnce(refused as never);
    expect(await f.direct()).toEqual(refused);
  });

  it.each([
    ["unreachable", "CONNECTOR_RUNTIME_UNREACHABLE"],
    ["outcome_unknown", "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"],
  ])(
    "retains the original %s classification after recording it, with no challenge and no second start",
    async (state, code) => {
      const startResult = { ...readyStart, state };
      const f = build({ startResult });
      expect(await f.direct()).toEqual(fail(code));
      expect(f.owner.recordSecureMcpRuntime).toHaveBeenCalledExactlyOnceWith({
        ...startResult,
        computerGeneration: 7,
        buildId: "fixture-build",
      });
      expect(f.runtime.start).toHaveBeenCalledOnce();
      expect(f.core.openComputerConnector).toHaveBeenCalledOnce();
      expect(f.owner.recordSecureMcpChallenge).not.toHaveBeenCalled();
    },
  );

  it("returns the owner's refusal when the start result cannot be recorded", async () => {
    const f = build();
    const refused = { ok: false, error: "SETTINGS_WRITE_FAILED" };
    f.owner.recordSecureMcpRuntime.mockResolvedValueOnce(refused as never);
    expect(await f.direct()).toEqual(refused);
    expect(f.owner.recordSecureMcpChallenge).not.toHaveBeenCalled();
  });

  it("stops the tunnel and withdraws its proof when the challenge is refused", async () => {
    const f = build();
    const refused = { ok: false, error: "SETTINGS_WRITE_FAILED" };
    f.owner.recordSecureMcpChallenge.mockResolvedValueOnce(refused as never);
    expect(await f.direct()).toEqual(refused);
    // The refused challenge is a scripted double, so it logs no event itself.
    expect(f.events.slice(-3)).toEqual(["record-runtime", "close", "stopped"]);
    expect(f.ports.stopAndConfirmComputerMcp).toHaveBeenCalledOnce();
  });

  it("names an unconfirmed Stop after a refused challenge and does not withdraw the proof", async () => {
    const f = build();
    f.owner.recordSecureMcpChallenge.mockResolvedValueOnce({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
    } as never);
    f.ports.stopAndConfirmComputerMcp.mockRejectedValueOnce(new Error("X"));
    expect(await f.direct()).toEqual(fail("CONNECTOR_STOP_UNCONFIRMED"));
    expect(f.owner.recordSecureMcpRuntime).toHaveBeenCalledOnce();
    expect(f.events).not.toContain("stopped");
  });

  it("swallows a failing stopped record after a refused challenge and still returns the refusal", async () => {
    const f = build();
    const refused = { ok: false, error: "SETTINGS_WRITE_FAILED" };
    f.owner.recordSecureMcpChallenge.mockResolvedValueOnce(refused as never);
    f.owner.recordSecureMcpStopped.mockRejectedValueOnce(new Error("DISK"));
    expect(await f.direct()).toEqual(refused);
  });

  it("rebinds the saved same-tunnel app choice after a known ready start", async () => {
    const f = build();
    f.settings.connectors.secureMcp.chatgptApp = {
      name: "Farol Dev",
      tunnelId: "fixture-tunnel",
      connectorGeneration: 1,
    };
    expect(await f.direct()).toMatchObject({ ok: true });
    expect(f.owner.selectSecureMcpChatGptApp).toHaveBeenCalledExactlyOnceWith({
      name: "Farol Dev",
      tunnelId: "fixture-tunnel",
      connectorGeneration: 3,
    });
    expect(f.events.slice(-3)).toEqual([
      "record-runtime",
      "challenge",
      "select-app",
    ]);
  });

  it("returns the owner's refusal when the app rebind is refused", async () => {
    const f = build();
    f.settings.connectors.secureMcp.chatgptApp = {
      name: "Farol Dev",
      tunnelId: "fixture-tunnel",
      connectorGeneration: 1,
    };
    const refused = { ok: false, error: "SETTINGS_WRITE_FAILED" };
    f.owner.selectSecureMcpChatGptApp.mockResolvedValueOnce(refused as never);
    expect(await f.direct()).toEqual(refused);
  });

  it("does not rebind an app choice that was never saved", async () => {
    const f = build();
    expect(await f.direct()).toMatchObject({ ok: true });
    expect(f.owner.selectSecureMcpChatGptApp).not.toHaveBeenCalled();
  });
});

describe("startAdmittedSecureMcpConnector generation checks after each await", () => {
  const cancelAt = (f: () => Fixture) => () => {
    f().state.cancellation!.abort();
  };

  it.each(phases)(
    "a withdrawn start observed after %s runs no later effect",
    async (phase) => {
      let holder!: Fixture;
      const f = (holder = build({
        hooks: { [phase]: cancelAt(() => holder) },
      }));
      f.state.cancellation = new AbortController();
      const result = await f.direct();
      const index = phases.indexOf(phase);
      expect(f.events).toEqual([
        ...phases.slice(0, index + 1),
        // A start already issued still has its real result recorded.
        ...(phase === "start" ? ["record-runtime"] : []),
      ]);
      expect(result).toEqual(fail("CONNECTOR_START_FAILED"));
      expect(f.core.openComputerConnector).toHaveBeenCalledTimes(
        index >= phases.indexOf("open") ? 1 : 0,
      );
      expect(f.owner.recordSecureMcpChallenge).not.toHaveBeenCalled();
      expect(f.state.cancellation!.signal.aborted).toBe(true);
    },
  );

  it.each(phases.filter((phase) => phase !== "start"))(
    "Quit latched during %s prevents every later effect",
    async (phase) => {
      let holder!: Fixture;
      const f = (holder = build({
        hooks: { [phase]: () => holder.admission.beginQuit() },
      }));
      const result = await f.direct();
      const index = phases.indexOf(phase);
      expect(f.events).toEqual(phases.slice(0, index + 1));
      expect(result).toEqual(fail("CONNECTOR_START_FAILED"));
      expect(f.runtime.start).toHaveBeenCalledTimes(0);
      expect(f.owner.recordSecureMcpRuntime).not.toHaveBeenCalled();
    },
  );

  it("withdraws a configure that began before the beforeEffect barrier closed", async () => {
    const f = build();
    f.runtime.configure.mockImplementationOnce((async (input: {
      beforeEffect: () => void;
    }) => {
      f.admission.beginQuit();
      input.beforeEffect();
    }) as never);
    expect(await f.direct()).toEqual(fail("CONNECTOR_CONFIGURE_FAILED"));
    expect(f.owner.recordSecureMcpRuntime).toHaveBeenCalledExactlyOnceWith({
      state: "unreachable",
      runtimeGeneration: "attempt-configure",
      computerGeneration: 7,
      buildId: "fixture-build",
    });
  });

  it("a recovery guard that turns false stops the start at the next check, not later", async () => {
    let allowed = true;
    const f = build({ hooks: { prepare: () => void (allowed = false) } });
    expect(
      await f.direct({ from: { runtimeId: "old" }, guard: () => allowed }),
    ).toEqual(fail("AUTHORITY_CHANGE_IN_PROGRESS"));
    expect(f.events).toEqual(phases.slice(0, 5));
    expect(f.runtime.configure).not.toHaveBeenCalled();
  });
});

describe("start through the observed reservation", () => {
  it("lets an in-flight Quit cancel the signal the start captured at its beginning", async () => {
    const f = build();
    const gate = deferred<void>();
    f.core.observeOriginalStop.mockImplementationOnce(async () => {
      await gate.promise;
      return { restricted: false };
    });
    const pending = f.observed();
    f.state.cancellation!.abort();
    gate.resolve();
    expect(await pending).toEqual(fail("CONNECTOR_START_FAILED"));
    expect(f.owner.snapshot).not.toHaveBeenCalled();
    expect(f.state.inFlight).toBeNull();
    expect(f.state.cancellation).toBeNull();
  });

  it("clears the start-in-flight promise only after the whole sequence settles", async () => {
    const f = build();
    let during: boolean | null = null;
    f.owner.recordSecureMcpChallenge.mockImplementationOnce((async () => {
      during = f.state.inFlight !== null;
      return { ok: true, snapshot: f.owner.snapshot() };
    }) as never);
    expect(await f.observed()).toMatchObject({ ok: true });
    expect(during).toBe(true);
    expect(f.state.inFlight).toBeNull();
  });
});
