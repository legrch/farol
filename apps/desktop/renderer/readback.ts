import {
  shouldAdoptConfigurationSnapshot,
  type ConfigurationRequestOrder,
} from "../../../src/ui/configuration-request-order";
import {
  workspaceReadbackConfirms,
  type WorkspaceReadbackBinding,
} from "../../../src/ui/guided-workspace-access";
import type {
  ConnectionStatusBootstrap,
  ConnectionStatusRead,
} from "../../../src/ui/renderer/connection/clock";
import type {
  ActivityEntry,
  Intent,
  NativeRefreshResult,
  PreloadApi,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import type { ChatHistoryContext } from "../../../src/pkg/ipc/chat-history";
import { BootstrapProjectionSchema } from "./snapshot";

/*
 * The window's native readback and its ordering. This module decides which
 * bootstrap reply, configuration snapshot or task state may replace what the
 * window shows, and holds what arrives before the first read: the newest
 * buffered task state and the buffered runtime events. It also remembers each
 * adopted readback receipt so a workspace check can be settled only by the
 * exact native witness it started from.
 *
 * The controller keeps every counter that fences a reply (the configuration
 * request order and the runtime, route and stale revisions), the lifecycle
 * flag and every other piece of window state. They reach this module as the
 * same shared instance or as getters, never as copies, and every side effect
 * that writes other controller state goes back through the ports below.
 */

/** What the readback reads and writes; the controller owns each. */
export type ReadbackPorts = Readonly<{
  /** The one bridge call a native readback makes. */
  api: Pick<PreloadApi, "bootstrap">;
  /** The live window snapshot, read again at every decision. */
  snapshot: () => WindowSnapshot;
  /** The controller's patch: publishes and applies its own retirement rules. */
  patch: (value: Partial<WindowSnapshot>) => void;
  /**
   * The counters that fence a reply. `order` is the controller's single
   * request order; the others are getters on its revision counters.
   */
  counters: Readonly<{
    order: ConfigurationRequestOrder;
    runtime: () => number;
    browserRoute: () => number;
    stale: () => number;
  }>;
  /** Whether the window was torn down, read again at every decision. */
  disposed: () => boolean;
  /** Effects on controller-owned state that a readback only triggers. */
  effects: Readonly<{
    /** Mark the window stale and fence in-flight history reads. */
    stale: () => void;
    invalidateHistory: () => void;
    adoptHistoryContext: (context: ChatHistoryContext | null) => void;
    /** Observe sign-in again once a readback changed what it waited on. */
    reconcileSignIn: () => void;
    connection: Readonly<{
      begin: () => ConnectionStatusRead;
      adopt: (
        data: ConnectionStatusBootstrap,
        read: ConnectionStatusRead,
      ) => void;
    }>;
    /** The workspace command a check was issued from, if still retained. */
    workspaceCommand: (
      intention: string,
    ) => WorkspaceReadbackBinding | undefined;
    /** Forget a settled workspace command and its retained dispatch. */
    consumeWorkspaceCommand: (intention: string) => void;
  }>;
}>;

export type Readback = Readonly<{
  /** Adopt a configuration snapshot unless a newer request or snapshot won. */
  adoptConfiguration: (
    value: WindowSnapshot["configuration"],
    order: number,
  ) => void;
  /** Adopt a task state; false when a contradictory revision made it stale. */
  adoptTasks: (value: WindowSnapshot["tasks"]) => boolean;
  /** Whether any task state was adopted yet. */
  tasksInitialized: () => boolean;
  /** Keep the newest task state that arrives before the first read. */
  bufferTasks: (value: WindowSnapshot["tasks"]) => void;
  /** Adopt the buffered task state; false when it contradicted the window. */
  adoptBufferedTasks: () => boolean;
  /** Buffer one runtime event; false when the buffer is full. */
  bufferEvent: (entry: ActivityEntry) => boolean;
  /** The buffered events that still belong to a known turn. */
  bufferedEvents: (known: ReadonlySet<string>) => ActivityEntry[];
  /** Drop everything buffered before the first read. */
  discardBuffered: () => void;
  /** One native readback of bootstrap state, with a request-owned receipt. */
  refresh: () => Promise<NativeRefreshResult>;
  /** Settle an unknown workspace check from the exact native witness. */
  reconcileWorkspace: (
    receipt: NativeRefreshResult,
    intention: string,
    pending: WorkspaceReadbackBinding,
  ) => Intent | null;
}>;

/** The most runtime events kept before the first read. */
const bufferedEventLimit = 256;

type Source = Readonly<{
  order: number;
  runtimeRevision: number;
  staleRevision: number;
  configuration: WindowSnapshot["configuration"];
  intents: WindowSnapshot["intents"];
}>;

export function createReadback(ports: ReadbackPorts): Readback {
  const { counters, effects } = ports;
  let tasksInitialized = false;
  let bufferedTasks: WindowSnapshot["tasks"] | null = null;
  let events: ActivityEntry[] = [];
  const sources = new WeakMap<object, Source>();

  function adoptConfiguration(
    value: WindowSnapshot["configuration"],
    order: number,
  ): void {
    if (!value || !counters.order.isLatest(order)) return;
    const state = ports.snapshot();
    if (
      state.configuration &&
      !shouldAdoptConfigurationSnapshot(state.configuration, value)
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
    ports.patch({
      configuration: value,
      evidence: null,
      workspaceEditDelivery:
        pending === state.workspaceEditDelivery
          ? state.workspaceEditDelivery
          : null,
    });
  }

  function adoptTasks(value: WindowSnapshot["tasks"]): boolean {
    const current = ports.snapshot().tasks;
    if (value.revision < current.revision) return true;
    if (
      value.revision === current.revision &&
      JSON.stringify(value) === JSON.stringify(current)
    ) {
      tasksInitialized = true;
      return true;
    }
    if (value.revision === current.revision && tasksInitialized) {
      effects.stale();
      return false;
    }
    tasksInitialized = true;
    // Admitted metadata remains inspectable after its turn moves on.
    ports.patch({ tasks: value });
    return true;
  }

  async function refresh(): Promise<NativeRefreshResult> {
    if (ports.disposed()) return { status: "unqualified", reason: "disposed" };
    const order = counters.order.begin();
    const runtimeRevision = counters.runtime();
    const browserRouteRevision = counters.browserRoute();
    const staleRevision = counters.stale();
    try {
      const connectionRead = effects.connection.begin();
      const value = await ports.api.bootstrap();
      if (ports.disposed())
        return { status: "unqualified", reason: "disposed" };
      if (!counters.order.isLatest(order))
        return { status: "unqualified", reason: "superseded" };
      const parsed = BootstrapProjectionSchema.safeParse(value);
      if (!parsed.success) {
        effects.invalidateHistory();
        ports.patch({ status: "incompatible" });
        return { status: "unqualified", reason: "malformed" };
      }
      // Legacy bootstrap has no authenticated generation; never present one.
      const buildId = ports.snapshot().buildId;
      if (buildId && parsed.data.build.buildId !== buildId) {
        effects.invalidateHistory();
        ports.patch({ status: "incompatible" });
        return { status: "unqualified", reason: "incompatible" };
      }
      if (
        counters.browserRoute() === browserRouteRevision &&
        parsed.data.browserRouteState
      ) {
        ports.patch({ route: parsed.data.browserRouteState.state });
      }
      const previousConfiguration = ports.snapshot().configuration;
      adoptConfiguration(parsed.data.configuration, order);
      const adoptedConfiguration = ports.snapshot().configuration;
      const tasksAccepted = adoptTasks({
        revision: parsed.data.taskRevision,
        tasks: parsed.data.tasks,
      });
      const runtime =
        runtimeRevision === counters.runtime()
          ? parsed.data.runtimeState
          : ports.snapshot().runtime;
      effects.adoptHistoryContext(parsed.data.chatHistoryContext ?? null);
      if (parsed.data.connectionStatus !== undefined)
        effects.connection.adopt(parsed.data, connectionRead);
      const status =
        parsed.data.configuration.status === "ready" &&
        tasksAccepted &&
        staleRevision === counters.stale() &&
        runtime === "ready"
          ? "current"
          : "stale";
      // A later valid bootstrap with the same context must not revive cached
      // answers or admit a read started before this loss of current state.
      if (status !== "current") effects.invalidateHistory();
      ports.patch({
        status,
        runtime,
      });
      effects.reconcileSignIn();
      if (ports.disposed())
        return { status: "unqualified", reason: "disposed" };
      if (!counters.order.isLatest(order))
        return { status: "unqualified", reason: "superseded" };
      if (
        adoptedConfiguration === previousConfiguration ||
        ports.snapshot().configuration !== adoptedConfiguration
      )
        return { status: "unqualified", reason: "not-adopted" };
      if (
        status !== "current" ||
        runtimeRevision !== counters.runtime() ||
        adoptedConfiguration?.status !== "ready" ||
        ports.snapshot().evidence !== null
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
      sources.set(receipt, {
        order,
        runtimeRevision,
        staleRevision,
        configuration: adoptedConfiguration,
        intents: ports.snapshot().intents,
      });
      return receipt;
    } catch {
      if (ports.disposed())
        return { status: "unqualified", reason: "disposed" };
      if (!counters.order.isLatest(order))
        return { status: "unqualified", reason: "superseded" };
      effects.stale();
      return { status: "unqualified", reason: "transport-unknown" };
    }
  }

  function reconcileWorkspace(
    receipt: NativeRefreshResult,
    intention: string,
    pending: WorkspaceReadbackBinding,
  ): Intent | null {
    const source = sources.get(receipt);
    const command = effects.workspaceCommand(intention);
    const state = ports.snapshot();
    const original = state.intents[intention];
    if (
      ports.disposed() ||
      receipt.status !== "adopted" ||
      !source ||
      !command ||
      !counters.order.isLatest(source.order) ||
      counters.runtime() !== source.runtimeRevision ||
      counters.stale() !== source.staleRevision ||
      state.status !== "current" ||
      state.runtime !== "ready" ||
      state.configuration !== source.configuration ||
      state.evidence !== null ||
      state.intents !== source.intents ||
      state.buildId !== receipt.buildId ||
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
    sources.delete(receipt);
    effects.consumeWorkspaceCommand(intention);
    ports.patch({ intents: { ...state.intents, [intention]: resolved } });
    return resolved;
  }

  return {
    adoptConfiguration,
    adoptTasks,
    tasksInitialized: () => tasksInitialized,
    bufferTasks(value) {
      if (!bufferedTasks || value.revision >= bufferedTasks.revision)
        bufferedTasks = value;
    },
    adoptBufferedTasks: () => !bufferedTasks || adoptTasks(bufferedTasks),
    bufferEvent(entry) {
      if (events.length >= bufferedEventLimit) return false;
      events.push(entry);
      return true;
    },
    bufferedEvents: (known) =>
      events.filter((event) => known.has(`${event.taskId}:${event.turnId}`)),
    discardBuffered() {
      events = [];
      bufferedTasks = null;
    },
    refresh,
    reconcileWorkspace,
  };
}
