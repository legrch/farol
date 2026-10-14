import type { ChildProcess } from "node:child_process";

export type LocalRuntimeLifetime = Readonly<{
  closed: Promise<void>;
  requestStop(): void;
  close(): Promise<void>;
}>;

/** Sending shutdown is not completion; retain this exact child's close event. */
export function observeLocalRuntime(child: ChildProcess): LocalRuntimeLifetime {
  let terminal = false;
  let requested = false;
  let exited: Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> | null = null;
  let disconnected = false;
  const closed = new Promise<void>((resolve, reject) => {
    const complete = (code: number | null, signal: NodeJS.Signals | null) => {
      if (terminal) return;
      terminal = true;
      if (code === 0 && signal === null) resolve();
      else reject(new Error("LOCAL_RUNTIME_SHUTDOWN_UNCONFIRMED"));
    };
    const disconnectedExit = () => {
      // Node can omit `close` after the parent disconnects IPC. An original
      // exit plus observed IPC disconnection is equivalent only with no
      // parent-owned stdio streams left to drain. This does not establish descendant cleanup.
      if (
        exited !== null &&
        disconnected &&
        child.stdin === null &&
        child.stdout === null &&
        child.stderr === null
      ) {
        complete(exited.code, exited.signal);
      }
    };
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      disconnectedExit();
    });
    child.once("disconnect", () => {
      disconnected = true;
      disconnectedExit();
    });
    child.once("close", complete);
  });
  // An early failure still belongs to Quit collection; no unhandled rejection.
  void closed.catch(() => undefined);
  const requestStop = () => {
    if (requested || terminal || exited !== null) return;
    requested = true;
    if (!child.connected) return;
    try {
      child.send("shutdown", () => {});
    } catch {
      // IPC refusal cannot manufacture a terminal observation or a retry.
    }
  };
  return {
    closed,
    requestStop,
    close: () => {
      requestStop();
      return closed;
    },
  };
}
