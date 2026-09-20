/**
 * What the Farol Model card says when this session holds no status evidence.
 *
 * Absent evidence has more than one meaning and used to have one sentence.
 * Farol Model may simply never have been connected in this session, which is
 * the ordinary first state. Or its endpoint may have stopped accepting
 * requests — since the lifecycle gained its `sealed` state, that happens when
 * a token rotation could neither restore nor clear its token, and every later
 * command comes back `MODEL_ENDPOINT_UNAVAILABLE`. The renderer drops its
 * status evidence in that case, so both situations rendered as "Not
 * connected. Preview the connection…", which tells an owner whose endpoint
 * has just died that it never started.
 *
 * The contract is unchanged: `sealed` is not a `model.status` state and this
 * module never invents one. It only distinguishes the three reasons the card
 * can be looking at nothing.
 */
export type ModelEvidenceAbsence =
  "no-evidence-yet" | "endpoint-stopped" | "endpoint-stopped-after-rotation";

/** The model commands whose failure says the endpoint stopped, not that it never ran. */
export function modelEvidenceAbsenceAfterFailure(
  error: string,
  commandKind: string,
): ModelEvidenceAbsence | null {
  if (error !== "MODEL_ENDPOINT_UNAVAILABLE") return null;
  return commandKind === "model.rotate-token"
    ? "endpoint-stopped-after-rotation"
    : "endpoint-stopped";
}

export function modelDisconnectedReadiness(
  absence: ModelEvidenceAbsence,
): string {
  return absence === "no-evidence-yet" ? "Not connected" : "Stopped";
}

export function modelDisconnectedSummary(
  absence: ModelEvidenceAbsence,
): string {
  switch (absence) {
    case "endpoint-stopped-after-rotation":
      return "Farol Model stopped accepting requests after a failed token rotation. Preview the connection and apply it again.";
    case "endpoint-stopped":
      return "Farol Model stopped accepting requests. Preview the connection and apply it again.";
    default:
      return "Not connected. Preview the connection to see what Farol would change in your Codex config.toml.";
  }
}
