const messages: Readonly<Record<string, string>> = {
  UPDATE_CONNECTOR_ACTIVE:
    "Disconnect the active connector in Connection before restarting.",
  UPDATE_TASK_ROUTE_NEEDS_DRAIN:
    "Wait for the current task to finish before restarting.",
  UPDATE_BROWSER_OPEN:
    "Close open ChatGPT tabs before restarting so browser work is not interrupted.",
  UPDATE_BROWSER_BUSY:
    "Wait for the active ChatGPT response, check or voice session to finish before restarting.",
  UPDATE_BROWSER_DRAFT:
    "Send or clear the unsent ChatGPT draft and attachments before restarting.",
  UPDATE_BROWSER_STATE_UNKNOWN:
    "Farol could not confirm that ChatGPT is idle. Installation has not started. Keep your current work and review this result in Diagnostics. Do not retry this update action until the unknown state is resolved.",
  UPDATE_BROWSER_RELEASE_UNCONFIRMED:
    "Farol could not confirm that ChatGPT resumed. Quit Farol and reopen it before updating.",
  UPDATE_WORK_PENDING: "Finish or cancel active work before restarting.",
  UPDATE_WORK_DRAIN_UNCONFIRMED:
    "Farol could not confirm that local work has finished. Review its current result before restarting.",
  UPDATE_HELPER_GO_CORE_REQUIRED:
    "This Farol build can’t update itself any more. Install the current Farol build manually.",
  UPDATE_BASELINE_ADOPTION_REQUIRED:
    "This copy of Farol isn’t a published release, so it can’t update itself. Download Farol from its releases page.",
  UPDATE_ADOPTION_RELEASE_NOT_FOUND:
    "This copy of Farol isn’t a published release, so it can’t update itself. Download Farol from its releases page.",
  UPDATE_ADOPTION_TREE_MISMATCH:
    "This copy of Farol doesn’t match its published release. Download it again.",
  UPDATE_ADOPTION_NETWORK_FAILURE:
    "Farol couldn’t check its release. Check your connection and try again.",
  UPDATE_RELEASE_FORMAT_NEWER:
    "A newer Farol is available that this version can’t install by itself. Download it from the releases page.",
  UPDATE_STATE_UNREADABLE: "Farol couldn’t read its update status.",
  UPDATE_VERIFICATION_RECOVERY_REQUIRED:
    "An earlier package check did not finish. Its files are saved. Review Diagnostics to recover that check before updating.",
};

// These failures carry their own guidance, not the generic copy: first-launch
// adoption failures and a newer release format this version cannot read.
const adoptionResultCodes: ReadonlySet<string> = new Set([
  "UPDATE_ADOPTION_RELEASE_NOT_FOUND",
  "UPDATE_BASELINE_ADOPTION_REQUIRED",
  "UPDATE_ADOPTION_TREE_MISMATCH",
  "UPDATE_ADOPTION_NETWORK_FAILURE",
  "UPDATE_RELEASE_FORMAT_NEWER",
]);

export function updateBlockMessage(
  code: string,
  fallback = "Farol can’t restart safely yet. Review active work and Diagnostics before updating.",
): string {
  return messages[code] ?? fallback;
}

/** A failure projection is not evidence that the installed slot changed. */
export function updateResultMessage(
  phase: "failed" | "unavailable",
  recoveryRequired = false,
  code?: string,
): string {
  if (phase === "unavailable")
    return "Farol cannot confirm update availability in this session. Review Diagnostics before another check.";
  if (code === "UPDATE_VERIFICATION_RECOVERY_REQUIRED") return messages[code]!;
  if (code !== undefined && adoptionResultCodes.has(code))
    return messages[code]!;
  return recoveryRequired
    ? "The update result needs recovery. Check Diagnostics and the installed version before another update action."
    : "The update did not finish. Check Diagnostics and the installed version before trying again.";
}
