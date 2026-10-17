import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recoverClosedPreservedChat,
  recoverStartupPreservedChat,
  type ClosedPreservedRecoveryInput,
  type StartupPreservedRecoveryInput,
} from "../../apps/desktop/bridge/preserved-recovery-host";
import type { PreservedRecoveryChildResult } from "../../apps/desktop/bridge/preserved-recovery-child";
import type { ClosedRecoveryState } from "../../src/apps/desktop/closed-computer-recovery";
import type { PromotionLeaseHandle } from "../../src/apps/desktop/promotion-lease";
import { MAX_RUN_MARKER_BYTES } from "../../src/apps/desktop/run-marker";
import { goCoreQuitClosers } from "../../apps/desktop/go-core-quit-closers";
import { drainOwnedChildren } from "../../src/apps/desktop/quit-drain";
import { serializeQuitReceipt } from "../../src/apps/desktop/quit-receipt";

// CPU host orchestration only. Every filesystem/process/lease/child/lifecycle
// boundary is a controlled port. The real Quit classifier and intent codec run.
// Mocked finish proves argument custody and awaiting, NOT shared finish internals,
// terminal recording, marker retention/durability, Go policy or native exclusion.
// Crash reconciliation is also a mocked port, NOT Go/native or terminal evidence.
type Mechanics =
  typeof import("../../src/apps/desktop/closed-empty-chat-recovery").closedRecoveryHostMechanics;
type Finish = Parameters<Mechanics["finish"]>[0];
type Snapshot = Awaited<ReturnType<Mechanics["snapshot"]>>;
type Inspect =
  typeof import("../../apps/desktop/bridge/preserved-inspection-child").inspectPreservedRecoveryChild;
type Prepare =
  typeof import("../../apps/desktop/bridge/preserved-recovery-child").preparePreservedRecoveryChild;
type Reconcile = {
  operationId: string;
  failedQuitSha256: string;
  proveIdle(): Promise<void>;
};
type CrashReconcile = {
  operationId: string;
  failedRunSha256: string;
  configSha256: string;
  proveIdle(): Promise<void>;
};
const ports = vi.hoisted(() => ({
  privateRoot: vi.fn<Mechanics["privateRoot"]>(),
  snapshot: vi.fn<Mechanics["snapshot"]>(),
  unchanged: vi.fn<Mechanics["unchanged"]>(),
  absent: vi.fn<Mechanics["absent"]>(),
  finish: vi.fn<Mechanics["finish"]>(),
  inspect: vi.fn<Inspect>(),
  prepare: vi.fn<Prepare>(),
  acquire:
    vi.fn<
      typeof import("../../src/apps/desktop/promotion-lease").acquirePromotionLease
    >(),
  release: vi.fn<(lease: PromotionLeaseHandle) => Promise<void>>(),
  verifyLease: vi.fn<(lease: PromotionLeaseHandle) => Promise<boolean>>(),
  fence: vi.fn<(options: { root: string }) => void>(),
  drain: vi.fn<(work: () => Promise<unknown>) => Promise<unknown>>(),
  retain:
    vi.fn<
      typeof import("../../src/apps/desktop/retained-empty-archive").retainEmptyChatForArchival
    >(),
  lifecycle: vi.fn<(root: string) => void>(),
  stop: vi.fn<() => Promise<void>>(),
  confirmStop: vi.fn<(timeoutMs: number) => Promise<void>>(),
  waitForStop: vi.fn<(timeoutMs: number) => Promise<void>>(),
  reconcile: vi.fn<(input: Reconcile) => Promise<void>>(),
  reconcileInactiveAfterCrash:
    vi.fn<(input: CrashReconcile) => Promise<void>>(),
  connectorWork: vi.fn<(root: string) => Promise<void>>(),
  legacyMembership:
    vi.fn<
      typeof import("../../apps/desktop/recovery/legacy-preparation").assertStartupLegacyPreparation
    >(),
}));
vi.mock("../../apps/desktop/recovery/legacy-preparation", () => ({
  assertStartupLegacyPreparation: ports.legacyMembership,
}));
vi.mock("../../src/apps/desktop/closed-computer-recovery", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/apps/desktop/closed-computer-recovery")
  >("../../src/apps/desktop/closed-computer-recovery");
  return { ...actual, assertClosedConnectorDurableWork: ports.connectorWork };
});
vi.mock("../../src/apps/desktop/closed-empty-chat-recovery", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/apps/desktop/closed-empty-chat-recovery")
  >("../../src/apps/desktop/closed-empty-chat-recovery");
  return {
    ...actual,
    closedRecoveryHostMechanics: {
      privateRoot: ports.privateRoot,
      snapshot: ports.snapshot,
      unchanged: ports.unchanged,
      absent: ports.absent,
      finish: ports.finish,
    },
  };
});
vi.mock("../../apps/desktop/bridge/preserved-inspection-child", () => ({
  inspectPreservedRecoveryChild: ports.inspect,
}));
vi.mock("../../apps/desktop/bridge/preserved-recovery-child", () => ({
  preparePreservedRecoveryChild: ports.prepare,
}));
vi.mock("../../src/apps/desktop/promotion-lease", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/apps/desktop/promotion-lease")
  >("../../src/apps/desktop/promotion-lease");
  return {
    ...actual,
    acquirePromotionLease: ports.acquire,
    releasePromotionLease: ports.release,
    verifyPromotionLease: ports.verifyLease,
  };
});
vi.mock("../../src/modules/computer/infra/mcp/execution-fence", () => ({
  PrivateExecutionFence: class {
    constructor(options: { root: string }) {
      ports.fence(options);
    }
    withClosedRecoveryDrain(work: () => Promise<unknown>) {
      return ports.drain(work);
    }
  },
}));
vi.mock("../../src/modules/computer/infra/mcp/private-mcp-lifecycle", () => ({
  PrivateMcpLifecycle: class {
    constructor(root: string) {
      ports.lifecycle(root);
    }
    beginClosedRecoveryStop() {
      return ports.stop();
    }
    confirmStop(timeoutMs: number) {
      return ports.confirmStop(timeoutMs);
    }
    waitForStop(timeoutMs: number) {
      return ports.waitForStop(timeoutMs);
    }
    reconcileInactive(input: Reconcile) {
      return ports.reconcile(input);
    }
    reconcileInactiveAfterCrash(input: CrashReconcile) {
      return ports.reconcileInactiveAfterCrash(input);
    }
  },
}));
vi.mock("../../src/apps/desktop/retained-empty-archive", () => ({
  retainEmptyChatForArchival: ports.retain,
}));

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const snapshot = (value: unknown, inode: number): Snapshot => ({
  bytes: Buffer.from(`${JSON.stringify(value)}\n`),
  device: 1,
  inode,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Phase =
  "before-observation" | "before-preparation" | "after-preparation" | "finish";
function fixture(
  quitScope: "previous" | "current" = "previous",
  basename: "Farol Dev" | "Farol DEV" | "Farol" = "Farol Dev",
  currentUnconfirmed: readonly string[] = ["go-core", "connector"],
) {
  const userData = path.join("/synthetic", basename);
  const state = path.join(userData, "farol-next-state");
  const profile = {
    profileId: "dev-profile",
    root: path.join(state, "go-core"),
    home: "/synthetic/home",
    device: "1",
    inode: "2",
  };
  const exact = {
    buildId: "b".repeat(64),
    operationId: "835a913b-bc20-42c6-bf56-9b83852cde3c",
    hostLifetimeId: "maintenance-host",
    childLaunchId: "maintenance-child",
    backendGeneration: "maintenance-generation",
    current: {
      Scope: {
        ProfileID: profile.profileId,
        BackendGeneration: "failed-generation",
      },
      ParentRoot: { Device: 1, Inode: 2, OwnerUID: 501 },
      ChatRoot: { Device: 1, Inode: 3, OwnerUID: 501 },
    },
  };
  const selectionInput = {
    Profile: { ProfileID: "", Root: "", Device: 0, Inode: 0 } as const,
    Selection: {
      OperationID: exact.operationId,
      Current: structuredClone(exact.current),
      HandoffDigest: Array<number>(32).fill(0),
      LifecycleDigest: Array<number>(32).fill(0),
      ResultsDigest: Array<number>(32).fill(0),
      Next: {
        ProfileID: profile.profileId,
        BackendGeneration: exact.backendGeneration,
      },
      BuildID: exact.buildId,
      HostLifetimeID: exact.hostLifetimeId,
      ChildLaunchID: exact.childLaunchId,
    },
    OwnerID: "owner",
    ComputerID: "computer",
    AccessDigest: Array<number>(32).fill(7),
    // Opaque native records. This fixture exercises the identity codec, not Go
    // validation of these records, settlement or their journal digests.
    Mutations: [
      {
        Key: "mutation",
        SHA256: "c".repeat(64),
        Binding: {
          Identity: {
            OperationID: "original-mutation",
            OwnerID: "owner",
            ProfileID: profile.profileId,
            ComputerID: "computer",
            Scope: "connector",
          },
          Connector: { SessionID: "original-connector-session" },
        },
      },
    ],
  };
  const observed = {
    ...structuredClone(selectionInput),
    Selection: {
      ...structuredClone(selectionInput.Selection),
      LifecycleDigest: Array<number>(32).fill(2),
      ResultsDigest: Array<number>(32).fill(4),
    },
  };
  const runValue = {
    schema: 1,
    pid: 314,
    startedAt: "2026-10-16T12:00:00.000Z",
    bootTime: 1000,
    processStart: "synthetic-original-start",
  };
  const quitValue = {
    schema: 1,
    at:
      quitScope === "previous"
        ? "2026-10-16T11:59:59.000Z"
        : "2026-10-16T12:00:01.000Z",
    drained: quitScope === "previous",
    unconfirmed: quitScope === "previous" ? [] : [...currentUnconfirmed],
  };
  const run = snapshot(runValue, 10);
  const config = snapshot({ profile: "original", connectorEnabled: true }, 11);
  const quit = snapshot(quitValue, 12);
  // Independent expected native value, including Go's four materialized zeros
  // and actual Profile. Do not compute this with the function under test.
  const intentValue = {
    ...structuredClone(observed),
    Mutations: observed.Mutations.map((mutation) => ({
      ...structuredClone(mutation),
      Binding: {
        ...structuredClone(mutation.Binding),
        Identity: {
          ...mutation.Binding.Identity,
          SessionID: "",
          TaskID: "",
          TaskEpoch: 0,
          ParticipantID: "",
        },
      },
    })),
    Profile: {
      ProfileID: profile.profileId,
      Root: profile.root,
      Device: 1,
      Inode: 2,
    },
  };
  const intent = snapshot(intentValue, 13);
  const archive = path.join(profile.root, `chat-retired-${exact.operationId}`);
  const chat = path.join(profile.root, "chat");
  const pending = path.join(state, "go-core.empty-recovery.pending");
  const files = new Map([
    [path.join(state, "running.json"), run],
    [path.join(state, "config.json"), config],
    [path.join(state, "last-quit.json"), quit],
    [pending, intent],
  ]);
  const child: PreservedRecoveryChildResult = {
    publication: {
      Binding: {
        ProfileID: profile.profileId,
        BackendGeneration: exact.backendGeneration,
        BuildID: exact.buildId,
        HostLifetimeID: exact.hostLifetimeId,
        ChildLaunchID: exact.childLaunchId,
        ParentRoot: { ...exact.current.ParentRoot },
        ChatRoot: { Device: 1, Inode: 4, OwnerUID: 501 },
      },
      HandoffID: exact.operationId,
      ReceiptDigest: Array<number>(32).fill(17),
    },
    acknowledgement: {
      handoffId: exact.operationId,
      receiptDigest: "11".repeat(32),
      ackDigest: "a".repeat(64),
    },
    terminal: {
      handoffId: exact.operationId,
      receiptDigest: "11".repeat(32),
      ackDigest: "a".repeat(64),
      backendGeneration: exact.backendGeneration,
      hostLifetimeId: exact.hostLifetimeId,
      childLaunchId: exact.childLaunchId,
      exitCode: "0",
      signal: "",
      forced: false,
    },
  };
  const lease: PromotionLeaseHandle = {
    file: path.join(state, "promotion.lease"),
    record: {
      schema: 1,
      generation: `preserved-chat-recovery-${exact.operationId}`,
      role: "promotion",
      pid: 42,
      nonce: "synthetic-lease",
      acquiredAt: "2026-10-16T13:00:00.000Z",
    },
  };
  const model = {
    phase: "before-observation" as Phase,
    promotionHeld: false,
    fenceHeld: false,
    roots: {
      parent: { dev: 1, ino: 2 },
      archive: { dev: 1, ino: 3 },
      chat: { dev: 1, ino: 4 },
    },
    desktop: {
      changed: [],
      unreadable: [],
      obligations:
        quitScope === "previous"
          ? ["QUIT_UNCONFIRMED:crash"]
          : [
              `QUIT_UNCONFIRMED:${currentUnconfirmed.join(",")}`,
              "QUIT_UNCONFIRMED:crash",
            ],
    } as ClosedRecoveryState,
  };
  const events: string[] = [];
  const faults = new Map<string, unknown>();
  const step = (name: string) => {
    events.push(name);
    if (faults.has(name)) throw faults.get(name);
  };
  const guarded = (name: string) => {
    expect(model.promotionHeld, name).toBe(true);
    expect(model.fenceHeld, name).toBe(true);
    step(`${model.phase}:${name}`);
  };
  const archivePin = {
    verify: vi.fn(async () => {}),
    include: vi.fn(async () => {}),
  };
  const movedArchive = vi.fn(async () => {
    guarded("archive-pin");
    return archivePin;
  });
  ports.privateRoot.mockImplementation(async (directory) => {
    const key =
      directory === profile.root
        ? "parent"
        : directory === archive
          ? "archive"
          : directory === chat
            ? "chat"
            : undefined;
    step(
      `${model.fenceHeld ? model.phase : "admission"}:root:${key ?? directory}`,
    );
    return key ? { ...model.roots[key] } : { dev: 1, ino: 99 };
  });
  ports.acquire.mockImplementation(async () => {
    step("promotion:acquire");
    model.promotionHeld = true;
    return lease;
  });
  ports.release.mockImplementation(async (actual) => {
    expect(actual).toBe(lease);
    expect(model.fenceHeld).toBe(false);
    step("promotion:release");
    model.promotionHeld = false;
  });
  ports.drain.mockImplementation(async (work) => {
    expect(model.promotionHeld).toBe(true);
    step("fence:enter");
    model.fenceHeld = true;
    try {
      return await work();
    } finally {
      model.fenceHeld = false;
      step("fence:release");
    }
  });
  ports.snapshot.mockImplementation(async (file) => {
    guarded(`snapshot:${path.basename(file)}`);
    const saved = files.get(file);
    if (!saved) throw Error(`unexpected snapshot: ${file}`);
    return saved;
  });
  ports.unchanged.mockImplementation(async (file, saved) => {
    guarded(`unchanged:${path.basename(file)}`);
    expect(saved).toBe(files.get(file));
  });
  ports.absent.mockImplementation(async (file) => {
    guarded(`absent:${path.basename(file)}`);
  });
  ports.verifyLease.mockImplementation(async (actual) => {
    expect(actual).toBe(lease);
    guarded("lease");
    return true;
  });
  ports.retain.mockImplementation(async () => {
    guarded("retain-chat");
    return movedArchive;
  });
  ports.inspect.mockImplementation(async () => {
    guarded("observe");
    model.phase = "before-preparation";
    return observed;
  });
  ports.prepare.mockImplementation(async () => {
    guarded("prepare");
    model.phase = "after-preparation";
    return child;
  });
  const result = {
    phase: "prepared_for_cold_start" as const,
    archive,
    operationId: exact.operationId,
  };
  ports.finish.mockImplementation(async () => {
    guarded("finish");
    model.phase = "finish";
    return result;
  });
  ports.lifecycle.mockImplementation(() => {
    guarded("lifecycle");
  });
  ports.connectorWork.mockImplementation(async () => {
    guarded("connector-work");
  });
  ports.stop.mockImplementation(async () => {
    guarded("stop");
  });
  ports.confirmStop.mockImplementation(async () => {
    guarded("confirm-stop");
  });
  ports.waitForStop.mockImplementation(async () => {
    guarded("wait-stop");
  });
  ports.reconcile.mockImplementation(async (input) => {
    guarded("reconcile");
    await input.proveIdle();
  });
  ports.reconcileInactiveAfterCrash.mockImplementation(async (input) => {
    guarded("reconcile-crash");
    await input.proveIdle();
    guarded("reconcile-crash:complete");
  });
  const input = {
    userData,
    executable: "/synthetic/attested/go-core",
    profile,
    exact,
    selectionInput,
    expectedRunSha256: digest(run.bytes),
    expectedConfigSha256: digest(config.bytes),
    expectedQuitSha256: digest(quit.bytes),
    desktopState: vi.fn(async () => {
      guarded("desktop");
      return model.desktop;
    }),
    processesAbsent: vi.fn(() => {
      guarded("processes");
    }),
    attest: vi.fn(async () => {
      guarded("attest");
    }),
  } satisfies ClosedPreservedRecoveryInput;
  return {
    input,
    observed,
    child,
    runValue,
    quitValue,
    intentValue,
    run,
    config,
    quit,
    intent,
    files,
    state,
    archive,
    chat,
    pending,
    lease,
    archivePin,
    movedArchive,
    model,
    events,
    faults,
    result,
    execute: () => recoverClosedPreservedChat(input),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  expect(ports.acquire.mock.calls.length).toBeLessThanOrEqual(1);
  expect(ports.inspect.mock.calls.length).toBeLessThanOrEqual(1);
  expect(ports.prepare.mock.calls.length).toBeLessThanOrEqual(1);
  expect(ports.finish.mock.calls.length).toBeLessThanOrEqual(1);
  expect(
    ports.reconcileInactiveAfterCrash.mock.calls.length,
  ).toBeLessThanOrEqual(1);
});
const finishInput = () => {
  expect(ports.finish).toHaveBeenCalledTimes(1);
  return ports.finish.mock.calls[0]![0];
};
function released(f: ReturnType<typeof fixture>) {
  expect(f.model.promotionHeld).toBe(false);
  expect(f.model.fenceHeld).toBe(false);
  expect(ports.release).toHaveBeenCalledExactlyOnceWith(f.lease);
  expect(f.events.slice(-2)).toEqual(["fence:release", "promotion:release"]);
}

function noQuitFixture(basename: Parameters<typeof fixture>[1] = "Farol Dev") {
  const f = fixture("previous", basename);
  const quit = path.join(f.state, "last-quit.json");
  f.files.delete(quit);
  delete (f.input as { expectedQuitSha256?: string }).expectedQuitSha256;
  const originalAbsent = ports.absent.getMockImplementation()!;
  ports.absent.mockImplementation(async (file) => {
    await originalAbsent(file);
    if (file === quit && f.files.has(quit))
      throw Error("SYNTHETIC_QUIT_APPEARED");
  });
  return f;
}

describe("closed preserved recovery with an absent Quit (controlled ports)", () => {
  it("reconciles the captured crash identity before preparation without inventing a Quit", async () => {
    const f = noQuitFixture();
    const originalBytes = [f.run.bytes, f.config.bytes].map((b) =>
      Buffer.from(b),
    );
    ports.finish.mockImplementation(async (handoff) => {
      f.model.phase = "finish";
      const waits = ports.waitForStop.mock.calls.length;
      await handoff.proof();
      expect(ports.waitForStop).toHaveBeenCalledTimes(waits + 1);
      await handoff.reconcileConnector!();
      expect(ports.waitForStop).toHaveBeenCalledTimes(waits + 3);
      await handoff.reconcileConnector!();
      expect(ports.waitForStop).toHaveBeenCalledTimes(waits + 5);
      return f.result;
    });
    await expect(f.execute()).resolves.toEqual(f.result);
    const handoff = finishInput();
    expect(handoff).not.toHaveProperty("failedQuit");
    expect(handoff).not.toHaveProperty("previousConfirmedQuit");
    expect(handoff.preservedHistory).toEqual({
      scope: f.input.exact.current,
      originalACK: "unobserved",
      originalTerminal: "unobserved",
    });
    expect(ports.stop).toHaveBeenCalledTimes(1);
    expect(ports.lifecycle).toHaveBeenCalledExactlyOnceWith(
      path.join(f.state, "secure-mcp-connector", "computer-authority"),
    );
    expect(ports.reconcileInactiveAfterCrash).toHaveBeenCalledExactlyOnceWith({
      operationId: f.input.exact.operationId,
      failedRunSha256: digest(f.run.bytes),
      configSha256: digest(f.config.bytes),
      proveIdle: handoff.proof,
    });
    expect(ports.confirmStop).toHaveBeenCalledExactlyOnceWith(0);
    expect(ports.waitForStop.mock.calls.length).toBeGreaterThan(1);
    for (const args of ports.waitForStop.mock.calls) expect(args).toEqual([0]);
    expect(ports.reconcile).not.toHaveBeenCalled();
    const sequence = [
      "before-observation:observe",
      "before-preparation:attest",
      "before-preparation:lease",
      "before-preparation:lifecycle",
      "before-preparation:stop",
      "before-preparation:reconcile-crash",
      "before-preparation:reconcile-crash:complete",
      "before-preparation:confirm-stop",
      "before-preparation:wait-stop",
      "before-preparation:prepare",
    ].map((event) => f.events.indexOf(event));
    for (let index = 0; index < sequence.length; index++) {
      expect(sequence[index]).toBeGreaterThanOrEqual(0);
      if (index) expect(sequence[index]).toBeGreaterThan(sequence[index - 1]!);
    }
    expect(
      ports.absent.mock.calls.filter(
        ([file]) => file === path.join(f.state, "last-quit.json"),
      ).length,
    ).toBeGreaterThan(2);
    expect(
      ports.snapshot.mock.calls.some(
        ([file]) => file === path.join(f.state, "last-quit.json"),
      ),
    ).toBe(false);
    expect(f.files.has(path.join(f.state, "last-quit.json"))).toBe(false);
    expect([f.run.bytes, f.config.bytes]).toEqual(originalBytes);
    released(f);
  });

  it("runs the original host proof during crash reconciliation without recursively waiting for a stop", async () => {
    const f = noQuitFixture();
    const reconcile =
      ports.reconcileInactiveAfterCrash.getMockImplementation()!;
    const wait = ports.waitForStop.getMockImplementation()!;
    let reconciling = false;
    ports.waitForStop.mockImplementation(async (timeoutMs) => {
      expect(
        reconciling,
        "no waitForStop inside the native proof callback",
      ).toBe(false);
      await wait(timeoutMs);
    });
    ports.reconcileInactiveAfterCrash.mockImplementationOnce(async (input) => {
      reconciling = true;
      const before = {
        desktop: f.input.desktopState.mock.calls.length,
        processes: f.input.processesAbsent.mock.calls.length,
        lease: ports.verifyLease.mock.calls.length,
      };
      expect(ports.confirmStop).not.toHaveBeenCalled();
      expect(ports.waitForStop).not.toHaveBeenCalled();
      await reconcile(input);
      expect(f.input.desktopState).toHaveBeenCalledTimes(before.desktop + 1);
      expect(f.input.processesAbsent).toHaveBeenCalledTimes(
        before.processes + 1,
      );
      expect(ports.verifyLease).toHaveBeenCalledTimes(before.lease + 1);
      expect(ports.waitForStop).not.toHaveBeenCalled();
      expect(ports.confirmStop).not.toHaveBeenCalled();
      reconciling = false;
    });
    await expect(f.execute()).resolves.toEqual(f.result);
    expect(ports.stop).toHaveBeenCalledTimes(1);
    expect(ports.confirmStop).toHaveBeenCalledExactlyOnceWith(0);
    expect(ports.reconcileInactiveAfterCrash).toHaveBeenCalledTimes(1);
    expect(ports.reconcile).not.toHaveBeenCalled();
    released(f);
  });

  it.each(
    (
      [
        "observation",
        "attestation",
        "pre-stop-proof",
        "stop",
        "reconcile",
        "reconciliation-proof",
        "confirm",
        "post-stop-proof",
      ] as const
    ).flatMap((point) =>
      (["resolve", "reject"] as const).map((outcome) => ({ point, outcome })),
    ),
  )(
    "awaits $point $outcome under both guards before preparation or finish",
    async ({ point, outcome }) => {
      const f = noQuitFixture();
      const entered = deferred<void>();
      const gate = deferred<void>();
      const failure = Object.assign(Error(`${point} outcome unknown`), {
        state: "unknown",
      });
      const hold = async () => {
        expect(f.model.promotionHeld).toBe(true);
        expect(f.model.fenceHeld).toBe(true);
        entered.resolve();
        await gate.promise;
      };
      if (point === "observation") {
        const original = ports.inspect.getMockImplementation()!;
        ports.inspect.mockImplementationOnce(async (...args) => {
          const observed = await original(...args);
          await hold();
          return observed;
        });
      }
      if (point === "attestation") {
        const original = f.input.attest.getMockImplementation()!;
        f.input.attest.mockImplementation(async () => {
          await original();
          if (f.model.phase === "before-preparation") await hold();
        });
      }
      if (point === "pre-stop-proof" || point === "reconciliation-proof") {
        const original = ports.verifyLease.getMockImplementation()!;
        let held = false;
        ports.verifyLease.mockImplementation(async (lease) => {
          const verified = await original(lease);
          if (
            !held &&
            f.model.phase === "before-preparation" &&
            ports.reconcileInactiveAfterCrash.mock.calls.length ===
              (point === "pre-stop-proof" ? 0 : 1) &&
            ports.confirmStop.mock.calls.length === 0
          ) {
            held = true;
            await hold();
          }
          return verified;
        });
      }
      if (point === "stop") {
        const original = ports.stop.getMockImplementation()!;
        ports.stop.mockImplementationOnce(async () => {
          await original();
          await hold();
        });
      }
      if (point === "reconcile") {
        const original =
          ports.reconcileInactiveAfterCrash.getMockImplementation()!;
        ports.reconcileInactiveAfterCrash.mockImplementationOnce(
          async (input) => {
            await original(input);
            await hold();
          },
        );
      }
      if (point === "confirm") {
        const original = ports.confirmStop.getMockImplementation()!;
        ports.confirmStop.mockImplementationOnce(async (timeoutMs) => {
          await original(timeoutMs);
          await hold();
        });
      }
      if (point === "post-stop-proof") {
        const original = ports.waitForStop.getMockImplementation()!;
        ports.waitForStop.mockImplementationOnce(async (timeoutMs) => {
          await original(timeoutMs);
          await hold();
        });
      }
      const done = f.execute();
      const settled = vi.fn();
      void done.then(settled, settled);
      await entered.promise;
      const beforeCrash = [
        "observation",
        "attestation",
        "pre-stop-proof",
        "stop",
      ].includes(point);
      expect(ports.reconcileInactiveAfterCrash).toHaveBeenCalledTimes(
        beforeCrash ? 0 : 1,
      );
      expect(ports.confirmStop).toHaveBeenCalledTimes(
        point === "confirm" || point === "post-stop-proof" ? 1 : 0,
      );
      expect(ports.waitForStop).toHaveBeenCalledTimes(
        point === "post-stop-proof" ? 1 : 0,
      );
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(f.movedArchive).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      expect(ports.release).not.toHaveBeenCalled();
      expect(f.model.promotionHeld).toBe(true);
      expect(f.model.fenceHeld).toBe(true);
      expect(settled).not.toHaveBeenCalled();
      if (outcome === "resolve") {
        gate.resolve();
        await expect(done).resolves.toEqual(f.result);
      } else {
        gate.reject(failure);
        await expect(done).rejects.toBe(failure);
        expect(ports.prepare).not.toHaveBeenCalled();
        expect(f.movedArchive).not.toHaveBeenCalled();
        expect(ports.finish).not.toHaveBeenCalled();
        expect(ports.reconcileInactiveAfterCrash).toHaveBeenCalledTimes(
          beforeCrash ? 0 : 1,
        );
        expect(ports.confirmStop).toHaveBeenCalledTimes(
          point === "confirm" || point === "post-stop-proof" ? 1 : 0,
        );
      }
      expect(ports.reconcile).not.toHaveBeenCalled();
      released(f);
    },
  );

  it.each(
    (["before-observation", "before-preparation"] as const).flatMap((phase) =>
      [
        "attest",
        "root:parent",
        "unchanged:running.json",
        "unchanged:config.json",
        "absent:last-quit.json",
        "desktop",
        "processes",
        "lease",
        ...(phase === "before-observation" ? ["observe"] : []),
      ].map((barrier) => ({ phase, barrier })),
    ),
  )(
    "does not select crash reconciliation after $phase $barrier fails",
    async ({ phase, barrier }) => {
      const f = noQuitFixture();
      const failure = Object.assign(Error(`${barrier} proof unknown`), {
        state: "unknown",
      });
      f.faults.set(`${phase}:${barrier}`, failure);
      await expect(f.execute()).rejects.toBe(failure);
      expect(ports.lifecycle).not.toHaveBeenCalled();
      expect(ports.stop).not.toHaveBeenCalled();
      expect(ports.reconcileInactiveAfterCrash).not.toHaveBeenCalled();
      expect(ports.confirmStop).not.toHaveBeenCalled();
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(f.movedArchive).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      released(f);
    },
  );

  it("does not select crash reconciliation after a false post-observation lease proof", async () => {
    const f = noQuitFixture();
    const original = ports.verifyLease.getMockImplementation()!;
    ports.verifyLease.mockImplementation(async (lease) => {
      await original(lease);
      return f.model.phase !== "before-preparation";
    });
    await expect(f.execute()).rejects.toThrow("PROMOTION_LEASE_LOST");
    expect(ports.reconcileInactiveAfterCrash).not.toHaveBeenCalled();
    expect(ports.lifecycle).not.toHaveBeenCalled();
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
    released(f);
  });

  it.each(["running.json", "config.json"])(
    "refuses changed selected %s bytes before crash reconciliation",
    async (name) => {
      const f = noQuitFixture();
      f.files.set(path.join(f.state, name), snapshot({ changed: true }, 99));
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_STATE_CHANGED",
      );
      expect(ports.inspect).not.toHaveBeenCalled();
      expect(ports.lifecycle).not.toHaveBeenCalled();
      expect(ports.reconcileInactiveAfterCrash).not.toHaveBeenCalled();
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      released(f);
    },
  );

  it.each(["changed", "unreadable", "obligations"] as const)(
    "refuses a post-observation desktop %s mismatch before crash reconciliation",
    async (field) => {
      const f = noQuitFixture();
      const inspect = ports.inspect.getMockImplementation()!;
      ports.inspect.mockImplementationOnce(async (...args) => {
        const observed = await inspect(...args);
        f.model.desktop = { ...f.model.desktop, [field]: ["foreign-work"] };
        return observed;
      });
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_WORK_PENDING",
      );
      expect(ports.lifecycle).not.toHaveBeenCalled();
      expect(ports.reconcileInactiveAfterCrash).not.toHaveBeenCalled();
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      released(f);
    },
  );

  it("refuses an existing Quit before observation or maintenance", async () => {
    const f = noQuitFixture();
    f.files.set(path.join(f.state, "last-quit.json"), f.quit);
    await expect(f.execute()).rejects.toThrow("SYNTHETIC_QUIT_APPEARED");
    expect(ports.inspect).not.toHaveBeenCalled();
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(ports.stop).not.toHaveBeenCalled();
    expect(ports.reconcileInactiveAfterCrash).not.toHaveBeenCalled();
    released(f);
  });

  it.each(["before-preparation", "after-preparation"] as const)(
    "retains refusal when Quit appears at %s",
    async (phase) => {
      const f = noQuitFixture();
      const appear = () =>
        f.files.set(path.join(f.state, "last-quit.json"), f.quit);
      if (phase === "before-preparation") {
        const original = ports.inspect.getMockImplementation()!;
        ports.inspect.mockImplementation(async (...args) => {
          const value = await original(...args);
          appear();
          return value;
        });
      } else {
        const original = ports.prepare.getMockImplementation()!;
        ports.prepare.mockImplementation(async (...args) => {
          const value = await original(...args);
          appear();
          return value;
        });
      }
      await expect(f.execute()).rejects.toThrow("SYNTHETIC_QUIT_APPEARED");
      if (phase === "before-preparation")
        expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      expect(ports.reconcile).not.toHaveBeenCalled();
      expect(ports.reconcileInactiveAfterCrash).toHaveBeenCalledTimes(
        phase === "before-preparation" ? 0 : 1,
      );
      released(f);
    },
  );

  it.each(["stop", "reconcileInactiveAfterCrash", "confirmStop"] as const)(
    "refuses an uncertain mocked %s before preparation",
    async (method) => {
      const f = noQuitFixture();
      ports[method].mockRejectedValueOnce(Error("SYNTHETIC_MCP_NOT_IDLE"));
      await expect(f.execute()).rejects.toThrow("SYNTHETIC_MCP_NOT_IDLE");
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      expect(ports.reconcile).not.toHaveBeenCalled();
      expect(ports.reconcileInactiveAfterCrash).toHaveBeenCalledTimes(
        method === "stop" ? 0 : 1,
      );
      expect(ports.confirmStop).toHaveBeenCalledTimes(
        method === "confirmStop" ? 1 : 0,
      );
      released(f);
    },
  );

  it("refuses a lost mocked idle proof after preparation", async () => {
    const f = noQuitFixture();
    const original = ports.prepare.getMockImplementation()!;
    ports.prepare.mockImplementation(async (...args) => {
      const value = await original(...args);
      ports.waitForStop.mockRejectedValueOnce(Error("SYNTHETIC_MCP_NOT_IDLE"));
      return value;
    });
    await expect(f.execute()).rejects.toThrow("SYNTHETIC_MCP_NOT_IDLE");
    expect(ports.finish).not.toHaveBeenCalled();
    expect(ports.reconcile).not.toHaveBeenCalled();
    expect(ports.reconcileInactiveAfterCrash).toHaveBeenCalledTimes(1);
    released(f);
  });

  it.each(["resolve", "reject"] as const)(
    "awaits the existing stop's finish recheck %s under both guards without claiming again",
    async (outcome) => {
      const f = noQuitFixture();
      const entered = deferred<void>();
      const gate = deferred<void>();
      const failure = Object.assign(Error("finish stop proof unknown"), {
        state: "unknown",
      });
      const wait = ports.waitForStop.getMockImplementation()!;
      const finished = vi.fn();
      ports.finish.mockImplementationOnce(async (handoff) => {
        f.model.phase = "finish";
        ports.waitForStop.mockImplementationOnce(async (timeoutMs) => {
          await wait(timeoutMs);
          entered.resolve();
          await gate.promise;
        });
        await handoff.reconcileConnector!();
        finished();
        return f.result;
      });
      const done = f.execute();
      const settled = vi.fn();
      void done.then(settled, settled);
      await entered.promise;
      expect(f.model.promotionHeld).toBe(true);
      expect(f.model.fenceHeld).toBe(true);
      expect(ports.release).not.toHaveBeenCalled();
      expect(finished).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      if (outcome === "resolve") {
        gate.resolve();
        await expect(done).resolves.toEqual(f.result);
        expect(finished).toHaveBeenCalledTimes(1);
      } else {
        gate.reject(failure);
        await expect(done).rejects.toBe(failure);
        expect(finished).not.toHaveBeenCalled();
      }
      expect(ports.lifecycle).toHaveBeenCalledTimes(1);
      expect(ports.stop).toHaveBeenCalledTimes(1);
      expect(ports.confirmStop).toHaveBeenCalledExactlyOnceWith(0);
      expect(ports.reconcileInactiveAfterCrash).toHaveBeenCalledTimes(1);
      expect(ports.reconcile).not.toHaveBeenCalled();
      released(f);
    },
  );
});

describe("connector durable-work admission (controlled port)", () => {
  it.each(["previous", "current", "absent"] as const)(
    "rechecks the existing connector guard under both exclusions for %s Quit",
    async (scope) => {
      const f = scope === "absent" ? noQuitFixture() : fixture(scope);
      ports.finish.mockImplementation(async (handoff) => {
        f.model.phase = "finish";
        await handoff.reconcileConnector!();
        return f.result;
      });
      await expect(f.execute()).resolves.toEqual(f.result);
      expect(ports.connectorWork.mock.calls.length).toBeGreaterThan(3);
      for (const args of ports.connectorWork.mock.calls)
        expect(args).toEqual([
          path.join(f.state, "secure-mcp-connector", "computer-authority"),
        ]);
      expect(
        f.events.indexOf("before-observation:connector-work"),
      ).toBeLessThan(f.events.indexOf("before-observation:observe"));
      expect(f.events).toContain("finish:connector-work");
      released(f);
    },
  );

  it.each(
    (["previous", "current", "absent"] as const).flatMap((scope) =>
      (["before-observation", "before-preparation"] as const).map((phase) => ({
        scope,
        phase,
      })),
    ),
  )(
    "refuses $scope Quit when connector work is unresolved at $phase",
    async ({ scope, phase }) => {
      const f = scope === "absent" ? noQuitFixture() : fixture(scope);
      const failure = Error("CLOSED_COMPUTER_RECOVERY_WORK_PENDING");
      f.faults.set(`${phase}:connector-work`, failure);
      await expect(f.execute()).rejects.toBe(failure);
      if (phase === "before-observation")
        expect(ports.inspect).not.toHaveBeenCalled();
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(f.movedArchive).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      expect(ports.reconcileInactiveAfterCrash).not.toHaveBeenCalled();
      released(f);
    },
  );

  it("rechecks connector work inside crash reconciliation before confirming stop or preparing Chat", async () => {
    const f = noQuitFixture();
    const failure = Error("CLOSED_COMPUTER_RECOVERY_WORK_PENDING");
    const original = ports.reconcileInactiveAfterCrash.getMockImplementation()!;
    ports.reconcileInactiveAfterCrash.mockImplementationOnce(async (input) => {
      ports.connectorWork.mockRejectedValueOnce(failure);
      await original(input);
    });
    await expect(f.execute()).rejects.toBe(failure);
    expect(ports.stop).toHaveBeenCalledTimes(1);
    expect(ports.confirmStop).not.toHaveBeenCalled();
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(f.movedArchive).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
    released(f);
  });

  it.each(["resolve", "reject"] as const)(
    "awaits the connector proof's %s under both exclusions without starting observation",
    async (outcome) => {
      const f = noQuitFixture();
      const entered = deferred<void>();
      const gate = deferred<void>();
      const original = ports.connectorWork.getMockImplementation()!;
      ports.connectorWork.mockImplementationOnce(async (root) => {
        await original(root);
        entered.resolve();
        await gate.promise;
      });
      const done = f.execute();
      void done.catch(() => undefined);
      await entered.promise;
      expect(f.model.promotionHeld).toBe(true);
      expect(f.model.fenceHeld).toBe(true);
      expect(ports.inspect).not.toHaveBeenCalled();
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.release).not.toHaveBeenCalled();
      if (outcome === "resolve") {
        gate.resolve();
        await expect(done).resolves.toEqual(f.result);
      } else {
        const failure = Error("connector settlement unconfirmed");
        gate.reject(failure);
        await expect(done).rejects.toBe(failure);
        expect(ports.inspect).not.toHaveBeenCalled();
        expect(ports.reconcileInactiveAfterCrash).not.toHaveBeenCalled();
      }
      released(f);
    },
  );
});

describe("closed preserved recovery host flow (controlled ports)", () => {
  it("preserves the actual desktop writer's current unconfirmed Quit bytes", async () => {
    const f = fixture("current");
    const failedClose = async () => {
      throw Error("SYNTHETIC_CLOSE_UNCONFIRMED");
    };
    const drained = await drainOwnedChildren(
      goCoreQuitClosers({ name: "connector", close: failedClose }, failedClose),
      1000,
    );
    expect(drained).toEqual({
      drained: false,
      unconfirmed: ["connector", "go-core"],
    });
    const originalBytes = Buffer.from(
      serializeQuitReceipt(drained, f.quitValue.at),
    );
    const selectedQuit = { ...f.quit, bytes: originalBytes };
    f.files.set(path.join(f.state, "last-quit.json"), selectedQuit);
    f.input.expectedQuitSha256 = digest(originalBytes);
    f.model.desktop = {
      ...f.model.desktop,
      obligations: [
        "QUIT_UNCONFIRMED:connector,go-core",
        "QUIT_UNCONFIRMED:crash",
      ],
    };
    ports.finish.mockImplementation(async (handoff) => {
      f.model.phase = "finish";
      await handoff.reconcileConnector!();
      return f.result;
    });
    await expect(f.execute()).resolves.toEqual(f.result);
    const handoff = finishInput();
    expect(handoff.failedQuit).toBe(selectedQuit);
    expect(handoff.failedQuit!.bytes).toEqual(originalBytes);
    expect(digest(handoff.failedQuit!.bytes)).toBe(f.input.expectedQuitSha256);
    expect(ports.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ failedQuitSha256: digest(originalBytes) }),
    );
    expect(ports.reconcileInactiveAfterCrash).not.toHaveBeenCalled();
    released(f);
  });

  it.each([
    { children: ["go-core", "connector"], crossed: "connector,go-core" },
    { children: ["connector", "go-core"], crossed: "go-core,connector" },
  ])(
    "refuses a projection with crossed child order $crossed",
    async ({ children, crossed }) => {
      const f = fixture("current", "Farol Dev", children);
      f.model.desktop = {
        ...f.model.desktop,
        obligations: [`QUIT_UNCONFIRMED:${crossed}`, "QUIT_UNCONFIRMED:crash"],
      };
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_WORK_PENDING",
      );
      expect(ports.inspect).not.toHaveBeenCalled();
      released(f);
    },
  );

  it("accepts the explicit alternate Dev basename", async () => {
    const f = fixture("previous", "Farol DEV");
    await expect(f.execute()).resolves.toEqual(f.result);
    expect(finishInput().profile.root).toBe(f.input.profile.root);
    released(f);
  });

  it.each(["previous", "current"] as const)(
    "hands off one observed selection and the actual new child with %s Quit",
    async (scope) => {
      const f = fixture(scope);
      const original = structuredClone({
        profile: f.input.profile,
        exact: f.input.exact,
        selectionInput: f.input.selectionInput,
      });
      const originalBytes = [f.run.bytes, f.config.bytes, f.quit.bytes].map(
        (b) => Buffer.from(b),
      );
      await expect(f.execute()).resolves.toEqual(f.result);
      expect(ports.acquire).toHaveBeenCalledExactlyOnceWith(
        f.input.userData,
        `preserved-chat-recovery-${f.input.exact.operationId}`,
        "promotion",
      );
      expect(ports.fence).toHaveBeenCalledExactlyOnceWith({
        root: path.join(f.state, "secure-mcp-connector", "computer-authority"),
      });
      expect(ports.inspect).toHaveBeenCalledExactlyOnceWith(
        f.input.executable,
        original.profile,
        original.selectionInput,
        original.exact,
      );
      expect(ports.prepare).toHaveBeenCalledExactlyOnceWith(
        f.input.executable,
        original.profile,
        f.observed,
        original.exact,
      );
      expect(ports.prepare.mock.calls[0]![2]).toBe(f.observed);
      expect(ports.retain).toHaveBeenCalledExactlyOnceWith(f.chat, f.archive);
      expect(f.movedArchive).toHaveBeenCalledTimes(1);
      expect(f.events.indexOf("before-observation:attest")).toBeLessThan(
        f.events.indexOf("before-observation:retain-chat"),
      );
      expect(f.events.indexOf("before-observation:processes")).toBeLessThan(
        f.events.indexOf("before-observation:observe"),
      );
      expect(f.events.indexOf("before-observation:retain-chat")).toBeLessThan(
        f.events.indexOf("before-observation:observe"),
      );
      expect(f.events.indexOf("before-preparation:attest")).toBeLessThan(
        f.events.indexOf("before-preparation:prepare"),
      );
      expect(f.events.indexOf("before-preparation:processes")).toBeLessThan(
        f.events.indexOf("before-preparation:prepare"),
      );
      expect(f.events.indexOf("after-preparation:archive-pin")).toBeLessThan(
        f.events.indexOf("after-preparation:finish"),
      );
      const handoff = finishInput();
      expect(handoff).toMatchObject({
        exact: original.exact,
        profile: original.profile,
        state: f.state,
        archive: f.archive,
        pending: f.pending,
        preparedRoots: {
          archive: { dev: 1, ino: 3 },
          chat: { dev: 1, ino: 4 },
        },
        input: {
          executable: f.input.executable,
          expectedRunSha256: f.input.expectedRunSha256,
          expectedConfigSha256: f.input.expectedConfigSha256,
          selectionInput: {},
        },
        preservedHistory: {
          scope: original.exact.current,
          originalACK: "unobserved",
          originalTerminal: "unobserved",
        },
      });
      expect(handoff.child).toBe(f.child);
      expect(handoff.run).toBe(f.run);
      expect(handoff.config).toBe(f.config);
      expect(handoff.failedQuit).toBe(f.quit);
      expect(handoff.intent).toBe(f.intent);
      expect(handoff.lease).toBe(f.lease);
      expect(handoff.archivePin).toBe(f.archivePin);
      expect(handoff.input.attest).toBe(f.input.attest);
      expect(handoff.input.processesAbsent).toBe(f.input.processesAbsent);
      expect(Object.hasOwn(handoff, "previousConfirmedQuit")).toBe(
        scope === "previous",
      );
      if (scope === "previous")
        expect(handoff.previousConfirmedQuit).toBe(true);
      expect([f.run.bytes, f.config.bytes, f.quit.bytes]).toEqual(
        originalBytes,
      );
      expect(f.input.profile).toEqual(original.profile);
      expect(f.input.exact).toEqual(original.exact);
      expect(f.input.selectionInput).toEqual(original.selectionInput);
      expect(ports.snapshot.mock.calls).toEqual([
        [path.join(f.state, "running.json"), MAX_RUN_MARKER_BYTES],
        [path.join(f.state, "config.json"), 256 * 1024],
        [path.join(f.state, "last-quit.json"), 16384],
        [f.pending, 65536],
      ]);
      expect(ports.lifecycle).not.toHaveBeenCalled(); // finish owns when to call it.
      expect(ports.reconcileInactiveAfterCrash).not.toHaveBeenCalled();
      released(f);
    },
  );

  it.each(["previous", "current"] as const)(
    "reconciles %s Quit with the existing stop and failed-Quit binding under both guards",
    async (scope) => {
      const f = fixture(scope);
      ports.finish.mockImplementation(async (handoff) => {
        f.model.phase = "finish";
        const before = f.input.desktopState.mock.calls.length;
        await handoff.reconcileConnector!();
        expect(ports.lifecycle).toHaveBeenCalledExactlyOnceWith(
          path.join(f.state, "secure-mcp-connector", "computer-authority"),
        );
        expect(ports.stop).toHaveBeenCalledTimes(1);
        expect(ports.reconcile).toHaveBeenCalledExactlyOnceWith({
          operationId: f.input.exact.operationId,
          failedQuitSha256: f.input.expectedQuitSha256,
          proveIdle: handoff.proof,
        });
        expect(f.input.desktopState.mock.calls.length - before).toBe(2);
        expect(f.events.indexOf("finish:stop")).toBeLessThan(
          f.events.indexOf("finish:reconcile"),
        );
        return f.result;
      });
      await expect(f.execute()).resolves.toEqual(f.result);
      expect(ports.reconcileInactiveAfterCrash).not.toHaveBeenCalled();
      expect(ports.confirmStop).not.toHaveBeenCalled();
      expect(ports.waitForStop).not.toHaveBeenCalled();
      released(f);
    },
  );

  it("awaits the original observation under both guards before preparing its returned metadata", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const observation = deferred<typeof f.observed>();
    ports.inspect.mockImplementationOnce(async () => {
      entered.resolve();
      const metadata = await observation.promise;
      f.model.phase = "before-preparation";
      return metadata;
    });
    const done = f.execute();
    await entered.promise;
    expect(f.model.promotionHeld).toBe(true);
    expect(f.model.fenceHeld).toBe(true);
    expect(ports.retain).toHaveBeenCalledTimes(1);
    expect(f.movedArchive).not.toHaveBeenCalled();
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
    observation.resolve(f.observed);
    await expect(done).resolves.toEqual(f.result);
    expect(ports.prepare.mock.calls[0]![2]).toBe(f.observed);
    released(f);
  });

  it.each(["stop", "reconcile"] as const)(
    "propagates lifecycle %s uncertainty without retry",
    async (point) => {
      const f = fixture();
      const failure = Object.assign(Error("lifecycle outcome unknown"), {
        state: "unknown",
      });
      f.faults.set(`finish:${point}`, failure);
      ports.finish.mockImplementation(async (handoff) => {
        f.model.phase = "finish";
        await handoff.reconcileConnector!();
        return f.result;
      });
      await expect(f.execute()).rejects.toBe(failure);
      expect(ports.reconcile).toHaveBeenCalledTimes(point === "stop" ? 0 : 1);
      released(f);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "holds both guards until asynchronous finish %s settles",
    async (outcome) => {
      const f = fixture();
      const entered = deferred<Finish>();
      const finish = deferred<typeof f.result>();
      const failure = Object.assign(Error("finish durability unknown"), {
        state: "unknown",
      });
      ports.finish.mockImplementation((handoff) => {
        entered.resolve(handoff);
        return finish.promise;
      });
      const done = f.execute();
      const settled = vi.fn();
      void done.then(settled, settled);
      const handoff = await entered.promise;
      expect(handoff.child).toBe(f.child);
      expect(f.model.promotionHeld).toBe(true);
      expect(f.model.fenceHeld).toBe(true);
      expect(ports.release).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      if (outcome === "resolve") {
        finish.resolve(f.result);
        await expect(done).resolves.toEqual(f.result);
      } else {
        finish.reject(failure);
        await expect(done).rejects.toBe(failure);
      }
      released(f);
    },
  );

  it.each(["previous", "absent"] as const)(
    "captures %s Quit selection, executable, digests and callbacks before the first await",
    async (scope) => {
      const f = scope === "absent" ? noQuitFixture() : fixture();
      const saved = structuredClone({
        executable: f.input.executable,
        profile: f.input.profile,
        exact: f.input.exact,
        selectionInput: f.input.selectionInput,
        run: f.input.expectedRunSha256,
        config: f.input.expectedConfigSha256,
        quit: f.input.expectedQuitSha256,
      });
      const originalAttest = f.input.attest;
      const originalProcesses = f.input.processesAbsent;
      const originalDesktop = f.input.desktopState;
      const gate = deferred<{ dev: number; ino: number }>();
      ports.privateRoot.mockImplementationOnce(() => gate.promise);
      ports.finish.mockImplementationOnce(async (handoff) => {
        f.model.phase = "finish";
        await handoff.reconcileConnector!();
        return f.result;
      });
      const done = f.execute();
      f.input.userData = "/synthetic/Other";
      f.input.executable = "/changed";
      f.input.profile.root = "/changed";
      f.input.profile.profileId = "changed";
      f.input.exact.operationId = "changed";
      f.input.exact.current.ChatRoot.Inode = 999;
      f.input.selectionInput.OwnerID = "changed";
      f.input.selectionInput.AccessDigest[0] = 255;
      f.input.selectionInput.Mutations[0]!.Binding.Identity.OwnerID = "changed";
      f.input.expectedRunSha256 = "0".repeat(64);
      f.input.expectedConfigSha256 = "0".repeat(64);
      f.input.expectedQuitSha256 = "0".repeat(64);
      const replacement = vi.fn(() => {
        throw Error("late caller replacement");
      });
      f.input.attest = replacement;
      f.input.processesAbsent = replacement;
      f.input.desktopState = replacement;
      // The private-root port uses the original synthetic path, independently of
      // caller mutation. Its first lookup is the only suspended boundary.
      ports.privateRoot.mockImplementation(async (directory) => {
        if (directory === saved.profile.root) return { dev: 1, ino: 2 };
        if (directory === f.archive) return { dev: 1, ino: 3 };
        if (directory === f.chat) return { dev: 1, ino: 4 };
        return { dev: 1, ino: 99 };
      });
      gate.resolve({ dev: 1, ino: 99 });
      await expect(done).resolves.toEqual(f.result);
      expect(ports.inspect).toHaveBeenCalledExactlyOnceWith(
        saved.executable,
        saved.profile,
        saved.selectionInput,
        saved.exact,
      );
      expect(ports.prepare).toHaveBeenCalledExactlyOnceWith(
        saved.executable,
        saved.profile,
        f.observed,
        saved.exact,
      );
      const handoff = finishInput();
      expect(handoff.input).toMatchObject({
        executable: saved.executable,
        expectedRunSha256: saved.run,
        expectedConfigSha256: saved.config,
      });
      expect(handoff.input.attest).toBe(originalAttest);
      expect(handoff.input.processesAbsent).toBe(originalProcesses);
      if (scope === "absent") {
        expect(
          ports.reconcileInactiveAfterCrash,
        ).toHaveBeenCalledExactlyOnceWith({
          operationId: saved.exact.operationId,
          failedRunSha256: saved.run,
          configSha256: saved.config,
          proveIdle: handoff.proof,
        });
        expect(handoff).not.toHaveProperty("failedQuit");
        expect(handoff).not.toHaveProperty("previousConfirmedQuit");
        expect(handoff.preservedHistory).toEqual({
          scope: saved.exact.current,
          originalACK: "unobserved",
          originalTerminal: "unobserved",
        });
        expect(ports.reconcile).not.toHaveBeenCalled();
        expect(originalDesktop.mock.calls.length).toBeGreaterThanOrEqual(6);
        expect(f.files.has(path.join(f.state, "last-quit.json"))).toBe(false);
      } else {
        expect(ports.reconcile).toHaveBeenCalledExactlyOnceWith({
          operationId: saved.exact.operationId,
          failedQuitSha256: saved.quit,
          proveIdle: handoff.proof,
        });
        expect(ports.reconcileInactiveAfterCrash).not.toHaveBeenCalled();
        expect(originalDesktop).toHaveBeenCalledTimes(5);
      }
      expect(originalAttest).toHaveBeenCalledTimes(2);
      expect(replacement).not.toHaveBeenCalled();
      released(f);
    },
  );
});

describe("closed preserved recovery refuses progression", () => {
  it.each([
    "relative",
    "/synthetic/Farol",
    "/synthetic/Farol Preview",
    "/synthetic/Farol dev",
  ])(
    "rejects unsupported userData %s before any host boundary",
    async (userData) => {
      const f = fixture();
      f.input.userData = userData;
      f.input.profile.root = path.join(userData, "farol-next-state", "go-core");
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_SELECTION_INVALID",
      );
      expect(ports.privateRoot).not.toHaveBeenCalled();
      expect(ports.acquire).not.toHaveBeenCalled();
    },
  );

  it.each([
    "00000000-0000-0000-0000-000000000001",
    "835a913b-bc20-f2c6-bf56-9b83852cde3c",
    "835a913b-bc20-42c6-0f56-9b83852cde3c",
  ])(
    "refuses the real reconciler's invalid UUID %s before host IO",
    async (operationId) => {
      const { PrivateMcpLifecycle: Reconciler } = await vi.importActual<
        typeof import("../../src/modules/computer/infra/mcp/private-mcp-lifecycle")
      >("../../src/modules/computer/infra/mcp/private-mcp-lifecycle");
      const proveIdle = vi.fn(async () => {});
      await expect(
        new Reconciler("/synthetic/unused-mcp").reconcileInactive({
          operationId,
          failedQuitSha256: "a".repeat(64),
          proveIdle,
        }),
      ).rejects.toThrow("COMPUTER_MCP_RECONCILIATION_INVALID");
      expect(proveIdle).not.toHaveBeenCalled();
      const f = fixture();
      f.input.exact.operationId = operationId;
      f.input.selectionInput.Selection.OperationID = operationId;
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_SELECTION_INVALID",
      );
      expect(ports.privateRoot).not.toHaveBeenCalled();
      expect(ports.acquire).not.toHaveBeenCalled();
      expect(ports.fence).not.toHaveBeenCalled();
      expect(ports.inspect).not.toHaveBeenCalled();
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
    },
  );

  it.each(["profile", "operation", "run", "config", "quit"] as const)(
    "rejects invalid %s selection before admission",
    async (field) => {
      const f = fixture();
      if (field === "profile") f.input.profile.root = "/other/go-core";
      if (field === "operation") f.input.exact.operationId = "not-a-uuid";
      if (field === "run") f.input.expectedRunSha256 = "a".repeat(63);
      if (field === "config") f.input.expectedConfigSha256 = "A".repeat(64);
      if (field === "quit") f.input.expectedQuitSha256 = "invalid";
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_SELECTION_INVALID",
      );
      expect(ports.privateRoot).not.toHaveBeenCalled();
      expect(ports.acquire).not.toHaveBeenCalled();
    },
  );

  it.each(["dev", "ino"] as const)(
    "rejects crossed parent %s before acquiring a lease",
    async (key) => {
      const f = fixture();
      f.model.roots.parent[key] = 999;
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_ROOT_CHANGED",
      );
      expect(ports.acquire).not.toHaveBeenCalled();
      expect(ports.inspect).not.toHaveBeenCalled();
    },
  );

  it("preserves a private-root refusal without acquiring admission", async () => {
    const f = fixture();
    const failure = Error("EMPTY_CHAT_RECOVERY_ROOT_UNSAFE");
    ports.privateRoot.mockRejectedValueOnce(failure);
    await expect(f.execute()).rejects.toBe(failure);
    expect(ports.acquire).not.toHaveBeenCalled();
    expect(ports.release).not.toHaveBeenCalled();
  });

  it("does not enter the Computer fence after promotion admission is refused", async () => {
    const f = fixture();
    ports.acquire.mockResolvedValueOnce(null);
    await expect(f.execute()).rejects.toThrow("PRESERVED_RECOVERY_APP_ACTIVE");
    expect(ports.fence).not.toHaveBeenCalled();
    expect(ports.snapshot).not.toHaveBeenCalled();
    expect(ports.release).not.toHaveBeenCalled();
  });

  it.each([
    "EXECUTION_FENCE_ACTIVE_COMPUTER_WORK",
    "EXECUTION_FENCE_LOCK_UNSUPPORTED",
  ])("releases promotion on %s without observing metadata", async (code) => {
    const f = fixture();
    ports.drain.mockRejectedValueOnce(Error(code));
    await expect(f.execute()).rejects.toThrow(code);
    expect(ports.snapshot).not.toHaveBeenCalled();
    expect(ports.inspect).not.toHaveBeenCalled();
    expect(ports.release).toHaveBeenCalledExactlyOnceWith(f.lease);
    expect(f.model.promotionHeld).toBe(false);
  });

  it.each(["running.json", "config.json", "last-quit.json"])(
    "rejects changed selected %s bytes before preservation or children",
    async (name) => {
      const f = fixture();
      f.files.set(path.join(f.state, name), snapshot({ changed: true }, 99));
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_STATE_CHANGED",
      );
      expect(ports.retain).not.toHaveBeenCalled();
      expect(ports.inspect).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      released(f);
    },
  );

  it.each([
    [
      "stale current",
      { at: "2026-10-16T11:59:59.000Z" },
      "PRESERVED_RECOVERY_QUIT_SCOPE_CHANGED",
    ],
    [
      "same-time current",
      { at: "2026-10-16T12:00:00.000Z" },
      "PRESERVED_RECOVERY_QUIT_SCOPE_CHANGED",
    ],
    [
      "missing connector",
      { unconfirmed: ["go-core"] },
      "INTERRUPTED_CHAT_RECOVERY_QUIT_CHANGED",
    ],
    [
      "missing go-core",
      { unconfirmed: ["connector"] },
      "INTERRUPTED_CHAT_RECOVERY_QUIT_CHANGED",
    ],
    [
      "duplicate connector pair",
      { unconfirmed: ["connector", "connector"] },
      "INTERRUPTED_CHAT_RECOVERY_QUIT_CHANGED",
    ],
    [
      "duplicate core pair",
      { unconfirmed: ["go-core", "go-core"] },
      "INTERRUPTED_CHAT_RECOVERY_QUIT_CHANGED",
    ],
    [
      "unexpected receipt field with desktop order",
      { unconfirmed: ["connector", "go-core"], unexpected: true },
      "INTERRUPTED_CHAT_RECOVERY_QUIT_CHANGED",
    ],
    [
      "duplicate child",
      { unconfirmed: ["go-core", "connector", "connector"] },
      "INTERRUPTED_CHAT_RECOVERY_QUIT_CHANGED",
    ],
    [
      "unrelated pending",
      { unconfirmed: ["go-core", "connector", "task"] },
      "INTERRUPTED_CHAT_RECOVERY_QUIT_CHANGED",
    ],
    [
      "current clean quit",
      { drained: true, unconfirmed: [] },
      "INTERRUPTED_CHAT_RECOVERY_QUIT_CHANGED",
    ],
  ] as const)(
    "refuses %s Quit even with a matching selected SHA",
    async (_name, fields, code) => {
      const f = fixture("current");
      const changed = snapshot({ ...f.quitValue, ...fields }, 12);
      f.files.set(path.join(f.state, "last-quit.json"), changed);
      f.input.expectedQuitSha256 = digest(changed.bytes);
      await expect(f.execute()).rejects.toThrow(code);
      expect(ports.retain).not.toHaveBeenCalled();
      expect(ports.inspect).not.toHaveBeenCalled();
      released(f);
    },
  );

  it.each(["changed", "unreadable", "obligations"] as const)(
    "requires the independent desktop %s proof",
    async (field) => {
      const f = fixture();
      f.model.desktop = { ...f.model.desktop, [field]: ["foreign-work"] };
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_WORK_PENDING",
      );
      expect(ports.retain).not.toHaveBeenCalled();
      expect(ports.inspect).not.toHaveBeenCalled();
      released(f);
    },
  );

  it("does not let a previous clean Quit substitute for current-unconfirmed desktop obligations", async () => {
    const f = fixture("current");
    f.model.desktop = {
      changed: [],
      unreadable: [],
      obligations: ["QUIT_UNCONFIRMED:crash"],
    };
    await expect(f.execute()).rejects.toThrow(
      "PRESERVED_RECOVERY_WORK_PENDING",
    );
    expect(ports.inspect).not.toHaveBeenCalled();
    released(f);
  });

  const barriers = [
    "root:parent",
    "unchanged:running.json",
    "unchanged:config.json",
    "unchanged:last-quit.json",
    "desktop",
    "processes",
    "lease",
  ];
  it.each(
    (
      ["before-observation", "before-preparation", "after-preparation"] as const
    ).flatMap((phase) => barriers.map((barrier) => ({ phase, barrier }))),
  )(
    "stops after failed $phase $barrier proof and releases both guards",
    async ({ phase, barrier }) => {
      const f = fixture();
      const failure = Object.assign(Error(`unconfirmed ${barrier}`), {
        state: "unknown",
      });
      f.faults.set(`${phase}:${barrier}`, failure);
      await expect(f.execute()).rejects.toBe(failure);
      expect(ports.inspect).toHaveBeenCalledTimes(
        phase === "before-observation" ? 0 : 1,
      );
      expect(ports.prepare).toHaveBeenCalledTimes(
        phase === "after-preparation" ? 1 : 0,
      );
      expect(ports.finish).not.toHaveBeenCalled();
      released(f);
    },
  );

  it.each([
    "before-observation",
    "before-preparation",
    "after-preparation",
  ] as const)("refuses a false lease proof at %s", async (phase) => {
    const f = fixture();
    ports.verifyLease.mockImplementation(async () => f.model.phase !== phase);
    await expect(f.execute()).rejects.toThrow("PROMOTION_LEASE_LOST");
    expect(ports.prepare).toHaveBeenCalledTimes(
      phase === "after-preparation" ? 1 : 0,
    );
    expect(ports.finish).not.toHaveBeenCalled();
    released(f);
  });

  it.each(["before-observation", "before-preparation"] as const)(
    "does not launch the next child after %s attestation fails",
    async (phase) => {
      const f = fixture();
      const failure = Error("attestation changed");
      f.faults.set(`${phase}:attest`, failure);
      await expect(f.execute()).rejects.toBe(failure);
      expect(ports.inspect).toHaveBeenCalledTimes(
        phase === "before-observation" ? 0 : 1,
      );
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      released(f);
    },
  );

  it.each(["go-core.empty-recovery.pending", "archive"])(
    "refuses existing %s before children",
    async (which) => {
      const f = fixture();
      const name = which === "archive" ? path.basename(f.archive) : which;
      f.faults.set(
        `before-observation:absent:${name}`,
        Error("state already present"),
      );
      await expect(f.execute()).rejects.toThrow("state already present");
      expect(ports.retain).not.toHaveBeenCalled();
      expect(ports.inspect).not.toHaveBeenCalled();
      released(f);
    },
  );

  it.each(["retain-chat", "observe", "prepare", "archive-pin"])(
    "propagates %s uncertainty without starting the next effect",
    async (point) => {
      const f = fixture();
      const phase =
        point === "prepare"
          ? "before-preparation"
          : point === "archive-pin"
            ? "after-preparation"
            : "before-observation";
      const failure = Object.assign(Error(`${point} unknown`), {
        state: "unknown",
      });
      f.faults.set(`${phase}:${point}`, failure);
      await expect(f.execute()).rejects.toBe(failure);
      if (point === "retain-chat") expect(ports.inspect).not.toHaveBeenCalled();
      if (point === "retain-chat" || point === "observe")
        expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      released(f);
    },
  );

  it.each(["archive", "chat"] as const)(
    "rejects changed %s identity after preparation",
    async (which) => {
      const f = fixture();
      ports.prepare.mockImplementationOnce(async () => {
        f.model.phase = "after-preparation";
        f.model.roots[which].ino = 999;
        return f.child;
      });
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_ARCHIVE_CHANGED",
      );
      expect(ports.finish).not.toHaveBeenCalled();
      released(f);
    },
  );

  it("rejects a changed parent identity on the repeated proof after observation", async () => {
    const f = fixture();
    ports.inspect.mockImplementationOnce(async () => {
      f.model.phase = "before-preparation";
      f.model.roots.parent.ino = 999;
      return f.observed;
    });
    await expect(f.execute()).rejects.toThrow(
      "PRESERVED_RECOVERY_ROOT_CHANGED",
    );
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
    released(f);
  });

  it("rechecks the pinned archive identity after obtaining the archive pin", async () => {
    const f = fixture();
    f.movedArchive.mockImplementationOnce(async () => {
      f.model.roots.archive.ino = 999;
      return f.archivePin;
    });
    await expect(f.execute()).rejects.toThrow(
      "PRESERVED_RECOVERY_ARCHIVE_CHANGED",
    );
    expect(ports.finish).not.toHaveBeenCalled();
    released(f);
  });

  it.each([
    "running.json",
    "config.json",
    "last-quit.json",
    "go-core.empty-recovery.pending",
  ])("does not continue after an unreadable %s snapshot", async (name) => {
    const f = fixture();
    const failure = Object.assign(Error("snapshot outcome unknown"), {
      state: "unknown",
    });
    const phase =
      name === "go-core.empty-recovery.pending"
        ? "after-preparation"
        : "before-observation";
    f.faults.set(`${phase}:snapshot:${name}`, failure);
    await expect(f.execute()).rejects.toBe(failure);
    expect(ports.inspect).toHaveBeenCalledTimes(
      phase === "after-preparation" ? 1 : 0,
    );
    expect(ports.prepare).toHaveBeenCalledTimes(
      phase === "after-preparation" ? 1 : 0,
    );
    expect(ports.finish).not.toHaveBeenCalled();
    released(f);
  });

  it.each(["Profile", "Selection", "Mutations", "extra"] as const)(
    "rejects changed pending intent %s before finish",
    async (which) => {
      const f = fixture();
      const changed = {
        ...f.intentValue,
        ...(which === "Profile"
          ? { Profile: { ...f.intentValue.Profile, Root: "/other" } }
          : {}),
        ...(which === "Selection"
          ? { Selection: f.input.selectionInput.Selection }
          : {}),
        ...(which === "Mutations" ? { Mutations: f.observed.Mutations } : {}),
        ...(which === "extra" ? { unexpected: true } : {}),
      };
      f.files.set(f.pending, snapshot(changed, 13));
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_INTENT_CHANGED",
      );
      expect(ports.finish).not.toHaveBeenCalled();
      released(f);
    },
  );

  it("propagates a failed final callback proof without claiming completion", async () => {
    const f = fixture();
    const failure = Object.assign(Error("final process absence unknown"), {
      state: "unknown",
    });
    const completed = vi.fn();
    ports.finish.mockImplementation(async (handoff) => {
      f.model.phase = "finish";
      f.faults.set("finish:processes", failure);
      await handoff.proof();
      completed();
      return f.result;
    });
    await expect(f.execute()).rejects.toBe(failure);
    expect(completed).not.toHaveBeenCalled();
    released(f);
  });
});

// The held admission flag and identity verifier below are controlled doubles.
// They prove original-handle/callback custody, never a kernel lock, current-host
// exclusion, actual child settlement or installed-profile qualification.
function startupFixture(scope: "previous" | "current" | "absent" = "previous") {
  const f =
    scope === "absent" ? noQuitFixture("Farol") : fixture(scope, "Farol");
  const lease = {
    file: f.lease.file,
    record: {
      ...f.lease.record,
      generation: f.input.exact.buildId,
      role: "admission" as const,
    },
  } satisfies PromotionLeaseHandle;
  const proofs = { native: true, full: true };
  f.model.promotionHeld = true;
  const proofStep = (name: string) => {
    expect(f.model.promotionHeld).toBe(true);
    const event = `${f.model.phase}:${name}`;
    f.events.push(event);
    if (f.faults.has(event)) throw f.faults.get(event);
  };
  ports.acquire.mockRejectedValue(Error("SYNTHETIC_STARTUP_ALREADY_HELD"));
  ports.verifyLease.mockImplementation(async (actual) => {
    expect(actual).toBe(lease);
    proofStep("lease");
    return proofs.native;
  });
  const startup = {
    lease,
    verify: vi.fn(async () => {
      proofStep("startup-verify");
      return proofs.full;
    }),
    assertCurrent: vi.fn(async () => {
      proofStep("startup-current");
    }),
  };
  const input = { ...f.input, startup } satisfies StartupPreservedRecoveryInput;
  return {
    ...f,
    input,
    lease,
    startup,
    proofs,
    execute: () => recoverStartupPreservedChat(input),
  };
}

function startupRetained(f: ReturnType<typeof startupFixture>) {
  expect(ports.acquire).not.toHaveBeenCalled();
  expect(ports.release).not.toHaveBeenCalled();
  expect(f.model.promotionHeld).toBe(true);
  expect(f.model.fenceHeld).toBe(false);
  expect(f.events).not.toContain("promotion:acquire");
  expect(f.events).not.toContain("promotion:release");
}

function startupLegacyFixture() {
  const f = startupFixture("absent");
  const legacyPreparation = {
    operationId: "ba9d0681-5226-43d5-bc72-e7d6815f5bad",
    sha256: "7".repeat(64),
    verify: vi.fn(async () => {
      f.events.push(`${f.model.phase}:legacy-preparation`);
      expect(f.model.promotionHeld).toBe(true);
    }),
    retireInto: vi.fn(async (_archive: string) =>
      snapshot({ phase: "prepared" }, 52),
    ),
  };
  const input = {
    ...f.input,
    startup: { ...f.input.startup, legacyPreparation },
  };
  f.model.desktop = {
    ...f.model.desktop,
    obligations: ["CHATGPT_DISPATCH_PREPARED", ...f.model.desktop.obligations],
  };
  ports.legacyMembership.mockImplementation((pin, userData) => {
    expect(pin).toBe(legacyPreparation);
    expect(userData).toBe(input.userData);
  });
  return {
    ...f,
    input,
    legacyPreparation,
    execute: () => recoverStartupPreservedChat(input),
  };
}

describe("startup ownership of inactive legacy preparation (controlled ports)", () => {
  it("pins the exact legacy preparation through Go observation and forwards archival without an ACK", async () => {
    const f = startupLegacyFixture();
    ports.finish.mockImplementationOnce(async (handoff) => {
      f.model.phase = "finish";
      await handoff.proof();
      expect(handoff.legacyPreparation).toBe(f.legacyPreparation);
      expect(handoff.preservedHistory?.originalACK).toBe("unobserved");
      expect(handoff.preservedHistory?.originalTerminal).toBe("unobserved");
      return f.result;
    });
    await expect(f.execute()).resolves.toEqual(f.result);
    expect(ports.legacyMembership).toHaveBeenCalledExactlyOnceWith(
      f.legacyPreparation,
      f.input.userData,
    );
    for (const phase of [
      "before-observation",
      "before-preparation",
      "after-preparation",
      "finish",
    ])
      expect(f.events).toContain(`${phase}:legacy-preparation`);
    expect(f.legacyPreparation.retireInto).not.toHaveBeenCalled(); // finish is mocked
    startupRetained(f);
  });

  it("keeps an unpinned legacy preparation blocking before a Go child", async () => {
    const f = startupFixture("absent");
    f.model.desktop = {
      ...f.model.desktop,
      obligations: [
        "CHATGPT_DISPATCH_PREPARED",
        ...f.model.desktop.obligations,
      ],
    };
    await expect(f.execute()).rejects.toThrow(
      "PRESERVED_RECOVERY_WORK_PENDING",
    );
    expect(ports.inspect).not.toHaveBeenCalled();
    expect(ports.prepare).not.toHaveBeenCalled();
    startupRetained(f);
  });

  it.each([
    "CHATGPT_DELIVERY_PENDING:dispatch_intent",
    "CHATGPT_DELIVERY_PENDING:result_retained",
    "TASK_OUTCOME_UNKNOWN:1",
    "EDIT_DELIVERY_PENDING:other",
  ])(
    "never waives unrelated %s work for a selected legacy preparation",
    async (obligation) => {
      const f = startupLegacyFixture();
      f.model.desktop = {
        ...f.model.desktop,
        obligations: [...f.model.desktop.obligations, obligation],
      };
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_WORK_PENDING",
      );
      expect(ports.inspect).not.toHaveBeenCalled();
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      startupRetained(f);
    },
  );

  it("rejects missing factory membership before host IO or drain", async () => {
    const f = startupLegacyFixture(),
      failure = Error("STARTUP_LEGACY_PREPARATION_SELECTION_INVALID");
    ports.legacyMembership.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(f.execute()).rejects.toBe(failure);
    expect(ports.privateRoot).not.toHaveBeenCalled();
    expect(ports.drain).not.toHaveBeenCalled();
    expect(ports.inspect).not.toHaveBeenCalled();
    startupRetained(f);
  });

  it.each([
    "before-observation",
    "before-preparation",
    "after-preparation",
  ] as const)(
    "keeps a changed original metadata pin unconfirmed at %s",
    async (phase) => {
      const f = startupLegacyFixture(),
        failure = Error("STARTUP_LEGACY_PREPARATION_CHANGED");
      f.legacyPreparation.verify.mockImplementation(async () => {
        if (f.model.phase === phase) throw failure;
      });
      await expect(f.execute()).rejects.toBe(failure);
      if (phase === "before-observation")
        expect(ports.inspect).not.toHaveBeenCalled();
      if (phase !== "after-preparation")
        expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      startupRetained(f);
    },
  );
});

describe("original startup-held preserved recovery (controlled ports)", () => {
  afterEach(() => {
    expect(ports.acquire).not.toHaveBeenCalled();
    expect(ports.release).not.toHaveBeenCalled();
  });

  it.each(
    (["previous", "current", "absent"] as const).flatMap((scope) =>
      (["refused", "throws"] as const).map((acquire) => ({ scope, acquire })),
    ),
  )(
    "uses the held admission handle for $scope Quit when another acquire $acquire",
    async ({ scope, acquire }) => {
      const f = startupFixture(scope);
      if (acquire === "refused") ports.acquire.mockResolvedValue(null);
      const originalBytes = [f.run.bytes, f.config.bytes, f.quit.bytes].map(
        (bytes) => Buffer.from(bytes),
      );
      ports.finish.mockImplementationOnce(async (handoff) => {
        f.model.phase = "finish";
        expect(handoff.lease).toBe(f.lease);
        expect(handoff.verifyLease).toEqual(expect.any(Function));
        await handoff.proof();
        await handoff.reconcileConnector!();
        await expect(handoff.verifyLease!()).resolves.toBe(true);
        return f.result;
      });
      await expect(f.execute()).resolves.toEqual(f.result);
      expect(ports.verifyLease).toHaveBeenCalled();
      for (const [actual] of ports.verifyLease.mock.calls)
        expect(actual).toBe(f.lease);
      expect(ports.inspect).toHaveBeenCalledExactlyOnceWith(
        f.input.executable,
        f.input.profile,
        f.input.selectionInput,
        f.input.exact,
      );
      expect(ports.prepare).toHaveBeenCalledExactlyOnceWith(
        f.input.executable,
        f.input.profile,
        f.observed,
        f.input.exact,
      );
      expect(ports.prepare.mock.calls[0]![2]).toBe(f.observed);
      expect(ports.retain).toHaveBeenCalledExactlyOnceWith(f.chat, f.archive);
      const handoff = finishInput();
      expect(handoff.child).toBe(f.child);
      expect(handoff.run).toBe(f.run);
      expect(handoff.config).toBe(f.config);
      expect(handoff.intent).toBe(f.intent);
      expect(handoff.archivePin).toBe(f.archivePin);
      expect(handoff.preservedHistory).toEqual({
        scope: f.input.exact.current,
        originalACK: "unobserved",
        originalTerminal: "unobserved",
      });
      for (const phase of [
        "before-observation",
        "before-preparation",
        "after-preparation",
        "finish",
      ]) {
        expect(f.events).toContain(`${phase}:startup-verify`);
        expect(f.events).toContain(`${phase}:startup-current`);
      }
      if (scope === "absent") {
        expect(handoff).not.toHaveProperty("failedQuit");
        expect(handoff).not.toHaveProperty("previousConfirmedQuit");
        expect(ports.reconcileInactiveAfterCrash).toHaveBeenCalledWith({
          operationId: f.input.exact.operationId,
          failedRunSha256: f.input.expectedRunSha256,
          configSha256: f.input.expectedConfigSha256,
          proveIdle: handoff.proof,
        });
        expect(ports.confirmStop).toHaveBeenCalledWith(0);
        expect(ports.waitForStop).toHaveBeenCalledWith(0);
        expect(ports.reconcile).not.toHaveBeenCalled();
        expect(f.files.has(path.join(f.state, "last-quit.json"))).toBe(false);
      } else {
        expect(handoff.failedQuit).toBe(f.quit);
        expect(Object.hasOwn(handoff, "previousConfirmedQuit")).toBe(
          scope === "previous",
        );
        expect(ports.reconcile).toHaveBeenCalledWith({
          operationId: f.input.exact.operationId,
          failedQuitSha256: f.input.expectedQuitSha256,
          proveIdle: handoff.proof,
        });
        expect(ports.reconcileInactiveAfterCrash).not.toHaveBeenCalled();
      }
      expect([f.run.bytes, f.config.bytes, f.quit.bytes]).toEqual(
        originalBytes,
      );
      startupRetained(f);
    },
  );

  it("keeps the closed maintenance route's private-basename refusal", async () => {
    const f = fixture("previous", "Farol");
    await expect(f.execute()).rejects.toThrow(
      "PRESERVED_RECOVERY_SELECTION_INVALID",
    );
    expect(ports.privateRoot).not.toHaveBeenCalled();
    expect(ports.drain).not.toHaveBeenCalled();
    expect(ports.inspect).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
  });

  it.each(["file", "role", "generation"] as const)(
    "refuses the wrong held %s identity before drain or children",
    async (field) => {
      const f = startupFixture();
      if (field === "file")
        f.lease.file = path.join("/other", "promotion.lease");
      if (field === "role")
        Object.assign(f.lease.record, { role: "promotion" });
      if (field === "generation") f.lease.record.generation = "other-build";
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_STARTUP_LEASE_INVALID",
      );
      expect(ports.drain).not.toHaveBeenCalled();
      expect(ports.retain).not.toHaveBeenCalled();
      expect(ports.inspect).not.toHaveBeenCalled();
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      startupRetained(f);
    },
  );

  it.each(["false", "copied", "released"] as const)(
    "refuses a %s native-handle proof before children (identity double)",
    async (kind) => {
      const f = startupFixture();
      const held = new WeakSet<PromotionLeaseHandle>([f.lease]);
      if (kind === "copied") f.startup.lease = structuredClone(f.lease);
      if (kind === "released") held.delete(f.lease);
      ports.verifyLease.mockImplementation(async (actual) => {
        expect(actual).toBe(f.startup.lease);
        return kind !== "false" && held.has(actual);
      });
      await expect(f.execute()).rejects.toThrow("PROMOTION_LEASE_LOST");
      expect(ports.verifyLease).toHaveBeenCalled();
      expect(ports.inspect).not.toHaveBeenCalled();
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      startupRetained(f);
    },
  );

  it.each(
    (
      ["before-observation", "before-preparation", "after-preparation"] as const
    ).flatMap((phase) =>
      (["false", "throws"] as const).map((outcome) => ({ phase, outcome })),
    ),
  )(
    "refuses original full startup verification $outcome at $phase",
    async ({ phase, outcome }) => {
      const f = startupFixture();
      const failure = Object.assign(
        Error("original startup verification unknown"),
        { state: "unknown" },
      );
      f.startup.verify.mockImplementation(async () => {
        if (f.model.phase !== phase) return true;
        if (outcome === "throws") throw failure;
        return false;
      });
      const done = f.execute();
      if (outcome === "throws") await expect(done).rejects.toBe(failure);
      else await expect(done).rejects.toThrow("PROMOTION_LEASE_LOST");
      if (phase === "before-observation")
        expect(ports.inspect).not.toHaveBeenCalled();
      if (phase !== "after-preparation")
        expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      startupRetained(f);
    },
  );

  it.each([
    "before-observation",
    "before-preparation",
    "after-preparation",
  ] as const)(
    "preserves original current-host proof failure at %s",
    async (phase) => {
      const f = startupFixture();
      const failure = Object.assign(
        Error("current host or owned child unconfirmed"),
        { state: "unknown" },
      );
      f.faults.set(`${phase}:startup-current`, failure);
      await expect(f.execute()).rejects.toBe(failure);
      if (phase === "before-observation")
        expect(ports.inspect).not.toHaveBeenCalled();
      if (phase !== "after-preparation")
        expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      startupRetained(f);
    },
  );

  it.each(
    (["before-observation", "after-preparation"] as const).flatMap((phase) =>
      (["verify", "assertCurrent"] as const).flatMap((proof) =>
        (["resolve", "reject"] as const).map((outcome) => ({
          phase,
          proof,
          outcome,
        })),
      ),
    ),
  )(
    "awaits original $proof $outcome at $phase before the next effect",
    async ({ phase, proof, outcome }) => {
      const f = startupFixture();
      const entered = deferred<void>();
      const gate = deferred<void>();
      const failure = Error("original startup proof outcome unknown");
      let waiting = false;
      const hold = async () => {
        if (waiting || f.model.phase !== phase) return;
        waiting = true;
        entered.resolve();
        await gate.promise;
      };
      if (proof === "verify") {
        const original = f.startup.verify.getMockImplementation()!;
        f.startup.verify.mockImplementation(async () => {
          const verified = await original();
          await hold();
          return verified;
        });
      } else {
        const original = f.startup.assertCurrent.getMockImplementation()!;
        f.startup.assertCurrent.mockImplementation(async () => {
          await original();
          await hold();
        });
      }
      const done = f.execute();
      const settled = vi.fn();
      void done.then(settled, settled);
      await entered.promise;
      expect(f.model.promotionHeld).toBe(true);
      if (phase === "before-observation") {
        expect(ports.inspect).not.toHaveBeenCalled();
        expect(ports.prepare).not.toHaveBeenCalled();
      } else {
        expect(ports.prepare).toHaveBeenCalled();
        expect(f.model.fenceHeld).toBe(true);
      }
      expect(ports.finish).not.toHaveBeenCalled();
      expect(ports.release).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      if (outcome === "resolve") {
        gate.resolve();
        await expect(done).resolves.toEqual(f.result);
      } else {
        gate.reject(failure);
        await expect(done).rejects.toBe(failure);
        expect(ports.finish).not.toHaveBeenCalled();
      }
      startupRetained(f);
    },
  );

  it.each(
    (["before-preparation", "after-preparation"] as const).flatMap((phase) =>
      (["file", "role", "generation", "native"] as const).map((field) => ({
        phase,
        field,
      })),
    ),
  )("rechecks the actual held $field at $phase", async ({ phase, field }) => {
    const f = startupFixture();
    const change = () => {
      if (field === "file") f.lease.file = "/other/promotion.lease";
      if (field === "role")
        Object.assign(f.lease.record, { role: "promotion" });
      if (field === "generation") f.lease.record.generation = "other-build";
      if (field === "native") f.proofs.native = false;
    };
    if (phase === "before-preparation") {
      const original = ports.inspect.getMockImplementation()!;
      ports.inspect.mockImplementationOnce(async (...args) => {
        const observed = await original(...args);
        change();
        return observed;
      });
    } else {
      const original = ports.prepare.getMockImplementation()!;
      ports.prepare.mockImplementationOnce(async (...args) => {
        const child = await original(...args);
        change();
        return child;
      });
    }
    await expect(f.execute()).rejects.toThrow(
      field === "native"
        ? "PROMOTION_LEASE_LOST"
        : "PRESERVED_RECOVERY_STARTUP_LEASE_INVALID",
    );
    if (phase === "before-preparation")
      expect(ports.prepare).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
    startupRetained(f);
  });

  it.each([
    "full-false",
    "full-throws",
    "current",
    "native",
    "file",
    "role",
    "generation",
  ] as const)(
    "the forwarded final checker refuses changed %s proof in mock finish",
    async (changed) => {
      const f = startupFixture();
      const failure = Object.assign(
        Error("original final startup proof unknown"),
        { state: "unknown" },
      );
      const completed = vi.fn();
      ports.finish.mockImplementationOnce(async (handoff) => {
        f.model.phase = "finish";
        expect(handoff.lease).toBe(f.lease);
        expect(handoff.verifyLease).toEqual(expect.any(Function));
        await handoff.proof();
        await expect(handoff.verifyLease!()).resolves.toBe(true);
        if (changed === "full-false") f.proofs.full = false;
        if (changed === "full-throws")
          f.faults.set("finish:startup-verify", failure);
        if (changed === "current")
          f.faults.set("finish:startup-current", failure);
        if (changed === "native") f.proofs.native = false;
        if (changed === "file") f.lease.file = "/other/promotion.lease";
        if (changed === "role")
          Object.assign(f.lease.record, { role: "promotion" });
        if (changed === "generation") f.lease.record.generation = "other-build";
        // This is the mock's eligibility decision, not the real pending move.
        // Native verification remains true when only the original full proof
        // changes, so a native-only forwarded checker would wrongly complete.
        if (!(await handoff.verifyLease!()))
          throw Error("PROMOTION_LEASE_LOST");
        completed();
        return f.result;
      });
      const done = f.execute();
      if (changed === "full-throws" || changed === "current")
        await expect(done).rejects.toBe(failure);
      else
        await expect(done).rejects.toThrow(
          changed === "file" || changed === "role" || changed === "generation"
            ? "PRESERVED_RECOVERY_STARTUP_LEASE_INVALID"
            : "PROMOTION_LEASE_LOST",
        );
      expect(completed).not.toHaveBeenCalled();
      expect(f.files.get(f.pending)).toBe(f.intent);
      startupRetained(f);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "awaits mocked finish %s while leaving the caller's admission lease held",
    async (outcome) => {
      const f = startupFixture();
      const entered = deferred<Finish>();
      const finish = deferred<typeof f.result>();
      const failure = Object.assign(Error("startup finish outcome unknown"), {
        state: "unknown",
      });
      ports.finish.mockImplementationOnce((handoff) => {
        entered.resolve(handoff);
        return finish.promise;
      });
      const done = f.execute();
      const settled = vi.fn();
      void done.then(settled, settled);
      const handoff = await entered.promise;
      expect(handoff.lease).toBe(f.lease);
      expect(handoff.verifyLease).toEqual(expect.any(Function));
      expect(f.model.promotionHeld).toBe(true);
      expect(f.model.fenceHeld).toBe(true);
      expect(ports.release).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      if (outcome === "resolve") {
        finish.resolve(f.result);
        await expect(done).resolves.toEqual(f.result);
      } else {
        finish.reject(failure);
        await expect(done).rejects.toBe(failure);
      }
      startupRetained(f);
    },
  );

  it.each(
    (["properties", "object"] as const).flatMap((replacement) =>
      (["success", "original-proof-fails"] as const).map((outcome) => ({
        replacement,
        outcome,
      })),
    ),
  )(
    "captures original ports before IO despite startup $replacement replacement ($outcome)",
    async ({ replacement, outcome }) => {
      const f = startupFixture();
      const original = {
        verify: f.startup.verify,
        assertCurrent: f.startup.assertCurrent,
        attest: f.input.attest,
        desktopState: f.input.desktopState,
        processesAbsent: f.input.processesAbsent,
      };
      const entered = deferred<void>();
      const gate = deferred<void>();
      const root = ports.privateRoot.getMockImplementation()!;
      ports.privateRoot.mockImplementationOnce(async (directory) => {
        entered.resolve();
        await gate.promise;
        return root(directory);
      });
      const replacementVerify = vi.fn(async () => {
        throw Error("late startup verifier replacement");
      });
      const replacementCurrent = vi.fn(async () => {
        throw Error("late current-host proof replacement");
      });
      const replacementPort = vi.fn(() => {
        throw Error("late host port replacement");
      });
      const failure = Error("captured original proof later refused");
      if (outcome === "original-proof-fails")
        f.faults.set("after-preparation:startup-verify", failure);
      const done = f.execute();
      void done.catch(() => undefined);
      await entered.promise;
      const changed = {
        lease: structuredClone(f.lease),
        verify: replacementVerify,
        assertCurrent: replacementCurrent,
      };
      if (replacement === "properties") Object.assign(f.startup, changed);
      else f.input.startup = changed;
      f.input.attest = replacementPort;
      f.input.desktopState = replacementPort;
      f.input.processesAbsent = replacementPort;
      ports.finish.mockImplementationOnce(async (handoff) => {
        f.model.phase = "finish";
        await handoff.proof();
        await expect(handoff.verifyLease!()).resolves.toBe(true);
        expect(handoff.lease).toBe(f.lease);
        expect(handoff.input.attest).toBe(original.attest);
        expect(handoff.input.processesAbsent).toBe(original.processesAbsent);
        return f.result;
      });
      gate.resolve();
      if (outcome === "success") await expect(done).resolves.toEqual(f.result);
      else {
        await expect(done).rejects.toBe(failure);
        expect(ports.finish).not.toHaveBeenCalled();
      }
      expect(original.verify).toHaveBeenCalled();
      expect(original.assertCurrent).toHaveBeenCalled();
      expect(original.desktopState).toHaveBeenCalled();
      expect(replacementVerify).not.toHaveBeenCalled();
      expect(replacementCurrent).not.toHaveBeenCalled();
      expect(replacementPort).not.toHaveBeenCalled();
      for (const [actual] of ports.verifyLease.mock.calls)
        expect(actual).toBe(f.lease);
      startupRetained(f);
    },
  );

  it.each(
    (
      [
        "before-observation",
        "before-preparation",
        "after-preparation",
        "finish",
      ] as const
    ).flatMap((phase) =>
      [
        "root:parent",
        "unchanged:running.json",
        "unchanged:config.json",
        "unchanged:last-quit.json",
        "desktop",
        "connector-work",
        "processes",
      ].map((barrier) => ({ phase, barrier })),
    ),
  )(
    "retains the existing $barrier refusal at $phase under startup admission",
    async ({ phase, barrier }) => {
      const f = startupFixture();
      const failure = Object.assign(Error(`startup ${barrier} proof unknown`), {
        state: "unknown",
      });
      f.faults.set(`${phase}:${barrier}`, failure);
      const completed = vi.fn();
      ports.finish.mockImplementationOnce(async (handoff) => {
        f.model.phase = "finish";
        await handoff.proof();
        completed();
        return f.result;
      });
      await expect(f.execute()).rejects.toBe(failure);
      if (phase === "before-observation")
        expect(ports.inspect).not.toHaveBeenCalled();
      if (phase === "before-observation" || phase === "before-preparation")
        expect(ports.prepare).not.toHaveBeenCalled();
      if (phase !== "finish") expect(ports.finish).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      startupRetained(f);
    },
  );

  it.each(["current", "absent"] as const)(
    "still refuses unresolved connector journals for %s Quit",
    async (scope) => {
      const f = startupFixture(scope);
      const failure = Error("CLOSED_COMPUTER_RECOVERY_WORK_PENDING");
      f.faults.set("before-preparation:connector-work", failure);
      await expect(f.execute()).rejects.toBe(failure);
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.reconcileInactiveAfterCrash).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      startupRetained(f);
    },
  );

  it.each(["full", "current", "native"] as const)(
    "rechecks the original %s proof inside the mocked crash reconciliation",
    async (proof) => {
      const f = startupFixture("absent");
      const failure = Error("owned read-only child proof unknown");
      const original =
        ports.reconcileInactiveAfterCrash.getMockImplementation()!;
      ports.reconcileInactiveAfterCrash.mockImplementationOnce(
        async (input) => {
          if (proof === "full") f.proofs.full = false;
          if (proof === "current")
            f.faults.set("before-preparation:startup-current", failure);
          if (proof === "native") f.proofs.native = false;
          await original(input);
        },
      );
      const done = f.execute();
      if (proof === "current") await expect(done).rejects.toBe(failure);
      else await expect(done).rejects.toThrow("PROMOTION_LEASE_LOST");
      expect(ports.stop).toHaveBeenCalled();
      expect(ports.confirmStop).not.toHaveBeenCalled();
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      startupRetained(f);
    },
  );

  it.each(["profile", "operation", "run", "config", "quit"] as const)(
    "refuses invalid startup %s selection before host IO",
    async (field) => {
      const f = startupFixture();
      if (field === "profile") f.input.profile.root = "/other/go-core";
      if (field === "operation") f.input.exact.operationId = "not-a-uuid";
      if (field === "run") f.input.expectedRunSha256 = "a".repeat(63);
      if (field === "config") f.input.expectedConfigSha256 = "A".repeat(64);
      if (field === "quit") f.input.expectedQuitSha256 = "invalid";
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_SELECTION_INVALID",
      );
      expect(ports.privateRoot).not.toHaveBeenCalled();
      expect(ports.drain).not.toHaveBeenCalled();
      expect(ports.inspect).not.toHaveBeenCalled();
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      startupRetained(f);
    },
  );

  it.each(["retain-chat", "observe", "prepare", "archive-pin"] as const)(
    "does not continue startup recovery after %s uncertainty",
    async (point) => {
      const f = startupFixture();
      const phase =
        point === "prepare"
          ? "before-preparation"
          : point === "archive-pin"
            ? "after-preparation"
            : "before-observation";
      const failure = Object.assign(Error(`${point} outcome unknown`), {
        state: "unknown",
      });
      f.faults.set(`${phase}:${point}`, failure);
      await expect(f.execute()).rejects.toBe(failure);
      if (point === "retain-chat") expect(ports.inspect).not.toHaveBeenCalled();
      if (point === "retain-chat" || point === "observe")
        expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      startupRetained(f);
    },
  );

  it.each(["running.json", "config.json", "last-quit.json"])(
    "refuses changed selected %s bytes on the startup route",
    async (name) => {
      const f = startupFixture();
      f.files.set(path.join(f.state, name), snapshot({ changed: true }, 99));
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_STATE_CHANGED",
      );
      expect(ports.retain).not.toHaveBeenCalled();
      expect(ports.inspect).not.toHaveBeenCalled();
      expect(ports.prepare).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      startupRetained(f);
    },
  );

  it.each(["Profile", "Selection", "Mutations", "extra"] as const)(
    "refuses changed pending intent %s before startup finish",
    async (which) => {
      const f = startupFixture();
      const changed = {
        ...f.intentValue,
        ...(which === "Profile"
          ? { Profile: { ...f.intentValue.Profile, Root: "/other" } }
          : {}),
        ...(which === "Selection"
          ? { Selection: f.input.selectionInput.Selection }
          : {}),
        ...(which === "Mutations" ? { Mutations: f.observed.Mutations } : {}),
        ...(which === "extra" ? { unexpected: true } : {}),
      };
      f.files.set(f.pending, snapshot(changed, 13));
      await expect(f.execute()).rejects.toThrow(
        "PRESERVED_RECOVERY_INTENT_CHANGED",
      );
      expect(ports.finish).not.toHaveBeenCalled();
      startupRetained(f);
    },
  );
});
