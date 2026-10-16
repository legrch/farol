import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recoverClosedPreservedChat,
  type ClosedPreservedRecoveryInput,
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
}));
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
vi.mock("../../src/apps/desktop/promotion-lease", () => ({
  acquirePromotionLease: ports.acquire,
  releasePromotionLease: ports.release,
  verifyPromotionLease: ports.verifyLease,
}));
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
  basename: "Farol Dev" | "Farol DEV" = "Farol Dev",
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

function noQuitFixture() {
  const f = fixture();
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
