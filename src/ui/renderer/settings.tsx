import { setupChecklist } from "./setup-navigation";
import {
  automaticUpdateAvailable,
  automaticUpdateEnabled,
  updateCheckAllowed,
} from "./update-eligibility";
import { SetupWalkthrough } from "../../../apps/desktop/renderer/setup-walkthrough";
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
import { GuidedWorkspaceAccess } from "../guided-workspace-access";
import { onboardingFacts } from "../guided-onboarding";
import { signInPresentation } from "./sign-in-presentation";
import { computerSetup } from "./computer-setup";
import { visibleSetupSection, type SetupSection } from "./setup-checklist";
import { commandAllowed, dependencyFences } from "./command-eligibility";
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
  setupStep?: "signin" | "connection" | "folders" | "attachment" | undefined;
}>;
type ActionDispatch =
  | Readonly<{ state: "not-sent" }>
  | Readonly<{ state: "attempted"; result: Intent | null }>;
type Actions = {
  refresh(): Promise<void>;
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
  runClassified(
    command: ProductConfigurationCommand,
    admit?: (current: WindowSnapshot) => boolean,
  ): Promise<ActionDispatch>;
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
type FeedbackPage = SettingsPage | `setup:${SetupSection}`;
function feedbackPage(destination: Destination): FeedbackPage {
  return destination.area === "setup"
    ? `setup:${visibleSetupSection(destination.setupStep)}`
    : destination.page;
}
function createFeedback() {
  let revision = 0;
  const listeners = new Set<() => void>();
  return {
    pages: {} as Partial<Record<FeedbackPage, PageFeedback>>,
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
function actionFeedback(result: Intent): string {
  if (result.state === "pending") return "Saving or checking…";
  if (result.state === "unknown" || result.code === "SETTINGS_WRITE_FAILED")
    return "Farol could not confirm the last action. Refresh its saved result before continuing; do not repeat it.";
  if (result.state === "refused")
    return "The action could not be completed. Check the setup guide before trying again.";
  return "Saved.";
}
// Evidence carries a revision, but no request ID. If another facade intent
// changed during a picker/preview, do not attribute its evidence to our action.
function soleIntent(
  before: WindowSnapshot,
  after: WindowSnapshot,
  kind: string,
  id = intention(kind),
): boolean {
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
        return;
      }
      const receipt = await facade.refreshReadback();
      if (
        !owner.mounted ||
        owner.generation !== generation ||
        facade.getSnapshot().destination !== destination ||
        receipt.status !== "adopted" ||
        flow.access.pendingReadback() !== pending
      )
        return;
      const id = intention(
        pending.command.kind,
        "workspaceId" in pending.command
          ? pending.command.workspaceId
          : undefined,
      );
      const resolved = facade.reconcileWorkspaceReadback(receipt, id, pending);
      if (!resolved) return;
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
      feedback.intents[id] = { id, state: "pending", code: null };
      report("Saving or checking…", { id, state: "pending", code: null });
      try {
        const result = await facade.configure(command, id);
        // Keep every unresolved dependency, even when a newer independent
        // request owns the page message. Refresh/remount cannot settle it.
        feedback.intents[id] = result;
        report(actionFeedback(result), result);
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
  };
  const pageFeedback = feedback.pages[feedbackPage(snapshot.destination)];
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
      {configuration?.status !== "ready" ? (
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
        </>
      ) : (
        <>
          {snapshot.destination.page === "appearance" ? (
            <AppearancePage {...props} />
          ) : snapshot.destination.page === "shortcuts" ? (
            <Shortcuts {...props} />
          ) : (
            <General {...props} />
          )}
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
function General({ snapshot, facade, actions }: PageProps) {
  const [checking, setChecking] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");
  const checklist = setupChecklist(snapshot);
  const preference = snapshot.update.automaticUpdatePreference;
  const updateIntent = snapshot.intents["update-automatic-downloads"];
  const quitIntent = snapshot.intents["update-install-on-quit"];
  const preferenceUnknown =
    preference?.status === "unknown" ||
    updateIntent?.state === "unknown" ||
    quitIntent?.state === "unknown";
  return (
    <>
      <h2>General</h2>
      <section className="settings-setup-status" aria-label="Setup status">
        <div>
          <h3>
            {checklist.ready ? "Farol is set up" : "Finish setting up Farol"}
          </h3>
          <p className="description">
            Sign-in, workspaces, connection and ChatGPT live in Setup.
          </p>
        </div>
        <button
          type="button"
          className="subtle"
          onClick={() =>
            facade.navigate({ area: "setup", setupStep: "overview" })
          }
        >
          Open Setup
        </button>
      </section>
      <Group title="Updates" showTitle={false}>
        <label className="setting-row">
          Install updates automatically
          <input
            type="checkbox"
            aria-label="Install updates automatically"
            checked={
              snapshot.environment === "preview" &&
              automaticUpdateEnabled(snapshot.update)
            }
            disabled={!automaticUpdateAvailable(snapshot)}
            onChange={(event) => {
              if (automaticUpdateAvailable(facade.getSnapshot()))
                void facade.setAutomaticDownloads(event.currentTarget.checked);
            }}
          />
        </label>
        {preferenceUnknown ? (
          <p className="description" role="status">
            The update preference could not be confirmed. Wait for its saved
            result before changing it again.
          </p>
        ) : preference?.status !== "confirmed" ? (
          <p className="description">
            The update preference is unavailable in this session.
          </p>
        ) : updateIntent?.state === "refused" ? (
          <p className="description" role="status">
            The update preference could not be saved.
          </p>
        ) : null}
        <div className="setting-row">
          <span>Version</span>
          <span>
            {snapshot.installedVersion?.version ?? "Unavailable"}
            {snapshot.installedVersion?.buildVersion
              ? ` · ${snapshot.installedVersion.buildVersion}`
              : ""}
          </span>
          <button
            type="button"
            className="text-button"
            disabled={
              checking ||
              snapshot.environment !== "preview" ||
              snapshot.status !== "current" ||
              snapshot.runtime !== "ready" ||
              !updateCheckAllowed(snapshot.update) ||
              snapshot.intents.update?.state === "unknown" ||
              snapshot.intents.update?.state === "pending"
            }
            onClick={async () => {
              if (!updateCheckAllowed(facade.getSnapshot().update)) return;
              setChecking(true);
              try {
                const result = await facade.update("check");
                setUpdateMessage(
                  result.state === "applied"
                    ? "Update check completed."
                    : result.state === "unknown"
                      ? "The update check could not be confirmed. Do not repeat it."
                      : "The update check could not be completed.",
                );
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? "Checking…" : "Check for updates"}
          </button>
        </div>
        {updateMessage && (
          <p className="description" role="status">
            {updateMessage}
          </p>
        )}
      </Group>
      <Group title="Something wrong?">
        <p className="description">
          Save a support file and attach it to a GitHub issue. It holds no
          messages, keys or file contents.
        </p>
        <Command actions={actions} command={{ kind: "support.export" }}>
          Save support file…
        </Command>
      </Group>
    </>
  );
}
function AppearancePage({ snapshot, facade }: PageProps) {
  const appearance = snapshot.appearance;
  const typefaceId = useId();
  return (
    <div className="appearance-page">
      <p className="appearance-intro">
        One interface, in the light that feels right for you.
      </p>
      <Group title="Interface appearance" showTitle={false}>
        <div className="appearance-row appearance-theme">
          <div className="appearance-copy">
            <h3>Theme</h3>
            <p>System follows the appearance of your Mac.</p>
          </div>
          <div className="theme-choices" role="group" aria-label="Theme">
            {(["light", "graphite", "system"] as const).map((theme) => (
              <button
                type="button"
                key={theme}
                className="theme-choice"
                aria-pressed={appearance.theme === theme}
                onClick={() =>
                  facade.appearance({
                    ...facade.getSnapshot().appearance,
                    theme,
                  })
                }
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
        </div>
        <div className="appearance-row">
          <div className="appearance-copy">
            <h3>Accent color</h3>
            <p>
              Highlights selection, focus and primary actions. Status stays
              distinct.
            </p>
          </div>
          <div
            className="accent-choices"
            role="group"
            aria-label="Accent color"
          >
            {(["iris", "cobalt", "amber"] as const).map((accent) => {
              const label =
                accent === "iris"
                  ? "Iris"
                  : accent === "cobalt"
                    ? "Cobalt"
                    : "Amber";
              return (
                <button
                  type="button"
                  key={accent}
                  className={`accent-choice ${accent}`}
                  aria-label={`${label} accent`}
                  aria-pressed={appearance.accent === accent}
                  onClick={() =>
                    facade.appearance({
                      ...facade.getSnapshot().appearance,
                      accent,
                    })
                  }
                >
                  <span className="accent-dot" aria-hidden="true" />
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="appearance-row">
          <div className="appearance-copy">
            <h3>
              <label htmlFor={typefaceId}>Typeface</label>
            </h3>
            <p>
              Geist gives Farol a consistent voice. System follows your
              platform.
            </p>
          </div>
          <select
            id={typefaceId}
            aria-label="Typeface"
            className="field"
            value={appearance.font}
            onChange={(event) =>
              facade.appearance({
                ...facade.getSnapshot().appearance,
                font: event.currentTarget.value as typeof appearance.font,
              })
            }
          >
            <option value="geist">Geist</option>
            <option value="system">System</option>
          </select>
        </div>
      </Group>
      <p className="description">
        Changes apply immediately. You can change them again at any time.
      </p>
    </div>
  );
}
const folderSetupByWindow = new WeakMap<
  RendererFacade,
  { access: GuidedWorkspaceAccess; busy: boolean }
>();

function Folders(props: PageProps) {
  const { settings, facade, snapshot, actions } = props;
  const [adding, setAdding] = useState(false);
  const feedback = useSettingsFeedback(facade);
  const result = feedback.pages["setup:folders"]?.result;
  const failed =
    (result?.state === "refused" || result?.state === "unknown") &&
    !result.code?.endsWith("_CANCELLED");
  let flow = folderSetupByWindow.get(facade);
  if (!flow) {
    flow = { access: new GuidedWorkspaceAccess(), busy: false };
    folderSetupByWindow.set(facade, flow);
  }
  const folderFlow = flow;
  async function choose() {
    if (folderFlow.busy || folderFlow.access.requiresReadback()) return;
    folderFlow.busy = true;
    setAdding(true);
    try {
      const picking = facade.getSnapshot();
      const picked = await actions.run({ kind: "computer.choose-workspace" });
      const before = facade.getSnapshot();
      const evidence = before.evidence;
      if (
        picked?.state !== "applied" ||
        evidence === picking.evidence ||
        !soleIntent(picking, before, "computer.choose-workspace") ||
        evidence?.value.kind !== "computer.workspace-pick" ||
        before.configuration?.status !== "ready" ||
        evidence.revision !== before.configuration.settings.revision ||
        before.buildId !== picking.buildId
      )
        return;
      const result = await actions.run({
        kind: "computer.add-workspace",
        selectionId: evidence.value.selectionId,
        access: "write",
      });
      const current = facade.getSnapshot();
      const selection = current.evidence?.value;
      if (
        result?.state !== "applied" ||
        current.evidence === before.evidence ||
        !soleIntent(before, current, "computer.add-workspace") ||
        selection?.kind !== "computer.workspace-selection" ||
        current.configuration?.status !== "ready" ||
        current.evidence?.revision !==
          current.configuration.settings.revision ||
        current.buildId !== before.buildId ||
        !current.configuration.settings.computer.workspaces.some(
          (item) => item.workspaceId === selection.workspaceId,
        )
      )
        return;
      await folderFlow.access.run(
        {
          settings: () => {
            const configuration = facade.getSnapshot().configuration;
            return configuration?.status === "ready"
              ? configuration.settings
              : null;
          },
          buildId: () => facade.getSnapshot().buildId ?? "",
          issueCheckId: () => crypto.randomUUID(),
          run: async (command) => {
            const outcome = await actions.runClassified(command);
            // Only the local guards prove no dispatch. A null result after
            // entering the facade can hide an effect and must stay unknown.
            if (outcome.state === "not-sent") return "refused";
            const intent = outcome.result;
            return intent?.state === "applied"
              ? "applied"
              : intent?.state === "refused"
                ? "refused"
                : "unknown";
          },
        },
        { workspaceId: selection.workspaceId, connectWhenConfigured: false },
        onboardingFacts(current.configuration.settings, current.buildId ?? ""),
      );
    } finally {
      folderFlow.busy = false;
      setAdding(false);
    }
  }

  async function update(
    workspaceId: string,
    plan: { access?: "read" | "write"; commands?: "none" | "workspace" } = {},
  ) {
    if (folderFlow.busy || folderFlow.access.requiresReadback()) return;
    folderFlow.busy = true;
    setAdding(true);
    const current = facade.getSnapshot();
    try {
      await folderFlow.access.run(
        {
          settings: () => {
            const value = facade.getSnapshot().configuration;
            return value?.status === "ready" ? value.settings : null;
          },
          buildId: () => facade.getSnapshot().buildId ?? "",
          issueCheckId: () => crypto.randomUUID(),
          run: async (command) => {
            const outcome = await actions.runClassified(command);
            return outcome.state === "not-sent" ||
              outcome.result?.state === "refused"
              ? "refused"
              : outcome.result?.state === "applied"
                ? "applied"
                : "unknown";
          },
        },
        { workspaceId, ...plan, connectWhenConfigured: false },
        onboardingFacts(
          current.configuration?.status === "ready"
            ? current.configuration.settings
            : null,
          current.buildId ?? "",
        ),
      );
    } finally {
      folderFlow.busy = false;
      setAdding(false);
    }
  }
  const paused =
    adding || folderFlow.busy || folderFlow.access.requiresReadback();
  return (
    <>
      <div className="setup-workspaces" aria-label="Approved workspaces">
        {settings.computer.workspaces.map((workspace) => {
          const checked =
            workspaceChecked(snapshot, workspace) &&
            !actions.computerPauseReason;
          return (
            <article
              className="setup-workspace-row"
              key={workspace.workspaceId}
              aria-label={`Workspace ${folderDisplayName(workspace)}`}
            >
              <div className="workspace-row-path">
                <strong>{folderDisplayName(workspace)}</strong>
                <p className="description">{workspace.root}</p>
              </div>
              <label>
                Access
                <select
                  className="field"
                  aria-label={`Access for ${folderDisplayName(workspace)}`}
                  value={workspace.access}
                  disabled={
                    paused ||
                    !actions.allowed(
                      "computer.update-access",
                      workspace.workspaceId,
                    )
                  }
                  onChange={(event) =>
                    void update(workspace.workspaceId, {
                      access:
                        event.currentTarget.value === "read" ? "read" : "write",
                    })
                  }
                >
                  <option value="read">Read only</option>
                  <option value="write">Read &amp; write</option>
                </select>
              </label>
              <label className="workspace-commands">
                <input
                  type="checkbox"
                  aria-label={`Commands for ${folderDisplayName(workspace)}`}
                  checked={settings.computer.commands === "workspace"}
                  disabled={
                    paused || !actions.allowed("computer.update-commands")
                  }
                  onChange={(event) =>
                    void update(workspace.workspaceId, {
                      commands: event.currentTarget.checked
                        ? "workspace"
                        : "none",
                    })
                  }
                />
                Commands
              </label>
              <div className="workspace-row-result" role="status">
                {checked ? (
                  <span className="setup-success">✓ Works</span>
                ) : (
                  <>
                    <span>
                      {actions.computerPauseReason ??
                        "Workspace access has not passed its check."}
                    </span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={
                        paused ||
                        !actions.allowed(
                          "computer.verify-workspace",
                          workspace.workspaceId,
                        )
                      }
                      onClick={() => void update(workspace.workspaceId)}
                    >
                      Check access
                    </button>
                  </>
                )}
              </div>
              <button
                type="button"
                className="text-button"
                disabled={
                  paused ||
                  !actions.allowed(
                    "computer.remove-workspace",
                    workspace.workspaceId,
                  )
                }
                onClick={() =>
                  void actions.run({
                    kind: "computer.remove-workspace",
                    workspaceId: workspace.workspaceId,
                  })
                }
              >
                Remove {folderDisplayName(workspace)}
              </button>
            </article>
          );
        })}
      </div>
      <button
        type="button"
        className="subtle"
        disabled={paused || !actions.allowed("computer.choose-workspace")}
        onClick={() => void choose()}
      >
        {adding ? "Checking workspace…" : "+ Add workspace"}
      </button>
      <p className="description">
        Adding a workspace checks it at once. Commands lets ChatGPT run git,
        tests and builds; each run still asks you first. Command access is
        shared by all workspaces.
      </p>
      {settings.computer.workspaces.length === 0 && (
        <p className="description">Add a workspace to continue.</p>
      )}
      {failed && <SetupFailure result={result ?? null} actions={actions} />}
    </>
  );
}
// Draft admission binds presentation to the exact Computer scope. Local
// selection is never a Computer grant or a replacement for the host guards.
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
function Connection(props: PageProps) {
  if (props.setupStep === "signin") return <SignInStep {...props} />;
  if (props.setupStep === "attachment") return <AddToChatGPT {...props} />;
  return <ConnectMac {...props} />;
}
function ConnectMac({ settings, snapshot, facade, actions }: PageProps) {
  const connector = settings.connectors.secureMcp;
  const [tunnelId, setTunnelId] = useState(connector.tunnelId ?? "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const composing = useRef(false);
  const feedback = useSettingsFeedback(facade);
  const result = feedback.pages["setup:connection"]?.result;
  const setup = computerSetup(snapshot);
  const failed = result?.state === "refused" || result?.state === "unknown";
  const connected = setup.localConnectionCurrent && !failed;
  const valid =
    key.length > 0
      ? ProductConfigurationCommandSchema.safeParse({
          kind: "connector.configure",
          tunnelId,
          runtimeKey: key,
        }).success
      : connector.credential === "stored" && tunnelId === connector.tunnelId;
  async function connect() {
    if (running.current || composing.current || !valid) return;
    running.current = true;
    setBusy(true);
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
      await actions.run({ kind: "connector.check-health" });
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
        <SetupWalkthrough />
        <Command
          actions={actions}
          command={{ kind: "onboarding.open-help", destination: "tunnels" }}
        >
          Open OpenAI Tunnels
        </Command>
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
            onChange={(event) => setTunnelId(event.currentTarget.value)}
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
              connector.credential === "stored" ? "Key saved" : "Paste your key"
            }
            onChange={(event) => setKey(event.currentTarget.value)}
            disabled={busy}
          />
        </label>
        <button
          className="primary"
          disabled={
            busy || !valid || !actions.allowed("connector.save-and-connect")
          }
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
      </form>
      {connected && (
        <p className="setup-success" role="status">
          ✓ Connected
        </p>
      )}
      {(failed || helperMissing) && (
        <SetupFailure
          result={result ?? null}
          actions={actions}
          helperMissing={helperMissing}
        />
      )}
      {!connected && !failed && !helperMissing && !busy && (
        <p className="description">
          Enter your tunnel ID and key, then connect.
        </p>
      )}
    </>
  );
}
function SetupFailure({
  result,
  actions,
  helperMissing = false,
}: {
  result: Intent | null;
  actions: Actions;
  helperMissing?: boolean;
}) {
  const unknown =
    result?.state === "unknown" || result?.code === "SETTINGS_WRITE_FAILED";
  const keyRejected =
    /(?:KEY_REJECTED|AUTHENTICATION_FAILED)/u.test(result?.code ?? "") &&
    !unknown;
  const keyStore = result?.code === "CONNECTOR_CREDENTIAL_STORE_FAILED";
  const workspaceFailure = result?.id.startsWith("settings:computer.");
  return (
    <div className="notice setup-failure" role="alert">
      <p>
        {unknown
          ? "Farol could not confirm the last action. Check its saved result before continuing; do not repeat it."
          : helperMissing
            ? "This Mac could not find a usable connection helper. Install tunnel-client for this account."
            : keyRejected
              ? "OpenAI did not accept this key. It may be revoked or belong to another tunnel."
              : keyStore
                ? "Farol could not save the key on this Mac. Check this account’s key storage before connecting again."
                : workspaceFailure
                  ? "Farol could not check this workspace. Make sure it still exists and this account can open it."
                  : result?.code === "CONNECTOR_POLLING_EXPIRED"
                    ? "The connection started, but its health check did not finish. The connection is not confirmed."
                    : "This Mac could not complete the check. Check the setup guide before trying again."}
      </p>
      {unknown ? (
        <button
          type="button"
          className="text-button"
          onClick={() => void actions.refresh()}
        >
          Refresh status
        </button>
      ) : (
        <Command
          actions={actions}
          command={{
            kind: "onboarding.open-help",
            destination: keyRejected ? "tunnels" : "setup-guide",
          }}
        >
          {keyRejected
            ? "Create a new key in OpenAI Tunnels"
            : helperMissing
              ? "How to install tunnel-client"
              : "Read the setup guide"}
        </Command>
      )}
    </div>
  );
}
function SignInStep({ snapshot, facade, actions }: PageProps) {
  const signIn = signInPresentation(snapshot);
  const saved =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings.setup.chatgpt
      : null;
  const verified =
    signIn.signedIn &&
    saved?.verified?.buildId === snapshot.buildId &&
    saved.reachable === "reachable";
  const feedback = useSettingsFeedback(facade);
  const result = feedback.pages["setup:signin"]?.result;
  return (
    <section aria-label="ChatGPT sign-in">
      {verified ? (
        <p className="setup-success" role="status">
          ✓ Signed in
        </p>
      ) : result?.state === "unknown" || result?.state === "refused" ? (
        <SetupFailure result={result} actions={actions} />
      ) : (
        <>
          <p className="description">
            {signIn.pending
              ? "Checking sign-in…"
              : signIn.signedIn
                ? "Your account is signed in. Check it once to continue."
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
function AddToChatGPT({ settings, snapshot, facade, actions }: PageProps) {
  const connector = settings.connectors.secureMcp;
  const setup = computerSetup(snapshot);
  const busy = useRef(false);
  const [checking, setChecking] = useState(false);
  const feedback = useSettingsFeedback(facade);
  const result = feedback.pages["setup:attachment"]?.result;
  const failed = result?.state === "refused" || result?.state === "unknown";
  async function test() {
    if (
      busy.current ||
      !computerSetup(facade.getSnapshot()).canVerifyEmbeddedApp
    )
      return;
    busy.current = true;
    setChecking(true);
    try {
      const current = facade.getSnapshot();
      if (current.configuration?.status !== "ready") return;
      const saved = current.configuration.settings.connectors.secureMcp;
      if (!saved.tunnelId) return;
      if (
        saved.chatgptApp?.name !== "Farol" ||
        saved.chatgptApp.tunnelId !== saved.tunnelId ||
        saved.chatgptApp.connectorGeneration !== saved.generation
      ) {
        if (
          (
            await actions.run({
              kind: "connector.select-chatgpt-app",
              name: "Farol",
              tunnelId: saved.tunnelId,
              connectorGeneration: saved.generation,
            })
          )?.state !== "applied"
        )
          return;
      }
      const pending = actions.run(
        { kind: "connector.verify-app" },
        (current) => computerSetup(current).canVerifyEmbeddedApp,
      );
      if (
        facade.getSnapshot().intents["settings:connector.verify-app:"]
          ?.state === "pending"
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
  return (
    <>
      <section aria-label="Create the ChatGPT app">
        <SetupWalkthrough kind="chatgpt" tunnelId={connector.tunnelId ?? ""} />
        <p className="description">
          In ChatGPT, create an app with these values:
        </p>
        <dl className="setup-app-values">
          <div>
            <dt>Name</dt>
            <dd>Farol</dd>
          </div>
          <div>
            <dt>Connection</dt>
            <dd>Tunnel · {connector.tunnelId ?? "Connect this Mac first"}</dd>
          </div>
          <div>
            <dt>Sign-in</dt>
            <dd>None</dd>
          </div>
        </dl>
        <Command
          actions={actions}
          command={{ kind: "onboarding.open-help", destination: "chatgpt" }}
        >
          Open ChatGPT Apps
        </Command>
      </section>
      <section className="setup-test" aria-label="Test in ChatGPT">
        <h3>Test in ChatGPT</h3>
        <p className="description">
          Farol sends one short message in a Temporary Chat using Instant and
          checks the reply from this Mac. It checks workspace access without
          reading file contents.
        </p>
        {setup.ready ? (
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
        ) : (
          <>
            {failed ? (
              <SetupFailure result={result ?? null} actions={actions} />
            ) : (
              <p className="description">
                {setup.canVerifyEmbeddedApp
                  ? "Create the app above, then run the check once."
                  : "Finish sign-in, workspace and connection checks before testing in ChatGPT."}
              </p>
            )}
            <button
              type="button"
              className="primary"
              disabled={
                checking ||
                !actions.allowed("connector.verify-app") ||
                !setup.canVerifyEmbeddedApp
              }
              onClick={() => void test()}
            >
              {checking ? "Testing in ChatGPT…" : "Test in ChatGPT"}
            </button>
          </>
        )}
      </section>
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
