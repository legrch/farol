import { connectionPresentation } from "../../../apps/desktop/renderer/connection-presentation";
import { unresolvedActions } from "../../../apps/desktop/renderer/unresolved-actions";
import { setupStepCheck } from "./setup-gate";
import { SetupWalkthrough } from "../../../apps/desktop/renderer/setup-walkthrough";
import { useEffect, useRef, useState } from "react";
import {
  ProductConfigurationCommandSchema,
  type ProductSettings,
} from "../../pkg/product-settings/contract";
import { signInPresentation } from "./sign-in-presentation";
import { computerSetup } from "./computer-setup";
import { commandAllowed, dependencyFences } from "./command-eligibility";
import {
  actionFeedback,
  feedbackPage,
  intention,
  retainedSetupIntents,
  settledEdit,
  useSettingsFeedback,
  useSetupIntents,
  useSettingsAttention,
  type FeedbackPage,
} from "../../../apps/desktop/renderer/intents";
export { retainedSetupIntents, useSetupIntents, useSettingsAttention };
import type { Intent, WindowSnapshot } from "./contract";
import { AddToChatGPT } from "../../../apps/desktop/renderer/connect";
import { General } from "../../../apps/desktop/renderer/general";
import { AppearancePage } from "../../../apps/desktop/renderer/appearance";
import { Shortcuts } from "../../../apps/desktop/renderer/shortcuts";
import {
  Folders,
  folderSetupByWindow,
} from "../../../apps/desktop/renderer/folders";
import {
  Group,
  Command,
  type Actions,
  type PageProps,
  type SettingsProps,
} from "../../../apps/desktop/renderer/page";
export type { SettingsProps };

/** Presentation only: mounting, observation and background updates never save. */
export function Settings({
  snapshot,
  facade,
  setupStep,
  setupInputsChanged,
  onSetupInputsChange,
  setupTestActionHost,
  unresolvedSheet,
}: SettingsProps) {
  const configuration = snapshot.configuration;
  const [lastReady, setLastReady] = useState<ProductSettings | null>(() =>
    configuration?.status === "ready" ? configuration.settings : null,
  );
  useEffect(() => {
    if (configuration?.status === "ready") setLastReady(configuration.settings);
  }, [configuration]);
  // Cached presentation preserves mounted drafts only. Command eligibility
  // always uses the actual snapshot, including unavailable configuration.
  const displayedSettings =
    configuration?.status === "ready" ? configuration.settings : lastReady;
  const feedback = useSettingsFeedback(facade);
  const composing = useRef(false);
  const refreshOwner = useRef({ mounted: true, generation: 0 });
  useEffect(() => {
    const owner = refreshOwner.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.generation++;
    };
  }, []);
  const retained = (current: WindowSnapshot) =>
    Object.values(feedback.intents).map(
      (intent) => settledEdit(intent, current) ?? intent,
    );
  const exportAllowed = (current: WindowSnapshot) =>
    Boolean(
      unresolvedSheet &&
      current.status === "current" &&
      current.runtime === "ready" &&
      current.buildId &&
      current.configuration?.status === "ready" &&
      ![...Object.values(current.intents), ...retained(current)].some(
        (intent) =>
          intent.id === intention("support.export") &&
          (intent.state === "pending" || intent.state === "unknown"),
      ),
    );
  const allowed: Actions["allowed"] = (kind, workspaceId) =>
    kind === "support.export" && unresolvedSheet
      ? exportAllowed(snapshot)
      : !feedback.unretained &&
        commandAllowed(snapshot, kind, workspaceId, retained(snapshot));
  const computerFences = dependencyFences(
    snapshot,
    "computer",
    retained(snapshot),
  );
  const computerPauseReason =
    feedback.unretained || computerFences.unknown
      ? "The last action could not be confirmed. Refresh its saved result before continuing; do not repeat it."
      : computerFences.pending
        ? "Wait for the current check to finish."
        : snapshot.status !== "current" ||
            snapshot.runtime !== "ready" ||
            !snapshot.buildId ||
            configuration?.status !== "ready"
          ? "Farol could not read the current status. Refresh it before continuing."
          : null;
  const actions: Actions = {
    async refresh() {
      const owner = refreshOwner.current;
      const generation = ++owner.generation;
      const destination = facade.getSnapshot().destination;
      const flow = folderSetupByWindow.get(facade);
      const pending = flow?.access.pendingReadback();
      if (
        !flow ||
        !pending ||
        !facade.refreshReadback ||
        !facade.reconcileWorkspaceReadback
      ) {
        await facade.refresh();
        if (setupStep === "signin") {
          facade.refreshSignInStatus?.();
        } else if (
          setupStep === "attachment" &&
          facade.getSnapshot().destination === destination &&
          actions.allowed("connector.check-attachment")
        ) {
          // Read the existing Go receipt; this command never creates a
          // challenge or opens/sends a ChatGPT test.
          return actions.run({ kind: "connector.check-attachment" });
        }
        return null;
      }
      const receipt = await facade.refreshReadback();
      if (
        !owner.mounted ||
        owner.generation !== generation ||
        facade.getSnapshot().destination !== destination ||
        receipt.status !== "adopted" ||
        flow.access.pendingReadback() !== pending
      )
        return null;
      const id = intention(
        pending.command.kind,
        "workspaceId" in pending.command
          ? pending.command.workspaceId
          : undefined,
      );
      const resolved = facade.reconcileWorkspaceReadback(receipt, id, pending);
      if (!resolved) return null;
      if (
        flow.access.reconcileReadback(
          receipt.configuration.settings,
          receipt.buildId,
        )
      ) {
        feedback.intents[id] = resolved;
        for (const [page, entry] of Object.entries(feedback.pages)) {
          if (entry?.result?.id === id && entry.result.state === "unknown")
            feedback.pages[page as FeedbackPage] = {
              ...entry,
              result: resolved,
              text: actionFeedback(resolved),
            };
        }
        feedback.changed();
      }
      return resolved;
    },
    disabled: !allowed("general.update"),
    computerPauseReason,
    allowed,
    async run(command, admit) {
      const outcome = await actions.runClassified(command, admit);
      return outcome.state === "attempted" ? outcome.result : null;
    },
    async runClassified(command, admit) {
      const current = facade.getSnapshot();
      const page = feedbackPage(current.destination);
      const request = {};
      const report = (text: string, result: Intent | null = null) => {
        // A late reply can update only its own page and request.
        if (feedback.pages[page]?.request !== request) return;
        feedback.pages[page] = {
          request,
          text,
          result,
          origin: current.destination,
        };
        feedback.changed();
      };
      const id = intention(
        command.kind,
        "workspaceId" in command
          ? command.workspaceId
          : "operationId" in command
            ? command.operationId
            : undefined,
      );
      if (
        composing.current ||
        !(command.kind === "support.export" && unresolvedSheet
          ? exportAllowed(current)
          : !feedback.unretained &&
            commandAllowed(
              current,
              command.kind,
              "workspaceId" in command ? command.workspaceId : undefined,
              retained(current),
            ))
      ) {
        feedback.pages[page] = {
          request,
          text: "",
          result: null,
          origin: current.destination,
        };
        report(
          "Action not sent. Current state or an unresolved operation prevents this change; refresh to observe the latest status.",
        );
        return { state: "not-sent" };
      }
      if (!ProductConfigurationCommandSchema.safeParse(command).success) {
        feedback.pages[page] = {
          request,
          text: "",
          result: null,
          origin: current.destination,
        };
        report(
          "Check the fields. Paths must be unique relative paths without dot segments; connection fields must match their required format.",
        );
        return { state: "not-sent" };
      }
      if (admit && !admit(current)) {
        feedback.pages[page] = {
          request,
          text: "",
          result: null,
          origin: current.destination,
        };
        report(
          "Action not sent. The workspace or connection changed after this page opened; review its current status before trying a new change.",
        );
        return { state: "not-sent" };
      }
      feedback.pages[page] = {
        request,
        text: "",
        result: null,
        origin: current.destination,
      };
      feedback.intents[id] = {
        id,
        state: "pending",
        code: null,
        inFlight: true,
      };
      report("Saving or checking…", feedback.intents[id]);
      try {
        const result = await facade.configure(command, id);
        // Keep every unresolved dependency, even when a newer independent
        // request owns the page message. Refresh/remount cannot settle it.
        feedback.intents[id] = result;
        report(
          command.kind === "onboarding.open-help" && result.state === "applied"
            ? "Opened in your default browser. Return to Farol to continue setup."
            : actionFeedback(result),
          result,
        );
        return { state: "attempted", result };
      } catch {
        // Keep a local fence too if an adapter throws before retaining its intent.
        feedback.unretained = true;
        feedback.intents[id] = { id, state: "unknown", code: null };
        report(
          "Outcome unknown. Do not repeat this action; inspect the existing result.",
          { id, state: "unknown", code: null },
        );
        return { state: "attempted", result: null };
      } finally {
        feedback.changed();
      }
    },
  };
  if (unresolvedSheet)
    return (
      <UnresolvedActionsContent
        snapshot={snapshot}
        facade={facade}
        actions={actions}
      />
    );
  if (!displayedSettings)
    return (
      <div className="settings-page">
        {!setupStep && <h2>Settings</h2>}
        <p className="notice">
          Settings are unavailable. Refresh the current state before making
          changes.
        </p>
        <button className="subtle" onClick={() => void actions.refresh()}>
          Refresh status
        </button>
      </div>
    );
  const props: PageProps = {
    snapshot,
    facade,
    settings: displayedSettings,
    actions,
    setupStep,
    setupInputsChanged,
    onSetupInputsChange,
    setupTestActionHost,
  };
  const pageFeedback = feedback.pages[feedbackPage(snapshot.destination)];
  const gate = setupStep
    ? setupStepCheck(
        snapshot,
        setupStep,
        setupInputsChanged &&
          (setupStep === "connection" || setupStep === "attachment"),
        retainedSetupIntents(facade, snapshot),
      )
    : null;
  return (
    <div
      className="settings-page"
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
      }}
    >
      {!setupStep && configuration?.status !== "ready" ? (
        <div className="notice" role="status">
          <p>Farol could not read the current settings.</p>
          <button
            type="button"
            className="text-button"
            onClick={() => void actions.refresh()}
          >
            Refresh status
          </button>
        </div>
      ) : null}
      {setupStep ? (
        <>
          {setupStep === "folders" ? (
            <Folders {...props} />
          ) : (
            <Connection {...props} />
          )}
          {gate && setupStep !== "attachment" && (
            <div
              className="setup-gate-status setup-result"
              role={gate.allowed ? "status" : "alert"}
              data-result-state={gate.state}
            >
              <strong>
                {gate.state === "success"
                  ? setupStep === "signin"
                    ? "✓ Sign-in checked"
                    : "Ready to continue"
                  : gate.state === "pending"
                    ? "Checking…"
                    : gate.state === "unknown"
                      ? "Check the last result"
                      : gate.state === "refused"
                        ? "This step needs attention"
                        : "Your next step"}
              </strong>
              <p>{gate.cause}</p>
              {gate.action && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    if (gate.action?.kind === "refresh") void actions.refresh();
                    else
                      void actions.run({
                        kind: "onboarding.open-help",
                        destination: gate.action?.destination ?? "setup-guide",
                      });
                  }}
                >
                  {gate.action.label}
                </button>
              )}
            </div>
          )}
          {gate?.actionError && (
            <div className="setup-result setup-action-error" role="alert">
              <p>{gate.actionError.cause}</p>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  void actions.run({
                    kind: "onboarding.open-help",
                    destination:
                      gate.actionError?.action.destination ?? "setup-guide",
                  })
                }
              >
                {gate.actionError.action.label}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {snapshot.destination.page === "appearance" ? (
            <AppearancePage {...props} />
          ) : snapshot.destination.page === "shortcuts" ? (
            <Shortcuts {...props} />
          ) : snapshot.destination.page === "general" ? (
            <General {...props} />
          ) : null}
          {pageFeedback && (
            <p className="description" role="status">
              {pageFeedback.text}
            </p>
          )}
        </>
      )}
    </div>
  );
}
function Connection(props: PageProps) {
  if (props.setupStep === "signin") return <SignInStep {...props} />;
  if (props.setupStep === "attachment") return <AddToChatGPT {...props} />;
  return <ConnectMac {...props} />;
}
function ConnectMac({
  settings,
  snapshot,
  facade,
  actions,
  onSetupInputsChange,
}: PageProps) {
  const connector = settings.connectors.secureMcp;
  const [tunnelId, setTunnelId] = useState(connector.tunnelId ?? "");
  const [key, setKey] = useState("");
  const savedTunnelId = useRef(connector.tunnelId ?? "");
  useEffect(() => {
    if (tunnelId === savedTunnelId.current && key.length === 0)
      setTunnelId(connector.tunnelId ?? "");
    savedTunnelId.current = connector.tunnelId ?? "";
  }, [connector.tunnelId, tunnelId, key]);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const composing = useRef(false);
  const feedback = useSettingsFeedback(facade);
  const result = feedback.pages["setup:connection"]?.result;
  const failed = result?.state === "refused" || result?.state === "unknown";
  const draftChanged =
    tunnelId !== (connector.tunnelId ?? "") || key.length > 0;
  useEffect(() => {
    onSetupInputsChange?.(draftChanged);
  }, [draftChanged, onSetupInputsChange]);
  const connected = setupStepCheck(
    snapshot,
    "connection",
    draftChanged,
    retainedSetupIntents(facade, snapshot),
  ).allowed;
  // The same live-tunnel light as the sidebar. A saved ready runtime stays
  // connected without a fresh server poll or a user Ping.
  const transportConnected = connectionPresentation(snapshot).connected;
  const valid =
    key.length > 0
      ? ProductConfigurationCommandSchema.safeParse({
          kind: "connector.configure",
          tunnelId,
          runtimeKey: key,
        }).success
      : connector.credential === "stored" && tunnelId === connector.tunnelId;
  const fieldError =
    !valid && (tunnelId.length > 0 || key.length > 0)
      ? !ProductConfigurationCommandSchema.safeParse({
          kind: "connector.configure",
          tunnelId,
          runtimeKey: null,
        }).success
        ? "Copy the complete tunnel ID from OpenAI Tunnels, without spaces."
        : key.length === 0
          ? "Paste the key shown when you created it in OpenAI."
          : "Paste the complete key without spaces or line breaks."
      : null;
  async function connect() {
    if (running.current || composing.current || !valid || connected) return;
    running.current = true;
    setBusy(true);
    const origin = facade.getSnapshot();
    const stillHere = () => {
      const latest = facade.getSnapshot();
      return (
        latest.destination === origin.destination &&
        latest.buildId === origin.buildId &&
        latest.configuration?.status === "ready" &&
        origin.configuration?.status === "ready" &&
        latest.configuration.settings.computer.computerId ===
          origin.configuration.settings.computer.computerId
      );
    };
    const secret = key;
    setKey("");
    try {
      let current = facade.getSnapshot();
      if (current.configuration?.status !== "ready") return;
      if (!current.configuration.settings.connectors.secureMcp.tunnelClient) {
        if (
          (await actions.run({ kind: "connector.discover-client" }))?.state !==
          "applied"
        )
          return;
        current = facade.getSnapshot();
        if (
          !stillHere() ||
          current.configuration?.status !== "ready" ||
          !current.configuration.settings.connectors.secureMcp.tunnelClient
        )
          return;
      }
      if (secret) {
        if (
          current.configuration.settings.connectors.secureMcp.runtime !==
            null &&
          (await actions.run({ kind: "connector.stop" }))?.state !== "applied"
        )
          return;
        if (!stillHere()) return;
        if (
          (
            await actions.run({
              kind: "connector.save-and-connect",
              operationId: crypto.randomUUID(),
              buildId: current.buildId ?? "",
              tunnelId,
              runtimeKey: secret,
            })
          )?.state !== "applied"
        )
          return;
      } else if (!computerSetup(current).localConnectionCurrent) {
        const kind =
          current.configuration.settings.connectors.secureMcp.runtime === null
            ? "connector.start"
            : "connector.repair";
        if ((await actions.run({ kind }))?.state !== "applied") return;
      }
      if (stillHere()) await actions.run({ kind: "connector.check-health" });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const helperMissing =
    Boolean(result?.id.includes("discover-client")) && !connector.tunnelClient;
  return (
    <>
      <section aria-label="Create a tunnel and a key">
        <h3>1. Create a tunnel and a key</h3>
        <SetupWalkthrough
          openLink={
            <Command
              className="text-button"
              actions={actions}
              command={{ kind: "onboarding.open-help", destination: "tunnels" }}
            >
              Open OpenAI Tunnels
            </Command>
          }
        />
      </section>
      <form
        className="connection-credentials"
        autoComplete="off"
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <label className="setting-row">
          Tunnel ID
          <input
            className="field"
            value={tunnelId}
            maxLength={160}
            onChange={(event) => {
              setTunnelId(event.currentTarget.value);
              onSetupInputsChange?.(
                event.currentTarget.value !== (connector.tunnelId ?? "") ||
                  key.length > 0,
              );
            }}
            required
            disabled={busy}
          />
        </label>
        <label className="setting-row">
          Key
          <input
            className="field"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={512}
            value={key}
            placeholder={
              connector.credential === "stored" ? "••••••••" : "Paste your key"
            }
            onChange={(event) => {
              setKey(event.currentTarget.value);
              onSetupInputsChange?.(
                event.currentTarget.value.length > 0 ||
                  tunnelId !== (connector.tunnelId ?? ""),
              );
            }}
            disabled={busy}
            aria-describedby="connection-key-hint"
          />
        </label>
        <p className="description connection-key-hint" id="connection-key-hint">
          {connector.credential === "stored"
            ? "Key saved on this Mac. Paste a new key only to replace it."
            : "Your key is saved privately on this Mac."}
        </p>
        <div className="connection-actions">
          {!connected && (
            <button
              className="primary"
              disabled={
                busy ||
                connected ||
                !valid ||
                !actions.allowed("connector.save-and-connect")
              }
            >
              {busy
                ? "Connecting…"
                : connected
                  ? transportConnected
                    ? "Connected"
                    : "Connection saved"
                  : draftChanged && connector.runtime !== null
                    ? "Save and connect"
                    : "Connect"}
            </button>
          )}
          {connected && (
            <span
              className={transportConnected ? "setup-success" : undefined}
              role="status"
            >
              {transportConnected ? "✓ Connected" : "Connection saved"}
            </span>
          )}
          {connector.runtime !== null && (
            <Command
              actions={actions}
              command={{ kind: "connector.stop" }}
              disabled={busy}
              admit={(current) =>
                current.configuration?.status === "ready" &&
                current.configuration.settings.connectors.secureMcp.runtime !==
                  null
              }
            >
              Disconnect
            </Command>
          )}
        </div>
      </form>
      {fieldError && (
        <p className="description" role="status">
          {fieldError}
        </p>
      )}

      {!connected && !failed && !helperMissing && !busy && (
        <p className="description">
          Enter your tunnel ID and key, then connect.
        </p>
      )}
    </>
  );
}
function SignInStep({ snapshot, facade, actions }: PageProps) {
  const signIn = signInPresentation(snapshot);
  const verified = setupStepCheck(
    snapshot,
    "signin",
    false,
    retainedSetupIntents(facade, snapshot),
  ).allowed;
  return (
    <section aria-label="ChatGPT sign-in">
      {verified ? null : (
        <>
          <p className="description">
            {signIn.pending
              ? "Checking sign-in…"
              : signIn.signedIn
                ? "You’re signed in. Check sign-in to continue."
                : "Sign in to your ChatGPT account, then return here."}
          </p>
          <Command
            actions={actions}
            className="primary"
            command={{
              kind: signIn.signedIn
                ? "chatgpt.verify"
                : signIn.unknown && !signIn.outcomeUnknown
                  ? "chatgpt.open-browser"
                  : "chatgpt.open-sign-in",
            }}
          >
            {signIn.signedIn
              ? "Check sign-in"
              : signIn.unknown && !signIn.outcomeUnknown
                ? "Open ChatGPT"
                : "Sign in"}
          </Command>
        </>
      )}
    </section>
  );
}
function WorkspaceEditResults({
  snapshot,
  settings,
  facade,
}: Omit<PageProps, "actions">) {
  const applyPrefix = intention("computer.apply-workspace-edit");
  const operations = new Set<string>();
  if (settings.computer.pendingEdit)
    operations.add(settings.computer.pendingEdit.operationId);
  if (snapshot.workspaceEditDelivery)
    operations.add(snapshot.workspaceEditDelivery);
  const unsettled = (intent: Intent | undefined) =>
    intent?.state === "pending" || intent?.state === "unknown";
  const stateLabel = (intent: Intent | undefined) =>
    !intent
      ? "Not observed in this window"
      : intent.state === "unknown"
        ? "Outcome unknown"
        : intent.state === "pending"
          ? "Checking…"
          : intent.state === "refused"
            ? "Refused"
            : "Confirmed";
  return [...operations].map((operationId) => {
    const applied = snapshot.intents[`${applyPrefix}${operationId}`];
    const observation = snapshot.intents[`observe:${operationId}`];
    const acknowledgement = snapshot.intents[`ack:${operationId}`];
    const awaitingDelivery = snapshot.workspaceEditDelivery === operationId;
    return (
      <Group title="Workspace edit result" key={operationId}>
        <p className="description">
          Operation: <code>{operationId}</code>
        </p>
        <p role="status">
          Edit submission: {stateLabel(applied)}.
          {applied?.code && (
            <>
              {" "}
              <code>{applied.code}</code>
            </>
          )}
        </p>
        {observation && (
          <p role="status">
            Observation: {stateLabel(observation)}.{" "}
            {observation.code && <code>{observation.code}</code>}
          </p>
        )}
        {acknowledgement && (
          <p role="status">
            Result acknowledgement: {stateLabel(acknowledgement)}.
            {acknowledgement.code && (
              <>
                {" "}
                <code>{acknowledgement.code}</code>
              </>
            )}
            {acknowledgement.state === "unknown" &&
              " Do not repeat acknowledgement; delivery is unconfirmed."}
            {acknowledgement.state === "applied" &&
              " Delivery recorded. This does not change the edit outcome."}
          </p>
        )}
        {settings.computer.pendingEdit?.operationId === operationId && (
          <>
            <p className="description">
              Observe this existing edit to retrieve its result without
              repeating the edit.
            </p>
            <button
              type="button"
              className="subtle"
              disabled={
                snapshot.status !== "current" ||
                unsettled(observation) ||
                acknowledgement?.state === "pending"
              }
              onClick={() => {
                const current = facade.getSnapshot();
                if (
                  current.status === "current" &&
                  current.configuration?.status === "ready" &&
                  current.configuration.settings.computer.pendingEdit
                    ?.operationId === operationId &&
                  !unsettled(current.intents[`observe:${operationId}`]) &&
                  current.intents[`ack:${operationId}`]?.state !== "pending"
                )
                  void facade.observeWorkspaceEdit(operationId);
              }}
            >
              Observe existing edit
            </button>
          </>
        )}
        {awaitingDelivery && (
          <>
            <p className="description">
              Review the result above, then record its delivery before preparing
              another edit.
            </p>
            <button
              type="button"
              className="subtle"
              disabled={
                snapshot.status !== "current" ||
                observation?.state === "pending" ||
                unsettled(acknowledgement)
              }
              onClick={() => {
                const current = facade.getSnapshot();
                if (
                  current.status === "current" &&
                  current.workspaceEditDelivery === operationId &&
                  current.intents[`observe:${operationId}`]?.state !==
                    "pending" &&
                  !unsettled(current.intents[`ack:${operationId}`])
                )
                  void facade.acknowledgeWorkspaceEdit(operationId);
              }}
            >
              Record result delivery
            </button>
          </>
        )}
      </Group>
    );
  });
}

function UnresolvedActionsContent({
  snapshot,
  facade,
  actions,
}: SettingsProps & { actions: Actions }) {
  const retained = useSetupIntents(facade, snapshot);
  const feedback = useSettingsFeedback(facade);
  const rows = unresolvedActions(snapshot, retained);
  const settings =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings
      : null;
  const evidence =
    settings && snapshot.evidence?.revision === settings.revision
      ? snapshot.evidence.value
      : null;
  return (
    <>
      {rows.length === 0 ? (
        <p role="status">No unresolved actions.</p>
      ) : (
        <ul aria-label="Unresolved operations">
          {rows.map((row) => (
            <li key={row.id}>
              <h3>{row.label}</h3>
              {row.id === "update-recovery" &&
                snapshot.environment === "preview" && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => facade.overlay("update-recovery")}
                  >
                    Review recovery options
                  </button>
                )}
              <p>
                {row.state === "pending" ? "Pending" : "Outcome unknown"}.{" "}
                {row.cause}
              </p>
              <p className="description">
                <code>{row.id}</code>
                {row.code ? (
                  <>
                    {" "}
                    · <code>{row.code}</code>
                  </>
                ) : null}
              </p>
              {Object.values(feedback.pages)
                .filter((entry) => entry?.result?.id === row.id)
                .map(
                  (entry) =>
                    entry && (
                      <button
                        key={row.id}
                        type="button"
                        className="text-button"
                        onClick={() => {
                          facade.overlay("none");
                          facade.navigate(
                            entry.origin.area === "setup"
                              ? {
                                  area: "setup",
                                  setupStep:
                                    entry.origin.setupStep ?? "overview",
                                }
                              : { area: "settings", page: entry.origin.page },
                          );
                        }}
                      >
                        Return to{" "}
                        {entry.origin.area === "setup" ? "Setup" : "Settings"}
                      </button>
                    ),
                )}
              {snapshot.intents[row.id]?.connectorAttempt && (
                <p className="description">
                  Original connection operation:{" "}
                  <code>
                    {snapshot.intents[row.id]!.connectorAttempt!.operationId}
                  </code>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {settings && (
        <WorkspaceEditResults
          snapshot={snapshot}
          facade={facade}
          settings={settings}
        />
      )}
      <button
        type="button"
        className="subtle"
        onClick={() => void actions.refresh()}
      >
        Refresh status
      </button>
      <p className="description">
        Refreshing cannot prove that an unknown action did not run. Only
        existing workspace edits support operation readback.
      </p>
      <Command actions={actions} command={{ kind: "support.export" }}>
        Save support file…
      </Command>
      {evidence?.kind === "support.exported" && (
        <p role="status">
          Saved {evidence.fileName} · {evidence.bytes} bytes.
        </p>
      )}
    </>
  );
}
