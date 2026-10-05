import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRenderer } from "./services";
import { PanelBoundary } from "./boundary";
import { Settings } from "./settings";
import type {
  ActivityEntry,
  RendererFacade,
  SettingsPage,
  WindowSnapshot,
} from "./contract";
import { routeReadiness } from "../setup-presentation";
import { TaskEditor } from "./task";
import { ChatReadonly } from "./chat-readonly";
import { ChatHistory } from "./chat-history";
const pages: readonly [SettingsPage, string][] = [
  ["general", "General"],
  ["appearance", "Appearance"],
  ["folders", "Folders"],
  ["computer", "This Mac"],
  ["connection", "Connection"],
  ["model", "Model"],
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
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name] ?? paths.settings} />
    </svg>
  );
}
export function connection(snapshot: WindowSnapshot) {
  const config = snapshot.configuration;
  if (config?.status !== "ready" || !snapshot.buildId) return "Setup needed";
  const ready = routeReadiness(config.settings.setup.chatgpt, {
    stale:
      config.settings.setup.chatgpt.verified !== null &&
      config.settings.setup.chatgpt.verified.buildId !== snapshot.buildId,
  });
  return snapshot.status !== "current"
    ? "Connection check needed"
    : ready === "ready"
      ? "Ready"
      : ready === "outcome-unknown"
        ? "Outcome unknown"
        : ready === "failed"
          ? "Disconnected"
          : ready === "not-configured"
            ? "Setup needed"
            : "Connection check needed";
}
function title(snapshot: WindowSnapshot) {
  return snapshot.destination.area === "settings"
    ? (pages.find(([id]) => id === snapshot.destination.page)?.[1] ??
        "Settings")
    : snapshot.destination.area === "chatgpt"
      ? (snapshot.tasks.tasks.find(
          (task) => task.taskId === snapshot.destination.taskId,
        )?.label ?? "ChatGPT")
      : snapshot.destination.area === "activity"
        ? "Activity"
        : "Home";
}
function Work({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  return (
    <div className="work-list">
      {snapshot.tasks.tasks.length === 0 ? (
        <p className="empty">No current work. Open ChatGPT to begin.</p>
      ) : (
        snapshot.tasks.tasks.map((task, index) => (
          <button
            className="work-row"
            key={task.taskId}
            onClick={() => {
              facade.navigate({ area: "chatgpt", taskId: task.taskId });
              void facade.task(
                { kind: "task.activate", taskId: task.taskId },
                `activate:${task.taskId}`,
              );
            }}
          >
            <span className="slot-number">{index + 1}</span>
            <span className="work-label">
              <strong>{task.label}</strong>
              <small>
                Window {index + 1} ·{" "}
                {task.agent?.observation === "unavailable"
                  ? "Observation unavailable"
                  : "Current slot"}
              </small>
            </span>
            <span className="phase">
              {task.agent?.phase ?? task.lifecycle.replaceAll("_", " ")}
            </span>
            <Icon name="forward" />
          </button>
        ))
      )}
    </div>
  );
}
function Home({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const ready = connection(snapshot);
  const settings =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings
      : null;
  return (
    <div className="home-page">
      <div className="home-intro">
        <span className="intro-mark">
          <Icon name={ready === "Ready" ? "check" : "home"} />
        </span>
        <div>
          <h1>
            {ready === "Ready"
              ? "Ready for your next task"
              : "Make room for your next task"}
          </h1>
          <p>
            {ready === "Ready"
              ? "ChatGPT is connected. The connection check passed."
              : `${ready}. Review connection and folder access independently.`}
          </p>
        </div>
      </div>
      <div className="home-columns">
        <div>
          <section>
            <div className="section-heading">
              <h2>Current work</h2>
              <button
                className="text-button"
                onClick={() => facade.navigate({ area: "chatgpt" })}
              >
                View ChatGPT
              </button>
            </div>
            <Work snapshot={snapshot} facade={facade} />
            <p className="description">
              Switching sections keeps ongoing work available.
            </p>
          </section>
          <ChatReadonly snapshot={snapshot} facade={facade} />
          <ChatHistory snapshot={snapshot} facade={facade} />
          <section className="recent">
            <div className="section-heading">
              <h2>Recent activity</h2>
              <button
                className="text-button"
                onClick={() => facade.navigate({ area: "activity" })}
              >
                View all
              </button>
            </div>
            <Activity snapshot={snapshot} facade={facade} recent />
          </section>
        </div>
        <aside className="readiness">
          <h2>Connection &amp; access</h2>
          <div className="readiness-summary" data-ready={ready === "Ready"}>
            <strong>{ready}</strong>
            <p>
              {ready === "Ready"
                ? "ChatGPT is connected and the check passed."
                : "Connection verification requires current evidence."}
            </p>
          </div>
          <h3>ChatGPT</h3>
          <p>{ready}</p>
          <button
            className="text-button"
            onClick={() =>
              facade.navigate({ area: "settings", page: "connection" })
            }
          >
            Manage connection
          </button>
          <h3>This Mac</h3>
          <p>
            {snapshot.runtime === "ready"
              ? "Local service available"
              : "Local service unavailable"}
          </p>
          <button
            className="text-button"
            onClick={() =>
              facade.navigate({ area: "settings", page: "computer" })
            }
          >
            Review access
          </button>
          <h3>Shared folders</h3>
          <p>{settings?.computer.workspaces.length ?? 0} approved folders</p>
          <p className="description">
            Folder status is separate from the connection.
          </p>
          <button
            className="text-button"
            onClick={() =>
              facade.navigate({ area: "settings", page: "folders" })
            }
          >
            Manage folders
          </button>
        </aside>
      </div>
    </div>
  );
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
  const [selected, setSelected] = useState<ActivityEntry | null>(null);
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
              setSelected(event);
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
            setSelected(null);
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
export function Shell() {
  const { snapshot, facade } = useRenderer();
  const state = snapshot;
  const destination = state.destination;
  const sideVisible = destination.area !== "home" && state.sidebar !== "rail";
  const sidebarOverlay = sideVisible && state.sidebar === "overlay";
  const settings = destination.area === "settings";
  const compact = () => window.matchMedia("(max-width: 979px)").matches;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        facade.overlay("search");
      } else if (event.key === "Escape") {
        facade.overlay("none");
        if (facade.getSnapshot().sidebar === "overlay")
          facade.toggleSidebar(true);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [facade]);
  const intents = Object.values(state.intents);
  const busy =
    intents.find(
      (intent) => intent.state === "pending" || intent.state === "unknown",
    ) ?? [...intents].reverse().find((intent) => intent.state === "refused");
  return (
    <div
      className="desktop"
      data-theme={state.appearance.theme}
      data-accent={state.appearance.accent}
      data-font={state.appearance.font}
      data-sidebar={sideVisible ? "full" : "rail"}
      data-window-active={state.window.focused}
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
            aria-label="Toggle sidebar"
            aria-expanded={sideVisible}
            onClick={() => facade.toggleSidebar(compact())}
          >
            <Icon name="sidebar" />
          </button>
        </div>
        <div className="toolbar-title">
          {settings && (
            <span>
              Settings <span className="separator">/</span>
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
            aria-label="Task options"
            onClick={() => facade.overlay("task")}
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
            aria-label={
              area === "chatgpt"
                ? "ChatGPT"
                : area === "home"
                  ? "Home"
                  : "Activity"
            }
            key={area}
            aria-current={destination.area === area ? "page" : undefined}
            onClick={() => facade.navigate({ area })}
          >
            <Icon name={area} />
          </button>
        ))}
        <button
          className="rail-bottom"
          aria-label="Settings"
          aria-current={settings ? "page" : undefined}
          onClick={() => facade.navigate({ area: "settings", page: "general" })}
        >
          <Icon name="settings" />
        </button>
      </nav>
      {sideVisible && (
        <aside
          className={`contextual-sidebar ${state.sidebar === "overlay" ? "sidebar-overlay" : ""}`}
          aria-label={settings ? "Settings pages" : "Current work"}
        >
          <h2>
            {settings
              ? "Settings"
              : destination.area === "activity"
                ? "Activity"
                : "ChatGPT"}
          </h2>
          <p className="description">
            {settings
              ? "Clear pages. Independent controls."
              : "Five current browser slots."}
          </p>
          {settings ? (
            pages.map(([page, label]) => (
              <button
                key={page}
                aria-current={destination.page === page ? "page" : undefined}
                onClick={() => facade.navigate({ page })}
              >
                <Icon name={page === "folders" ? "sidebar" : "settings"} />
                {label}
              </button>
            ))
          ) : (
            <>
              {state.tasks.tasks.map((task, index) => (
                <button
                  key={task.taskId}
                  aria-current={
                    destination.taskId === task.taskId ? "page" : undefined
                  }
                  onClick={() => {
                    facade.navigate({ area: "chatgpt", taskId: task.taskId });
                    void facade.task(
                      { kind: "task.activate", taskId: task.taskId },
                      `activate:${task.taskId}`,
                    );
                  }}
                >
                  <span className="slot-number">{index + 1}</span>
                  <span>
                    {task.label}
                    <small>
                      {task.agent?.phase ?? task.lifecycle.replaceAll("_", " ")}
                    </small>
                  </span>
                </button>
              ))}
              <button
                disabled={
                  state.status !== "current" ||
                  state.tasks.tasks.length >= 5 ||
                  state.intents["task:new"]?.state === "pending" ||
                  state.intents["task:new"]?.state === "unknown"
                }
                onClick={() =>
                  void facade.task({ kind: "task.create-chatgpt" }, "task:new")
                }
              >
                <Icon name="plus" />
                New ChatGPT task
              </button>
            </>
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
        {busy && (
          <div
            className="notice"
            role={busy.state === "refused" ? "alert" : "status"}
          >
            {busy.state === "pending"
              ? "Action in progress…"
              : busy.state === "unknown"
                ? "Outcome unknown. The action may already have taken effect."
                : `Action refused: ${busy.code}`}
          </div>
        )}
        <PanelBoundary key={destination.area}>
          {destination.area === "home" ? (
            <Home snapshot={state} facade={facade} />
          ) : destination.area === "settings" ? (
            <Settings snapshot={state} facade={facade} />
          ) : destination.area === "activity" ? (
            <div className="activity-page">
              <Activity snapshot={state} facade={facade} />
            </div>
          ) : (
            <div className="native-browser-placeholder">
              <p>
                Existing ChatGPT pages remain in their native browser views.
              </p>
              <div className="control-row">
                <button
                  onClick={() =>
                    void facade.configure(
                      { kind: "chatgpt.open-browser" },
                      "settings:chatgpt.open-browser:",
                    )
                  }
                >
                  Open ChatGPT
                </button>
                <button
                  onClick={() =>
                    void facade.configure(
                      { kind: "chatgpt.open-sign-in" },
                      "settings:chatgpt.open-sign-in:",
                    )
                  }
                >
                  Sign in
                </button>
              </div>
            </div>
          )}
        </PanelBoundary>
      </main>
      {state.workspaceEditDelivery && (
        <div className="delivery-notice" role="status">
          Guarded edit result:{" "}
          {state.intents[`observe:${state.workspaceEditDelivery}`]?.state ??
            "applied"}
          .{" "}
          {state.intents[`observe:${state.workspaceEditDelivery}`]?.code ??
            "The exact edit outcome was delivered."}{" "}
          <button
            onClick={() =>
              void facade.acknowledgeWorkspaceEdit(state.workspaceEditDelivery!)
            }
          >
            Record result delivery
          </button>
        </div>
      )}
      {state.overlay === "search" && (
        <Search snapshot={state} facade={facade} />
      )}{" "}
      {state.overlay === "update" && (
        <Update snapshot={state} facade={facade} />
      )}{" "}
      {state.overlay === "task" && (
        <Overlay title="Current task" onClose={() => facade.overlay("none")}>
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
