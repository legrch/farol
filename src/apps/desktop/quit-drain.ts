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

export type QuitDrainPorts = Readonly<{
  // Every owned child at the moment quit begins: one-off host checks, the
  // product Agent, the connector, Route B and the relay. Collected exactly
  // once; a child that unregisters itself afterwards is still drained.
  collect(): readonly OwnedCloser[];
  deadlineMs: number;
  // The private diagnostic receipt. Its failure changes nothing about the
  // drain's outcome or the quit.
  record(receipt: QuitDrainReceipt): Promise<void>;
  // Quits for real, once, after the drain settled or its deadline passed.
  quit(): void;
}>;

export type QuitDrainState = "idle" | "draining" | "done";

export type QuitDrain = Readonly<{
  // The host's before-quit hook: prevents the first quit, drains, then lets
  // the real one through. Later quits during the drain change nothing.
  onBeforeQuit(event: Readonly<{ preventDefault(): void }>): void;
  state(): QuitDrainState;
}>;

/**
 * Quit as the product composes it: the first quit is held while every owned
 * child is closed and confirmed up to one deadline, the receipt is recorded,
 * and only then does the real quit run. A second quit while draining neither
 * restarts the drain nor skips it; after the drain, quit is not intercepted.
 */
export function createQuitDrain(ports: QuitDrainPorts): QuitDrain {
  let state: QuitDrainState = "idle";
  return {
    state: () => state,
    onBeforeQuit: (event) => {
      if (state === "done") return;
      event.preventDefault();
      if (state === "draining") return;
      state = "draining";
      const closers = [...ports.collect()];
      void drainOwnedChildren(closers, ports.deadlineMs)
        .then((receipt) => ports.record(receipt))
        .catch(() => undefined)
        .finally(() => {
          state = "done";
          ports.quit();
        });
    },
  };
}
