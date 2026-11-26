import type { ProductSettings } from "../../../src/pkg/product-settings/contract";
import type { SettingsStoreReplaceResult } from "../bridge/wire";
import {
  SettingsStoreUnsupported,
  settingsStoreSnapshot,
  settingsStoreReplacement,
  type SettingsStoreScope,
} from "../settings-store-document";
import type {
  ComputerSettingsPublication,
  SettingsDeliveryStore,
  WorkspaceEditLeaseGuard,
  WorkspaceEditLeaseHold,
} from "./input";
import type { ProductSettingsStore } from "./store";

// The Go settings delivery store: the one trusted host binding through which
// the Go core reads and replaces the owner's settings over the retained single
// writer. It owns the delivery fence (loss latch, queued withdrawal outcome,
// held withdrawal) and the deadline, revision and conditional-write checks of
// every read, replace and fence; every other settings write consults the same
// fence through `fenced`. The service keeps the current settings, the queue
// and the policy; this module reaches them only through the ports below, read
// late on every call, never captured.

// The one throw `beforeWrite` may raise on this path: the promotion lease a
// guarded edit holds is no longer the lease on disk. Carried as its own class
// so the service's `commit` can report the edit's readable refusal instead of
// the generic write failure every other `save` error becomes.
export class WorkspaceEditLeaseLost extends Error {
  constructor() {
    super("WORKSPACE_MUTATION_PROMOTION_PENDING");
  }
}

export type SettingsDeliveryPorts = Readonly<{
  store: Pick<
    ProductSettingsStore,
    "load" | "saveConditional" | "fenceConditionalWrites"
  >;
  settings: Readonly<{
    current(): ProductSettings | null;
    // Adopt exactly these settings as current, with no recorded error.
    settle(settings: ProductSettings): void;
    // Drop the current settings and record the unknown write outcome.
    lose(): void;
  }>;
  // The service's one-owner-change-at-a-time queue; re-entrant.
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  authority: Readonly<{
    // Absent until the native publication owner is attached.
    withdrawal(): (() => Promise<ComputerSettingsPublication>) | undefined;
    changed(
      before: ProductSettings,
      candidate: ProductSettings,
      original: ProductSettings,
    ): Promise<boolean>;
  }>;
  leases: Readonly<{
    guard: WorkspaceEditLeaseGuard | undefined;
    keep(operationId: string, lease: WorkspaceEditLeaseHold): void;
    release(operationId: string): Promise<void>;
  }>;
}>;

export type SettingsDelivery = Readonly<{
  // Exactly one binding; a second attach throws.
  attach(scope: SettingsStoreScope): SettingsDeliveryStore;
  readonly attached: boolean;
  readonly fenced: boolean;
  // Synchronous: loss is marked even while a write is awaiting.
  latchLoss(): void;
  assertCurrent(expected: ProductSettings): void;
  holdWithdrawal(held: boolean): void;
  retainAuthorityFailure(error: unknown): void;
}>;

export function createSettingsDelivery(
  ports: SettingsDeliveryPorts,
): SettingsDelivery {
  const { store, settings, authority, leases } = ports;
  let attached = false;
  let fenced = false;
  let fenceOutcome: Promise<void> | undefined;
  let withdrawalHeld = false;

  const assertDeadline = (deadlineMillis: string | undefined): void => {
    // Omission is for direct in-process storage callers only. The reciprocal
    // driver always forwards the original Go command deadline unchanged.
    if (deadlineMillis === undefined) return;
    const deadline = Number(deadlineMillis);
    if (
      !/^[1-9][0-9]*$/u.test(deadlineMillis) ||
      !Number.isSafeInteger(deadline) ||
      deadline <= Date.now() ||
      deadline - Date.now() > 15_000
    )
      throw new Error("SETTINGS_DELIVERY_DEADLINE_EXPIRED");
  };

  const latchLoss = (): void => {
    fenced = true;
    store.fenceConditionalWrites();
    settings.lose();
  };

  const assertCurrent = (expected: ProductSettings): void => {
    if (settings.current() !== expected || fenced)
      throw new Error("TASK_SETTINGS_SOURCE_CHANGED");
  };

  const fence = (): Promise<void> => {
    latchLoss();
    if (fenceOutcome) return fenceOutcome;
    // No publication callback: authority remains withdrawn until an explicitly
    // supported recovery, never a fresh read of valid-looking disk bytes.
    fenceOutcome = (async () => {
      // A successful withdrawal with an unused publication capability already
      // proves inactivity. Repeating it would call the locked host owner again.
      if (withdrawalHeld) return;
      await authority.withdrawal()?.();
      withdrawalHeld = true;
    })();
    return fenceOutcome;
  };

  const retainAuthorityFailure = (error: unknown): void => {
    latchLoss();
    fenceOutcome = Promise.reject(error);
    void fenceOutcome.catch(() => undefined);
  };

  const replace = async (
    scope: SettingsStoreScope,
    change: unknown,
    deadlineMillis?: string,
  ): Promise<SettingsStoreReplaceResult> => {
    if (fenced) return { status: "unknown" };
    const current = settings.current();
    if (!current) return { status: "not_written" };
    const original = current;
    const before = structuredClone(original);
    let candidate: ProductSettings | undefined;
    try {
      assertDeadline(deadlineMillis);
      candidate = settingsStoreReplacement(before, scope, change);
    } catch {
      return { status: "not_written" };
    }
    if (!candidate) return { status: "not_written" };
    const beginning =
      before.computer.pendingEdit === null &&
      candidate.computer.pendingEdit !== null;
    let lease: WorkspaceEditLeaseHold | null = null;
    let storeCalled = false;
    let keepLease = false;
    try {
      if (beginning && leases.guard) {
        lease = await leases.guard.acquireForAdmission();
        if (!lease || (lease.verify && !(await lease.verify())))
          return { status: "not_written" };
      }
      const changed = await authority.changed(before, candidate, original);
      assertDeadline(deadlineMillis);
      let publication: ComputerSettingsPublication | undefined;
      const withdraw = authority.withdrawal();
      if (changed && withdraw) {
        try {
          publication = await withdraw();
          withdrawalHeld = true;
        } catch (error) {
          // The original authority call may have completed. Retain that exact
          // uncertainty instead of retrying it through the generic fence hook.
          retainAuthorityFailure(error);
          return { status: "unknown" };
        }
      }
      if (fenced) {
        await fence();
        return { status: "unknown" };
      }
      assertCurrent(original);
      assertDeadline(deadlineMillis);
      const verify = lease?.verify?.bind(lease);
      storeCalled = true;
      const written = await store.saveConditional(before, candidate, {
        beforeWrite: async () => {
          if (verify && !(await verify())) throw new WorkspaceEditLeaseLost();
          assertCurrent(original);
        },
        assertBeforePublication: () => {
          assertCurrent(original);
          assertDeadline(deadlineMillis);
        },
      });
      if (written.status === "not_written") return written;
      assertDeadline(deadlineMillis);
      if (written.status === "unknown" || fenced) {
        await fence();
        return { status: "unknown" };
      }
      if (publication) {
        withdrawalHeld = false;
        try {
          await publication.publish(structuredClone(written.settings));
        } catch (error) {
          retainAuthorityFailure(error);
          return { status: "unknown" };
        }
      }
      if (fenced) {
        await fence();
        return { status: "unknown" };
      }
      settings.settle(written.settings);
      if (beginning && lease) {
        leases.keep(candidate.computer.pendingEdit!.operationId, lease);
        keepLease = true;
      }
      if (
        candidate.computer.pendingEdit === null &&
        before.computer.pendingEdit !== null
      )
        await leases.release(before.computer.pendingEdit.operationId);
      if (fenced) return { status: "unknown" };
      return {
        status: "committed",
        snapshot: settingsStoreSnapshot(written.settings, scope),
      };
    } catch {
      if (fenced) {
        await fence().catch(() => undefined);
        return { status: "unknown" };
      }
      if (!storeCalled) return { status: "not_written" };
      await fence().catch(() => undefined);
      return { status: "unknown" };
    } finally {
      if (!keepLease) await lease?.release();
    }
  };

  const attach = (scope: SettingsStoreScope): SettingsDeliveryStore => {
    if (attached) throw new Error("SETTINGS_DELIVERY_STORE_ALREADY_BOUND");
    attached = true;
    const selected = structuredClone(scope);
    return {
      read: (deadlineMillis) =>
        ports.exclusive(async () => {
          if (fenced || !settings.current()) return { status: "unavailable" };
          try {
            assertDeadline(deadlineMillis);
            const readback = await store.load();
            assertDeadline(deadlineMillis);
            if (JSON.stringify(readback) !== JSON.stringify(settings.current()))
              return { status: "unavailable" };
            return {
              status: "ok",
              snapshot: settingsStoreSnapshot(settings.current()!, selected),
            };
          } catch (error) {
            return {
              status:
                error instanceof SettingsStoreUnsupported
                  ? "unsupported"
                  : "unavailable",
            };
          }
        }),
      replace: (change, deadlineMillis) => {
        // Capture caller bytes before joining the queue.
        const captured: unknown = structuredClone(change);
        return ports.exclusive(() =>
          replace(selected, captured, deadlineMillis),
        );
      },
      fence: () => {
        // Loss is synchronous, including while a write/readback/publication is
        // awaiting. The queued withdrawal must not be the first loss marker.
        latchLoss();
        return ports.exclusive(() => fence());
      },
    };
  };

  return {
    attach,
    get attached() {
      return attached;
    },
    get fenced() {
      return fenced;
    },
    latchLoss,
    assertCurrent,
    holdWithdrawal: (held) => {
      withdrawalHeld = held;
    },
    retainAuthorityFailure,
  };
}
