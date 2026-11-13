// Map a spawnSync result of a VM tool child to this wrapper's exit status.
// Keep this file free of TypeScript imports: vm-entry.mjs loads it under an
// older shell Node before selecting the declared runtime.
//
// The Python tools reserve 1 for a classified refusal or a known test FAIL and
// 2 for BLOCKED/UNKNOWN. A child killed by a signal, or one whose status is
// missing, may have left an effect in flight: report it as outcome unknown
// (exit 2 with a closed code on stderr), never as a plain exit 1 refusal.
export const OUTCOME_UNKNOWN_EXIT = 2;

export function childExitStatus(result, label, stderr = process.stderr) {
  if (result && result.error) throw result.error;
  if (
    !result ||
    result.signal != null ||
    !Number.isInteger(result.status) ||
    result.status < 0
  ) {
    stderr.write(
      `VM_${label}_OUTCOME_UNKNOWN: child ended without an exit status` +
        (result && result.signal ? ` (${result.signal})` : "") +
        "\n",
    );
    return OUTCOME_UNKNOWN_EXIT;
  }
  return result.status;
}
