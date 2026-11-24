import type { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";
import type {
  LiveTaskStoreRecord,
  PrivateLiveTaskStore,
  StoredLiveTask,
} from "../../../src/apps/desktop/live-task-store";

// The live tasks' durable state: how the registry becomes the stored record,
// how saves are chained, how a task is marked running durably and how the
// record is restored at startup. Main keeps every owner, the surface publish
// and the persistence-failure surface; each `let` there is a late getter or a
// setter here, so a change made while a save waits is seen on the next read.
// The registry and the two maps are the owners' own objects, shared by
// reference. Nothing here retries: a failed save is returned, never repeated.

// The only thing restore does to a route it staged is dispose it again.
type LiveTaskRoute = Readonly<{ dispose: () => void }>;

export type TaskPersistPorts = Readonly<{
  liveTaskStore: () => PrivateLiveTaskStore | null;
  setLiveTaskStore: (value: PrivateLiveTaskStore | null) => void;
  liveTaskPersistence: () => Promise<void>;
  setLiveTaskPersistence: (value: Promise<void>) => void;
  setLiveTaskRegistryRestored: (value: boolean) => void;
  setSelectedTaskId: (value: string) => void;
  chatGptHomeUrl: () => string;
  liveTaskRegistry: Pick<
    LiveTaskRegistry,
    "snapshot" | "restore" | "markRunningDurable"
  >;
  liveTaskRoutes: Map<string, LiveTaskRoute>;
  liveTaskConversationUrls: Map<string, string | null>;
  statePaths: () => Readonly<{ liveTasks: string }>;
  createLiveChatGptRoute: (
    taskId: string,
    label: string,
    initialUrl?: string,
  ) => LiveTaskRoute;
  // Opens the private store at its root. The only hook a caller may pass is
  // the e2e save fault below; main builds the real store here.
  openStore: (
    root: string,
    hooks: Readonly<{ beforeCommit?: () => Promise<void> }>,
  ) => PrivateLiveTaskStore;
  publishTasksState: () => void;
  surfaceLiveTaskPersistenceFailure: (taskId: string) => void;
  env: Readonly<Record<string, string | undefined>>;
}>;

export function createTaskPersist(ports: TaskPersistPorts) {
  const {
    liveTaskStore,
    setLiveTaskStore,
    liveTaskPersistence,
    setLiveTaskPersistence,
    setLiveTaskRegistryRestored,
    setSelectedTaskId,
    chatGptHomeUrl,
    liveTaskRegistry,
    liveTaskRoutes,
    liveTaskConversationUrls,
    statePaths,
    createLiveChatGptRoute,
    openStore,
    publishTasksState,
    surfaceLiveTaskPersistenceFailure,
    env,
  } = ports;

  function storedLiveTaskState(): Readonly<{
    revision: number;
    tasks: StoredLiveTask[];
  }> {
    const snapshot = liveTaskRegistry.snapshot();
    return {
      revision: snapshot.revision,
      tasks: snapshot.tasks.map((task) => ({
        ...task,
        provider: "chatgpt" as const,
        conversationUrl: liveTaskConversationUrls.get(task.taskId) ?? null,
      })),
    };
  }

  function persistLiveTaskState(): Promise<void> {
    const store = liveTaskStore();
    if (!store) return Promise.reject(new Error("LIVE_TASK_STATE_UNAVAILABLE"));
    const state = storedLiveTaskState();
    const write = liveTaskPersistence().then(() => store.save(state));
    setLiveTaskPersistence(write.catch(() => undefined));
    return write;
  }

  async function markLiveTaskRunningDurable(taskId: string): Promise<boolean> {
    return liveTaskRegistry.markRunningDurable(
      taskId,
      () => persistLiveTaskState(),
      {
        onPublish: () => publishTasksState(),
        onPersistFailure: () => surfaceLiveTaskPersistenceFailure(taskId),
      },
    );
  }

  async function initializeLiveTaskState(): Promise<void> {
    let e2eSaveAttempts = 0;
    const e2eSuccessfulSaves =
      env.FAROL_E2E === "1"
        ? env.FAROL_E2E_LIVE_TASK_SAVE_SUCCESSES
        : undefined;
    const store = openStore(
      statePaths().liveTasks,
      e2eSuccessfulSaves === undefined
        ? {}
        : {
            beforeCommit: async () => {
              const successfulSaves = Number(e2eSuccessfulSaves);
              if (
                !Number.isSafeInteger(successfulSaves) ||
                successfulSaves < 0
              ) {
                throw new Error("LIVE_TASK_E2E_SAVE_FAULT_INVALID");
              }
              e2eSaveAttempts += 1;
              if (e2eSaveAttempts > successfulSaves) {
                throw new Error("LIVE_TASK_E2E_SAVE_FAULT");
              }
            },
          },
    );
    const stagedRoutes = new Map<string, LiveTaskRoute>();
    const stagedConversationUrls = new Map<string, string | null>();
    let record: LiveTaskStoreRecord | null;
    try {
      record = await store.load();
    } catch {
      setLiveTaskStore(null);
      return;
    }
    setLiveTaskStore(store);
    if (!record) return;

    let reconciled = false;
    try {
      const tasks = record.tasks.map(({ conversationUrl, ...task }) => {
        stagedConversationUrls.set(task.taskId, conversationUrl);
        const lifecycle =
          task.lifecycle === "running" ? "outcome_unknown" : task.lifecycle;
        reconciled ||= lifecycle !== task.lifecycle;
        stagedRoutes.set(
          task.taskId,
          createLiveChatGptRoute(
            task.taskId,
            task.label,
            conversationUrl ?? chatGptHomeUrl(),
          ),
        );
        return { ...task, lifecycle };
      });
      liveTaskRegistry.restore({
        revision: record.revision + (reconciled ? 1 : 0),
        tasks,
      });
      setLiveTaskRegistryRestored(true);
      for (const [taskId, route] of stagedRoutes) {
        liveTaskRoutes.set(taskId, route);
      }
      for (const [taskId, conversationUrl] of stagedConversationUrls) {
        liveTaskConversationUrls.set(taskId, conversationUrl);
      }
      setSelectedTaskId(tasks[0]?.taskId ?? "");
    } catch {
      for (const route of stagedRoutes.values()) route.dispose();
      setLiveTaskStore(null);
      liveTaskConversationUrls.clear();
      return;
    }

    if (reconciled) {
      try {
        await persistLiveTaskState();
      } catch {
        setLiveTaskStore(null);
      }
    }
  }

  return {
    stored: storedLiveTaskState,
    persist: persistLiveTaskState,
    markRunningDurable: markLiveTaskRunningDurable,
    initialize: initializeLiveTaskState,
  };
}
