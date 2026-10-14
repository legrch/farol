type Runtime = Readonly<{ close(): Promise<unknown> }>;
export type RuntimeParentPorts<R extends Runtime> = Readonly<{
  onStop(handler: () => void): void;
  connected(): boolean;
  ready(runtime: R): void;
  closed(): void;
  exit(code: number): void;
}>;

/** Install parent-loss ownership before the original asynchronous startup. */
export async function runParentOwnedRuntime<R extends Runtime>(
  start: () => Promise<R>,
  parent: RuntimeParentPorts<R>,
): Promise<void> {
  let runtime: R | null = null;
  let stopRequested = false;
  let closing: Promise<void> | null = null;
  const stop = () => {
    stopRequested = true;
    if (runtime === null || closing !== null) return;
    const original = runtime;
    closing = Promise.resolve()
      .then(() => original.close())
      .then(
        () => {
          if (parent.connected()) {
            try {
              parent.closed();
            } catch {
              /* Lost ACK does not undo shutdown. */
            }
          }
          parent.exit(0);
        },
        () => parent.exit(1),
      );
  };
  parent.onStop(stop);
  if (stopRequested || !parent.connected()) {
    parent.exit(0);
    return;
  }
  runtime = await start();
  if (stopRequested || !parent.connected()) {
    stop();
    await closing;
  } else {
    parent.ready(runtime);
  }
}
