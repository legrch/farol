export type OwnedCloser = Readonly<{ name: string; close(): Promise<void> }>;

export type QuitDrainReceipt = Readonly<{
  drained: boolean;
  // Owned children whose exit was not confirmed before the deadline, or
  // whose close failed: the app cannot claim they stopped.
  unconfirmed: readonly string[];
}>;

/**
 * Closes every owned child at quit and waits for each to confirm, up to one
 * shared deadline. Sending a signal is not a drain; only a confirmed close
 * is. What did not confirm is named, never reported as drained.
 */
export async function drainOwnedChildren(
  closers: readonly OwnedCloser[],
  deadlineMs: number,
): Promise<QuitDrainReceipt> {
  const confirmed = new Set<string>();
  const closing = Promise.allSettled(
    closers.map(async (closer) => {
      await closer.close();
      confirmed.add(closer.name);
    }),
  );
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    closing,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  const unconfirmed = closers
    .map((closer) => closer.name)
    .filter((name) => !confirmed.has(name));
  return { drained: unconfirmed.length === 0, unconfirmed };
}
