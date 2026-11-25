import type {
  FarolModelCompactionHandler,
  FarolModelTurnHandler,
} from "../../../src/apps/desktop/farol-model-endpoint";

// The model endpoint at startup: built only when the model route is enabled,
// answering through the already-running Route B provider or, in the E2E lane
// alone, a synthetic completed reply. Main keeps the owner and calls this where
// the endpoint starts. The caller owns the synthetic gate: it passes a reply
// only when FAROL_E2E=1 and the reply variable are both set. A start failure
// does not abort unrelated startup; the endpoint stays built and unstarted.

export type ModelEndpointOptions = Readonly<{
  stateRoot: string;
  model: string;
  handler: FarolModelTurnHandler;
  compactionHandler: FarolModelCompactionHandler;
}>;

export type ModelEndpointPorts<
  Lifecycle extends { start(): Promise<unknown> },
> = Readonly<{
  enabled: boolean;
  syntheticReply: string | undefined;
  stateRoot: string;
  model: string;
  createLifecycle: (options: ModelEndpointOptions) => Lifecycle;
  recordTurn: (handler: FarolModelTurnHandler) => FarolModelTurnHandler;
  recordCompaction: (
    handler: FarolModelCompactionHandler,
  ) => FarolModelCompactionHandler;
  syntheticTurn: (reply: string) => FarolModelTurnHandler;
  routeBTurn: () => FarolModelTurnHandler;
  routeBCompaction: () => FarolModelCompactionHandler;
}>;

export function createModelEndpoint<
  Lifecycle extends { start(): Promise<unknown> },
>(ports: ModelEndpointPorts<Lifecycle>): Lifecycle | null {
  if (!ports.enabled) return null;
  return ports.createLifecycle({
    stateRoot: ports.stateRoot,
    model: ports.model,
    handler: ports.recordTurn(
      ports.syntheticReply
        ? ports.syntheticTurn(ports.syntheticReply)
        : ports.routeBTurn(),
    ),
    compactionHandler: ports.recordCompaction(ports.routeBCompaction()),
  });
}

// Separate from the build so the caller can publish the lifecycle to its
// owner before the start is awaited: a Quit during the start must still see
// and close it.
export async function startModelEndpoint(lifecycle: {
  start(): Promise<unknown>;
}): Promise<void> {
  try {
    await lifecycle.start();
  } catch {
    // Model failure does not abort unrelated app startup.
  }
}
