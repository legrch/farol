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
  confirm: ConfirmUntrustedCandidate | null;
}>;

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
  if (!dependencies.confirm) return "declined";
  const decision = await dependencies.confirm({ kind, path: candidate.path });
  return decision === "confirmed" ? candidate : "declined";
}
