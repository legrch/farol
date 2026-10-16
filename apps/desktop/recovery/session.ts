import { BridgeError } from "../bridge/client";
import type { StartupRecoveryComputer } from "./core-host";
import {
  RecoveryReadRequestSchema,
  type RecoveryState,
  type RecoveryReadResult,
} from "../renderer/recovery/contract";
import type { ProductSettings } from "../../../src/pkg/product-settings/contract";

export type StartupRecoverySession = Readonly<{
  state(): Promise<RecoveryState>;
  read(request: unknown): Promise<RecoveryReadResult>;
  close(): Promise<void>;
}>;

// Mechanical UI lifetime over original owners. Startup exclusion remains with
// the caller. There is one load and one selected child, never a retry or normal
// runtime fallback. Only the allowed projection crosses to the document.
export function createStartupRecoverySession(
  ports: Readonly<{
    load(): Promise<ProductSettings | null>;
    start(settings: ProductSettings): Promise<StartupRecoveryComputer>;
    assertCurrent(): Promise<void>;
  }>,
): StartupRecoverySession {
  let closing = false,
    readBusy = false;
  let view: RecoveryState = { status: "settings_unavailable" };
  let computer: StartupRecoveryComputer | undefined;
  let computerClose: Promise<void> | undefined;
  let closeResult: Promise<void> | undefined;
  let cleanupFailure: unknown;
  const closeComputer = () => {
    if (computer && !computerClose) computerClose = computer.close();
    return computerClose;
  };
  const initialization = (async () => {
    let settings: ProductSettings | null;
    try {
      await ports.assertCurrent();
      if (closing) return;
      settings = await ports.load();
      await ports.assertCurrent();
      if (!settings || closing) return;
      view = {
        status: "ready",
        revision: settings.revision,
        folders: settings.computer.workspaces.map(
          ({ workspaceId, label, root }) => ({ workspaceId, label, root }),
        ),
        computer: "unavailable",
      };
    } catch {
      return;
    }
    try {
      if (closing) return;
      computer = await ports.start(settings);
      await ports.assertCurrent();
      if (closing) return;
      if (view.status === "ready") view = { ...view, computer: "available" };
    } catch (error) {
      // An original unknown startup/cleanup cannot become a clean UI Quit.
      if (!(error instanceof BridgeError) || error.state === "unknown")
        cleanupFailure = error;
      try {
        await closeComputer();
      } catch (cleanup) {
        cleanupFailure =
          cleanupFailure === undefined
            ? cleanup
            : new AggregateError(
                [cleanupFailure, cleanup],
                "recovery_cleanup_unconfirmed",
              );
      }
    }
  })();
  return Object.freeze({
    state: async (): Promise<RecoveryState> => {
      await initialization;
      return closing ? { status: "closing" } : structuredClone(view);
    },
    read: async (input: unknown): Promise<RecoveryReadResult> => {
      const parsed = RecoveryReadRequestSchema.safeParse(input);
      if (!parsed.success) return { status: "refused" };
      await initialization;
      if (
        closing ||
        readBusy ||
        !computer ||
        view.status !== "ready" ||
        view.computer !== "available"
      )
        return { status: "unavailable" };
      const { kind, workspaceId, relativePath } = parsed.data;
      if (!view.folders.some((folder) => folder.workspaceId === workspaceId))
        return { status: "refused" };
      readBusy = true;
      try {
        await ports.assertCurrent();
        if (closing) return { status: "unavailable" };
        const data =
          kind === "list"
            ? await computer.list(workspaceId, relativePath)
            : await computer.snapshot(workspaceId, relativePath);
        await ports.assertCurrent();
        if (closing) return { status: "unavailable" };
        if (kind === "list" && "entries" in data)
          return {
            status: "ok",
            data: {
              kind,
              relativePath,
              entries: [...data.entries],
              truncated: data.truncated,
            },
          };
        if (kind === "metadata" && "sha256" in data)
          return {
            status: "ok",
            data: {
              kind,
              relativePath,
              bytes: data.bytes,
              sha256: data.sha256,
            },
          };
        throw new BridgeError("unknown", "crossed_recovery_result");
      } catch (error) {
        const status =
          error instanceof BridgeError
            ? error.state === "unsupported"
              ? "unavailable"
              : error.state
            : "unknown";
        if (status === "unknown") {
          if (view.status === "ready")
            view = { ...view, computer: "unavailable" };
        }
        return { status };
      } finally {
        readBusy = false;
      }
    },
    close: () => {
      if (!closeResult) {
        closing = true;
        closeResult = (async () => {
          await initialization;
          await closeComputer();
          if (cleanupFailure !== undefined) throw cleanupFailure;
        })();
      }
      return closeResult;
    },
  });
}
