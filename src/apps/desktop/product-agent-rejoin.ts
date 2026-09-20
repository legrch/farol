import type { ProductSettings } from "../../pkg/product-settings/contract";
import type { ProductTaskAgent } from "../../modules/chat/contract/product-task";
import {
  productAgentContext,
  productAgentInputMatchesContext,
  type ProductAgentContext,
} from "./product-agent-context";
import type {
  PrivateProductAgentStore,
  ProductAgentInput,
} from "./product-agent-store";

// S35-TA-11: admitting a rejoin of a native Product Agent.
//
// This lived inline in `main.ts`, which exports nothing and which no test
// loads, so the one thing that matters here could not be pinned: WHEN the
// configuration snapshot is read relative to the awaited load of the stored
// input.
//
// The ordering is deliberate and it is the fail-closed one. The snapshot is
// taken AFTER the load resolves, so the context describes the freshest world
// the process has seen. If configuration moved while the load was in flight
// — the owner advanced the Computer generation, rotated the verified host,
// removed the workspace — then either the context comes back null or the
// stored input no longer matches it, and the rejoin is refused. Sampling
// BEFORE the await would compare the stored input against a world that still
// matched it and admit a rejoin into a configuration that has since changed:
// the same race, in the direction that lets it through.
//
// The start branch of the same command samples before ITS await, and that is
// not an inconsistency. There the context CONSTRUCTS the input — the
// candidate cannot be built without it — so it must precede. Here the input
// already exists and the context VALIDATES it. A constructor reads before it
// builds; a validator reads the freshest world it can.
//
// Three independent reviewers read this as a defect and proposed hoisting
// the snapshot above the await. It was adjudicated by reading the
// pre-extraction code, which took the snapshot inside `productAgentContext`
// and therefore also after the await: the proposal was a behaviour change,
// not a restoration. This module exists so the next reader does not have to
// re-litigate it from prose.

/** Why a rejoin was refused. Each maps to one caller-facing task failure. */
export type ProductAgentRejoinRefusal =
  | "AGENT_REJOIN_UNAVAILABLE"
  | "AGENT_INPUT_STATE_UNAVAILABLE"
  | "AGENT_NOT_READY";

export type ProductAgentRejoinOutcome =
  | Readonly<{
      ok: true;
      input: ProductAgentInput;
      context: ProductAgentContext;
    }>
  | Readonly<{
      ok: false;
      refusal: ProductAgentRejoinRefusal;
      /**
       * The caller records an unknown-outcome summary for this task before
       * refusing: the stored input is not the one this agent was started
       * with, so what the agent did is no longer attributable.
       */
      recordUnknownSummary?: true;
    }>;

export type ProductAgentRejoinRequest = Readonly<{
  agent: ProductTaskAgent | null | undefined;
  /** Loads the durable input. Awaited BEFORE the settings are read. */
  loadInput: () => Promise<ProductAgentInput | null>;
  /**
   * Reads the current settings. Called AFTER `loadInput` resolves, on
   * purpose — see the note above. Returns null when the configuration is
   * not ready, which is itself a refusal.
   */
  readSettings: () => ProductSettings | null;
  /**
   * The durable input store, passed through to `productAgentContext`
   * unchanged — null when the app has not created one, which that function
   * already treats as "no context".
   */
  store: PrivateProductAgentStore | null;
  buildId: string;
  /** The caller's own binding comparison, which reads no settings. */
  assignmentMatches: (
    agent: ProductTaskAgent,
    input: ProductAgentInput,
  ) => boolean;
}>;

/**
 * Whether this task is in a state a rejoin can even be attempted from:
 * still running, or finished with a result the parent has not taken yet.
 */
function rejoinable(agent: ProductTaskAgent | null | undefined): boolean {
  return (
    agent?.phase === "running" ||
    (agent?.phase === "completed" &&
      agent.parentDelivery === "pending" &&
      agent.resultAvailable)
  );
}

export async function admitProductAgentRejoin(
  request: ProductAgentRejoinRequest,
): Promise<ProductAgentRejoinOutcome> {
  const agent = request.agent;
  if (!rejoinable(agent)) {
    return { ok: false, refusal: "AGENT_REJOIN_UNAVAILABLE" };
  }

  let input: ProductAgentInput | null;
  try {
    input = await request.loadInput();
  } catch {
    return { ok: false, refusal: "AGENT_INPUT_STATE_UNAVAILABLE" };
  }
  if (!input) return { ok: false, refusal: "AGENT_REJOIN_UNAVAILABLE" };

  // Reads no settings: a digest over taskId/sessionId/assignmentId. Order
  // relative to the snapshot below is therefore irrelevant to freshness.
  if (!request.assignmentMatches(agent!, input)) {
    return {
      ok: false,
      refusal: "AGENT_REJOIN_UNAVAILABLE",
      recordUnknownSummary: true,
    };
  }

  // THE ORDERING THIS MODULE EXISTS FOR: after the await, never before.
  const settings = request.readSettings();
  const context = productAgentContext(
    input.workspaceId,
    settings,
    request.store,
    request.buildId,
  );
  if (
    !context ||
    !productAgentInputMatchesContext(input, context, request.buildId)
  ) {
    return { ok: false, refusal: "AGENT_NOT_READY" };
  }
  return { ok: true, input, context };
}
