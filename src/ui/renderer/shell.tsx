import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import { shellGeometry } from "../../pkg/shell-layout/geometry";
import { useRenderer } from "./services";
import { PanelBoundary } from "./boundary";
import { Settings, useSettingsAttention } from "./settings";
import type { RendererFacade, SettingsPage, WindowSnapshot } from "./contract";
import { computerSetup } from "./computer-setup";
import { TaskEditor } from "./task";
import { Home, HomeNavigation, homeTitle } from "./home";
import { Setup, SetupNavigation } from "./setup";
import { setupSteps } from "./setup-navigation";
const pages: readonly [SettingsPage, string][] = [
  ["general", "General"],
  ["folders", "Folders"],
  ["computer", "This Mac"],
  ["connection", "Connection"],
  ["appearance", "Appearance"],
  ["shortcuts", "Keyboard shortcuts"],
  ["updates", "Updates"],
  ["diagnostics", "Diagnostics"],
];
export function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    home: "M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9",
    chatgpt: "M4 4h16v12H9l-5 4V4m4 4h8m-8 4h5",
    activity: "M3 13h4l3-9 4 16 3-7h4",
    settings:
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m-2-5h4l1 3 3 1 3 3v4l-3 1-1 3-3 3h-4l-1-3-3-1-3-3v-4l3-1 1-3z",
    back: "m14 5-7 7 7 7",
    forward: "m10 5 7 7-7 7",
    sidebar: "M3 4h18v16H3V4m5 0v16",
    search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6",
    close: "m5 5 14 14M19 5 5 19",
    plus: "M12 4v16M4 12h16",
    check: "m5 12 4 4L19 6",
    attention: "M12 4 2 21h20L12 4m0 6v5m0 3v1",
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name] ?? paths.settings} />
    </svg>
  );
}
export function connection(snapshot: WindowSnapshot) {
  return computerSetup(snapshot).label;
}
function title(snapshot: WindowSnapshot) {
  return snapshot.destination.area === "settings"
    ? (pages.find(([id]) => id === snapshot.destination.page)?.[1] ??
        "Settings")
    : snapshot.destination.area === "chatgpt"
      ? (snapshot.tasks.tasks.find(
          (task) => task.taskId === snapshot.destination.taskId && task.agent,
        )?.label ?? "ChatGPT")
      : snapshot.destination.area === "activity"
        ? "Activity"
        : snapshot.destination.area === "setup"
          ? (setupSteps.find(
              ([step]) => step === snapshot.destination.setupStep,
            )?.[1] ?? "Setup")
          : homeTitle(snapshot);
}
function Activity({
  snapshot,
  facade,
  recent = false,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
  recent?: boolean;
}) {
  const selected = snapshot.activity.find(
    (event) => event.id === snapshot.destination.activityId,
  );
  const items = [...snapshot.activity].reverse().slice(0, recent ? 5 : 256);
  return (
    <>
      <p className="description">
        Recorded metadata in this window. Conversation content is not stored.
      </p>
      {items.length === 0 ? (
        <p className="empty">No recorded activity in this window.</p>
      ) : (
        items.map((event) => (
          <button
            className="activity-row"
            key={event.id}
            onClick={() => {
              facade.navigate({ area: "activity", activityId: event.id });
              facade.overlay("activity");
            }}
          >
            <time>
              {new Date(event.at).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            <span>
              <strong>{event.label}</strong>
              <small>
                {event.phase?.replaceAll("_", " ") ?? event.kind}
                {event.operation ? ` · ${event.operation}` : ""}
              </small>
            </span>
            <Icon name="forward" />
          </button>
        ))
      )}
      {selected && snapshot.overlay === "activity" && (
        <Overlay
          title="Recorded event"
          onClose={() => {
            facade.overlay("none");
          }}
        >
          <dl>
            {[
              ["Task", selected.label],
              ["Event", selected.kind],
              ["Phase", selected.phase ?? "Not recorded"],
              ["Operation", selected.operation ?? "Not recorded"],
              ["Code", selected.code ?? "Not recorded"],
              ["Task identity", selected.taskId],
              ["Turn identity", selected.turnId],
            ].map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {snapshot.tasks.tasks.some(
            (task) =>
              task.taskId === selected.taskId &&
              task.turnId === selected.turnId,
          ) ? (
            <button
              className="primary"
              onClick={() =>
                facade.navigate({ area: "chatgpt", taskId: selected.taskId })
              }
            >
              View chat
            </button>
          ) : (
            <p>
              The recorded conversation is no longer available in this slot.
            </p>
          )}
        </Overlay>
      )}
      {!selected && snapshot.overlay === "activity" && (
        <Overlay title="Recorded event" onClose={() => facade.overlay("none")}>
          <p>
            This event is no longer available in this window. Its absence does
            not establish an outcome.
          </p>
        </Overlay>
      )}
    </>
  );
}
export function Overlay({
  title,
  children,
  onClose,
  dismissible = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  // Capture before React commits autofocus descendants, including StrictMode.
  const trigger = useRef(document.activeElement);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const restore = trigger.current;
    dialog.showModal();
    return () => {
      dialog.close();
      if (restore instanceof HTMLElement && restore.isConnected)
        restore.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) close.current();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && dismissible)
          close.current();
      }}
    >
      <div className="sheet-content">
        <div className="section-heading">
          <h2>{title}</h2>
          {dismissible && (
            <button aria-label="Close" onClick={onClose}>
              <Icon name="close" />
            </button>
          )}
        </div>
        {children}
      </div>
    </dialog>
  );
}
function Search({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const [query, setQuery] = useState("");
  const targets = [
    { label: "Home", area: "home" as const, page: "general" as const },
    { label: "ChatGPT", area: "chatgpt" as const, page: "general" as const },
    { label: "Activity", area: "activity" as const, page: "general" as const },
    { label: "Setup", area: "setup" as const, page: "general" as const },
    ...pages.map(([page, label]) => ({
      label,
      area: "settings" as const,
      page,
    })),
  ];
  return (
    <Overlay title="Find a page" onClose={() => facade.overlay("none")}>
      <input
        autoFocus
        aria-label="Find a page"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            const first = targets.find((item) =>
              item.label.toLowerCase().includes(query.toLowerCase()),
            );
            if (first) facade.navigate(first);
          }
        }}
      />
      <div className="search-results">
        {targets
          .filter((item) =>
            item.label.toLowerCase().includes(query.toLowerCase()),
          )
          .map((item) => (
            <button key={item.label} onClick={() => facade.navigate(item)}>
              {item.label}
            </button>
          ))}
        {snapshot.tasks.tasks
          .filter((task) =>
            task.label.toLowerCase().includes(query.toLowerCase()),
          )
          .map((task) => (
            <button
              key={task.taskId}
              onClick={() =>
                facade.navigate({ area: "chatgpt", taskId: task.taskId })
              }
            >
              {task.label}
            </button>
          ))}
      </div>
    </Overlay>
  );
}
function Update({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const update = snapshot.update;
  const intent = snapshot.intents.update;
  const disabled =
    snapshot.status !== "current" ||
    intent?.state === "pending" ||
    intent?.state === "unknown";
  const canCheck =
    update.phase === "idle" ||
    (update.phase === "ready" && update.blockedBy !== null) ||
    (update.phase === "failed" && !update.recoveryRequired);
  return (
    <Overlay
      title="Farol updates"
      onClose={() => facade.overlay("none")}
      dismissible={update.phase !== "applying"}
    >
      <p className="description">
        Review the current release state before any action.
      </p>
      <p className="update-state">
        {update.phase === "ready"
          ? `Version ${update.version} is ready`
          : update.phase === "failed"
            ? `Update failed: ${update.code}`
            : update.phase === "unavailable"
              ? `Update unavailable: ${update.code}`
              : update.phase === "recovery"
                ? `Recovery required for ${update.version}`
                : update.phase === "applying"
                  ? "Applying update…"
                  : update.phase === "checking"
                    ? "Checking for updates…"
                    : update.phase === "downloading"
                      ? "Downloading update…"
                      : "You can check for updates."}
      </p>
      {update.phase === "ready" && update.blockedBy && (
        <p role="alert">
          Installation blocked: {update.blockedBy}. Current work must be
          settled.
        </p>
      )}
      <div className="control-row">
        <button
          disabled={disabled || !canCheck}
          onClick={() => void facade.update("check")}
        >
          Check for Updates
        </button>
        {update.phase === "ready" && (
          <>
            <button
              disabled={disabled || update.deferred}
              onClick={() => {
                void facade.update("later");
                facade.overlay("none");
              }}
            >
              Remind Me Later
            </button>
            <button
              className="primary"
              disabled={disabled || update.blockedBy !== null}
              onClick={() => void facade.update("restart")}
            >
              Restart &amp; Update
            </button>
          </>
        )}
        {(update.phase === "recovery" ||
          (update.phase === "failed" && update.recoveryRequired)) && (
          <button
            disabled={
              disabled ||
              (update.phase === "recovery" && update.blockedBy !== null)
            }
            onClick={() => void facade.update("recover")}
          >
            Recover
          </button>
        )}
        {(update.phase === "idle" ||
          (update.phase === "failed" && !update.recoveryRequired)) &&
          update.rollbackVersion && (
            <button
              disabled={
                disabled ||
                (update.phase === "idle" && Boolean(update.blockedBy))
              }
              onClick={() => void facade.update("rollback")}
            >
              Roll Back
            </button>
          )}
      </div>
      <p className="description">
        Automatic installation and interruption are unavailable. Review current
        work before restarting or restoring the previous version.
      </p>
      {intent?.state === "unknown" && (
        <p role="alert">
          Outcome unknown. Inspect the retained operation; do not submit another
          apply.
        </p>
      )}
    </Overlay>
  );
}
function ChatBrowser({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const intentions = ["chatgpt.open-browser", "chatgpt.open-sign-in"] as const;
  const relevant = intentions
    .map((kind) => snapshot.intents[`settings:${kind}:`])
    .filter((intent) => intent && intent.state !== "applied");
  return (
    <div className="native-browser-placeholder">
      <p>
        ChatGPT opens in its own browser view. Existing conversations belong to
        ChatGPT.
      </p>
      <div className="control-row">
        {intentions.map((kind) => {
          const intent = snapshot.intents[`settings:${kind}:`];
          return (
            <button
              key={kind}
              disabled={
                snapshot.status !== "current" ||
                intent?.state === "pending" ||
                intent?.state === "unknown"
              }
              onClick={() =>
                void facade.configure({ kind }, `settings:${kind}:`)
              }
            >
              {kind === "chatgpt.open-browser" ? "Open ChatGPT" : "Sign in"}
            </button>
          );
        })}
      </div>
      {relevant.length > 0 && (
        <p className="notice" role="status">
          {relevant.some((intent) => intent?.state === "unknown")
            ? "Opening ChatGPT is unconfirmed. See Diagnostics before repeating this action."
            : relevant.some((intent) => intent?.state === "pending")
              ? "Opening ChatGPT…"
              : relevant.some(
                    (intent) => intent?.code === "CHATGPT_SIGN_IN_IN_PROGRESS",
                  )
                ? "Sign-in is already open in ChatGPT. Finish there, then check sign-in in Connection."
                : "ChatGPT could not be opened. Check Connection or see Diagnostics for details."}
        </p>
      )}
    </div>
  );
}
function PageListResizer({
  facade,
  width,
}: {
  facade: RendererFacade;
  width: number;
}) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(
    null,
  );
  const finish = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    facade.resizeSidebar(facade.getSnapshot().sidebarWidth, false);
  }, [facade]);
  useEffect(() => {
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("blur", finish);
      finish();
    };
  }, [finish]);
  return (
    <div
      className="page-list-resizer"
      role="separator"
      aria-label="Resize page list"
      aria-orientation="vertical"
      aria-valuemin={shellGeometry.pageListMin}
      aria-valuemax={shellGeometry.pageListMax}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag or use arrow keys to resize the page list"
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        const state = facade.getSnapshot();
        facade.resizeSidebar(state.sidebarWidth, true);
        if (!facade.getSnapshot().sidebarResizing) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          width: state.sidebarWidth,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!facade.getSnapshot().sidebarResizing) {
          drag.current = null;
          return;
        }
        const start = drag.current;
        if (start?.pointerId !== event.pointerId) return;
        facade.resizeSidebar(start.width + event.clientX - start.x, true);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        finish();
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={(event) => {
        if (!facade.getSnapshot().sidebarResizing) drag.current = null;
        if (event.key === "Escape" && drag.current) {
          drag.current = null;
          facade.dismissOverlay();
        } else if (event.key === "ArrowLeft")
          facade.resizeSidebar(width - 8, drag.current !== null);
        else if (event.key === "ArrowRight")
          facade.resizeSidebar(width + 8, drag.current !== null);
        else if (event.key === "Home")
          facade.resizeSidebar(
            shellGeometry.pageListMin,
            drag.current !== null,
          );
        else if (event.key === "End")
          facade.resizeSidebar(
            shellGeometry.pageListMax,
            drag.current !== null,
          );
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    />
  );
}

export function Shell() {
  const { snapshot, facade } = useRenderer();
  const state = snapshot;
  const destination = state.destination;
  const stage = useRef<HTMLElement>(null);
  const pageKey =
    destination.area === "settings" || destination.area === "setup"
      ? `${destination.area}:${destination.page}:${destination.setupStep ?? ""}`
      : destination.area === "home"
        ? `home:${destination.homeView ?? "overview"}:${destination.homeSelection?.id ?? ""}`
        : destination.area;
  useLayoutEffect(() => {
    if (stage.current) {
      stage.current.scrollTop = 0;
      stage.current.scrollLeft = 0;
    }
  }, [pageKey]);
  const [compactWindow, setCompactWindow] = useState(
    () => window.innerWidth < shellGeometry.autoRailBelow,
  );
  useEffect(() => {
    const resize = () =>
      setCompactWindow(window.innerWidth < shellGeometry.autoRailBelow);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const sideVisible =
    state.sidebar === "overlay" || (state.sidebar === "full" && !compactWindow);
  const sidebarOverlay = sideVisible && state.sidebar === "overlay";
  const settings = destination.area === "settings";
  const settingsAttention = useSettingsAttention(facade, state);
  const configuration =
    state.configuration?.status === "ready"
      ? state.configuration.settings
      : null;
  const unresolved =
    settingsAttention ||
    Boolean(
      state.workspaceEditDelivery || configuration?.computer.pendingEdit,
    ) ||
    Object.values(state.intents).some(
      (intent) => intent.state === "pending" || intent.state === "unknown",
    ) ||
    Object.values(configuration?.setup ?? {}).some(
      (step) => "outcomeUnknown" in step && step.outcomeUnknown,
    ) ||
    configuration?.connectors.secureMcp.runtime?.state === "outcome_unknown";
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        facade.overlay("search");
      } else if (event.key === "Escape") {
        facade.dismissOverlay();
      }
    };
    window.addEventListener("keydown", listener);
    return () => {
      window.removeEventListener("keydown", listener);
    };
  }, [facade]);
  return (
    <div
      className="desktop"
      data-theme={state.appearance.theme}
      data-accent={state.appearance.accent}
      data-font={state.appearance.font}
      data-sidebar={sidebarOverlay ? "overlay" : sideVisible ? "full" : "rail"}
      data-window-active={state.window.focused}
      data-sidebar-resizing={state.sidebarResizing}
      style={
        {
          "--rail-width": `${shellGeometry.sidebarRail}px`,
          "--toolbar-height": `${shellGeometry.windowBar}px`,
          "--page-list-width": `${state.sidebarWidth}px`,
          "--side-width": `${sideVisible && !sidebarOverlay ? state.sidebarWidth : 0}px`,
        } as CSSProperties
      }
    >
      <header className="toolbar">
        <div className="navigation-chrome">
          <div className="traffic-light-space" />
          <button
            aria-label="Back"
            disabled={!state.back}
            onClick={() => facade.travel(-1)}
          >
            <Icon name="back" />
          </button>
          <button
            aria-label="Forward"
            disabled={!state.forward}
            onClick={() => facade.travel(1)}
          >
            <Icon name="forward" />
          </button>
          <button
            title="Show or hide page list"
            aria-label="Toggle sidebar"
            aria-expanded={sideVisible}
            onClick={() => facade.toggleSidebar(compactWindow)}
          >
            <Icon name="sidebar" />
          </button>
        </div>
        <div className="toolbar-title">
          {(settings || destination.area === "setup") && (
            <span>
              {settings ? "Settings" : "Setup"}{" "}
              <span className="separator">/</span>
            </span>
          )}
          <strong>{title(state)}</strong>
          {state.environment === "dev" && <small>Development</small>}
        </div>
        <button
          aria-label="Find a page"
          className="search-trigger"
          onClick={() => facade.overlay("search")}
        >
          <Icon name="search" />
          <span>Find a page</span>
          <kbd>⌘ K</kbd>
        </button>
        {destination.area === "chatgpt" && destination.taskId && (
          <button
            aria-label="Chat options"
            onClick={() => {
              facade.overlay("task");
            }}
          >
            <Icon name="settings" />
          </button>
        )}
        {state.update.phase !== "unavailable" && (
          <button
            aria-label="Review update status"
            onClick={() => facade.overlay("update")}
          >
            <Icon name="settings" />
          </button>
        )}
      </header>
      <nav className="rail" aria-label="Sections">
        {(["home", "chatgpt", "activity"] as const).map((area) => (
          <button
            key={area}
            aria-label={
              area === "chatgpt"
                ? "ChatGPT"
                : area === "home"
                  ? "Home"
                  : "Activity"
            }
            title={
              area === "chatgpt"
                ? "ChatGPT"
                : area === "home"
                  ? "Home"
                  : "Activity"
            }
            aria-current={destination.area === area ? "page" : undefined}
            onClick={() => facade.navigate({ area })}
          >
            <Icon name={area} />
          </button>
        ))}
        <button
          aria-label="Setup"
          title="Setup"
          aria-current={destination.area === "setup" ? "page" : undefined}
          onClick={() => facade.navigate({ area: "setup" })}
        >
          <Icon name="check" />
        </button>
        {unresolved && (
          <button
            aria-label="Review unresolved actions"
            title="Actions need observation or result delivery"
            className="attention-action"
            onClick={() =>
              facade.navigate({ area: "settings", page: "diagnostics" })
            }
          >
            <Icon name="attention" />
          </button>
        )}
        <button
          className="rail-bottom"
          aria-label="Settings"
          title="Settings"
          aria-current={settings ? "page" : undefined}
          onClick={() =>
            facade.navigate({ area: "settings", page: "appearance" })
          }
        >
          <Icon name="settings" />
        </button>
      </nav>
      {sideVisible && (
        <aside
          className={`sidebar contextual-sidebar ${sidebarOverlay ? "sidebar-overlay" : ""}`}
          aria-label={settings ? "Settings pages" : "Page list"}
        >
          <PageListResizer facade={facade} width={state.sidebarWidth} />
          <h2>
            {settings
              ? "Settings"
              : destination.area === "home"
                ? "Home"
                : destination.area === "setup"
                  ? "Setup"
                  : destination.area === "chatgpt"
                    ? "ChatGPT"
                    : "Activity"}
          </h2>
          {destination.area === "home" && (
            <HomeNavigation snapshot={state} facade={facade} />
          )}
          {destination.area === "setup" && (
            <SetupNavigation snapshot={state} facade={facade} />
          )}
          {settings && (
            <nav aria-label="Settings navigation">
              {pages.map(([page, label]) => (
                <button
                  key={page}
                  aria-current={destination.page === page ? "page" : undefined}
                  onClick={() => facade.navigate({ area: "settings", page })}
                >
                  <Icon name={page === "folders" ? "sidebar" : "settings"} />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
          )}
          {destination.area === "chatgpt" &&
            state.tasks.tasks.some((task) => task.agent) && (
              <nav className="sidebar-section" aria-label="Farol work">
                <h2>Farol work</h2>
                {state.tasks.tasks
                  .filter((task) => task.agent)
                  .map((task) => (
                    <button
                      key={task.taskId}
                      aria-current={
                        destination.area === "chatgpt" &&
                        destination.taskId === task.taskId
                          ? "page"
                          : undefined
                      }
                      onClick={() => {
                        facade.navigate({
                          area: "chatgpt",
                          taskId: task.taskId,
                        });
                        void facade.task(
                          { kind: "task.activate", taskId: task.taskId },
                          `activate:${task.taskId}`,
                        );
                      }}
                    >
                      <Icon name="chatgpt" />
                      <span>
                        {task.label}
                        <small>{task.agent?.phase.replaceAll("_", " ")}</small>
                      </span>
                    </button>
                  ))}
              </nav>
            )}
          {destination.area === "chatgpt" && (
            <p className="description">
              Your conversations stay in ChatGPT. Use its own New chat action to
              start a conversation.
            </p>
          )}
          {destination.area === "activity" && (
            <p className="description">
              Recorded events in this window. Select an event for its details.
            </p>
          )}
        </aside>
      )}
      {sidebarOverlay && (
        <button
          className="sidebar-scrim"
          aria-label="Close sidebar"
          onClick={() => facade.toggleSidebar(true)}
        />
      )}
      <main
        ref={stage}
        className="stage"
        inert={state.overlay !== "none" || sidebarOverlay}
      >
        {state.status !== "current" && (
          <div className="notice" role="status">
            {state.status === "starting"
              ? "Connecting to Farol…"
              : state.status === "incompatible"
                ? "This renderer and host could not agree on their schema."
                : state.status === "unavailable"
                  ? "Farol state is unavailable."
                  : "State is stale. Observe current state before changing access."}
            <button onClick={() => void facade.refresh()}>Refresh state</button>
          </div>
        )}
        <PanelBoundary key={destination.area}>
          {destination.area === "home" ? (
            <Home snapshot={state} facade={facade} />
          ) : destination.area === "setup" ? (
            <Setup snapshot={state} facade={facade} />
          ) : destination.area === "settings" ? (
            <Settings snapshot={state} facade={facade} />
          ) : destination.area === "activity" ? (
            <div className="activity-page">
              <Activity snapshot={state} facade={facade} />
            </div>
          ) : (
            <ChatBrowser snapshot={state} facade={facade} />
          )}
        </PanelBoundary>
      </main>
      {state.overlay === "search" && (
        <Search snapshot={state} facade={facade} />
      )}{" "}
      {state.overlay === "update" && (
        <Update snapshot={state} facade={facade} />
      )}{" "}
      {state.overlay === "task" && (
        <Overlay title="Chat options" onClose={() => facade.overlay("none")}>
          <TaskEditor
            key={destination.taskId}
            snapshot={state}
            facade={facade}
          />
        </Overlay>
      )}
    </div>
  );
}
