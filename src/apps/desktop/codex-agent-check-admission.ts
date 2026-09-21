// The end of a native Agent check's authority transition reservation.
//
// `host.run-codex-agent-check` takes the `agent-admission` reservation to do
// exactly two things: re-read the authority it was admitted with, and bind it
// to the session that will carry it. Once that session is active the check
// binds nothing further — it polls the child, for up to 480 cycles — so the
// reservation has to be gone by then, or a `computer.*` authority change, a
// connector start and every new Product Agent session wait behind a poll that
// is only watching.
//
// The check has two paths to an active session and only one of them used to
// close that window. A first poll launched the App Server, recorded the
// session and released; a resumed poll — `activeCodexAgentCheck` already set,
// because the previous poll answered `CODEX_AGENT_STILL_RUNNING` — skipped
// that whole block, so its release did not run until the `finally` after the
// poll. The session it was holding the reservation "until" was already active
// when it started. `openProductAgentSession` meanwhile throws
// `AUTHORITY_CHANGE_IN_PROGRESS` when it cannot take the same reservation,
// and a rejoin that was refused that way used to be recorded
// `outcome_unknown` — terminal — which is how a poll that observed nothing
// ended an Agent.
//
// Putting both paths behind one function makes the asymmetry unrepresentable:
// whichever path produces the session, and however it ends, the reservation
// closes when it does.

import type { AuthorityTransitionHandle } from "./authority-transition";

export type AgentCheckActivation<Session, Refusal> =
  | Readonly<{ active: true; session: Session }>
  | Readonly<{ active: false; refusal: Refusal }>;

/**
 * Produce the check's active session and close its authority reservation.
 *
 * `existing` is the session a resumed poll already has; `launch` runs only
 * when there is none, and may refuse instead of producing one. The
 * reservation is released once this settles — on either path, on a refusal,
 * and on a throw.
 */
export async function activateAgentCheckSession<Session, Refusal>(
  admission: AuthorityTransitionHandle,
  existing: Session | null,
  launch: () => Promise<AgentCheckActivation<Session, Refusal>>,
): Promise<AgentCheckActivation<Session, Refusal>> {
  try {
    return existing === null
      ? await launch()
      : { active: true, session: existing };
  } finally {
    admission.release();
  }
}
