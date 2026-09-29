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
  }>,
): GracefulQuitSignals {
  let ready = false;
  let requested = false;
  let disposed = false;
  const request = () => {
    if (disposed || requested || ports.isQuitting()) return;
    requested = true;
    ports.requestQuit();
  };
  return {
    ready: () => {
      if (disposed || ready) return;
      ready = true;
      ports.signals.on("SIGINT", request);
      ports.signals.on("SIGTERM", request);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ports.signals.removeListener("SIGINT", request);
      ports.signals.removeListener("SIGTERM", request);
    },
  };
}
