import { useEffect, useRef, useState } from "react";
import { ProductConfigurationCommandSchema } from "../../../src/pkg/product-settings/contract";
import { credentialRecoveryMatches } from "../../../src/ui/renderer/command-eligibility";
import { computerSetup } from "../../../src/ui/renderer/computer-setup";
import { setupStepCheck } from "../../../src/ui/renderer/setup-gate";
import { signInPresentation } from "../../../src/ui/renderer/sign-in-presentation";
import { AddToChatGPT } from "./connect";
import { connectionPresentation } from "./connection-presentation";
import { retainedSetupIntents, useSettingsFeedback } from "./intents";
import { Command, type PageProps } from "./page";
import { SetupWalkthrough } from "./setup-walkthrough";

export function Connection(props: PageProps) {
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
        {!connected && credentialRecoveryMatches(snapshot) && (
          <p className="description connection-recovery-hint" role="status">
            The last key change did not finish saving. Enter the same key again
            to complete it.
          </p>
        )}
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
