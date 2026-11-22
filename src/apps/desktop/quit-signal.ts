type QuitSignal = "SIGINT" | "SIGTERM";

type SignalSource = Readonly<{
  on(signal: QuitSignal, listener: () => void): unknown;
  removeListener(signal: QuitSignal, listener: () => void): unknown;
}>;

export type GracefulQuitSignals = Readonly<{
  // Install only once before-quit is listening. Until then preserve native
  // termination instead of swallowing a signal behind a stalled startup.
  ready(): void;
  dispose(): void;
}>;

export function createGracefulQuitSignals(
  ports: Readonly<{
    signals: SignalSource;
    requestQuit(): void;
    isQuitting(): boolean;
    // Diagnostic only; never throws into the signal path.
    observe?(signal: QuitSignal, ignored: boolean): void;
  }>,
): GracefulQuitSignals {
  let ready = false;
  let requested = false;
  let disposed = false;
  const handle = (signal: QuitSignal) => {
    const ignored = disposed || requested || ports.isQuitting();
    try {
      ports.observe?.(signal, ignored);
    } catch {
      // Observation can never change the signal outcome.
    }
    if (ignored) return;
    requested = true;
    ports.requestQuit();
  };
  const onSigint = () => handle("SIGINT");
  const onSigterm = () => handle("SIGTERM");
  return {
    ready: () => {
      if (disposed || ready) return;
      ready = true;
      ports.signals.on("SIGINT", onSigint);
      ports.signals.on("SIGTERM", onSigterm);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ports.signals.removeListener("SIGINT", onSigint);
      ports.signals.removeListener("SIGTERM", onSigterm);
    },
  };
}
