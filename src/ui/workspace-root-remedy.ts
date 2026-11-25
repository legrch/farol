/**
 * Presentation-only guidance. A root refusal cannot authorize access, replay a
 * check, rebind a saved approval, or settle an unknown operation.
 */
export function workspaceRootChangeRemedy(
  code: string | null | undefined,
): string | null {
  return code === "WORKSPACE_ROOT_CHANGED"
    ? "Farol stopped this check because the workspace folder or its saved settings changed while it ran, so nothing continued against the changed state. Open Settings, check the folder, then try again. Resolve any unknown operation first, and do not repeat its effect."
    : null;
}

/**
 * The reason a refused workspace check gives, in plain words. Only a closed
 * code is read; an unknown code returns null so the caller keeps its generic
 * text. Presentation only: it never grants or retries anything.
 */
export function workspaceCheckRefusalReason(
  code: string | null | undefined,
): string | null {
  switch (code) {
    case "WORKSPACE_NOT_FOUND":
      return "This folder no longer exists or was moved.";
    case "WORKSPACE_PATH_REFUSED":
      return "Farol could not open this folder. It may belong to another user of this Mac, be reached through a link, or macOS may be blocking access. Choose a folder you own, or allow access in System Settings › Privacy & Security.";
    default:
      return null;
  }
}

type WorkspaceCheckIntent = Readonly<{
  id: string;
  state: string;
  code: string | null;
}>;

const verifyPrefix = "settings:computer.verify-workspace:";
const folderPrefix = "settings:computer.check-folder:";

/**
 * A refusal for workspace A is never cleared by a check for workspace B.
 * A later successful *verify-workspace* for A may supersede it only when both
 * events have valid, strictly increasing local order. Missing order is not
 * proof of supersession, nor is a successful folder probe a new grant.
 *
 * This is a local UI projection, not native authority or persisted custody.
 */
export function unresolvedWorkspaceRootChange<T extends WorkspaceCheckIntent>(
  intents: readonly T[],
  order: Readonly<Record<string, number>> | undefined,
  currentWorkspaceIds?: readonly string[],
): T | undefined {
  return intents.find((intent) => {
    if (intent.state !== "refused" || intent.code !== "WORKSPACE_ROOT_CHANGED")
      return false;

    const prefix = intent.id.startsWith(verifyPrefix)
      ? verifyPrefix
      : intent.id.startsWith(folderPrefix)
        ? folderPrefix
        : null;
    if (prefix === null) return false;
    const workspaceId = intent.id.slice(prefix.length);
    if (
      !workspaceId ||
      (currentWorkspaceIds !== undefined &&
        !currentWorkspaceIds.includes(workspaceId))
    )
      return false;

    const refusedAt = order?.[intent.id];
    const validOrder = (value: number | undefined) =>
      value !== undefined && Number.isSafeInteger(value) && value > 0;
    return !intents.some((later) => {
      const confirmedAt = order?.[later.id];
      return (
        later.id === `${verifyPrefix}${workspaceId}` &&
        later.state === "applied" &&
        validOrder(refusedAt) &&
        validOrder(confirmedAt) &&
        confirmedAt! > refusedAt!
      );
    });
  });
}
