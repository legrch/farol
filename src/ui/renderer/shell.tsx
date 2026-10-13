import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import {
  isCompactShell,
  shellGeometry,
  shellRailWidth,
} from "../../pkg/shell-layout/geometry";
import { useRenderer } from "./services";
import { pageListMode } from "./sidebar-presentation";
import { PanelBoundary } from "./boundary";
import { Settings, useSettingsAttention } from "./settings";
import type { RendererFacade, SettingsPage, WindowSnapshot } from "./contract";
import { computerSetup } from "./computer-setup";
import { TaskEditor } from "./task";
import { Home, HomeNavigation, homeTitle } from "./home";
import { Setup, SetupNavigation } from "./setup";
import { setupSteps } from "./setup-navigation";
import { designIconPath, designIconViewBox } from "./design-icons";
import { UpdateNotice, acknowledgeUpdateNotice } from "./update-notice";
import {
  confirmedRestartAllowed,
  isConfirmedBrowserBlock,
  updateVersionLabel,
} from "./update-eligibility";
import { AutomaticUpdateChoice } from "./automatic-update-choice";
import {
  UpdateDownloadProgress,
  updateDownloadMessage,
} from "./update-download";
import {
  updateBlockMessage,
  updateResultMessage,
} from "../update-block-message";
const pages: readonly [SettingsPage, string][] = [
  ["general", "General"],
  ["appearance", "Appearance"],
  ["folders", "Workspaces"],
  ["computer", "This Mac"],
  ["connection", "Connection"],
  ["shortcuts", "Keyboard shortcuts"],
  ["diagnostics", "Diagnostics"],
];
export function Icon({ name }: { name: string }) {
  return (
    <svg viewBox={designIconViewBox} aria-hidden="true">
      <path d={designIconPath(name)} />
    </svg>
  );
}
export function connection(snapshot: WindowSnapshot) {
  return computerSetup(snapshot).label;
}
function title(snapshot: WindowSnapshot, filter: ActivityFilter) {
  return snapshot.destination.area === "settings"
    ? (pages.find(([id]) => id === snapshot.destination.page)?.[1] ??
        "Settings")
    : snapshot.destination.area === "chatgpt"
      ? (snapshot.tasks.tasks.find(
          (task) => task.taskId === snapshot.destination.taskId && task.agent,
        )?.label ?? "ChatGPT")
      : snapshot.destination.area === "activity"
        ? activityTitle(snapshot, filter)
        : snapshot.destination.area === "setup"
          ? (setupSteps.find(
              ([step]) => step === snapshot.destination.setupStep,
            )?.[1] ?? "Setup")
          : homeTitle(snapshot);
}
type ActivityFilter = "all" | "attention";
function activityItems(snapshot: WindowSnapshot, filter: ActivityFilter) {
  return [...snapshot.activity]
    .reverse()
    .filter((event) => filter === "all" || event.phase === "outcome_unknown");
}
function activitySelection(snapshot: WindowSnapshot, filter: ActivityFilter) {
  const items = activityItems(snapshot, filter);
  const selected = snapshot.destination.activityId
    ? snapshot.activity.find(
        (event) => event.id === snapshot.destination.activityId,
      )
    : items[0];
  const missing = Boolean(snapshot.destination.activityId && !selected);
  const filtered = Boolean(
    selected && !items.some((event) => event.id === selected.id),
  );
  return { items, selected, missing, filtered };
}
function activityTitle(snapshot: WindowSnapshot, filter: ActivityFilter) {
  const { selected, filtered } = activitySelection(snapshot, filter);
  return selected && !filtered ? selected.label : "Activity";
}
function activityPhase(event: WindowSnapshot["activity"][number]) {
  return event.phase?.replaceAll("_", " ") ?? "Phase not recorded";
}
function ActivityTime({
  at,
  compact = false,
}: {
  at: number;
  compact?: boolean;
}) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return <span>Time unavailable</span>;
  return (
    <time dateTime={date.toISOString()}>
      {compact
        ? date.toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })
        : date.toLocaleString()}
    </time>
  );
}
function ActivityNavigation({
  snapshot,
  facade,
  filter,
  onFilter,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
  filter: ActivityFilter;
  onFilter: (filter: ActivityFilter) => void;
}) {
  const items = activityItems(snapshot, filter);
  const selectedId = snapshot.destination.activityId ?? items[0]?.id;
  return (
    <div className="activity-navigation">
      <p className="description">Events you can inspect.</p>
      <label className="activity-filter">
        Activity filter
        <select
          value={filter}
          onChange={(event) =>
            onFilter(event.target.value === "attention" ? "attention" : "all")
          }
        >
          <option value="all">All activity</option>
          <option value="attention">Needs attention</option>
        </select>
      </label>
      <nav aria-label="Recorded events">
        {items.map((event) => (
          <button
            type="button"
            className="activity-row"
            key={event.id}
            aria-current={selectedId === event.id ? "page" : undefined}
            onClick={() =>
              facade.navigate({ area: "activity", activityId: event.id })
            }
          >
            <span>
              <strong>{event.label}</strong>
              <small>
                {activityPhase(event)} · <ActivityTime at={event.at} compact />
              </small>
              {event.operation && <small>{event.operation}</small>}
            </span>
          </button>
        ))}
      </nav>
      {!items.length && <p className="description">No matching events.</p>}
      <p className="description activity-retention">
        Recorded metadata only. Up to 256 events are held in memory in this
        window.
      </p>
      {snapshot.sidebar === "overlay" && (
        <button type="button" onClick={() => facade.toggleSidebar(true)}>
          Close Activity sidebar
        </button>
      )}
    </div>
  );
}
function ActivityRecord({
  snapshot,
  facade,
  selected,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
  selected: WindowSnapshot["activity"][number];
}) {
  const matchingChat = snapshot.tasks.tasks.some(
    (task) =>
      task.taskId === selected.taskId && task.turnId === selected.turnId,
  );
  const outcome =
    selected.phase === "outcome_unknown"
      ? "There is no confirmed successful or failed result."
      : selected.kind === "turn.terminal" && selected.phase === "completed"
        ? "A completed result was recorded."
        : "This event does not establish successful task completion.";
  const summary =
    selected.phase === "outcome_unknown"
      ? "Outcome not confirmed"
      : selected.kind === "computer.requested"
        ? "Computer operation requested"
        : selected.kind === "turn.terminal" && selected.phase === "cancelled"
          ? "Work cancelled"
          : selected.kind === "turn.terminal" && selected.phase === "completed"
            ? "Completed event"
            : "Recorded event";
  return (
    <>
      <div className="activity-header">
        <Icon name="activity" />
        <div>
          <strong
            className={
              selected.phase === "outcome_unknown"
                ? "activity-unknown"
                : undefined
            }
          >
            {activityPhase(selected)}
          </strong>
          <p>
            <ActivityTime at={selected.at} />
          </p>
        </div>
        {matchingChat && (
          <button
            type="button"
            onClick={() => {
              const latest = facade.getSnapshot();
              const recorded = latest.activity.some(
                (event) =>
                  event.id === selected.id &&
                  event.taskId === selected.taskId &&
                  event.turnId === selected.turnId,
              );
              const task = latest.tasks.tasks.find(
                (item) =>
                  item.taskId === selected.taskId &&
                  item.turnId === selected.turnId,
              );
              if (
                latest.status === "current" &&
                latest.runtime === "ready" &&
                recorded &&
                task &&
                task.agent?.observation !== "unavailable"
              )
                facade.navigate({ area: "chatgpt", taskId: task.taskId });
            }}
          >
            View chat
          </button>
        )}
      </div>
      {!matchingChat && (
        <div className="activity-history-limit">
          <h2>Chat no longer available here</h2>
          <p>
            The recorded conversation is no longer available in this slot. Its
            event can still be inspected.
          </p>
        </div>
      )}
      <h2>What was recorded</h2>
      <div className="activity-event">
        <ActivityTime at={selected.at} compact />
        <strong>{summary}</strong>
        <p>{outcome}</p>
      </div>
      <dl className="activity-facts">
        {[
          ["Event kind", selected.kind],
          ["Phase", selected.phase ?? "Not recorded"],
          ["Terminal code", selected.code ?? "Not recorded"],
          ["Operation", selected.operation ?? "Not recorded"],
        ].map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              <code>{value}</code>
            </dd>
          </div>
        ))}
      </dl>
      <details className="activity-identifiers">
        <summary>Available technical identifiers</summary>
        <dl className="activity-facts">
          {[
            ["Event identity", selected.id],
            ["Task identity", selected.taskId],
            ["Turn identity", selected.turnId],
            ["Generation", selected.generation],
          ].map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </details>
      <p className="description">
        Only recorded metadata is shown. Conversation text, file contents and
        full tool payloads are excluded.
      </p>
    </>
  );
}
function Activity({
  snapshot,
  facade,
  filter,
  onFilter,
  showList,
  heading,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
  filter: ActivityFilter;
  onFilter: (filter: ActivityFilter) => void;
  showList: boolean;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const previousOverlay = useRef(snapshot.overlay);
  const { items, selected, missing, filtered } = activitySelection(
    snapshot,
    filter,
  );
  useLayoutEffect(() => {
    const returningFrom = previousOverlay.current;
    previousOverlay.current = snapshot.overlay;
    if (
      snapshot.sidebar !== "overlay" &&
      snapshot.overlay === "none" &&
      (returningFrom === "none" || returningFrom === "activity")
    )
      heading.current?.focus({ preventScroll: true });
  }, [
    heading,
    snapshot.destination.activityId,
    snapshot.sidebar,
    snapshot.overlay,
  ]);
  const emptyTitle = missing
    ? "Event no longer available"
    : filter === "all" && !snapshot.activity.length
      ? "No activity yet"
      : !items.length
        ? "No events need attention"
        : "Selected event is outside this filter";
  const details =
    selected && !filtered ? (
      <ActivityRecord snapshot={snapshot} facade={facade} selected={selected} />
    ) : (
      <div className="activity-empty" role="status">
        <Icon name="activity" />
        <h2>{emptyTitle}</h2>
        <p>
          {missing
            ? "This event is no longer available in this window. Its absence does not establish an outcome."
            : filter === "all" && !snapshot.activity.length
              ? "Recorded task events appear here as work happens. Only recorded metadata is shown."
              : "Choose All activity or select a matching event to inspect recorded work."}
        </p>
        {filter === "attention" && (
          <button
            type="button"
            onClick={(event) => {
              const dialog = event.currentTarget.closest("dialog");
              const target = dialog
                ? dialog.querySelector<HTMLButtonElement>(
                    'button[aria-label="Close"]',
                  )
                : heading.current;
              onFilter("all");
              target?.focus();
            }}
          >
            Show all activity
          </button>
        )}
      </div>
    );
  return (
    <>
      <p className="description">
        Recorded stages and outcomes, without storing the conversation itself.
      </p>
      {showList && (
        <ActivityNavigation
          snapshot={snapshot}
          facade={facade}
          filter={filter}
          onFilter={onFilter}
        />
      )}
      {details}
      {snapshot.overlay === "activity" && (
        <Overlay title="Recorded event" onClose={() => facade.overlay("none")}>
          {details}
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
  initialFocus,
  className,
  headingIcon,
  headingDescription,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  dismissible?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  headingIcon?: string;
  headingDescription?: ReactNode;
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
    const target = initialFocus?.current;
    if (target && dialog.contains(target)) target.focus();
    return () => {
      dialog.close();
      if (restore instanceof HTMLElement && restore.isConnected)
        restore.focus();
    };
  }, [initialFocus]);
  return (
    <dialog
      ref={ref}
      className={className ? `sheet ${className}` : "sheet"}
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
          {headingIcon ? (
            <div className="update-heading">
              <span className="update-symbol">
                <Icon name={headingIcon} />
              </span>
              <div>
                <h2>{title}</h2>
                {headingDescription}
              </div>
            </div>
          ) : (
            <h2>{title}</h2>
          )}
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
  const input = useRef<HTMLInputElement>(null);
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
    <Overlay
      title="Find a page"
      onClose={() => facade.overlay("none")}
      initialFocus={input}
    >
      <input
        ref={input}
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
const updateSheetTitles: Record<WindowSnapshot["update"]["phase"], string> = {
  available: "Update available",
  ready: "Ready to install",
  failed: "The update did not finish",
  recovery: "Update needs attention",
  checking: "Checking for updates",
  downloading: "Downloading update",
  applying: "Restarting to update",
  unavailable: "Updates unavailable",
  idle: "Update status",
};
function Update({
  snapshot,
  facade,
  recoveryMode = false,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
  recoveryMode?: boolean;
}) {
  const update = snapshot.update;
  const intent = snapshot.intents.update;
  const safeAction = useRef<HTMLButtonElement>(null);
  const progressStatus = useRef<HTMLParagraphElement>(null);
  const noticeKey = "notice" in update ? update.notice?.key : undefined;
  useEffect(() => {
    if (!recoveryMode && noticeKey) acknowledgeUpdateNotice(facade);
  }, [facade, noticeKey, recoveryMode]);
  const disabled =
    snapshot.status !== "current" ||
    intent?.state === "pending" ||
    intent?.state === "unknown";
  const recovery =
    update.phase === "recovery" ||
    (update.phase === "failed" && update.recoveryRequired);
  const rollbackVersion =
    recoveryMode &&
    (update.phase === "idle" ||
      (update.phase === "failed" && !update.recoveryRequired))
      ? update.rollbackVersion
      : undefined;
  const release =
    !recoveryMode && (update.phase === "available" || update.phase === "ready");
  const blockedBy =
    (recovery ||
      rollbackVersion ||
      (!recoveryMode && update.phase === "ready")) &&
    "blockedBy" in update
      ? update.blockedBy
      : undefined;
  const localDismiss = !release || disabled || update.deferred;
  const stateCopy =
    !recoveryMode && snapshot.status !== "current"
      ? "Update status could not be confirmed. Review Diagnostics."
      : recoveryMode && !recovery
        ? rollbackVersion
          ? `Restore previous version ${rollbackVersion}.`
          : "No previous version is available to restore in the current update state."
        : update.phase === "ready"
          ? `Version ${updateVersionLabel(update.version)} is ready to install.`
          : update.phase === "available"
            ? `Version ${updateVersionLabel(update.version)} is available to download.`
            : update.phase === "failed"
              ? updateResultMessage(
                  "failed",
                  update.recoveryRequired,
                  update.code,
                )
              : update.phase === "unavailable"
                ? updateResultMessage("unavailable")
                : update.phase === "recovery"
                  ? `Recovery required for ${update.version}`
                  : update.phase === "applying"
                    ? `Applying version ${update.version}…`
                    : update.phase === "checking"
                      ? "Checking for updates…"
                      : update.phase === "downloading"
                        ? updateDownloadMessage(update)
                        : intent?.state === "unknown"
                          ? "Update status could not be confirmed."
                          : intent?.state === "pending"
                            ? "Checking update status…"
                            : update.checkedAt === null
                              ? "Update availability has not been checked."
                              : null;
  useEffect(() => {
    const active = document.activeElement;
    const target = safeAction.current;
    if (
      localDismiss &&
      target &&
      (active === document.body ||
        (active instanceof HTMLButtonElement &&
          active.disabled &&
          target.closest("dialog")?.contains(active)))
    )
      target.focus();
  }, [localDismiss, update.phase]);
  return (
    <Overlay
      title={
        recoveryMode
          ? "Update recovery"
          : update.phase === "downloading" &&
              update.progress?.stage === "verifying"
            ? "Checking update"
            : intent?.state === "unknown"
              ? "Update status unconfirmed"
              : intent?.state === "pending" && update.phase === "idle"
                ? "Checking for updates"
                : snapshot.status !== "current"
                  ? "Update status unconfirmed"
                  : update.phase === "idle" && update.checkedAt !== null
                    ? "You’re up to date"
                    : updateSheetTitles[update.phase]
      }
      onClose={() => facade.overlay("none")}
      dismissible={update.phase !== "applying"}
      className="update-sheet"
      initialFocus={update.phase === "applying" ? progressStatus : safeAction}
      headingIcon={
        recoveryMode ||
        update.phase === "failed" ||
        update.phase === "recovery" ||
        update.phase === "unavailable"
          ? "warning"
          : "download"
      }
      headingDescription={
        stateCopy !== null ? (
          <>
            <p
              className="update-state"
              role="status"
              ref={progressStatus}
              tabIndex={-1}
            >
              {stateCopy}
            </p>
            {!recoveryMode && update.phase === "downloading" && (
              <UpdateDownloadProgress update={update} />
            )}
          </>
        ) : undefined
      }
    >
      {!recoveryMode &&
        (update.phase === "available" || update.phase === "ready") &&
        update.notes && (
          <details className="update-release">
            <summary>
              What’s new in {updateVersionLabel(update.version)}
            </summary>
            <p className="update-notes">{update.notes}</p>
          </details>
        )}
      {recoveryMode &&
        (update.phase === "failed" || update.phase === "unavailable") &&
        (recovery || !isConfirmedBrowserBlock(update.code)) && (
          <details className="update-technical-code">
            <summary>Technical code</summary>
            <code>{update.code}</code>
          </details>
        )}
      {!recoveryMode && (
        <AutomaticUpdateChoice snapshot={snapshot} facade={facade} />
      )}
      {!recoveryMode && update.phase === "ready" && (
        <p className="description update-confirmation">
          Farol will close open ChatGPT sessions and interrupt work before
          restarting.
        </p>
      )}
      {recoveryMode && recovery ? (
        <p className="description">
          Farol will quit to finish recovery. If recovery restores the previous
          version, it stays closed until recovery completion is confirmed. Start
          the restored version separately after confirmation, then verify that
          start before resuming work.
        </p>
      ) : rollbackVersion ? (
        <p className="description">
          Version {rollbackVersion} is available to restore. Farol will quit to
          roll back, and the restored version stays closed until recovery
          completion is confirmed. Start it separately after confirmation, then
          verify that start before resuming work.
        </p>
      ) : !recoveryMode && update.phase === "available" ? (
        <p className="description">
          Download the update, then confirm installation and restart.
        </p>
      ) : null}
      {blockedBy &&
        (recoveryMode || recovery || !isConfirmedBrowserBlock(blockedBy)) && (
          <div
            className={
              recoveryMode || recovery ? "update-block" : "update-issue"
            }
            role="alert"
          >
            <strong>
              {recovery
                ? "Recovery is blocked"
                : rollbackVersion
                  ? "Roll back is blocked"
                  : "Update needs attention"}
            </strong>
            <p>
              {recoveryMode || recovery
                ? updateBlockMessage(blockedBy)
                : "Review Diagnostics before restarting."}
            </p>
            {recoveryMode && (
              <details>
                <summary>Technical code</summary>
                <code>{blockedBy}</code>
              </details>
            )}
          </div>
        )}
      <div
        className={`update-actions${update.phase === "available" ? "" : " two"}`}
      >
        {localDismiss && update.phase !== "applying" && (
          <button ref={safeAction} onClick={() => facade.overlay("none")}>
            {recoveryMode
              ? rollbackVersion || recovery
                ? "Cancel"
                : "Done"
              : update.phase === "idle"
                ? "Done"
                : recovery || rollbackVersion
                  ? "Dismiss"
                  : update.phase === "failed" || update.phase === "unavailable"
                    ? "Dismiss"
                    : "Continue working"}
          </button>
        )}
        {!recoveryMode && update.phase === "available" && (
          <>
            <button
              disabled={disabled}
              onClick={() => {
                const latest = facade.getSnapshot();
                if (
                  latest.status === "current" &&
                  latest.intents.update?.state !== "pending" &&
                  latest.intents.update?.state !== "unknown" &&
                  latest.update.phase === "available"
                )
                  void facade.update("skip");
              }}
            >
              Skip This Version
            </button>
            <button
              ref={!localDismiss ? safeAction : undefined}
              disabled={disabled || update.deferred}
              onClick={() => {
                void facade.update("later").then((result) => {
                  if (result.state === "applied") facade.overlay("none");
                });
              }}
            >
              Remind Me Later
            </button>
            <button
              className="primary"
              disabled={disabled}
              onClick={() => {
                const latest = facade.getSnapshot();
                if (
                  latest.status === "current" &&
                  latest.intents.update?.state !== "pending" &&
                  latest.intents.update?.state !== "unknown" &&
                  latest.update.phase === "available"
                )
                  void facade.update("download");
              }}
            >
              Download Update
            </button>
          </>
        )}
        {!recoveryMode && update.phase === "ready" && (
          <>
            <button
              ref={!localDismiss ? safeAction : undefined}
              disabled={disabled}
              onClick={() => {
                void facade.update("later").then((result) => {
                  if (result.state === "applied") facade.overlay("none");
                });
              }}
            >
              Remind Me Later
            </button>
            <button
              className="primary"
              disabled={disabled || !confirmedRestartAllowed(update)}
              onClick={() =>
                void facade.update("restart-confirmed", update.version)
              }
            >
              Install and Relaunch
            </button>
          </>
        )}
        {recoveryMode &&
          (update.phase === "recovery" ||
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
        {!recoveryMode &&
          (recovery ||
            !!blockedBy ||
            update.phase === "failed" ||
            update.phase === "unavailable") && (
            <button
              onClick={() =>
                facade.navigate({ area: "settings", page: "diagnostics" })
              }
            >
              Review Diagnostics
            </button>
          )}
        {recoveryMode &&
          (update.phase === "idle" ||
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
      {(("notice" in update && update.notice?.blockedBy) ||
        snapshot.intents["update-notice"]?.state === "unknown") && (
        <p role="alert">
          Saved update notices could not be confirmed. Do not retry the notice
          acknowledgement. Update actions retain their separate safety checks.
        </p>
      )}
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
  const intentions = [
    "chatgpt.present-browser",
    "chatgpt.open-browser",
    "chatgpt.open-sign-in",
  ] as const;
  const relevant = intentions
    .map((kind) => snapshot.intents[`settings:${kind}:`])
    .filter((intent) => intent && intent.state !== "applied");
  // Explicit navigation owns presentation; mounting this placeholder never
  // opens a browser. Retain pending and uncertain command outcomes separately
  // from the ambient route status.
  if (snapshot.route === "loaded" && relevant.length === 0) return null;
  const unknown = relevant.some((intent) => intent?.state === "unknown");
  const pending = relevant.some((intent) => intent?.state === "pending");
  const failed = snapshot.route === "failed" || relevant.length > 0;
  return (
    <div className="native-browser-placeholder">
      <p
        className="notice"
        role={unknown || (failed && !pending) ? "alert" : "status"}
      >
        {unknown
          ? "Opening ChatGPT is unconfirmed. See Diagnostics before repeating this action."
          : pending
            ? "Opening ChatGPT…"
            : relevant.some(
                  (intent) => intent?.code === "CHATGPT_SIGN_IN_IN_PROGRESS",
                )
              ? "Sign-in is already open in ChatGPT. Finish there, then check sign-in in Connection."
              : failed
                ? "ChatGPT could not be opened. Check Connection or see Diagnostics for details."
                : "ChatGPT page status has not been confirmed. Check Connection for details."}
      </p>
      <div className="control-row">
        <button
          onClick={() =>
            facade.navigate({
              area: "settings",
              page: unknown ? "diagnostics" : "connection",
            })
          }
        >
          {unknown ? "Diagnostics" : "Connection"}
        </button>
      </div>
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
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const stage = useRef<HTMLElement>(null);
  const activityHeading = useRef<HTMLHeadingElement>(null);
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const sidebarPanel = useRef<HTMLElement>(null);
  const previousSidebar = useRef({ open: false, destination });
  const scrollPositions = useRef(
    new WeakMap<WindowSnapshot["destination"], { top: number; left: number }>(),
  );
  useLayoutEffect(() => {
    if (stage.current) {
      const saved = scrollPositions.current.get(destination);
      stage.current.scrollTop = saved?.top ?? 0;
      stage.current.scrollLeft = saved?.left ?? 0;
    }
  }, [destination]);
  const [compactWindow, setCompactWindow] = useState(() =>
    isCompactShell(window.innerWidth),
  );
  useEffect(() => {
    const resize = () => setCompactWindow(isCompactShell(window.innerWidth));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const pageList = pageListMode(destination, state.sidebar);
  const sideVisible =
    pageList === "overlay" || (pageList === "full" && !compactWindow);
  const sidebarOverlay = sideVisible && pageList === "overlay";
  useLayoutEffect(() => {
    const previous = previousSidebar.current;
    previousSidebar.current = { open: sidebarOverlay, destination };
    // Modal dialogs and destination views own their own focus transitions.
    if (state.overlay !== "none") return;
    if (sidebarOverlay && !previous.open) {
      sidebarPanel.current
        ?.querySelector<HTMLElement>(
          "button:not(:disabled), select:not(:disabled), input:not(:disabled)",
        )
        ?.focus();
    } else if (
      !sidebarOverlay &&
      previous.open &&
      destination === previous.destination
    ) {
      sidebarTrigger.current?.focus();
    }
  }, [sidebarOverlay, destination, state.overlay]);
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
  const updateRailLabel =
    state.update.phase === "available"
      ? state.update.deferred
        ? "Update available, saved for later"
        : "Update available"
      : state.update.phase === "ready"
        ? state.update.deferred
          ? "Update downloaded, saved for later"
          : "Update ready"
        : state.update.phase === "failed" || state.update.phase === "recovery"
          ? "Update needs attention"
          : state.update.phase === "downloading" ||
              state.update.phase === "applying"
            ? "Update in progress"
            : null;
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
          "--rail-width": `${shellRailWidth(window.innerWidth)}px`,
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
            ref={sidebarTrigger}
            title="Show or hide page list"
            aria-label="Toggle sidebar"
            aria-expanded={sideVisible}
            onClick={() => facade.toggleSidebar(compactWindow)}
          >
            <Icon name="sidebar" />
          </button>
        </div>
        <div className="toolbar-title">
          {(settings ||
            destination.area === "setup" ||
            destination.area === "home") && (
            <span>
              {settings
                ? "Settings"
                : destination.area === "setup"
                  ? "Setup"
                  : "Home"}{" "}
              <span className="separator">/</span>
            </span>
          )}
          {destination.area === "activity" ? (
            <h1 ref={activityHeading} tabIndex={-1}>
              {title(state, activityFilter)}
            </h1>
          ) : (
            <strong>{title(state, activityFilter)}</strong>
          )}
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
          <Icon name="setup" />
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
        <div className="rail-footer">
          {updateRailLabel && (
            <button
              className="update-action"
              aria-label={updateRailLabel}
              title={updateRailLabel}
              onClick={() => facade.overlay("update")}
            >
              <Icon
                name={
                  state.update.phase === "failed" ||
                  state.update.phase === "recovery"
                    ? "attention"
                    : "download"
                }
              />
              {"notice" in state.update &&
                state.update.notice &&
                !state.update.notice.seen && (
                  <span className="update-dot" aria-hidden="true" />
                )}
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
        </div>
      </nav>
      {sideVisible && (
        <aside
          ref={sidebarPanel}
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
                  <Icon name={page} />
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
                        const latest = facade.getSnapshot();
                        const currentTask = latest.tasks.tasks.find(
                          (item) =>
                            item.taskId === task.taskId &&
                            item.sessionId === task.sessionId &&
                            item.turnId === task.turnId,
                        );
                        if (
                          latest.status !== "current" ||
                          latest.runtime !== "ready" ||
                          !currentTask?.agent ||
                          currentTask.agent.observation === "unavailable"
                        )
                          return;
                        facade.navigate({
                          area: "chatgpt",
                          taskId: currentTask.taskId,
                        });
                        const afterNavigation = facade.getSnapshot();
                        const activationTask = afterNavigation.tasks.tasks.find(
                          (item) =>
                            item.taskId === currentTask.taskId &&
                            item.sessionId === currentTask.sessionId &&
                            item.turnId === currentTask.turnId,
                        );
                        if (
                          afterNavigation.status !== "current" ||
                          afterNavigation.runtime !== "ready" ||
                          !activationTask?.agent ||
                          activationTask.agent.observation === "unavailable"
                        )
                          return;
                        void facade.task(
                          {
                            kind: "task.activate",
                            taskId: activationTask.taskId,
                          },
                          `activate:${activationTask.taskId}`,
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
            <ActivityNavigation
              snapshot={state}
              facade={facade}
              filter={activityFilter}
              onFilter={setActivityFilter}
            />
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
        onScrollCapture={(event) => {
          if (event.target !== event.currentTarget) return;
          // Save the displayed entry before navigation changes or clamps its DOM.
          scrollPositions.current.set(destination, {
            top: event.currentTarget.scrollTop,
            left: event.currentTarget.scrollLeft,
          });
        }}
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
              <Activity
                snapshot={state}
                facade={facade}
                filter={activityFilter}
                onFilter={setActivityFilter}
                showList={!sideVisible}
                heading={activityHeading}
              />
            </div>
          ) : (
            <ChatBrowser snapshot={state} facade={facade} />
          )}
        </PanelBoundary>
      </main>
      <UpdateNotice snapshot={state} facade={facade} />
      {state.overlay === "search" && (
        <Search snapshot={state} facade={facade} />
      )}{" "}
      {state.overlay === "update" && (
        <Update snapshot={state} facade={facade} />
      )}{" "}
      {state.overlay === "update-recovery" && (
        <Update snapshot={state} facade={facade} recoveryMode />
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
