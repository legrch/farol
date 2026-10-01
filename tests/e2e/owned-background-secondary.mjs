// Only an exact child object returned by the fixture's own spawn may be passed.
// A timeout remains a failed assertion even if bounded cleanup later succeeds.
async function within(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForOwnedSecondary(
  child,
  {
    timeoutMs = 20000,
    cleanupTimeoutMs = 10000,
    onObservation = () => {},
  } = {},
) {
  const onError = () => {};
  const terminal = new Promise((resolve) => {
    child.once("close", (exit, signal) => {
      child.removeListener("error", onError);
      onObservation({
        kind: "background-secondary-terminal",
        pid: child.pid,
        exit,
        signal,
      });
      resolve({ terminal: true, exit, signal });
    });
    child.on("error", onError);
  });
  const initial = await within(terminal, timeoutMs);
  if (initial)
    return {
      ...initial,
      timedOut: false,
      stopRequested: false,
      stopError: null,
    };

  let stopRequested = false;
  let stopError = null;
  if (child.exitCode === null && child.signalCode === null) {
    if (child.killed) {
      stopError = "STOP_ALREADY_REQUESTED";
    } else if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      stopError = "PID_UNCONFIRMED";
    } else {
      stopRequested = true;
      try {
        if (!child.kill("SIGTERM")) stopError = "STOP_NOT_DELIVERED";
      } catch (error) {
        stopError =
          typeof error?.code === "string" &&
          /^[A-Z][A-Z0-9]{0,39}$/u.test(error.code)
            ? error.code
            : "STOP_FAILED";
      }
    }
  }
  onObservation({
    kind: "background-secondary-timeout-cleanup",
    pid: child.pid,
    stopRequested,
    stopError,
  });
  const reconciled = await within(terminal, cleanupTimeoutMs);
  if (reconciled)
    return { ...reconciled, timedOut: true, stopRequested, stopError };

  // The unknown child stays recorded, and no signal is sent again. Release only
  // this runner's owned pipe handles so its failure can reach a terminal report.
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  return { terminal: false, timedOut: true, stopRequested, stopError };
}
