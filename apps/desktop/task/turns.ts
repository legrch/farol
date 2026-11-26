import type {
  RouteBTaskSurfaces,
  RouteBSurfaceAdmission,
} from "../../../src/apps/desktop/route-b-runtime";

// The lifecycle of the turns Farol itself submits for a Codex host thread
// (Route B), told apart turn by turn. A turn's end is reported by its own
// `settled`, and a Cancel confirms the stop of the turn it started on; either
// can arrive first, and an aborted turn always settles as unknown. Each turn
// of a task therefore has an identity (its epoch), a Cancel takes the epoch of
// the turn it starts on, and the two events are ordered by it, not by timing:
//
// - a Cancel confirmed for a turn keeps the task `cancelled`: that turn's
//   `settled`, before or after, writes nothing;
// - a turn that settled on its own keeps its result: a Cancel that ends
//   unknown afterwards writes nothing;
// - a Cancel for a turn that has since been replaced by another writes
//   nothing, and neither does that turn's `settled` for the next Cancel.
//
// A task with no turn in flight (an owner Browser task, a restored task, a
// turn the owner typed) has no epoch, and its Cancel is applied as it is.

type SettledLifecycle = "idle" | "outcome_unknown";

type Turn = {
  epoch: number;
  settled: boolean;
  cancelled: boolean;
};

export type CancelTicket = Readonly<{
  taskId: string;
  // The turn in flight when the Cancel started; null when there was none.
  epoch: number | null;
}>;

export type TurnLifecyclePorts = Readonly<{
  // The route's own admission of a thread's turn.
  surfaceFor: (threadId: string) => Promise<RouteBSurfaceAdmission>;
  // Writes the task's lifecycle.
  apply: (taskId: string, lifecycle: SettledLifecycle) => void;
}>;

export type TurnLifecycle = Readonly<{
  // What the Route B runtime is given: the admission opens a turn, and its
  // `settled` closes it.
  surfaces: RouteBTaskSurfaces;
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
  return {
    surfaces: {
      surfaceFor: async (threadId) => {
        const admitted = await ports.surfaceFor(threadId);
        if (admitted.ok) {
          turns.set(threadId, {
            epoch: (turns.get(threadId)?.epoch ?? 0) + 1,
            settled: false,
            cancelled: false,
          });
        }
        return admitted;
      },
      settled: (threadId, state) => {
        const turn = turns.get(threadId);
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
    startCancel: (taskId) => {
      const turn = turns.get(taskId);
      return {
        taskId,
        epoch: turn && !turn.settled ? turn.epoch : null,
      };
    },
    finishCancel: (ticket, result) => {
      if (ticket.epoch === null) return true;
      const turn = turns.get(ticket.taskId);
      if (!turn || turn.epoch !== ticket.epoch) return false;
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
