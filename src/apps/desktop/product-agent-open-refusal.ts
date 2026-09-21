// What a failed Product Agent session open means for the assignment behind
// it — the one decision `executeProductAgent` makes before it refuses.
//
// `openProductAgentSession` fails in two very different ways, and the
// difference is the whole content of this module.
//
// Two of its refusals are decided by admission alone, before any process is
// probed or launched: `PRODUCT_AGENT_SESSION_BUSY`, when another Agent
// session is live, and `AUTHORITY_CHANGE_IN_PROGRESS`, when the
// `agent-admission` reservation is held — by a `computer.*` authority change,
// a connector start, or a resumed `host.run-codex-agent-check` poll, which
// keeps that reservation for the whole of its check. Neither of them reaches
// the child. The assignment is exactly as it was and is still rejoinable, so
// the owner can retry once the other operation ends.
//
// Every other failure happened while opening: a probe that disagreed with the
// recorded host, an App Server that would not launch, a session that was
// built and then thrown away. On a rejoin, what the child did in the meantime
// is no longer attributable, and `outcome_unknown` is the honest record.
//
// Before this module the rejoin branch wrote `outcome_unknown` for all of
// them, and that phase is terminal: `admitProductAgentRejoin` refuses it
// (`rejoinable` admits only `running`, or `completed` with a result the
// parent has not taken), and `task.start-agent` refuses it too. So an Agent
// whose rejoin happened to collide with another operation's reservation was
// permanently unstartable and unrejoinable, from a refusal that changed
// nothing at all.
//
// A `new` start is not in that position: `startAgentDurable` has already
// moved the task to `running`, so every refusal must record something, and
// `failed` is what it recorded before and still records now.

/** Whether this open was a brand new assignment or a rejoin of a live one. */
export type ProductAgentAdmission = "new" | "rejoin";

export type ProductAgentOpenRefusal = Readonly<{
  /**
   * The phase to persist for the assignment, or "none" to leave the durable
   * record exactly as the open found it.
   */
  record: "none" | "failed" | "outcome_unknown";
  failure:
    | "AGENT_ALREADY_RUNNING"
    | "AGENT_NOT_READY"
    | "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN";
}>;

/**
 * The refusals `openProductAgentSession` decides before it touches anything.
 * Both are thrown by admission checks with no await before them, so no probe
 * has run, no App Server has been launched and no session exists.
 */
const ADMISSION_ONLY = new Set([
  "PRODUCT_AGENT_SESSION_BUSY",
  "AUTHORITY_CHANGE_IN_PROGRESS",
]);

export function productAgentOpenRefusal(
  admission: ProductAgentAdmission,
  error: unknown,
): ProductAgentOpenRefusal {
  const code = error instanceof Error ? error.message : "";
  const busy = code === "PRODUCT_AGENT_SESSION_BUSY";
  if (admission === "new") {
    // The task is already `running`; a refusal must move it off that.
    return {
      record: "failed",
      failure: busy ? "AGENT_ALREADY_RUNNING" : "AGENT_NOT_READY",
    };
  }
  if (ADMISSION_ONLY.has(code)) {
    return {
      record: "none",
      failure: busy ? "AGENT_ALREADY_RUNNING" : "AGENT_NOT_READY",
    };
  }
  return {
    record: "outcome_unknown",
    failure: "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN",
  };
}
