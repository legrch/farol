// The deadline discipline of one installed-update relaunch observation. Each
// observation gets a fresh budget; every read races that budget, and an
// exhausted budget is a timeout, never success. Nothing here retries or
// classifies what a read returned: the relaunch owner decides that, and an
// unconfirmed relaunch stays unconfirmed.

export type RelaunchWaitOptions = Readonly<{
  timeoutMs?: number;
  intervalMs?: number;
}>;

export type RelaunchWaitPorts = Readonly<{
  now(): number;
  pause(ms: number): Promise<void>;
}>;

export type RelaunchBudget = Readonly<{
  remaining(): number;
  bounded<T>(read: () => Promise<T>): Promise<T>;
  // One poll interval, never longer than the budget that is left.
  sleep(): Promise<void>;
}>;

export type RelaunchWait = Readonly<{
  intervalMs: number;
  begin(): RelaunchBudget;
}>;

export function createRelaunchWait(
  options: RelaunchWaitOptions,
  ports: RelaunchWaitPorts,
): RelaunchWait {
  const timeoutMs = options.timeoutMs ?? 30000;
  const intervalMs = options.intervalMs ?? 50;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > 1000
  )
    throw new Error("UPDATE_RELAUNCH_DEADLINE_INVALID");
  return {
    intervalMs,
    begin() {
      const deadline = ports.now() + timeoutMs;
      const remaining = () => {
        const ms = Math.ceil(deadline - ports.now());
        if (ms <= 0) throw new Error("UPDATE_RELAUNCH_TIMEOUT");
        return ms;
      };
      const bounded = async <T>(read: () => Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const budget = remaining();
          const value = await Promise.race([
            read(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("UPDATE_RELAUNCH_TIMEOUT")),
                budget,
              );
            }),
          ]);
          remaining();
          return value;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };
      return {
        remaining,
        bounded,
        sleep: () =>
          bounded(() => ports.pause(Math.min(intervalMs, remaining()))),
      };
    },
  };
}
