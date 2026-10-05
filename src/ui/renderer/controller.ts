import {
  defaultNavigationShortcuts,
  parseNavigationShortcuts,
  type NavigationShortcuts,
} from "../../pkg/ipc/navigation-shortcuts";
import { workspaceEditToAcknowledge } from "../workspace-edit-delivery";
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
import {
  ProductConfigurationSnapshotSchema,
  ProductConfigurationCommandSchema,
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
  configuration: null,
  tasks: { revision: 0, tasks: [] },
  activity: [],
  runtime: "starting",
  route: "loading",
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
  private history: Destination[] = [home];
  private cursor = 0;
  private navigationRevision = 0;
  private readonly seenActions = new Set<string>();
  private sectionNavigationSequence = 0;
  private presentationRevision = 0;
  private pendingSectionNavigation: {
    action: SectionNavigationAction;
    presentationRevision: number;
  } | null = null;
  private readonly commands = new Map<
    string,
    { fingerprint: Promise<string>; promise: Promise<Intent> }
  >();
  // Window-local provenance and permanent consumption, never backend authority.
  private readonly editPreviews = new Map<string, EditReceipt>();
  private readonly submittedEdits = new Map<string, SubmittedEdit>();
  private readonly observedEdits = new Map<string, ObservedEdit>();
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
        const parsed = BrowserRouteStatusSchema.safeParse(value);
        if (parsed.success) this.patch({ route: parsed.data.state });
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
              settings.setup.chatgpt.configured ||
              settings.computer.workspaces.length > 0)
          ) {
            const launch = settings.general.openAtLaunch;
            this.navigate(
              launch === "browser"
                ? { area: "chatgpt", taskId: data.selectedTaskId }
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
        if (this.updateRevision === revision)
          this.patch({
            update: { phase: "unavailable", code: "UPDATE_STATUS_UNAVAILABLE" },
          });
      }
      if (this.refreshPending || this.overflow) await this.refresh();
      if (this.pendingUpdateCheck && !this.disposed) {
        this.pendingUpdateCheck = false;
        await this.update("check");
      }
    })();
    return this.startPromise;
  }
  /** Window teardown only. React observation disposers never call this. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
    const ids = new Set(
      value.tasks.map((task) => `${task.taskId}:${task.turnId}`),
    );
    this.patch({
      tasks: value,
      activity: this.state.activity.filter((event) =>
        ids.has(`${event.taskId}:${event.turnId}`),
      ),
    });
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
    const parsed = InstalledUpdateViewSchema.safeParse(value);
    if (parsed.success) {
      this.updateRevision++;
      if (parsed.data.phase === "failed" || parsed.data.phase === "unavailable")
        parsed.data.code = displayCode(parsed.data.code);
      this.patch({ update: parsed.data });
    } else
      this.patch({
        update: { phase: "unavailable", code: "UPDATE_STATE_INVALID" },
      });
  }
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const order = this.configOrder.begin();
    const runtimeRevision = this.runtimeRevision;
    const staleRevision = this.staleRevision;
    try {
      const value = await this.api.bootstrap();
      if (this.disposed || !this.configOrder.isLatest(order)) return;
      const parsed = BootstrapProjectionSchema.safeParse(value);
      if (!parsed.success) {
        this.invalidateHistory();
        this.patch({ status: "incompatible" });
        return;
      }
      // Legacy bootstrap has no authenticated generation; never present one.
      if (
        this.state.buildId &&
        parsed.data.build.buildId !== this.state.buildId
      ) {
        this.invalidateHistory();
        this.patch({ status: "incompatible" });
        return;
      }
      this.adoptConfiguration(parsed.data.configuration, order);
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
    } catch {
      if (this.configOrder.isLatest(order)) this.stale();
    }
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
    const previous = this.commands.get(key);
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
    this.commands.set(key, { fingerprint: binding, promise });
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
        this.commands.delete(key);
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
      if (result.state !== "unknown") this.commands.delete(key);
      this.patch({ intents: { ...this.state.intents, [key]: result } });
      resolve(result);
    })();
    return promise;
  }
  configure(
    command: ProductConfigurationCommand,
    intention: string,
  ): Promise<Intent> {
    if (!ProductConfigurationCommandSchema.safeParse(command).success)
      return Promise.resolve({
        id: intention,
        state: "refused",
        code: "SETTINGS_INPUT_INVALID",
      });
    return this.dispatch(intention, command, async () => {
      const before = this.state;
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
        this.patch({ evidence: { revision, value: outcome.result.evidence } });
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
                      : command.kind === "chatgpt.observe-readonly-conversation"
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
    });
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
  task(command: ProductTaskCommand, intention: string): Promise<Intent> {
    if (!ProductTaskCommandSchema.safeParse(command).success)
      return Promise.resolve({
        id: intention,
        state: "refused",
        code: "TASK_COMMAND_INVALID",
      });
    const nav = this.navigationRevision;
    return this.dispatch(intention, command, async () => {
      const result = ProductTaskCommandResultSchema.safeParse(
        await this.api.task(command),
      );
      if (!result.success)
        return {
          id: intention,
          state: "unknown",
          code: "TASK_OUTCOME_UNKNOWN",
        };
      this.adoptTasks(result.data.state);
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
      if (
        !this.disposed &&
        result.data.selectedTaskId &&
        nav === this.navigationRevision &&
        this.state.overlay === "none"
      )
        this.navigate({ area: "chatgpt", taskId: result.data.selectedTaskId });
      return { id: intention, state: "applied", code: null };
    });
  }
  update(action: UpdateAction): Promise<Intent> {
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
    return this.dispatch("update", action, async () => {
      const value = InstalledUpdateViewSchema.safeParse(
        await this.api.installedUpdate({ kind: action }),
      );
      if (!value.success)
        return {
          id: "update",
          state: "unknown",
          code: "UPDATE_OUTCOME_UNKNOWN",
        };
      this.patch({ update: value.data });
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
    this.presentationRevision++;
    const next: Destination = {
      area: destination.area ?? this.state.destination.area,
      page: destination.page ?? this.state.destination.page,
      taskId: destination.taskId ?? this.state.destination.taskId,
    };
    if (JSON.stringify(next) === JSON.stringify(this.state.destination)) {
      if (this.state.overlay === "search") {
        this.patch({ overlay: "none" });
        this.presentation();
      }
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
    });
    this.presentation();
  }
  travel(direction: -1 | 1): void {
    if (this.disposed || this.state.update.phase === "applying") return;
    const cursor = this.cursor + direction;
    if (cursor < 0 || cursor >= this.history.length) return;
    this.presentationRevision++;
    this.draft.select(this.history[cursor]!.taskId);
    this.cursor = cursor;
    this.navigationRevision++;
    this.patch({
      destination: this.history[cursor]!,
      back: cursor > 0,
      forward: cursor < this.history.length - 1,
      overlay: "none",
    });
    this.presentation();
  }
  toggleSidebar(compact: boolean): void {
    if (this.disposed || this.state.update.phase === "applying") return;
    this.presentationRevision++;
    this.patch({
      sidebar: compact
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
  appearance(value: Appearance): void {
    if (this.disposed) return;
    this.patch({ appearance: value });
    this.persistAppearance(value);
  }
  presentation(): void {
    if (this.disposed) return;
    const state = this.state;
    const sidebar = state.destination.area === "home" ? "rail" : state.sidebar;
    this.api.layout(
      state.destination.area === "chatgpt"
        ? "browser"
        : state.destination.area === "settings"
          ? "settings"
          : "activity",
      state.destination.taskId,
      state.status !== "current",
      false,
      sidebar,
      state.overlay === "none"
        ? sidebar === "overlay"
          ? "sidebar"
          : "none"
        : state.overlay === "search"
          ? "quick-switcher"
          : "task-menu",
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
    else if (action.action === "close-overlay") this.overlay("none");
    else if (action.action === "open-updates") {
      this.navigate({ area: "settings", page: "updates" });
      this.overlay("update");
      if (this.booting) this.pendingUpdateCheck = true;
      else void this.update("check");
    } else {
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
