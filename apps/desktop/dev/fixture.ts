import type { CodexContextController } from "../../../src/apps/desktop/codex-context-runtime";
import type { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";
import type { Result } from "../../../src/pkg/kernel/domain/result";
import type { Cell } from "../host/cell";
import type { ContextBinding } from "../task/context";

// The E2E-only context fixture: the canned history a compaction is run over,
// and the two control commands that compact it or confirm its hand-off. It
// refuses outside an E2E run and in demo mode, before it reads any task or the
// controller. Main keeps every owner: the live task registry and the context
// host are shared by reference, the controller is read from the host's cell at
// the call, and the binding, the model and the codec stay the context
// module's own, handed over as ports. Nothing in this module holds state.

type Source = NonNullable<
  Awaited<ReturnType<CodexContextController["store"]["getSource"]>>
>;

// What the codec needs from the stored source and what it hands back. The
// module owns the codec, so this folder states only the shape it reads.
type HandoffBuilder = (
  request: Readonly<{
    variant: Source["variant"];
    identity: Readonly<{
      threadId: string;
      turnId: string;
      modelId: ContextBinding["modelId"];
    }>;
    sourceBoundary: Source["sourceBoundary"];
    history: Source["history"];
  }>,
  candidate: unknown,
  options: Readonly<{
    maximumCheckpointContentBytes: number;
    retainedTailMaximumBytes: number;
    maximumHandoffBytes: number;
  }>,
) => Result<
  | Readonly<{
      variant: "unary_replacement_history";
      response: Readonly<{ output: readonly unknown[] }>;
    }>
  | Readonly<{ variant: "streamed_compaction_item"; item: unknown }>,
  string
>;

export type ContextFixturePorts = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  demoMode: boolean;
  liveTaskRegistry: Pick<LiveTaskRegistry, "get">;
  contextHost: Readonly<{
    controller: Pick<Cell<CodexContextController | null>, "get">;
  }>;
  contextBinding: (taskId: string) => ContextBinding;
  contextModel: ContextBinding["modelId"];
  buildHostCompactionHandoff: HandoffBuilder;
}>;

export function createContextFixture(ports: ContextFixturePorts) {
  const {
    env,
    demoMode,
    liveTaskRegistry,
    contextHost,
    contextBinding,
    contextModel,
    buildHostCompactionHandoff,
  } = ports;

  function contextFixtureHistory(epoch: number): readonly unknown[] {
    return [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Keep every change local until owner review.",
          },
        ],
      },
      {
        type: "function_call_output",
        call_id: `context-receipt-${epoch}`,
        output: `receipt-context-epoch-${epoch}`,
      },
      {
        type: "function_call_output",
        call_id: `context-unknown-${epoch}`,
        output: "outcome_unknown",
      },
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Use report-v2.md; report-v1.md is obsolete. Never publish, push, sign, or release.",
          },
        ],
      },
    ];
  }

  async function runContextFixtureControl(
    taskId: string,
    action: "compact-context-fixture" | "confirm-context-fixture",
  ): Promise<unknown> {
    if (env.FAROL_E2E !== "1" || demoMode) {
      return { error: "IPC_CONTROL_INVALID" };
    }
    const task = liveTaskRegistry.get(taskId);
    const controller = contextHost.controller.get();
    if (!task || task.provider !== "chatgpt" || !controller) {
      return { error: "CONTEXT_FIXTURE_UNAVAILABLE" };
    }
    const binding = contextBinding(taskId);
    if (action === "compact-context-fixture") {
      const epoch = task.context?.phase === "active" ? task.context.epoch : 1;
      const compacted = await controller.continuity.compact({
        endpoint: "responses_compact",
        body: {
          model: contextModel,
          input: contextFixtureHistory(epoch),
        },
        metadataHeader: JSON.stringify({
          thread_id: taskId,
          turn_id: `${task.turnId}-context-compact-${epoch}`,
        }),
      });
      return compacted.ok
        ? {
            ok: true,
            phase: liveTaskRegistry.get(taskId)?.context?.phase ?? null,
          }
        : { error: compacted.error.code };
    }

    const session = await controller.store.load(binding);
    const operation = session?.operation;
    if (
      !session ||
      session.phase !== "handoff_offered" ||
      !operation?.checkpointId
    ) {
      return { error: "CONTEXT_FIXTURE_CONFIRMATION_UNAVAILABLE" };
    }
    const [checkpoint, source] = await Promise.all([
      controller.store.get(binding, operation.checkpointId),
      controller.store.getSource(binding, operation.operationId),
    ]);
    if (!checkpoint || !source) {
      return { error: "CONTEXT_FIXTURE_CONFIRMATION_UNAVAILABLE" };
    }
    const handoff = buildHostCompactionHandoff(
      {
        variant: source.variant,
        identity: {
          threadId: taskId,
          turnId: `${task.turnId}-context-compact-${session.epoch}`,
          modelId: contextModel,
        },
        sourceBoundary: source.sourceBoundary,
        history: source.history,
      },
      checkpoint,
      {
        maximumCheckpointContentBytes: 256 * 1_024,
        retainedTailMaximumBytes: 64 * 1_024,
        maximumHandoffBytes: 128 * 1_024,
      },
    );
    if (!handoff.ok) return { error: handoff.error.code };
    const input =
      handoff.value.variant === "unary_replacement_history"
        ? handoff.value.response.output
        : [handoff.value.item];
    const confirmed = await controller.continuity.prepareTurn({
      body: {
        model: contextModel,
        input,
        client_metadata: {
          session_id: taskId,
          thread_id: taskId,
          turn_id: `${task.turnId}-context-confirm-${session.epoch}`,
        },
      },
    });
    return confirmed.ok
      ? {
          ok: true,
          phase: liveTaskRegistry.get(taskId)?.context?.phase ?? null,
        }
      : { error: confirmed.error.code };
  }

  return { contextFixtureHistory, runContextFixtureControl };
}
