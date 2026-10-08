import type { ReactNode } from "react";
import type { ProductTask } from "../../modules/chat/contract/product-task";
import { folderAccessChecked, folderDisplayName } from "../folder-access-state";
import { computerSetup } from "./computer-setup";
import { designIconPath, designIconViewBox } from "./design-icons";
import type {
  ActivityEntry,
  Destination,
  HomeView,
  RendererFacade,
  WindowSnapshot,
} from "./contract";

type Props = { snapshot: WindowSnapshot; facade: RendererFacade };
type Selection = NonNullable<Destination["homeSelection"]>;
const views: readonly [HomeView, string, string][] = [
  ["overview", "Overview", "home"],
  ["work", "Current work", "chat"],
  ["attention", "Needs attention", "attention"],
  ["activity", "Recent activity", "activity"],
  ["access", "Connection & access", "connection"],
];
type Issue = {
  id: string;
  title: string;
  state: string;
  copy: string;
  target: "access" | "folders" | "work" | "diagnostics";
  task?: ProductTask;
  details?: [string, ReactNode][];
};

function Glyph({ name }: { name: string }) {
  return (
    <svg viewBox={designIconViewBox} aria-hidden="true">
      <path d={designIconPath(name)} />
    </svg>
  );
}
function current(snapshot: WindowSnapshot) {
  return snapshot.status === "current" && snapshot.runtime === "ready";
}
function taskState(task: ProductTask) {
  if (task.agent?.observation === "unavailable")
    return "Observation unavailable";
  if (task.context?.phase === "outcome_unknown") return "Outcome unknown";
  if (task.context?.phase === "blocked") return "Needs attention";
  const phase = task.agent?.phase ?? task.lifecycle;
  return {
    running: "Working",
    completed: "Done",
    cancelled: "Interrupted",
    failed: "Failed",
    outcome_unknown: "Outcome unknown",
    idle: "Idle",
    event_driven: "Waiting for work",
  }[phase];
}
function eventState(event: ActivityEntry) {
  if (event.phase) return event.phase.replaceAll("_", " ");
  if (event.code) return "Recorded issue";
  return "Result not recorded";
}
function timestamp(at: number) {
  return Number.isFinite(at) && Math.abs(at) <= 8.64e15
    ? new Date(at).toISOString()
    : "Time unavailable";
}
function projection(snapshot: WindowSnapshot) {
  const setup = computerSetup(snapshot);
  const settings =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings
      : null;
  const folders =
    settings?.computer.workspaces.map((folder) => ({
      folder,
      name: folderDisplayName(folder),
      state: !current(snapshot)
        ? "Evidence unavailable"
        : settings.setup.computer.outcomeUnknown
          ? "Outcome unknown"
          : folderAccessChecked(settings, folder, snapshot.buildId ?? "")
            ? "Verified"
            : folder.accessCheck ||
                settings.setup.computer.verified?.workspaceId ===
                  folder.workspaceId
              ? "Check needed"
              : "Not checked",
    })) ?? [];
  const work = snapshot.tasks.tasks;
  const running = current(snapshot)
    ? work.filter((task) => taskState(task) === "Working")
    : [];
  const recent = [...snapshot.activity].sort((a, b) => b.at - a.at).slice(0, 3);
  const issues: Issue[] = [];
  if (!current(snapshot))
    issues.push({
      id: "snapshot",
      title: "Current evidence is unavailable",
      state: snapshot.status === "current" ? snapshot.runtime : snapshot.status,
      copy: "Retained records may be out of date. They do not confirm the current task or connection state.",
      target: "access",
    });
  if (!settings)
    issues.push({
      id: "configuration",
      title: "Setup evidence is unavailable",
      state: "Unavailable",
      copy: "Workspace and connection evidence could not be read. No approved-workspace count or verified state can be confirmed.",
      target: "access",
    });
  else {
    if (
      setup.embeddedChatGPT === "Outcome unknown" ||
      settings.setup.chatgpt.unavailable ||
      settings.setup.chatgpt.reachable === "unreachable"
    )
      issues.push({
        id: "embedded-chatgpt",
        title: "Embedded ChatGPT sign-in is not confirmed",
        state: setup.embeddedChatGPT,
        copy: "Embedded sign-in is optional and independent of Computer access. Review its available evidence before using an embedded conversation.",
        target: "access",
      });
    if (!setup.ready)
      issues.push({
        id: "connection",
        title: "Review connection evidence",
        state: setup.label,
        copy: setup.next,
        target: "access",
      });
    for (const item of folders.filter((item) => item.state !== "Verified"))
      issues.push({
        id: `folder:${item.folder.workspaceId}`,
        title: `${item.name} needs an access check`,
        state: item.state,
        copy: `Configured access: ${item.folder.access === "write" ? "Read and write" : "Read only"}. Adding a workspace and verifying its access are separate steps.`,
        target: "folders",
      });
    const editIds = new Set(
      [
        settings.computer.pendingEdit?.operationId,
        snapshot.workspaceEditDelivery,
      ].filter((id): id is string => Boolean(id)),
    );
    for (const operationId of editIds)
      issues.push({
        id: `folder-edit:${operationId}`,
        title: "A workspace edit needs review",
        state: "Pending review",
        copy: "Inspect the existing operation and its delivery state in Diagnostics before preparing another edit.",
        target: "diagnostics",
        details: [["Operation", operationId]],
      });
  }
  for (const task of work.filter((task) =>
    [
      "Outcome unknown",
      "Observation unavailable",
      "Interrupted",
      "Failed",
      "Needs attention",
    ].includes(taskState(task)),
  ))
    issues.push({
      id: `task:${task.taskId}:${task.turnId}`,
      title: task.label,
      state: taskState(task),
      copy: "The current record does not confirm successful completion. Inspect the same task before choosing another action.",
      target: "work",
      task,
    });
  for (const intent of Object.values(snapshot.intents).filter(
    (intent) => intent.state === "unknown" || intent.state === "refused",
  ))
    issues.push({
      id: `intent:${intent.id}`,
      title: "An action needs review",
      state: intent.state === "unknown" ? "Outcome unknown" : "Refused",
      copy:
        intent.state === "unknown"
          ? "The action has no confirmed result. Opening this item does not repeat it."
          : "The action was refused. Opening this item does not retry it.",
      target: "diagnostics",
      details: [
        ["Action", intent.id],
        ["Recorded code", intent.code ?? "Not recorded"],
      ],
    });
  const connection = !current(snapshot)
    ? "Evidence unavailable"
    : !settings
      ? "Evidence unavailable"
      : setup.label;
  return {
    settings,
    setup,
    folders,
    work,
    running,
    recent,
    issues,
    connection,
  };
}
function go(
  facade: RendererFacade,
  homeView: HomeView,
  homeSelection?: Selection,
) {
  facade.navigate({
    area: "home",
    homeView,
    homeSelection: homeSelection ?? null,
  });
}
function matchingTask(snapshot: WindowSnapshot, id: string, turnId?: string) {
  return turnId === undefined
    ? undefined
    : snapshot.tasks.tasks.find(
        (task) => task.taskId === id && task.turnId === turnId,
      );
}
function openChat(facade: RendererFacade, id: string, turnId: string) {
  const latest = facade.getSnapshot();
  const task = matchingTask(latest, id, turnId);
  if (current(latest) && task && task.agent?.observation !== "unavailable")
    facade.navigate({ area: "chatgpt", taskId: task.taskId });
}
export function homeTitle(snapshot: WindowSnapshot) {
  const selection = snapshot.destination.homeSelection;
  const data = projection(snapshot);
  if (selection?.kind === "task")
    return (
      matchingTask(snapshot, selection.id, selection.turnId)?.label ??
      "Work details"
    );
  if (selection?.kind === "activity")
    return (
      snapshot.activity.find(
        (event) =>
          event.id === selection.id &&
          (selection.turnId === undefined || event.turnId === selection.turnId),
      )?.label ?? "Event details"
    );
  if (selection?.kind === "attention")
    return (
      data.issues.find((issue) => issue.id === selection.id)?.title ??
      "Attention details"
    );
  return (
    views.find(
      ([id]) => id === (snapshot.destination.homeView ?? "overview"),
    )?.[1] ?? "Overview"
  );
}
export function HomeNavigation({ snapshot, facade }: Props) {
  const data = projection(snapshot);
  return (
    <div className="home-candidate-navigation">
      <p>Work, events and readiness.</p>
      <nav aria-label="Home views">
        {views.map(([id, label, icon]) => (
          <button
            type="button"
            key={id}
            aria-current={
              (snapshot.destination.homeView ?? "overview") === id
                ? "page"
                : undefined
            }
            onClick={() => go(facade, id)}
          >
            <Glyph name={icon} />
            <span className="home-candidate-label">{label}</span>
            {id === "work" && data.running.length > 0 ? (
              <span
                className="home-candidate-count"
                aria-label={`${data.running.length} working`}
              >
                {data.running.length}
              </span>
            ) : id === "attention" && data.issues.length > 0 ? (
              <span
                className="home-candidate-count"
                aria-label={`${data.issues.length} items need attention`}
              >
                {data.issues.length}
              </span>
            ) : null}
          </button>
        ))}
      </nav>
      <button
        type="button"
        className="home-candidate-connection-link"
        onClick={() => go(facade, "access")}
      >
        <span
          className={`home-candidate-connection-symbol${current(snapshot) && data.setup.ready ? " is-ready" : ""}`}
        >
          <Glyph
            name={
              current(snapshot) && data.setup.ready ? "check" : "connection"
            }
          />
        </span>
        <span className="home-candidate-label">
          <strong>{data.connection}</strong>
          <small>View connection &amp; access</small>
        </span>
        <Glyph name="forward" />
      </button>
    </div>
  );
}
function Empty({
  title,
  children,
  icon = "home",
}: {
  title: string;
  children: ReactNode;
  icon?: string;
}) {
  return (
    <div className="home-candidate-empty">
      <Glyph name={icon} />
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
function Badge({ children }: { children: ReactNode }) {
  return <span className="home-candidate-badge">{children}</span>;
}
function Facts({ rows }: { rows: readonly [string, ReactNode][] }) {
  return (
    <dl className="home-candidate-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
function TaskRow({
  task,
  number,
  facade,
}: {
  task: ProductTask;
  number: number;
  facade: RendererFacade;
}) {
  return (
    <button
      type="button"
      className="home-candidate-record"
      onClick={() =>
        go(facade, "work", {
          kind: "task",
          id: task.taskId,
          turnId: task.turnId,
        })
      }
    >
      <span className="home-candidate-number">{number}</span>
      <span className="home-candidate-label">
        <strong>{task.label}</strong>
        <small>Window {number}</small>
      </span>
      <Badge>{taskState(task)}</Badge>
      <Glyph name="forward" />
    </button>
  );
}
function EventRow({
  event,
  facade,
}: {
  event: ActivityEntry;
  facade: RendererFacade;
}) {
  return (
    <button
      type="button"
      className="home-candidate-record"
      onClick={() =>
        go(facade, "activity", {
          kind: "activity",
          id: event.id,
          turnId: event.turnId,
        })
      }
    >
      <Glyph name="activity" />
      <span className="home-candidate-label">
        <strong>{event.label}</strong>
        <small>
          {eventState(event)} · {timestamp(event.at)}
        </small>
      </span>
      <Glyph name="forward" />
    </button>
  );
}
function IssueRow({ issue, facade }: { issue: Issue; facade: RendererFacade }) {
  return (
    <button
      type="button"
      className="home-candidate-record home-candidate-issue"
      onClick={() =>
        go(facade, "attention", { kind: "attention", id: issue.id })
      }
    >
      <Glyph
        name={
          issue.task
            ? "chat"
            : issue.target === "folders"
              ? "folders"
              : issue.target === "access"
                ? "connection"
                : "attention"
        }
      />
      <span className="home-candidate-label">
        <strong>{issue.title}</strong>
        <small>
          {issue.state} · {issue.copy}
        </small>
      </span>
      <Glyph name="forward" />
    </button>
  );
}
function ChatLink({
  snapshot,
  facade,
  id,
  turnId,
}: Props & { id: string; turnId: string }) {
  const task = matchingTask(snapshot, id, turnId);
  const available =
    current(snapshot) && task && task.agent?.observation !== "unavailable";
  return (
    <div className="home-candidate-actions">
      <button
        type="button"
        className="home-candidate-primary"
        disabled={!available}
        onClick={() => openChat(facade, id, turnId)}
      >
        <Glyph name="chat" /> Open ChatGPT <Glyph name="forward" />
      </button>
      <span>
        {available
          ? "Opens the matching ChatGPT window"
          : "The matching conversation is unavailable in current evidence"}
      </span>
    </div>
  );
}
function Inspector({ snapshot, facade }: Props) {
  const selection = snapshot.destination.homeSelection!;
  const data = projection(snapshot);
  const view =
    selection.kind === "task"
      ? "work"
      : selection.kind === "activity"
        ? "activity"
        : "attention";
  const back = (
    <button
      type="button"
      className="home-candidate-back"
      onClick={() => go(facade, view)}
    >
      <Glyph name="back" />
      {views.find(([id]) => id === view)?.[1]}
    </button>
  );
  let body: ReactNode;
  if (selection.kind === "task") {
    const task = matchingTask(snapshot, selection.id, selection.turnId);
    body = task ? (
      <section className="home-candidate-detail">
        <div className="home-candidate-detail-heading">
          <span className="home-candidate-number">
            {data.work.indexOf(task) + 1}
          </span>
          <div>
            <p className="home-candidate-caption">Current window</p>
            <h2>{task.label}</h2>
          </div>
          <Badge>{taskState(task)}</Badge>
        </div>
        <p className="home-candidate-copy">
          This view shows task metadata. The conversation stays in its existing
          ChatGPT window. Task completion does not verify workspace access.
        </p>
        <Facts
          rows={[
            ["Window", data.work.indexOf(task) + 1],
            ["State", taskState(task)],
            ["Task", task.taskId],
            ["Turn", task.turnId],
            [
              "Observation",
              task.agent?.observation ?? "No separate observation recorded",
            ],
          ]}
        />
        <ChatLink
          snapshot={snapshot}
          facade={facade}
          id={task.taskId}
          turnId={task.turnId}
        />
      </section>
    ) : (
      <Empty icon="chat" title="This window has moved on">
        The selected task and turn are no longer in a current window. Home will
        not open a different conversation in their place.
      </Empty>
    );
  } else if (selection.kind === "activity") {
    const event = snapshot.activity.find(
      (event) =>
        event.id === selection.id &&
        (selection.turnId === undefined || event.turnId === selection.turnId),
    );
    body = event ? (
      <section className="home-candidate-detail">
        <div className="home-candidate-detail-heading">
          <span className="home-candidate-mark">
            <Glyph name="activity" />
          </span>
          <div>
            <p className="home-candidate-caption">Recorded event</p>
            <h2>{event.label}</h2>
          </div>
        </div>
        <Facts
          rows={[
            ["Recorded at", timestamp(event.at)],
            ["Result", eventState(event)],
            ["Operation", event.operation ?? "No operation recorded"],
            ["Task", event.taskId],
            ["Turn", event.turnId],
          ]}
        />
        <p className="home-candidate-copy">
          Recorded metadata does not establish the current conversation state.
          An old event cannot open a reused window.
        </p>
        <ChatLink
          snapshot={snapshot}
          facade={facade}
          id={event.taskId}
          turnId={event.turnId}
        />
        <div className="home-candidate-actions">
          <button
            type="button"
            onClick={() => {
              facade.navigate({ area: "activity", activityId: event.id });
              facade.overlay("activity");
            }}
          >
            Open in Activity <Glyph name="forward" />
          </button>
          <span>Opens this record in Activity</span>
        </div>
      </section>
    ) : (
      <Empty icon="activity" title="This event is no longer available">
        The retained record is missing. Return to Recent activity to inspect
        available evidence.
      </Empty>
    );
  } else {
    const issue = data.issues.find((issue) => issue.id === selection.id);
    body = issue ? (
      <section className="home-candidate-detail">
        <h2>{issue.title}</h2>
        <Badge>{issue.state}</Badge>
        <p className="home-candidate-copy">{issue.copy}</p>
        {issue.details && <Facts rows={issue.details} />}
        <div className="home-candidate-actions">
          {issue.target === "folders" ? (
            <button
              type="button"
              onClick={() =>
                facade.navigate({ area: "settings", page: "folders" })
              }
            >
              Manage workspaces <Glyph name="forward" />
            </button>
          ) : issue.target === "work" && issue.task ? (
            <button
              type="button"
              onClick={() =>
                go(facade, "work", {
                  kind: "task",
                  id: issue.task!.taskId,
                  turnId: issue.task!.turnId,
                })
              }
            >
              Inspect current work
            </button>
          ) : issue.target === "diagnostics" ? (
            <button
              type="button"
              onClick={() =>
                facade.navigate({ area: "settings", page: "diagnostics" })
              }
            >
              Inspect action details <Glyph name="forward" />
            </button>
          ) : (
            <button type="button" onClick={() => go(facade, "access")}>
              Review connection &amp; access
            </button>
          )}
        </div>
      </section>
    ) : (
      <Empty title="This item is no longer present">
        The current projection has changed. Review the remaining items in Needs
        attention.
      </Empty>
    );
  }
  return (
    <>
      {back}
      {body}
    </>
  );
}
function Access({ snapshot, facade }: Props) {
  const data = projection(snapshot);
  return (
    <>
      <p className="home-candidate-intro">
        View connection and access evidence here. Changes and new checks belong
        to Setup and Settings.
      </p>
      <section className="home-candidate-readiness">
        <h2>{data.connection}</h2>
        <p className="home-candidate-copy">
          {!data.settings
            ? "Workspace and connection evidence could not be read."
            : data.folders.length
              ? data.setup.next
              : "No workspaces added. Computer access requires an approved, verified workspace."}
        </p>
        <Facts
          rows={[
            [
              "Embedded ChatGPT",
              current(snapshot) && data.settings
                ? data.setup.embeddedChatGPT
                : "Evidence unavailable",
            ],
            [
              "Computer connection",
              current(snapshot) && data.settings
                ? data.setup.label
                : "Evidence unavailable",
            ],
            [
              "Local service",
              snapshot.runtime === "ready"
                ? "Available; separate from the ChatGPT connection"
                : snapshot.runtime,
            ],
            [
              "Workspace access",
              !data.settings
                ? "Evidence unavailable"
                : data.folders.length
                  ? `${data.folders.length} shared · ${data.folders.filter((item) => item.state === "Verified").length} verified`
                  : "No workspaces added",
            ],
          ]}
        />
        {data.folders.map((item) => (
          <div className="home-candidate-folder" key={item.folder.workspaceId}>
            <span>
              <strong>{item.name}</strong>
              <small>
                {item.folder.root} ·{" "}
                {item.folder.access === "write"
                  ? "Read and write"
                  : "Read only"}
              </small>
            </span>
            <Badge>{item.state}</Badge>
          </div>
        ))}
      </section>
      <div className="home-candidate-actions">
        <button
          type="button"
          onClick={() =>
            facade.navigate({ area: "settings", page: "connection" })
          }
        >
          Manage connection <Glyph name="forward" />
        </button>
        <button
          type="button"
          onClick={() => facade.navigate({ area: "settings", page: "folders" })}
        >
          Manage workspaces <Glyph name="forward" />
        </button>
        <button
          type="button"
          onClick={() => facade.navigate({ area: "setup" })}
        >
          Open Setup <Glyph name="forward" />
        </button>
      </div>
    </>
  );
}
function Overview({ snapshot, facade }: Props) {
  const data = projection(snapshot);
  const focus = data.running.length
    ? data.running
    : data.work.filter((task) => taskState(task) !== "Done");
  if (data.work.length === 0 && data.recent.length === 0)
    return (
      <>
        <p className="home-candidate-intro">
          A starting point for your ChatGPT work on this Mac.
        </p>
        <Empty title="Your workspace starts here">
          Work and recent records will appear here as they become available.
          Connection and workspace checks stay independent.
        </Empty>
        <div className="home-candidate-actions">
          <button
            type="button"
            onClick={() => facade.navigate({ area: "setup" })}
          >
            {data.setup.ready ? "Review setup" : "Continue setup"}
          </button>
          <button type="button" onClick={() => go(facade, "access")}>
            Review setup status
          </button>
        </div>
        {data.issues.length > 0 && (
          <section className="home-candidate-section">
            <h2>Worth a look</h2>
            <IssueRow issue={data.issues[0]!} facade={facade} />
          </section>
        )}
      </>
    );
  return (
    <>
      <p className="home-candidate-intro">
        Check what is happening, then inspect anything here without leaving
        Home.
      </p>
      <div className="home-candidate-overview-heading">
        <span className="home-candidate-mark">
          <Glyph
            name={
              data.running.length
                ? "activity"
                : data.issues.length
                  ? "attention"
                  : "check"
            }
          />
        </span>
        <div>
          <h2>
            {!current(snapshot)
              ? "Current state needs review"
              : data.running.length
                ? "Work is moving"
                : data.issues.length
                  ? "A few things to review"
                  : "Ready when you are"}
          </h2>
          <p>
            {current(snapshot)
              ? `${data.running.length} windows working.`
              : "Current work cannot be confirmed."}{" "}
            {data.issues.length} items to review.
          </p>
        </div>
      </div>
      <div className="home-candidate-summaries">
        <button type="button" onClick={() => go(facade, "work")}>
          <span>Current work</span>
          <strong>
            {current(snapshot)
              ? data.running.length
                ? `${data.running.length} working`
                : "All quiet"
              : "Not confirmed"}
          </strong>
          <small>
            {data.work.filter((task) => taskState(task) === "Done").length}{" "}
            completed window records retained
          </small>
        </button>
        <button type="button" onClick={() => go(facade, "attention")}>
          <span>Needs attention</span>
          <strong>
            {data.issues.length
              ? `${data.issues.length} to review`
              : "All clear"}
          </strong>
          <small>Review the available evidence</small>
        </button>
        <button type="button" onClick={() => go(facade, "access")}>
          <span>Connection</span>
          <strong>{data.connection}</strong>
          <small>Workspace access is checked separately</small>
        </button>
      </div>
      <div className="home-candidate-columns">
        <section className="home-candidate-section">
          <div className="home-candidate-section-title">
            <h2>{data.running.length ? "In progress" : "Current work"}</h2>
            <button type="button" onClick={() => go(facade, "work")}>
              View work <Glyph name="forward" />
            </button>
          </div>
          {focus.length ? (
            focus.map((task) => (
              <TaskRow
                key={`${task.taskId}:${task.turnId}`}
                task={task}
                number={data.work.indexOf(task) + 1}
                facade={facade}
              />
            ))
          ) : (
            <p className="home-candidate-copy">
              Completed windows remain available in Current work.
            </p>
          )}
          {data.recent[0] && (
            <section className="home-candidate-latest">
              <div className="home-candidate-section-title">
                <h2>Latest event</h2>
                <button type="button" onClick={() => go(facade, "activity")}>
                  View recent <Glyph name="forward" />
                </button>
              </div>
              <EventRow event={data.recent[0]} facade={facade} />
            </section>
          )}
        </section>
        <section className="home-candidate-section">
          <div className="home-candidate-section-title">
            <h2>Worth a look</h2>
            <span>
              {data.issues.length ? "Available evidence" : "All clear"}
            </span>
          </div>
          {data.issues[0] ? (
            <IssueRow issue={data.issues[0]} facade={facade} />
          ) : (
            <p className="home-candidate-copy">
              No unresolved items in the available evidence.
            </p>
          )}
          {data.issues.length > 1 && (
            <button
              type="button"
              className="home-candidate-link"
              onClick={() => go(facade, "attention")}
            >
              Review all {data.issues.length} items
            </button>
          )}
          <p className="home-candidate-section-note">
            Select a row to inspect it inside Home.
          </p>
        </section>
      </div>
    </>
  );
}
export function Home({ snapshot, facade }: Props) {
  const view = snapshot.destination.homeView ?? "overview";
  const data = projection(snapshot);
  return (
    <div className="home-candidate" data-home-view={view}>
      {!current(snapshot) && (
        <p className="home-candidate-evidence" role="status">
          Current evidence unavailable ·{" "}
          {snapshot.status === "current" ? snapshot.runtime : snapshot.status}.
          Retained records may be out of date.
        </p>
      )}
      {snapshot.destination.homeSelection ? (
        <Inspector snapshot={snapshot} facade={facade} />
      ) : view === "access" ? (
        <Access snapshot={snapshot} facade={facade} />
      ) : view === "work" ? (
        <>
          <p className="home-candidate-intro">
            A short view of occupied windows. Select a task to inspect its state
            here.
          </p>
          {data.work.length ? (
            <section className="home-candidate-section">
              <div className="home-candidate-section-title">
                <h2>Occupied windows</h2>
                <span>{data.work.length} of 5</span>
              </div>
              {data.work.map((task, index) => (
                <TaskRow
                  key={`${task.taskId}:${task.turnId}`}
                  task={task}
                  number={index + 1}
                  facade={facade}
                />
              ))}
              <p className="home-candidate-copy">
                {current(snapshot)
                  ? `${5 - data.work.length} windows are available for other work.`
                  : "Window availability cannot be confirmed from retained records."}
              </p>
            </section>
          ) : (
            <Empty
              icon="chat"
              title={
                current(snapshot)
                  ? "No current work"
                  : "Current work is unavailable"
              }
            >
              Tasks will appear here when current records become available.
            </Empty>
          )}
        </>
      ) : view === "attention" ? (
        <>
          <p className="home-candidate-intro">
            Review unresolved items here. Opening an item does not change
            settings or run a check.
          </p>
          {data.issues.length ? (
            <section className="home-candidate-section">
              <h2>To review</h2>
              {data.issues.map((issue) => (
                <IssueRow key={issue.id} issue={issue} facade={facade} />
              ))}
            </section>
          ) : (
            <Empty icon="check" title="All clear">
              There are no unresolved items in the available evidence.
            </Empty>
          )}
        </>
      ) : view === "activity" ? (
        <>
          <p className="home-candidate-intro">
            The three latest recorded events. Select one to inspect its metadata
            here.
          </p>
          {data.recent.length ? (
            <section className="home-candidate-section">
              <h2>Recent events</h2>
              {data.recent.map((event) => (
                <EventRow key={event.id} event={event} facade={facade} />
              ))}
            </section>
          ) : (
            <Empty icon="activity" title="No recent events">
              Recorded events will appear here as work happens.
            </Empty>
          )}
          <div className="home-candidate-actions">
            <button
              type="button"
              onClick={() => facade.navigate({ area: "activity" })}
            >
              Open full Activity <Glyph name="forward" />
            </button>
            <span>Opens the Activity section</span>
          </div>
        </>
      ) : (
        <Overview snapshot={snapshot} facade={facade} />
      )}
    </div>
  );
}
