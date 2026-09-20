import type {
  DiscoveryCandidate,
  DiscoveryResult,
  ExecutableKind,
} from "./executable-discovery";

/**
 * A renderer-chosen discovery candidate is never trusted at face value: the
 * main process re-runs discovery itself and only accepts a path that is
 * still a current, non-refused candidate before handing it to the existing
 * execution probes (`verifyCodexExecutable` / `verifyTunnelClientExecutable`,
 * which remain the sole authority on whether a path may actually run). This
 * closes the gap between "the owner clicked a card that was true a moment
 * ago" and "this exact path is still what discovery would offer right now".
 *
 * A candidate Farol does not trust automatically (`verdict !==
 * "offer"`) runs only after the owner confirms it through
 * `dependencies.confirm`, which shows a main-process warning dialog: a
 * renderer request alone is never the owner's choice. `confirm` is `null`
 * when there is no owner-facing window to show that dialog in, and a
 * missing window can never confirm an untrusted candidate.
 */

export type UntrustedCandidateConfirmation = "confirmed" | "cancelled";

export type ConfirmUntrustedCandidate = (
  input: Readonly<{ kind: ExecutableKind; path: string }>,
) => Promise<UntrustedCandidateConfirmation>;

export type ReverifyDiscoveredCandidateDependencies = Readonly<{
  discover: (kind: ExecutableKind) => Promise<DiscoveryResult>;
  // Read only after discovery has completed, never before it: discovery is
  // asynchronous, and the owner-facing window may go away while it runs. A
  // caller that resolves this property lazily -- a getter over its live
  // window -- is therefore asked about the window that exists at the moment
  // a confirmation is actually needed, and a window that is gone by then can
  // never confirm an untrusted candidate.
  confirm: ConfirmUntrustedCandidate | null;
}>;

// The owner-facing confirmation dialog for an untrusted candidate, exactly
// as the main process shows it. "Cancel" is both the default button and the
// cancel button -- Escape, the close box and a dismissed dialog all resolve
// to it -- so the only response that confirms is an explicit press of
// "Use this file". Anything else, including a response index the dialog
// cannot produce, is a cancellation.
export const UNTRUSTED_CANDIDATE_DIALOG = Object.freeze({
  buttons: Object.freeze(["Cancel", "Use this file"] as const),
  defaultId: 0,
  cancelId: 0,
  confirmId: 1,
});

export function untrustedCandidateDialogDecision(
  response: number,
): UntrustedCandidateConfirmation {
  return response === UNTRUSTED_CANDIDATE_DIALOG.confirmId
    ? "confirmed"
    : "cancelled";
}

export async function reverifyDiscoveredCandidate(
  kind: ExecutableKind,
  requestedPath: string,
  dependencies: ReverifyDiscoveredCandidateDependencies,
): Promise<DiscoveryCandidate | "stale" | "declined"> {
  const discovered = await dependencies.discover(kind);
  const candidate = discovered.candidates.find(
    (entry) => entry.path === requestedPath && entry.verdict !== "refused",
  );
  if (!candidate) return "stale";
  if (candidate.verdict === "offer") return candidate;
  // Resolved here, after discovery, on purpose: see the dependency's note.
  const confirm = dependencies.confirm;
  if (!confirm) return "declined";
  let decision: UntrustedCandidateConfirmation;
  try {
    decision = await confirm({ kind, path: candidate.path });
  } catch {
    // A confirmation that could not be shown -- for instance because its
    // window was destroyed while the dialog was being raised -- is not a
    // confirmation. The candidate stays unused.
    return "declined";
  }
  return decision === "confirmed" ? candidate : "declined";
}
