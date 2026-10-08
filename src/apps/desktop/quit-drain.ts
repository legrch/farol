// The receipt's on-disk contract (schema, serializer, parser) is owned by
// `quit-receipt.ts` and shared with the promotion reader; the desktop's
// `recordQuitReceipt` writes exactly `serializeQuitReceipt(receipt, at)`.
export {
  serializeQuitReceipt,
  type QuitReceipt,
  type QuitReceiptInput,
} from "./quit-receipt";

export type OwnedCloser = Readonly<{ name: string; close(): Promise<void> }>;

export type QuitDrainReceipt = Readonly<{
  drained: boolean;
  // Owned children whose exit was not confirmed before the deadline, or
  // whose close failed: the app cannot claim they stopped.
  unconfirmed: readonly string[];
}>;

/**
 * Closes every owned child at quit and waits for each to confirm, up to one
 * shared deadline. Sending a signal is not a drain; only a confirmed close
 * is. What did not confirm is named, never reported as drained.
 */
export async function drainOwnedChildren(
  closers: readonly OwnedCloser[],
  deadlineMs: number,
  // Preparation may have spent part of Quit's original absolute budget.
  // Omitted by existing callers, whose relative-drain semantics are retained.
  deadlineAt?: number,
): Promise<QuitDrainReceipt> {
  const confirmed = new Set<string>();
  const closing = Promise.allSettled(
    closers.map(async (closer) => {
      await closer.close();
      if (deadlineAt === undefined || Date.now() < deadlineAt)
        confirmed.add(closer.name);
    }),
  );
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    closing,
    new Promise<void>((resolve) => {
      timer = setTimeout(
        resolve,
        deadlineAt === undefined
          ? deadlineMs
          : Math.max(0, deadlineAt - Date.now()),
      );
      // This timer is the last-resort path to the real app.quit(). It must
      // remain referenced: a stalled closer may own no active handle, and an
      // unref'd deadline would then let Node stop servicing the drain before
      // either the receipt or the final quit can run.
    }),
  ]);
  clearTimeout(timer);
  const unconfirmed = closers
    .map((closer) => closer.name)
    .filter((name) => !confirmed.has(name));
  return { drained: unconfirmed.length === 0, unconfirmed };
}

export type QuitPreparationContext = Readonly<{
  // The original Quit deadline, in the Date.now() clock. Never renew it.
  deadlineAt: number;
  // Recheck synchronously immediately before each new effect, including
  // after every await. Closes before collection or at the deadline. This
  // does not cancel a helper already dispatched while the fence was open.
  canStartEffect(): boolean;
}>;

// Structurally accepts the existing normal-Quit updater receipt. Accepted
// means preparation's ACK only, never proof that an update was installed.
export type QuitPreparationResult = Readonly<{
  status: "accepted" | "skipped" | "blocked" | "unknown";
}>;

export type QuitDrainPorts = Readonly<{
  // Optional one-shot preparation, before collect changes closing flags.
  // The hook and its downstream ports must honor the effect fence; a race
  // against a timeout alone cannot prevent a late dispatch. Keep the
  // original attempt/unknown outcome: no retry, recursive Quit or relaunch.
  // Download preference is not consent for an install-on-Quit effect.
  prepare?(context: QuitPreparationContext): Promise<QuitPreparationResult>;
  // Every owned child after preparation (if present): one-off host checks, the
  // product Agent, the connector, Route B and the relay. Collected exactly
  // once; a child that unregisters itself afterwards is still drained.
  collect(): readonly OwnedCloser[];
  deadlineMs: number;
  // The private diagnostic receipt. Its failure changes nothing about the
  // drain's outcome or the quit.
  record(receipt: QuitDrainReceipt): Promise<void>;
  // Quits for real, once, after the drain settled or its deadline passed.
  quit(): void;
}>;

export type QuitDrainState = "idle" | "draining" | "done";

export type QuitDrain = Readonly<{
  // The host's before-quit hook: prevents the first quit, drains, then lets
  // the real one through. Later quits during the drain change nothing.
  onBeforeQuit(event: Readonly<{ preventDefault(): void }>): void;
  state(): QuitDrainState;
}>;

/**
 * Quit as the product composes it: the first quit is held while every owned
 * child is closed and confirmed up to one deadline, the receipt is recorded,
 * and only then does the real quit run. A second quit while draining neither
 * restarts the drain nor skips it; after the drain, quit is not intercepted.
 */
export function createQuitDrain(ports: QuitDrainPorts): QuitDrain {
  let state: QuitDrainState = "idle";
  return {
    state: () => state,
    onBeforeQuit: (event) => {
      if (state === "done") return;
      event.preventDefault();
      if (state === "draining") return;
      state = "draining";
      const startedAt = Date.now();
      const deadlineAt = startedAt + ports.deadlineMs;
      const remaining = () => Math.max(0, deadlineAt - Date.now());
      const prepare = ports.prepare;
      const collectAndDrain = (): Promise<QuitDrainReceipt> => {
        try {
          const closers = [...ports.collect()];
          if (!prepare) return drainOwnedChildren(closers, ports.deadlineMs);
          const budget = remaining();
          if (budget === 0) {
            // Still ask every actual closer to stop, but an exit after the
            // deadline is not confirmed within this Quit's budget.
            void Promise.allSettled(
              closers.map(async (closer) => closer.close()),
            );
            return Promise.resolve({
              drained: closers.length === 0,
              unconfirmed: closers.map((closer) => closer.name),
            });
          }
          return drainOwnedChildren(closers, budget, deadlineAt);
        } catch {
          // Collection may already have disposed some handles before throwing.
          // Their exit is unproved, so keep the run marker and still quit.
          return Promise.resolve({
            drained: false,
            unconfirmed: ["collection"],
          });
        }
      };
      const prepareAndDrain = async (): Promise<QuitDrainReceipt> => {
        let unconfirmed = false;
        if (prepare && remaining() > 0) {
          let preparing = true;
          let preparationTimer: NodeJS.Timeout | undefined;
          const expired = new Promise<QuitPreparationResult>((resolve) => {
            // Referenced: pending preparation must not strand normal Quit.
            preparationTimer = setTimeout(
              () => resolve({ status: "unknown" }),
              remaining(),
            );
          });
          try {
            const originalAttempt = prepare(
              Object.freeze({
                deadlineAt,
                canStartEffect: () => preparing && Date.now() < deadlineAt,
              }),
            );
            if (remaining() === 0) {
              // Synchronous hook work also spends the original budget.
              // Observe late rejection without settling/cancelling its attempt.
              void originalAttempt.catch(() => undefined);
              unconfirmed = true;
            } else {
              const result = await Promise.race([originalAttempt, expired]);
              switch (result.status) {
                case "accepted":
                case "skipped":
                case "blocked":
                  unconfirmed = remaining() === 0;
                  break;
                default:
                  unconfirmed = true;
              }
            }
          } catch {
            // A throwing hook cannot prove whether it dispatched an effect.
            unconfirmed = true;
          } finally {
            preparing = false;
            clearTimeout(preparationTimer);
          }
        }
        const receipt = await collectAndDrain();
        return unconfirmed
          ? {
              drained: false,
              unconfirmed: ["preparation", ...receipt.unconfirmed],
            }
          : receipt;
      };
      // Preserve synchronous collection and child-close invocation when the
      // optional hook is absent, including reentrant before-quit behavior.
      const draining = prepare ? prepareAndDrain() : collectAndDrain();
      let recordTimer: NodeJS.Timeout | undefined;
      void draining
        .then((receipt) => {
          // Recording is bounded by the same absolute deadline that bounds
          // the drain (the elapsed drain time counts against it): a
          // `record` that never settles must not delay quit past it.
          let budget = remaining();
          const recorded = ports.record(receipt).catch(() => undefined);
          if (prepare) budget = remaining();
          // An exhausted preparation/drain has no fresh receipt budget. The
          // diagnostic still starts, but cannot postpone the real Quit.
          if (prepare && budget === 0) return undefined;
          return Promise.race([
            recorded,
            new Promise<void>((resolve) => {
              recordTimer = setTimeout(resolve, budget);
              // The diagnostic write must not be able to strand the real
              // quit. Keep its absolute-deadline timer referenced for the
              // same reason as the child-drain deadline above.
            }),
          ]);
        })
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(recordTimer);
          state = "done";
          ports.quit();
        });
    },
  };
}
