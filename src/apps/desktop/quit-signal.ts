type QuitSignal = "SIGINT" | "SIGTERM";

type SignalSource = Readonly<{
  on(signal: QuitSignal, listener: () => void): unknown;
  removeListener(signal: QuitSignal, listener: () => void): unknown;
}>;

export type GracefulQuitSignals = Readonly<{
  // Arm only after before-quit is listening, so a signal during startup
  // cannot bypass the quit drain.
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
  let pending = false;
  let requested = false;
  let disposed = false;
  const request = () => {
    if (disposed || requested || ports.isQuitting()) return;
    pending = true;
    if (!ready) return;
    requested = true;
    ports.requestQuit();
  };
  ports.signals.on("SIGINT", request);
  ports.signals.on("SIGTERM", request);
  return {
    ready: () => {
      if (disposed || ready) return;
      ready = true;
      if (pending) request();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ports.signals.removeListener("SIGINT", request);
      ports.signals.removeListener("SIGTERM", request);
    },
  };
}
