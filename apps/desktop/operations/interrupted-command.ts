import type { OperationsStore } from "./store";

const code = "FRESH_SESSION_INTERRUPTED_COMMAND_UNKNOWN";

/** Presentation only: never settles, replays or changes the old process journal. */
export async function recordInterruptedCommand(
  core: { interruptedCommand(): Promise<boolean> },
  operations: Pick<OperationsStore, "snapshot" | "record">,
  archivedShell = false,
): Promise<void> {
  if (!archivedShell && !(await core.interruptedCommand())) return;
  const retained = await operations.snapshot();
  if (retained.entries.some((entry) => entry.code === code)) return;
  operations.record(
    { source: "Setup", kind: "computer_shell_start", target: {} },
    "unknown",
    code,
    0,
  );
}
