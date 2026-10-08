import {
  defaultNavigationShortcuts,
  parseNavigationShortcuts,
  type NavigationShortcuts,
} from "../../pkg/ipc/navigation-shortcuts";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import {
  ProductConfigurationCommandSchema,
  type ApprovedProductWorkspace,
  type ProductConfigurationCommand,
  type ProductSettings,
} from "../../pkg/product-settings/contract";
import { folderAccessChecked, folderDisplayName } from "../folder-access-state";
import { computerSetup } from "./computer-setup";
import { commandAllowed, dependencyFences } from "./command-eligibility";
import { updateCheckAllowed } from "./update-eligibility";
import { updateBlockMessage } from "../update-block-message";
import { ChatDirect } from "./chat-direct";
import { ChatReadonly } from "./chat-readonly";
import { ChatHistory } from "./chat-history";
import type {
  Destination,
  Intent,
  RendererFacade,
  SettingsPage,
  WindowSnapshot,
} from "./contract";

export type SettingsProps = Readonly<{
  snapshot: WindowSnapshot;
  facade: RendererFacade;
  setupStep?: "connection" | "folders" | "attachment" | undefined;
}>;
type Actions = {
  disabled: boolean;
  computerPauseReason: string | null;
  allowed(
    kind: ProductConfigurationCommand["kind"],
    workspaceId?: string,
  ): boolean;
  run(
    command: ProductConfigurationCommand,
    admit?: (current: WindowSnapshot) => boolean,
  ): Promise<Intent | null>;
};
type PageProps = SettingsProps & {
  settings: ProductSettings;
  actions: Actions;
};
const intention = (kind: string, workspaceId = "") =>
  `settings:${kind}:${workspaceId}`;
type PageFeedback = Readonly<{
  request: object;
  text: string;
  result: Intent | null;
  origin: Destination;
}>;
function createFeedback() {
  let revision = 0;
  const listeners = new Set<() => void>();
  return {
    pages: {} as Partial<Record<SettingsPage, PageFeedback>>,
    intents: {} as Record<string, Intent>,
    unretained: false,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => revision,
    changed() {
      revision++;
      listeners.forEach((listener) => listener());
    },
  };
}
// Window-owned presentation receipts survive page dismissal. No command bodies,
// credentials or authority are cached; the facade still owns operation outcomes.
const feedbackByWindow = new WeakMap<
  RendererFacade,
  ReturnType<typeof createFeedback>
>();
function useSettingsFeedback(facade: RendererFacade) {
  let feedback = feedbackByWindow.get(facade);
  if (!feedback) {
    feedback = createFeedback();
    feedbackByWindow.set(facade, feedback);
  }
  useSyncExternalStore(feedback.subscribe, feedback.getSnapshot);
  return feedback;
}
function settledEdit(
  result: Intent | "unretained" | null,
  snapshot: WindowSnapshot,
) {
  if (
    !result ||
    result === "unretained" ||
    !result.id.startsWith("settings:computer.apply-workspace-edit:")
  )
    return null;
  const current = snapshot.intents[result.id];
  return current &&
    current !== result &&
    (current.state === "applied" || current.state === "refused")
    ? current
    : null;
}
export function useSettingsAttention(
  facade: RendererFacade,
  snapshot: WindowSnapshot,
) {
  const feedback = useSettingsFeedback(facade);
  return Boolean(
    feedback.unretained ||
    Object.values(feedback.intents).some(
      (intent) => intent.state === "unknown" && !settledEdit(intent, snapshot),
    ),
  );
}
function actionFeedback(
  result: Intent,
  current?: WindowSnapshot,
  evidenceReceived = false,
): string {
  if (result.state === "pending") return "Saving or checking…";
  if (result.code === "CONNECTOR_STOP_UNCONFIRMED")
    return "Farol could not confirm that the connection stopped. The requested change is unconfirmed. Do not repeat this action; review the existing result in Diagnostics.";
  if (result.state === "unknown")
    return "Outcome unknown. Do not repeat this action; inspect the existing result in Diagnostics.";
  if (result.id.startsWith("settings:computer.apply-workspace-edit:"))
    return result.state === "applied"
      ? "Workspace edit confirmed. Review the exact result in Diagnostics."
      : "Workspace edit refused. Review the exact result in Diagnostics.";
  if (
    result.state === "applied" &&
    result.id === intention("computer.choose-workspace")
  )
    return evidenceReceived &&
      current?.evidence?.value.kind === "computer.workspace-pick"
      ? "Selection received. Confirm read-only access below to add it."
      : "Workspace selection request completed. Review the current selection below before approving access.";
  if (
    result.state === "applied" &&
    result.id === intention("computer.add-workspace")
  )
    return "Approval request completed. Only workspaces in the approved list below have saved access.";
  if (
    result.state === "applied" &&
    result.id.startsWith("settings:computer.update-access:")
  )
    return "Workspace access saved. Verify it again before using the new access.";
  if (
    result.state === "applied" &&
    result.id.startsWith("settings:computer.remove-workspace:")
  )
    return "Workspace access removed. Files on disk were not deleted.";
  if (
    result.state === "applied" &&
    result.id === intention("connector.discover-client")
  ) {
    if (
      current?.configuration?.status === "ready" &&
      current.configuration.settings.connectors.secureMcp.tunnelClient
    )
      return "Connection helper validated and selected. This does not start the connection or prove ChatGPT attachment.";
    const discovery = evidenceReceived ? current?.evidence?.value : null;
    if (discovery?.kind === "connector.client-discovery")
      return discovery.candidates.length === 0
        ? "No connection helper found. Install the helper described in the Connection guide, or choose a custom installation in Advanced connection options."
        : `${discovery.candidates.length} connection helper candidate(s) found, but no validated helper selected. Review a custom installation in Advanced connection options; candidates do not prove readiness.`;
    return "Discovery completed without a current validated selection. Review the client status and Advanced connection options.";
  }
  if (
    result.state === "applied" &&
    result.id === intention("connector.configure")
  )
    return "Connection details saved. This does not start the connection or verify access from ChatGPT.";
  if (
    result.state === "applied" &&
    (result.id === intention("connector.start") ||
      result.id === intention("connector.repair"))
  )
    return "Local connection started. Verify Farol in ChatGPT to confirm external access.";
  if (
    result.state === "applied" &&
    result.id === intention("connector.check-health")
  )
    return "Local connection checked. Access from ChatGPT has a separate verification.";
  if (result.state === "applied")
    return "Action confirmed. Check the current status below.";
  if (result.code === "TUNNEL_CLIENT_DISCOVERY_FAILED")
    return "Connection helper discovery failed. Review Diagnostics and the Connection guide; no usable helper is confirmed.";
  if (result.code === "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE")
    return "The connection helper candidate changed. It was not selected; review the installation in Advanced connection options.";
  if (
    result.code === "TUNNEL_CLIENT_SELECTION_INVALID" ||
    result.code === "TUNNEL_CLIENT_EXECUTABLE_UNSAFE"
  )
    return "The connection helper did not pass executable validation. Review Diagnostics and choose a supported installation in Advanced connection options.";
  if (
    result.code === "TUNNEL_CLIENT_INCOMPATIBLE" ||
    result.code === "TUNNEL_CLIENT_PROBE_FAILED"
  )
    return "The connection helper could not be verified as compatible. Review Diagnostics and the Connection guide before using it.";
  if (result.code === "CONNECTOR_STOP_REQUIRED")
    return "The connection must be stopped before changing workspace access, verification, its helper or credentials. Open Diagnostics, review Connection controls and choose Stop connection, then return here. Farol will not stop it automatically.";
  if (result.code === "CODEX_HOST_TASK_IN_PROGRESS")
    return "A coding task is using the current workspace access. Wait for that task to finish before changing or verifying access.";
  if (result.code === "WORKSPACE_ROOT_CHANGED")
    return "This workspace no longer has the approved root identity. Access was not changed. Review its current path and identity before verifying it again.";
  if (result.code === "WORKSPACE_NOT_FOUND")
    return "This workspace is no longer in the approved list. Refresh the list before choosing another action.";
  if (result.code?.endsWith("_CANCELLED")) return "Action cancelled.";
  if (result.code === "CHATGPT_SIGN_IN_IN_PROGRESS")
    return "Sign-in is already open in ChatGPT. Finish there, then check sign-in.";
  if (result.code === "TASK_OPERATION_IN_PROGRESS")
    return "Wait for the current task action to finish.";
  if (result.code === "MODEL_ENDPOINT_UNAVAILABLE")
    return "The model connection is unavailable. See Diagnostics for details.";
  return "This action could not be completed. Review the current status or see Diagnostics for details.";
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
function Group({
  title,
  children,
  showTitle = true,
}: {
  title: string;
  children: ReactNode;
  showTitle?: boolean;
}) {
  return (
    <section className="settings-group" aria-label={title}>
      {showTitle && <h3>{title}</h3>}
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
  admit,
}: {
  command: ProductConfigurationCommand;
  actions: Actions;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  admit?: (current: WindowSnapshot) => boolean;
}) {
  const workspaceId =
    "workspaceId" in command ? command.workspaceId : undefined;
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || !actions.allowed(command.kind, workspaceId)}
      onClick={() => void actions.run(command, admit)}
    >
      {children}
    </button>
  );
}

/** Presentation only: mounting, observation and background updates never save. */
export function Settings({ snapshot, facade, setupStep }: SettingsProps) {
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
  const retained = (current: WindowSnapshot) =>
    Object.values(feedback.intents).map(
      (intent) => settledEdit(intent, current) ?? intent,
    );
  const allowed: Actions["allowed"] = (kind, workspaceId) =>
    !feedback.unretained &&
    commandAllowed(snapshot, kind, workspaceId, retained(snapshot));
  const computerFences = dependencyFences(
    snapshot,
    "computer",
    retained(snapshot),
  );
  const computerPauseReason =
    feedback.unretained || computerFences.unknown
      ? "An operation has an unconfirmed outcome. Do not repeat it; review the existing result in Diagnostics."
      : computerFences.pending
        ? "A dependent operation is pending. Wait for its result before submitting another action."
        : snapshot.status !== "current" ||
            snapshot.runtime !== "ready" ||
            !snapshot.buildId ||
            configuration?.status !== "ready"
          ? "Current configuration or runtime status is unavailable. Refresh status before submitting an action."
          : null;
  const actions: Actions = {
    disabled: !allowed("general.update"),
    computerPauseReason,
    allowed,
    async run(command, admit) {
      const current = facade.getSnapshot();
      const page = current.destination.page;
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
        feedback.unretained ||
        composing.current ||
        !commandAllowed(
          current,
          command.kind,
          "workspaceId" in command ? command.workspaceId : undefined,
          retained(current),
        )
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
        return null;
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
        return null;
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
        return null;
      }
      feedback.pages[page] = {
        request,
        text: "",
        result: null,
        origin: current.destination,
      };
      feedback.intents[id] = { id, state: "pending", code: null };
      report("Saving or checking…", { id, state: "pending", code: null });
      try {
        const result = await facade.configure(command, id);
        // Keep every unresolved dependency, even when a newer independent
        // request owns the page message. Refresh/remount cannot settle it.
        feedback.intents[id] = result;
        const after = facade.getSnapshot();
        report(
          actionFeedback(
            result,
            soleIntent(current, after, command.kind) ? after : undefined,
            after.evidence !== current.evidence,
          ),
          result,
        );
        return result;
      } catch {
        // Keep a local fence too if an adapter throws before retaining its intent.
        feedback.unretained = true;
        feedback.intents[id] = { id, state: "unknown", code: null };
        report(
          "Outcome unknown. Do not repeat this action; inspect the existing result.",
          { id, state: "unknown", code: null },
        );
        return null;
      } finally {
        feedback.changed();
      }
    },
  };
  if (!displayedSettings)
    return (
      <div className="settings-page">
        {!setupStep && <h2>Settings</h2>}
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
    setupStep,
  };
  const pageFeedback = feedback.pages[snapshot.destination.page];
  const settled = settledEdit(pageFeedback?.result ?? null, snapshot);
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
      {pageFeedback &&
        !(
          snapshot.destination.page === "folders" &&
          pageFeedback.result?.id.match(
            /settings:computer\.(?:check-folder|verify-workspace|update-access):/u,
          )
        ) && (
          <p className="notice" role="status">
            {settled ? actionFeedback(settled) : pageFeedback.text}
          </p>
        )}
      {actions.disabled && (
        <p className="notice">
          Some actions are paused while state is stale, a dependent action is
          pending, or its outcome is unconfirmed. Refresh observes status; it
          does not replay an action.
        </p>
      )}
      <div hidden={snapshot.destination.page !== "general"}>
        <button
          type="button"
          className="subtle"
          onClick={() => facade.navigate({ area: "setup" })}
        >
          Review Setup
        </button>
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
      <div hidden={snapshot.destination.page !== "shortcuts"}>
        <Shortcuts {...props} />
      </div>
      <div hidden={snapshot.destination.page !== "updates"}>
        <Updates {...props} />
      </div>
      <div
        hidden={
          snapshot.destination.page !== "diagnostics" &&
          snapshot.destination.page !== "model"
        }
      >
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
      <h3>Startup and navigation</h3>
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
            Choose what Farol shows when it opens. Home is always available in
            the sidebar.
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
            This choice applies when Farol opens. Use the toolbar button to show
            or hide the page list during a session.
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    settings.computer.workspaces.find(
      (item) => item.workspaceId === selectedId,
    ) ?? settings.computer.workspaces[0];
  const detailId = useId();
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
      {!props.setupStep && <h2>Workspaces</h2>}
      {!props.setupStep && (
        <p className="description">
          Choose the workspaces Farol may access. Each workspace has its own
          access level and check. Removing a workspace revokes access and keeps
          its files.
        </p>
      )}
      {selected && (
        <div className="workspace-layout">
          <nav className="workspace-picker" aria-label="Approved workspaces">
            {settings.computer.workspaces.map((workspace) => (
              <button
                key={workspace.workspaceId}
                type="button"
                className="workspace-choice"
                aria-label={`Select workspace ${folderDisplayName(workspace)}`}
                aria-current={
                  workspace.workspaceId === selected.workspaceId
                    ? "true"
                    : undefined
                }
                aria-controls={detailId}
                onClick={() => setSelectedId(workspace.workspaceId)}
              >
                <strong>{folderDisplayName(workspace)}</strong>
                <span>
                  {workspace.access === "read" ? "Read-only" : "Read & write"}
                </span>
                <span className="workspace-choice-path">{workspace.root}</span>
              </button>
            ))}
          </nav>
          <WorkspaceDetail
            key={selected.workspaceId}
            {...props}
            workspace={selected}
            detailId={detailId}
          />
        </div>
      )}
      <div className="workspace-add">
        <div className="control-row">
          <button
            type="button"
            className="primary"
            disabled={!actions.allowed("computer.choose-workspace")}
            onClick={() => void choose()}
          >
            Add workspace…
          </button>
          {pickCurrent && (
            <button
              type="button"
              className="primary"
              disabled={!actions.allowed("computer.add-workspace")}
              onClick={() => {
                const before = facade.getSnapshot();
                const evidence = before.evidence;
                if (
                  evidence !== picked ||
                  evidence?.value.kind !== "computer.workspace-pick"
                )
                  return;
                setPicked(null);
                void actions
                  .run({
                    kind: "computer.add-workspace",
                    selectionId: evidence.value.selectionId,
                  })
                  .then((result) => {
                    if (result?.state !== "applied") return;
                    const after = facade.getSnapshot();
                    const selected = after.evidence?.value;
                    if (
                      after.evidence !== before.evidence &&
                      selected?.kind === "computer.workspace-selection" &&
                      after.configuration?.status === "ready" &&
                      after.evidence?.revision ===
                        after.configuration.settings.revision &&
                      soleIntent(before, after, "computer.add-workspace") &&
                      after.configuration.settings.computer.workspaces.some(
                        (item) => item.workspaceId === selected.workspaceId,
                      )
                    )
                      setSelectedId(selected.workspaceId);
                  });
              }}
            >
              Add selected workspace read-only
            </button>
          )}
        </div>
        {!actions.allowed("computer.choose-workspace") && (
          <p className="description">
            Workspace selection and approval are paused.{" "}
            {actions.computerPauseReason}
          </p>
        )}
        {pickCurrent && (
          <p className="description" role="status">
            {picked.value.kind === "computer.workspace-pick" &&
              picked.value.displayPath && (
                <>
                  Selected workspace: <code>{picked.value.displayPath}</code>
                  .{" "}
                </>
              )}
            Selection received; access is not approved yet. Confirm read-only
            access to add the selection, then review its saved path in the
            approved list.
          </p>
        )}
        {picked && !pickCurrent && (
          <p className="notice">
            The selection is no longer current. Choose the workspace again
            before adding it.
          </p>
        )}
        {settings.computer.workspaces.length === 0 && (
          <p className="description">
            No workspaces approved. Local file access is optional.
          </p>
        )}
      </div>
    </>
  );
}
// Draft admission binds presentation to the exact Computer scope. Local
// selection is never a Computer grant or a replacement for the host guards.
function workspaceScope(snapshot: WindowSnapshot, workspaceId: string) {
  if (snapshot.configuration?.status !== "ready") return null;
  const settings = snapshot.configuration.settings;
  const workspace = settings.computer.workspaces.find(
    (item) => item.workspaceId === workspaceId,
  );
  return workspace
    ? JSON.stringify([
        snapshot.buildId,
        settings.computer.generation,
        workspace.workspaceId,
        workspace.root,
        workspace.rootIdentity,
        workspace.access,
        workspace.excludedPaths,
        workspace.gitHistoryApproved,
        workspace.gitMetadata,
      ])
    : null;
}
function workspaceChecked(
  snapshot: WindowSnapshot,
  workspace: ApprovedProductWorkspace,
) {
  return (
    snapshot.status === "current" &&
    snapshot.runtime === "ready" &&
    snapshot.configuration?.status === "ready" &&
    !snapshot.configuration.settings.setup.computer.outcomeUnknown &&
    Boolean(
      snapshot.buildId &&
      folderAccessChecked(
        snapshot.configuration.settings,
        workspace,
        snapshot.buildId,
      ),
    )
  );
}
function workspaceCurrent(
  snapshot: WindowSnapshot,
  workspace: ApprovedProductWorkspace,
) {
  const settings =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings
      : null;
  const verified = settings?.setup.computer.verified;
  return (
    workspaceChecked(snapshot, workspace) &&
    settings?.setup.computer.reachable === "reachable" &&
    verified?.workspaceId === workspace.workspaceId &&
    verified.buildId === snapshot.buildId &&
    verified.configRevision === settings?.computer.generation
  );
}
function WorkspaceDetail({
  workspace,
  snapshot,
  facade,
  actions,
  detailId,
}: PageProps & { workspace: ApprovedProductWorkspace; detailId: string }) {
  const name = folderDisplayName(workspace);
  const scope = workspaceScope(snapshot, workspace.workspaceId);
  const [draft, setDraft] = useState<{
    access: ApprovedProductWorkspace["access"];
    scope: string | null;
  } | null>(null);
  const [removal, setRemoval] = useState<{ scope: string | null } | null>(null);
  const [stopReview, setStopReview] = useState(false);
  const [stopResult, setStopResult] = useState<Intent | null>(null);
  const feedback = useSettingsFeedback(facade);
  const receipts = Object.values(feedback.intents).filter(
    (intent) =>
      intent.id.endsWith(`:${workspace.workspaceId}`) &&
      /^settings:computer\.(?:check-folder|verify-workspace|update-access|remove-workspace):/u.test(
        intent.id,
      ),
  );
  const stopRequired = receipts.some(
    (intent) =>
      intent.state === "refused" && intent.code === "CONNECTOR_STOP_REQUIRED",
  );
  const checked = workspaceChecked(snapshot, workspace);
  const current = workspaceCurrent(snapshot, workspace);
  const verifyKind = current
    ? "computer.check-folder"
    : "computer.verify-workspace";
  const stale = draft !== null && (scope === null || draft.scope !== scope);
  const removalStale =
    removal !== null && (scope === null || removal.scope !== scope);
  const access = draft?.access ?? workspace.access;
  const changed = access !== workspace.access;
  const admitScope = (latest: WindowSnapshot) =>
    scope !== null && workspaceScope(latest, workspace.workspaceId) === scope;
  return (
    <section
      id={detailId}
      className="workspace-detail"
      aria-label={`Workspace ${name}`}
    >
      <div className="workspace-heading">
        <h3>{name}</h3>
        <button
          type="button"
          className="subtle workspace-remove"
          aria-label={`Remove workspace ${name}`}
          disabled={
            !actions.allowed("computer.remove-workspace", workspace.workspaceId)
          }
          onClick={() => setRemoval({ scope })}
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
          </svg>
          Remove
        </button>
      </div>
      <p className="workspace-path">
        <code>{workspace.root}</code>
      </p>
      <p className="description">
        Saved access:{" "}
        {workspace.access === "read"
          ? "Read-only"
          : "Read & write · approval required"}
        .
      </p>
      <p className="badges">
        {checked ? "Access checked" : "Check access needed"}
      </p>
      <p className="description">
        {current
          ? "Current workspace for Connection. Verify workspace checks access without changing its binding."
          : "Verify workspace checks access and prepares this workspace for Connection."}
      </p>
      <form
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(null);
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft || !changed || stale) return;
          void actions
            .run(
              {
                kind: "computer.update-access",
                workspaceId: workspace.workspaceId,
                access,
              },
              admitScope,
            )
            .then((result) => {
              // A refused/unknown save retains its draft and existing fence.
              if (result?.state === "applied")
                setDraft((latest) => (latest === draft ? null : latest));
            });
        }}
      >
        <label className="setting-row">
          Workspace access
          <select
            className="field"
            value={access}
            onChange={(event) =>
              setDraft({
                access: event.currentTarget
                  .value as ApprovedProductWorkspace["access"],
                scope: draft ? draft.scope : scope,
              })
            }
          >
            <option value="read">Read-only</option>
            <option value="write">Read &amp; write</option>
          </select>
        </label>
        <p className="description">
          Read &amp; write allows guarded changes that still require approval.
          Saving access changes requires a fresh check.
        </p>
        {stale && (
          <p className="notice" role="status">
            Workspace access or identity changed while this draft was open.
            Cancel to review the saved access before editing again.
          </p>
        )}
        <div className="control-row">
          <button
            type="submit"
            className="primary"
            disabled={
              !changed ||
              !draft ||
              stale ||
              !actions.allowed("computer.update-access", workspace.workspaceId)
            }
          >
            Save
          </button>
          <button
            type="button"
            className="subtle"
            disabled={!draft}
            onClick={() => setDraft(null)}
          >
            Cancel
          </button>
        </div>
      </form>
      {removal && (
        <div
          className="notice workspace-removal"
          role="group"
          aria-label={`Confirm removal of ${name}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setRemoval(null);
            }
          }}
        >
          <p>
            Remove {name}? This revokes Farol access to this workspace and keeps
            its files on disk.
          </p>
          {removalStale && (
            <p role="status">
              Workspace access or identity changed. Cancel and review the
              workspace before removing it.
            </p>
          )}
          <div className="control-row">
            <button
              type="button"
              className="subtle"
              disabled={
                removalStale ||
                !actions.allowed(
                  "computer.remove-workspace",
                  workspace.workspaceId,
                )
              }
              onClick={() => {
                void actions
                  .run(
                    {
                      kind: "computer.remove-workspace",
                      workspaceId: workspace.workspaceId,
                    },
                    admitScope,
                  )
                  .then((result) => {
                    if (result?.state === "applied") setRemoval(null);
                  });
              }}
            >
              Confirm removal
            </button>
            <button
              type="button"
              className="subtle"
              onClick={() => setRemoval(null)}
            >
              Keep workspace
            </button>
          </div>
        </div>
      )}
      <div className="workspace-feedback" aria-label="Workspace action status">
        {receipts.map((intent) => (
          <p key={intent.id} className="notice" role="status">
            {intent.id.startsWith("settings:computer.update-access:")
              ? "Save access: "
              : intent.id.startsWith("settings:computer.remove-workspace:")
                ? "Remove workspace: "
                : "Verify workspace: "}
            {actionFeedback(intent)}
          </p>
        ))}
        {actions.computerPauseReason && (
          <p className="description" role="status">
            {actions.computerPauseReason}
          </p>
        )}
        {stopRequired && (
          <div className="workspace-stop-review">
            <p className="description">
              The last access action was refused because the connection was
              running. If it has since stopped, review and submit the change
              again. Farol will not repeat it automatically.
            </p>
            {!stopReview ? (
              <button
                type="button"
                className="subtle"
                disabled={!actions.allowed("connector.stop")}
                onClick={() => setStopReview(true)}
              >
                Review stop connection
              </button>
            ) : (
              <div role="group" aria-label="Confirm stop connection">
                <p className="notice">
                  Stopping disconnects Farol from ChatGPT. Finish current work
                  before continuing. Your workspace draft stays here; submit it
                  separately after the stop is confirmed.
                </p>
                <button
                  type="button"
                  className="subtle"
                  disabled={!actions.allowed("connector.stop")}
                  onClick={() => {
                    setStopReview(false);
                    void actions
                      .run({ kind: "connector.stop" })
                      .then(setStopResult);
                  }}
                >
                  Stop connection
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setStopReview(false)}
                >
                  Keep connection
                </button>
              </div>
            )}
            {stopResult && (
              <p role="status" className="notice">
                {stopResult.state === "applied"
                  ? "Connection stop confirmed. Review the workspace and submit its change separately."
                  : actionFeedback(stopResult)}
              </p>
            )}
          </div>
        )}
        {receipts.some(
          (intent) => intent.state === "unknown" || intent.state === "refused",
        ) && (
          <button
            type="button"
            className="text-button"
            onClick={() =>
              facade.navigate({ area: "settings", page: "diagnostics" })
            }
          >
            Workspace diagnostics
          </button>
        )}
      </div>
      <Command
        actions={actions}
        className="primary"
        disabled={Boolean(draft || removal)}
        command={{ kind: verifyKind, workspaceId: workspace.workspaceId }}
        admit={(latest) =>
          admitScope(latest) && workspaceCurrent(latest, workspace) === current
        }
      >
        Verify workspace
      </Command>
    </section>
  );
}
function FolderOptions({
  workspace,
  settings,
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
  return (
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
            Workspace access changed while this draft was open. Reload the saved
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
  );
}
type EditReview = Readonly<{
  evidence: NonNullable<WindowSnapshot["evidence"]>;
  configuration: WindowSnapshot["configuration"];
  buildId: string;
  revision: number;
  generation: number;
}>;
function editScope(current: WindowSnapshot, workspaceId: string) {
  if (current.configuration?.status !== "ready") return null;
  const settings = current.configuration.settings;
  return JSON.stringify([
    settings.computer.workspaces.find(
      (item) => item.workspaceId === workspaceId,
    ),
    settings.setup.computer,
  ]);
}
function editableWorkspace(current: WindowSnapshot, workspaceId: string) {
  if (current.status !== "current" || current.configuration?.status !== "ready")
    return false;
  const settings = current.configuration.settings;
  const workspace = settings.computer.workspaces.find(
    (item) => item.workspaceId === workspaceId,
  );
  const verified = settings.setup.computer.verified;
  return Boolean(
    workspace?.access === "write" &&
    current.buildId &&
    folderAccessChecked(settings, workspace, current.buildId) &&
    verified?.workspaceId === workspaceId &&
    verified.configRevision === settings.computer.generation &&
    verified.buildId === current.buildId &&
    settings.setup.computer.reachable === "reachable" &&
    !settings.setup.computer.outcomeUnknown,
  );
}
function liveEdit(
  current: WindowSnapshot,
  review: EditReview | null,
  workspaceId: string,
) {
  const evidence = review?.evidence.value;
  return Boolean(
    review &&
    current.evidence === review.evidence &&
    current.configuration === review.configuration &&
    current.buildId === review.buildId &&
    current.configuration?.status === "ready" &&
    current.configuration.settings.revision === review.revision &&
    current.configuration.settings.computer.generation === review.generation &&
    review.evidence.revision === review.revision &&
    evidence?.kind === "computer.workspace-edit-preview" &&
    evidence.workspaceId === workspaceId &&
    Date.parse(evidence.expiresAt) > Date.now() &&
    editableWorkspace(current, workspaceId),
  );
}
function editConsumed(current: WindowSnapshot, operationId: string) {
  // Exact operation keys retain the one-shot UI disposition across remounts.
  // This does not clear uncertainty or change the facade's dispatch policy.
  return Boolean(
    current.intents[intention("computer.apply-workspace-edit", operationId)] ||
    current.intents[intention("computer.cancel-workspace-edit", operationId)],
  );
}
function GuardedEdit({
  workspace,
  snapshot,
  facade,
  actions,
}: PageProps & {
  workspace: ApprovedProductWorkspace;
}) {
  const [review, setReview] = useState<EditReview | null>(null);
  const [oldText, setOldText] = useState("");
  const [newText, setNewText] = useState("");
  const [notice, setNotice] = useState("");
  const consumed = useRef(new Set<string>());
  const preparing = useRef(false);
  const mounted = useRef(true);
  const observation = useRef<(() => void) | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      observation.current?.();
      observation.current = null;
    };
  }, []);
  const preview = review?.evidence.value;
  const selected =
    preview?.kind === "computer.workspace-edit-preview" ? preview : null;
  const live =
    liveEdit(snapshot, review, workspace.workspaceId) &&
    Boolean(
      selected &&
      !consumed.current.has(selected.operationId) &&
      !editConsumed(snapshot, selected.operationId),
    );
  async function prepare() {
    const before = facade.getSnapshot();
    if (
      preparing.current ||
      !commandAllowed(
        before,
        "computer.prepare-workspace-edit",
        workspace.workspaceId,
      ) ||
      (liveEdit(before, review, workspace.workspaceId) &&
        selected &&
        !consumed.current.has(selected.operationId)) ||
      !editableWorkspace(before, workspace.workspaceId)
    )
      return;
    preparing.current = true;
    const id = intention(
      "computer.prepare-workspace-edit",
      workspace.workspaceId,
    );
    let pending: Intent | null = null;
    let observed: WindowSnapshot["evidence"] = null;
    let previous = before;
    let configurations = 0;
    let raced = false;
    // Observe the same pending intent -> evidence -> terminal intent transition.
    // A final snapshot alone cannot distinguish foreign or overwritten evidence.
    const dispose = facade.subscribe(() => {
      const current = facade.getSnapshot();
      if (
        current.status !== "current" ||
        current.buildId !== before.buildId ||
        current.configuration?.status !== "ready" ||
        before.configuration?.status !== "ready" ||
        current.configuration.settings.revision !==
          before.configuration.settings.revision ||
        current.configuration.settings.computer.generation !==
          before.configuration.settings.computer.generation ||
        editScope(current, workspace.workspaceId) !==
          editScope(before, workspace.workspaceId) ||
        Object.keys({ ...before.intents, ...current.intents }).some(
          (key) => key !== id && before.intents[key] !== current.intents[key],
        )
      )
        raced = true;
      if (current.configuration !== previous.configuration) configurations++;
      if (configurations > 1) raced = true;
      const intent = current.intents[id];
      if (intent?.state === "pending") {
        if (pending && pending !== intent) raced = true;
        pending = intent;
      }
      if (current.evidence !== previous.evidence && current.evidence) {
        if (!pending || intent !== pending || observed) raced = true;
        observed = current.evidence;
      } else if (observed && current.evidence !== observed) raced = true;
      previous = current;
    });
    observation.current = dispose;
    try {
      const result = await actions.run({
        kind: "computer.prepare-workspace-edit",
        workspaceId: workspace.workspaceId,
      });
      const current = facade.getSnapshot();
      const evidence = current.evidence;
      const value = evidence?.value;
      const candidate: EditReview | null =
        evidence && current.buildId && current.configuration?.status === "ready"
          ? {
              evidence,
              configuration: current.configuration,
              buildId: current.buildId,
              revision: current.configuration.settings.revision,
              generation: current.configuration.settings.computer.generation,
            }
          : null;
      const ambient = before.evidence?.value;
      if (!mounted.current) return;
      if (
        result?.state === "applied" &&
        result.id === id &&
        current.intents[id] === result &&
        pending &&
        !raced &&
        observed === evidence &&
        value?.kind === "computer.workspace-edit-preview" &&
        !(
          ambient?.kind === "computer.workspace-edit-preview" &&
          ambient.operationId === value.operationId &&
          JSON.stringify(ambient) !== JSON.stringify(value)
        ) &&
        !consumed.current.has(value.operationId) &&
        !editConsumed(current, value.operationId) &&
        liveEdit(current, candidate, workspace.workspaceId) &&
        commandAllowed(
          current,
          "computer.prepare-workspace-edit",
          workspace.workspaceId,
        )
      ) {
        setReview(candidate);
        setNotice("");
      } else if (result) {
        setNotice(
          "The file preview could not be confirmed for this request. Check current status before continuing.",
        );
      }
    } finally {
      dispose();
      observation.current = null;
      preparing.current = false;
    }
  }
  function finish(
    kind: "computer.apply-workspace-edit" | "computer.cancel-workspace-edit",
  ) {
    if (!selected) return;
    const command: ProductConfigurationCommand =
      kind === "computer.apply-workspace-edit"
        ? { kind, operationId: selected.operationId, oldText, newText }
        : { kind, operationId: selected.operationId };
    void actions.run(command, (current) => {
      if (
        !liveEdit(current, review, workspace.workspaceId) ||
        consumed.current.has(selected.operationId) ||
        editConsumed(current, selected.operationId)
      )
        return false;
      consumed.current.add(selected.operationId);
      setReview(null);
      setNotice(
        kind === "computer.apply-workspace-edit"
          ? "Edit submitted once. Use Diagnostics to observe any unconfirmed result, then acknowledge the exact delivered result."
          : "Cancellation submitted for the selected preview.",
      );
      return true;
    });
  }
  const validText =
    selected &&
    ProductConfigurationCommandSchema.safeParse({
      kind: "computer.apply-workspace-edit",
      operationId: selected.operationId,
      oldText,
      newText,
    }).success;
  return (
    <section aria-label={`Guarded edit for ${folderDisplayName(workspace)}`}>
      <h4>Guarded text edit</h4>
      <p className="description">
        Choose a text file, then replace one unique occurrence of the old text.
        Empty replacement text deletes that occurrence.
      </p>
      <button
        type="button"
        className="subtle"
        disabled={
          live ||
          !editableWorkspace(snapshot, workspace.workspaceId) ||
          !actions.allowed(
            "computer.prepare-workspace-edit",
            workspace.workspaceId,
          )
        }
        onClick={() => void prepare()}
      >
        Prepare edit…
      </button>
      {selected && (
        <p className="description">
          Selected file: {selected.relativePath} · {selected.bytes} bytes.
        </p>
      )}
      {selected && (
        <details>
          <summary>File details</summary>
          <p className="description">
            SHA-256: {selected.beforeSha256}. Expires: {selected.expiresAt}.
          </p>
        </details>
      )}
      {selected && !live && (
        <p className="notice">
          This preview is no longer current. Prepare and review the file again.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          finish("computer.apply-workspace-edit");
        }}
      >
        <label className="setting-row">
          Old text
          <textarea
            className="field"
            value={oldText}
            maxLength={32_768}
            onChange={(event) => setOldText(event.currentTarget.value)}
          />
        </label>
        <label className="setting-row">
          New text
          <textarea
            className="field"
            value={newText}
            maxLength={32_768}
            onChange={(event) => setNewText(event.currentTarget.value)}
          />
        </label>
        <div className="control-row">
          <button
            className="primary"
            disabled={
              !live ||
              !validText ||
              !actions.allowed("computer.apply-workspace-edit")
            }
          >
            Apply edit
          </button>
          <button
            type="button"
            className="subtle"
            disabled={
              !live || !actions.allowed("computer.cancel-workspace-edit")
            }
            onClick={() => finish("computer.cancel-workspace-edit")}
          >
            Cancel edit
          </button>
        </div>
      </form>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
function ThisMac({ settings, snapshot, facade, actions }: PageProps) {
  const [commands, setCommands] = useState(settings.computer.commands);
  const [filePolicy, setFilePolicy] = useState(
    settings.computer.filePolicy ?? "",
  );
  return (
    <>
      <h2>This Mac</h2>
      <p className="description">
        Terminal &amp; Git access is optional. After changing workspace or
        command access, verify the workspace again in Workspaces, then open
        Connection to start or reconnect explicitly.
      </p>
      <button
        type="button"
        className="text-button"
        onClick={() => facade.navigate({ area: "settings", page: "folders" })}
      >
        Review workspace verification
      </button>
      <Group title="Local service">
        <div className="setting-row">
          <strong>{settings.computer.name}</strong>
          <span className="badges">
            {snapshot.runtime === "ready" ? "Available" : "Unavailable"}
          </span>
        </div>
        <p className="description">
          Local service status is independent of connection verification and
          workspace access.
        </p>
      </Group>
      <Group title="Files in approved workspaces">
        <p className="description">
          Your existing file policy stays in effect until you save a new choice.
          Allowing all names includes hidden and sensitive files inside approved
          folders. A file linked into an approved folder can be accessible
          there. Explicit folder exclusions remain in place.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void actions.run({
              kind: "computer.update-file-policy",
              filePolicy,
            });
          }}
        >
          <label className="setting-row">
            File access
            <select
              className="field"
              value={filePolicy}
              onChange={(event) =>
                setFilePolicy(event.currentTarget.value as typeof filePolicy)
              }
            >
              <option value="">Keep protected-file restrictions</option>
              <option value="approved-roots-v1">
                Allow all names in approved folders
              </option>
            </select>
          </label>
          <p className="description">
            Saving requires a stopped connection and fresh folder verification.
            It does not grant another folder or enable Terminal access.
          </p>
          <button
            className="primary"
            disabled={!actions.allowed("computer.update-file-policy")}
          >
            Save file permissions
          </button>
        </form>
      </Group>
      <Group title="Terminal & Git">
        <p className="description">
          {settings.computer.commands === "none"
            ? "Saved command permission: off."
            : settings.computer.commands === "verification"
              ? "Saved command permission: Git checks only."
              : "Saved command permission: Terminal in approved folders."}{" "}
          Changing saved permissions requires workspace verification again.
        </p>
        <p className="description">
          Command capability: unavailable in this beta. Shell and Git execution
          are not active through the external connector.
        </p>
        <p className="description">
          Command verification: not qualified for this beta. File and connection
          checks do not verify command execution. File Computer can be ready
          independently of command availability.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void actions.run({ kind: "computer.update-commands", commands });
          }}
        >
          <label className="setting-row">
            Command access
            <select
              className="field"
              value={commands}
              onChange={(event) =>
                setCommands(event.currentTarget.value as typeof commands)
              }
            >
              <option value="none">Off</option>
              <option value="verification">Git checks only</option>
              <option value="workspace">Terminal in approved folders</option>
            </select>
          </label>
          <p className="description">
            Saving preserves your permission choice; it does not activate
            command execution in this beta. Review technical limits in
            Diagnostics.
          </p>
          <button
            className="primary"
            disabled={!actions.allowed("computer.update-commands")}
          >
            Save permissions
          </button>
        </form>
      </Group>
    </>
  );
}
function Connection({
  settings,
  snapshot,
  facade,
  actions,
  setupStep,
}: PageProps) {
  const connector = settings.connectors.secureMcp;
  const setup = computerSetup(snapshot);
  const externalChallenge = setup.externalChallenge;
  const connectorName = snapshot.environment === "dev" ? "Farol Dev" : "Farol";
  const [copiedVerification, setCopiedVerification] = useState<string | null>(
    null,
  );
  const [copyError, setCopyError] = useState<string | null>(null);
  const verificationIdentity = externalChallenge
    ? JSON.stringify([
        externalChallenge.tunnelId,
        externalChallenge.workspaceId,
        externalChallenge.value,
      ])
    : null;
  const verificationRequest = externalChallenge
    ? `Please use the ${connectorName} connector to call ` +
      "farol_next_connector_verify exactly once with " +
      JSON.stringify({
        challenge: externalChallenge.value,
        workspaceId: externalChallenge.workspaceId,
      }) +
      ". Report the result; do not write files."
    : null;
  const [tunnelId, setTunnelId] = useState(connector.tunnelId ?? "");
  const [key, setKey] = useState("");
  const [keyVisible, setKeyVisible] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const saved = connector.credential === "stored";
  const editing = !saved || replacing;
  const replacementUnconfirmed =
    snapshot.intents[intention("connector.configure")]?.state === "unknown";
  const keyComposing = useRef(false);
  const credentialFeedbackId = useId();
  const credentialInput = ProductConfigurationCommandSchema.safeParse({
    kind: "connector.configure",
    tunnelId,
    runtimeKey: key,
  });
  const tunnelInvalid =
    !credentialInput.success &&
    credentialInput.error.issues.some((issue) => issue.path[0] === "tunnelId");
  const keyInvalid =
    !credentialInput.success &&
    credentialInput.error.issues.some(
      (issue) => issue.path[0] === "runtimeKey",
    );
  const credentialFeedback = tunnelInvalid
    ? "Enter the Tunnel ID from Tunnels: 1–160 letters, numbers, periods, underscores, colons or hyphens, without spaces or line breaks."
    : keyInvalid
      ? "Enter the complete runtime key: 20–512 printable ASCII characters, without spaces or line breaks."
      : "Credential format is valid. Saving does not start the connection or prove ChatGPT attachment.";
  const credentialPauseReason = !actions.allowed("connector.configure")
    ? actions.computerPauseReason
    : null;
  const connectionStatus =
    setup.label === "Outcome unknown" ||
    setup.label === "Connection check pending"
      ? setup.label
      : setup.ready
        ? "Computer ready"
        : setup.localConnectionCurrent
          ? "Connected to this Mac · ChatGPT check needed"
          : !saved
            ? "Connection details needed"
            : !connector.tunnelClient
              ? "Connection helper needed"
              : !setup.workspacesVerified
                ? "Workspace verification needed"
                : setup.canStart
                  ? "Ready to connect"
                  : setup.canReconnect
                    ? "Connection needs recovery"
                    : setup.label;
  const connectionDiagnostics = (
    <button
      type="button"
      className="text-button"
      onClick={() => facade.navigate({ area: "settings", page: "diagnostics" })}
    >
      Connection diagnostics
    </button>
  );
  return (
    <>
      {!setupStep && <h2>Connection</h2>}
      <div hidden={setupStep !== undefined && setupStep !== "connection"}>
        <Group title="This Mac connection" showTitle={!setupStep}>
          <p className="badges" role="status">
            {connectionStatus}
          </p>
          {saved && !setup.ready && <p className="description">{setup.next}</p>}
          {saved && (
            <div
              className="credentials-saved"
              data-unconfirmed={replacementUnconfirmed}
              role="status"
            >
              <strong>
                {replacementUnconfirmed
                  ? "Credential replacement unconfirmed"
                  : "Tunnel credentials saved"}
              </strong>
              <p className="description">
                {replacementUnconfirmed
                  ? "Do not submit another replacement. Review the existing result in Diagnostics."
                  : "The saved key stays private. Edit only when these details change."}
              </p>
              {!replacing && (
                <button
                  type="button"
                  className="subtle"
                  disabled={!actions.allowed("connector.configure")}
                  onClick={() => {
                    setTunnelId(connector.tunnelId ?? "");
                    setKey("");
                    setKeyVisible(false);
                    setReplacing(true);
                  }}
                >
                  Edit connection
                </button>
              )}
            </div>
          )}
          {editing && (
            <form
              className="connection-credentials"
              autoComplete="off"
              onCompositionStart={() => {
                keyComposing.current = true;
              }}
              onCompositionEnd={() => {
                keyComposing.current = false;
              }}
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  keyComposing.current ||
                  !actions.allowed("connector.configure")
                )
                  return;
                const command: ProductConfigurationCommand = {
                  kind: "connector.configure",
                  tunnelId,
                  runtimeKey: key,
                };
                if (
                  !key.trim() ||
                  !ProductConfigurationCommandSchema.safeParse(command).success
                )
                  return;
                setKey("");
                setKeyVisible(false);
                void actions.run(command).then((result) => {
                  if (result?.state === "applied") setReplacing(false);
                });
              }}
            >
              <label className="setting-row">
                Tunnel ID
                <input
                  className="field"
                  value={tunnelId}
                  aria-describedby={`${credentialFeedbackId} ${credentialFeedbackId}-pause`}
                  aria-invalid={tunnelId.length > 0 && tunnelInvalid}
                  onChange={(event) => setTunnelId(event.currentTarget.value)}
                  required
                  maxLength={160}
                />
              </label>
              <label className="setting-row">
                Runtime key
                <input
                  id={`${credentialFeedbackId}-key`}
                  className="field"
                  type={keyVisible ? "text" : "password"}
                  autoComplete="new-password"
                  spellCheck={false}
                  value={key}
                  aria-describedby={`${credentialFeedbackId} ${credentialFeedbackId}-pause`}
                  aria-invalid={key.length > 0 && keyInvalid}
                  onChange={(event) => {
                    setKey(event.currentTarget.value);
                    if (event.currentTarget.value.length === 0)
                      setKeyVisible(false);
                  }}
                  maxLength={512}
                  required
                />
              </label>
              <button
                type="button"
                className="text-button"
                aria-controls={`${credentialFeedbackId}-key`}
                aria-pressed={keyVisible}
                disabled={key.length === 0}
                onClick={() => setKeyVisible((visible) => !visible)}
              >
                {keyVisible ? "Hide runtime key" : "Show runtime key"}
              </button>
              <p
                id={credentialFeedbackId}
                className="description credential-entry-feedback"
                role="status"
              >
                {credentialFeedback}
              </p>
              <p
                id={`${credentialFeedbackId}-pause`}
                className="description credential-pause-feedback"
                role="status"
              >
                {credentialPauseReason &&
                  `Saving is paused. ${credentialPauseReason}`}
              </p>
              <p className="description">
                The key stays private and is cleared from this field when
                submitted.
              </p>
              <button
                className="primary"
                disabled={
                  !key.trim() ||
                  !ProductConfigurationCommandSchema.safeParse({
                    kind: "connector.configure",
                    tunnelId,
                    runtimeKey: key,
                  }).success ||
                  !actions.allowed("connector.configure")
                }
              >
                Save credentials
              </button>
              <button
                type="button"
                className="subtle"
                onClick={() => {
                  setKey("");
                  setKeyVisible(false);
                  setTunnelId(connector.tunnelId ?? "");
                  setReplacing(false);
                }}
              >
                Cancel
              </button>
            </form>
          )}
          {!saved && !connector.tunnelClient && (
            <Command
              actions={actions}
              command={{ kind: "connector.discover-client" }}
            >
              Find connection helper
            </Command>
          )}
          {saved && !replacing && !setup.workspacesVerified && (
            <button
              type="button"
              className="text-button"
              onClick={() =>
                facade.navigate(
                  setupStep
                    ? { area: "setup", setupStep: "folders" }
                    : { area: "settings", page: "folders" },
                )
              }
            >
              Verify a workspace
            </button>
          )}
          {saved && !replacing && connector.tunnelClient && setup.canStart && (
            <Command
              actions={actions}
              admit={(current) => computerSetup(current).canStart}
              command={{ kind: "connector.start" }}
              className="primary"
            >
              Connect this Mac
            </Command>
          )}
          {saved &&
            !replacing &&
            connector.tunnelClient &&
            !setup.localConnectionCurrent &&
            setup.canReconnect && (
              <Command
                actions={actions}
                admit={(current) => computerSetup(current).canReconnect}
                command={{ kind: "connector.repair" }}
                className="primary"
              >
                Reconnect
              </Command>
            )}
          {saved && !replacing && setup.localConnectionCurrent && (
            <Command
              actions={actions}
              command={{ kind: "connector.check-health" }}
              className="primary"
            >
              Check connection
            </Command>
          )}
          {saved && !replacing && !connector.tunnelClient && (
            <Command
              actions={actions}
              command={{ kind: "connector.discover-client" }}
              className="primary"
            >
              Find connection helper
            </Command>
          )}
          {setupStep ? (
            <details className="setup-help">
              <summary>Connection help</summary>
              <p className="description">
                Review detailed status or an unconfirmed result in Diagnostics.
                Opening help does not repeat an action.
              </p>
              {connectionDiagnostics}
            </details>
          ) : (
            connectionDiagnostics
          )}
        </Group>
      </div>
      <div hidden={setupStep !== undefined && setupStep !== "attachment"}>
        <Group title="Add to ChatGPT" showTitle={!setupStep}>
          {!setupStep && (
            <p className="description">
              Attach this {connectorName} connection in ChatGPT, then ask
              ChatGPT to verify it. Farol never sends the request for you.
            </p>
          )}
          <ol className="attachment-steps">
            <li>
              Open Tunnels in ChatGPT and attach this {connectorName}
              connection.
            </li>
            <li>
              Copy the current verification request and send it in ChatGPT.
            </li>
            <li>Return here to check the recorded attachment result.</li>
          </ol>
          <div className="control-row">
            <Command
              actions={actions}
              command={{ kind: "onboarding.open-help", destination: "tunnels" }}
            >
              Open Tunnels
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
          {externalChallenge && (
            <div
              className="connector-challenge"
              data-connector-challenge="pending"
            >
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  // Copy is the owner's explicit local action. It neither
                  // submits a provider message nor changes connector state.
                  try {
                    if (!navigator.clipboard?.writeText)
                      throw new Error("CLIPBOARD_UNAVAILABLE");
                    await navigator.clipboard.writeText(verificationRequest!);
                    setCopiedVerification(verificationIdentity);
                    setCopyError(null);
                  } catch {
                    setCopiedVerification(null);
                    setCopyError(verificationIdentity);
                  }
                }}
              >
                Copy verification request
              </button>
              {copiedVerification === verificationIdentity && (
                <p className="description" role="status">
                  Copied. Paste the request in ChatGPT; Farol has not sent it.
                </p>
              )}
              {copyError === verificationIdentity && (
                <p className="notice" role="status">
                  Copy was unavailable. Open Technical details to select the
                  current request manually.
                </p>
              )}
              <details className="attachment-technical">
                <summary>Technical details</summary>
                <p>
                  Attach tunnel {externalChallenge.tunnelId} in ChatGPT
                  Settings.
                </p>
                <p>Verified workspace: {externalChallenge.root}</p>
                <p>
                  Ask the connector to call farol_next_connector_verify once
                  with:
                </p>
                <pre className="attachment-request">
                  <code>{verificationRequest}</code>
                </pre>
                <dl>
                  <div>
                    <dt>challenge</dt>
                    <dd>
                      <code>{externalChallenge.value}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>workspaceId</dt>
                    <dd>
                      <code>{externalChallenge.workspaceId}</code>
                    </dd>
                  </div>
                </dl>
                <small>
                  The check lists only the approved root and returns counts,
                  never names or file contents.
                </small>
              </details>
            </div>
          )}
          <p className="badges" role="status">
            {setup.ready
              ? "Attachment checked · Computer ready"
              : "Attachment check needed"}
          </p>
          <Command
            actions={actions}
            command={{ kind: "connector.check-attachment" }}
            disabled={!setup.canCheckAttachment}
            admit={(current) => computerSetup(current).canCheckAttachment}
          >
            Check attachment
          </Command>
        </Group>
      </div>
      <div hidden={setupStep !== undefined}>
        <Group title="Embedded ChatGPT · optional">
          <p className="badges">{setup.embeddedChatGPT}</p>
          <p className="description">
            Embedded sign-in is optional for external Computer access. It has
            its own check.
          </p>
          <div className="control-row">
            <Command
              actions={actions}
              command={{ kind: "chatgpt.open-sign-in" }}
            >
              Sign in
            </Command>
            <Command
              actions={actions}
              command={{ kind: "chatgpt.open-browser" }}
            >
              Open ChatGPT
            </Command>
            <Command actions={actions} command={{ kind: "chatgpt.verify" }}>
              Check sign-in
            </Command>
          </div>
        </Group>
      </div>
    </>
  );
}
function ConnectionDiagnostics({
  settings,
  snapshot,
  facade,
  actions,
}: PageProps) {
  const connector = settings.connectors.secureMcp;
  const setup = computerSetup(snapshot);
  const [appName, setAppName] = useState(connector.chatgptApp?.name ?? "");
  const appCheckStarted = useRef(false);
  const [appCheckAttempted, setAppCheckAttempted] = useState(false);
  return (
    <>
      <Group title="Connection controls">
        <p className="description">
          These controls change or stop the local connection. An uncertain
          result must be inspected before another action.
        </p>
        <div className="control-row">
          <Command
            actions={actions}
            command={{ kind: "connector.select-client" }}
          >
            Choose tunnel client…
          </Command>
          <Command
            actions={actions}
            command={{ kind: "connector.check-health" }}
          >
            Check local connection
          </Command>
          <Command
            actions={actions}
            command={{ kind: "connector.repair" }}
            disabled={!setup.canReconnect}
            admit={(current) => computerSetup(current).canReconnect}
          >
            Reconnect
          </Command>
          <Command actions={actions} command={{ kind: "connector.stop" }}>
            Stop connection
          </Command>
        </div>
      </Group>
      <Group title="Connection verification details">
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
              !setup.canVerifyEmbeddedApp ||
              !connector.chatgptApp ||
              connector.chatgptApp.connectorGeneration !==
                connector.generation ||
              connector.chatgptApp.tunnelId !== connector.tunnelId
            }
            onClick={() => {
              if (appCheckStarted.current) return;
              appCheckStarted.current = true;
              setAppCheckAttempted(true);
              void actions.run({ kind: "connector.verify-app" }, (current) => {
                const latest = computerSetup(current);
                return (
                  current.environment === "dev" &&
                  latest.canVerifyEmbeddedApp &&
                  current.configuration?.status === "ready" &&
                  current.configuration.settings.connectors.secureMcp.chatgptApp
                    ?.connectorGeneration ===
                    current.configuration.settings.connectors.secureMcp
                      .generation &&
                  current.configuration.settings.connectors.secureMcp.chatgptApp
                    ?.tunnelId ===
                    current.configuration.settings.connectors.secureMcp.tunnelId
                );
              });
            }}
          >
            Check in ChatGPT once
          </button>
          <p className="description">
            External verification uses the challenge in Connection and does not
            require embedded sign-in. Health checks do not prove ChatGPT
            attachment.
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              facade.navigate({ area: "settings", page: "connection" })
            }
          >
            Continue attachment setup
          </button>
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
  const preference = update.automaticUpdatePreference;
  const preferenceIntent = snapshot.intents["update-automatic-downloads"];
  const preferenceBusy =
    preferenceIntent?.state === "pending" ||
    preferenceIntent?.state === "unknown";
  const preferenceAvailable =
    preference?.status === "confirmed" &&
    !preferenceBusy &&
    !actions.disabled &&
    update.phase !== "checking" &&
    update.phase !== "downloading" &&
    update.phase !== "applying" &&
    update.phase !== "recovery" &&
    !(update.phase === "failed" && update.code.includes("UNKNOWN")) &&
    !(update.phase === "ready" && update.blockedBy?.includes("UNKNOWN"));
  const current =
    snapshot.status === "current" ? snapshot.installedVersion : null;
  if (snapshot.environment === "dev") {
    return (
      <>
        <h2>Updates</h2>
        <Group title="Development app">
          <p className="description">
            Farol Dev is updated by rebuilding the development app from source.
            Installed app updates are available in the installed Farol app.
          </p>
        </Group>
      </>
    );
  }
  return (
    <>
      <h2>Updates</h2>
      <Group title="Update status">
        <p className="description">
          {current
            ? `Installed: Farol ${current.version}${current.buildVersion ? ` (build ${current.buildVersion})` : ""}.`
            : "Installed version could not be confirmed from this app session."}
        </p>
        <p className="badges">
          {update.phase === "ready"
            ? `Downloaded: Farol ${update.version}. Ready to install; this version is not installed yet.`
            : update.phase === "available"
              ? `Available: Farol ${update.version}. Download it when you choose; this version is not installed.`
              : `${update.phase}${"version" in update ? ` · ${update.version}` : ""}`}
        </p>
        {"code" in update && <p className="notice">{update.code}</p>}
        {"blockedBy" in update && update.blockedBy && (
          <>
            <p className="notice" role="status">
              {updateBlockMessage(update.blockedBy)}
            </p>
            <details>
              <summary>Technical code</summary>
              <code>{update.blockedBy}</code>
            </details>
          </>
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
              !updateCheckAllowed(update) ||
              actions.disabled ||
              !commandAllowed(snapshot, "general.update")
            }
            onClick={() => {
              const latest = facade.getSnapshot();
              if (
                busy.current ||
                !updateCheckAllowed(latest.update) ||
                !commandAllowed(latest, "general.update")
              )
                return;
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
          its existing integrity and work-admission checks.
        </p>
      </Group>
      <Group title="Automatic downloads">
        <p className="description" role="status">
          {preference?.status === "confirmed"
            ? preference.enabled
              ? "On. Farol downloads eligible updates during scheduled checks. Installation still requires Review update and Restart & Update."
              : "Off. Farol checks for updates, but downloads only when you choose."
            : "Download preference cannot be confirmed in this session."}
        </p>
        {preference?.status !== "confirmed" && preference?.code && (
          <p className="notice" role="status">
            {preference.code}
          </p>
        )}
        {preferenceIntent?.state === "unknown" && (
          <p className="notice" role="status">
            Preference outcome is unknown. Do not repeat this change; review
            Diagnostics.
          </p>
        )}
        <button
          type="button"
          className="subtle"
          disabled={!preferenceAvailable}
          onClick={() => {
            const latest = facade.getSnapshot();
            const choice = latest.update.automaticUpdatePreference;
            if (
              choice?.status !== "confirmed" ||
              latest.intents["update-automatic-downloads"]?.state ===
                "pending" ||
              latest.intents["update-automatic-downloads"]?.state === "unknown"
            )
              return;
            void facade.setAutomaticDownloads(!choice.enabled);
          }}
        >
          {preference?.status === "confirmed" && preference.enabled
            ? "Turn off automatic downloads"
            : "Turn on automatic downloads"}
        </button>
      </Group>
    </>
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
  for (const id of Object.keys(snapshot.intents)) {
    const prefix = [applyPrefix, "observe:", "ack:"].find((candidate) =>
      id.startsWith(candidate),
    );
    if (prefix) operations.add(id.slice(prefix.length));
  }
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

function Diagnostics({ snapshot, settings, facade, actions }: PageProps) {
  const feedback = useSettingsFeedback(facade);
  const unresolved = Object.entries(feedback.pages).filter(
    ([, entry]) =>
      entry &&
      (entry.result?.state === "pending" ||
        entry.result?.state === "unknown") &&
      !settledEdit(entry.result, snapshot),
  );
  const evidence =
    snapshot.evidence?.revision === settings.revision
      ? snapshot.evidence.value
      : null;
  return (
    <>
      <h2>Diagnostics</h2>
      {unresolved.length > 0 && (
        <Group title="Actions needing observation">
          {unresolved.map(([page, entry]) => (
            <div key={page}>
              <p>{entry.text}</p>
              <p className="description">
                <code>{entry.result?.id}</code>
              </p>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  facade.navigate(
                    entry.origin.area === "setup"
                      ? {
                          area: "setup",
                          setupStep: entry.origin.setupStep ?? "overview",
                        }
                      : { area: "settings", page: page as SettingsPage },
                  )
                }
              >
                Return to{" "}
                {entry.origin.area === "setup"
                  ? "Setup"
                  : page === "computer"
                    ? "This Mac"
                    : page.charAt(0).toUpperCase() + page.slice(1)}
              </button>
            </div>
          ))}
        </Group>
      )}
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
          Export uses the existing native support flow.
        </p>
      </Group>
      <details
        open={Object.values(snapshot.intents).some(
          (intent) => intent.state === "pending" || intent.state === "unknown",
        )}
      >
        <summary>Action details</summary>
        <ul aria-label="Retained actions">
          {Object.values(snapshot.intents).map((intent) => (
            <li key={intent.id}>
              <code>{intent.id}</code>: {intent.state}
              {intent.code && (
                <>
                  {" "}
                  · <code>{intent.code}</code>
                </>
              )}
            </li>
          ))}
        </ul>
      </details>
      <WorkspaceEditResults
        snapshot={snapshot}
        facade={facade}
        settings={settings}
      />
      <details>
        <summary>Workspace diagnostics and guarded edits</summary>
        {settings.computer.workspaces.map((workspace) => (
          <article className="folder-row" key={workspace.workspaceId}>
            <h3>{folderDisplayName(workspace)}</h3>
            <p className="description">{workspace.root}</p>
            <FolderOptions
              workspace={workspace}
              settings={settings}
              snapshot={snapshot}
              facade={facade}
              actions={actions}
            />
            <GuardedEdit
              workspace={workspace}
              settings={settings}
              snapshot={snapshot}
              facade={facade}
              actions={actions}
            />
          </article>
        ))}
      </details>
      <details>
        <summary>Terminal &amp; Git details</summary>
        <p className="description">
          Shell and Git execution are unavailable and unqualified in this beta.
          The saved Git-check permission covers bounded Git status and HEAD
          commands with Apple Git; the saved workspace permission covers a
          sandboxed workspace shell. Both exclude network access; expanded Git
          access remains a separate workspace approval.
        </p>
      </details>
      <details>
        <summary>Model configuration</summary>
        <p className="description">
          Model configuration is independent of Computer setup.
        </p>
        <Model
          snapshot={snapshot}
          settings={settings}
          facade={facade}
          actions={actions}
        />
      </details>
      <details>
        <summary>ChatGPT acceptance tools</summary>
        <p className="description">
          These tools run only when you explicitly select an action. Opening
          Diagnostics does not check an account, prepare files or send a
          message.
        </p>
        <ChatDirect snapshot={snapshot} facade={facade} />
        <ChatReadonly snapshot={snapshot} facade={facade} />
        <ChatHistory snapshot={snapshot} facade={facade} />
      </details>
      <details>
        <summary>Browser windows</summary>
        <p className="description">
          These are existing ChatGPT browser views. A view is Farol work only
          when it has a recorded agent.
        </p>
        {snapshot.tasks.tasks.map((task) => (
          <button
            key={task.taskId}
            type="button"
            className="subtle"
            onClick={() => {
              facade.navigate({ area: "chatgpt", taskId: task.taskId });
              void facade.task(
                { kind: "task.activate", taskId: task.taskId },
                `activate:${task.taskId}`,
              );
            }}
          >
            {task.label}
          </button>
        ))}
      </details>
      <ConnectionDiagnostics
        snapshot={snapshot}
        settings={settings}
        facade={facade}
        actions={actions}
      />
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
