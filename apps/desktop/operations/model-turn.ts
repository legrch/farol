import type {
  FarolModelTurnHandler,
  FarolModelSseEvent,
  FarolModelCompactionHandler,
} from "../../../src/apps/desktop/farol-model-endpoint";
import type {
  OperationsRecorder,
  OperationEntry,
} from "../renderer/operations-contract";
import { observeOperation, operationResult } from "./observe";

/** Observe only closed terminal fields. Never retain request/response content. */
export function recordedModelTurn(
  recorder: OperationsRecorder,
  handler: FarolModelTurnHandler,
): FarolModelTurnHandler {
  return async (request) => {
    const started = performance.now();
    const metadata = {
      source: "Codex",
      kind: "model.responses.turn",
      target: {},
    } as const;
    const finish =
      recorder.begin?.(metadata) ??
      ((
        outcome: OperationEntry["outcome"],
        code: string | null,
        durationMs: number,
      ) => recorder.record(metadata, outcome, code, durationMs));
    let outcome: OperationEntry["outcome"] = "unknown";
    let terminalCode: string | null = null;
    let terminalObserved = false;
    const observe = (frame: FarolModelSseEvent) => {
      if (
        ![
          "response.completed",
          "response.failed",
          "response.incomplete",
        ].includes(frame.event)
      )
        return;
      const record = (v: unknown): Record<string, unknown> =>
        v !== null && typeof v === "object" && !Array.isArray(v)
          ? (v as Record<string, unknown>)
          : {};
      const data = record(frame.data);
      const response = record(data.response);
      const result = operationResult({
        outcome: frame.event,
        error: response.error ?? data.error,
        status: response.status,
      });
      // Multiple terminal frames cannot establish a single confirmed completion.
      if (terminalObserved) {
        outcome = "unknown";
        if (terminalCode !== "OPERATION_CODE_UNMAPPED")
          terminalCode = "MODEL_TERMINAL_UNCONFIRMED";
      } else {
        outcome = result.outcome;
        terminalCode =
          result.code ??
          (frame.event === "response.failed" ? "MODEL_RESPONSE_FAILED" : null);
        terminalObserved = true;
      }
    };
    const record = () =>
      finish(
        outcome,
        terminalCode ??
          (outcome === "unknown" ? "MODEL_TERMINAL_UNCONFIRMED" : null),
        performance.now() - started,
      );
    try {
      const result = await handler(request);
      if (!result.ok) {
        const classified = operationResult(result);
        finish(
          classified.outcome,
          classified.code,
          performance.now() - started,
        );
        return result;
      }
      if ("stream" in result) {
        const original = result.stream;
        return {
          ok: true,
          stream: (async function* () {
            try {
              for await (const frame of original) {
                observe(frame);
                yield frame;
              }
            } catch (error) {
              outcome = "unknown";
              if (terminalCode !== "OPERATION_CODE_UNMAPPED")
                terminalCode = "MODEL_TERMINAL_UNCONFIRMED";
              throw error;
            } finally {
              record();
            }
          })(),
        };
      }
      result.events.forEach(observe);
      record();
      return result;
    } catch (error) {
      record();
      throw error;
    }
  };
}
export function recordedCompaction(
  recorder: OperationsRecorder,
  handler: FarolModelCompactionHandler,
): FarolModelCompactionHandler {
  return (request) =>
    observeOperation(
      recorder,
      { source: "Codex", kind: "model.responses.compact", target: {} },
      () => handler(request),
    );
}
