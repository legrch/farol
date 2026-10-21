// Controlled composition ports only: no filesystem, attestation, process,
// native lease, Go child, authority, Electron or installed recovery evidence.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runStartupPreservedMaintenance } from "../../apps/desktop/recovery/maintenance";
import type { StartupPreservedSelection } from "../../apps/desktop/recovery/selection";
import type { StartupPreservedRecoveryInput } from "../../apps/desktop/bridge/preserved-recovery-host";

const ports = vi.hoisted(() => ({
  expected: vi.fn(),
  declaration: vi.fn(),
  resources: vi.fn(),
  executable: vi.fn(),
  select: vi.fn(),
  discover: vi.fn(),
  recover: vi.fn(),
  processes: vi.fn(),
  obligations: vi.fn(),
}));
vi.mock("../../apps/desktop/bridge/desktop-artifact", () => ({
  desktopCoreExpectation: ports.expected,
  readDesktopCoreDeclaration: ports.declaration,
}));
vi.mock("../../apps/desktop/bridge/core-resources", async (original) => ({
  ...(await original<
    typeof import("../../apps/desktop/bridge/core-resources")
  >()),
  verifyCoreResources: ports.resources,
}));
vi.mock("../../apps/desktop/bridge/attested-core", () => ({
  verifyCoreExecutable: ports.executable,
}));
vi.mock("../../apps/desktop/recovery/selection", () => ({
  selectStartupPreservedRecovery: ports.select,
}));
vi.mock("../../apps/desktop/bridge/preserved-inspection-child", () => ({
  discoverPreservedRecoveryChild: ports.discover,
}));
vi.mock("../../apps/desktop/bridge/preserved-recovery-host", () => ({
  recoverStartupPreservedChat: ports.recover,
}));
vi.mock("../../src/apps/desktop/closed-computer-recovery", () => ({
  assertClosedConnectorProcesses: ports.processes,
}));
vi.mock("../../src/apps/desktop/legacy-activation-obligations", () => ({
  activationObligations: ports.obligations,
}));
beforeEach(() => vi.resetAllMocks());

function fixture() {
  const root = "/private/synthetic/Farol Dev";
  const current = {
    Scope: { ProfileID: "profile", BackendGeneration: "" },
    ParentRoot: { Device: 1, Inode: 2, OwnerUID: 501 },
    ChatRoot: { Device: 1, Inode: 3, OwnerUID: 501 },
  };
  const candidate: StartupPreservedSelection = {
    profile: {
      profileId: "profile",
      root: root + "/farol-next-state/go-core",
      home: "/private/synthetic/home",
      device: "1",
      inode: "2",
    },
    exact: {
      buildId: "b".repeat(64),
      operationId: "8893a870-270c-4d55-bc02-20624596c418",
      current,
      hostLifetimeId: "maintenance-host",
      childLaunchId: "maintenance-child",
      backendGeneration: "maintenance-generation",
    },
    selectionInput: {
      Selection: {
        OperationID: "8893a870-270c-4d55-bc02-20624596c418",
        Current: structuredClone(current),
        HandoffDigest: Array(32).fill(0),
        LifecycleDigest: Array(32).fill(0),
        ResultsDigest: Array(32).fill(0),
        Next: {
          ProfileID: "profile",
          BackendGeneration: "maintenance-generation",
        },
        BuildID: "b".repeat(64),
        HostLifetimeID: "maintenance-host",
        ChildLaunchID: "maintenance-child",
      },
      OwnerID: "owner-desktop",
      ComputerID: "computer",
      AccessDigest: Array(32).fill(5),
      Mutations: [],
    },
    expectedRunSha256: "a".repeat(64),
    expectedConfigSha256: "c".repeat(64),
    recheck: vi.fn(async () => undefined),
  };
  const input: Parameters<typeof runStartupPreservedMaintenance>[0] = {
    userData: root,
    home: candidate.profile.home,
    computerId: "computer",
    artifactRoot: "/private/synthetic/artifacts",
    compiledArtifact: { fixture: "core" },
    compiledResources: { fixture: "resources" },
    build: {
      schema: 1,
      product: "Farol Next Preview",
      version: "0.2.7",
      bundleId: "local.farol.next.preview",
      updateChannel: "local-preview-only",
      builtAt: "2026-10-17T00:00:00.000Z",
      sourceCommit: "d".repeat(40),
      sourceTreeDigest: "e".repeat(64),
      sourceDirty: false,
      buildId: "b".repeat(64),
    },
    startup: {
      lease: {
        file: root + "/farol-next-state/promotion.lease",
        record: {
          schema: 1,
          generation: "b".repeat(64),
          role: "admission",
          pid: 42,
          nonce: "controlled",
          acquiredAt: "2026-10-17T00:00:00.000Z",
        },
      },
      verify: vi.fn(async () => true),
      assertCurrent: vi.fn(async () => undefined),
    },
  };
  const expected = {
    build: { fixture: "compiled-build" },
    binary: { fixture: "compiled-binary" },
  };
  const observed = structuredClone(candidate.selectionInput);
  Object.assign(observed.Selection, {
    HandoffDigest: Array(32).fill(1),
    LifecycleDigest: Array(32).fill(2),
    ResultsDigest: Array(32).fill(3),
  });
  Object.assign(observed.Selection.Current.Scope, {
    BackendGeneration: "old-unconfirmed-generation",
  });
  const result = {
    phase: "prepared_for_cold_start",
    archive: root + "/retained",
    operationId: candidate.exact.operationId,
  };
  ports.expected.mockReturnValue(expected);
  ports.declaration.mockReturnValue(expected);
  ports.resources.mockResolvedValue(undefined);
  ports.executable.mockReturnValue(
    "/private/synthetic/artifacts/farol-backend",
  );
  ports.select.mockResolvedValue(candidate);
  ports.discover.mockResolvedValue(observed);
  ports.recover.mockResolvedValue(result);
  const obligations = {
    obligations: ["QUIT_UNCONFIRMED:crash"],
    unreadable: [],
    changed: [],
  };
  ports.obligations.mockResolvedValue(obligations);
  return { input, candidate, observed, expected, result, obligations };
}

describe("one startup preserving-maintenance attempt", () => {
  it("forwards only the collector's exact legacy pin, retaining the original admission callbacks", async () => {
    const f = fixture();
    const selectedPin = Object.freeze({
      operationId: "known-old-operation",
      sha256: "f".repeat(64),
      verify: vi.fn(),
      retireInto: vi.fn(),
    });
    ports.select.mockResolvedValue({
      ...f.candidate,
      legacyPreparation: selectedPin,
    });
    const unselected = { ...selectedPin, operationId: "unselected" };
    await runStartupPreservedMaintenance({
      ...f.input,
      startup: { ...f.input.startup, legacyPreparation: unselected },
    });
    const handoff = ports.recover.mock
      .calls[0]![0] as StartupPreservedRecoveryInput;
    expect(handoff.startup.legacyPreparation).toBe(selectedPin);
    expect(handoff.startup.lease).toBe(f.input.startup.lease);
    expect(handoff.startup.verify).toBe(f.input.startup.verify);
    expect(handoff.startup.assertCurrent).toBe(f.input.startup.assertCurrent);
    expect(unselected.verify).not.toHaveBeenCalled();
    expect(unselected.retireInto).not.toHaveBeenCalled();
  });

  it("reobserves canonical scope under the original admission and forwards the complete owning guards", async () => {
    const f = fixture();
    const original = structuredClone(f.candidate.selectionInput);
    await expect(runStartupPreservedMaintenance(f.input)).resolves.toBe(
      f.result,
    );
    expect(ports.discover).toHaveBeenCalledExactlyOnceWith(
      "/private/synthetic/artifacts/farol-backend",
      f.candidate.profile,
      f.candidate.selectionInput,
      f.candidate.exact,
    );
    expect(f.candidate.recheck).toHaveBeenCalledOnce();
    expect(ports.recover).toHaveBeenCalledOnce();
    const handoff = ports.recover.mock
      .calls[0]![0] as StartupPreservedRecoveryInput;
    expect(handoff.startup).toEqual(f.input.startup);
    expect(handoff.startup.lease).toBe(f.input.startup.lease);
    expect(handoff.exact.current).toEqual(f.observed.Selection.Current);
    expect(handoff.selectionInput.Selection.Current).toEqual(
      f.observed.Selection.Current,
    );
    for (const key of [
      "HandoffDigest",
      "LifecycleDigest",
      "ResultsDigest",
    ] as const)
      expect(handoff.selectionInput.Selection[key]).toEqual(Array(32).fill(0));
    expect(handoff.expectedRunSha256).toBe(f.candidate.expectedRunSha256);
    expect(handoff.expectedConfigSha256).toBe(f.candidate.expectedConfigSha256);
    expect(handoff).not.toHaveProperty("expectedQuitSha256");
    expect(f.candidate.selectionInput).toEqual(original);
    await expect(handoff.desktopState()).resolves.toBe(f.obligations);
    expect(ports.obligations).toHaveBeenCalledExactlyOnceWith(f.input.userData);
    await handoff.attest();
    expect(ports.resources).toHaveBeenCalledTimes(2);
    handoff.processesAbsent();
    for (const spelling of ["Farol Dev", "Farol DEV"])
      for (const suffix of ["secure-mcp-connector", "go-core"])
        expect(ports.processes).toHaveBeenCalledWith(
          `/private/synthetic/${spelling}/farol-next-state/${suffix}`,
        );
  });

  it.each([
    "select",
    "declaration",
    "resources",
    "executable",
    "discover",
    "recheck",
    "recover",
    "current",
    "processes",
  ] as const)(
    "retains a %s failure without replacement or preparation retry",
    async (point) => {
      const f = fixture(),
        failure = Object.assign(Error("original outcome unknown"), {
          state: "unknown",
        });
      if (point === "current")
        vi.mocked(f.input.startup.assertCurrent).mockRejectedValue(failure);
      else if (point === "recheck")
        vi.mocked(f.candidate.recheck).mockRejectedValue(failure);
      else if (["declaration", "executable", "processes"].includes(point))
        ports[point as "declaration"].mockImplementation(() => {
          throw failure;
        });
      else ports[point as "select"].mockRejectedValue(failure);
      await expect(runStartupPreservedMaintenance(f.input)).rejects.toBe(
        failure,
      );
      if (point !== "recover") expect(ports.recover).not.toHaveBeenCalled();
      expect(ports.discover.mock.calls.length).toBeLessThanOrEqual(1);
      expect(ports.recover.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );

  it("refuses a lost original full verifier before selecting storage", async () => {
    const f = fixture();
    vi.mocked(f.input.startup.verify).mockResolvedValue(false);
    await expect(runStartupPreservedMaintenance(f.input)).rejects.toThrow(
      "STARTUP_PROMOTION_LEASE_LOST",
    );
    expect(ports.select).not.toHaveBeenCalled();
    expect(ports.discover).not.toHaveBeenCalled();
    expect(ports.recover).not.toHaveBeenCalled();
  });

  it("keeps late executable drift terminal at the forwarded host boundary", async () => {
    const f = fixture();
    await runStartupPreservedMaintenance(f.input);
    const handoff = ports.recover.mock
      .calls[0]![0] as StartupPreservedRecoveryInput;
    ports.executable.mockReturnValue("/other/farol-backend");
    await expect(handoff.attest()).rejects.toThrow(
      "STARTUP_RECOVERY_EXECUTABLE_CHANGED",
    );
    expect(ports.discover).toHaveBeenCalledOnce();
    expect(ports.recover).toHaveBeenCalledOnce();
  });
});
