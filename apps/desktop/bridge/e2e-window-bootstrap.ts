import { app, BrowserWindow } from "electron";
import { writeSync } from "node:fs";
import {
  desktopAppDataPath,
  desktopEnvironment,
} from "../../../src/apps/desktop/desktop-environment.ts";
import { parsePreviewWindowMode } from "../../../src/apps/desktop/window-placement.ts";
import {
  createE2EWindowObserver,
  E2E_WINDOW_LIFETIME_PREFIX,
  type E2EWindowObserverPorts,
} from "./e2e-window-observer.ts";

export interface E2EWindowBootstrapPorts {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly pid: number;
  readonly app: object;
  readonly existingWindows: E2EWindowObserverPorts["existingWindows"];
  readonly subscribeCreated: E2EWindowObserverPorts["subscribeCreated"];
  readonly onNodeExit: (listen: (code: number) => void) => void;
  readonly onAppQuit: (listen: (code: number) => void) => void;
  readonly write: (line: string) => void;
}

/** The same read-only physical proof as main, before any product composition. */
export function installE2EWindowObserver(ports: E2EWindowBootstrapPorts): void {
  const { env } = ports;
  if (env.FAROL_E2E !== "1") return;
  try {
    if (parsePreviewWindowMode(ports.argv) !== "hidden") return;
    desktopAppDataPath(desktopEnvironment(env.FAROL_ENVIRONMENT), "/", {
      enabled: true,
      override: env.FAROL_E2E_APP_DATA,
      acceptanceProfile: env.FAROL_ACCEPTANCE_PROFILE,
      testRoot: env.FAROL_E2E_TEST_ROOT,
      testHome: env.HOME,
      testProof: env.FAROL_E2E_TEST_PROOF,
    });
  } catch {
    // Main retains startup refusal. No dialog, fallback, or observer on bad proof.
    return;
  }
  const observer = createE2EWindowObserver({
    pid: ports.pid,
    existingWindows: ports.existingWindows,
    subscribeCreated: ports.subscribeCreated,
    publish: (frame) =>
      ports.write(`${E2E_WINDOW_LIFETIME_PREFIX}${JSON.stringify(frame)}\n`),
  });
  // Installation failures are diagnostic only and must not affect product flow.
  // A missing readback or terminal frame cannot pass the consumer's proof gate.
  try {
    Object.defineProperty(ports.app, "__farolE2EWindowLifetime", {
      value: observer.snapshot,
      writable: false,
      configurable: false,
    });
    ports.onNodeExit((code) => observer.terminal("node-exit", code));
    ports.onAppQuit((code) => observer.terminal("app-quit", code));
  } catch {
    // Keep the already subscribed observer active; never hide/close any window.
  }
}

// This module is main's first import. These closures perform no native reads or
// hook registration unless the E2E flag, parsed mode and physical proof pass.
installE2EWindowObserver({
  env: process.env,
  argv: process.argv,
  pid: process.pid,
  app,
  existingWindows: () => BrowserWindow.getAllWindows(),
  subscribeCreated: (listen) => {
    app.on("browser-window-created", (_event, window) => listen(window));
  },
  onNodeExit: (listen) => {
    process.once("exit", listen);
  },
  onAppQuit: (listen) => {
    app.once("quit", (_event, code) => listen(code));
  },
  write: (line) => {
    if (writeSync(2, line) !== line.length)
      throw new Error("E2E_WINDOW_LIFETIME_WRITE_INCOMPLETE");
  },
});
