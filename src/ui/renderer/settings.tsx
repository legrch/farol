import {
  defaultNavigationShortcuts,
  parseNavigationShortcuts,
  type NavigationShortcuts,
} from "../../pkg/ipc/navigation-shortcuts";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ProductConfigurationCommandSchema,
  type ApprovedProductWorkspace,
  type ProductConfigurationCommand,
  type ProductSettings,
} from "../../pkg/product-settings/contract";
import { folderAccessChecked, folderDisplayName } from "../folder-access-state";
import { onboardingFacts } from "../guided-onboarding";
import type { Intent, RendererFacade, WindowSnapshot } from "./contract";

export type SettingsProps = Readonly<{
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}>;
type Actions = {
  disabled: boolean;
  allowed(
    kind: ProductConfigurationCommand["kind"],
    workspaceId?: string,
  ): boolean;
  run(command: ProductConfigurationCommand): Promise<Intent | null>;
};
type PageProps = SettingsProps & {
  settings: ProductSettings;
  actions: Actions;
};
const intention = (kind: string, workspaceId = "") =>
  `settings:${kind}:${workspaceId}`;
function fenced(snapshot: WindowSnapshot): boolean {
  const settings =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings
      : null;
  return (
    snapshot.status !== "current" ||
    snapshot.configuration?.status !== "ready" ||
    Object.values(snapshot.intents).some(
      (item) => item.state === "pending" || item.state === "unknown",
    ) ||
    Boolean(
      settings &&
      (settings.computer.pendingEdit ||
        Object.values(settings.setup).some(
          (step) => "outcomeUnknown" in step && step.outcomeUnknown,
        ) ||
        settings.connectors.secureMcp.runtime?.state === "outcome_unknown"),
    )
  );
}
// Evidence carries a revision, but no request ID. If another facade intent
// changed during a picker/preview, do not attribute its evidence to our action.
function soleIntent(
  before: WindowSnapshot,
  after: WindowSnapshot,
  kind: string,
): boolean {
  const id = intention(kind);
  return Object.entries(after.intents).every(
    ([key, value]) => key === id || before.intents[key] === value,
  );
}
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-group" aria-label={title}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function Command({
  command,
  actions,
  children,
  className = "subtle",
  disabled = false,
}: {
  command: ProductConfigurationCommand;
  actions: Actions;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const workspaceId =
    "workspaceId" in command ? command.workspaceId : undefined;
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || !actions.allowed(command.kind, workspaceId)}
      onClick={() => void actions.run(command)}
    >
      {children}
    </button>
  );
}

/** Presentation only: mounting, observation and background updates never save. */
export function Settings({ snapshot, facade }: SettingsProps) {
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
  const busy = useRef(false);
  const uncertain = useRef(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const composing = useRef(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const allowed: Actions["allowed"] = () =>
    !pending && !unconfirmed && !fenced(snapshot);
  const actions: Actions = {
    disabled: pending || unconfirmed || fenced(snapshot),
    allowed,
    async run(command) {
      const current = facade.getSnapshot();
      const id = intention(
        command.kind,
        "workspaceId" in command ? command.workspaceId : undefined,
      );
      if (
        busy.current ||
        uncertain.current ||
        composing.current ||
        fenced(current)
      )
        return null;
      if (!ProductConfigurationCommandSchema.safeParse(command).success) {
        setMessage(
          "Check the fields. Paths must be unique relative paths without dot segments; connection fields must match their required format.",
        );
        return null;
      }
      busy.current = true;
      setPending(true);
      setMessage("Saving or checking…");
      try {
        const result = await facade.configure(command, id);
        if (result.state === "unknown") {
          uncertain.current = true;
          setUnconfirmed(true);
        }
        setMessage(
          result.state === "applied"
            ? "Action confirmed. Check the current status below."
            : result.state === "unknown"
              ? "Outcome unknown. Do not repeat this action; inspect the existing result."
              : "Action refused. Resolve the reported condition before continuing.",
        );
        if (result.code && /^[A-Z][A-Z0-9_]{0,119}$/u.test(result.code)) {
          setMessage((value) => `${value} ${result.code}`);
        }
        return result;
      } catch {
        // Keep a local fence too if an adapter throws before retaining its intent.
        uncertain.current = true;
        setUnconfirmed(true);
        setMessage(
          "Outcome unknown. Do not repeat this action; inspect the existing result.",
        );
        return null;
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
  };
  if (!displayedSettings)
    return (
      <div className="settings-page">
        <h2>Settings</h2>
        <p className="notice">
          Settings are unavailable. Refresh the current state before making
          changes.
        </p>
        <button className="subtle" onClick={() => void facade.refresh()}>
          Refresh status
        </button>
      </div>
    );
  const props: PageProps = {
    snapshot,
    facade,
    settings: displayedSettings,
    actions,
  };
  // Keep each form mounted across page/background changes. No revision key or
  // snapshot effect may replace a draft or interrupt IME composition.
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
      {configuration?.status !== "ready" && (
        <p className="notice" role="status">
          Settings are temporarily unavailable. Your drafts are retained; saved
          settings and access must be checked before making changes.
          <button className="subtle" onClick={() => void facade.refresh()}>
            Refresh status
          </button>
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {actions.disabled && (
        <p className="notice">
          Changes are paused while state is stale, an action is pending, or an
          outcome is unconfirmed. Refresh observes status; it does not replay an
          action.
        </p>
      )}
      <div hidden={snapshot.destination.page !== "general"}>
        <General {...props} />
      </div>
      <div hidden={snapshot.destination.page !== "appearance"}>
        <AppearancePage {...props} />
      </div>
      <div hidden={snapshot.destination.page !== "folders"}>
        <Folders {...props} />
      </div>
      <div hidden={snapshot.destination.page !== "computer"}>
        <ThisMac {...props} />
      </div>
      <div hidden={snapshot.destination.page !== "connection"}>
        <Connection {...props} />
      </div>
      <div hidden={snapshot.destination.page !== "model"}>
        <Model {...props} />
      </div>
      <div hidden={snapshot.destination.page !== "shortcuts"}>
        <Shortcuts {...props} />
      </div>
      <div hidden={snapshot.destination.page !== "updates"}>
        <Updates {...props} />
      </div>
      <div hidden={snapshot.destination.page !== "diagnostics"}>
        <Diagnostics {...props} />
      </div>
    </div>
  );
}

function General({ settings, actions }: PageProps) {
  const [start, setStart] = useState(settings.general.openAtLaunch);
  const [sidebar, setSidebar] = useState(settings.general.sidebarDefault);
  return (
    <>
      <h2>General</h2>
      <Group title="Navigation">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void actions.run({
              kind: "general.update",
              openAtLaunch: start,
              sidebarDefault: sidebar,
              activityDetail: settings.general.activityDetail,
            });
          }}
        >
          <label className="setting-row">
            Start page
            <select
              className="field"
              value={start}
              onChange={(event) =>
                setStart(event.currentTarget.value as typeof start)
              }
            >
              <option value="browser">ChatGPT</option>
              <option value="computer">This Mac</option>
              <option value="activity">Activity</option>
              <option value="settings">Settings</option>
            </select>
          </label>
          <p className="description">
            Home is available in the sidebar. The current launch contract
            supports these four destinations.
          </p>
          <label className="setting-row">
            Sidebar
            <select
              className="field"
              value={sidebar}
              onChange={(event) =>
                setSidebar(event.currentTarget.value as typeof sidebar)
              }
            >
              <option value="full">Show page list</option>
              <option value="rail">Hide page list</option>
            </select>
          </label>
          <p className="description">
            The toolbar toggles the page list. Remembering the last choice is
            not supported by the current settings contract.
          </p>
          <div className="control-row">
            <button
              className="primary"
              disabled={!actions.allowed("general.update")}
            >
              Save navigation
            </button>
            <button
              className="subtle"
              type="button"
              onClick={() => {
                setStart(settings.general.openAtLaunch);
                setSidebar(settings.general.sidebarDefault);
              }}
            >
              Reset to saved navigation
            </button>
          </div>
        </form>
      </Group>
    </>
  );
}
function AppearancePage({ snapshot, facade }: PageProps) {
  const appearance = snapshot.appearance;
  return (
    <>
      <h2>Appearance</h2>
      <Group title="Interface">
        <div className="setting-row">Theme</div>
        <div className="theme-choices" role="group" aria-label="Theme">
          {(["light", "graphite", "system"] as const).map((theme) => (
            <button
              type="button"
              key={theme}
              className="theme-choice"
              aria-pressed={appearance.theme === theme}
              onClick={() => facade.appearance({ ...appearance, theme })}
            >
              <span className={`theme-preview ${theme}`} aria-hidden="true" />
              {theme === "light"
                ? "Light"
                : theme === "graphite"
                  ? "Graphite"
                  : "System"}
            </button>
          ))}
        </div>
        <label className="setting-row">
          Accent
          <select
            className="field"
            value={appearance.accent}
            onChange={(event) =>
              facade.appearance({
                ...appearance,
                accent: event.currentTarget.value as typeof appearance.accent,
              })
            }
          >
            <option value="iris">Iris</option>
            <option value="cobalt">Cobalt</option>
            <option value="amber">Amber</option>
          </select>
        </label>
        <label className="setting-row">
          Font
          <select
            className="field"
            value={appearance.font}
            onChange={(event) =>
              facade.appearance({
                ...appearance,
                font: event.currentTarget.value as typeof appearance.font,
              })
            }
          >
            <option value="geist">Geist</option>
            <option value="system">System</option>
          </select>
        </label>
        <p className="description">
          System follows your Mac. Appearance changes keep the same layout;
          status colors retain their meaning.
        </p>
      </Group>
    </>
  );
}
function Folders(props: PageProps) {
  const { settings, facade, snapshot, actions } = props;
  const [picked, setPicked] = useState<WindowSnapshot["evidence"]>(null);
  const pickCurrent =
    picked !== null &&
    snapshot.evidence === picked &&
    picked.revision === settings.revision &&
    picked.value.kind === "computer.workspace-pick";
  async function choose() {
    setPicked(null);
    const before = facade.getSnapshot();
    const result = await actions.run({ kind: "computer.choose-workspace" });
    const current = facade.getSnapshot();
    if (
      result?.state === "applied" &&
      current.evidence !== before.evidence &&
      soleIntent(before, current, "computer.choose-workspace") &&
      current.evidence?.value.kind === "computer.workspace-pick" &&
      current.configuration?.status === "ready" &&
      current.evidence.revision === current.configuration.settings.revision
    )
      setPicked(current.evidence);
  }
  return (
    <>
      <h2>Folders</h2>
      <p className="description">
        Folders start read-only. Read &amp; write allows guarded changes that
        still require approval. Access changes require a fresh check.
      </p>
      <Group title="Approved folders">
        <div className="control-row">
          <button
            type="button"
            className="primary"
            disabled={!actions.allowed("computer.choose-workspace")}
            onClick={() => void choose()}
          >
            Add folder…
          </button>
          {pickCurrent && (
            <button
              type="button"
              className="primary"
              disabled={!actions.allowed("computer.add-workspace")}
              onClick={() => {
                const evidence = facade.getSnapshot().evidence;
                if (
                  evidence !== picked ||
                  evidence?.value.kind !== "computer.workspace-pick"
                )
                  return;
                setPicked(null);
                void actions.run({
                  kind: "computer.add-workspace",
                  selectionId: evidence.value.selectionId,
                });
              }}
            >
              Add selected folder read-only
            </button>
          )}
        </div>
        {picked && !pickCurrent && (
          <p className="notice">
            The selection is no longer current. Choose the folder again before
            adding it.
          </p>
        )}
        {settings.computer.workspaces.length === 0 && (
          <p className="description">
            No folders approved. Local file access is optional.
          </p>
        )}
        {settings.computer.workspaces.map((workspace) => (
          <Folder
            key={workspace.workspaceId}
            {...props}
            workspace={workspace}
          />
        ))}
      </Group>
    </>
  );
}
function Folder({
  workspace,
  settings,
  snapshot,
  actions,
}: PageProps & { workspace: ApprovedProductWorkspace }) {
  const relativeExclusions = () => {
    const prefix = workspace.root === "/" ? "/" : `${workspace.root}/`;
    return workspace.excludedPaths
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .join("\n");
  };
  const policy = JSON.stringify([
    workspace.root,
    settings.computer.generation,
    workspace.excludedPaths,
  ]);
  const [exclusions, setExclusions] = useState(relativeExclusions);
  const [draftPolicy, setDraftPolicy] = useState(policy);
  const name = folderDisplayName(workspace);
  const checked =
    snapshot.status === "current" &&
    !settings.setup.computer.outcomeUnknown &&
    Boolean(
      snapshot.buildId &&
      folderAccessChecked(settings, workspace, snapshot.buildId),
    );
  return (
    <article className="folder-row">
      <div className="setting-row">
        <strong>{name}</strong>
        <span className="badges">
          {workspace.access === "read"
            ? "Read-only"
            : "Read & write · approval required"}{" "}
          · {checked ? "Access checked" : "Check access needed"}
        </span>
      </div>
      <p className="description">{workspace.root}</p>
      <div className="control-row">
        <Command
          actions={actions}
          command={{
            kind: "computer.check-folder",
            workspaceId: workspace.workspaceId,
          }}
        >
          Check access
        </Command>
        <Command
          actions={actions}
          command={{
            kind: "computer.verify-workspace",
            workspaceId: workspace.workspaceId,
          }}
        >
          Verify workspace
        </Command>
        <Command
          actions={actions}
          command={{
            kind: "computer.update-access",
            workspaceId: workspace.workspaceId,
            access: workspace.access === "read" ? "write" : "read",
          }}
        >
          {workspace.access === "read"
            ? "Allow guarded changes"
            : "Use read-only"}
        </Command>
        <Command
          actions={actions}
          command={{
            kind: "computer.remove-workspace",
            workspaceId: workspace.workspaceId,
          }}
        >
          Remove folder
        </Command>
      </div>
      <details>
        <summary>More access options</summary>
        <p className="description">
          Git history, old versions, hooks and user settings require a separate
          approval. This grant does not enable commands.
        </p>
        <Command
          actions={actions}
          command={{
            kind: "computer.update-git-history",
            workspaceId: workspace.workspaceId,
            approved: !workspace.gitHistoryApproved,
          }}
        >
          {workspace.gitHistoryApproved
            ? "Remove expanded Git approval"
            : "Approve expanded Git access"}
        </Command>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (policy !== draftPolicy) return;
            void actions.run({
              kind: "computer.update-exclusions",
              workspaceId: workspace.workspaceId,
              excludedPaths: exclusions
                .split(/[\n,]/u)
                .map((path) => path.trim())
                .filter(Boolean),
            });
          }}
        >
          <label className="setting-row">
            Excluded paths for {name}
            <textarea
              className="field"
              value={exclusions}
              onChange={(event) => setExclusions(event.currentTarget.value)}
            />
          </label>
          <p className="description">
            One relative path per line. Exclusions remove access inside this
            folder.
          </p>
          {policy !== draftPolicy && (
            <p className="notice">
              Folder access changed while this draft was open. Reload the saved
              exclusions before changing them.
            </p>
          )}
          <div className="control-row">
            <button
              className="primary"
              disabled={
                policy !== draftPolicy ||
                !actions.allowed(
                  "computer.update-exclusions",
                  workspace.workspaceId,
                )
              }
            >
              Save exclusions
            </button>
            <button
              className="subtle"
              type="button"
              onClick={() => {
                setExclusions(relativeExclusions());
                setDraftPolicy(policy);
              }}
            >
              Reload saved exclusions
            </button>
          </div>
        </form>
      </details>
    </article>
  );
}
function ThisMac({ settings, snapshot, actions }: PageProps) {
  const [commands, setCommands] = useState(settings.computer.commands);
  return (
    <>
      <h2>This Mac</h2>
      <Group title="Local service">
        <div className="setting-row">
          <strong>{settings.computer.name}</strong>
          <span className="badges">{snapshot.runtime}</span>
        </div>
        <p className="description">
          Local service status is independent of connection verification and
          folder access.
        </p>
      </Group>
      <Group title="Command access">
        <p className="description">
          Current policy: {settings.computer.commands}. Changing command access
          requires workspace verification again.
        </p>
        <details>
          <summary>Run commands</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void actions.run({ kind: "computer.update-commands", commands });
            }}
          >
            <label className="setting-row">
              Command policy
              <select
                className="field"
                value={commands}
                onChange={(event) =>
                  setCommands(event.currentTarget.value as typeof commands)
                }
              >
                <option value="none">Off</option>
                <option value="verification">Fixed verification only</option>
                <option value="workspace">Approved folders only</option>
              </select>
            </label>
            <p className="description">
              Fixed verification runs bounded Git status and HEAD commands with
              Apple Git. Approved folders allow a sandboxed workspace shell.
              Both exclude network access; expanded Git access remains a
              separate folder approval.
            </p>
            <button
              className="primary"
              disabled={!actions.allowed("computer.update-commands")}
            >
              Apply command policy
            </button>
          </form>
        </details>
      </Group>
      <p className="notice">
        Premium host and Agent verification are unavailable here because their
        existing live contract requires Astra. This page does not run them.
      </p>
    </>
  );
}
function Connection({ settings, snapshot, actions }: PageProps) {
  const connector = settings.connectors.secureMcp;
  const facts = onboardingFacts(settings, snapshot.buildId ?? "");
  const ready =
    snapshot.status === "current" &&
    facts.chat === "ready" &&
    facts.attachmentCurrent &&
    !facts.outcomeUnknown;
  const [tunnelId, setTunnelId] = useState(connector.tunnelId ?? "");
  const [key, setKey] = useState("");
  const keyComposing = useRef(false);
  const [appName, setAppName] = useState(connector.chatgptApp?.name ?? "");
  const appCheckStarted = useRef(false);
  const [appCheckAttempted, setAppCheckAttempted] = useState(false);
  return (
    <>
      <h2>Connection</h2>
      <Group title="ChatGPT">
        <p className="badges">
          {facts.outcomeUnknown
            ? "Outcome unknown"
            : ready
              ? "Ready"
              : facts.runtimeCurrent
                ? "Connection check needed"
                : "Setup needed or disconnected"}
        </p>
        <p className="description">
          Sign-in, the local service and end-to-end access have separate checks.
          A running service alone cannot establish Ready.
        </p>
        <div className="control-row">
          <Command actions={actions} command={{ kind: "chatgpt.open-sign-in" }}>
            Sign in
          </Command>
          <Command actions={actions} command={{ kind: "chatgpt.open-browser" }}>
            Open ChatGPT
          </Command>
          <Command actions={actions} command={{ kind: "chatgpt.verify" }}>
            Check sign-in
          </Command>
        </div>
      </Group>
      <Group title="This Mac connection">
        <p className="description">
          Select the tunnel client, save the tunnel, then start the connection.
          An approved, verified folder is required for local access.
        </p>
        <Command
          actions={actions}
          command={{ kind: "connector.select-client" }}
        >
          Choose tunnel client…
        </Command>
        <p className="badges">
          Client: {connector.tunnelClient ? "Selected" : "Not selected"} · Key:{" "}
          {connector.credential === "stored" ? "Saved" : "Needed"} · Service:{" "}
          {connector.runtime?.state ?? "Stopped"}
        </p>
        <form
          autoComplete="off"
          onCompositionStart={() => {
            keyComposing.current = true;
          }}
          onCompositionEnd={() => {
            keyComposing.current = false;
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (keyComposing.current || !actions.allowed("connector.configure"))
              return;
            const runtimeKey = key || null;
            setKey("");
            void actions.run({
              kind: "connector.configure",
              tunnelId,
              runtimeKey,
            });
          }}
        >
          <label className="setting-row">
            Tunnel ID
            <input
              className="field"
              value={tunnelId}
              onChange={(event) => setTunnelId(event.currentTarget.value)}
              required
              maxLength={160}
            />
          </label>
          <label className="setting-row">
            Runtime key
            <input
              className="field"
              type="password"
              autoComplete="new-password"
              value={key}
              onChange={(event) => setKey(event.currentTarget.value)}
              maxLength={512}
            />
          </label>
          <p className="description">
            Leave the key empty to retain the saved key. A replacement key is
            submitted only when you press Save connection and is then cleared
            from this field.
          </p>
          <button
            className="primary"
            disabled={!actions.allowed("connector.configure")}
          >
            Save connection
          </button>
        </form>
        <div className="control-row">
          <Command
            actions={actions}
            disabled={
              !facts.client ||
              !facts.credentialStored ||
              !facts.tunnelId ||
              facts.folder !== "ready" ||
              connector.runtime !== null
            }
            command={{ kind: "connector.start" }}
          >
            Start connection
          </Command>
          <Command
            actions={actions}
            command={{ kind: "connector.check-health" }}
          >
            Check local connection
          </Command>
          <Command
            actions={actions}
            command={{ kind: "connector.check-attachment" }}
            disabled={!facts.runtimeCurrent}
          >
            Check attachment
          </Command>
          <Command actions={actions} command={{ kind: "connector.stop" }}>
            Stop connection
          </Command>
        </div>
        <details>
          <summary>ChatGPT app and technical options</summary>
          <p className="description">
            Select the existing ChatGPT app attached to this tunnel. Check in
            ChatGPT sends one short message and verifies a local receipt; it is
            available only in Dev with the selected app, Temporary Chat and
            Instant model.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!connector.tunnelId) return;
              void actions.run({
                kind: "connector.select-chatgpt-app",
                name: appName,
                tunnelId: connector.tunnelId,
                connectorGeneration: connector.generation,
              });
            }}
          >
            <label className="setting-row">
              ChatGPT app name
              <input
                className="field"
                value={appName}
                onChange={(event) => setAppName(event.currentTarget.value)}
                required
                maxLength={64}
              />
            </label>
            <button
              className="primary"
              disabled={
                !connector.tunnelId ||
                !actions.allowed("connector.select-chatgpt-app")
              }
            >
              Select ChatGPT app
            </button>
          </form>
          <button
            type="button"
            className="primary"
            disabled={
              appCheckAttempted ||
              !actions.allowed("connector.verify-app") ||
              snapshot.environment !== "dev" ||
              !facts.runtimeCurrent ||
              facts.chat !== "ready" ||
              facts.folder !== "ready" ||
              !connector.challenge ||
              !connector.chatgptApp ||
              connector.chatgptApp.connectorGeneration !==
                connector.generation ||
              connector.chatgptApp.tunnelId !== connector.tunnelId
            }
            onClick={() => {
              if (appCheckStarted.current) return;
              appCheckStarted.current = true;
              setAppCheckAttempted(true);
              void actions.run({ kind: "connector.verify-app" });
            }}
          >
            Check in ChatGPT once
          </button>
          <p className="description">
            External verification: use the existing challenge and attachment
            flow. Health checks do not prove ChatGPT attachment.
          </p>
          <div className="control-row">
            <Command
              actions={actions}
              command={{ kind: "onboarding.open-help", destination: "tunnels" }}
            >
              Tunnel setup help
            </Command>
            <Command
              actions={actions}
              command={{
                kind: "onboarding.open-help",
                destination: "setup-guide",
              }}
            >
              Connection guide
            </Command>
          </div>
        </details>
      </Group>
    </>
  );
}
function Model({ settings, snapshot, facade, actions }: PageProps) {
  const [selectDefault, setSelectDefault] = useState(false);
  const [reviewed, setReviewed] = useState<WindowSnapshot["evidence"]>(null);
  const choice = snapshot.environment === "dev" ? false : selectDefault;
  const evidence =
    snapshot.evidence?.revision === settings.revision
      ? snapshot.evidence.value
      : null;
  const preview = evidence?.kind === "model.config-preview" ? evidence : null;
  const applyAllowed =
    preview !== null &&
    reviewed === snapshot.evidence &&
    preview.providerSelectionRequested === choice &&
    ["noop", "install", "update"].includes(preview.providerBlockStatus) &&
    (!choice ||
      preview.providerSelectionStatus === "noop" ||
      preview.providerSelectionStatus === "install" ||
      preview.providerSelectionStatus === "update");
  async function prepare() {
    setReviewed(null);
    const before = facade.getSnapshot();
    const result = await actions.run({
      kind: "model.preview",
      selectAsDefault: choice,
    });
    const current = facade.getSnapshot();
    if (
      result?.state === "applied" &&
      current.evidence !== before.evidence &&
      soleIntent(before, current, "model.preview") &&
      current.evidence?.value.kind === "model.config-preview"
    )
      setReviewed(current.evidence);
  }
  return (
    <>
      <h2>Model</h2>
      <Group title="Farol model">
        <p className="description">
          Provider: farol · Model: chatgpt.{" "}
          {snapshot.environment === "dev"
            ? "Changes use Farol Dev’s private Codex home."
            : "Changes write the Farol-managed block in Codex config.toml; default selection is a separate explicit choice."}
        </p>
        <Command actions={actions} command={{ kind: "model.status" }}>
          Check model status
        </Command>
        {evidence?.kind === "model.status" && (
          <p className="badges">
            {evidence.state} · Requests served: {evidence.requestsServed}
          </p>
        )}
        {snapshot.environment !== "dev" && (
          <label className="setting-row">
            <input
              type="checkbox"
              checked={selectDefault}
              onChange={(event) => {
                setSelectDefault(event.currentTarget.checked);
                setReviewed(null);
              }}
            />
            Select Farol as the default provider
          </label>
        )}
        <div className="control-row">
          <button
            type="button"
            className="subtle"
            disabled={!actions.allowed("model.preview")}
            onClick={() => void prepare()}
          >
            Preview model configuration
          </button>
          <button
            type="button"
            className="primary"
            disabled={!applyAllowed || !actions.allowed("model.apply")}
            onClick={() => {
              const current = facade.getSnapshot();
              if (
                current.evidence !== reviewed ||
                current.configuration?.status !== "ready" ||
                current.evidence?.revision !==
                  current.configuration.settings.revision
              )
                return;
              setReviewed(null);
              void actions.run({
                kind: "model.apply",
                selectAsDefault: choice,
              });
            }}
          >
            Apply reviewed configuration
          </button>
          <Command actions={actions} command={{ kind: "model.rollback" }}>
            Roll back managed configuration
          </Command>
        </div>
        {preview && (
          <p className="notice">
            Preview: {preview.configPath}. Managed block:{" "}
            {preview.providerBlockStatus}. Default selection:{" "}
            {preview.providerSelectionRequested
              ? (preview.providerSelectionStatus ?? "Not recorded")
              : "Not requested"}
            . Conflicts, unsafe permissions, symbolic links or malformed
            configuration prevent Apply. Preview metadata excludes credentials
            and raw config lines.
          </p>
        )}
        {evidence?.kind === "model.config-applied" && (
          <p className="notice">
            Managed block applied: {String(evidence.providerBlockApplied)}.
            Default selection applied:{" "}
            {String(evidence.providerSelectionApplied)}. Restart Codex to apply;
            host state: {evidence.codexHost}. No restart or model test runs from
            this page.
          </p>
        )}
        {evidence?.kind === "model.config-rollback" && (
          <p className="notice">
            Managed block restored: {String(evidence.providerBlockRestored)}.
            Default selection restored:{" "}
            {String(evidence.providerSelectionRestored)}.
          </p>
        )}
      </Group>
    </>
  );
}
function Shortcuts({ snapshot, facade }: PageProps) {
  const [draft, setDraft] = useState<NavigationShortcuts>(() => ({
    ...snapshot.shortcuts,
  }));
  const [message, setMessage] = useState("");
  const intent = snapshot.intents.shortcuts;
  const disabled =
    snapshot.status !== "current" ||
    intent?.state === "pending" ||
    intent?.state === "unknown";
  return (
    <>
      <h2>Shortcuts</h2>
      <Group title="Navigation shortcuts">
        <p className="description">
          Section keys use ⌘. Sidebar uses ⌃⌘. Search uses ⌘K. Commands respect
          composition and do not cancel hidden work.
        </p>
        {(
          [
            ["browser", "ChatGPT"],
            ["computer", "This Mac"],
            ["activity", "Activity"],
            ["settings", "Settings"],
          ] as const
        ).map(([key, label]) => (
          <label className="setting-row" key={key}>
            {label}
            <select
              aria-label={`${label} shortcut`}
              value={draft[key]}
              onChange={(e) =>
                setDraft({ ...draft, [key]: Number(e.target.value) })
              }
            >
              {[0, 1, 2, 3, 4].map((value) => (
                <option key={value} value={value}>
                  {value === 0 ? "Off" : `⌘${value}`}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className="setting-row">
          Toggle sidebar
          <select
            aria-label="Toggle sidebar shortcut"
            value={draft.sidebar}
            onChange={(e) =>
              setDraft({
                ...draft,
                sidebar: e.target.value as NavigationShortcuts["sidebar"],
              })
            }
          >
            <option value="s">⌃⌘S</option>
            <option value="b">⌃⌘B</option>
            <option value="off">Off</option>
          </select>
        </label>
        <div className="control-row">
          <button
            className="primary"
            disabled={disabled}
            onClick={() => {
              const parsed = parseNavigationShortcuts(draft);
              if (!parsed) {
                setMessage(
                  "Choose distinct section keys, or turn unused keys off.",
                );
                return;
              }
              void facade
                .shortcuts(parsed)
                .then((result) =>
                  setMessage(
                    result.state === "applied"
                      ? "Shortcuts saved and active."
                      : result.state === "unknown"
                        ? "Outcome unknown. Do not repeat this change."
                        : "Shortcut change refused.",
                  ),
                );
            }}
          >
            Save shortcuts
          </button>
          <button
            disabled={disabled}
            onClick={() => setDraft({ ...defaultNavigationShortcuts })}
          >
            Restore default choices
          </button>
        </div>
        {message && (
          <p role="status" className="notice">
            {message}
          </p>
        )}
      </Group>
    </>
  );
}
function Updates({ snapshot, facade, actions }: PageProps) {
  const busy = useRef(false);
  const [checked, setChecked] = useState(false);
  const update = snapshot.update;
  return (
    <>
      <h2>Updates</h2>
      <Group title="Installed update">
        <p className="badges">
          {update.phase}
          {"version" in update ? ` · ${update.version}` : ""}
        </p>
        {"code" in update && <p className="notice">{update.code}</p>}
        {"blockedBy" in update && update.blockedBy && (
          <p className="notice">{update.blockedBy}</p>
        )}
        <div className="control-row">
          <button
            type="button"
            className="primary"
            onClick={() => facade.overlay("update")}
          >
            Review update
          </button>
          <button
            type="button"
            className="subtle"
            disabled={
              checked ||
              actions.disabled ||
              fenced(snapshot) ||
              update.phase === "checking" ||
              update.phase === "downloading" ||
              update.phase === "applying"
            }
            onClick={() => {
              if (busy.current || fenced(facade.getSnapshot())) return;
              busy.current = true;
              setChecked(true);
              void facade.update("check").catch(() => {});
            }}
          >
            Check for updates once
          </button>
        </div>
        <p className="description">
          Review opens the update sheet. Installation, recovery and rollback use
          its existing integrity and work-admission checks. Automatic update
          preferences are not exposed by the current facade.
        </p>
      </Group>
    </>
  );
}
function Diagnostics({ snapshot, settings, facade, actions }: PageProps) {
  const evidence =
    snapshot.evidence?.revision === settings.revision
      ? snapshot.evidence.value
      : null;
  return (
    <>
      <h2>Diagnostics</h2>
      <Group title="Current status">
        <div className="setting-row">
          Snapshot<span className="badges">{snapshot.status}</span>
        </div>
        <div className="setting-row">
          Local service<span className="badges">{snapshot.runtime}</span>
        </div>
        <p className="description">
          Environment: {snapshot.environment}. Configuration revision:{" "}
          {settings.revision}. Activity contains bounded window-local metadata;
          it is not a conversation archive.
        </p>
        <button
          className="subtle"
          type="button"
          onClick={() => void facade.refresh()}
        >
          Refresh status
        </button>
      </Group>
      <Group title="Support">
        <Command actions={actions} command={{ kind: "support.export" }}>
          Export support diagnostics…
        </Command>
        {evidence?.kind === "support.exported" && (
          <p className="notice">
            Exported {evidence.fileName} · {evidence.bytes} bytes.
          </p>
        )}
        <p className="description">
          Export uses the existing native support flow. This page does not
          display snapshots, credentials or private transcripts.
        </p>
      </Group>
      {settings.computer.pendingEdit && (
        <Group title="Unconfirmed folder edit">
          <p className="notice">
            An existing edit is awaiting delivery. Observe that exact operation
            instead of repeating it.
          </p>
          <button
            type="button"
            className="subtle"
            onClick={() => {
              const edit = facade.getSnapshot().configuration;
              if (
                edit?.status === "ready" &&
                edit.settings.computer.pendingEdit
              )
                void facade.observeWorkspaceEdit(
                  edit.settings.computer.pendingEdit.operationId,
                );
            }}
          >
            Observe existing edit
          </button>
        </Group>
      )}
      <details>
        <summary>Protocol limits</summary>
        <p className="description">
          The current adapter has no authenticated runtime incarnation, stream
          sequence or general operation query. Only workspace edits support
          retained operation observation. Refresh cannot prove an unknown
          command did not run.
        </p>
      </details>
    </>
  );
}
