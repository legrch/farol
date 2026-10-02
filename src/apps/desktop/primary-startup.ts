export class PrimaryStartup {
  private initialization: Promise<void> | null = null;

  begin(initialization: Promise<void>): void {
    if (this.initialization) throw new Error("PRIMARY_STARTUP_ALREADY_BEGUN");
    this.initialization = initialization.then(
      () => undefined,
      () => {
        throw new Error("PRIMARY_STARTUP_FAILED");
      },
    );
    void this.initialization.catch(() => undefined);
  }

  async whenReady(): Promise<void> {
    if (!this.initialization) throw new Error("PRIMARY_STARTUP_UNAVAILABLE");
    await this.initialization;
  }
}

export type StartupStage =
  | "lock-primary"
  | "lock-secondary"
  | "before-ready"
  | "ready"
  | "run-marker"
  | "before-delay"
  | "delay-complete"
  | "startup-complete"
  | "connector-resumed"
  | "connector-resume-refused"
  | "connector-resume-failed"
  | "update-abort-connector-resumed"
  | "update-abort-connector-resume-refused"
  | "update-abort-connector-resume-failed"
  | "connector-resume-skipped";

// E2E-only, fixed tokens. No profile path, command line or browser content is
// ever included in this diagnostic stream.
export function emitStartupStage(
  stage: StartupStage,
  enabled: boolean,
  write: (line: string) => void,
): void {
  if (enabled) write(`FAROL_NEXT_STARTUP_STAGE:${stage}\n`);
}

export function primaryStartupReady(state: {
  runtimeState: "starting" | "ready" | "offline" | "failed";
  windowReady: boolean;
  taskViewCount: number;
  expectedTaskViewCount: number;
  // A primary that is quitting or stopping its runtime is not ready, even
  // while its window is still up: a second launch must not be told it was
  // reopened into an app that is about to exit (F3-P2).
  stopping?: boolean;
}): boolean {
  return (
    state.stopping !== true &&
    state.runtimeState === "ready" &&
    state.windowReady &&
    Number.isSafeInteger(state.expectedTaskViewCount) &&
    state.expectedTaskViewCount >= 0 &&
    state.taskViewCount === state.expectedTaskViewCount
  );
}

export function previewStartupDelay(
  arguments_: readonly string[],
  enabled: boolean,
): number {
  if (!enabled) return 0;
  const prefix = "--preview-startup-delay-ms=";
  const values = arguments_
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
  if (values.length !== 1 || !/^[0-9]{1,4}$/u.test(values[0] ?? "")) return 0;
  const delay = Number(values[0]);
  return Number.isSafeInteger(delay) && delay >= 1 && delay <= 5_000
    ? delay
    : 0;
}
