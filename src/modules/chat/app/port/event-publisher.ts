import type { TurnIdentity, TurnPhase } from "../../domain/turn";

type EventBase = TurnIdentity & Readonly<{ at: number }>;

export type ClientEvent =
  | (EventBase & Readonly<{ kind: "turn.phase"; phase: TurnPhase }>)
  | (EventBase &
      Readonly<{ kind: "text.delta"; sequence: number; text: string }>)
  | (EventBase &
      Readonly<{
        kind: "computer.requested";
        callId: string;
        operation: "inspect_fixture";
      }>)
  | (EventBase & Readonly<{ kind: "computer.completed"; callId: string }>)
  | (EventBase &
      Readonly<{ kind: "turn.terminal"; phase: TurnPhase; code: string }>);

export interface EventPublisher {
  publish(event: ClientEvent): Promise<void>;
}
