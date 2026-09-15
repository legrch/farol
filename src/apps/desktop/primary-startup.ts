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
