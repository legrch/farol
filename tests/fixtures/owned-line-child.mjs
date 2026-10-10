// Test-only observation of one original child. A line is not terminal proof;
// close must be retained before any asynchronous fixture work can lose it.
export function observeOwnedLineChild(
  child,
  {
    lineTimeoutMs = 10_000,
    closeTimeoutMs = 30_000,
    outputLimit = 64 * 1024,
  } = {},
) {
  if (
    !child.stdout ||
    !Number.isSafeInteger(lineTimeoutMs) ||
    lineTimeoutMs < 1 ||
    !Number.isSafeInteger(closeTimeoutMs) ||
    closeTimeoutMs < 1 ||
    !Number.isSafeInteger(outputLimit) ||
    outputLimit < 1
  )
    throw new Error("FIXTURE_CHILD_OBSERVATION_INVALID");

  let output = "";
  let outputBytes = 0;
  let failure = null;
  let terminal = null;
  let spawnErrorCode = null;
  let settleClose;
  let rejectClose;
  const pending = new Set();
  const closed = new Promise((resolve, reject) => {
    settleClose = resolve;
    rejectClose = reject;
  });
  // Keep the original rejection observed while the test is awaiting a line.
  // Awaiting `closed` later still receives the same original failure.
  void closed.catch(() => undefined);
  const refuseLines = (code, cause) => {
    failure ??= new Error(code, { cause });
    for (const waiter of pending) waiter.reject(failure);
  };
  const closeTimer = setTimeout(() => {
    const unconfirmed = new Error("FIXTURE_CHILD_CLOSE_UNCONFIRMED", {
      cause: failure,
    });
    refuseLines(unconfirmed.message);
    rejectClose(unconfirmed);
    child.stdout.off("data", onData);
    child.stderr?.off("data", onStderr);
  }, closeTimeoutMs);
  const onData = (chunk) => {
    if (failure) return;
    const bytes = Buffer.from(chunk);
    outputBytes += bytes.length;
    if (outputBytes > outputLimit) {
      refuseLines("FIXTURE_CHILD_OUTPUT_LIMIT");
      return;
    }
    output += bytes.toString("utf8");
    for (const waiter of pending)
      if (output.includes(waiter.needle)) waiter.resolve();
  };
  // Drain the original diagnostics pipe without storing or exposing its text.
  const onStderr = (chunk) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > outputLimit) refuseLines("FIXTURE_CHILD_OUTPUT_LIMIT");
  };
  child.stdout.on("data", onData);
  child.stderr?.on("data", onStderr);
  child.on("error", (error) => {
    spawnErrorCode =
      typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code)
        ? error.code
        : null;
    refuseLines("FIXTURE_CHILD_START_FAILED", { code: spawnErrorCode });
  });
  child.once("close", (code, signal) => {
    terminal = Object.freeze({ code, signal, spawnErrorCode });
    clearTimeout(closeTimer);
    child.stdout.off("data", onData);
    child.stderr?.off("data", onStderr);
    refuseLines("FIXTURE_CHILD_CLOSED_BEFORE_LINE", terminal);
    settleClose(terminal);
  });

  return Object.freeze({
    closed,
    waitForLine(needle) {
      if (typeof needle !== "string" || !needle || needle.length > 256)
        return Promise.reject(new Error("FIXTURE_CHILD_LINE_INVALID"));
      if (failure) return Promise.reject(failure);
      if (terminal)
        return Promise.reject(
          new Error("FIXTURE_CHILD_CLOSED_BEFORE_LINE", { cause: terminal }),
        );
      if (output.includes(needle)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        let waiter;
        const finish = (callback, value) => {
          if (!pending.delete(waiter)) return;
          clearTimeout(timer);
          callback(value);
        };
        const timer = setTimeout(
          () => finish(reject, new Error("FIXTURE_CHILD_LINE_TIMEOUT")),
          lineTimeoutMs,
        );
        waiter = {
          needle,
          resolve: () => finish(resolve),
          reject: (error) => finish(reject, error),
        };
        pending.add(waiter);
      });
    },
  });
}
