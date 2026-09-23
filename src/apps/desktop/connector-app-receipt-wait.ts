/** Waits for a matching receipt through read-only probes after one send. */
export async function readPendingConnectorReceipt<T>(
  readReceipt: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await readReceipt();
  } catch (error) {
    // The recorder creates the private file before writing its JSON. An
    // incomplete observation can settle on the next read; a persistently
    // invalid receipt still times out without another ChatGPT message.
    if (
      error instanceof Error &&
      error.message === "CONNECTOR_VERIFICATION_RECEIPT_INVALID"
    ) {
      return null;
    }
    throw error;
  }
}

export async function waitForConnectorAppReceipt<T>(
  readReceipt: () => Promise<T | null>,
  matchesAttempt: (receipt: T) => boolean,
  options: Readonly<{
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    pause?: (ms: number) => Promise<void>;
  }> = {},
): Promise<T | null> {
  const now = options.now ?? Date.now;
  const pause =
    options.pause ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 45_000);
  const interval = options.intervalMs ?? 1_000;
  while (now() < deadline) {
    const remaining = deadline - now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const receipt = await Promise.race([
      readReceipt(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), remaining);
      }),
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    if (receipt !== null && matchesAttempt(receipt)) return receipt;
    const remainingAfterRead = deadline - now();
    if (remainingAfterRead <= 0) return null;
    await pause(Math.min(interval, remainingAfterRead));
  }
  return null;
}
