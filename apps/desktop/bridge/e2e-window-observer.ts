export const E2E_WINDOW_LIFETIME_SCHEMA = "farol.e2e-window-lifetime/1";
export const E2E_WINDOW_LIFETIME_PREFIX = "FAROL_E2E_WINDOW_LIFETIME:";

type WindowEvent = "show" | "focus" | "closed";
type TerminalEvent = "node-exit" | "app-quit";
export type E2EWindowLifetimeEvent =
  "armed" | "created" | WindowEvent | TerminalEvent;

export interface WindowPort {
  readonly id: number;
  isVisible(): boolean;
  isFocused(): boolean;
  on(event: WindowEvent, listener: () => void): unknown;
}

export interface FrozenSnapshot {
  readonly schema: typeof E2E_WINDOW_LIFETIME_SCHEMA;
  readonly pid: number;
  readonly sequence: number;
  readonly priorWindows: number;
  readonly createdWindows: number;
  readonly openWindows: number;
  readonly violations: number;
  readonly overflow: boolean;
  readonly observerFault: boolean;
}

export interface E2EWindowLifetimeFrame extends FrozenSnapshot {
  readonly event: E2EWindowLifetimeEvent;
  readonly exitCode: number | null;
}

export interface E2EWindowObserverPorts {
  readonly pid: number;
  readonly existingWindows: () => readonly WindowPort[];
  readonly subscribeCreated: (listen: (window: WindowPort) => void) => void;
  readonly publish: (frame: E2EWindowLifetimeFrame) => void;
}

/** Content-free, observation-only lifetime evidence. Closed IDs remain reserved. */
export function createE2EWindowObserver(ports: E2EWindowObserverPorts) {
  let sequence = 0;
  let priorWindows = 0;
  let createdWindows = 0;
  let openWindows = 0;
  let violations = 0;
  let overflow = false;
  let observerFault = !Number.isSafeInteger(ports.pid) || ports.pid <= 0;
  const pid = observerFault ? 0 : ports.pid;
  const windows = new Map<number, { closed: boolean }>();

  function increment(value: number): number {
    if (value === Number.MAX_SAFE_INTEGER) {
      overflow = true;
      return value;
    }
    return value + 1;
  }

  function snapshot(): FrozenSnapshot {
    return Object.freeze({
      schema: E2E_WINDOW_LIFETIME_SCHEMA,
      pid,
      sequence,
      priorWindows,
      createdWindows,
      openWindows,
      violations,
      overflow,
      observerFault,
    });
  }

  function emit(
    event: E2EWindowLifetimeEvent,
    exitCode: number | null = null,
  ): void {
    sequence = increment(sequence);
    const frame = Object.freeze({ ...snapshot(), event, exitCode });
    try {
      ports.publish(frame);
    } catch {
      // The next frame/snapshot retains this failure; never throw into Electron.
      observerFault = true;
    }
  }

  function observe(action: () => void): void {
    try {
      action();
    } catch {
      observerFault = true;
    }
  }

  function attach(window: WindowPort): void {
    const id = window.id;
    if (!Number.isSafeInteger(id) || id <= 0 || windows.has(id)) {
      observerFault = true;
      return;
    }
    if (windows.size === 64) {
      overflow = true;
      return;
    }
    const state = { closed: false };
    windows.set(id, state);
    openWindows = increment(openWindows);
    for (const event of ["show", "focus", "closed"] as const) {
      // One failed listener must not prevent the remaining observations.
      observe(() =>
        window.on(event, () => {
          observe(() => {
            if (event === "closed") {
              if (state.closed) observerFault = true;
              else {
                state.closed = true;
                openWindows -= 1;
              }
            } else {
              if (state.closed) observerFault = true;
              violations = increment(violations);
            }
          });
          emit(event);
        }),
      );
    }
    for (const sample of [() => window.isVisible(), () => window.isFocused()]) {
      observe(() => {
        const value = sample();
        if (typeof value !== "boolean") observerFault = true;
        else if (value) violations = increment(violations);
      });
    }
  }

  // Subscribe first: even a creation during enumeration cannot go unobserved.
  observe(() =>
    ports.subscribeCreated((window) => {
      createdWindows = increment(createdWindows);
      observe(() => attach(window));
      emit("created");
    }),
  );
  observe(() => {
    for (const window of ports.existingWindows()) {
      priorWindows = increment(priorWindows);
      observe(() => attach(window));
    }
  });
  emit("armed");

  function terminal(event: TerminalEvent, exitCode: number): void {
    if (!Number.isSafeInteger(exitCode)) {
      observerFault = true;
      emit(event, 0);
      return;
    }
    emit(event, exitCode);
  }

  return Object.freeze({ snapshot, terminal });
}
