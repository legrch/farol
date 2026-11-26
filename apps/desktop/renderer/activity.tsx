import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type {
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import { Icon } from "./icon";
import { OperationsActivity } from "./operations-view";

export type ActivityFilter = "all" | "attention";
export function activityItems(
  snapshot: WindowSnapshot,
  filter: ActivityFilter,
) {
  return [...snapshot.activity]
    .reverse()
    .filter((event) => filter === "all" || event.phase === "outcome_unknown");
}
export function activitySelection(
  snapshot: WindowSnapshot,
  filter: ActivityFilter,
) {
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
export function activityTitle(
  snapshot: WindowSnapshot,
  filter: ActivityFilter,
) {
  if (snapshot.activityDiagnostics !== undefined) return "Activity";
  const { selected, filtered } = activitySelection(snapshot, filter);
  return selected && !filtered ? selected.label : "Activity";
}
export function activityPhase(event: WindowSnapshot["activity"][number]) {
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
        Recorded metadata only. App operations remain available across restarts.
      </p>
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
export function Activity({
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
  if (
    snapshot.activityDiagnostics !== undefined ||
    snapshot.activity.some((row) => row.source)
  )
    return <OperationsActivity snapshot={snapshot} facade={facade} />;
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
    </>
  );
}
