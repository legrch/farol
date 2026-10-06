// Retain only the original Playwright child. No PID lookup or signal fallback.
export function retainOriginalChild(application, observations, context) {
  const child = application.process();
  if (!child) throw new Error("SETUP_CONFIG_FAULT_CHILD_UNAVAILABLE");
  const owned = { child, closeAttempted: false, stdout: "", stderr: "" };
  owned.terminal = new Promise((resolve) => {
    const recordExit = (exit, signal) => {
      observations.push({
        kind: "native-exit-observed",
        ...context,
        pid: child.pid,
        exit,
        signal,
        stdout: owned.stdout,
        stderr: owned.stderr,
      });
      resolve();
    };
    child.once("exit", recordExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.removeListener("exit", recordExit);
      recordExit(child.exitCode, child.signalCode);
    }
  });
  for (const stream of ["stdout", "stderr"]) {
    child[stream]?.on("data", (chunk) => {
      owned[stream] = (owned[stream] + chunk.toString("utf8")).slice(-32768);
    });
  }
  return owned;
}

export async function closeOriginalChild(application, owned, bounded) {
  const { child } = owned;
  let closeError;
  let exitError;
  if (
    child.exitCode === null &&
    child.signalCode === null &&
    !owned.closeAttempted
  ) {
    owned.closeAttempted = true;
    try {
      await bounded(application.close(), "SETUP_CONFIG_FAULT_CLOSE_UNKNOWN");
    } catch (error) {
      closeError = error;
    }
  }
  // Reconcile the SAME child after a close failure, without another close.
  if (child.exitCode === null && child.signalCode === null) {
    try {
      await bounded(owned.terminal, "SETUP_CONFIG_FAULT_EXIT_UNKNOWN");
    } catch (error) {
      exitError = error;
    }
  }
  return {
    pid: child.pid,
    exit: child.exitCode,
    signal: child.signalCode,
    terminal: child.exitCode !== null || child.signalCode !== null,
    closeAttempted: owned.closeAttempted,
    stdout: owned.stdout,
    stderr: owned.stderr,
    closeError,
    exitError,
  };
}
