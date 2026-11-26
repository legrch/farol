import { unresolvedActions } from "../../../apps/desktop/renderer/unresolved-actions";
import { setupStepCheck } from "./setup-gate";
import { useEffect, useRef, useState } from "react";
import {
  ProductConfigurationCommandSchema,
  type ProductSettings,
} from "../../pkg/product-settings/contract";
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
import { Connection } from "../../../apps/desktop/renderer/connection";
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
