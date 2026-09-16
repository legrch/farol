import type { DeferredGate } from "../../../../pkg/async/deferred-gate";
import { failure, success } from "../../../../pkg/kernel/domain/result";
import type { ChatComputerOutput } from "../../app/port/computer-capability";
import type {
  ChatProvider,
  ProviderEvent,
  ProviderRequest,
  ProviderSession,
} from "../../app/port/provider";

export type FixtureScenario = "normal" | "failure";

export type ScriptedProviderControls = Readonly<{
  completion: DeferredGate;
}>;

class ScriptedSession implements ProviderSession {
  private submitted: ChatComputerOutput | null = null;

  constructor(
    private readonly request: Omit<ProviderRequest, "prompt">,
    private readonly scenario: FixtureScenario,
    private readonly controls: ScriptedProviderControls,
    private readonly withComputer: boolean,
  ) {}

  async *events(): AsyncIterable<ProviderEvent> {
    yield { kind: "submit_activated" };
    yield { kind: "accepted" };
    yield {
      kind: "delta",
      sequence: 1,
      text: this.withComputer
        ? "Checking the isolated fixture workspace…"
        : "A second task is streaming independently…",
    };
    if (this.scenario === "failure") {
      yield { kind: "failed", code: "FIXTURE_PROVIDER_FAILURE" };
      return;
    }
    if (this.withComputer) {
      yield {
        kind: "computer_call",
        callId: `${this.request.turnId}-computer-1`,
        workspaceId: "preview-fixture",
        operation: {
          kind: "workspace.read",
          relativePath: "status.txt",
        },
      };
      if (this.submitted === null) {
        yield { kind: "failed", code: "FIXTURE_TOOL_RESULT_MISSING" };
        return;
      }
      yield {
        kind: "delta",
        sequence: 2,
        text:
          this.submitted.output.kind === "workspace.text"
            ? ` Fixture read returned ${this.submitted.output.bytes} bytes bound to ${this.submitted.callId}.`
            : " Fixture returned an unexpected typed result.",
      };
    } else {
      yield {
        kind: "delta",
        sequence: 2,
        text: " Its hidden view stayed alive.",
      };
    }
    if ((await this.controls.completion.wait()) === "cancelled") return;
    yield { kind: "completed" };
  }

  async submitComputerResult(result: ChatComputerOutput) {
    const exact =
      result.ownerId === this.request.ownerId &&
      result.sessionId === this.request.sessionId &&
      result.taskId === this.request.taskId &&
      result.turnId === this.request.turnId &&
      result.generation === this.request.generation &&
      result.callId === `${this.request.turnId}-computer-1` &&
      result.taskEpoch === 0 &&
      result.participantId === `${this.request.taskId}:main` &&
      result.workspaceId === "preview-fixture" &&
      result.relativePath === "status.txt";
    if (!exact || this.submitted !== null)
      return failure("PROVIDER_RESULT_REJECTED");
    this.submitted = structuredClone(result);
    return success(undefined);
  }
}

export class ScriptedProvider implements ChatProvider {
  constructor(
    private readonly scenario: FixtureScenario,
    private readonly controls: ScriptedProviderControls,
    private readonly withComputer: boolean,
  ) {}

  async prepare(request: ProviderRequest): Promise<ProviderSession> {
    const identity = {
      ownerId: request.ownerId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      turnId: request.turnId,
      generation: request.generation,
    };
    return new ScriptedSession(
      identity,
      this.scenario,
      this.controls,
      this.withComputer,
    );
  }
}
