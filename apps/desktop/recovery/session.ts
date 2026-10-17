import { BridgeError, type ChildTerminalObservation } from "../bridge/client";
import type { StartupRecoveryCore } from "./core-host";
import {
  RecoveryReadRequestSchema,
  RecoveryReadResultSchema,
  type RecoveryArchiveEntry,
  type RecoveryState,
  type RecoveryReadResult,
} from "../renderer/recovery/contract";
import type { ProductSettings } from "../../../src/pkg/product-settings/contract";

export type StartupRecoverySession = Readonly<{
  state(): Promise<RecoveryState>;
  read(request: unknown): Promise<RecoveryReadResult>;
  close(): Promise<void>;
  closeAndObserve(): Promise<ChildTerminalObservation>;
}>;

// One original Settings load and selected child. Saved Settings do not wait for
// child readiness. Independent read surfaces retain their own availability;
// original startup exclusion and child cleanup remain with this UI lifetime.
export function createStartupRecoverySession(
  ports: Readonly<{
    load(): Promise<ProductSettings | null>;
    start(settings: ProductSettings): Promise<StartupRecoveryCore>;
    assertCurrent(): Promise<void>;
  }>,
): StartupRecoverySession {
  let closing = false,
    readBusy = false,
    withdrawn = false;
  let view: RecoveryState = { status: "settings_unavailable" };
  let core: StartupRecoveryCore | undefined;
  let coreClose: Promise<void> | undefined;
  let coreObservation: Promise<ChildTerminalObservation> | undefined;
  let terminalResult: Promise<ChildTerminalObservation> | undefined;
  let closeResult: Promise<void> | undefined;
  let cleanupFailure: unknown;
  let exclusionFailure: unknown;
  let archiveLoaded = false,
    archiveNext = "";
  const entries = new Map<string, RecoveryArchiveEntry>();
  const unavailable = (surface?: "computer" | "archive") => {
    if (view.status !== "ready") return;
    view = surface
      ? { ...view, [surface]: "unavailable" }
      : { ...view, computer: "unavailable", archive: "unavailable" };
  };
  const observeCore = () => {
    if (core && !core.isAvailable()) unavailable();
  };
  const ready = (folderReadsAvailable: boolean) => {
    if (view.status === "ready" && !withdrawn)
      view = {
        ...view,
        computer: folderReadsAvailable ? "available" : "unavailable",
        archive: "available",
      };
  };
  const assertCurrent = async () => {
    if (withdrawn) throw exclusionFailure;
    try {
      await ports.assertCurrent();
      if (withdrawn) throw exclusionFailure;
    } catch (error) {
      withdrawn = true;
      exclusionFailure = error ?? Error("recovery_exclusion_lost");
      unavailable();
      throw exclusionFailure;
    }
  };
  const closeCore = () => {
    if (core && !coreClose)
      coreClose = coreObservation
        ? coreObservation.then(() => undefined)
        : core.close();
    return coreClose;
  };
  const closeCoreAndObserve = (): Promise<ChildTerminalObservation> => {
    if (!core)
      throw new BridgeError("unavailable", "startup_recovery_core_not_started");
    if (!coreObservation)
      coreObservation = coreClose
        ? coreClose.then(() => core!.closeAndObserve())
        : core.closeAndObserve();
    return coreObservation;
  };
  const loaded = (async () => {
    try {
      await assertCurrent();
      if (closing) return null;
      const settings = await ports.load();
      await assertCurrent();
      if (!settings || closing) return null;
      view = {
        status: "ready",
        revision: settings.revision,
        folders: settings.computer.workspaces.map(
          ({ workspaceId, label, root }) => ({ workspaceId, label, root }),
        ),
        computer: "starting",
        archive: "starting",
      };
      return settings;
    } catch {
      return null;
    }
  })();
  const initialization = (async () => {
    const settings = await loaded;
    if (!settings || closing || withdrawn) return;
    try {
      core = await ports.start(settings);
      await assertCurrent();
      if (closing) return;
      ready(core.folderReadsAvailable);
      observeCore();
    } catch (error) {
      unavailable();
      if (!(error instanceof BridgeError) || error.state === "unknown")
        cleanupFailure = error;
      try {
        await closeCore();
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
      await loaded;
      if (!closing && !withdrawn) {
        try {
          await assertCurrent();
        } catch {
          /* Keep only the unavailable projection. */
        }
      }
      observeCore();
      return closing ? { status: "closing" } : structuredClone(view);
    },
    read: async (input: unknown): Promise<RecoveryReadResult> => {
      const parsed = RecoveryReadRequestSchema.safeParse(input);
      if (!parsed.success) return { status: "refused" };
      await initialization;
      observeCore();
      if (closing || withdrawn || readBusy || !core || view.status !== "ready")
        return { status: "unavailable" };
      const request = parsed.data;
      const surface =
        request.kind === "archive-list" || request.kind === "archive-read"
          ? "archive"
          : "computer";
      if (view[surface] !== "available") return { status: "unavailable" };
      if (request.kind === "list" || request.kind === "metadata") {
        if (
          !view.folders.some(
            (folder) => folder.workspaceId === request.workspaceId,
          )
        )
          return { status: "refused" };
      } else if (request.kind === "archive-list") {
        if (
          request.after !== archiveNext ||
          (archiveLoaded && archiveNext === "")
        )
          return { status: "refused" };
      } else if (request.kind === "archive-read") {
        const selected = entries.get(request.key);
        if (!selected || selected.digest !== request.digest)
          return { status: "refused" };
      }
      readBusy = true;
      try {
        await assertCurrent();
        if (closing) return { status: "unavailable" };
        let result: RecoveryReadResult;
        if (request.kind === "archive-list") {
          const page = await core.archiveList(request.after);
          result = RecoveryReadResultSchema.parse({
            status: "ok",
            data: { kind: request.kind, after: request.after, ...page },
          });
          if (result.status !== "ok" || result.data.kind !== "archive-list")
            throw Error("crossed_archive_page");
          let previous = request.after;
          for (const entry of result.data.entries) {
            if (entry.key <= previous || entries.has(entry.key))
              throw Error("crossed_archive_page");
            previous = entry.key;
          }
          if (
            result.data.next !== "" &&
            (result.data.entries.length !== 32 || result.data.next !== previous)
          )
            throw Error("crossed_archive_cursor");
        } else if (request.kind === "archive-read") {
          const selected = entries.get(request.key)!;
          const reply = await core.archiveRead(request.key, request.digest);
          if (closing) return { status: "unavailable" };
          result = RecoveryReadResultSchema.parse({
            status: "ok",
            data: { kind: request.kind, ...reply },
          });
          if (result.status !== "ok" || result.data.kind !== "archive-read")
            throw Error("crossed_archive_reply");
          const actual = result.data.summary;
          if (
            (Object.keys(selected) as (keyof RecoveryArchiveEntry)[]).some(
              (key) => selected[key] !== actual[key],
            ) ||
            new TextEncoder().encode(result.data.text).length !== actual.bytes
          )
            throw Error("crossed_archive_reply");
        } else {
          const data =
            request.kind === "list"
              ? await core.list(request.workspaceId, request.relativePath)
              : await core.snapshot(request.workspaceId, request.relativePath);
          if (request.kind === "list" && "entries" in data)
            result = RecoveryReadResultSchema.parse({
              status: "ok",
              data: {
                kind: request.kind,
                relativePath: request.relativePath,
                entries: [...data.entries],
                truncated: data.truncated,
              },
            });
          else if (request.kind === "metadata" && "sha256" in data)
            result = RecoveryReadResultSchema.parse({
              status: "ok",
              data: {
                kind: request.kind,
                relativePath: request.relativePath,
                bytes: data.bytes,
                sha256: data.sha256,
              },
            });
          else throw Error("crossed_recovery_result");
        }
        await assertCurrent();
        observeCore();
        if (closing || view[surface] !== "available")
          return { status: "unavailable" };
        if (result.status === "ok" && result.data.kind === "archive-list") {
          for (const entry of result.data.entries)
            entries.set(entry.key, structuredClone(entry));
          archiveLoaded = true;
          archiveNext = result.data.next;
        }
        return result;
      } catch (error) {
        const status =
          error instanceof BridgeError
            ? error.state === "unsupported"
              ? "unavailable"
              : error.state
            : "unknown";
        if (status === "unknown" || status === "unavailable")
          unavailable(surface);
        observeCore();
        return { status };
      } finally {
        readBusy = false;
      }
    },
    // Memoized facts from this original read-only child. This closes admission
    // to UI reads; it grants no predecessor settlement or writable handoff.
    closeAndObserve: () => {
      if (!terminalResult) {
        closing = true;
        entries.clear();
        terminalResult = (async () => {
          await initialization;
          // Initialization already awaited cleanup and retained all causes.
          if (cleanupFailure !== undefined) throw cleanupFailure;
          return closeCoreAndObserve();
        })();
      }
      return terminalResult;
    },
    close: () => {
      if (!closeResult) {
        closing = true;
        entries.clear();
        closeResult = (async () => {
          await initialization;
          if (cleanupFailure !== undefined) throw cleanupFailure;
          await closeCore();
        })();
      }
      return closeResult;
    },
  });
}
