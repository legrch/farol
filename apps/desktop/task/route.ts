import type { ChatGptRouteOptions } from "../../../src/apps/desktop/chatgpt-route";
import type { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";

// The three ChatGPT route builders: the managed route every ChatGPT surface
// shares, the live route a saved task owns and the context-summary fallback.
// Main keeps every owner, the persistence and the window; each `let` there is
// a late getter here, so a change made while a route is built is seen at use.
// The route class itself is the `openRoute` port, so what is built is the
// caller's route type and nothing here knows how a route opens a surface.

type Lifecycle = NonNullable<ReturnType<LiveTaskRegistry["get"]>>["lifecycle"];

export type TaskRoutesPorts<Route> = Readonly<{
  window: ChatGptRouteOptions["parent"];
  chatGptHomeUrl: () => string;
  chatGptE2eOrigin: () => string | null;
  managedChatGptRoutes: Set<Route>;
  liveTaskRegistry: Pick<LiveTaskRegistry, "get">;
  liveTaskConversationUrls: Map<string, string | null>;
  activeDesktopIdentity: Readonly<{
    chatGptPartition: NonNullable<ChatGptRouteOptions["partition"]>;
    displayName: string;
  }>;
  channels: Readonly<{ browserHistoryState: string }>;
  displayProductName: string;
  runtimeEnvironment: string;
  persistLiveTaskState: () => Promise<void>;
  surfaceLiveTaskPersistenceFailure: (taskId: string) => void;
  setLiveTaskLifecycle: (taskId: string, lifecycle: Lifecycle) => void;
  chatGptWindowPresentationOption: () => Pick<
    ChatGptRouteOptions,
    "windowPresentation"
  >;
  liveChatGptSurfaceFactory: (
    taskId: string,
  ) => NonNullable<ChatGptRouteOptions["surfaceFactory"]>;
  openRoute: (options: ChatGptRouteOptions) => Route;
  writeStderr: (text: string) => void;
  env: Readonly<Record<string, string | undefined>>;
}>;

export function createTaskRoutes<Route>(ports: TaskRoutesPorts<Route>) {
  const {
    window,
    chatGptHomeUrl,
    chatGptE2eOrigin,
    managedChatGptRoutes,
    liveTaskRegistry,
    liveTaskConversationUrls,
    activeDesktopIdentity,
    channels,
    displayProductName,
    runtimeEnvironment,
    persistLiveTaskState,
    surfaceLiveTaskPersistenceFailure,
    setLiveTaskLifecycle,
    chatGptWindowPresentationOption,
    liveChatGptSurfaceFactory,
    openRoute,
    writeStderr,
    env,
  } = ports;

  function createManagedChatGptRoute(options: ChatGptRouteOptions): Route {
    let route: Route;
    route = openRoute({
      ...options,
      partition: activeDesktopIdentity.chatGptPartition,
      ...(runtimeEnvironment === "dev"
        ? {
            requiredAppName: activeDesktopIdentity.displayName,
            title:
              options.title ?? `ChatGPT · ${activeDesktopIdentity.displayName}`,
          }
        : {}),
      onUpdateAdmissionDiagnostic: (diagnostic) => {
        // Fixed classifications only. The browser route contains observer errors,
        // so diagnostics cannot alter an update admission or release outcome.
        writeStderr(
          `FAROL_UPDATE_ADMISSION_DIAGNOSTIC ${diagnostic.stage}:${diagnostic.reason}\n`,
        );
        options.onUpdateAdmissionDiagnostic?.(diagnostic);
      },
      onProfilePreparationDiagnostic: (diagnostic) => {
        if (runtimeEnvironment === "dev")
          writeStderr(
            `FAROL_PROFILE_PREPARATION_DIAGNOSTIC ${JSON.stringify(diagnostic)}\n`,
          );
        options.onProfilePreparationDiagnostic?.(diagnostic);
      },
      onDisposed: () => managedChatGptRoutes.delete(route),
    });
    managedChatGptRoutes.add(route);
    return route;
  }

  function createLiveChatGptRoute(
    taskId: string,
    label: string,
    initialUrl = chatGptHomeUrl(),
  ): Route {
    let routeHomeUrl = chatGptHomeUrl();
    let routeInitialUrl = initialUrl;
    if (chatGptE2eOrigin() !== null) {
      const fixtureUrl = new URL(chatGptHomeUrl());
      fixtureUrl.searchParams.set("farol-e2e-task", taskId);
      routeHomeUrl = fixtureUrl.href;
      if (initialUrl === chatGptHomeUrl()) routeInitialUrl = routeHomeUrl;
    }
    const recordConversationUrl = (conversationUrl: string | null) => {
      if (!liveTaskRegistry.get(taskId)) return;
      if (liveTaskConversationUrls.get(taskId) === conversationUrl) return;
      liveTaskConversationUrls.set(taskId, conversationUrl);
      void persistLiveTaskState().catch(() =>
        surfaceLiveTaskPersistenceFailure(taskId),
      );
    };
    const recordTaskActivity = (
      state: "idle" | "running" | "outcome_unknown",
    ) => {
      const task = liveTaskRegistry.get(taskId);
      if (!task) return;
      const lifecycle =
        state === "running"
          ? "running"
          : state === "outcome_unknown"
            ? "outcome_unknown"
            : task.lifecycle === "running"
              ? "completed"
              : task.lifecycle;
      setLiveTaskLifecycle(taskId, lifecycle);
    };
    return createManagedChatGptRoute({
      homeUrl: routeHomeUrl,
      initialUrl: routeInitialUrl,
      e2eOrigin: chatGptE2eOrigin(),
      parent: () => window(),
      ...chatGptWindowPresentationOption(),
      surfaceFactory: liveChatGptSurfaceFactory(taskId),
      onNavigationHistoryChanged: (state) =>
        window()?.webContents.send(channels.browserHistoryState, {
          taskId,
          ...state,
        }),
      title: `${label} · ${displayProductName}`,
      onClosed: (conversationUrl, taskRunning) => {
        recordConversationUrl(conversationUrl);
        recordTaskActivity(taskRunning ? "outcome_unknown" : "idle");
      },
      onConversationChanged: recordConversationUrl,
      onTaskActivityChanged: recordTaskActivity,
      ...(env.FAROL_E2E === "1" && chatGptE2eOrigin() !== null
        ? { taskTimeoutMs: 5_000, taskPollMs: 50 }
        : {}),
    });
  }

  function createContextSummaryFallbackRoute(
    binding: Readonly<{ taskId: string }>,
    recoveredConversationUrl?: string,
  ): Route {
    let initialUrl = recoveredConversationUrl ?? chatGptHomeUrl();
    if (recoveredConversationUrl === undefined && chatGptE2eOrigin() !== null) {
      const fixtureUrl = new URL(initialUrl);
      fixtureUrl.searchParams.set(
        "farol-e2e-task",
        `context-${binding.taskId}`,
      );
      initialUrl = fixtureUrl.href;
    }
    return createManagedChatGptRoute({
      homeUrl: chatGptHomeUrl(),
      initialUrl,
      e2eOrigin: chatGptE2eOrigin(),
      parent: () => window(),
      ...chatGptWindowPresentationOption(),
      title: `Context recovery · ${displayProductName}`,
      ...(env.FAROL_E2E === "1" && chatGptE2eOrigin() !== null
        ? { taskTimeoutMs: 5_000, taskPollMs: 50 }
        : {}),
    });
  }

  return {
    managed: createManagedChatGptRoute,
    live: createLiveChatGptRoute,
    contextSummaryFallback: createContextSummaryFallbackRoute,
  };
}
