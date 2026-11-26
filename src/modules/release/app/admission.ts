// Keep in sync with the release contract's presentation eligibility. The
// application guard remains authoritative even for callers bypassing the UI.
const recheckableAdmissionBlocks = new Set([
  "UPDATE_CONNECTOR_ACTIVE",
  "UPDATE_TASK_ROUTE_NEEDS_DRAIN",
  "UPDATE_BROWSER_OPEN",
  "UPDATE_BROWSER_BUSY",
  "UPDATE_BROWSER_DRAFT",
  "UPDATE_WORK_PENDING",
  // Raised before admission or any helper: a fresh read of the fence is safe.
  "UPDATE_RESTORE_NOT_READY",
]);

const confirmedBrowserBlocks = new Set([
  "UPDATE_BROWSER_OPEN",
  "UPDATE_BROWSER_BUSY",
  "UPDATE_BROWSER_DRAFT",
  "UPDATE_BROWSER_STATE_UNKNOWN",
]);

/** A known admission refusal launched no helper, so a fresh read is safe. */
export function admissionRecheckable(code: string): boolean {
  return recheckableAdmissionBlocks.has(code);
}

/** The timer may retry only a block that precedes installer dispatch. */
export function timerMayRetryBlock(blockedBy: string | null): boolean {
  return (
    blockedBy === null ||
    recheckableAdmissionBlocks.has(blockedBy) ||
    confirmedBrowserBlocks.has(blockedBy)
  );
}

/** A restart proceeds past a block only with the owner's confirmation. */
export function restartBlockPermitted(
  blockedBy: string | null,
  confirmed: boolean,
): boolean {
  return (
    blockedBy === null ||
    (confirmed &&
      (confirmedBrowserBlocks.has(blockedBy) ||
        recheckableAdmissionBlocks.has(blockedBy)))
  );
}
