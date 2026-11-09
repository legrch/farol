import { useEffect, useRef, useSyncExternalStore } from "react";
import type { RendererFacade, Intent } from "../../../src/ui/renderer/contract";
import { commandAllowed } from "../../../src/ui/renderer/command-eligibility";
import { computerSetup } from "../../../src/ui/renderer/computer-setup";
import { SeparateAppVerificationScopeSchema } from "../../../src/pkg/product-settings/contract";
import { connectorWorkspaceSelection } from "../../../src/pkg/product-settings/connector-workspace-selection";
import { chatGptPreSubmitRemedy } from "../../../src/ui/chatgpt-pre-submit-remedy";

type State = Readonly<{
  phase: "idle" | "preparing" | "testing" | "done" | "refused" | "unknown";
  code: string | null;
  manual?: boolean;
}>;
const idle: State = { phase: "idle", code: null };
const owners = new WeakMap<
  RendererFacade,
  { state: State; running: boolean; listeners: Set<() => void> }
>();
function owner(facade: RendererFacade) {
  let value = owners.get(facade);
  if (!value) {
    value = { state: idle, running: false, listeners: new Set() };
    owners.set(facade, value);
  }
  return value;
}
/**
 * These codes are pre-dispatch only in runManualDeepTest/runReadonlyTask with
 * manualSubmissionOnly. Do not put them in the shared remedy: a read-only task
 * observer can report some of the same codes *after* an earlier Send.
 */
function manualBeforeSendRemedy(code: string | null): string | null {
  if (code === "CHATGPT_SIGN_IN_REQUIRED")
    return "The current ChatGPT page needs sign-in. This manual check stopped before Send; review the original attempt in Activity.";
  if (code === "CHATGPT_UI_UNRECOGNIZED")
    return "Farol could not recognize the current ChatGPT controls before Send. Nothing was sent; inspect this page without guessing an app or model.";
  if (code === "CHATGPT_PAGE_UNREACHABLE")
    return "Farol could not reach the current ChatGPT page before Send. Nothing was sent; check the page and current connection status.";
  if (code === "CHATGPT_COMPOSER_UNAVAILABLE")
    return "Farol could not confirm a usable ChatGPT composer before Send. Nothing was sent; do not overwrite an existing draft.";
  if (code === "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT")
    return "ChatGPT navigated away before Send. Nothing was sent; inspect the current conversation before a new check.";
  if (code === "CHATGPT_SUBMIT_UNAVAILABLE")
    return "ChatGPT did not confirm an available Send action. This manual check stopped before Send; review Activity before another test.";
  return chatGptPreSubmitRemedy(code);
}

/** Presentation only: an applied host result can still contain a typed
 * failed-before-submit result. An unclassified code cannot prove Send or no Send.
 */
const text = (state: State) => {
  const knownBeforeSend =
    state.phase === "done" || state.phase === "refused"
      ? state.manual
        ? manualBeforeSendRemedy(state.code)
        : chatGptPreSubmitRemedy(state.code)
      : null;
  if (state.manual) {
    if (state.phase === "preparing" || state.phase === "testing")
      return "Preparing connection test…";
    if (state.phase === "unknown")
      return "Could not confirm whether the request was sent. Review the original attempt in Activity and ChatGPT before another test.";
    if (knownBeforeSend) return knownBeforeSend;
    if (state.phase === "done")
      return state.code === null
        ? "Send requested. View ChatGPT; this is not yet connection verification."
        : "The result was recorded, but Send was not confirmed. Review the original attempt in Activity before another test.";
    if (state.phase === "refused")
      return state.code === "CONNECTION_TEST_PREREQUISITES_REQUIRED"
        ? "This view cannot start a connection test. No request was made. Review the current connection status."
        : "The test was refused, but this status alone does not prove whether Send occurred. Review the original attempt in Activity before another test.";
    return "";
  }
  if (state.phase === "preparing") return "Preparing a new connection test…";
  if (state.phase === "testing")
    return "Testing in a new temporary ChatGPT chat…";
  if (state.phase === "done") return "ChatGPT confirmed this connection.";
  if (state.phase === "unknown")
    return "The test has no confirmed result. Its original record stays in Activity.";
  if (knownBeforeSend) return knownBeforeSend;
  if (state.phase === "refused")
    return "The check was refused. Review its original result in Activity and the current connection status.";
  return "";
};

export async function runManualConnectionPrompt(
  facade: RendererFacade,
): Promise<Intent> {
  const active = owner(facade),
    id = "connection-test";
  if (active.running)
    return { id, state: "refused", code: "CONNECTION_TEST_IN_PROGRESS" };
  const publish = (state: State) => {
    active.state = { ...state, manual: true };
    for (const listener of active.listeners) listener();
  };
  const snapshot = facade.getSnapshot();
  if (
    snapshot.destination.area !== "chatgpt" ||
    !commandAllowed(snapshot, "chatgpt.run-deep-test")
  ) {
    publish({
      phase: "refused",
      code: "CONNECTION_TEST_PREREQUISITES_REQUIRED",
    });
    return {
      id,
      state: "refused",
      code: "CONNECTION_TEST_PREREQUISITES_REQUIRED",
    };
  }
  active.running = true;
  publish({ phase: "preparing", code: null });
  const operationId = crypto.randomUUID();
  try {
    const result = await facade.configure(
      {
        kind: "chatgpt.run-deep-test",
        operationId,
        taskId: snapshot.destination.taskId,
        test: "connection",
      },
      `connection-test:run:${operationId}`,
    );
    publish({
      phase:
        result.state === "applied"
          ? "done"
          : result.state === "unknown" || result.state === "pending"
            ? "unknown"
            : "refused",
      code: result.code ?? null,
    });
    // Only the delivered click acknowledgement is acknowledged here. An
    // ambiguous Send stays retained for the user and is never repeated.
    if (result.state === "applied")
      void facade
        .configure(
          { kind: "chatgpt.ack-deep-test", operationId },
          `deep-test:ack:${operationId}`,
        )
        .catch(() => undefined);
    return result;
  } catch {
    publish({ phase: "unknown", code: "CHATGPT_CONVERSATION_UNCONFIRMED" });
    return { id, state: "unknown", code: "CHATGPT_CONVERSATION_UNCONFIRMED" };
  } finally {
    active.running = false;
  }
}

/** Check the live route without disturbing its proof. When recovery is needed,
 * prepare a distinct runtime through confirmed stop/start; never replay a claim. */
export async function runFreshConnectionTest(
  facade: RendererFacade,
): Promise<Intent> {
  const active = owner(facade),
    id = "connection-test";
  if (active.running)
    return { id, state: "refused", code: "CONNECTION_TEST_IN_PROGRESS" };
  const publish = (state: State) => {
    active.state = state;
    for (const listener of active.listeners) listener();
  };
  const finish = (result: Intent) => {
    publish({
      phase:
        result.state === "applied"
          ? "done"
          : result.state === "unknown" || result.state === "pending"
            ? "unknown"
            : "refused",
      code: result.code ?? null,
    });
    return result;
  };
  const initial = facade.getSnapshot();
  if (
    initial.configuration?.status !== "ready" ||
    !commandAllowed(initial, "connector.repair") ||
    !computerSetup(initial).canReconnect
  )
    return finish({
      id,
      state: "refused",
      code: "CONNECTION_TEST_PREREQUISITES_REQUIRED",
    });
  const before = initial.configuration.settings;
  if (!before.connectors.secureMcp.chatgptApp)
    return finish({
      id,
      state: "refused",
      code: "CONNECTOR_CHATGPT_APP_REQUIRED",
    });
  if (
    before.connectors.secureMcp.chatgptApp.tunnelId !==
    before.connectors.secureMcp.tunnelId
  )
    return finish({
      id,
      state: "refused",
      code: "CONNECTOR_APP_TARGET_REQUIRED",
    });
  active.running = true;
  publish({ phase: "preparing", code: null });
  try {
    // A healthy live route gets a read-only status check. Restarting it would
    // discard its valid proof, interrupt tools and make the check itself break
    // the connection it is supposed to observe.
    const live = before.connectors.secureMcp;
    if (
      computerSetup(initial).localConnectionCurrent &&
      !live.appVerificationPending &&
      !before.setup.connect.outcomeUnknown &&
      live.chatgptApp!.connectorGeneration === live.generation &&
      commandAllowed(initial, "connector.verify-app")
    ) {
      publish({ phase: "testing", code: null });
      const key = (crypto.randomUUID() + crypto.randomUUID()).replaceAll(
        "-",
        "",
      );
      return finish(
        await facade.configure(
          { kind: "connector.verify-app" },
          `settings:connector.verify-app:${key}`,
        ),
      );
    }
    const repaired = await facade.configure(
      { kind: "connector.repair" },
      "settings:connector.repair:",
    );
    if (repaired.state !== "applied") return finish(repaired);
    let current = facade.getSnapshot();
    if (
      current.status !== "current" ||
      current.runtime !== "ready" ||
      current.buildId !== initial.buildId ||
      current.destination !== initial.destination ||
      current.configuration?.status !== "ready"
    )
      return finish({
        id,
        state: "refused",
        code: "CONNECTION_TEST_STATE_CHANGED",
      });
    let settings = current.configuration.settings,
      connector = settings.connectors.secureMcp;
    if (
      settings.computer.computerId !== before.computer.computerId ||
      settings.computer.generation !== before.computer.generation ||
      connector.tunnelId !== before.connectors.secureMcp.tunnelId ||
      connector.chatgptApp?.name !==
        before.connectors.secureMcp.chatgptApp.name ||
      connector.runtime?.state !== "ready" ||
      connector.runtime.connectorGeneration !== connector.generation ||
      connector.runtime.computerGeneration !== settings.computer.generation ||
      connector.runtime.buildId !== current.buildId ||
      !connector.challenge ||
      connector.challenge.runtimeGeneration !==
        connector.runtime.runtimeGeneration ||
      connector.challenge.computerGeneration !== settings.computer.generation ||
      connector.challenge.buildId !== current.buildId ||
      connector.challenge.challengeSha256 ===
        before.connectors.secureMcp.challenge?.challengeSha256 ||
      connector.runtime?.runtimeGeneration ===
        before.connectors.secureMcp.runtime?.runtimeGeneration
    )
      return finish({
        id,
        state: "refused",
        code: "CONNECTION_TEST_FRESH_BINDING_REQUIRED",
      });
    // A verified restart can advance the connector generation while retaining
    // the owner's app label. Rebind that same selection only to the same
    // tunnel; it remains a routing choice, not an attachment receipt.
    if (connector.chatgptApp?.tunnelId !== connector.tunnelId)
      return finish({
        id,
        state: "refused",
        code: "CONNECTOR_APP_TARGET_REQUIRED",
      });
    if (connector.chatgptApp.connectorGeneration !== connector.generation) {
      if (!commandAllowed(current, "connector.select-chatgpt-app"))
        return finish({
          id,
          state: "refused",
          code: "CONNECTOR_APP_TARGET_REQUIRED",
        });
      const expected = {
        name: connector.chatgptApp.name,
        tunnelId: connector.tunnelId!,
        connectorGeneration: connector.generation,
        runtimeGeneration: connector.runtime!.runtimeGeneration,
        challengeSha256: connector.challenge!.challengeSha256,
      };
      const selected = await facade.configure(
        {
          kind: "connector.select-chatgpt-app",
          name: expected.name,
          tunnelId: expected.tunnelId,
          connectorGeneration: expected.connectorGeneration,
        },
        "settings:connector.select-chatgpt-app:",
      );
      if (selected.state !== "applied") return finish(selected);
      current = facade.getSnapshot();
      if (
        current.status !== "current" ||
        current.runtime !== "ready" ||
        current.buildId !== initial.buildId ||
        current.destination !== initial.destination ||
        current.configuration?.status !== "ready"
      )
        return finish({
          id,
          state: "refused",
          code: "CONNECTION_TEST_STATE_CHANGED",
        });
      settings = current.configuration.settings;
      connector = settings.connectors.secureMcp;
      if (
        settings.computer.computerId !== before.computer.computerId ||
        settings.computer.generation !== before.computer.generation ||
        connector.tunnelId !== expected.tunnelId ||
        connector.generation !== expected.connectorGeneration ||
        connector.runtime?.runtimeGeneration !== expected.runtimeGeneration ||
        connector.challenge?.challengeSha256 !== expected.challengeSha256 ||
        connector.chatgptApp?.name !== expected.name ||
        connector.chatgptApp.tunnelId !== expected.tunnelId ||
        connector.chatgptApp.connectorGeneration !==
          expected.connectorGeneration
      )
        return finish({
          id,
          state: "refused",
          code: "CONNECTION_TEST_STATE_CHANGED",
        });
    }
    const separate =
      connector.appVerificationPending && settings.setup.connect.outcomeUnknown;
    const setup = computerSetup(current);
    if (
      separate
        ? !setup.canVerifySeparateEmbeddedApp
        : !setup.canVerifyEmbeddedApp
    )
      return finish({
        id,
        state: "refused",
        code: "CONNECTION_TEST_PREREQUISITES_REQUIRED",
      });
    const expected = SeparateAppVerificationScopeSchema.safeParse({
      ownerAuthorized: true,
      appName: connector.chatgptApp.name,
      tunnelId: connector.tunnelId,
      connectorGeneration: connector.generation,
      computerGeneration: settings.computer.generation,
      runtimeGeneration: connector.runtime?.runtimeGeneration,
      buildId: current.buildId,
      challengeSha256: connector.challenge.challengeSha256,
      workspaceId: connectorWorkspaceSelection(settings),
    });
    if (separate && !expected.success)
      return finish({
        id,
        state: "refused",
        code: "CONNECTION_TEST_STATE_CHANGED",
      });
    // The separate command still obtains real native confirmation in main.
    const command =
      separate && expected.success
        ? {
            kind: "connector.verify-separate-app" as const,
            expected: expected.data,
          }
        : { kind: "connector.verify-app" as const };
    if (!commandAllowed(current, command.kind))
      return finish({
        id,
        state: "refused",
        code: "CONNECTION_TEST_PREREQUISITES_REQUIRED",
      });
    publish({ phase: "testing", code: null });
    const intention = `settings:${command.kind}:${connector.challenge.challengeSha256}`,
      pending = facade.configure(command, intention);
    if (facade.getSnapshot().intents[intention]?.state === "pending")
      facade.navigate({
        area: "chatgpt",
        taskId: "",
        ...(initial.destination.area === "setup"
          ? { connectionCheckReturn: true as const }
          : {}),
      });
    return finish(await pending);
  } catch {
    return finish({
      id,
      state: "unknown",
      code: "CONNECTION_TEST_OUTCOME_UNKNOWN",
    });
  } finally {
    active.running = false;
  }
}
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
  const test = useConnectionTest(facade),
    snapshot = facade.getSnapshot();
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
  const allowed = toolbar
    ? commandAllowed(snapshot, "chatgpt.run-deep-test")
    : commandAllowed(snapshot, "connector.repair") &&
      computerSetup(snapshot).canReconnect;
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
        title={
          toolbar
            ? "Send a connection test in this ChatGPT chat"
            : "Send one new connection test in a temporary ChatGPT chat"
        }
        disabled={disabled || test.busy || !allowed}
        onClick={() =>
          void (toolbar
            ? runManualConnectionPrompt(facade)
            : runFreshConnectionTest(facade))
        }
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
