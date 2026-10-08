import type { WebContents } from "electron";

const reasons = new Set([
  "clean-exit",
  "abnormal-exit",
  "killed",
  "crashed",
  "oom",
  "launch-failed",
  "integrity-failure",
]);

/** Mechanical, content-free diagnostics. Observation does not establish readiness. */
export function observeRendererLifecycle(
  contents: Pick<WebContents, "on" | "getOSProcessId">,
  buildId: string,
  write: (line: string) => void,
): void {
  // The existing build owner validates admission before window creation. An
  // unusable diagnostic identity emits no records and adds no startup guard.
  if (!/^[a-f0-9]{64}$/u.test(buildId)) return;
  const integer = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) ? value : null;
  const emit = (
    event: string,
    details: Record<string, string | number | boolean | null> = {},
  ) => {
    let rendererPid: number | null = null;
    try {
      rendererPid = integer(contents.getOSProcessId());
    } catch {
      /* A destroyed renderer has no current process observation. */
    }
    try {
      write(
        `FAROL_RENDERER_OBSERVATION:${JSON.stringify({ schema: 1, buildId, event, rendererPid: rendererPid !== null && rendererPid > 0 ? rendererPid : null, ...details })}\n`,
      );
    } catch {
      /* A failed diagnostic sink must not change renderer lifecycle. */
    }
  };
  contents.on("did-finish-load", () => emit("load-finished"));
  contents.on(
    "did-fail-load",
    (_event, errorCode, _description, _url, isMainFrame) =>
      emit("load-failed", {
        errorCode: integer(errorCode),
        mainFrame: typeof isMainFrame === "boolean" ? isMainFrame : null,
      }),
  );
  contents.on("preload-error", () => emit("preload-failed"));
  contents.on("render-process-gone", (_event, details) =>
    emit("process-gone", {
      reason: reasons.has(details.reason) ? details.reason : "unclassified",
      exitCode: integer(details.exitCode),
    }),
  );
}
