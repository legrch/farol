import type { Clock } from "../../../../pkg/kernel/app/clock";
import type { ActivityRecorder } from "../port/activity-recorder";
import type { ComputerCapability } from "../port/computer-capability";
import type { ClientEvent, EventPublisher } from "../port/event-publisher";
import type {
  ChatProvider,
  ProviderEvent,
  ProviderSession,
} from "../port/provider";
import type { TurnRepository } from "../port/turn-repository";
import {
  acceptSubmission,
  activateSubmission,
  appendDelta,
  completeTurn,
  createTurn,
  failTurn,
  markOutcomeUnknown,
  requestComputer,
  resolveComputer,
  type Turn,
  type TurnIdentity,
} from "../../domain/turn";

export type RunTurnCommand = TurnIdentity & Readonly<{ prompt: string }>;

export class RunTurn {
  constructor(
    private readonly provider: ChatProvider,
    private readonly computer: ComputerCapability,
    private readonly turns: TurnRepository,
    private readonly events: EventPublisher,
    private readonly activity: ActivityRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(command: RunTurnCommand): Promise<Turn> {
    let turn = createTurn(command);
    try {
      await this.saveAndReport(turn, "phase");
    } catch {
      const failed = failTurn(turn, "local_persistence_failed_before_dispatch");
      if (!failed.ok) return turn;
      await this.bestEffortSaveAndReport(failed.value, "terminal");
      return failed.value;
    }
    let dispatched = false;
    try {
      const session = await this.provider.open(command);
      for await (const event of session.events()) {
        if (event.kind === "submit_activated") dispatched = true;
        const next = await this.applyEvent(
          turn,
          event,
          session.submitComputerResult.bind(session),
        );
        turn = next;
        if (turn.terminal) return turn;
      }
      const ended = dispatched
        ? markOutcomeUnknown(turn, "provider_stream_ended_without_terminal")
        : failTurn(turn, "provider_not_dispatched");
      turn = ended.ok ? ended.value : turn;
    } catch {
      if (dispatched && turn.phase === "prepared") {
        const activated = activateSubmission(turn);
        if (activated.ok) turn = activated.value;
      }
      const failed = !dispatched
        ? failTurn(turn, "provider_not_dispatched")
        : markOutcomeUnknown(turn, "provider_outcome_unknown");
      turn = failed.ok ? failed.value : turn;
    }
    await this.bestEffortSaveAndReport(turn, "terminal");
    return turn;
  }

  private async applyEvent(
    turn: Turn,
    event: ProviderEvent,
    submitComputerResult: ProviderSession["submitComputerResult"],
  ): Promise<Turn> {
    if (event.kind === "submit_activated") {
      const next = activateSubmission(turn);
      return this.requireTransition(next, turn, "phase");
    }
    if (event.kind === "accepted") {
      const next = acceptSubmission(turn);
      return this.requireTransition(next, turn, "phase");
    }
    if (event.kind === "delta") {
      const next = appendDelta(turn, event.sequence);
      const changed = await this.requireTransition(
        next,
        turn,
        "delta_observed",
        event.sequence,
      );
      await this.deliver(changed, {
        ...changed.identity,
        at: this.clock.now(),
        kind: "text.delta",
        sequence: event.sequence,
        text: event.text,
      });
      return changed;
    }
    if (event.kind === "computer_call") {
      return this.submitComputer(
        turn,
        event,
        this.computer,
        submitComputerResult,
      );
    }
    if (event.kind === "completed") {
      const next = completeTurn(turn);
      return this.requireTransition(next, turn, "terminal");
    }
    const failed = failTurn(turn, event.code);
    return this.requireTransition(failed, turn, "terminal");
  }

  private async submitComputer(
    turn: Turn,
    event: Extract<ProviderEvent, { kind: "computer_call" }>,
    computer: ComputerCapability,
    submitResult: ProviderSession["submitComputerResult"],
  ): Promise<Turn> {
    const waiting = requestComputer(turn, event.callId);
    const changed = await this.requireTransition(
      waiting,
      turn,
      "computer_requested",
    );
    await this.deliver(changed, {
      ...changed.identity,
      at: this.clock.now(),
      kind: "computer.requested",
      callId: event.callId,
      operation: event.operation,
    });
    const result = await computer.execute({
      ...changed.identity,
      callId: event.callId,
      operation: event.operation,
      target: event.target,
    });
    if (!result.ok) {
      const failed = failTurn(changed, result.error.code);
      return this.requireTransition(failed, changed, "terminal");
    }
    const submitted = await submitResult(result.value);
    if (!submitted.ok) {
      const unknown = markOutcomeUnknown(changed, submitted.error.code);
      return this.requireTransition(unknown, changed, "terminal");
    }
    const resumed = resolveComputer(changed, {
      ...changed.identity,
      callId: event.callId,
    });
    const running = await this.requireTransition(
      resumed,
      changed,
      "computer_completed",
    );
    await this.deliver(running, {
      ...running.identity,
      at: this.clock.now(),
      kind: "computer.completed",
      callId: event.callId,
    });
    return running;
  }

  private async requireTransition(
    result: ReturnType<typeof activateSubmission>,
    previous: Turn,
    activityKind:
      | "phase"
      | "delta_observed"
      | "computer_requested"
      | "computer_completed"
      | "terminal",
    sequence: number | null = null,
  ): Promise<Turn> {
    if (!result.ok) {
      const failed = failTurn(previous, result.error.code);
      if (!failed.ok) return previous;
      await this.saveAndReport(failed.value, "terminal");
      return failed.value;
    }
    await this.saveAndReport(result.value, activityKind, sequence);
    return result.value;
  }

  private async saveAndReport(
    turn: Turn,
    kind:
      | "phase"
      | "delta_observed"
      | "computer_requested"
      | "computer_completed"
      | "terminal",
    sequence: number | null = null,
  ): Promise<void> {
    await this.turns.save(turn);
    try {
      await this.activity.record({
        taskId: turn.identity.taskId,
        turnId: turn.identity.turnId,
        generation: turn.identity.generation,
        at: this.clock.now(),
        kind,
        phase: turn.phase,
        sequence,
        capability: kind === "computer_requested" ? "inspect_fixture" : null,
      });
    } catch {
      // Activity is evidence; its sink cannot rewrite a provider decision.
    }
    const event: ClientEvent = turn.terminal
      ? {
          ...turn.identity,
          at: this.clock.now(),
          kind: "turn.terminal",
          phase: turn.phase,
          code: turn.terminalReason ?? turn.phase,
        }
      : {
          ...turn.identity,
          at: this.clock.now(),
          kind: "turn.phase",
          phase: turn.phase,
        };
    await this.deliver(turn, event);
  }

  private async bestEffortSaveAndReport(
    turn: Turn,
    kind: "terminal",
  ): Promise<void> {
    try {
      await this.turns.save(turn);
    } catch {
      // The caller still receives the conservative terminal state in memory.
    }
    try {
      await this.activity.record({
        taskId: turn.identity.taskId,
        turnId: turn.identity.turnId,
        generation: turn.identity.generation,
        at: this.clock.now(),
        kind,
        phase: turn.phase,
        sequence: null,
        capability: null,
      });
    } catch {
      // Activity is evidence, never authority to replay an uncertain operation.
    }
    try {
      await this.deliver(turn, {
        ...turn.identity,
        at: this.clock.now(),
        kind: "turn.terminal",
        phase: turn.phase,
        code: turn.terminalReason ?? turn.phase,
      });
    } catch {
      // Client delivery failure cannot change or retry the terminal decision.
    }
  }

  private async deliver(turn: Turn, event: ClientEvent): Promise<void> {
    try {
      await this.events.publish(event);
    } catch {
      try {
        await this.activity.record({
          taskId: turn.identity.taskId,
          turnId: turn.identity.turnId,
          generation: turn.identity.generation,
          at: this.clock.now(),
          kind: "client_delivery_failed",
          phase: turn.phase,
          sequence: event.kind === "text.delta" ? event.sequence : null,
          capability: null,
        });
      } catch {
        // Delivery evidence is best effort and cannot change provider outcome.
      }
    }
  }
}
