import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorVerificationProof } from "../../../src/apps/desktop/connector-verification-proof";
import {
  fixtureBuildId,
  fixtureWorkspaceId,
  guidedSettingsFixture,
} from "../../../tests/fixtures/guided-onboarding";
import { connectorCheckHost } from "../../../tests/support/connector-check-ports";
import {
  ConnectionCheckRefusal,
  connectionCheckDigest,
} from "../connection-check-command";
import { DesktopAdmission } from "../host/admission";
import {
  connectorAppBindingCurrent,
  createConnectorCheck,
  type ConnectorAppVerificationBinding,
} from "./check";

// The explicit check coordinator is scripted: its own claim/prepare/advance
// protocol is tested with the coordinator. This file covers what the host adds
// around it, namely refusal order, admission reservations, the late reads
// across each await, and publication of the attachment after a first check.
type RunArguments = [
  { kind: string; operationId: string; taskId: string },
  unknown,
  () => Promise<unknown>,
];
const run = vi.hoisted(() => ({
  impl: null as null | ((...values: unknown[]) => Promise<unknown>),
}));
vi.mock("../connection-check-command", async (original) => ({
  ...(await original<object>()),
  runExplicitConnectionCheck: (...values: unknown[]) => run.impl!(...values),
}));

const operationId = "0311add3-b03c-4f89-b916-aea6a0a39242";
const challengeValue = "00000000-0000-4000-8000-000000000003";
const receiptSha256 = "f".repeat(64);
const command = {
  kind: "connector.test-connection" as const,
  operationId,
  taskId: "",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

/** The settings of an app whose attachment has not been proven yet, or one that
 * already has it. */
function settingsFor(mode: "pending" | "attached") {
  const settings = guidedSettingsFixture();
  const connector = settings.connectors.secureMcp;
  connector.chatgptApp = {
    name: "Farol Dev",
    tunnelId: connector.tunnelId!,
    connectorGeneration: connector.generation,
  };
  connector.appVerificationPending = false;
  settings.setup.connect.outcomeUnknown = false;
  if (mode === "pending") {
    connector.attachment = null;
    connector.challenge = {
      value: challengeValue,
      challengeSha256: connectionCheckDigest(challengeValue),
      runtimeGeneration: connector.runtime!.runtimeGeneration,
      computerGeneration: 1,
      buildId: fixtureBuildId,
      preparedAt: "2026-01-01T00:00:00.000Z",
    };
  } else {
    connector.challenge = null;
  }
  return settings;
}

function build(mode: "pending" | "attached" = "pending") {
  const settings = settingsFor(mode);
  const connector = settings.connectors.secureMcp;
  const events: string[] = [];
  const binding = {
    buildId: fixtureBuildId,
    profileId: "profile",
    backendGeneration: "backend",
    runtimeId: "runtime",
    connectorGeneration: String(connector.generation),
  };
  type Receipt = { binding: typeof binding; challengeSha256: string };
  type Proof = {
    binding: typeof binding;
    receiptSha256: string;
    receipt?: Receipt & { workspaceId: string };
    catalogueReceipt?: Receipt & { workspaceCount: number };
  };
  const proofFor = (
    challengeSha256: string,
    workspaceId: string | null,
  ): Proof => ({
    binding,
    receiptSha256,
    ...(workspaceId === null
      ? { catalogueReceipt: { binding, challengeSha256, workspaceCount: 0 } }
      : { receipt: { binding, challengeSha256, workspaceId } }),
  });
  const state = {
    settings: settings as typeof settings,
    observed: { binding } as Record<string, unknown>,
    snapshotStatus: "ready" as "ready" | "error",
    quitAfterObserve: false,
  };
  const authenticated = {
    state: "authenticated" as const,
    binding: { sequence: 1, documentGeneration: 1 },
  };
  const route = {
    open: vi.fn(async () => ({ status: "opened" as const })),
    openTemporaryChat: vi.fn(async () => ({ status: "opened" as const })),
    captureManualTaskTarget: vi.fn(() => () => true),
    hasPendingReadinessDocument: vi.fn(() => false),
    observeSignInStatus: vi.fn(async () => authenticated),
    isCurrentSignInStatus: (value: unknown) => value === authenticated,
    openConnectionCheckChat: vi.fn(async () => ({ status: "opened" as const })),
    captureConnectionCheckDocument: vi.fn(() => ({
      identity: "retained-physical-document",
      current: () => true,
    })),
    runReadonlyTask: vi.fn(async () => ({ state: "completed", code: null })),
  };
  const core = {
    observeComputerConnectorVerification: vi.fn(async () => state.observed),
    claimConnectionCheck: vi.fn(),
    prepareConnectionCheck: vi.fn(),
    advanceConnectionCheck: vi.fn(),
    observeConnectionCheck: vi.fn(),
  };
  const owner = {
    snapshot: vi.fn(() =>
      state.snapshotStatus === "ready"
        ? { status: "ready" as const, settings: state.settings }
        : { status: "error" as const, error: "SETTINGS_READ_FAILED" },
    ),
    recordSecureMcpAttachment: vi.fn(async (_input: object) => {
      events.push("attachment-recorded");
      return { ok: true, snapshot: owner.snapshot() };
    }),
    recordSecureMcpChallenge: vi.fn(async (input: Record<string, unknown>) => {
      events.push("challenge-minted");
      connector.challenge = {
        value: String(input.challenge),
        challengeSha256: connectionCheckDigest(String(input.challenge)),
        runtimeGeneration: String(input.runtimeGeneration),
        computerGeneration: Number(input.computerGeneration),
        buildId: String(input.buildId),
        preparedAt: "2026-01-01T00:00:00.000Z",
      };
      return { ok: true, snapshot: owner.snapshot() };
    }),
  };
  const runtime = {
    isRunning: vi.fn(() => true),
    hasUnresolvedEffect: vi.fn(() => false),
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
  const reservations: string[] = [];
  const reserveAdmitted = admission.reserveAdmitted.bind(admission);
  vi.spyOn(admission, "reserveAdmitted").mockImplementation((kind, purpose) => {
    reservations.push(kind);
    return reserveAdmitted(kind, purpose);
  });
  const window = { isDestroyed: vi.fn(() => false) };
  const connection = {
    sample: vi.fn(async () => ({ sampled: true })),
  };
  const fixture: Record<string, unknown> = {
    configuration: owner,
    secureMcpConnectorRuntime: runtime,
    desktopGoCore: core,
    chatGptRoute: route,
    window,
    selectedTaskId: "",
    liveTaskRoutes: new Map(),
    desktopAdmission: admission,
    buildIdentity: { buildId: fixtureBuildId },
    randomUUID: () => "00000000-0000-4000-8000-0000000000aa",
    connectorVerificationProof,
    statePaths: () => ({ secureMcpLaunch: "/synthetic-no-filesystem" }),
    configurationFailure: (error: string) => ({ ok: false, error }),
    embeddedBrowserEnabled: () => true,
    connectorAppVerificationAttemptExists: vi.fn(async () => false),
    connectorConnection: connection,
    currentConnectionStatus: vi.fn(),
  };
  const check = createConnectorCheck(connectorCheckHost(fixture));
  /** Maps a refusal thrown by the capture as the coordinator does. */
  run.impl = async (...values: unknown[]) => {
    const [cmd, , capture] = values as RunArguments;
    try {
      await capture();
    } catch (error) {
      if (error instanceof ConnectionCheckRefusal)
        return {
          state: "refused",
          operationId: cmd.operationId,
          code: error.code,
        };
      throw error;
    }
    // Go retains the receipt once a first check is verified.
    state.observed = proofFor(
      connector.challenge?.challengeSha256 ??
        connector.attachment!.challengeSha256,
      settings.computer.workspaces.length === 0 ? null : fixtureWorkspaceId,
    );
    return {
      state: "verified",
      operationId: cmd.operationId,
      receiptDigest: "d".repeat(64),
      retained: false,
    };
  };
  const replaceSettings = (change: (next: typeof settings) => void) => {
    const next = structuredClone(state.settings);
    change(next);
    state.settings = next;
  };
  return {
    check,
    fixture,
    replaceSettings,
    settings,
    connector,
    owner,
    runtime,
    core,
    route,
    window,
    connection,
    admission,
    reservations,
    events,
    state,
    proofFor,
    binding,
  };
}
type Fixture = ReturnType<typeof build>;

const failure = (error: string) => ({ ok: false, error });
/** The attachment publications: each reserves connector admission on its own,
 * after the check that asked for it has released its two. */
const publications = (f: Fixture) =>
  f.reservations.filter((kind) => kind === "connector-task").length -
  f.reservations.filter((kind) => kind === "chatgpt-task").length;

afterEach(() => {
  vi.restoreAllMocks();
  run.impl = null;
});

describe("connectorAppBindingCurrent", () => {
  function expected(f: Fixture): ConnectorAppVerificationBinding {
    return {
      tunnelId: f.connector.tunnelId!,
      connectorGeneration: f.connector.generation,
      computerGeneration: f.settings.computer.generation,
      runtimeGeneration: f.connector.runtime!.runtimeGeneration,
      challengeSha256: f.connector.challenge!.challengeSha256,
      buildId: fixtureBuildId,
      workspaceId: fixtureWorkspaceId,
      appName: "Farol Dev",
    };
  }

  it("accepts the exact binding, with or without the app name", () => {
    const f = build();
    expect(connectorAppBindingCurrent(f.settings, expected(f))).toBe(true);
    const { appName: _appName, ...withoutApp } = expected(f);
    expect(connectorAppBindingCurrent(f.settings, withoutApp)).toBe(true);
  });

  it.each([
    [
      "computer generation",
      (f: Fixture) => void (f.settings.computer.generation += 1),
    ],
    ["tunnel id", (f: Fixture) => void (f.connector.tunnelId = "other-tunnel")],
    [
      "connector generation",
      (f: Fixture) => void (f.connector.generation += 1),
    ],
    [
      "runtime generation",
      (f: Fixture) =>
        void (f.connector.runtime!.runtimeGeneration = "f".repeat(64)),
    ],
    [
      "runtime build",
      (f: Fixture) => void (f.connector.runtime!.buildId = "e".repeat(64)),
    ],
    [
      "challenge",
      (f: Fixture) =>
        void (f.connector.challenge!.challengeSha256 = "e".repeat(64)),
    ],
    [
      "selected app",
      (f: Fixture) => void (f.connector.chatgptApp!.name = "Other"),
    ],
    [
      "workspace selection",
      (f: Fixture) => void (f.settings.computer.workspaces = []),
    ],
  ])("rejects a changed %s", (_name, change) => {
    const f = build();
    const binding = expected(f);
    change(f);
    expect(connectorAppBindingCurrent(f.settings, binding)).toBe(false);
  });

  it("falls back to the current attachment's challenge once the challenge is consumed", () => {
    const f = build("attached");
    const binding: ConnectorAppVerificationBinding = {
      tunnelId: f.connector.tunnelId!,
      connectorGeneration: f.connector.generation,
      computerGeneration: f.settings.computer.generation,
      runtimeGeneration: f.connector.runtime!.runtimeGeneration,
      challengeSha256: f.connector.attachment!.challengeSha256,
      buildId: fixtureBuildId,
      workspaceId: fixtureWorkspaceId,
    };
    expect(connectorAppBindingCurrent(f.settings, binding)).toBe(true);
    expect(
      connectorAppBindingCurrent(f.settings, {
        ...binding,
        challengeSha256: "e".repeat(64),
      }),
    ).toBe(false);
  });
});

describe("checkSecureMcpAttachment", () => {
  it.each(["configuration", "secureMcpConnectorRuntime"])(
    "refuses a missing %s before reserving admission",
    async (name) => {
      const f = build();
      f.fixture[name] = null;
      expect(await f.check.checkSecureMcpAttachment()).toEqual(
        failure("SETTINGS_UNAVAILABLE"),
      );
      expect(f.reservations).toEqual([]);
    },
  );

  it("refuses while a connector task is running, and leaves that task's reservation alone", async () => {
    const f = build();
    const held = f.admission.reserveAdmitted("connector-task");
    f.reservations.length = 0;
    expect(await f.check.checkSecureMcpAttachment()).toEqual(
      failure("CONNECTOR_ALREADY_RUNNING"),
    );
    expect(f.reservations).toEqual([]);
    expect(f.admission.occupied("connector-task")).toBe(true);
    held.release();
  });

  it("holds connector admission while it reads Go and releases it afterwards", async () => {
    const f = build();
    f.state.observed = f.proofFor(
      f.connector.challenge!.challengeSha256,
      fixtureWorkspaceId,
    );
    let during: boolean | null = null;
    f.core.observeComputerConnectorVerification.mockImplementation(
      (async () => {
        during = f.admission.occupied("connector-task");
        return f.state.observed;
      }) as never,
    );
    await f.check.checkSecureMcpAttachment();
    expect(during).toBe(true);
    expect(f.reservations).toEqual(["connector-task"]);
    expect(f.admission.occupied("connector-task")).toBe(false);
  });

  it("releases connector admission when its reads throw", async () => {
    const f = build();
    f.owner.snapshot.mockImplementation(() => {
      throw new Error("SNAPSHOT_THREW");
    });
    await expect(f.check.checkSecureMcpAttachment()).rejects.toThrow(
      "SNAPSHOT_THREW",
    );
    expect(f.admission.occupied("connector-task")).toBe(false);
  });

  it("refuses unavailable Settings after reserving", async () => {
    const f = build();
    f.state.snapshotStatus = "error";
    expect(await f.check.checkSecureMcpAttachment()).toEqual(
      failure("SETTINGS_UNAVAILABLE"),
    );
    expect(f.admission.occupied("connector-task")).toBe(false);
  });

  it("refuses a binding that is no longer current before reading Go", async () => {
    const f = build();
    expect(
      await f.check.checkSecureMcpAttachment(undefined, {
        tunnelId: "stale",
        connectorGeneration: 1,
        computerGeneration: 1,
        runtimeGeneration: "x",
        challengeSha256: "y",
        buildId: fixtureBuildId,
        workspaceId: fixtureWorkspaceId,
      }),
    ).toEqual(failure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED"));
    expect(f.core.observeComputerConnectorVerification).not.toHaveBeenCalled();
  });

  it("returns an already current attachment without reading Go or writing", async () => {
    const f = build("attached");
    const result = await f.check.checkSecureMcpAttachment(fixtureWorkspaceId);
    expect(result).toMatchObject({
      ok: true,
      evidence: {
        kind: "connector.attachment",
        workspaceId: fixtureWorkspaceId,
        receiptSha256: "d".repeat(64),
      },
    });
    expect(f.core.observeComputerConnectorVerification).not.toHaveBeenCalled();
    expect(f.owner.recordSecureMcpAttachment).not.toHaveBeenCalled();
  });

  it("refuses an expected workspace that is not the selection", async () => {
    const f = build();
    expect(await f.check.checkSecureMcpAttachment("other-workspace")).toEqual(
      failure("CONNECTOR_ATTACHMENT_INVALID"),
    );
    expect(f.core.observeComputerConnectorVerification).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a runtime that is not ready",
      (f: Fixture) => void (f.connector.runtime!.state = "unreachable"),
    ],
    [
      "a consumed challenge",
      (f: Fixture) => void (f.connector.challenge = null),
    ],
    [
      "a tunnel that is not running",
      (f: Fixture) => void f.runtime.isRunning.mockReturnValue(false),
    ],
  ])("refuses %s as an unavailable challenge", async (_name, change) => {
    const f = build();
    change(f);
    expect(await f.check.checkSecureMcpAttachment()).toEqual(
      failure("CONNECTOR_CHALLENGE_UNAVAILABLE"),
    );
    expect(f.core.observeComputerConnectorVerification).not.toHaveBeenCalled();
  });

  it("refuses without a Go core, or when Go cannot be read", async () => {
    const f = build();
    f.fixture.desktopGoCore = null;
    expect(await f.check.checkSecureMcpAttachment()).toEqual(
      failure("CONNECTOR_ATTACHMENT_INVALID"),
    );
    f.fixture.desktopGoCore = f.core;
    f.core.observeComputerConnectorVerification.mockRejectedValueOnce(
      new Error("GO_DOWN"),
    );
    expect(await f.check.checkSecureMcpAttachment()).toEqual(
      failure("CONNECTOR_ATTACHMENT_INVALID"),
    );
    expect(f.owner.recordSecureMcpAttachment).not.toHaveBeenCalled();
  });

  it("refuses when Go holds no proof yet", async () => {
    const f = build();
    expect(await f.check.checkSecureMcpAttachment()).toEqual(
      failure("CONNECTOR_ATTACHMENT_NOT_FOUND"),
    );
  });

  it.each([
    [
      "another challenge",
      (f: Fixture) => f.proofFor("e".repeat(64), fixtureWorkspaceId),
    ],
    [
      "another build",
      (f: Fixture) => {
        const proof = f.proofFor(
          f.connector.challenge!.challengeSha256,
          fixtureWorkspaceId,
        );
        return {
          ...proof,
          receipt: {
            ...proof.receipt!,
            binding: { ...f.binding, buildId: "e".repeat(64) },
          },
        };
      },
    ],
    [
      "another connector generation",
      (f: Fixture) => {
        const proof = f.proofFor(
          f.connector.challenge!.challengeSha256,
          fixtureWorkspaceId,
        );
        return {
          ...proof,
          receipt: {
            ...proof.receipt!,
            binding: { ...f.binding, connectorGeneration: "99" },
          },
        };
      },
    ],
    [
      "no receipt digest",
      (f: Fixture) => ({
        ...f.proofFor(
          f.connector.challenge!.challengeSha256,
          fixtureWorkspaceId,
        ),
        receiptSha256: undefined,
      }),
    ],
    [
      "another workspace",
      (f: Fixture) =>
        f.proofFor(f.connector.challenge!.challengeSha256, "other-workspace"),
    ],
  ])("refuses a receipt for %s", async (_name, receipt) => {
    const f = build();
    f.state.observed = receipt(f);
    expect(await f.check.checkSecureMcpAttachment()).toEqual(
      failure("CONNECTOR_ATTACHMENT_INVALID"),
    );
    expect(f.owner.recordSecureMcpAttachment).not.toHaveBeenCalled();
  });

  it("refuses a receipt for a workspace other than the one expected", async () => {
    const f = build();
    f.state.observed = f.proofFor(
      f.connector.challenge!.challengeSha256,
      fixtureWorkspaceId,
    );
    expect(await f.check.checkSecureMcpAttachment("other-workspace")).toEqual(
      failure("CONNECTOR_ATTACHMENT_INVALID"),
    );
  });

  it("records the attachment once and returns its evidence", async () => {
    const f = build();
    f.state.observed = f.proofFor(
      f.connector.challenge!.challengeSha256,
      fixtureWorkspaceId,
    );
    const result = await f.check.checkSecureMcpAttachment(fixtureWorkspaceId);
    expect(f.owner.recordSecureMcpAttachment).toHaveBeenCalledExactlyOnceWith({
      workspaceId: fixtureWorkspaceId,
      runtimeGeneration: f.connector.runtime!.runtimeGeneration,
      computerGeneration: 1,
      buildId: fixtureBuildId,
      challengeSha256: f.connector.challenge!.challengeSha256,
      receiptSha256,
    });
    expect(result).toMatchObject({
      ok: true,
      evidence: {
        kind: "connector.attachment",
        workspaceId: fixtureWorkspaceId,
        receiptSha256,
      },
    });
  });

  it("returns the owner's refusal when the attachment cannot be recorded", async () => {
    const f = build();
    f.state.observed = f.proofFor(
      f.connector.challenge!.challengeSha256,
      fixtureWorkspaceId,
    );
    f.owner.recordSecureMcpAttachment.mockResolvedValueOnce({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      snapshot: f.owner.snapshot(),
    } as never);
    expect(await f.check.checkSecureMcpAttachment()).toMatchObject({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
    });
  });

  // Every change below lands while Go is being read, as a new Settings value
  // (the owner replaces its snapshot; it never edits the one already read).
  // None of them may be published.
  it.each([
    ["Settings gone", (f: Fixture) => void (f.state.snapshotStatus = "error")],
    [
      "a different Go core",
      (f: Fixture) => void (f.fixture.desktopGoCore = { other: true }),
    ],
    [
      "a new computer generation",
      (f: Fixture) =>
        f.replaceSettings((s) => void (s.computer.generation += 1)),
    ],
    [
      "a new connector generation",
      (f: Fixture) =>
        f.replaceSettings((s) => void (s.connectors.secureMcp.generation += 1)),
    ],
    [
      "a new runtime generation",
      (f: Fixture) =>
        f.replaceSettings(
          (s) =>
            void (s.connectors.secureMcp.runtime!.runtimeGeneration =
              "f".repeat(64)),
        ),
    ],
    [
      "a consumed challenge",
      (f: Fixture) =>
        f.replaceSettings(
          (s) => void (s.connectors.secureMcp.challenge = null),
        ),
    ],
  ])("does not record when %s during the Go read", async (_name, change) => {
    const f = build();
    f.state.observed = f.proofFor(
      f.connector.challenge!.challengeSha256,
      fixtureWorkspaceId,
    );
    f.core.observeComputerConnectorVerification.mockImplementationOnce(
      (async () => {
        const observed = f.state.observed;
        change(f);
        return observed;
      }) as never,
    );
    expect(await f.check.checkSecureMcpAttachment()).toEqual(
      failure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED"),
    );
    expect(f.owner.recordSecureMcpAttachment).not.toHaveBeenCalled();
  });

  it("does not record when the verification binding went stale during the Go read", async () => {
    const f = build();
    const binding = {
      tunnelId: f.connector.tunnelId!,
      connectorGeneration: f.connector.generation,
      computerGeneration: 1,
      runtimeGeneration: f.connector.runtime!.runtimeGeneration,
      challengeSha256: f.connector.challenge!.challengeSha256,
      buildId: fixtureBuildId,
      workspaceId: fixtureWorkspaceId,
      appName: "Farol Dev",
    };
    f.state.observed = f.proofFor(binding.challengeSha256, fixtureWorkspaceId);
    f.core.observeComputerConnectorVerification.mockImplementationOnce(
      (async () => {
        const observed = f.state.observed;
        f.replaceSettings(
          (s) => void (s.connectors.secureMcp.chatgptApp!.name = "Changed"),
        );
        return observed;
      }) as never,
    );
    expect(
      await f.check.checkSecureMcpAttachment(fixtureWorkspaceId, binding),
    ).toEqual(failure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED"));
    expect(f.owner.recordSecureMcpAttachment).not.toHaveBeenCalled();
  });
});

describe("testConnectionCommand refusals before any claim", () => {
  it.each(["desktopGoCore", "configuration"])(
    "refuses a missing %s without reserving or reaching the coordinator",
    async (name) => {
      const f = build();
      f.fixture[name] = null;
      run.impl = vi.fn();
      expect(await f.check.testConnectionCommand(command)).toEqual(
        failure("CONNECTION_CHECK_HOST_NOT_READY"),
      );
      expect(run.impl).not.toHaveBeenCalled();
      expect(f.reservations).toEqual([]);
      expect(f.connection.sample).not.toHaveBeenCalled();
    },
  );

  it.each(["chatgpt-task", "connector-task"] as const)(
    "refuses while %s is held, before Go's first claim, leaving that hold alone",
    async (kind) => {
      const f = build();
      const held = f.admission.reserveAdmitted(kind);
      f.reservations.length = 0;
      run.impl = vi.fn();
      expect(await f.check.testConnectionCommand(command)).toEqual(
        failure("CHATGPT_TASK_IN_PROGRESS"),
      );
      expect(run.impl).not.toHaveBeenCalled();
      expect(f.reservations).toEqual([]);
      expect(f.admission.occupied(kind)).toBe(true);
      held.release();
    },
  );
});

describe("testConnectionCommand admission and sampling", () => {
  it.each([
    ["selected-task", "manual-diagnostic"],
    ["setup", null],
  ] as const)(
    "reserves both routes before the coordinator runs, with purpose for %s",
    async (origin, purpose) => {
      const f = build();
      let seen: unknown[] | null = null;
      run.impl = async (...values: unknown[]) => {
        seen = [
          f.admission.occupied("chatgpt-task"),
          f.admission.occupied("connector-task"),
          f.admission.connectorTaskAdmissionPurpose,
        ];
        return {
          state: "refused",
          operationId: (values[0] as { operationId: string }).operationId,
          code: "CONNECTION_CHECK_BLOCKED",
        };
      };
      await f.check.testConnectionCommand(command, origin);
      expect(seen).toEqual([true, true, purpose]);
      expect(f.reservations).toEqual(["chatgpt-task", "connector-task"]);
    },
  );

  it("releases both and samples the connection afterwards, reporting its status", async () => {
    const f = build();
    let heldAtSample: boolean | null = null;
    f.connection.sample.mockImplementation((async () => {
      heldAtSample =
        f.admission.occupied("chatgpt-task") ||
        f.admission.occupied("connector-task");
      return { sampled: true };
    }) as never);
    await f.check.testConnectionCommand(command);
    await vi.waitFor(() =>
      expect(f.fixture.currentConnectionStatus).toHaveBeenCalled(),
    );
    expect(heldAtSample).toBe(false);
    expect(f.fixture.currentConnectionStatus).toHaveBeenCalledExactlyOnceWith({
      sampled: true,
    });
  });

  it("releases both, samples and rethrows when the coordinator throws", async () => {
    const f = build();
    run.impl = async () => {
      throw new Error("COORDINATOR_THREW");
    };
    await expect(f.check.testConnectionCommand(command)).rejects.toThrow(
      "COORDINATOR_THREW",
    );
    expect(f.admission.occupied("chatgpt-task")).toBe(false);
    expect(f.admission.occupied("connector-task")).toBe(false);
    expect(f.connection.sample).toHaveBeenCalledOnce();
  });

  it("does not let a failing sample change the result or reject", async () => {
    const f = build("attached");
    f.connection.sample.mockRejectedValue(new Error("SAMPLE_FAILED"));
    run.impl = async (...values: unknown[]) => ({
      state: "verified",
      operationId,
      receiptDigest: "d".repeat(64),
      retained: true,
      ...(values.length === 0 ? {} : {}),
    });
    expect(await f.check.testConnectionCommand(command)).toMatchObject({
      ok: true,
    });
    await Promise.resolve();
    expect(f.fixture.currentConnectionStatus).not.toHaveBeenCalled();
  });
});

describe("testConnectionCommand prerequisites inside the first claim", () => {
  async function refused(f: Fixture, taskId = command.taskId) {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await f.check.testConnectionCommand({ ...command, taskId });
    return { result, logged: error.mock.calls.map((call) => String(call[0])) };
  }
  const prerequisites = failure("CONNECTION_CHECK_PREREQUISITES_REQUIRED");

  it.each([
    [
      "the embedded browser is off",
      (f: Fixture) => void (f.fixture.embeddedBrowserEnabled = () => false),
      "CONNECTION_CHECK_HOST_NOT_READY",
    ],
    [
      "the desktop is closing",
      (f: Fixture) => void f.admission.beginQuit(),
      "CONNECTION_CHECK_HOST_NOT_READY",
    ],
    [
      "the selected task changed",
      (f: Fixture) => void (f.fixture.selectedTaskId = "other-task"),
      "CONNECTION_CHECK_HOST_NOT_READY",
    ],
    [
      "there is no browser route",
      (f: Fixture) => void (f.fixture.chatGptRoute = null),
      "CONNECTION_CHECK_PREREQUISITES_REQUIRED",
    ],
    [
      "the window is gone",
      (f: Fixture) => void (f.fixture.window = null),
      "CONNECTION_CHECK_PREREQUISITES_REQUIRED",
    ],
    [
      "the window is destroyed",
      (f: Fixture) => void f.window.isDestroyed.mockReturnValue(true),
      "CONNECTION_CHECK_PREREQUISITES_REQUIRED",
    ],
    [
      "no original document can be captured",
      (f: Fixture) =>
        void f.route.captureManualTaskTarget.mockReturnValue(null as never),
      "CONNECTION_CHECK_PREREQUISITES_REQUIRED",
    ],
    [
      "Settings are unavailable",
      (f: Fixture) => void (f.state.snapshotStatus = "error"),
      "CONNECTION_CHECK_HOST_NOT_READY",
    ],
    [
      "no app is selected",
      (f: Fixture) => void (f.connector.chatgptApp = undefined as never),
      "CONNECTION_CHECK_CONNECTOR_NOT_SET_UP",
    ],
    [
      "there is no tunnel",
      (f: Fixture) => void (f.connector.tunnelId = null),
      "CONNECTION_CHECK_CONNECTOR_NOT_SET_UP",
    ],
    [
      "the runtime is unreachable",
      (f: Fixture) => void (f.connector.runtime!.state = "unreachable"),
      "CONNECTION_CHECK_RUNTIME_NOT_RUNNING",
    ],
    [
      "the runtime outcome is unknown",
      (f: Fixture) => void (f.connector.runtime!.state = "outcome_unknown"),
      "CONNECTION_CHECK_SETUP_UNRESOLVED",
    ],
    [
      "the runtime is another build",
      (f: Fixture) => void (f.connector.runtime!.buildId = "e".repeat(64)),
      "CONNECTION_CHECK_CONNECTOR_NOT_SET_UP",
    ],
    [
      "the runtime is not running",
      (f: Fixture) => void f.runtime.isRunning.mockReturnValue(false),
      "CONNECTION_CHECK_RUNTIME_NOT_RUNNING",
    ],
    [
      "the runtime has an unresolved effect",
      (f: Fixture) => void f.runtime.hasUnresolvedEffect.mockReturnValue(true),
      "CONNECTION_CHECK_SETUP_UNRESOLVED",
    ],
  ])("refuses with the matching cause when %s", async (_name, change, code) => {
    const f = build();
    change(f);
    const { result, logged } = await refused(f);
    expect(result).toEqual(failure(code));
    expect(
      logged.some((line) => line.startsWith("FAROL_CONNECTION_CHECK_REFUSED")),
    ).toBe(true);
    expect(f.route.runReadonlyTask).not.toHaveBeenCalled();
    expect(f.core.observeComputerConnectorVerification).not.toHaveBeenCalled();
  });

  it.each([
    [
      "build=false",
      (f: Fixture) => void (f.connector.runtime!.buildId = "e".repeat(64)),
    ],
    [
      "computer=false",
      (f: Fixture) => void (f.connector.runtime!.computerGeneration += 1),
    ],
    [
      "connector=false",
      (f: Fixture) => void (f.connector.runtime!.connectorGeneration += 1),
    ],
    [
      "running=false",
      (f: Fixture) => void f.runtime.isRunning.mockReturnValue(false),
    ],
    [
      "unresolved=true",
      (f: Fixture) => void f.runtime.hasUnresolvedEffect.mockReturnValue(true),
    ],
  ])("names %s in a ready runtime's refusal", async (field, change) => {
    const f = build();
    change(f);
    const { logged } = await refused(f);
    const line = logged.find((entry) =>
      entry.startsWith("FAROL_CONNECTION_CHECK_REFUSED runtime "),
    );
    expect(line).toContain("state=ready");
    expect(line).toContain(field);
  });

  it("uses the selected task's own browser route, not the Setup route", async () => {
    const f = build();
    const taskRoute = {
      ...f.route,
      captureManualTaskTarget: vi.fn(() => null),
    };
    (f.fixture.liveTaskRoutes as Map<string, unknown>).set("task-a", taskRoute);
    f.fixture.selectedTaskId = "task-a";
    const { result } = await refused(f, "task-a");
    expect(result).toEqual(prerequisites);
    expect(taskRoute.captureManualTaskTarget).toHaveBeenCalledOnce();
    expect(f.route.captureManualTaskTarget).not.toHaveBeenCalled();
  });

  it("keeps the Setup route for Setup even while a task is selected", async () => {
    const f = build();
    f.fixture.selectedTaskId = "task-a";
    let browser: unknown = null;
    run.impl = async (...values: unknown[]) => {
      browser = await (values as RunArguments)[2]();
      return {
        state: "refused",
        operationId,
        code: "CONNECTION_CHECK_BLOCKED",
      };
    };
    await f.check.testConnectionCommand(
      { ...command, taskId: "task-a" },
      "setup",
    );
    expect(browser).not.toBeNull();
    expect(f.route.captureManualTaskTarget).toHaveBeenCalled();
  });

  it.each([
    [
      "an unresolved Setup connect",
      (f: Fixture) => void (f.settings.setup.connect.outcomeUnknown = true),
    ],
    [
      "a pending app verification",
      (f: Fixture) => void (f.connector.appVerificationPending = true),
    ],
  ])(
    "names %s as unresolved, not as a check still running",
    async (_name, change) => {
      const f = build();
      change(f);
      const result = await f.check.testConnectionCommand(command);
      expect(result).toEqual(failure("CONNECTION_CHECK_SETUP_UNRESOLVED"));
      expect(
        f.core.observeComputerConnectorVerification,
      ).not.toHaveBeenCalled();
    },
  );

  it("refuses a retained proof for a workspace other than the selection", async () => {
    const f = build("attached");
    f.state.observed = f.proofFor("c".repeat(64), "other-workspace");
    expect(await f.check.testConnectionCommand(command)).toEqual(
      failure("CONNECTION_CHECK_OWNER_CHANGED"),
    );
  });

  it("refuses when the legacy challenge fuse already holds a bootstrap attempt", async () => {
    const f = build();
    (
      f.fixture.connectorAppVerificationAttemptExists as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValue(true);
    expect(await f.check.testConnectionCommand(command)).toEqual(
      failure("CONNECTION_CHECK_ALREADY_ATTEMPTED"),
    );
    expect(f.route.runReadonlyTask).not.toHaveBeenCalled();
  });

  it("does not read the legacy fuse when Go already holds the proof", async () => {
    const f = build("attached");
    f.state.observed = f.proofFor(
      f.connector.attachment!.challengeSha256,
      fixtureWorkspaceId,
    );
    await f.check.testConnectionCommand(command);
    expect(
      f.fixture.connectorAppVerificationAttemptExists,
    ).not.toHaveBeenCalled();
  });

  it("mints a fresh challenge against the live runtime when Go holds no proof and the old one is gone", async () => {
    const f = build("attached");
    await f.check.testConnectionCommand(command);
    expect(f.owner.recordSecureMcpChallenge).toHaveBeenCalledExactlyOnceWith({
      challenge: "00000000-0000-4000-8000-0000000000aa",
      runtimeGeneration: f.connector.runtime!.runtimeGeneration,
      computerGeneration: 1,
      buildId: fixtureBuildId,
    });
  });

  it("does not mint when the existing challenge is still current", async () => {
    const f = build();
    await f.check.testConnectionCommand(command);
    expect(f.owner.recordSecureMcpChallenge).not.toHaveBeenCalled();
  });

  it.each([
    ["refuses", async () => ({ ok: false, error: "SETTINGS_WRITE_FAILED" })],
    [
      "answers with unavailable Settings",
      async () => ({
        ok: true,
        snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
      }),
    ],
  ])(
    "refuses with prerequisites when minting a challenge %s",
    async (_name, mint) => {
      const f = build("attached");
      f.owner.recordSecureMcpChallenge.mockImplementation(mint as never);
      const { result } = await refused(f);
      expect(result).toEqual(prerequisites);
    },
  );

  it("refuses with prerequisites when the minted challenge is not for this runtime", async () => {
    const f = build("attached");
    f.owner.recordSecureMcpChallenge.mockImplementation((async () => {
      f.connector.challenge = {
        value: "stale",
        challengeSha256: "s".repeat(64),
        runtimeGeneration: "someone-else",
        computerGeneration: 1,
        buildId: fixtureBuildId,
        preparedAt: "2026-01-01T00:00:00.000Z",
      };
      return { ok: true, snapshot: f.owner.snapshot() };
    }) as never);
    const { result } = await refused(f);
    expect(result).toEqual(prerequisites);
  });

  it("selects bootstrap with the challenge value when Go holds no proof", async () => {
    const f = build();
    let browser: { selection: Record<string, unknown> } | null = null;
    run.impl = async (...values: unknown[]) => {
      browser = (await (values as RunArguments)[2]()) as never;
      return {
        state: "refused",
        operationId,
        code: "CONNECTION_CHECK_BLOCKED",
      };
    };
    await f.check.testConnectionCommand(command);
    expect(browser!.selection).toEqual({
      mode: "bootstrap",
      appName: "Farol Dev",
      model: "temporary-instant",
      tunnelId: f.connector.tunnelId,
      computerGeneration: "1",
      workspaceId: fixtureWorkspaceId,
      challengeDigest: connectionCheckDigest(challengeValue),
      challenge: challengeValue,
    });
  });

  it("selects status without the challenge value when Go already holds the proof", async () => {
    const f = build("attached");
    f.state.observed = f.proofFor(
      f.connector.attachment!.challengeSha256,
      fixtureWorkspaceId,
    );
    let browser: { selection: Record<string, unknown> } | null = null;
    run.impl = async (...values: unknown[]) => {
      browser = (await (values as RunArguments)[2]()) as never;
      return {
        state: "refused",
        operationId,
        code: "CONNECTION_CHECK_BLOCKED",
      };
    };
    await f.check.testConnectionCommand(command);
    expect(browser!.selection).toMatchObject({
      mode: "status",
      challengeDigest: f.connector.attachment!.challengeSha256,
    });
    expect(browser!.selection).not.toHaveProperty("challenge");
  });

  // Deliberately changed from the earlier characterization, which pinned the
  // defect: with folders configured but none currently verified, the capture
  // fell back to a workspace yet compared its binding with the strict selection
  // (undefined), so the check's own currency test always refused as
  // owner-changed and no explicit check could ever be sent. The capture and the
  // currency test now share one fallback (connectorCheckWorkspace).
  describe("folders configured but none currently verified", () => {
    /** Runs the capture, then reports the check's own currency over time. */
    async function observe(
      f: Fixture,
      afterCapture?: () => void,
    ): Promise<{
      selection: Record<string, unknown>;
      before: boolean;
      after: boolean;
    }> {
      let seen: {
        selection: Record<string, unknown>;
        before: boolean;
        after: boolean;
      } | null = null;
      run.impl = async (...values: unknown[]) => {
        const browser = (await (values as RunArguments)[2]()) as {
          selection: Record<string, unknown>;
          current: () => boolean;
        };
        const before = browser.current();
        afterCapture?.();
        seen = {
          selection: browser.selection,
          before,
          after: browser.current(),
        };
        return {
          state: "refused",
          operationId,
          code: "CONNECTION_CHECK_BLOCKED",
        };
      };
      const result = await f.check.testConnectionCommand(command);
      expect(result).toEqual(failure("CONNECTION_CHECK_BLOCKED"));
      return seen!;
    }
    const unverified = (f: Fixture) =>
      void (f.settings.setup.computer.verified!.configRevision = 999);

    it("passes the currency check and reaches dispatch with the fallback workspace", async () => {
      const f = build();
      unverified(f);
      const seen = await observe(f);
      expect(seen.before).toBe(true);
      expect(seen.after).toBe(true);
      expect(seen.selection).toMatchObject({ workspaceId: fixtureWorkspaceId });
      expect(f.route.runReadonlyTask).not.toHaveBeenCalled();
    });

    it("falls back to the first configured folder when the verified one is gone", async () => {
      const f = build();
      f.settings.setup.computer.verified = null;
      const seen = await observe(f);
      expect(seen.before).toBe(true);
      expect(seen.selection).toMatchObject({ workspaceId: fixtureWorkspaceId });
    });

    it.each([
      [
        "the tunnel",
        (next: Fixture["settings"]) =>
          void (next.connectors.secureMcp.tunnelId = "changed-tunnel"),
      ],
      [
        "the connector generation",
        (next: Fixture["settings"]) =>
          void (next.connectors.secureMcp.generation += 1),
      ],
      [
        "the computer generation",
        (next: Fixture["settings"]) => void (next.computer.generation += 1),
      ],
      [
        "the selected app",
        (next: Fixture["settings"]) =>
          void (next.connectors.secureMcp.chatgptApp!.name = "Another App"),
      ],
      [
        "the runtime build",
        (next: Fixture["settings"]) =>
          void (next.connectors.secureMcp.runtime!.buildId = "e".repeat(64)),
      ],
    ])(
      "still refuses as owner-changed when %s changes mid-check",
      async (_name, change) => {
        const f = build();
        unverified(f);
        const seen = await observe(f, () => f.replaceSettings(change));
        expect(seen.before).toBe(true);
        expect(seen.after).toBe(false);
      },
    );

    it("refuses as owner-changed when the fallback workspace itself changes mid-check", async () => {
      const f = build();
      f.settings.setup.computer.verified = null;
      f.settings.computer.workspaces.push({
        ...structuredClone(f.settings.computer.workspaces[0]!),
        workspaceId: "second-workspace",
      });
      const seen = await observe(f, () =>
        f.replaceSettings((next) => void next.computer.workspaces.shift()),
      );
      expect(seen.selection).toMatchObject({ workspaceId: fixtureWorkspaceId });
      expect(seen.before).toBe(true);
      expect(seen.after).toBe(false);
    });
  });

  it("selects an empty catalogue without a workspace id", async () => {
    const f = build();
    f.settings.computer.workspaces = [];
    let browser: { selection: Record<string, unknown> } | null = null;
    run.impl = async (...values: unknown[]) => {
      browser = (await (values as RunArguments)[2]()) as never;
      return {
        state: "refused",
        operationId,
        code: "CONNECTION_CHECK_BLOCKED",
      };
    };
    await f.check.testConnectionCommand(command);
    expect(browser!.selection).toMatchObject({ mode: "bootstrap" });
    expect(browser!.selection).not.toHaveProperty("workspaceId");
  });

  it("refuses with owner-changed when the binding no longer holds at capture", async () => {
    const f = build();
    f.route.captureManualTaskTarget.mockReturnValue((() => false) as never);
    expect(await f.check.testConnectionCommand(command)).toEqual(
      failure("CONNECTION_CHECK_OWNER_CHANGED"),
    );
  });

  it("builds a document readiness check that refuses on a failed probe and never sends", async () => {
    const f = build();
    f.route.observeSignInStatus.mockResolvedValue({
      state: "signed-out",
    } as never);
    let prepare: (() => Promise<unknown>) | null = null;
    run.impl = async (...values: unknown[]) => {
      const browser = (await (values as RunArguments)[2]()) as {
        prepareDocument: () => Promise<unknown>;
      };
      prepare = browser.prepareDocument;
      return {
        state: "refused",
        operationId,
        code: "CONNECTION_CHECK_BLOCKED",
      };
    };
    await f.check.testConnectionCommand(command);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(prepare!()).rejects.toMatchObject({
      code: "CONNECTION_CHECK_PREREQUISITES_REQUIRED",
    });
    expect(f.route.runReadonlyTask).not.toHaveBeenCalled();
  });
});

describe("testConnectionCommand after the coordinator", () => {
  it.each([
    ["refused", "CONNECTION_CHECK_BLOCKED"],
    ["unknown", "CONNECTION_CHECK_OUTCOME_UNKNOWN"],
  ] as const)(
    "returns the coordinator's %s code and publishes nothing",
    async (state, code) => {
      const f = build();
      run.impl = async () => ({ state, operationId, code });
      expect(await f.check.testConnectionCommand(command)).toEqual(
        failure(code),
      );
      expect(publications(f)).toBe(0);
    },
  );

  it("publishes the attachment once after a first verified check, then reports it", async () => {
    const f = build();
    const result = await f.check.testConnectionCommand(command);
    expect(result).toMatchObject({
      ok: true,
      evidence: {
        kind: "connector.connection-check",
        operationId,
        receiptSha256: "d".repeat(64),
        retained: false,
      },
    });
    expect(f.owner.recordSecureMcpAttachment).toHaveBeenCalledOnce();
    expect(publications(f)).toBe(1);
  });

  it("publishes a verified check when folders are configured but none is currently verified", async () => {
    const f = build();
    f.settings.setup.computer.verified!.configRevision = 999;
    const result = await f.check.testConnectionCommand(command);
    expect(result).toMatchObject({
      ok: true,
      evidence: { kind: "connector.connection-check", retained: false },
    });
    expect(f.owner.recordSecureMcpAttachment).toHaveBeenCalledOnce();
    expect(f.owner.recordSecureMcpAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: fixtureWorkspaceId }),
    );
    expect(publications(f)).toBe(1);
  });

  it("answers unknown, not success, when the fallback workspace changes before publication", async () => {
    const f = build();
    f.settings.setup.computer.verified = null;
    f.settings.computer.workspaces.push({
      ...structuredClone(f.settings.computer.workspaces[0]!),
      workspaceId: "second-workspace",
    });
    const dispatch = run.impl!;
    run.impl = async (...values: unknown[]) => {
      const verified = await dispatch(...values);
      // The first folder is removed after Go verified it: the fallback is now
      // another folder, so the verified workspace is no longer the owner's.
      f.replaceSettings((next) => void next.computer.workspaces.shift());
      return verified;
    };
    expect(await f.check.testConnectionCommand(command)).toEqual(
      failure("CONNECTION_CHECK_OUTCOME_UNKNOWN"),
    );
    expect(f.owner.recordSecureMcpAttachment).not.toHaveBeenCalled();
  });

  it("never publishes again for a retained result of an earlier check", async () => {
    const f = build();
    run.impl = async () => ({
      state: "verified",
      operationId,
      receiptDigest: "d".repeat(64),
      retained: true,
    });
    expect(await f.check.testConnectionCommand(command)).toMatchObject({
      ok: true,
      evidence: { retained: true },
    });
    expect(f.owner.recordSecureMcpAttachment).not.toHaveBeenCalled();
    expect(publications(f)).toBe(0);
  });

  it("answers unknown, not success, when the reply was lost and nothing was captured", async () => {
    const f = build();
    run.impl = async () => ({
      state: "verified",
      operationId,
      receiptDigest: "d".repeat(64),
      retained: false,
    });
    // Neither the binding nor the workspace was ever captured.
    expect(await f.check.testConnectionCommand(command)).toEqual(
      failure("CONNECTION_CHECK_OUTCOME_UNKNOWN"),
    );
    expect(f.owner.recordSecureMcpAttachment).not.toHaveBeenCalled();
  });

  it.each([
    [
      "Go core",
      (f: Fixture) => void (f.fixture.desktopGoCore = { other: true }),
    ],
    [
      "Settings owner",
      (f: Fixture) =>
        void (f.fixture.configuration = { snapshot: f.owner.snapshot }),
    ],
  ])(
    "answers unknown and publishes nothing when the %s changed during the check",
    async (_name, change) => {
      const f = build();
      const inner = run.impl!;
      run.impl = async (...values: unknown[]) => {
        const result = await inner(...values);
        change(f);
        return result;
      };
      expect(await f.check.testConnectionCommand(command)).toEqual(
        failure("CONNECTION_CHECK_OUTCOME_UNKNOWN"),
      );
      expect(f.owner.recordSecureMcpAttachment).not.toHaveBeenCalled();
    },
  );

  it("keeps a failed attachment write a failed write, and any other refusal unknown", async () => {
    const f = build();
    f.owner.recordSecureMcpAttachment.mockResolvedValueOnce({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      snapshot: f.owner.snapshot(),
    } as never);
    expect(await f.check.testConnectionCommand(command)).toEqual(
      failure("SETTINGS_WRITE_FAILED"),
    );
    const g = build();
    g.state.snapshotStatus = "ready";
    const inner = run.impl!;
    run.impl = async (...values: unknown[]) => {
      const result = await inner(...values);
      g.state.observed = { binding: g.binding };
      return result;
    };
    expect(await g.check.testConnectionCommand(command)).toEqual(
      failure("CONNECTION_CHECK_OUTCOME_UNKNOWN"),
    );
  });

  it("does not repeat the publication or the check when the same command is observed again", async () => {
    const f = build();
    const first = await f.check.testConnectionCommand(command);
    expect(first).toMatchObject({ ok: true });
    run.impl = async () => ({
      state: "verified",
      operationId,
      receiptDigest: "d".repeat(64),
      retained: true,
    });
    expect(await f.check.testConnectionCommand(command)).toMatchObject({
      ok: true,
      evidence: { retained: true },
    });
    expect(f.owner.recordSecureMcpAttachment).toHaveBeenCalledOnce();
    expect(f.route.runReadonlyTask).not.toHaveBeenCalled();
  });
});

// A check's page is a different one from today's: its capture is a snapshot of
// owners, and each is read afresh while the check waits.
describe("testConnectionCommand late reads", () => {
  it("sees an owner that changes while the coordinator waits", async () => {
    const f = build();
    const gate = deferred<void>();
    let current: boolean[] = [];
    run.impl = async (...values: unknown[]) => {
      const browser = (await (values as RunArguments)[2]()) as {
        current: () => boolean;
      };
      current.push(browser.current());
      await gate.promise;
      current.push(browser.current());
      f.fixture.selectedTaskId = "changed";
      current.push(browser.current());
      f.fixture.selectedTaskId = "";
      f.fixture.window = { isDestroyed: () => false };
      current.push(browser.current());
      f.fixture.window = f.window;
      f.admission.beginQuit();
      current.push(browser.current());
      return {
        state: "refused",
        operationId,
        code: "CONNECTION_CHECK_BLOCKED",
      };
    };
    const pending = f.check.testConnectionCommand(command);
    await vi.waitFor(() => expect(current.length).toBe(1));
    gate.resolve();
    await pending;
    expect(current).toEqual([true, true, false, false, false]);
  });
});
