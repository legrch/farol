import { useEffect, useRef, useSyncExternalStore } from "react";
import type { RendererFacade, Intent } from "../../../src/ui/renderer/contract";
import { commandAllowed } from "../../../src/ui/renderer/command-eligibility";
import { chatGptPreSubmitRemedy } from "../../../src/ui/chatgpt-pre-submit-remedy";

type State = Readonly<{
  phase: "idle" | "preparing" | "testing" | "done" | "refused" | "unknown";
  code: string | null;
  operationId: string | null;
}>;
const idle: State = { phase: "idle", code: null, operationId: null };
const owners = new WeakMap<
  RendererFacade,
  {
    state: State;
    running: boolean;
    listeners: Set<() => void>;
  }
>();
function owner(facade: RendererFacade) {
  let value = owners.get(facade);
  if (!value) {
    value = { state: idle, running: false, listeners: new Set() };
    owners.set(facade, value);
  }
  return value;
}
const text = (state: State): string => {
  if (state.phase === "preparing" || state.phase === "testing")
    return "Testing once in a temporary ChatGPT chat…";
  if (state.phase === "done")
    return "The original connection test was confirmed. Current status is shown separately.";
  if (state.phase === "unknown")
    return "This original test has an unconfirmed outcome. It will not be sent again; review the original attempt.";
  if (state.phase === "refused") {
    if (state.code === "CONNECTION_CHECK_PENDING")
      return "An earlier connection check is unresolved. It was not repeated.";
    if (state.code === "CONNECTION_CHECK_ALREADY_ATTEMPTED")
      return "This challenge already has an attempt. Its original outcome was not changed or retried.";
    return (
      chatGptPreSubmitRemedy(state.code) ??
      "The check stopped before Send. Review the current page, selected app and connector; no repair was attempted."
    );
  }
  return "";
};

/** Presentation only. Both controls issue the SAME explicit original command.
 * Main and Go select/validate bootstrap or fresh status. An attachment, previous
 * setup completion, local health or a renderer result cannot authorize Send. */
export async function runExplicitConnectionTest(
  facade: RendererFacade,
): Promise<Intent> {
  const active = owner(facade);
  const id = "connection-test";
  if (active.running)
    return { id, state: "refused", code: "CONNECTION_TEST_IN_PROGRESS" };
  if (active.state.phase === "unknown")
    return {
      id: active.state.operationId
        ? `connection-test:run:${active.state.operationId}`
        : id,
      state: "unknown",
      code: "CONNECTION_CHECK_OUTCOME_UNKNOWN",
    };
  const publish = (state: State) => {
    active.state = state;
    for (const listener of active.listeners) listener();
  };
  const snapshot = facade.getSnapshot();
  if (!commandAllowed(snapshot, "connector.test-connection")) {
    publish({
      phase: "refused",
      code: "CONNECTION_CHECK_PREREQUISITES_REQUIRED",
      operationId: null,
    });
    return {
      id,
      state: "refused",
      code: "CONNECTION_CHECK_PREREQUISITES_REQUIRED",
    };
  }
  active.running = true;
  const operationId = crypto.randomUUID();
  const intentId = `connection-test:run:${operationId}`;
  publish({ phase: "preparing", code: null, operationId });
  try {
    const result = await facade.configure(
      {
        kind: "connector.test-connection",
        operationId,
        taskId:
          snapshot.destination.area === "chatgpt"
            ? snapshot.destination.taskId
            : "",
      },
      intentId,
    );
    const uncertain =
      result.state === "unknown" ||
      result.state === "pending" ||
      result.code === "CONNECTION_CHECK_OUTCOME_UNKNOWN" ||
      result.code === "SETTINGS_WRITE_FAILED";
    publish({
      phase: uncertain
        ? "unknown"
        : result.state === "applied"
          ? "done"
          : "refused",
      code: result.code ?? null,
      operationId,
    });
    return uncertain && result.state !== "unknown"
      ? { ...result, state: "unknown" }
      : result;
  } catch {
    publish({
      phase: "unknown",
      code: "CONNECTION_CHECK_OUTCOME_UNKNOWN",
      operationId,
    });
    return {
      id: intentId,
      state: "unknown",
      code: "CONNECTION_CHECK_OUTCOME_UNKNOWN",
    };
  } finally {
    active.running = false;
  }
}

// Keep exported caller names compatible, not their retired Deep Test/repair
// behavior. Neither path can silently reconnect, select another app, or retry.
export const runManualConnectionPrompt = runExplicitConnectionTest;
export const runFreshConnectionTest = runExplicitConnectionTest;

export function useConnectionTest(facade: RendererFacade) {
  const active = owner(facade);
  const state = useSyncExternalStore(
    (listener) => {
      active.listeners.add(listener);
      return () => active.listeners.delete(listener);
    },
    () => active.state,
    () => idle,
  );
  return {
    state,
    busy: state.phase === "preparing" || state.phase === "testing",
    message: text(state),
  };
}
export function ConnectionTestButton({
  facade,
  disabled = false,
  primary = false,
  toolbar = false,
  manualFeedback = "",
}: {
  facade: RendererFacade;
  disabled?: boolean;
  primary?: boolean;
  toolbar?: boolean;
  manualFeedback?: string;
}) {
  const test = useConnectionTest(facade);
  const snapshot = facade.getSnapshot();
  const arrow = useRef<HTMLButtonElement>(null);
  const previousOverlay = useRef(snapshot.overlay);
  const menuOpen = toolbar && snapshot.overlay === "connection-tests";
  useEffect(() => {
    if (
      toolbar &&
      snapshot.overlay === "none" &&
      (previousOverlay.current === "connection-tests" ||
        previousOverlay.current === "deep-test")
    )
      arrow.current?.focus();
    previousOverlay.current = snapshot.overlay;
  }, [snapshot.overlay, toolbar]);
  return (
    <div
      className="connection-test-control"
      data-toolbar={toolbar || undefined}
    >
      {toolbar && test.message && (
        <span role="status" className="connection-test-feedback">
          {test.message}
        </span>
      )}
      {toolbar && manualFeedback && (
        <span role="status" className="connection-test-feedback">
          {manualFeedback}
        </span>
      )}
      <button
        className={primary ? "primary" : undefined}
        title="Send one connection test in a temporary ChatGPT chat"
        disabled={
          disabled ||
          test.busy ||
          test.state.phase === "unknown" ||
          !commandAllowed(snapshot, "connector.test-connection")
        }
        onClick={() => void runExplicitConnectionTest(facade)}
      >
        {test.busy
          ? "Testing…"
          : toolbar
            ? "Test connection"
            : "Test in ChatGPT"}
      </button>
      {toolbar && (
        <button
          ref={arrow}
          type="button"
          className="connection-test-menu-trigger"
          aria-label="More connection tests"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          disabled={disabled}
          onClick={() => facade.overlay(menuOpen ? "none" : "connection-tests")}
        >
          <span aria-hidden="true">▾</span>
        </button>
      )}
      {!toolbar && test.message && (
        <span role="status" className="connection-test-feedback">
          {test.message}
        </span>
      )}
    </div>
  );
}
