import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SecureMcpAppSelectionSchema,
  SeparateAppVerificationScopeSchema,
  type ProductConfigurationCommand,
} from "../../../src/pkg/product-settings/contract";
import { connectorWorkspaceSelection } from "../../../src/pkg/product-settings/connector-workspace-selection";
import { separateAppVerificationScopeCurrent } from "../../../src/pkg/product-settings/separate-app-verification";
import { computerSetup } from "../../../src/ui/renderer/computer-setup";
import type {
  Destination,
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import { setupStepCheck } from "../../../src/ui/renderer/setup-gate";
import { ConnectionTestButton, useConnectionTest } from "./connection-test";
import {
  intention,
  retainedSetupIntents,
  useSettingsFeedback,
} from "./intents";
import { Command, type PageProps } from "./page";
import { SetupWalkthrough } from "./setup-walkthrough";

const requestedSeparateTests = new WeakMap<RendererFacade, Set<string>>();
const automaticAttachmentReads = new WeakMap<
  RendererFacade,
  { binding: string; destination: Destination }
>();

export function AddToChatGPT({
  settings,
  snapshot,
  facade,
  actions,
  onSetupInputsChange,
  setupStep,
  setupTestActionHost,
}: PageProps) {
  const freshTest = useConnectionTest(facade);
  const connector = settings.connectors.secureMcp;
  const defaultName =
    snapshot.environment === "dev"
      ? "Farol Dev"
      : snapshot.environment === "owner-preview"
        ? "Farol Preview"
        : "Farol";
  const selectedName = connector.chatgptApp?.name ?? defaultName;
  const [appName, setAppName] = useState(selectedName);
  const previousName = useRef(selectedName);
  useEffect(() => {
    if (appName === previousName.current) setAppName(selectedName);
    previousName.current = selectedName;
  }, [appName, selectedName]);
  const nameChanged = appName !== selectedName;
  const savedSetup = settings.setup.journey.dismissed && !nameChanged;
  useEffect(() => {
    onSetupInputsChange?.(nameChanged);
  }, [nameChanged, onSetupInputsChange]);
  const nameValid = SecureMcpAppSelectionSchema.safeParse({
    name: appName,
    tunnelId: connector.tunnelId,
    connectorGeneration: connector.generation,
  }).success;
  const setup = computerSetup(snapshot);
  const busy = useRef(false);
  const [checking, setChecking] = useState(false);
  const connectionDetails = useRef<HTMLDListElement>(null);
  const readingConfirmation = useRef(false);
  const [refreshingConfirmation, setRefreshingConfirmation] = useState(false);
  const [confirmationRead, setConfirmationRead] = useState<string | null>(null);
  const feedback = useSettingsFeedback(facade);
  const result = feedback.pages["setup:attachment"]?.result;
  const failed = result?.state === "refused" || result?.state === "unknown";
  const gate = setupStepCheck(
    snapshot,
    "attachment",
    nameChanged,
    retainedSetupIntents(facade, snapshot),
  );
  const unconfirmedTest =
    connector.appVerificationPending === true ||
    snapshot.intents["settings:connector.verify-app:"]?.state === "unknown";
  const waitingForConfirmation =
    !gate.allowed &&
    !checking &&
    (gate.state !== "pending" || refreshingConfirmation) &&
    (gate.state === "unknown" || unconfirmedTest);
  const checkConfirmation = useCallback(async () => {
    if (readingConfirmation.current || busy.current) return;
    readingConfirmation.current = true;
    setRefreshingConfirmation(true);
    setConfirmationRead(null);
    try {
      const observed = await actions.refresh();
      setConfirmationRead(
        observed?.state === "applied"
          ? "Status updated from this Dev’s saved confirmation."
          : observed?.code === "CONNECTOR_ATTACHMENT_NOT_FOUND"
            ? "No confirmation has reached this Dev. The earlier test remains unconfirmed."
            : observed?.state === "unknown"
              ? "The status read could not be confirmed. The saved attempt has been kept; it will not be repeated."
              : "Status refreshed. No new confirmation is available; no message was sent.",
      );
    } finally {
      readingConfirmation.current = false;
      setRefreshingConfirmation(false);
    }
  }, [actions]);
  const canObserveConfirmation = actions.allowed("connector.check-attachment");
  const observationBinding = `${snapshot.buildId}:${connector.runtime?.runtimeGeneration}:${connector.challenge?.challengeSha256}`;
  useEffect(() => {
    if (
      !waitingForConfirmation ||
      !connector.appVerificationPending ||
      !canObserveConfirmation ||
      (automaticAttachmentReads.get(facade)?.binding === observationBinding &&
        automaticAttachmentReads.get(facade)?.destination ===
          snapshot.destination)
    )
      return;
    automaticAttachmentReads.set(facade, {
      binding: observationBinding,
      destination: snapshot.destination,
    });
    void checkConfirmation();
  }, [
    waitingForConfirmation,
    connector.appVerificationPending,
    canObserveConfirmation,
    facade,
    observationBinding,
    snapshot.destination,
    checkConfirmation,
  ]);
  function reviewConnection() {
    connectionDetails.current?.scrollIntoView({ block: "center" });
    connectionDetails.current?.focus({ preventScroll: true });
  }
  const canPrepareTest = (current: WindowSnapshot) => {
    if (current.configuration?.status !== "ready") return false;
    return (
      computerSetup(current).canReconnect &&
      !computerSetup(current).facts.outcomeUnknown &&
      current.configuration.settings.connectors.secureMcp.challenge === null &&
      !setupStepCheck(
        current,
        "attachment",
        false,
        retainedSetupIntents(facade, current),
      ).allowed
    );
  };
  const needsNewTest = !nameChanged && canPrepareTest(snapshot);
  const separateParsed = SeparateAppVerificationScopeSchema.safeParse({
    ownerAuthorized: true,
    appName,
    tunnelId: connector.tunnelId,
    connectorGeneration: connector.generation,
    computerGeneration: settings.computer.generation,
    runtimeGeneration: connector.runtime?.runtimeGeneration,
    buildId: snapshot.buildId,
    challengeSha256: connector.challenge?.challengeSha256,
    workspaceId: connectorWorkspaceSelection(settings),
  });
  const separateExpected =
    separateParsed.success &&
    !nameChanged &&
    setup.canVerifySeparateEmbeddedApp &&
    separateAppVerificationScopeCurrent(
      settings,
      separateParsed.data,
      snapshot.buildId ?? "",
    )
      ? separateParsed.data
      : null;
  // This only selects the command. Main owns the native confirmation for each
  // fresh attempt; IPC metadata is never treated as owner consent.
  const separateBinding = separateExpected
    ? JSON.stringify(separateExpected)
    : null;
  const [requestedSeparate, setRequestedSeparate] = useState<string | null>(
    null,
  );
  const separateAvailable =
    separateBinding !== null &&
    requestedSeparate !== separateBinding &&
    !requestedSeparateTests.get(facade)?.has(separateBinding);

  async function saveName() {
    if (!nameValid || busy.current || !connector.tunnelId) return;
    await actions.run({
      kind: "connector.select-chatgpt-app",
      name: appName,
      tunnelId: connector.tunnelId,
      connectorGeneration: connector.generation,
    });
  }
  async function test() {
    const dismissedSetup = settings.setup.journey.dismissed && !nameChanged;
    if (
      busy.current ||
      !nameValid ||
      (!dismissedSetup &&
        !(
          computerSetup(facade.getSnapshot()).canVerifyEmbeddedApp ||
          (separateAvailable &&
            separateExpected &&
            computerSetup(facade.getSnapshot()).canVerifySeparateEmbeddedApp)
        ))
    )
      return;
    busy.current = true;
    if (separateAvailable && separateBinding) {
      const requested = requestedSeparateTests.get(facade) ?? new Set<string>();
      requested.add(separateBinding);
      requestedSeparateTests.set(facade, requested);
      setRequestedSeparate(separateBinding);
    }
    setChecking(true);
    try {
      const current = facade.getSnapshot();
      if (current.configuration?.status !== "ready") return;
      const saved = current.configuration.settings.connectors.secureMcp;
      if (!saved.tunnelId) return;
      if (
        saved.chatgptApp?.name !== appName ||
        saved.chatgptApp.tunnelId !== saved.tunnelId ||
        saved.chatgptApp.connectorGeneration !== saved.generation
      ) {
        if (
          (
            await actions.run({
              kind: "connector.select-chatgpt-app",
              name: appName,
              tunnelId: saved.tunnelId,
              connectorGeneration: saved.generation,
            })
          )?.state !== "applied"
        )
          return;
      }
      const latest = facade.getSnapshot();
      if (
        latest.destination !== current.destination ||
        latest.buildId !== current.buildId ||
        latest.configuration?.status !== "ready" ||
        latest.configuration.settings.connectors.secureMcp.generation !==
          saved.generation ||
        latest.configuration.settings.connectors.secureMcp.tunnelId !==
          saved.tunnelId
      )
        return;
      const command: ProductConfigurationCommand =
        separateAvailable && separateExpected
          ? {
              kind: "connector.verify-separate-app",
              expected: separateExpected,
            }
          : { kind: "connector.verify-app" };
      const pending = actions.run(command, (current) =>
        command.kind === "connector.verify-separate-app"
          ? current.configuration?.status === "ready" &&
            computerSetup(current).canVerifySeparateEmbeddedApp &&
            separateAppVerificationScopeCurrent(
              current.configuration.settings,
              command.expected,
              current.buildId ?? "",
            )
          : settings.setup.journey.dismissed ||
            computerSetup(current).canVerifyEmbeddedApp,
      );
      // Stamp the return before the host navigation microtask. The person
      // lands on ChatGPT and can come back to this step.
      if (
        facade.getSnapshot().intents[intention(command.kind)]?.state ===
        "pending"
      )
        facade.navigate({
          area: "chatgpt",
          taskId: "",
          connectionCheckReturn: true,
        });
      await pending;
    } finally {
      busy.current = false;
      setChecking(false);
    }
  }
  const testDisabled =
    settings.setup.journey.dismissed && !nameChanged
      ? checking ||
        !nameValid ||
        (waitingForConfirmation && !separateAvailable) ||
        !actions.allowed("connector.verify-app")
      : checking ||
        (waitingForConfirmation && !separateAvailable) ||
        needsNewTest ||
        !nameValid ||
        !(separateAvailable
          ? actions.allowed("connector.verify-separate-app") &&
            setup.canVerifySeparateEmbeddedApp
          : actions.allowed("connector.verify-app") &&
            setup.canVerifyEmbeddedApp);
  const showSavedSetup =
    savedSetup && !checking && !freshTest.busy && !unconfirmedTest;
  const testAction = (
    <button
      type="button"
      className="primary"
      disabled={testDisabled}
      aria-describedby={
        waitingForConfirmation && !showSavedSetup
          ? "setup-test-blocked"
          : undefined
      }
      title={
        waitingForConfirmation && !showSavedSetup
          ? "Check the saved result first. The earlier test has no confirmed outcome."
          : undefined
      }
      onClick={() => void test()}
    >
      {checking || freshTest.busy ? "Testing in ChatGPT…" : "Test in ChatGPT"}
    </button>
  );
  return (
    <>
      {setupStep === "attachment" && setupTestActionHost
        ? createPortal(testAction, setupTestActionHost)
        : null}
      <section aria-label="Create the ChatGPT app">
        <h3>
          {savedSetup ? "Your ChatGPT app" : "1. Add your app in ChatGPT"}
        </h3>

        <p className="description">
          {savedSetup
            ? "Your app was added and tested during setup."
            : "Create a new app, or use the one already connected to this tunnel."}
        </p>
        <SetupWalkthrough
          kind="chatgpt"
          openLink={
            <Command
              className="text-button"
              actions={actions}
              command={{ kind: "onboarding.open-help", destination: "chatgpt" }}
            >
              Open ChatGPT Apps
            </Command>
          }
        />
        <p className="description setup-connection-hint">
          Use this Mac’s tunnel ID in ChatGPT. A matching app name does not
          guarantee that the app connects to this Mac.
        </p>
        <dl
          className="setup-app-values"
          ref={connectionDetails}
          tabIndex={-1}
          aria-label="Connection details for this Mac"
        >
          <div>
            <dt>Name</dt>
            <dd>
              <input
                className="field"
                aria-label="ChatGPT app name"
                aria-describedby="chatgpt-app-name-hint"
                value={appName}
                maxLength={64}
                disabled={
                  checking || !actions.allowed("connector.select-chatgpt-app")
                }
                onChange={(event) => setAppName(event.currentTarget.value)}
              />
              <p className="description" id="chatgpt-app-name-hint">
                Use the exact name shown in ChatGPT. For a separate test app,
                use Farol Dev.
              </p>
              {nameChanged && (
                <button
                  type="button"
                  className="subtle"
                  disabled={
                    !nameValid ||
                    !actions.allowed("connector.select-chatgpt-app")
                  }
                  onClick={() => void saveName()}
                >
                  Save app name
                </button>
              )}
              {!nameValid && (
                <p className="description" role="status">
                  Enter 1–64 letters, numbers, spaces, periods, underscores or
                  hyphens. Start with a letter or number.
                </p>
              )}
            </dd>
          </div>
          <div>
            <dt>Connection</dt>
            <dd>Tunnel · {connector.tunnelId ?? "Connect this Mac first"}</dd>
          </div>
          <div>
            <dt>App authentication</dt>
            <dd>
              No additional sign-in
              <p className="description">
                Choose None in the app’s authentication settings. Your ChatGPT
                account stays signed in separately.
              </p>
            </dd>
          </div>
        </dl>
      </section>
      <section className="setup-test" aria-label="Test in ChatGPT">
        <h3>{savedSetup ? "Connection test" : "2. Check the connection"}</h3>
        {settings.setup.journey.dismissed && freshTest.message && (
          <p role="status">{freshTest.message}</p>
        )}
        <p className="description" id="setup-test-blocked">
          {showSavedSetup
            ? "A new connection test is optional. Current connection status is shown on Home."
            : waitingForConfirmation
              ? separateAvailable
                ? "Test in ChatGPT sends one new test message after confirmation. The earlier result stays in Activity and will not be repeated."
                : unconfirmedTest
                  ? "An earlier test has no confirmed result. It will not be repeated. Refresh status to check its saved result."
                  : "An earlier action has no confirmed result. Check its saved status before starting a test."
              : "Farol opens a separate chat, selects Instant and sends one test message to your app. The reply confirms that ChatGPT can reach this Mac — without reading file contents."}
        </p>
        <div
          className="setup-result setup-gate-status"
          role={
            !showSavedSetup &&
            gate.state === "refused" &&
            !waitingForConfirmation
              ? "alert"
              : "status"
          }
          data-result-state={showSavedSetup ? "success" : gate.state}
          data-confirmation-pending={
            (!showSavedSetup && waitingForConfirmation) || undefined
          }
        >
          <strong>
            {showSavedSetup
              ? "App added and tested"
              : gate.allowed
                ? "ChatGPT is connected"
                : waitingForConfirmation
                  ? refreshingConfirmation
                    ? "Checking confirmation…"
                    : "Waiting for confirmation"
                  : gate.state === "pending"
                    ? "Checking the connection…"
                    : gate.state === "unknown"
                      ? "Waiting for ChatGPT confirmation"
                      : gate.state === "refused"
                        ? "The check stopped"
                        : "Ready when your app is added"}
          </strong>
          <p>
            {showSavedSetup
              ? "Setup is saved. View Home for the current connection status, or run a new test below when you need one."
              : gate.state === "missing"
                ? "Add the app above, then run the check once."
                : waitingForConfirmation
                  ? unconfirmedTest
                    ? "This Mac has not received confirmation. Check the saved result, or compare the app’s tunnel ID with the connection shown above."
                    : "An earlier action is not confirmed. Checking status will not repeat it or start a ChatGPT test."
                  : gate.cause}
          </p>
          {gate.action && gate.state !== "missing" && !showSavedSetup && (
            <button
              type="button"
              className="text-button"
              disabled={refreshingConfirmation}
              onClick={() => {
                if (waitingForConfirmation) void checkConfirmation();
                else if (gate.action?.kind === "refresh")
                  void actions.refresh();
                else
                  void actions.run({
                    kind: "onboarding.open-help",
                    destination: gate.action?.destination ?? "setup-guide",
                  });
              }}
            >
              {waitingForConfirmation
                ? refreshingConfirmation
                  ? "Refreshing…"
                  : "Refresh status"
                : gate.action.label}
            </button>
          )}
          {confirmationRead && (
            <p className="setup-confirmation-read" role="status">
              {confirmationRead}
            </p>
          )}
        </div>
        {settings.setup.journey.dismissed &&
        !(setupStep === "attachment" && setupTestActionHost) ? (
          <ConnectionTestButton
            facade={facade}
            disabled={nameChanged || !nameValid}
          />
        ) : null}
        {gate.allowed ? (
          <div className="setup-success" role="status">
            <strong>✓ Everything works</strong>
            <p>
              ChatGPT used Farol, reached this Mac and verified{" "}
              {setup.facts.hasFolder
                ? "access to the approved workspace"
                : "the workspace list"}
              . No file contents were read.
            </p>
          </div>
        ) : waitingForConfirmation ? (
          <>
            <button
              type="button"
              className="text-button setup-review-connection"
              onClick={reviewConnection}
            >
              Show connection details
            </button>
            <p className="description">
              Farol checks the saved confirmation automatically when you return
              here. Refresh status checks again without sending a message. The
              earlier test stays in Unresolved actions.
            </p>
          </>
        ) : needsNewTest ? (
          <>
            <p className="description">
              Prepare a fresh test for this app by refreshing this Mac’s
              connection. Your saved key and workspace settings stay in place.
            </p>
            <Command
              className="primary"
              actions={actions}
              command={{ kind: "connector.repair" }}
              disabled={checking || !nameValid}
              admit={canPrepareTest}
            >
              Prepare new test
            </Command>
          </>
        ) : (
          <>
            {!failed && gate.state !== "unknown" && (
              <p className="description">
                {nameChanged
                  ? "Save the app name above before preparing a new test."
                  : settings.setup.journey.dismissed
                    ? "This test is optional. It does not change the connection status."
                    : setup.canVerifyEmbeddedApp
                      ? "Create the app above, then run the check once."
                      : "Finish sign-in, workspace and connection checks before testing in ChatGPT."}
              </p>
            )}
            {setupStep !== "attachment" ? testAction : null}
          </>
        )}
      </section>
    </>
  );
}
