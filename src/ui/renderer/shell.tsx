import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { shellGeometry } from "../../pkg/shell-layout/geometry";
import { useRenderer } from "./services";
import { PanelBoundary } from "./boundary";
import {
  InstallOnQuitChoice,
  Settings,
  useSettingsAttention,
} from "./settings";
import type { RendererFacade, SettingsPage, WindowSnapshot } from "./contract";
import { computerSetup } from "./computer-setup";
import { TaskEditor } from "./task";
import { Home, HomeNavigation, homeTitle } from "./home";
import { Setup, SetupNavigation } from "./setup";
import { setupSteps } from "./setup-navigation";
import { designIconPath, designIconViewBox } from "./design-icons";
import { UpdateNotice, acknowledgeUpdateNotice } from "./update-notice";
import { updateCheckAllowed } from "./update-eligibility";
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
  ["updates", "Updates"],
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
type ActivityFilter = "all" | "attention";
function activityItems(snapshot: WindowSnapshot, filter: ActivityFilter) {
  return [...snapshot.activity]
    .reverse()
    .filter((event) => filter === "all" || event.phase === "outcome_unknown");
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
            onClick={() =>
              facade.navigate({ area: "chatgpt", taskId: selected.taskId })
            }
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
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
  filter: ActivityFilter;
  onFilter: (filter: ActivityFilter) => void;
  showList: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const previousOverlay = useRef(snapshot.overlay);
  const items = activityItems(snapshot, filter);
  const selected = snapshot.destination.activityId
    ? snapshot.activity.find(
        (event) => event.id === snapshot.destination.activityId,
      )
    : items[0];
  const missing = Boolean(snapshot.destination.activityId && !selected);
  const filtered = selected && !items.some((event) => event.id === selected.id);
  useLayoutEffect(() => {
    const returningFrom = previousOverlay.current;
    previousOverlay.current = snapshot.overlay;
    if (
      snapshot.sidebar !== "overlay" &&
      snapshot.overlay === "none" &&
      (returningFrom === "none" || returningFrom === "activity")
    )
      heading.current?.focus();
  }, [snapshot.destination.activityId, snapshot.sidebar, snapshot.overlay]);
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
      <h1 ref={heading} tabIndex={-1}>
        {selected && !filtered ? selected.label : "Activity"}
      </h1>
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
  available: "A new version of Farol is available",
  ready: "Ready to update Farol",
  failed: "The update did not finish",
  recovery: "Farol update recovery",
  checking: "Checking for Farol updates",
  downloading: "Downloading Farol update",
  applying: "Restarting to update Farol",
  unavailable: "Farol updates unavailable",
  idle: "Farol updates",
};
function Update({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const update = snapshot.update;
  const intent = snapshot.intents.update;
  const preference = update.automaticUpdatePreference;
  const preferenceIntent = snapshot.intents["update-automatic-downloads"];
  const safeAction = useRef<HTMLButtonElement>(null);
  const progressStatus = useRef<HTMLParagraphElement>(null);
  const noticeKey = "notice" in update ? update.notice?.key : undefined;
  useEffect(() => {
    if (noticeKey) acknowledgeUpdateNotice(facade);
  }, [facade, noticeKey]);
  const disabled =
    snapshot.status !== "current" ||
    intent?.state === "pending" ||
    intent?.state === "unknown";
  const recovery =
    update.phase === "recovery" ||
    (update.phase === "failed" && update.recoveryRequired);
  const rollbackVersion =
    update.phase === "idle" ||
    (update.phase === "failed" && !update.recoveryRequired)
      ? update.rollbackVersion
      : undefined;
  const canCheck = updateCheckAllowed(update);
  const release = update.phase === "available" || update.phase === "ready";
  const blockedBy = "blockedBy" in update ? update.blockedBy : undefined;
  const localDismiss = !release || disabled || update.deferred;
  const stateCopy =
    update.phase === "ready"
      ? `Farol ${update.version} is downloaded and ready; it is not installed yet.`
      : update.phase === "available"
        ? `Farol ${update.version} is available; it is not downloaded or installed yet.`
        : update.phase === "failed"
          ? updateResultMessage("failed", update.recoveryRequired)
          : update.phase === "unavailable"
            ? updateResultMessage("unavailable")
            : update.phase === "recovery"
              ? `Recovery required for ${update.version}`
              : update.phase === "applying"
                ? `Applying version ${update.version}…`
                : update.phase === "checking"
                  ? "Checking for updates…"
                  : update.phase === "downloading"
                    ? "Downloading update in the background. Keep working."
                    : update.checkedAt === null
                      ? "No update check yet."
                      : "You can check for updates.";
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
      title={updateSheetTitles[update.phase]}
      onClose={() => facade.overlay("none")}
      dismissible={update.phase !== "applying"}
      className="update-sheet"
      initialFocus={update.phase === "applying" ? progressStatus : safeAction}
      headingIcon={
        update.phase === "failed" ||
        update.phase === "recovery" ||
        update.phase === "unavailable"
          ? "warning"
          : "download"
      }
      headingDescription={
        <>
          <p
            className="update-state"
            role="status"
            ref={progressStatus}
            tabIndex={-1}
          >
            {stateCopy}
          </p>
          <p className="update-installed">
            {snapshot.status === "current" && snapshot.installedVersion
              ? `Installed: Farol ${snapshot.installedVersion.version}${snapshot.installedVersion.buildVersion ? ` (build ${snapshot.installedVersion.buildVersion})` : ""}.`
              : "Installed version cannot be confirmed in this session."}
          </p>
        </>
      }
    >
      {(update.phase === "available" || update.phase === "ready") &&
        update.notes && (
          <details className="update-release">
            <summary>What’s new in Farol {update.version}</summary>
            <p className="update-notes">{update.notes}</p>
          </details>
        )}
      {(update.phase === "failed" || update.phase === "unavailable") && (
        <details className="update-technical-code">
          <summary>Technical code</summary>
          <code>{update.code}</code>
        </details>
      )}
      {(update.phase === "available" || update.phase === "ready") && (
        <div className="update-preference">
          <div className="copy">
            <strong>Automatic downloads</strong>
            <p className="description" role="status">
              {preference?.status === "confirmed"
                ? preference.enabled
                  ? "Future eligible updates download during scheduled checks. Installation requires Restart & Update or separate consent to install on normal Quit."
                  : "Future updates download only when you choose."
                : "Automatic download preference cannot be confirmed in this session."}
            </p>
          </div>
          <button
            type="button"
            disabled={
              disabled ||
              preference?.status !== "confirmed" ||
              preferenceIntent?.state === "pending" ||
              preferenceIntent?.state === "unknown" ||
              snapshot.intents["update-install-on-quit"]?.state === "pending" ||
              (update.phase === "ready" &&
                Boolean(update.blockedBy?.includes("UNKNOWN")))
            }
            onClick={() => {
              const latest = facade.getSnapshot();
              const choice = latest.update.automaticUpdatePreference;
              if (
                latest.status !== "current" ||
                choice?.status !== "confirmed" ||
                latest.intents["update-automatic-downloads"]?.state ===
                  "pending" ||
                latest.intents["update-automatic-downloads"]?.state ===
                  "unknown"
              )
                return;
              void facade.setAutomaticDownloads(!choice.enabled);
            }}
          >
            {preference?.status === "confirmed" && preference.enabled
              ? "Turn off automatic downloads"
              : "Turn on automatic downloads"}
          </button>
          {preferenceIntent?.state === "unknown" && (
            <p role="alert">Preference outcome unknown. Do not retry.</p>
          )}
        </div>
      )}
      {(update.phase === "available" || update.phase === "ready") && (
        <div className="update-preference">
          <div className="copy">
            <InstallOnQuitChoice snapshot={snapshot} facade={facade} />
          </div>
        </div>
      )}
      {recovery ? (
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
      ) : update.phase === "available" ? (
        <p className="description">
          Download the verified package when you choose. This does not restart
          Farol or interrupt current work.
        </p>
      ) : update.phase === "ready" ? (
        <p className="description">
          Restart &amp; Update will quit Farol, install version {update.version}{" "}
          and restart into the new version after a successful update.
        </p>
      ) : null}
      {blockedBy && (
        <div className="update-block" role="alert">
          <strong>
            {recovery
              ? "Recovery is blocked"
              : rollbackVersion
                ? "Roll back is blocked"
                : "Restart is blocked"}
          </strong>
          <p>{updateBlockMessage(blockedBy)}</p>
          <details>
            <summary>Technical code</summary>
            <code>{blockedBy}</code>
          </details>
        </div>
      )}
      <div className="update-check">
        <button
          disabled={disabled || !canCheck}
          onClick={() => {
            const latest = facade.getSnapshot();
            if (
              latest.status !== "current" ||
              latest.intents.update?.state === "pending" ||
              latest.intents.update?.state === "unknown" ||
              !updateCheckAllowed(latest.update)
            )
              return;
            void facade.update("check");
          }}
        >
          Check for Updates
        </button>
      </div>
      <div
        className={`update-actions${update.phase === "available" ? "" : " two"}`}
      >
        {localDismiss && update.phase !== "applying" && (
          <button ref={safeAction} onClick={() => facade.overlay("none")}>
            {update.phase === "idle"
              ? "Done"
              : recovery || rollbackVersion
                ? "Cancel"
                : update.phase === "failed" || update.phase === "unavailable"
                  ? "Dismiss"
                  : "Continue working"}
          </button>
        )}
        {update.phase === "available" && (
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
        {update.phase === "ready" && (
          <>
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
      <p className="update-policy-strip">
        Automatic installation and interruption are unavailable. Review current
        work before restarting or restoring the previous version.
      </p>
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
  const pageKey =
    destination.area === "settings" || destination.area === "setup"
      ? `${destination.area}:${destination.page}:${destination.setupStep ?? ""}`
      : destination.area === "home"
        ? `home:${destination.homeView ?? "overview"}:${destination.homeSelection?.id ?? ""}`
        : destination.area === "activity"
          ? `activity:${destination.activityId ?? ""}`
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
