import type {
  RouteBTaskSurfaces,
  RouteBSurfaceAdmission,
} from "../../../src/apps/desktop/route-b-runtime";

// The lifecycle of the turns Farol itself submits for a Codex host thread
// (Route B), told apart turn by turn. A turn's end is reported by its own
// `settled`, and a Cancel confirms the stop of the turn it started on; either
// can arrive first, and an aborted turn always settles as unknown. Each turn
// of a task therefore has an identity, and a Cancel takes the identity it
// starts on. The identity is the task route's page-turn epoch, the one the
// Cancel's own effects on the page are checked against: a counter that only
// increases, advanced when a turn is admitted, so "no turn in flight" is a
// value no later turn can reproduce. The two events are ordered by it, not by
// timing:
//
// - a Cancel confirmed for a turn keeps the task `cancelled`: that turn's
//   `settled`, before or after, writes nothing;
// - a turn that settled on its own keeps its result: a Cancel that ends
//   unknown afterwards writes nothing;
// - a Cancel that started on an epoch another turn has since replaced (one
//   that began with no turn in flight included, and one whose successor has
//   already ended) writes nothing, and neither does that turn's `settled` for
//   the next Cancel.
//
// A task with no turn in flight (an owner Browser task, a turn the owner
// typed) has the epoch it last had, and its Cancel is applied as it is as long
// as no turn is admitted.

type SettledLifecycle = "idle" | "outcome_unknown";

type Turn = {
  epoch: number;
  settled: boolean;
  cancelled: boolean;
};

export type CancelTicket = Readonly<{
  taskId: string;
  // The route's page-turn epoch when the Cancel started; null without a route.
  epoch: number | null;
  // Whether a turn of that epoch was in flight then.
  inFlight: boolean;
}>;

export type TurnLifecyclePorts = Readonly<{
  // The route's own admission of a thread's turn.
  surfaceFor: (threadId: string) => Promise<RouteBSurfaceAdmission>;
  // Writes the task's lifecycle.
  apply: (taskId: string, lifecycle: SettledLifecycle) => void;
  // The task route's page-turn epoch, read now; null when the task has no
  // route. Every admission of a turn advanced it, so a turn is known by it
  // from the moment of its admission, not from the moment the admission ended.
  epoch: (taskId: string) => number | null;
  // The route stops waiting for the turn an admission advanced it for: the
  // admission was refused, or the turn settled (also one that never ran).
  endAdmission: (taskId: string) => void;
}>;

export type TurnLifecycle = Readonly<{
  // What the Route B runtime is given: the admission opens a turn, and its
  // `settled` closes it.
  surfaces: RouteBTaskSurfaces;
  // The task route's page-turn epoch, read now.
  epoch: (taskId: string) => number | null;
  startCancel: (taskId: string) => CancelTicket;
  // Whether the Cancel's result is to be written to the task.
  finishCancel: (
    ticket: CancelTicket,
    result: "cancelled" | "outcome_unknown",
  ) => boolean;
  // The task is gone.
  forget: (taskId: string) => void;
}>;

export function createTurnLifecycle(ports: TurnLifecyclePorts): TurnLifecycle {
  const turns = new Map<string, Turn>();
  // The turn of the route's current epoch, if a turn has advanced it: opened
  // the first time its epoch is seen, which is never later than the first
  // Cancel or settlement that can concern it.
  const turnOf = (taskId: string): Turn | null => {
    const epoch = ports.epoch(taskId);
    if (epoch === null || epoch === 0) return null;
    const known = turns.get(taskId);
    if (known?.epoch === epoch) return known;
    const opened = { epoch, settled: false, cancelled: false };
    turns.set(taskId, opened);
    return opened;
  };
  return {
    surfaces: {
      surfaceFor: async (threadId) => {
        const admitted = await ports.surfaceFor(threadId);
        if (admitted.ok) turnOf(threadId);
        else ports.endAdmission(threadId);
        return admitted;
      },
      settled: (threadId, state) => {
        ports.endAdmission(threadId);
        const turn = turnOf(threadId);
        if (turn) {
          turn.settled = true;
          if (turn.cancelled) return;
        }
        ports.apply(
          threadId,
          state === "outcome_unknown" ? "outcome_unknown" : "idle",
        );
      },
    },
    epoch: (taskId) => ports.epoch(taskId),
    startCancel: (taskId) => {
      const turn = turnOf(taskId);
      return {
        taskId,
        epoch: ports.epoch(taskId),
        inFlight: turn !== null && !turn.settled,
      };
    },
    finishCancel: (ticket, result) => {
      // Another turn was admitted since the Cancel started (or the task went):
      // whatever this Cancel found is not about the task's current turn.
      if (ports.epoch(ticket.taskId) !== ticket.epoch) return false;
      if (!ticket.inFlight) return true;
      const turn = turnOf(ticket.taskId);
      if (!turn) return true;
      if (result === "cancelled") {
        turn.cancelled = true;
        return true;
      }
      return !turn.settled;
    },
    forget: (taskId) => {
      turns.delete(taskId);
    },
  };
}
