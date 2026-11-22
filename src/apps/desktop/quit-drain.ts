// The receipt's on-disk contract (schema, serializer, parser) is owned by
// `quit-receipt.ts` and shared with the promotion reader; the desktop's
// `recordQuitReceipt` writes exactly `serializeQuitReceipt(receipt, at)`.
export {
  serializeQuitReceipt,
  type QuitReceipt,
  type QuitReceiptInput,
} from "./quit-receipt";

export type OwnedCloser = Readonly<{ name: string; close(): Promise<void> }>;

// A phase shares Quit's original absolute deadline. Expiration ends waiting,
// never the original operation or custody of an unknown effect.
export async function withinQuitDeadline<T>(
  original: Promise<T>,
  deadlineAt: number | undefined,
  code: string,
): Promise<T> {
  if (deadlineAt === undefined) return original;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      original,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(code)),
          Math.max(0, deadlineAt - Date.now()),
        );
      }),
    ]);
    // Timers can be delayed by synchronous work. A late resolution cannot
    // renew the phase or turn an expired wait into confirmation.
    if (Date.now() >= deadlineAt) throw new Error(code);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export type QuitDrainReceipt = Readonly<{
  drained: boolean;
  // Owned children whose exit was not confirmed before the deadline, or
  // whose close failed: the app cannot claim they stopped.
  unconfirmed: readonly string[];
}>;

/** Fixed, content-free Quit stages. Diagnostic only: never authority. */
export type QuitStage =
  | Readonly<{ stage: "drain-entered" }>
  | Readonly<{ stage: "claim-step-failed"; step: string }>
  | Readonly<{ stage: "second-quit" }>
  | Readonly<{ stage: "preparation-begin" }>
  | Readonly<{
      stage: "preparation-end";
      status: QuitPreparationResult["status"] | "timed-out" | "failed";
    }>
  | Readonly<{ stage: "collect-end"; closers: number }>
  | Readonly<{ stage: "closer-begin"; closer: number; name: string }>
  | Readonly<{
      stage: "closer-end";
      closer: number;
      name: string;
      outcome: "confirmed" | "failed" | "late";
    }>
  | Readonly<{ stage: "drain-end"; drained: boolean; unconfirmed: number }>
  | Readonly<{ stage: "record-begin" }>
  | Readonly<{
      stage: "record-end";
      outcome: "recorded" | "failed" | "timed-out";
    }>
  | Readonly<{ stage: "exit-requested" }>;

/** Must not throw or block; every call is isolated anyway. */
export type QuitStageObserver = (stage: QuitStage) => void;

function emit(observer: QuitStageObserver | undefined, stage: QuitStage) {
  if (!observer) return;
  try {
    observer(stage);
  } catch {
    // Observation can never change Quit.
  }
}

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
  observer?: QuitStageObserver,
): Promise<QuitDrainReceipt> {
  // Each closer is its own obligation: two closers sharing a name are
  // confirmed separately, never by the first one to finish.
  const confirmed = new Set<number>();
  const closing = Promise.allSettled(
    closers.map(async (closer, index) => {
      emit(observer, {
        stage: "closer-begin",
        closer: index,
        name: closer.name,
      });
      try {
        await closer.close();
      } catch (error) {
        emit(observer, {
          stage: "closer-end",
          closer: index,
          name: closer.name,
          outcome: "failed",
        });
        throw error;
      }
      const intime = deadlineAt === undefined || Date.now() < deadlineAt;
      if (intime) confirmed.add(index);
      emit(observer, {
        stage: "closer-end",
        closer: index,
        name: closer.name,
        outcome: intime ? "confirmed" : "late",
      });
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
    .filter((_, index) => !confirmed.has(index))
    .map((closer) => closer.name);
  return { drained: unconfirmed.length === 0, unconfirmed };
}

export type QuitPreparationContext = Readonly<{
  // Preparation's absolute deadline within the original Quit budget, in the
  // Date.now() clock. Never renew it or spend the reserved recording time.
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
  collect(context: Readonly<{ deadlineAt: number }>): readonly OwnedCloser[];
  deadlineMs: number;
  // Optional phase limits within the original deadline, never fresh budgets.
  preparationMs?: number;
  recordReserveMs?: number;
  // The private diagnostic receipt. Its failure changes nothing about the
  // drain's outcome or the quit.
  record(receipt: QuitDrainReceipt): Promise<void>;
  // Synchronous steps that must hold before preparation or collection can
  // run (admission latch, start cancellation). Called once, right after the
  // attempt is claimed. Each step is isolated: a throwing step is recorded
  // as an unconfirmed obligation and never skips the drain.
  onClaim?: readonly Readonly<{ name: string; run(): void }>[];
  // Optional diagnostic sink; never awaited, never authority.
  observe?: QuitStageObserver;
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
  const reserve = ports.recordReserveMs ?? 0;
  const preparationMs = ports.preparationMs ?? ports.deadlineMs;
  if (
    !Number.isFinite(ports.deadlineMs) ||
    ports.deadlineMs < 0 ||
    !Number.isFinite(reserve) ||
    reserve < 0 ||
    reserve > ports.deadlineMs ||
    !Number.isFinite(preparationMs) ||
    preparationMs < 0
  )
    throw new Error("QUIT_BUDGET_INVALID");
  let state: QuitDrainState = "idle";
  return {
    state: () => state,
    onBeforeQuit: (event) => {
      if (state === "done") return;
      event.preventDefault();
      if (state === "draining") {
        emit(ports.observe, { stage: "second-quit" });
        return;
      }
      state = "draining";
      emit(ports.observe, { stage: "drain-entered" });
      // Latch admission before the first synchronous preparation step.
      const claimFailures: string[] = [];
      for (const step of ports.onClaim ?? []) {
        try {
          step.run();
        } catch {
          claimFailures.push(step.name);
          emit(ports.observe, { stage: "claim-step-failed", step: step.name });
        }
      }
      const startedAt = Date.now();
      const deadlineAt = startedAt + ports.deadlineMs;
      const remaining = () => Math.max(0, deadlineAt - Date.now());
      const drainDeadlineAt = deadlineAt - reserve;
      const drainRemaining = () => Math.max(0, drainDeadlineAt - Date.now());
      const preparationDeadlineAt = Math.min(
        drainDeadlineAt,
        startedAt + preparationMs,
      );
      const preparationRemaining = () =>
        Math.max(0, preparationDeadlineAt - Date.now());
      const prepare = ports.prepare;
      const collectAndDrain = (): Promise<QuitDrainReceipt> => {
        try {
          const closers = [
            ...ports.collect(Object.freeze({ deadlineAt: drainDeadlineAt })),
          ];
          emit(ports.observe, {
            stage: "collect-end",
            closers: closers.length,
          });
          const budget = drainRemaining();
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
          return drainOwnedChildren(
            closers,
            budget,
            drainDeadlineAt,
            ports.observe,
          );
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
        if (prepare && preparationRemaining() > 0) {
          emit(ports.observe, { stage: "preparation-begin" });
          let timedOut = false;
          let preparing = true;
          let preparationTimer: NodeJS.Timeout | undefined;
          const expired = new Promise<QuitPreparationResult>((resolve) => {
            // Referenced: pending preparation must not strand normal Quit.
            preparationTimer = setTimeout(() => {
              timedOut = true;
              resolve({ status: "unknown" });
            }, preparationRemaining());
          });
          try {
            const originalAttempt = prepare(
              Object.freeze({
                deadlineAt: preparationDeadlineAt,
                canStartEffect: () =>
                  preparing && Date.now() < preparationDeadlineAt,
              }),
            );
            if (preparationRemaining() === 0) {
              // Synchronous hook work also spends the original budget.
              // Observe late rejection without settling/cancelling its attempt.
              void originalAttempt.catch(() => undefined);
              unconfirmed = true;
              emit(ports.observe, {
                stage: "preparation-end",
                status: "timed-out",
              });
            } else {
              const result = await Promise.race([originalAttempt, expired]);
              emit(ports.observe, {
                stage: "preparation-end",
                status: timedOut ? "timed-out" : result.status,
              });
              switch (result.status) {
                case "accepted":
                case "skipped":
                case "blocked":
                  unconfirmed = preparationRemaining() === 0;
                  break;
                default:
                  unconfirmed = true;
              }
            }
          } catch {
            // A throwing hook cannot prove whether it dispatched an effect.
            unconfirmed = true;
            emit(ports.observe, { stage: "preparation-end", status: "failed" });
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
      const drained = prepare ? prepareAndDrain() : collectAndDrain();
      // A claim step that could not be established is an unconfirmed stop.
      const draining = drained.then((receipt): QuitDrainReceipt => {
        const result =
          claimFailures.length === 0
            ? receipt
            : {
                drained: false,
                unconfirmed: [
                  ...claimFailures.map((name) => `claim:${name}`),
                  ...receipt.unconfirmed,
                ],
              };
        emit(ports.observe, {
          stage: "drain-end",
          drained: result.drained,
          unconfirmed: result.unconfirmed.length,
        });
        return result;
      });
      let recordTimer: NodeJS.Timeout | undefined;
      void draining
        .then((receipt) => {
          // Recording is bounded by the same absolute deadline that bounds
          // the drain (the elapsed drain time counts against it): a
          // `record` that never settles must not delay quit past it.
          emit(ports.observe, { stage: "record-begin" });
          let settled = false;
          const recorded = ports.record(receipt).then(
            () => {
              settled = true;
              emit(ports.observe, { stage: "record-end", outcome: "recorded" });
            },
            () => {
              settled = true;
              emit(ports.observe, { stage: "record-end", outcome: "failed" });
            },
          );
          const budget = remaining();
          // An exhausted preparation/drain has no fresh receipt budget. The
          // diagnostic still starts, but cannot postpone the real Quit.
          if (budget === 0) {
            emit(ports.observe, { stage: "record-end", outcome: "timed-out" });
            return undefined;
          }
          return Promise.race([
            recorded,
            new Promise<void>((resolve) => {
              recordTimer = setTimeout(() => {
                if (!settled)
                  emit(ports.observe, {
                    stage: "record-end",
                    outcome: "timed-out",
                  });
                resolve();
              }, budget);
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
          // Never awaited: the real Quit cannot wait for any diagnostic.
          emit(ports.observe, { stage: "exit-requested" });
          ports.quit();
        });
    },
  };
}
