import { useSyncExternalStore } from "react";
import type { RendererFacade, Intent } from "../../../src/ui/renderer/contract";
import { commandAllowed } from "../../../src/ui/renderer/command-eligibility";
import { computerSetup } from "../../../src/ui/renderer/computer-setup";
import { SeparateAppVerificationScopeSchema } from "../../../src/pkg/product-settings/contract";
import { connectorWorkspaceSelection } from "../../../src/pkg/product-settings/connector-workspace-selection";

type State = Readonly<{
  phase: "idle" | "preparing" | "testing" | "done" | "refused" | "unknown";
  code: string | null;
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
const text = (state: State) =>
  state.phase === "preparing"
    ? "Preparing a new connection test…"
    : state.phase === "testing"
      ? "Testing in a new temporary ChatGPT chat…"
      : state.phase === "done"
        ? "ChatGPT confirmed this connection."
        : state.phase === "unknown"
          ? "The test has no confirmed result. Its original record stays in Activity."
          : state.code === "CHATGPT_COMPOSER_DRAFT_PRESENT"
            ? "Finish or clear the current draft before testing. Nothing was sent."
            : state.code === "CONNECTOR_APP_VERIFICATION_NOT_READY"
              ? "Check sign-in and connection in Setup."
              : state.phase === "refused"
                ? "The check didn’t finish. Review the connection in Setup."
                : "";

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
}: {
  facade: RendererFacade;
  disabled?: boolean;
  primary?: boolean;
  toolbar?: boolean;
}) {
  const test = useConnectionTest(facade),
    snapshot = facade.getSnapshot();
  const allowed =
    commandAllowed(snapshot, "connector.repair") &&
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
      <button
        className={primary ? "primary" : undefined}
        title="Send one new connection test in a temporary ChatGPT chat"
        disabled={disabled || test.busy || !allowed}
        onClick={() => void runFreshConnectionTest(facade)}
      >
        {test.busy ? "Testing…" : "Test in ChatGPT"}
      </button>
      {!toolbar && test.message && (
        <span role="status" className="connection-test-feedback">
          {test.message}
        </span>
      )}
    </div>
  );
}
