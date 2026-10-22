import type {
  FarolModelTurnHandler,
  FarolModelSseEvent,
  FarolModelCompactionHandler,
} from "../../../src/apps/desktop/farol-model-endpoint";
import type {
  OperationsRecorder,
  OperationEntry,
} from "../renderer/operations-contract";
import { observeOperation } from "./observe";
import { recordableOperationCode } from "../renderer/operations-vocabulary";

/** Watches only the closed SSE event name. No request or response data is logged. */
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
    const observe = (frame: FarolModelSseEvent) => {
      if (frame.event === "response.completed") outcome = "done";
      else if (frame.event === "response.failed") {
        const record = (v: unknown): Record<string, unknown> =>
          v !== null && typeof v === "object" && !Array.isArray(v)
            ? (v as Record<string, unknown>)
            : {};
        const data = record(frame.data);
        const rawCode =
          record(record(data.response).error).code ?? record(data.error).code;
        terminalCode =
          recordableOperationCode(rawCode) ?? "MODEL_RESPONSE_FAILED";
        outcome = /unknown|unconfirmed|unreachable/iu.test(terminalCode)
          ? "unknown"
          : "failed";
      } else if (frame.event === "response.incomplete") outcome = "unknown";
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
        const code = recordableOperationCode(result.reason) ?? "MODEL_REFUSED";
        finish(
          /unknown|unconfirmed|unreachable/iu.test(code)
            ? "unknown"
            : "refused",
          code,
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
