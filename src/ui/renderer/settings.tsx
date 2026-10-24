import { unresolvedActions } from "../../../apps/desktop/renderer/unresolved-actions";
import { setupStepCheck } from "./setup-gate";
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
  SecureMcpAppSelectionSchema,
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
  unresolvedSheet?: boolean;
  setupInputsChanged?: boolean | undefined;
  onSetupInputsChange?: ((changed: boolean) => void) | undefined;
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
/** Retained transport outcomes also fence Setup when the facade lost its receipt. */
export function retainedSetupIntents(
  facade: RendererFacade,
  snapshot: WindowSnapshot,
): readonly Intent[] {
  const feedback = feedbackByWindow.get(facade);
  if (!feedback) return [];
  return [
    ...Object.values(feedback.intents).map(
      (intent) => settledEdit(intent, snapshot) ?? intent,
    ),
    ...(feedback.unretained
      ? [{ id: "setup:unretained", state: "unknown" as const, code: null }]
      : []),
  ];
}
export function useSetupIntents(
  facade: RendererFacade,
  snapshot: WindowSnapshot,
) {
  useSettingsFeedback(facade);
  return retainedSetupIntents(facade, snapshot);
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
export function Settings({
  snapshot,
  facade,
  setupStep,
  setupInputsChanged,
  onSetupInputsChange,
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
          await actions.run({ kind: "connector.check-attachment" });
        }
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
      <div className="settings-update-controls">
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
                  void facade.setAutomaticDownloads(
                    event.currentTarget.checked,
                  );
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
            <button
              className="subtle"
              onClick={() => facade.overlay("update-recovery")}
            >
              Update recovery…
            </button>
          </div>
          {updateMessage && (
            <p className="description" role="status">
              {updateMessage}
            </p>
          )}
        </Group>
      </div>
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
        before.destination !== picking.destination ||
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
        current.destination !== picking.destination ||
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

  async function remove(workspaceId: string) {
    if (folderFlow.busy || folderFlow.access.requiresReadback()) return;
    const before = facade.getSnapshot();
    if (before.configuration?.status !== "ready") return;
    const previous = before.configuration.settings.computer;
    const expected = {
      ...previous,
      generation: previous.generation + 1,
      workspaces: previous.workspaces.filter(
        (item) => item.workspaceId !== workspaceId,
      ),
    };
    let remaining: string | undefined;
    folderFlow.busy = true;
    setAdding(true);
    try {
      const result = await actions.run({
        kind: "computer.remove-workspace",
        workspaceId,
      });
      const current = facade.getSnapshot();
      // Follow only this acknowledged removal. A navigation, unknown outcome
      // or any other scope change cannot schedule additional configuration work.
      if (
        result?.state === "applied" &&
        current.destination === before.destination &&
        current.buildId === before.buildId &&
        soleIntent(
          before,
          current,
          "computer.remove-workspace",
          intention("computer.remove-workspace", workspaceId),
        ) &&
        current.configuration?.status === "ready" &&
        JSON.stringify(current.configuration.settings.computer) ===
          JSON.stringify(expected)
      ) {
        remaining =
          current.configuration.settings.computer.workspaces[0]?.workspaceId;
      }
    } finally {
      folderFlow.busy = false;
      setAdding(false);
    }
    // The existing guarded flow checks every retained folder with its saved
    // access/commands, and keeps original unknown effects fenced.
    if (remaining !== undefined) await update(remaining);
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
                  checked={settings.computer.commands !== "none"}
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
                onClick={() => void remove(workspace.workspaceId)}
              >
                Remove {folderDisplayName(workspace)}
              </button>
            </article>
          );
        })}
      </div>
      <button
        type="button"
        className={
          settings.computer.workspaces.length === 0 ? "primary" : "subtle"
        }
        disabled={paused || !actions.allowed("computer.choose-workspace")}
        onClick={() => void choose()}
      >
        {adding ? "Checking workspace…" : "+ Add workspace"}
      </button>
      <p className="description">
        Workspace access is checked automatically when you add or change a
        workspace. “Works” means that check passed for the current settings; no
        repeat check is needed to continue. Commands lets ChatGPT run git, tests
        and builds; each run still asks you first. Command access is shared by
        all workspaces.
      </p>
      {settings.computer.commands === "verification" && (
        <p className="description">
          This profile currently allows Git checks only. Turn Commands off and
          on to allow workspace commands.
        </p>
      )}
      {settings.computer.workspaces.length === 0 && (
        <p className="description">Add a workspace to continue.</p>
      )}
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
                  ? "Connected"
                  : draftChanged && connector.runtime !== null
                    ? "Save and connect"
                    : "Connect"}
            </button>
          )}
          {connected && (
            <span className="setup-success" role="status">
              ✓ Connected to this Mac
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
                ? "You’re signed in. Farol is confirming this step automatically."
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
function AddToChatGPT({
  settings,
  snapshot,
  facade,
  actions,
  onSetupInputsChange,
}: PageProps) {
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
    gate.state !== "pending" &&
    (gate.state === "unknown" || unconfirmedTest);
  async function checkConfirmation() {
    if (readingConfirmation.current || busy.current) return;
    readingConfirmation.current = true;
    setRefreshingConfirmation(true);
    try {
      await actions.refresh();
    } finally {
      readingConfirmation.current = false;
      setRefreshingConfirmation(false);
    }
  }
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
    if (
      busy.current ||
      !nameValid ||
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
        <h3>1. Add your app in ChatGPT</h3>

        <p className="description">
          Create a new app, or use the one already connected to this tunnel.
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
        <h3>2. Check the connection</h3>
        <p className="description">
          {waitingForConfirmation
            ? unconfirmedTest
              ? "An earlier test has no confirmed result. A new test is paused so it cannot be sent twice."
              : "An earlier action has no confirmed result. Check its saved status before starting a test."
            : "Farol opens a separate chat, selects Instant and sends one test message to your app. The reply confirms that ChatGPT can reach this Mac — without reading file contents."}
        </p>
        <div
          className="setup-result setup-gate-status"
          role={
            gate.state === "refused" && !waitingForConfirmation
              ? "alert"
              : "status"
          }
          data-result-state={gate.state}
          data-confirmation-pending={waitingForConfirmation || undefined}
        >
          <strong>
            {gate.allowed
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
            {gate.state === "missing"
              ? "Add the app above, then run the check once."
              : waitingForConfirmation
                ? unconfirmedTest
                  ? "This Mac has not received confirmation. Check the saved result, or compare the app’s tunnel ID with the connection shown above."
                  : "An earlier action is not confirmed. Checking status will not repeat it or start a ChatGPT test."
                : gate.cause}
          </p>
          {gate.action && gate.state !== "missing" && (
            <button
              type="button"
              className={waitingForConfirmation ? "primary" : "text-button"}
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
                  ? "Checking confirmation…"
                  : "Check for confirmation"
                : gate.action.label}
            </button>
          )}
        </div>
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
              Review connection
            </button>
            <p className="description">
              Checking confirmation reads the saved result. It sends no new
              message and keeps the earlier test in Unresolved actions.
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
                  : setup.canVerifyEmbeddedApp
                    ? "Create the app above, then run the check once."
                    : "Finish sign-in, workspace and connection checks before testing in ChatGPT."}
              </p>
            )}
            <button
              type="button"
              className="primary"
              disabled={
                checking ||
                !nameValid ||
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
