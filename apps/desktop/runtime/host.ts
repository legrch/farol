import type { ChildProcess, SpawnOptions } from "node:child_process";
import path from "node:path";
import type { LocalRuntimeLifetime } from "../../../src/apps/desktop/local-runtime-lifetime";
import type { DesktopAdmission } from "../host/admission";

// The local in-memory preview runtime child: its start through the private
// executable and Node IPC, and what an exit means once it is ready. Main keeps
// every owner; each `let` there is a late getter or a setter here, so a Quit
// that arrives while the resource recheck or the ready message waits is seen at
// the next read. The child, its generation counter and the exit handler are
// read and written only here, so they live in this closure. Nothing here
// retries: a failed start leaves the runtime failed, never started again.

export type PreviewRuntimeTask = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  generation: number;
  label: string;
  hasComputer: boolean;
}>;

export type PreviewRuntimeReady = Readonly<{
  identity: string;
  tasks: readonly PreviewRuntimeTask[];
}>;

export type PreviewRuntimeState = "starting" | "ready" | "offline" | "failed";

export type PreviewRuntimePorts<Ready extends PreviewRuntimeReady> = Readonly<{
  desktopAdmission: Pick<DesktopAdmission, "closed">;
  ownedLocalRuntimes: Pick<
    Map<LocalRuntimeLifetime, string>,
    "size" | "set" | "delete"
  >;
  runtimeStopping: () => boolean;
  setRuntimeStopping: (value: boolean) => void;
  setRuntime: (value: Ready | null) => void;
  setRuntimeState: (value: PreviewRuntimeState) => void;
  setRuntimeError: (value: string | null) => void;
  setTaskCountsBeforeRuntimeExit: (
    value: Readonly<{
      running: number;
      waiting: number;
      failed: number;
    }> | null,
  ) => void;
  installedUpdates: Readonly<{
    resources: () => Readonly<{
      executable: string;
      directory: string;
      recheck: () => Promise<void>;
    }>;
  }>;
  activeDesktopIdentity: Readonly<{ runtimeIdentity: string }>;
  demoMode: boolean;
  expectedTasks: readonly PreviewRuntimeTask[];
  readySchema: Readonly<{
    safeParse: (
      value: unknown,
    ) =>
      Readonly<{ success: true; data: Ready }> | Readonly<{ success: false }>;
  }>;
  streamControllers: Pick<Map<string, unknown>, "size">;
  pendingComputer: Pick<Map<string, unknown>, "size" | "clear">;
  taskSurfaceFailures: Pick<Map<string, unknown>, "size" | "clear">;
  stopStreams: () => void;
  disposeTaskViews: (reason: "runtime") => void;
  publishRuntimeStatus: () => void;
  observeLocalRuntime: (
    child: ChildProcess,
    scope: "in-memory-preview",
  ) => LocalRuntimeLifetime;
  spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  setTimeout: (
    handler: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  env: Readonly<Record<string, string | undefined>>;
  argv: readonly string[];
}>;

export function createPreviewRuntime<Ready extends PreviewRuntimeReady>(
  ports: PreviewRuntimePorts<Ready>,
) {
  const {
    desktopAdmission,
    ownedLocalRuntimes,
    runtimeStopping,
    setRuntimeStopping,
    setRuntime,
    setRuntimeState,
    setRuntimeError,
    setTaskCountsBeforeRuntimeExit,
    installedUpdates,
    activeDesktopIdentity,
    demoMode,
    expectedTasks,
    readySchema,
    streamControllers,
    pendingComputer,
    taskSurfaceFailures,
    stopStreams,
    disposeTaskViews,
    publishRuntimeStatus,
    observeLocalRuntime,
    spawn,
    setTimeout,
    clearTimeout,
    env,
    argv,
  } = ports;

  let runtimeChild: ChildProcess | null = null;
  let localRuntimeGeneration = 0;

  function handleRuntimeExit(code: number | null): void {
    if (runtimeStopping()) {
      runtimeChild = null;
      setRuntime(null);
      return;
    }
    setTaskCountsBeforeRuntimeExit({
      running: streamControllers.size,
      waiting: pendingComputer.size,
      failed: taskSurfaceFailures.size,
    });
    runtimeChild = null;
    setRuntime(null);
    setRuntimeState("failed");
    setRuntimeError(
      code === 0 ? "RUNTIME_PROCESS_EXITED" : "RUNTIME_PROCESS_FAILED",
    );
    stopStreams();
    taskSurfaceFailures.clear();
    pendingComputer.clear();
    disposeTaskViews("runtime");
    publishRuntimeStatus();
  }

  async function startRuntime(): Promise<void> {
    if (desktopAdmission.closed()) return;
    if (runtimeChild !== null || ownedLocalRuntimes.size !== 0) {
      throw new Error("LOCAL_RUNTIME_ALREADY_OWNED");
    }
    setRuntimeStopping(false);
    const resources = installedUpdates.resources();
    await resources.recheck();
    if (runtimeStopping() || desktopAdmission.closed()) return;
    const child = spawn(
      resources.executable,
      [path.join(resources.directory, "runtime.cjs")],
      {
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          LANG: env.LANG ?? "en_US.UTF-8",
          FAROL_RUNTIME_IDENTITY: activeDesktopIdentity.runtimeIdentity,
          FAROL_PREVIEW_SCENARIO: argv.includes("--preview-stream-failure")
            ? "stream-failure"
            : env.FAROL_E2E === "1" &&
                argv.includes("--preview-runtime-start-failure")
              ? "startup-failure"
              : argv.includes("--preview-failure")
                ? "failure"
                : "normal",
          FAROL_PREVIEW_MODE: demoMode ? "demo" : "empty",
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
        windowsHide: true,
      },
    );
    runtimeChild = child;
    // runtime.cjs is the build-qualified in-memory preview service. Real Go,
    // connector and command owners keep their independent shutdown obligations.
    const lifetime = observeLocalRuntime(child, "in-memory-preview");
    ownedLocalRuntimes.set(
      lifetime,
      `local-runtime-${++localRuntimeGeneration}`,
    );
    void lifetime.closed.then(
      () => ownedLocalRuntimes.delete(lifetime),
      () => {
        /* A failed shutdown remains an unconfirmed Quit obligation. */
      },
    );
    try {
      setRuntime(
        await new Promise<Ready>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error("RUNTIME_START_TIMEOUT"));
          }, 10_000);
          child.once("error", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error("RUNTIME_PROCESS_NOT_STARTED"));
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            if (settled) {
              handleRuntimeExit(code);
              return;
            }
            settled = true;
            reject(
              new Error(
                code === 0 ? "RUNTIME_EXITED" : `RUNTIME_START_FAILED_${code}`,
              ),
            );
          });
          child.on("message", (message) => {
            const parsed = readySchema.safeParse(message);
            if (!parsed.success || settled) return;
            if (
              parsed.data.identity !== activeDesktopIdentity.runtimeIdentity
            ) {
              settled = true;
              clearTimeout(timer);
              reject(new Error("RUNTIME_IDENTITY_MISMATCH"));
              return;
            }
            const exactTasks =
              parsed.data.tasks.length === expectedTasks.length &&
              parsed.data.tasks.every((task, index) => {
                const expected = expectedTasks[index];
                return (
                  expected !== undefined &&
                  task.ownerId === expected.ownerId &&
                  task.sessionId === expected.sessionId &&
                  task.taskId === expected.taskId &&
                  task.turnId === expected.turnId &&
                  task.generation === expected.generation &&
                  task.label === expected.label &&
                  task.hasComputer === expected.hasComputer
                );
              });
            if (!exactTasks) {
              settled = true;
              clearTimeout(timer);
              reject(new Error("RUNTIME_TASK_MANIFEST_MISMATCH"));
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(parsed.data);
          });
        }),
      );
      setRuntimeState("ready");
      setTaskCountsBeforeRuntimeExit(null);
    } catch (error) {
      setRuntimeState("failed");
      setRuntimeError(
        error instanceof Error ? error.message : "RUNTIME_START_FAILED",
      );
      setRuntimeStopping(true);
      child.kill();
      runtimeChild = null;
    }
  }

  return { start: startRuntime };
}
