import {
  automaticUpdateAvailable,
  updateCheckAllowed,
  confirmedRestartAllowed,
} from "./update-eligibility";
import {
  defaultNavigationShortcuts,
  parseNavigationShortcuts,
  type NavigationShortcuts,
} from "../../pkg/ipc/navigation-shortcuts";
import {
  workspaceReadbackBinding,
  workspaceReadbackConfirms,
  type WorkspaceReadbackBinding,
} from "../guided-workspace-access";
import { workspaceEditToAcknowledge } from "../workspace-edit-delivery";
import {
  clampPageListWidth,
  shellGeometry,
} from "../../pkg/shell-layout/geometry";
import { AgentDraftStore } from "../agent-draft";
import { ConversationDraftStore } from "./conversation-draft";
import { z } from "zod";
import {
  ChatHistoryContextSchema,
  ChatHistoryQuerySchema,
  ChatHistoryReplySchema,
  sameHistoryContext,
  type ChatHistoryQuery,
  type ChatHistoryReply,
  type ChatHistoryContext,
} from "../../pkg/ipc/chat-history";
import { adoptReadConversation } from "./read-conversation-state";
import { computerSetup } from "./computer-setup";
import { setupPage } from "./setup-navigation";
import { isHomeOverview, pageListMode } from "./sidebar-presentation";
import {
  ProductConfigurationSnapshotSchema,
  ProductConfigurationCommandSchema,
  ProductConfigurationResultSchema,
} from "../../pkg/product-settings/contract";
import {
  ProductTaskCommandSchema,
  ProductTaskCommandResultSchema,
  ProductTasksStateSchema,
} from "../../modules/chat/contract/product-task";
import { InstalledUpdateViewSchema } from "../../modules/release/contract/installed-update";
import { ClientEventSchema } from "../../modules/chat/contract/client-event";
import {
  ShellActionSchema,
  ShellLayoutSchema,
  WindowStateSchema,
  type ShellAction,
} from "../../pkg/ipc/shell-state";
import { BuildIdentitySchema } from "../../pkg/build-info/identity";
import {
  BrowserRouteStatusSchema,
  RuntimeStatusSchema,
} from "../../pkg/ipc/runtime-status";
import { TaskSurfaceStatusSchema } from "../../pkg/ipc/task-surface-status";
import {
  ConfigurationRequestOrder,
  shouldAdoptConfigurationSnapshot,
  configurationEvidenceRevision,
} from "../configuration-request-order";
import {
  classifyConfigurationResponse,
  configurationEffectOutcome,
} from "../configuration-outcome";
import type {
  ProductConfigurationCommand,
  ProductConfigurationEvidence,
} from "../../pkg/product-settings/contract";

import type { ProductTaskCommand } from "../../modules/chat/contract/product-task";
import type {
  ActivityEntry,
  Appearance,
  Destination,
  Intent,
  NativeRefreshResult,
  PreloadApi,
  RendererFacade,
  UpdateAction,
  WindowSnapshot,
} from "./contract";

type EditPreview = Extract<
  ProductConfigurationEvidence,
  { kind: "computer.workspace-edit-preview" }
>;
type EditReceipt = Readonly<{
  preview: EditPreview;
  configuration: WindowSnapshot["configuration"];
  buildId: string;
  computerId: string;
  generation: number;
}>;
type SubmittedEdit = Readonly<{
  intention: string;
  receipt: EditReceipt | null;
}>;
type ObservedEdit = Readonly<{
  submitted: SubmittedEdit;
  configuration: WindowSnapshot["configuration"];
  evidence: WindowSnapshot["evidence"];
  state: "applied" | "refused";
  code: string | null;
}>;

type SectionNavigationAction = Extract<
  ShellAction,
  { action: "navigate-section" }
>;

// Parse only the renderer-safe projection; never retain the raw bootstrap object.
export const BootstrapProjectionSchema = z.object({
  schema: z.literal(3),
  environment: z.enum(["preview", "dev"]),
  build: BuildIdentitySchema,
  configuration: ProductConfigurationSnapshotSchema,
  runtimeState: z.enum(["starting", "ready", "offline", "failed"]),
  selectedTaskId: z.string().default(""),
  taskRevision: z.number().int().nonnegative(),
  tasks: ProductTasksStateSchema.shape.tasks,
  windowState: WindowStateSchema,
  chatHistoryContext: ChatHistoryContextSchema.nullable().optional(),
});
const home: Destination = { area: "home", page: "general", taskId: "" };
const initial: WindowSnapshot = {
  status: "starting",
  environment: "preview",
  buildId: null,
  installedVersion: null,
  configuration: null,
  tasks: { revision: 0, tasks: [] },
  activity: [],
  runtime: "starting",
  route: "loading",
  signInObservation: null,
  update: { phase: "unavailable", code: "UPDATE_STATUS_PENDING" },
  intents: {},
  evidence: null,
  readPreview: null,
  readConversation: null,
  directChatPreview: null,
  chatHistoryContext: null,
  chatHistoryEpoch: 0,
  shortcuts: { ...defaultNavigationShortcuts },
  workspaceEditDelivery: null,
  destination: home,
  back: false,
  forward: false,
  sidebar: "full",
  sidebarWidth: shellGeometry.pageListDefault,
  sidebarResizing: false,
  overlay: "none",
  window: { focused: false, fullScreen: false, trafficLightPosition: null },
  appearance: { theme: "system", accent: "iris", font: "geist" },
  capabilities: {
    incarnation: false,
    sequence: false,
    operationQuery: "workspace-edit-only",
    overlayAcknowledgement: false,
  },
};
// This additive renderer capability stays within the controller slice while
// transitional facades without it remain observation-only.
type InstallOnQuitFacade = RendererFacade & {
  setInstallOnQuitPreference(enabled: boolean): Promise<Intent>;
};
function installOnQuitPreferenceEligible(snapshot: WindowSnapshot): boolean {
  const update = snapshot.update;
  const unsettled = (key: string) =>
    snapshot.intents[key]?.state === "pending" ||
    snapshot.intents[key]?.state === "unknown";
  return (
    snapshot.environment === "preview" &&
    snapshot.status === "current" &&
    snapshot.runtime === "ready" &&
    Boolean(snapshot.buildId) &&
    update.installOnQuitPreference?.status === "confirmed" &&
    update.installOnQuitPreference.scope === "install-on-normal-quit" &&
    snapshot.intents["update-install-on-quit"]?.state !== "unknown" &&
    snapshot.intents["update-automatic-downloads"]?.state !== "pending" &&
    !unsettled("update") &&
    !("blockedBy" in update && update.blockedBy?.includes("UNKNOWN")) &&
    (update.phase === "idle" ||
      update.phase === "available" ||
      update.phase === "ready" ||
      (update.phase === "failed" &&
        !update.recoveryRequired &&
        !update.code.includes("UNKNOWN")))
  );
}
export function canSetInstallOnQuitPreference(
  snapshot: WindowSnapshot,
  facade: RendererFacade,
): facade is InstallOnQuitFacade {
  return (
    "setInstallOnQuitPreference" in facade &&
    typeof facade.setInstallOnQuitPreference === "function" &&
    snapshot.intents["update-install-on-quit"]?.state !== "pending" &&
    installOnQuitPreferenceEligible(snapshot)
  );
}
export class WindowController implements RendererFacade {
  readonly draft = new AgentDraftStore();
  readonly conversationDraft = new ConversationDraftStore();
  private state: WindowSnapshot = immutable({ ...initial });
  private readonly listeners = new Set<() => void>();
  private disposers: (() => void)[] = [];
  private startPromise: Promise<void> | null = null;
  private disposed = false;
  private booting = true;
  private readonly configOrder = new ConfigurationRequestOrder();
  private tasksInitialized = false;
  private runtimeRevision = 0;
  private updateRevision = 0;
  private pendingUpdateCheck = false;
  private staleRevision = 0;
  private historyRevision = 0;
  private bufferedTasks: WindowSnapshot["tasks"] | null = null;
  private bufferedEvents: ActivityEntry[] = [];
  private overflow = false;
  private refreshPending = false;
  private eventOrdinal = 0;
  private signInCounter = 0;
  private signInTimer: ReturnType<typeof setTimeout> | null = null;
  private authWindowGeneration = -1;
  private history: Destination[] = [home];
  private cursor = 0;
  private navigationRevision = 0;
  private taskSelectionRevision = 0;
  private readonly seenActions = new Set<string>();
  private sectionNavigationSequence = 0;
  private presentationRevision = 0;
  private resizeStartWidth: number | null = null;
  private presentationDeferred = false;
  private pendingSectionNavigation: {
    action: SectionNavigationAction;
    presentationRevision: number;
  } | null = null;
  private readonly workspaceReadbackCommands = new Map<
    string,
    WorkspaceReadbackBinding
  >();
  private readonly nativeReadbacks = new WeakMap<
    object,
    Readonly<{
      order: number;
      runtimeRevision: number;
      staleRevision: number;
      configuration: WindowSnapshot["configuration"];
      intents: WindowSnapshot["intents"];
    }>
  >();
  private readonly commands = new Map<
    string,
    { fingerprint: Promise<string>; promise: Promise<Intent> }
  >();
  // Window-local provenance and permanent consumption, never backend authority.
  private readonly editPreviews = new Map<string, EditReceipt>();
  private readonly submittedEdits = new Map<string, SubmittedEdit>();
  private readonly observedEdits = new Map<string, ObservedEdit>();
  // An operation ID belongs to its original Intent even if a remount supplies
  // another label. Retain only the digest and content-free result promise.
  private readonly connectorSetupCommands = new Map<
    string,
    { fingerprint: Promise<string>; promise: Promise<Intent> }
  >();
  constructor(
    private readonly api: PreloadApi,
    private readonly persistAppearance: (value: Appearance) => void = () => {},
    private readonly persistShortcuts: (
      value: NavigationShortcuts,
    ) => void = () => {},
    private readonly compactViewport: () => boolean = () => false,
  ) {}
  readonly getSnapshot = (): WindowSnapshot => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (active) {
        active = false;
        this.listeners.delete(listener);
      }
    };
  };
  private patch(value: Partial<WindowSnapshot>): void {
    if (this.disposed) return;
    // General configuration publication cannot overwrite this independent read.
    // Navigation retires pending reads. A settled document sample remains visible
    // across Setup/Settings until loss of its document/runtime context.
    if (
      (value.destination !== undefined &&
        this.state.signInObservation?.pending === true &&
        JSON.stringify(value.destination) !==
          JSON.stringify(this.state.destination)) ||
      (value.status !== undefined && value.status !== "current") ||
      (value.configuration !== undefined &&
        value.configuration?.status !== "ready") ||
      (value.buildId !== undefined && value.buildId !== this.state.buildId) ||
      (value.runtime !== undefined && value.runtime !== this.state.runtime) ||
      value.update?.phase === "applying"
    ) {
      this.retireSignInObservation();
      value = { ...value, signInObservation: null };
    }
    if (
      Object.entries(value).every(
        ([key, item]) => this.state[key as keyof WindowSnapshot] === item,
      )
    )
      return;
    this.state = immutable({ ...this.state, ...value });
    for (const listener of this.listeners) listener();
    if (value.status !== undefined) this.presentation();
  }
  /** Called exactly once by the window entrypoint, outside React. */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.disposed) return Promise.resolve();
    this.disposers = [
      this.api.onConfigurationChanged(() => {
        if (this.booting) this.refreshPending = true;
        else void this.refresh();
      }),
      this.api.onTasksState((value) => {
        const parsed = ProductTasksStateSchema.safeParse(value);
        if (!parsed.success) {
          this.stale();
          return;
        }
        if (this.booting) {
          if (
            !this.bufferedTasks ||
            parsed.data.revision >= this.bufferedTasks.revision
          )
            this.bufferedTasks = parsed.data;
        } else this.adoptTasks(parsed.data);
      }),
      this.api.onRuntimeEvent((value) => this.record(value)),
      this.api.onRuntimeState((value) => {
        this.invalidateSignInObservation();
        const parsed = RuntimeStatusSchema.safeParse(value);
        if (parsed.success) {
          this.runtimeRevision++;
          if (parsed.data.state !== "ready") this.invalidateHistory();
          this.patch({
            runtime: parsed.data.state,
            ...(parsed.data.state === "offline" ||
            parsed.data.state === "failed"
              ? { status: "stale" as const }
              : {}),
          });
        }
      }),
      this.api.onInstalledUpdateState((value) => this.adoptUpdate(value)),
      this.api.onBrowserRouteState((value) => {
        this.invalidateSignInObservation();
        const parsed = BrowserRouteStatusSchema.safeParse(value);
        if (parsed.success) {
          this.patch({ route: parsed.data.state });
          // Page load retires the old sample. Read the newly loaded document
          // while this step is open; the event itself is never sign-in proof.
          if (parsed.data.state === "loaded") this.observeSignIn();
        }
      }),
      this.api.onTaskSurfaceState((value) => {
        const parsed = TaskSurfaceStatusSchema.safeParse(value);
        if (parsed.success && parsed.data.state === "failed") this.stale();
      }),
      this.api.onLayout((value) => this.hostLayout(value)),
      this.api.onShellAction((value) => this.shellAction(value)),
      this.api.onWindowState((value) => {
        const parsed = WindowStateSchema.safeParse(value);
        if (parsed.success) this.patch({ window: parsed.data });
      }),
    ];
    const runtimeAtStart = this.runtimeRevision;
    const windowAtStart = this.state.window;
    const order = this.configOrder.begin();
    this.startPromise = (async () => {
      try {
        const value = await this.api.bootstrap();
        if (this.disposed) return;
        const parsed = BootstrapProjectionSchema.safeParse(value);
        if (!parsed.success) {
          this.patch({ status: "incompatible" });
          return;
        }
        const data = parsed.data;
        this.adoptHistoryContext(data.chatHistoryContext ?? null);
        this.patch({
          environment: data.environment,
          buildId: data.build.buildId,
          installedVersion: {
            version: data.build.version,
            buildVersion: data.build.buildVersion ?? null,
          },
          runtime:
            this.runtimeRevision === runtimeAtStart
              ? data.runtimeState
              : this.state.runtime,
          window:
            this.state.window === windowAtStart
              ? data.windowState
              : this.state.window,
        });
        this.adoptConfiguration(data.configuration, order);
        // A contradictory revision stays stale instead of being cleared by
        // bootstrap completion or its automatic refresh.
        if (
          !this.adoptTasks({ revision: data.taskRevision, tasks: data.tasks })
        )
          return;
        if (this.bufferedTasks && !this.adoptTasks(this.bufferedTasks)) return;
        const pending = this.pendingSectionNavigation;
        const pendingTaskSelection =
          pending &&
          pending.presentationRevision === this.presentationRevision &&
          this.state.tasks.tasks.some(
            (task) => task.taskId === pending.action.taskId,
          );
        if (
          this.taskSelectionRevision === 0 &&
          !pendingTaskSelection &&
          this.state.update.phase !== "applying" &&
          data.selectedTaskId !== "" &&
          this.state.tasks.tasks.some(
            (task) => task.taskId === data.selectedTaskId,
          )
        ) {
          // Before any explicit task choice, blank history cursors are startup
          // placeholders. Restore them in place without adding navigation.
          this.history = this.history.map((destination) =>
            destination.taskId === ""
              ? { ...destination, taskId: data.selectedTaskId }
              : destination,
          );
          const destination = this.history[this.cursor]!;
          this.draft.select(destination.taskId);
          this.patch({ destination });
        }
        const ids = new Set(
          this.state.tasks.tasks.map((task) => `${task.taskId}:${task.turnId}`),
        );
        this.patch({
          activity: this.bufferedEvents.filter((event) =>
            ids.has(`${event.taskId}:${event.turnId}`),
          ),
          status:
            this.overflow ||
            this.state.configuration?.status !== "ready" ||
            this.state.runtime !== "ready"
              ? "stale"
              : "current",
        });
        if (
          this.presentationRevision === 0 &&
          this.state.configuration?.status === "ready"
        ) {
          const settings = this.state.configuration.settings;
          this.patch({ sidebar: settings.general.sidebarDefault });
          if (
            !this.pendingSectionNavigation &&
            (settings.setup.journey.dismissed ||
              computerSetup(this.state).ready)
          ) {
            const launch = settings.general.openAtLaunch;
            this.navigate(
              launch === "home"
                ? { area: "home" }
                : launch === "browser"
                  ? { area: "chatgpt" }
                  : launch === "computer"
                    ? { area: "settings", page: "computer" }
                    : launch === "settings"
                      ? { area: "settings", page: "general" }
                      : { area: "activity" },
            );
          }
        }
      } catch {
        this.patch({ status: "unavailable" });
      } finally {
        this.booting = false;
        this.bufferedEvents = [];
        this.bufferedTasks = null;
        const pending = this.pendingSectionNavigation;
        this.pendingSectionNavigation = null;
        if (
          !pending ||
          pending.presentationRevision !== this.presentationRevision ||
          !this.applySectionNavigation(pending.action)
        )
          this.presentation();
      }
      if (this.disposed) return;
      const revision = this.updateRevision;
      try {
        const value = await this.api.installedUpdate({ kind: "status" });
        if (this.updateRevision === revision) this.adoptUpdate(value);
      } catch {
        if (this.updateRevision === revision) {
          // Failed readback is a newer negative observation, not a settlement
          // of an already applying update or permission for an older reply.
          this.updateRevision++;
          if (this.state.update.phase !== "applying")
            this.patch({
              update: {
                phase: "unavailable",
                code: "UPDATE_STATUS_UNAVAILABLE",
              },
            });
        }
      }
      if (this.refreshPending || this.overflow) await this.refresh();
      if (this.pendingUpdateCheck && !this.disposed) {
        this.pendingUpdateCheck = false;
        await this.checkUpdateOnOpen();
      }
    })();
    return this.startPromise;
  }
  /** Window teardown only. React observation disposers never call this. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.retireSignInObservation();
    this.state = immutable({ ...this.state, signInObservation: null });
    this.conversationDraft.dispose();
    this.pendingSectionNavigation = null;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.listeners.clear();
  }
  private stale(): void {
    this.staleRevision++;
    this.invalidateHistory();
    if (this.booting) this.overflow = true;
    this.patch({ status: "stale", evidence: null });
  }
  private adoptConfiguration(
    value: WindowSnapshot["configuration"],
    order: number,
  ): void {
    if (!value || !this.configOrder.isLatest(order)) return;
    if (
      this.state.configuration &&
      !shouldAdoptConfigurationSnapshot(this.state.configuration, value)
    )
      return;
    if (value.status === "ready") {
      const settings = { ...value.settings };
      delete settings.tasks;
      value = { ...value, settings };
    }
    const pending =
      value.status === "ready"
        ? value.settings.computer.pendingEdit?.operationId
        : null;
    this.patch({
      configuration: value,
      evidence: null,
      workspaceEditDelivery:
        pending === this.state.workspaceEditDelivery
          ? this.state.workspaceEditDelivery
          : null,
    });
  }
  private adoptTasks(value: WindowSnapshot["tasks"]): boolean {
    if (value.revision < this.state.tasks.revision) return true;
    if (
      value.revision === this.state.tasks.revision &&
      JSON.stringify(value) === JSON.stringify(this.state.tasks)
    ) {
      this.tasksInitialized = true;
      return true;
    }
    if (value.revision === this.state.tasks.revision && this.tasksInitialized) {
      this.stale();
      return false;
    }
    this.tasksInitialized = true;
    // Admitted metadata remains inspectable after its turn moves on.
    this.patch({ tasks: value });
    return true;
  }
  private record(value: unknown): void {
    const parsed = ClientEventSchema.safeParse(value);
    if (!parsed.success) {
      this.stale();
      return;
    }
    const event = parsed.data;
    if (event.kind === "text.delta") return; // Transcript bodies never enter UI history.
    const task = this.state.tasks.tasks.find(
      (item) => item.taskId === event.taskId && item.turnId === event.turnId,
    );
    if (!this.booting && !task) return;
    const entry: ActivityEntry = {
      id: `${event.taskId}:${event.turnId}:${event.generation}:${++this.eventOrdinal}`,
      taskId: event.taskId,
      turnId: event.turnId,
      generation: event.generation,
      label: task?.label ?? "Task",
      kind: event.kind,
      at: event.at,
      phase: "phase" in event ? event.phase : null,
      operation: "operation" in event ? event.operation : null,
      code: "code" in event ? displayCode(event.code) : null,
    };
    if (this.booting) {
      if (this.bufferedEvents.length >= 256) {
        this.overflow = true;
        return;
      }
      this.bufferedEvents.push(entry);
    } else
      this.patch({ activity: [...this.state.activity, entry].slice(-256) });
  }
  private adoptUpdate(value: unknown): void {
    // A newer invalid observation also fences older replies; it cannot revive
    // their status or release an already applying update.
    this.updateRevision++;
    const parsed = InstalledUpdateViewSchema.safeParse(value);
    if (parsed.success) {
      if (parsed.data.phase === "failed" || parsed.data.phase === "unavailable")
        parsed.data.code = displayCode(parsed.data.code);
      this.patch({ update: parsed.data });
      if (parsed.data.phase !== "applying" && this.presentationDeferred)
        this.presentation();
    } else if (this.state.update.phase !== "applying")
      this.patch({
        update: { phase: "unavailable", code: "UPDATE_STATE_INVALID" },
      });
    // An invalid projection cannot release the last known applying admission.
    // Keep deferred presentation until a valid settlement arrives.
  }
  async refresh(): Promise<void> {
    await this.refreshReadback();
  }
  async refreshReadback(): Promise<NativeRefreshResult> {
    if (this.disposed) return { status: "unqualified", reason: "disposed" };
    const order = this.configOrder.begin();
    const runtimeRevision = this.runtimeRevision;
    const staleRevision = this.staleRevision;
    try {
      const value = await this.api.bootstrap();
      if (this.disposed) return { status: "unqualified", reason: "disposed" };
      if (!this.configOrder.isLatest(order))
        return { status: "unqualified", reason: "superseded" };
      const parsed = BootstrapProjectionSchema.safeParse(value);
      if (!parsed.success) {
        this.invalidateHistory();
        this.patch({ status: "incompatible" });
        return { status: "unqualified", reason: "malformed" };
      }
      // Legacy bootstrap has no authenticated generation; never present one.
      if (
        this.state.buildId &&
        parsed.data.build.buildId !== this.state.buildId
      ) {
        this.invalidateHistory();
        this.patch({ status: "incompatible" });
        return { status: "unqualified", reason: "incompatible" };
      }
      const previousConfiguration = this.state.configuration;
      this.adoptConfiguration(parsed.data.configuration, order);
      const adoptedConfiguration = this.state.configuration;
      const tasksAccepted = this.adoptTasks({
        revision: parsed.data.taskRevision,
        tasks: parsed.data.tasks,
      });
      const runtime =
        runtimeRevision === this.runtimeRevision
          ? parsed.data.runtimeState
          : this.state.runtime;
      this.adoptHistoryContext(parsed.data.chatHistoryContext ?? null);
      const status =
        parsed.data.configuration.status === "ready" &&
        tasksAccepted &&
        staleRevision === this.staleRevision &&
        runtime === "ready"
          ? "current"
          : "stale";
      // A later valid bootstrap with the same context must not revive cached
      // answers or admit a read started before this loss of current state.
      if (status !== "current") this.invalidateHistory();
      this.patch({
        status,
        runtime,
      });
      if (this.disposed) return { status: "unqualified", reason: "disposed" };
      if (!this.configOrder.isLatest(order))
        return { status: "unqualified", reason: "superseded" };
      if (
        adoptedConfiguration === previousConfiguration ||
        this.state.configuration !== adoptedConfiguration
      )
        return { status: "unqualified", reason: "not-adopted" };
      if (
        status !== "current" ||
        runtimeRevision !== this.runtimeRevision ||
        adoptedConfiguration?.status !== "ready" ||
        this.state.evidence !== null
      )
        return { status: "unqualified", reason: "not-current" };
      const receipt: NativeRefreshResult = Object.freeze({
        status: "adopted",
        requestId: order,
        buildId: parsed.data.build.buildId,
        computerId: adoptedConfiguration.settings.computer.computerId,
        generation: adoptedConfiguration.settings.computer.generation,
        configuration: adoptedConfiguration,
        evidence: null,
      });
      this.nativeReadbacks.set(receipt, {
        order,
        runtimeRevision,
        staleRevision,
        configuration: adoptedConfiguration,
        intents: this.state.intents,
      });
      return receipt;
    } catch {
      if (this.disposed) return { status: "unqualified", reason: "disposed" };
      if (!this.configOrder.isLatest(order))
        return { status: "unqualified", reason: "superseded" };
      this.stale();
      return { status: "unqualified", reason: "transport-unknown" };
    }
  }
  reconcileWorkspaceReadback(
    receipt: NativeRefreshResult,
    intention: string,
    pending: WorkspaceReadbackBinding,
  ): Intent | null {
    const source = this.nativeReadbacks.get(receipt);
    const command = this.workspaceReadbackCommands.get(intention);
    const original = this.state.intents[intention];
    if (
      this.disposed ||
      receipt.status !== "adopted" ||
      !source ||
      !command ||
      !this.configOrder.isLatest(source.order) ||
      this.runtimeRevision !== source.runtimeRevision ||
      this.staleRevision !== source.staleRevision ||
      this.state.status !== "current" ||
      this.state.runtime !== "ready" ||
      this.state.configuration !== source.configuration ||
      this.state.evidence !== null ||
      this.state.intents !== source.intents ||
      this.state.buildId !== receipt.buildId ||
      original?.state !== "unknown" ||
      original.code !== "CONFIGURATION_OUTCOME_UNKNOWN" ||
      command.buildId !== pending.buildId ||
      command.generation !== pending.generation ||
      command.scope !== pending.scope ||
      command.previousCheckId !== pending.previousCheckId ||
      command.connectionIdentity !== pending.connectionIdentity ||
      JSON.stringify(command.command) !== JSON.stringify(pending.command) ||
      Boolean(receipt.configuration.settings.computer.pendingEdit) ||
      receipt.configuration.settings.setup.computer.outcomeUnknown ||
      !workspaceReadbackConfirms(
        command,
        receipt.configuration.settings,
        receipt.buildId,
      )
    )
      return null;
    // Only an unconfirmed response to a read-only check can use its exact
    // native witness. Typed backend uncertainty retains the original fence.
    const resolved: Intent = {
      id: intention,
      state: "applied",
      code: "WORKSPACE_READBACK_CONFIRMED",
      workspaceReadback: {
        requestId: receipt.requestId,
        originalCode: original.code,
      },
    };
    this.nativeReadbacks.delete(receipt);
    this.workspaceReadbackCommands.delete(intention);
    this.commands.delete(intention);
    this.patch({ intents: { ...this.state.intents, [intention]: resolved } });
    return resolved;
  }
  async readChatHistory(query: ChatHistoryQuery): Promise<ChatHistoryReply> {
    const before = this.state;
    const context = before.chatHistoryContext;
    const revision = this.staleRevision;
    const runtimeRevision = this.runtimeRevision;
    const historyRevision = this.historyRevision;
    const request = ChatHistoryQuerySchema.parse(query);
    if (
      this.disposed ||
      before.status !== "current" ||
      !context ||
      !this.api.chatHistory
    )
      throw new Error("CHAT_HISTORY_UNAVAILABLE");
    const raw = await this.api.chatHistory({ context, query: request });
    if (
      this.disposed ||
      this.state.status !== "current" ||
      revision !== this.staleRevision ||
      runtimeRevision !== this.runtimeRevision ||
      historyRevision !== this.historyRevision ||
      before.buildId !== this.state.buildId ||
      !sameHistoryContext(context, this.state.chatHistoryContext)
    )
      throw new Error("CHAT_HISTORY_STALE");
    const reply = ChatHistoryReplySchema.parse(raw);
    if (
      !sameHistoryContext(reply.context, context) ||
      reply.value.kind !== (request.kind === "list" ? "page" : "result")
    )
      throw new Error("CHAT_HISTORY_CROSSED");
    if (
      request.kind === "list" &&
      reply.value.kind === "page" &&
      reply.value.offset !== request.offset
    )
      throw new Error("CHAT_HISTORY_CROSSED");
    if (
      request.kind === "result" &&
      reply.value.kind === "result" &&
      (reply.value.entry.key.operationId !== request.key.operationId ||
        reply.value.entry.key.backendGeneration !==
          request.key.backendGeneration)
    )
      throw new Error("CHAT_HISTORY_CROSSED");
    return immutable(reply);
  }
  private adoptHistoryContext(context: ChatHistoryContext | null): void {
    if (
      sameHistoryContext(context, this.state.chatHistoryContext) ||
      (context === null && this.state.chatHistoryContext === null)
    )
      return;
    this.invalidateHistory();
    this.invalidateSignInObservation();
    this.patch({ chatHistoryContext: context });
  }
  private invalidateHistory(): void {
    this.historyRevision++;
    this.patch({ chatHistoryEpoch: this.historyRevision });
  }
  private dispatch(
    key: string,
    payload: unknown,
    run: () => Promise<Intent>,
    setupOperationId?: string,
    retainSettlement = false,
  ): Promise<Intent> {
    // Only a digest survives an uncertain result; never retain credentials or
    // private command bodies in the intention map.
    const fingerprint = async (): Promise<string> => {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    };
    const previous =
      this.commands.get(key) ??
      (setupOperationId
        ? this.connectorSetupCommands.get(setupOperationId)
        : undefined);
    if (previous)
      return Promise.all([previous.fingerprint, fingerprint()])
        .then(([before, after]) =>
          before === after
            ? previous.promise
            : {
                id: key,
                state: "refused" as const,
                code: "INTENTION_PAYLOAD_CONFLICT",
              },
        )
        .catch(() => ({
          id: key,
          state: "refused",
          code: "COMMAND_BINDING_UNAVAILABLE",
        }));
    if (this.disposed || this.state.status !== "current") {
      const result: Intent = {
        id: key,
        state: "refused",
        code: this.disposed
          ? "WINDOW_OBSERVATION_CLOSED"
          : "CURRENT_STATE_REQUIRED",
      };
      this.patch({ intents: { ...this.state.intents, [key]: result } });
      return Promise.resolve(result);
    }
    let resolve!: (result: Intent) => void;
    const promise = new Promise<Intent>((done) => {
      resolve = done;
    });
    // The latch is installed synchronously, before notification or any effect.
    const binding = fingerprint();
    const retained = { fingerprint: binding, promise };
    this.commands.set(key, retained);
    if (setupOperationId)
      this.connectorSetupCommands.set(setupOperationId, retained);
    this.patch({
      intents: {
        ...this.state.intents,
        [key]: { id: key, state: "pending", code: null },
      },
    });
    void (async () => {
      let result: Intent;
      try {
        await binding;
      } catch {
        result = {
          id: key,
          state: "refused",
          code: "COMMAND_BINDING_UNAVAILABLE",
        };
        if (!retainSettlement) this.commands.delete(key);
        this.patch({ intents: { ...this.state.intents, [key]: result } });
        resolve(result);
        return;
      }
      try {
        result =
          this.disposed || this.state.status !== "current"
            ? { id: key, state: "refused", code: "CURRENT_STATE_REQUIRED" }
            : await run();
      } catch {
        result = { id: key, state: "unknown", code: "COMMAND_OUTCOME_UNKNOWN" };
      }
      result = {
        ...result,
        code: result.code === null ? null : displayCode(result.code),
      };
      if (result.state !== "unknown" && !retainSettlement)
        this.commands.delete(key);
      this.patch({ intents: { ...this.state.intents, [key]: result } });
      resolve(result);
    })();
    return promise;
  }
  configure(
    value: ProductConfigurationCommand,
    intention: string,
  ): Promise<Intent> {
    const parsed = ProductConfigurationCommandSchema.safeParse(value);
    if (!parsed.success)
      return Promise.resolve({
        id: intention,
        state: "refused",
        code: "SETTINGS_INPUT_INVALID",
      });
    // Capture validated values before digest/transport awaits. Caller mutation
    // must not change the original operation or its receipt correlation.
    const command = parsed.data;
    if (command.kind === "chatgpt.observe-sign-in")
      return Promise.resolve({
        id: intention,
        state: "refused",
        code: "SIGN_IN_OBSERVATION_WINDOW_OWNED",
      });
    // Presentation has one window-owned intention across clicks and remounts,
    // including known refusals. A new label must not release that latch.
    if (command.kind === "chatgpt.present-browser")
      intention = "settings:chatgpt.present-browser:";
    if (command.kind === "chatgpt.verify") this.invalidateSignInObservation();
    return this.dispatch(
      intention,
      command,
      async () => {
        const before = this.state;
        if (command.kind === "chatgpt.present-browser") {
          // Recheck after the digest await; navigation or admission may have
          // changed while the synchronous pending latch was being published.
          if (
            before.runtime !== "ready" ||
            before.update.phase === "applying" ||
            before.destination.area !== "chatgpt"
          )
            return {
              id: intention,
              state: "refused",
              code: "CHATGPT_PRESENTATION_UNAVAILABLE",
            };
          if (
            before.route === "loaded" ||
            before.tasks.tasks.length > 0 ||
            before.destination.taskId !== "" ||
            before.intents["settings:chatgpt.open-browser:"] ||
            before.intents["settings:chatgpt.open-sign-in:"]
          )
            return { id: intention, state: "applied", code: null };
        }
        if (
          command.kind === "connector.save-and-connect" &&
          command.buildId !== before.buildId
        )
          return {
            id: intention,
            state: "refused",
            code: "CONNECTOR_SETUP_BINDING_CHANGED",
          };
        if (command.kind === "computer.apply-workspace-edit") {
          if (this.submittedEdits.has(command.operationId))
            return {
              id: intention,
              state: "refused",
              code: "WORKSPACE_EDIT_ALREADY_CONSUMED",
            };
          const receipt = this.editPreviews.get(command.operationId);
          this.submittedEdits.set(command.operationId, {
            intention,
            receipt:
              receipt &&
              before.configuration === receipt.configuration &&
              before.evidence?.value === receipt.preview &&
              this.sameEditOwner(receipt, before)
                ? receipt
                : null,
          });
        }
        if (command.kind === "computer.observe-workspace-edit")
          this.observedEdits.delete(command.operationId);
        const acknowledged =
          command.kind === "computer.ack-workspace-edit"
            ? this.observedEdits.get(command.operationId)
            : undefined;
        if (
          (command.kind === "computer.verify-workspace" ||
            command.kind === "computer.check-folder") &&
          before.configuration?.status === "ready" &&
          before.buildId
        )
          this.workspaceReadbackCommands.set(
            intention,
            workspaceReadbackBinding(
              before.configuration.settings,
              before.buildId,
              command,
            ),
          );
        const order = this.configOrder.begin();
        let transport: Parameters<typeof classifyConfigurationResponse>[0];
        try {
          transport = {
            settled: "fulfilled",
            value: await this.api.configure(command),
          };
        } catch {
          transport = { settled: "rejected" };
        }
        const outcome = classifyConfigurationResponse(transport);
        if (outcome.kind === "unconfirmed")
          return {
            id: intention,
            state: "unknown",
            code: "CONFIGURATION_OUTCOME_UNKNOWN",
          };
        if (command.kind === "connector.save-and-connect") {
          const receipt = outcome.result.connectorSetup;
          if (
            !receipt ||
            receipt.operationId !== command.operationId ||
            receipt.buildId !== command.buildId ||
            receipt.buildId !== before.buildId ||
            this.state.buildId !== before.buildId ||
            this.state.status === "incompatible"
          )
            return {
              id: intention,
              state: "unknown",
              code: "CONFIGURATION_OUTCOME_UNKNOWN",
            };
        }
        this.adoptConfiguration(outcome.result.snapshot, order);
        const delivery = workspaceEditToAcknowledge(command, outcome);
        if (delivery && this.configOrder.isLatest(order))
          this.patch({ workspaceEditDelivery: delivery });
        const revision = this.state.configuration
          ? configurationEvidenceRevision(
              this.state.configuration,
              outcome.result.snapshot,
              this.configOrder.isLatest(order),
            )
          : null;
        if (outcome.result.ok && outcome.result.evidence && revision !== null)
          this.patch({
            evidence: { revision, value: outcome.result.evidence },
          });
        if (outcome.result.ok) {
          const value = outcome.result.evidence;
          const retained = this.state.readPreview;
          if (
            command.kind === "chatgpt.submit-readonly-task" ||
            command.kind === "chatgpt.start-conversation" ||
            command.kind === "chatgpt.observe-readonly-conversation" ||
            command.kind === "chatgpt.ack-readonly-conversation" ||
            command.kind === "chatgpt.follow-readonly-conversation"
          ) {
            // An independent refresh may win configuration snapshot ordering.
            // Conversation correlation still uses the exact current revision,
            // build and retained owner below; do not adopt the older snapshot.
            const conversationRevision = this.state.configuration
              ? configurationEvidenceRevision(
                  this.state.configuration,
                  outcome.result.snapshot,
                  true,
                )
              : null;
            const start = command.kind === "chatgpt.submit-readonly-task";
            const typedStart = command.kind === "chatgpt.start-conversation";
            const inspected = before.directChatPreview;
            const exactTypedStart =
              typedStart &&
              inspected &&
              inspected.value.operationId === command.operationId &&
              inspected.value.confirmationId === command.confirmationId &&
              inspected.buildId === before.buildId &&
              inspected.revision === conversationRevision &&
              this.state.directChatPreview === inspected;
            const first = before.readPreview;
            const exactStart =
              start &&
              first &&
              first.value.operationId === command.operationId &&
              first.value.account?.state === "approved" &&
              first.buildId === before.buildId &&
              first.revision === conversationRevision &&
              this.state.readPreview === first;
            const next =
              value?.kind === "chatgpt.readonly-conversation" &&
              this.state.status === "current" &&
              before.buildId &&
              before.buildId === this.state.buildId &&
              conversationRevision !== null &&
              (!start || exactStart) &&
              (!typedStart || exactTypedStart) &&
              before.readConversation === this.state.readConversation
                ? adoptReadConversation(before.readConversation, value, {
                    action: typedStart
                      ? "typed-start"
                      : start
                        ? "start"
                        : command.kind ===
                            "chatgpt.observe-readonly-conversation"
                          ? "progress"
                          : command.kind === "chatgpt.ack-readonly-conversation"
                            ? "ack"
                            : "follow",
                    operationId: command.operationId,
                    ...(typedStart && inspected
                      ? { sessionId: inspected.value.sessionId }
                      : {}),
                    ...("handleId" in command
                      ? { handleId: command.handleId }
                      : {}),
                    ...("cursor" in command ? { cursor: command.cursor } : {}),
                    ...("resultId" in command
                      ? { resultId: command.resultId }
                      : {}),
                    buildId: before.buildId,
                    revision: conversationRevision,
                  })
                : null;
            if (!next)
              return {
                id: intention,
                state: "unknown",
                code: "READ_CONVERSATION_UNCONFIRMED",
              };
            this.patch({ readConversation: next });
          }
          if (command.kind === "chatgpt.inspect-chat-account") {
            if (
              revision === null ||
              before.configuration?.status !== "ready" ||
              revision !== before.configuration.settings.revision ||
              !before.buildId ||
              before.buildId !== this.state.buildId ||
              this.state.status !== "current" ||
              this.state.directChatPreview !== null ||
              before.readConversation !== null ||
              value?.kind !== "chatgpt.chat-account-preview" ||
              value.operationId !== command.operationId
            )
              return {
                id: intention,
                state: "unknown",
                code: "CHAT_ACCOUNT_UNCONFIRMED",
              };
            this.patch({
              directChatPreview: {
                intention,
                buildId: before.buildId,
                revision,
                value,
              },
            });
          } else if (command.kind === "chatgpt.cancel-readonly-task") {
            // Exact known cancellation retires this receipt even if a refresh won
            // snapshot ordering. A different operation is never removed.
            if (retained?.value.operationId === command.operationId)
              this.patch({ readPreview: null });
          } else if (command.kind === "chatgpt.prepare-readonly-task") {
            if (
              revision === null ||
              before.configuration?.status !== "ready" ||
              revision !== before.configuration.settings.revision ||
              !before.buildId ||
              before.buildId !== this.state.buildId ||
              value?.kind !== "chatgpt.readonly-task-preview" ||
              value.workspaceId !== command.workspaceId ||
              value.account !== undefined ||
              retained !== null
            )
              return {
                id: intention,
                state: "unknown",
                code: "READ_PREVIEW_UNCONFIRMED",
              };
            this.patch({
              readPreview: {
                prepareIntention: intention,
                evidenceIntention: intention,
                buildId: before.buildId,
                revision,
                value,
              },
            });
          } else if (
            command.kind === "chatgpt.inspect-readonly-account" ||
            command.kind === "chatgpt.approve-readonly-account"
          ) {
            const sameMetadata =
              retained &&
              value?.kind === "chatgpt.readonly-task-preview" &&
              JSON.stringify({ ...retained.value, account: undefined }) ===
                JSON.stringify({ ...value, account: undefined });
            if (
              !retained ||
              before.readPreview !== retained ||
              retained.value.operationId !== command.operationId ||
              retained.buildId !== this.state.buildId ||
              revision !== retained.revision ||
              !sameMetadata ||
              value?.kind !== "chatgpt.readonly-task-preview" ||
              !value.account ||
              (retained.value.account &&
                retained.value.account.confirmationId !==
                  value.account.confirmationId) ||
              (retained.value.account?.state === "approved" &&
                value.account.state !== "approved") ||
              (command.kind === "chatgpt.inspect-readonly-account" &&
                value.account.state !== "observed") ||
              (command.kind === "chatgpt.approve-readonly-account" &&
                (!retained.value.account ||
                  retained.value.account.confirmationId !==
                    command.confirmationId ||
                  value.account.confirmationId !== command.confirmationId ||
                  value.account.state !== "approved"))
            )
              return {
                id: intention,
                state: "unknown",
                code: "READ_ACCOUNT_UNCONFIRMED",
              };
            this.patch({
              readPreview: { ...retained, evidenceIntention: intention, value },
            });
          }
        }
        const result: Intent = {
          id: intention,
          state: configurationEffectOutcome(outcome),
          code: outcome.result.ok ? null : outcome.result.error,
          ...(outcome.result.connectorSetup
            ? { connectorSetup: outcome.result.connectorSetup }
            : {}),
          ...(command.kind === "chatgpt.verify" &&
          outcome.result.ok &&
          outcome.result.evidence?.kind === "chatgpt.readiness"
            ? { chatGptReadiness: outcome.result.evidence }
            : {}),
          ...(!outcome.result.ok && outcome.result.connectorAttempt
            ? { connectorAttempt: outcome.result.connectorAttempt }
            : {}),
        };
        const value = outcome.result.ok ? outcome.result.evidence : undefined;
        if (
          command.kind === "computer.prepare-workspace-edit" &&
          value?.kind === "computer.workspace-edit-preview" &&
          value.workspaceId === command.workspaceId &&
          before.configuration?.status === "ready" &&
          this.state.configuration?.status === "ready" &&
          this.configOrder.isLatest(order) &&
          revision === before.configuration.settings.revision &&
          before.buildId &&
          before.buildId === this.state.buildId &&
          before.configuration.settings.computer.computerId ===
            this.state.configuration.settings.computer.computerId &&
          before.configuration.settings.computer.generation ===
            this.state.configuration.settings.computer.generation &&
          this.state.status === "current"
        ) {
          const retained = this.editPreviews.get(value.operationId);
          if (
            retained &&
            (retained.buildId !== before.buildId ||
              retained.computerId !==
                before.configuration.settings.computer.computerId ||
              retained.generation !==
                before.configuration.settings.computer.generation ||
              JSON.stringify(retained.preview) !== JSON.stringify(value))
          )
            return {
              id: intention,
              state: "unknown",
              code: "WORKSPACE_EDIT_PREVIEW_UNCONFIRMED",
            };
          this.editPreviews.set(value.operationId, {
            preview: value,
            configuration: this.state.configuration,
            buildId: before.buildId,
            computerId: before.configuration.settings.computer.computerId,
            generation: before.configuration.settings.computer.generation,
          });
        }
        if (command.kind === "computer.observe-workspace-edit") {
          // Only this parsed command reply can supply settlement evidence. Ambient
          // snapshots, delivery IDs and another intention's evidence cannot.
          this.observedEdits.delete(command.operationId);
          const submitted = this.submittedEdits.get(command.operationId);
          const receipt = submitted?.receipt;
          if (
            submitted &&
            receipt &&
            delivery === command.operationId &&
            revision !== null &&
            this.configOrder.isLatest(order) &&
            this.samePendingEdit(receipt, before) &&
            this.samePendingEdit(receipt, this.state) &&
            (result.state === "applied" || result.state === "refused") &&
            (result.state === "refused" ||
              (value?.kind === "computer.workspace-mutation" &&
                value.operation === "edit" &&
                value.operationId === receipt.preview.operationId &&
                value.workspaceId === receipt.preview.workspaceId &&
                value.relativePath === receipt.preview.relativePath &&
                value.beforeSha256 === receipt.preview.beforeSha256))
          )
            this.observedEdits.set(command.operationId, {
              submitted,
              configuration: this.state.configuration,
              evidence: this.state.evidence,
              state: result.state,
              code: result.code,
            });
        }
        if (
          command.kind === "computer.ack-workspace-edit" &&
          result.state === "applied" &&
          revision !== null &&
          this.configOrder.isLatest(order) &&
          acknowledged?.submitted.receipt &&
          before.workspaceEditDelivery === command.operationId &&
          before.configuration === acknowledged.configuration &&
          before.evidence === acknowledged.evidence &&
          this.samePendingEdit(acknowledged.submitted.receipt, before) &&
          this.sameEditOwner(acknowledged.submitted.receipt, this.state) &&
          before.configuration?.status === "ready" &&
          this.state.configuration?.status === "ready" &&
          this.state.configuration.settings.revision >
            before.configuration.settings.revision &&
          this.state.configuration.settings.computer.pendingEdit === null
        ) {
          const original = this.state.intents[acknowledged.submitted.intention];
          if (original?.state === "unknown")
            this.patch({
              intents: {
                ...this.state.intents,
                [original.id]: {
                  id: original.id,
                  state: acknowledged.state,
                  code: acknowledged.code,
                },
              },
            });
          // Retain both the submitted identity and the original dispatch latch.
          // Settlement permits a NEW operation, never another original Apply.
          this.observedEdits.delete(command.operationId);
        }
        return result;
      },
      command.kind === "connector.save-and-connect"
        ? command.operationId
        : undefined,
      command.kind === "chatgpt.present-browser",
    );
  }
  private sameEditOwner(
    receipt: EditReceipt,
    current: WindowSnapshot,
  ): boolean {
    return (
      current.status === "current" &&
      current.buildId === receipt.buildId &&
      current.configuration?.status === "ready" &&
      current.configuration.settings.computer.computerId ===
        receipt.computerId &&
      current.configuration.settings.computer.generation === receipt.generation
    );
  }
  private samePendingEdit(
    receipt: EditReceipt,
    current: WindowSnapshot,
  ): boolean {
    const pending =
      current.configuration?.status === "ready"
        ? current.configuration.settings.computer.pendingEdit
        : null;
    return (
      this.sameEditOwner(receipt, current) &&
      pending?.operationId === receipt.preview.operationId &&
      pending.workspaceId === receipt.preview.workspaceId &&
      pending.relativePath === receipt.preview.relativePath &&
      pending.computerGeneration === receipt.generation
    );
  }
  task(value: ProductTaskCommand, intention: string): Promise<Intent> {
    const parsed = ProductTaskCommandSchema.safeParse(value);
    if (!parsed.success)
      return Promise.resolve({
        id: intention,
        state: "refused",
        code: "TASK_COMMAND_INVALID",
      });
    // Bind validation, fingerprint and transport to the same owned values.
    const command = parsed.data;
    const nav = this.navigationRevision;
    return this.dispatch(intention, command, async () => {
      const build = this.state.buildId;
      const runtimeRevision = this.runtimeRevision;
      const staleRevision = this.staleRevision;
      const result = ProductTaskCommandResultSchema.safeParse(
        await this.api.task(command),
      );
      if (!result.success)
        return {
          id: intention,
          state: "unknown",
          code: "TASK_OUTCOME_UNKNOWN",
        };
      const sameContext = () =>
        !this.disposed &&
        build === this.state.buildId &&
        runtimeRevision === this.runtimeRevision &&
        staleRevision === this.staleRevision;
      // The operation receipt can settle without replacing a newer owner view.
      if (sameContext()) this.adoptTasks(result.data.state);
      if (!result.data.ok)
        return {
          id: intention,
          state:
            result.data.error.includes("OUTCOME_UNKNOWN") ||
            result.data.error === "TASK_CANCEL_FAILED"
              ? "unknown"
              : "refused",
          code: result.data.error,
        };
      const selectedTaskId = result.data.selectedTaskId;
      const selected = result.data.state.tasks.find(
        (task) => task.taskId === selectedTaskId,
      );
      if (
        sameContext() &&
        this.state.status === "current" &&
        this.state.runtime === "ready" &&
        selected &&
        this.state.tasks.tasks.some(
          (task) =>
            task.taskId === selected.taskId &&
            task.sessionId === selected.sessionId &&
            task.turnId === selected.turnId,
        ) &&
        nav === this.navigationRevision &&
        this.state.overlay === "none"
      )
        this.navigate({ area: "chatgpt", taskId: selected.taskId });
      return { id: intention, state: "applied", code: null };
    });
  }
  update(action: UpdateAction, noticeKey?: string): Promise<Intent> {
    if (action === "notice-seen") {
      const current = this.state.update;
      const notice = "notice" in current ? current.notice : undefined;
      if (
        !notice ||
        notice.key !== noticeKey ||
        notice.seen ||
        notice.blockedBy ||
        this.state.intents.update?.state === "pending" ||
        this.state.intents.update?.state === "unknown" ||
        (current.phase === "failed" && current.code.includes("UNKNOWN")) ||
        (current.phase === "ready" && current.blockedBy?.includes("UNKNOWN"))
      )
        return Promise.resolve({
          id: "update-notice",
          state: "refused",
          code: "UPDATE_NOTICE_NOT_AVAILABLE",
        });
      return this.dispatch("update-notice", { action, noticeKey }, async () => {
        const revision = this.updateRevision;
        const value = InstalledUpdateViewSchema.safeParse(
          await this.api.installedUpdate({
            kind: "notice-seen",
            noticeKey: notice.key,
          }),
        );
        if (
          !value.success ||
          !("notice" in value.data) ||
          !value.data.notice ||
          value.data.notice.key !== notice.key ||
          JSON.stringify({ ...value.data, notice: undefined }) !==
            JSON.stringify({ ...current, notice: undefined })
        )
          return {
            id: "update-notice",
            state: "unknown",
            code: "UPDATE_NOTICE_OUTCOME_UNKNOWN",
          };
        // The reply acknowledges its bound notice, not a newer event. The
        // command's own published event may already have supplied this state.
        if (this.updateRevision === revision) this.adoptUpdate(value.data);
        const blocked = value.data.notice.blockedBy;
        return {
          id: "update-notice",
          state: blocked?.includes("UNKNOWN")
            ? "unknown"
            : blocked || !value.data.notice.seen
              ? "refused"
              : "applied",
          code:
            blocked ??
            (value.data.notice.seen ? null : "UPDATE_NOTICE_NOT_ACKNOWLEDGED"),
        };
      });
    }
    if (
      (action === "download" || action === "skip") &&
      this.state.update.phase !== "available"
    )
      return Promise.resolve({
        id: "update",
        state: "refused",
        code: "UPDATE_NOT_AVAILABLE",
      });
    if (
      action === "restart" &&
      (this.state.update.phase !== "ready" ||
        this.state.update.blockedBy !== null)
    )
      return Promise.resolve({
        id: "update",
        state: "refused",
        code: "UPDATE_NOT_READY",
      });
    if (
      action === "restart-confirmed" &&
      (!confirmedRestartAllowed(this.state.update) ||
        this.state.update.phase !== "ready" ||
        this.state.update.version !== noticeKey)
    )
      return Promise.resolve({
        id: "update",
        state: "refused",
        code: "UPDATE_NOT_READY",
      });
    return this.dispatch("update", { action, version: noticeKey }, async () => {
      const revision = this.updateRevision;
      const value = InstalledUpdateViewSchema.safeParse(
        await this.api.installedUpdate(
          action === "restart-confirmed"
            ? { kind: "restart-confirmed", version: noticeKey! }
            : { kind: action },
        ),
      );
      if (!value.success)
        return {
          id: "update",
          state: "unknown",
          code: "UPDATE_OUTCOME_UNKNOWN",
        };
      // The reply settles this command, not a more recent progress observation.
      if (this.updateRevision === revision) this.adoptUpdate(value.data);
      return {
        id: "update",
        state:
          value.data.phase === "unavailable"
            ? "refused"
            : value.data.phase === "failed"
              ? value.data.code.includes("UNKNOWN")
                ? "unknown"
                : "refused"
              : "applied",
        code:
          value.data.phase === "failed" || value.data.phase === "unavailable"
            ? value.data.code
            : null,
      };
    });
  }
  setAutomaticDownloads(enabled: boolean): Promise<Intent> {
    const key = "update-automatic-downloads";
    const current = this.state;
    const preference = current.update.automaticUpdatePreference;
    if (!automaticUpdateAvailable(current))
      return Promise.resolve({
        id: key,
        state: "refused",
        code: "UPDATE_AUTOMATIC_PREFERENCE_UNAVAILABLE",
      });
    if (
      preference?.status === "confirmed" &&
      preference.enabled === enabled &&
      preference.scope === "download-and-install"
    )
      return Promise.resolve({ id: key, state: "applied", code: null });
    return this.dispatch(key, enabled, async () => {
      const revision = this.updateRevision;
      const parsed = InstalledUpdateViewSchema.safeParse(
        await this.api.installedUpdate({
          kind: "set-automatic-update-preference",
          enabled,
          scope: "download-and-install",
        }),
      );
      if (!parsed.success || !parsed.data.automaticUpdatePreference)
        return {
          id: key,
          state: "unknown",
          code: "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
        };
      if (this.updateRevision === revision) this.adoptUpdate(parsed.data);
      const result = parsed.data.automaticUpdatePreference;
      return result.status === "confirmed" &&
        result.enabled === enabled &&
        result.scope === "download-and-install"
        ? { id: key, state: "applied", code: null }
        : result.status === "blocked"
          ? { id: key, state: "refused", code: result.code }
          : {
              id: key,
              state: "unknown",
              code:
                result.status === "unknown"
                  ? result.code
                  : "UPDATE_AUTOMATIC_PREFERENCE_ACK_MISMATCH",
            };
    });
  }
  setInstallOnQuitPreference(enabled: boolean): Promise<Intent> {
    const key = "update-install-on-quit";
    const retained = this.state.intents[key];
    if (retained?.state === "unknown") return Promise.resolve(retained);
    if (
      typeof enabled !== "boolean" ||
      !canSetInstallOnQuitPreference(this.state, this)
    )
      return Promise.resolve({
        id: key,
        state: "refused",
        code: "UPDATE_QUIT_PREFERENCE_UNAVAILABLE",
      });
    if (this.state.update.installOnQuitPreference?.enabled === enabled)
      return Promise.resolve({ id: key, state: "applied", code: null });
    return this.dispatch(key, enabled, async () => {
      // The digest await may have delivered a new admission fence. This
      // command's own pending intent is a latch, not an eligibility failure.
      if (!installOnQuitPreferenceEligible(this.state))
        return {
          id: key,
          state: "refused",
          code: "UPDATE_QUIT_PREFERENCE_UNAVAILABLE",
        };
      const revision = this.updateRevision;
      const parsed = InstalledUpdateViewSchema.safeParse(
        await this.api.installedUpdate({
          kind: "set-install-on-quit-preference",
          enabled,
        }),
      );
      if (!parsed.success || !parsed.data.installOnQuitPreference)
        return {
          id: key,
          state: "unknown",
          code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
        };
      if (this.updateRevision === revision) this.adoptUpdate(parsed.data);
      const result = parsed.data.installOnQuitPreference;
      return result.status === "confirmed" && result.enabled === enabled
        ? { id: key, state: "applied", code: null }
        : result.status === "blocked"
          ? { id: key, state: "refused", code: result.code }
          : {
              id: key,
              state: "unknown",
              code:
                result.status === "unknown"
                  ? result.code
                  : "UPDATE_QUIT_PREFERENCE_ACK_MISMATCH",
            };
    });
  }
  observeWorkspaceEdit(operationId: string): Promise<Intent> {
    return this.configure(
      { kind: "computer.observe-workspace-edit", operationId },
      `observe:${operationId}`,
    );
  }
  acknowledgeWorkspaceEdit(operationId: string): Promise<Intent> {
    if (operationId !== this.state.workspaceEditDelivery)
      return Promise.resolve({
        id: `ack:${operationId}`,
        state: "refused",
        code: "EXACT_DELIVERED_EDIT_REQUIRED",
      });
    return this.configure(
      { kind: "computer.ack-workspace-edit", operationId },
      `ack:${operationId}`,
    );
  }
  shortcuts(value: NavigationShortcuts): Promise<Intent> {
    const parsed = parseNavigationShortcuts(value);
    if (!parsed)
      return Promise.resolve({
        id: "shortcuts",
        state: "refused",
        code: "SHORTCUTS_INVALID",
      });
    return this.dispatch("shortcuts", parsed, async () => {
      const reply = z
        .strictObject({ ok: z.boolean() })
        .safeParse(await this.api.setNavigationShortcuts(parsed));
      if (!reply.success)
        return {
          id: "shortcuts",
          state: "unknown",
          code: "SHORTCUTS_OUTCOME_UNKNOWN",
        };
      if (!reply.data.ok)
        return { id: "shortcuts", state: "refused", code: "SHORTCUTS_REFUSED" };
      this.patch({ shortcuts: parsed });
      if (!this.disposed) this.persistShortcuts(parsed);
      return { id: "shortcuts", state: "applied", code: null };
    });
  }
  navigate(destination: Partial<Destination>): void {
    if (this.disposed || this.state.update.phase === "applying") return;
    if (destination.taskId !== undefined) this.taskSelectionRevision++;
    this.presentationRevision++;
    const wasSignIn = this.isSignInEntry();
    const next: Destination = {
      area: destination.area ?? this.state.destination.area,
      page: destination.page ?? this.state.destination.page,
      taskId: destination.taskId ?? this.state.destination.taskId,
    };
    if (next.area === "chatgpt" && destination.connectionCheckReturn === true)
      Object.assign(next, { connectionCheckReturn: true });
    const homeView = destination.homeView ?? this.state.destination.homeView;
    const activityId = Object.hasOwn(destination, "activityId")
      ? destination.activityId
      : this.state.destination.activityId;
    if (activityId !== undefined) Object.assign(next, { activityId });
    const workspaceId = Object.hasOwn(destination, "workspaceId")
      ? destination.workspaceId
      : destination.area === undefined && destination.page === undefined
        ? this.state.destination.workspaceId
        : undefined;
    if (
      next.area === "settings" &&
      next.page === "folders" &&
      workspaceId !== undefined
    )
      Object.assign(next, { workspaceId });
    if (homeView) Object.assign(next, { homeView });
    const homeSelection = Object.hasOwn(destination, "homeSelection")
      ? destination.homeSelection
      : destination.homeView &&
          destination.homeView !== this.state.destination.homeView
        ? null
        : this.state.destination.homeSelection;
    if (homeSelection !== undefined) Object.assign(next, { homeSelection });
    if (next.area === "setup") {
      const setupStep =
        destination.setupStep ??
        (this.state.destination.area === "setup"
          ? this.state.destination.setupStep
          : undefined) ??
        "overview";
      Object.assign(next, { setupStep, page: setupPage(setupStep) });
    }
    if (JSON.stringify(next) === JSON.stringify(this.state.destination)) {
      if (this.state.overlay === "search" || this.state.sidebar === "overlay") {
        this.patch({
          overlay: "none",
          sidebar:
            this.state.sidebar === "overlay" ? "rail" : this.state.sidebar,
        });
        this.presentation();
      }
      this.presentBrowserOnNavigation();
      return;
    }
    if (next.taskId !== this.state.destination.taskId)
      this.draft.select(next.taskId);
    this.history = this.history.slice(0, this.cursor + 1);
    this.history.push(next);
    if (this.history.length > 100) this.history.shift();
    this.cursor = this.history.length - 1;
    this.navigationRevision++;
    this.patch({
      destination: next,
      back: this.cursor > 0,
      forward: false,
      overlay: "none",
      sidebar: this.state.sidebar === "overlay" ? "rail" : this.state.sidebar,
    });
    this.presentation();
    this.presentBrowserOnNavigation();
    if (!wasSignIn && this.isSignInEntry()) {
      this.invalidateSignInObservation();
      this.observeSignIn();
    }
  }
  travel(direction: -1 | 1): void {
    if (this.disposed || this.state.update.phase === "applying") return;
    const wasSignIn = this.isSignInEntry();
    const cursor = this.cursor + direction;
    if (cursor < 0 || cursor >= this.history.length) return;
    this.presentationRevision++;
    if (this.history[cursor]!.taskId !== this.state.destination.taskId)
      this.taskSelectionRevision++;
    this.draft.select(this.history[cursor]!.taskId);
    this.cursor = cursor;
    this.navigationRevision++;
    this.patch({
      destination: this.history[cursor]!,
      back: cursor > 0,
      forward: cursor < this.history.length - 1,
      overlay: "none",
      sidebar: this.state.sidebar === "overlay" ? "rail" : this.state.sidebar,
    });
    this.presentation();
    this.presentBrowserOnNavigation();
    if (!wasSignIn && this.isSignInEntry()) {
      this.invalidateSignInObservation();
      this.observeSignIn();
    }
  }
  private isSignInEntry(): boolean {
    return (
      this.state.destination.area === "setup" &&
      this.state.destination.setupStep === "signin"
    );
  }
  private retireSignInObservation(): void {
    this.signInCounter++;
    if (this.signInTimer !== null) clearTimeout(this.signInTimer);
    this.signInTimer = null;
  }
  private invalidateSignInObservation(): void {
    this.retireSignInObservation();
    this.patch({ signInObservation: null });
  }
  private observeSignIn(): void {
    const current = this.state;
    if (
      this.disposed ||
      this.booting ||
      !this.isSignInEntry() ||
      current.status !== "current" ||
      current.runtime !== "ready" ||
      current.update.phase === "applying" ||
      current.configuration?.status !== "ready" ||
      !current.buildId ||
      current.signInObservation?.pending === true
    )
      return;
    const command = ProductConfigurationCommandSchema.safeParse({
      kind: "chatgpt.observe-sign-in",
      observationId: crypto.randomUUID(),
      buildId: current.buildId,
    });
    if (!command.success || command.data.kind !== "chatgpt.observe-sign-in")
      return;
    const request = command.data;
    const startedAt = performance.now();
    const deadlineAt = startedAt + 2_500;
    if (!Number.isFinite(startedAt) || !Number.isFinite(deadlineAt)) return;
    const counter = ++this.signInCounter;
    const pending = {
      observationId: request.observationId,
      buildId: request.buildId,
      counter,
      pending: true,
      state: "unknown" as const,
      binding: null,
    };
    // Publish the latch before transport; subscriptions/remounts cannot submit it.
    this.patch({ signInObservation: pending });
    const active = () =>
      !this.disposed &&
      this.signInCounter === counter &&
      this.state.signInObservation === pending &&
      this.isSignInEntry() &&
      this.state.status === "current" &&
      this.state.runtime === "ready" &&
      this.state.update.phase !== "applying" &&
      this.state.configuration?.status === "ready" &&
      this.state.buildId === request.buildId;
    const settle = (raw?: unknown) => {
      if (!active()) return;
      if (this.signInTimer !== null) clearTimeout(this.signInTimer);
      this.signInTimer = null;
      const parsed = ProductConfigurationResultSchema.safeParse(raw);
      const evidence =
        parsed.success && parsed.data.ok ? parsed.data.evidence : null;
      const now = performance.now();
      const exact =
        Number.isFinite(now) &&
        now >= startedAt &&
        now < deadlineAt &&
        evidence?.kind === "chatgpt.sign-in-status" &&
        evidence.observationId === request.observationId &&
        evidence.buildId === request.buildId;
      // Never adopt the response's settings snapshot, effect intent or evidence cache.
      this.patch({
        signInObservation: {
          ...pending,
          pending: false,
          state: exact ? evidence.state : "unknown",
          binding: exact ? evidence.binding : null,
        },
      });
    };
    // Host observation is bounded to two seconds. A lost IPC reply also expires;
    // its later delivery cannot revive or settle any original effect UNKNOWN.
    if (!active()) return;
    this.signInTimer = setTimeout(() => settle(), 2_500);
    void (async () => {
      try {
        settle(await this.api.configure(request));
      } catch {
        settle();
      }
    })();
  }
  private presentBrowserOnNavigation(): void {
    const state = this.state;
    if (
      this.disposed ||
      this.booting ||
      state.status !== "current" ||
      state.runtime !== "ready" ||
      state.update.phase === "applying" ||
      state.destination.area !== "chatgpt" ||
      (state.destination.connectionCheckReturn === true &&
        state.intents["settings:connector.verify-app:"]?.state === "pending") ||
      state.route === "loaded" ||
      state.tasks.tasks.length > 0 ||
      state.destination.taskId !== "" ||
      state.intents["settings:chatgpt.present-browser:"] ||
      state.intents["settings:chatgpt.open-browser:"] ||
      state.intents["settings:chatgpt.open-sign-in:"]
    )
      return;
    // Loading is not absence: only the host may decide whether open() needs
    // to create a surface, join an open, or retain the existing document.
    void this.configure(
      { kind: "chatgpt.present-browser" },
      "settings:chatgpt.present-browser:",
    );
  }
  toggleSidebar(compact: boolean): void {
    if (this.disposed || this.state.update.phase === "applying") return;
    this.presentationRevision++;
    this.patch({
      sidebar:
        compact || isHomeOverview(this.state.destination)
          ? this.state.sidebar === "overlay"
            ? "rail"
            : "overlay"
          : this.state.sidebar === "full"
            ? "rail"
            : "full",
    });
    this.presentation();
  }
  overlay(kind: WindowSnapshot["overlay"]): void {
    // Applying admission owns presentation until a newer update result settles.
    // Host layout rejects these changes too; keep both owners on the same view.
    if (this.disposed || this.state.update.phase === "applying") return;
    this.presentationRevision++;
    this.patch({ overlay: kind });
    this.presentation();
  }
  resizeSidebar(width: number, active: boolean): void {
    if (this.disposed) return;
    if (this.state.update.phase === "applying") {
      // A pointer ending during apply must not leave a stale drag afterwards.
      if (!active && this.state.sidebarResizing) {
        this.resizeStartWidth = null;
        this.presentationDeferred = true;
        this.patch({ sidebarResizing: false });
      }
      return;
    }
    if (
      active &&
      (this.state.overlay !== "none" ||
        pageListMode(this.state.destination, this.state.sidebar) === "rail")
    )
      return;
    const sidebarWidth = clampPageListWidth(width);
    if (
      sidebarWidth === this.state.sidebarWidth &&
      active === this.state.sidebarResizing
    )
      return;
    if (active && !this.state.sidebarResizing)
      this.resizeStartWidth = this.state.sidebarWidth;
    if (!active) this.resizeStartWidth = null;
    this.presentationRevision++;
    this.patch({ sidebarWidth, sidebarResizing: active });
    this.presentation();
  }
  dismissOverlay(): void {
    if (this.disposed || this.state.update.phase === "applying") return;
    const sidebarWidth = this.state.sidebarResizing
      ? (this.resizeStartWidth ?? this.state.sidebarWidth)
      : this.state.sidebarWidth;
    this.resizeStartWidth = null;
    this.presentationRevision++;
    this.patch({
      overlay: "none",
      sidebar: this.state.sidebar === "overlay" ? "rail" : this.state.sidebar,
      sidebarWidth,
      sidebarResizing: false,
    });
    this.presentation();
  }
  appearance(value: Appearance): void {
    if (this.disposed) return;
    this.patch({ appearance: value });
    this.persistAppearance(value);
  }
  presentation(): void {
    if (this.disposed) return;
    const state = this.state;
    if (state.update.phase === "applying") {
      this.presentationDeferred = true;
      return;
    }
    this.presentationDeferred = false;
    const sidebar = pageListMode(state.destination, state.sidebar);
    this.api.layout(
      state.destination.area === "chatgpt"
        ? "browser"
        : state.destination.area === "settings" ||
            state.destination.area === "setup"
          ? "settings"
          : "activity",
      state.destination.taskId,
      state.status !== "current",
      false,
      sidebar,
      state.overlay === "none"
        ? sidebar === "overlay" || state.sidebarResizing
          ? "sidebar"
          : "none"
        : state.overlay === "search"
          ? "quick-switcher"
          : "task-menu",
      state.sidebarWidth,
    );
  }
  private hostLayout(value: unknown): void {
    if (!ShellLayoutSchema.safeParse(value).success) return;
    // Host projections are mirrors, never owner navigation or overlay commands.
  }
  private applySectionNavigation(action: SectionNavigationAction): boolean {
    if (
      this.disposed ||
      this.state.status !== "current" ||
      !this.tasksInitialized ||
      this.state.update.phase === "applying"
    )
      return false;
    const tasks = this.state.tasks.tasks;
    if (
      tasks.length === 0
        ? action.taskId !== ""
        : !tasks.some((task) => task.taskId === action.taskId)
    )
      return false;
    const previous = this.state.destination;
    this.patch({
      overlay: "none",
      sidebar: this.state.sidebar === "overlay" ? "rail" : this.state.sidebar,
    });
    this.navigate({
      area:
        action.section === "browser"
          ? "chatgpt"
          : action.section === "activity"
            ? "activity"
            : "settings",
      page: action.section === "computer" ? "computer" : "general",
      taskId: action.taskId,
    });
    // The same destination still needs one host acknowledgement after closing
    // an overlay; navigate does not add history or publish in that case.
    if (this.state.destination === previous) {
      this.navigationRevision++;
      this.presentation();
    }
    return true;
  }
  private checkUpdateOnOpen(): Promise<Intent> | undefined {
    const { update, intents } = this.state;
    // Opening the menu observes an existing download/install or retained unknown.
    if (
      intents.update?.state === "pending" ||
      intents.update?.state === "unknown" ||
      (update.phase === "failed" && update.code.includes("UNKNOWN")) ||
      !updateCheckAllowed(update)
    )
      return;
    return this.update("check");
  }
  private shellAction(value: unknown): void {
    const parsed = ShellActionSchema.safeParse(value);
    if (!parsed.success || this.seenActions.has(parsed.data.eventId)) return;
    if (this.seenActions.size >= 256)
      this.seenActions.delete(this.seenActions.values().next().value!);
    this.seenActions.add(parsed.data.eventId);
    const action = parsed.data;
    if (action.action === "navigate-section") {
      if (action.sequence <= this.sectionNavigationSequence) return;
      this.sectionNavigationSequence = action.sequence;
      if (this.booting)
        this.pendingSectionNavigation = {
          action,
          presentationRevision: this.presentationRevision,
        };
      else this.applySectionNavigation(action);
    } else if (action.action === "toggle-sidebar")
      this.toggleSidebar(this.compactViewport());
    else if (action.action === "open-quick-switcher") this.overlay("search");
    else if (action.action === "close-overlay") this.dismissOverlay();
    else if (action.action === "open-updates") {
      this.overlay("update");
      if (this.booting) this.pendingUpdateCheck = true;
      else void this.checkUpdateOnOpen();
    } else {
      if (
        action.source === "auth-window-closed" &&
        (action.action === "sign-in-returned" ||
          action.action === "open-settings") &&
        action.authWindowGeneration !== null
      ) {
        if (action.authWindowGeneration <= this.authWindowGeneration) return;
        this.authWindowGeneration = action.authWindowGeneration;
        this.invalidateSignInObservation();
        this.observeSignIn();
      }
      if (
        action.source === "settings-command" ||
        action.source === "sign-in-return-command"
      )
        this.navigate({ area: "settings", page: "connection" });
      void this.refresh();
    }
  }
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }
  return value;
}

function displayCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,119}$/u.test(value)
    ? value
    : "DIAGNOSTIC_CODE_UNAVAILABLE";
}
