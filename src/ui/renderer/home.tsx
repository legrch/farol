import { useState } from "react";
import { commandAllowed } from "./command-eligibility";
import { setupChecklist } from "./setup-navigation";
import { useSetupIntents, retainedSetupIntents } from "./settings";
import { unresolvedActions } from "../../../apps/desktop/renderer/unresolved-actions";
import type { RendererFacade, WindowSnapshot } from "./contract";

type Props = { snapshot: WindowSnapshot; facade: RendererFacade };
const stepLabels = {
  signin: "Sign in to ChatGPT",
  folders: "Choose workspaces",
  connection: "Connect this Mac",
  attachment: "Add Farol to ChatGPT and test it",
};
function checkedTime(snapshot: WindowSnapshot) {
  const at =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings.connectors.secureMcp.runtime?.observedAt
      : undefined;
  const date = at ? new Date(at) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "time unavailable";
}
function taskStatus(task: WindowSnapshot["tasks"]["tasks"][number]) {
  if (task.agent?.observation === "unavailable") return "Status unavailable";
  if (task.context?.phase === "outcome_unknown") return "Result unconfirmed";
  if (task.context?.phase === "blocked") return "Needs attention";
  return eventState(task.agent?.phase ?? task.lifecycle);
}
function eventState(phase: string | null) {
  if (phase === "completed") return "Done";
  if (phase === "outcome_unknown") return "Result unconfirmed";
  if (phase === "running") return "Working";
  if (phase === "failed") return "Failed";
  if (phase === "cancelled") return "Interrupted";
  return "Recorded";
}
/** A read-only landing page. Only Check now invokes the existing health check. */
export function Home({ snapshot, facade }: Props) {
  const local = useSetupIntents(facade, snapshot);
  const checklist = setupChecklist(snapshot, false, local);
  const first = checklist.entries.find((entry) => entry.state !== "verified");
  const working = checklist.ready;
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const unresolved = unresolvedActions(snapshot, local);
  const tasks = snapshot.tasks.tasks.filter(
    (task) =>
      task.agent?.observation === "unavailable" ||
      task.context?.phase === "outcome_unknown" ||
      task.context?.phase === "blocked" ||
      ["failed", "cancelled", "outcome_unknown"].includes(
        task.agent?.phase ?? task.lifecycle,
      ),
  );
  const refused = Object.values(snapshot.intents).filter(
    (intent) => intent.state === "refused",
  );
  const recent = [...snapshot.activity].sort((a, b) => b.at - a.at).slice(0, 3);
  const workspaceCount =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings.computer.workspaces.length
      : 0;
  async function checkNow() {
    const latest = facade.getSnapshot();
    if (
      checking ||
      !commandAllowed(
        latest,
        "connector.check-health",
        undefined,
        retainedSetupIntents(facade, latest),
      ) ||
      latest.update.phase === "applying"
    )
      return;
    setChecking(true);
    try {
      const result = await facade.configure(
        { kind: "connector.check-health" },
        "settings:connector.check-health:",
      );
      setCheckResult(
        result.state === "applied"
          ? "Connection check finished."
          : result.state === "unknown"
            ? "The check has no confirmed result. Review Unresolved actions."
            : "The check could not finish. Review Setup.",
      );
    } finally {
      setChecking(false);
    }
  }
  return (
    <div className="home-candidate" data-home-view="overview">
      <h1>Home</h1>
      {!working && !checking ? (
        <section className="home-setup-card" aria-labelledby="home-setup-title">
          <h2 id="home-setup-title">Finish setup</h2>
          <p>Complete these four steps to connect ChatGPT to this Mac.</p>
          <ol className="home-setup-steps">
            {checklist.entries.map((entry, index) => (
              <li
                key={entry.step}
                data-state={
                  entry.state === "verified"
                    ? "done"
                    : entry === first
                      ? "current"
                      : "pending"
                }
                aria-current={entry === first ? "step" : undefined}
              >
                <span className="home-step-number" aria-hidden="true">
                  {entry.state === "verified" ? "✓" : index + 1}
                </span>
                <span>
                  {stepLabels[entry.step]}
                  <small>
                    {entry.state === "verified"
                      ? "Done"
                      : entry === first
                        ? entry.state === "pending"
                          ? "In progress"
                          : entry.state === "unknown"
                            ? "Result unconfirmed"
                            : "Next step"
                        : "Pending"}
                  </small>
                </span>
              </li>
            ))}
          </ol>
          <button
            className="primary"
            onClick={() =>
              facade.navigate({
                area: "setup",
                setupStep: first?.step ?? "connection",
              })
            }
          >
            Continue setup
          </button>
        </section>
      ) : (
        <>
          <section className="home-status-card" aria-label="Connection status">
            <span className="home-working-mark" aria-hidden="true">
              {checking ? "…" : "✓"}
            </span>
            <div>
              <h2>{checking ? "Checking connection…" : "Farol is working"}</h2>
              <p>
                {checking ? (
                  "Waiting for the current connection check."
                ) : (
                  <>
                    ChatGPT can reach this Mac · {workspaceCount}{" "}
                    {workspaceCount === 1 ? "workspace" : "workspaces"} ·
                    checked {checkedTime(snapshot)}
                  </>
                )}
              </p>
            </div>
            <button
              disabled={
                checking ||
                snapshot.update.phase === "applying" ||
                !commandAllowed(
                  snapshot,
                  "connector.check-health",
                  undefined,
                  local,
                )
              }
              onClick={() => void checkNow()}
            >
              {checking ? "Checking…" : "Check now"}
            </button>
          </section>
          {(unresolved.length > 0 ||
            tasks.length > 0 ||
            refused.length > 0) && (
            <section
              className="home-attention"
              aria-labelledby="home-attention-title"
            >
              <h2 id="home-attention-title">Needs attention</h2>
              {unresolved.map((item) => (
                <button
                  className="home-row"
                  key={item.id}
                  onClick={() => facade.overlay("unresolved-actions")}
                >
                  <span className="home-row-label">
                    An action needs review
                    <small>
                      {item.state === "unknown"
                        ? "Its result is unconfirmed"
                        : "Waiting for its result"}
                    </small>
                  </span>
                  <span className="home-link">Review</span>
                </button>
              ))}
              {tasks.map((task) => (
                <button
                  className="home-row"
                  key={`${task.taskId}:${task.turnId}`}
                  onClick={() => {
                    const latest = facade.getSnapshot();
                    const match = latest.tasks.tasks.find(
                      (item) =>
                        item.taskId === task.taskId &&
                        item.turnId === task.turnId,
                    );
                    if (
                      latest.status === "current" &&
                      latest.runtime === "ready" &&
                      match &&
                      match.agent?.observation !== "unavailable"
                    )
                      facade.navigate({
                        area: "chatgpt",
                        taskId: match.taskId,
                      });
                    else facade.navigate({ area: "activity" });
                  }}
                >
                  <span className="home-row-label">
                    {task.label}
                    <small>{taskStatus(task)}</small>
                  </span>
                  <span className="home-link">Review</span>
                </button>
              ))}
              {refused.map((intent) => (
                <button
                  className="home-row"
                  key={intent.id}
                  onClick={() => facade.navigate({ area: "setup" })}
                >
                  <span className="home-row-label">
                    An action could not finish
                    <small>Review setup before trying again</small>
                  </span>
                  <span className="home-link">Review</span>
                </button>
              ))}
            </section>
          )}
          <section className="home-recent" aria-labelledby="home-recent-title">
            <div className="home-section-title">
              <h2 id="home-recent-title">Recent activity</h2>
              <button onClick={() => facade.navigate({ area: "activity" })}>
                Show all
              </button>
            </div>
            {recent.map((event) => (
              <button
                className="home-row"
                key={event.id}
                onClick={() =>
                  facade.navigate({ area: "activity", activityId: event.id })
                }
              >
                <time>
                  {Number.isFinite(event.at) && Math.abs(event.at) <= 8.64e15
                    ? new Date(event.at).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "Time unavailable"}
                </time>
                <span className="home-row-label">{event.label}</span>
                <span className="home-event-state">
                  {eventState(event.phase)}
                </span>
              </button>
            ))}
            {!recent.length && (
              <p className="description">
                Activity will appear here as you use Farol.
              </p>
            )}
          </section>
        </>
      )}
      {checkResult && (
        <p role="status" className="home-check-result">
          {checkResult}
        </p>
      )}
    </div>
  );
}
