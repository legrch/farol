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
        : state.code === "CHATGPT_COMPOSER_DRAFT_PRESENT"
          ? "Finish or clear the current draft before testing. Nothing was sent."
          : state.phase === "unknown"
            ? "The test has no confirmed result. Its original record stays in Activity."
            : state.phase === "refused"
              ? `The connection test needs attention. ${state.code ?? "Review the connection in Setup."}`
              : "";

/** One explicit click prepares a distinct runtime/challenge via the existing
 * confirmed stop/start. No old claim is reset, replayed or treated as consent. */
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
  active.running = true;
  publish({ phase: "preparing", code: null });
  try {
    const repaired = await facade.configure(
      { kind: "connector.repair" },
      "settings:connector.repair:",
    );
    if (repaired.state !== "applied") return finish(repaired);
    const current = facade.getSnapshot();
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
    const settings = current.configuration.settings,
      connector = settings.connectors.secureMcp;
    if (
      settings.computer.computerId !== before.computer.computerId ||
      settings.computer.generation !== before.computer.generation ||
      connector.tunnelId !== before.connectors.secureMcp.tunnelId ||
      connector.chatgptApp?.name !==
        before.connectors.secureMcp.chatgptApp.name ||
      !connector.challenge ||
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
}: {
  facade: RendererFacade;
  disabled?: boolean;
}) {
  const test = useConnectionTest(facade),
    snapshot = facade.getSnapshot();
  const allowed =
    commandAllowed(snapshot, "connector.repair") &&
    computerSetup(snapshot).canReconnect;
  return (
    <div className="connection-test-control">
      <button
        title="Send one new connection test in a temporary ChatGPT chat"
        disabled={disabled || test.busy || !allowed}
        onClick={() => void runFreshConnectionTest(facade)}
      >
        {test.busy ? "Testing…" : "Test in ChatGPT"}
      </button>
      {test.message && (
        <span role="status" className="connection-test-feedback">
          {test.message}
        </span>
      )}
    </div>
  );
}
