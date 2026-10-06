import { useState } from "react";
import type { Intent, RendererFacade, WindowSnapshot } from "./contract";
import type { ProductTaskCommand } from "../../modules/chat/contract/product-task";
import { EMPTY_AGENT_DRAFT } from "../agent-draft";
import {
  agentAuthorityUnchanged,
  AGENT_AUTHORITY_CHANGED,
} from "../shell-action-policy";
import type { AgentAuthority } from "../shell-action-policy";
import { ProductAgentScopeSelectionSchema } from "../../modules/chat/contract/product-task";
export function taskActionFeedback(label: string, result: Intent) {
  if (result.state === "pending") return `${label}: In progress…`;
  if (result.state === "unknown")
    return `${label}: Outcome unknown. The action may have taken effect. Review the retained result in Diagnostics before continuing.`;
  if (result.state === "refused")
    return result.code === "TASK_OPERATION_IN_PROGRESS"
      ? `${label}: Another action is still in progress. Wait for its result.`
      : `${label}: Could not be completed. See Diagnostics for details.`;
  return `${label}: Confirmed.`;
}
export function TaskEditor({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const task = snapshot.tasks.tasks.find(
    (item) => item.taskId === snapshot.destination.taskId,
  );
  const settings =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings
      : null;
  const [workspaceId, setWorkspaceId] = useState(
    settings?.computer.workspaces[0]?.workspaceId ?? "",
  );
  const [fields, setFields] = useState(
    () =>
      facade.draft.restore(snapshot.destination.taskId) ?? EMPTY_AGENT_DRAFT,
  );
  const [label, setLabel] = useState(task?.label ?? "");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [returned, setReturned] = useState<
    Record<string, { result: Intent; retained: Intent | undefined }>
  >({});
  const taskId = snapshot.destination.taskId;
  const actionLabels = [
    ["rename", "Rename"],
    ["pin", "Pin"],
    ["cancel", "Cancel work"],
    ["close", "Close chat"],
    ["agent", "Agent assignment"],
    ["rejoin", "Observe Agent"],
  ] as const;
  const resultFor = (id: string) => {
    const current = snapshot.intents[id];
    const local = returned[id];
    return local && local.retained === current ? local.result : current;
  };
  const disabled = (action: string) => {
    const result = resultFor(`${action}:${taskId}`);
    return (
      snapshot.status !== "current" ||
      result?.state === "pending" ||
      result?.state === "unknown"
    );
  };
  const run = (command: ProductTaskCommand, action: string) => {
    const id = `${action}:${taskId}`;
    const latest = facade.getSnapshot();
    if (
      latest.status !== "current" ||
      ["pending", "unknown"].includes(latest.intents[id]?.state ?? "")
    )
      return;
    void facade.task(command, id).then((result) => {
      const retained = facade.getSnapshot().intents[id];
      // Immediate validation refusals need not enter the controller map. A
      // late reply must never replace another dispatch's retained result.
      if (retained === result || retained === latest.intents[id])
        setReturned((previous) => ({
          ...previous,
          [id]: { result, retained },
        }));
    });
  };
  const results = actionLabels.flatMap(([action, label]) => {
    const id = `${action}:${taskId}`;
    const result = resultFor(id);
    return result
      ? [
          <p key={id} role="status">
            {taskActionFeedback(label, result)}
          </p>,
        ]
      : [];
  });
  const resultView = results.length > 0 && (
    <section aria-label="Chat action results">
      {results}
      <button
        className="text-button"
        onClick={() =>
          facade.navigate({ area: "settings", page: "diagnostics" })
        }
      >
        Inspect action details
      </button>
    </section>
  );
  const authority: AgentAuthority | null =
    settings && workspaceId
      ? {
          workspaceId,
          configGeneration: settings.computer.generation,
          hostExecutablePath:
            settings.nativeHosts.codex?.executablePath ?? null,
        }
      : null;
  const [composedUnder, setComposedUnder] = useState(
    () => facade.draft.composedUnder() ?? authority,
  );
  const pending = snapshot.intents[`agent:${task?.taskId}`]?.state;
  const change = (next: typeof fields) => {
    setFields(next);
    facade.draft.capture(snapshot.destination.taskId, next, composedUnder);
  };
  if (!task)
    return (
      <div>
        {resultView}
        <p>No current chat is selected.</p>
      </div>
    );
  const unchanged = agentAuthorityUnchanged(composedUnder, authority);
  const submit = () => {
    if (!unchanged) {
      setFeedback(AGENT_AUTHORITY_CHANGED);
      return;
    }
    const lines = (value: string) =>
      value
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
    const scope = ProductAgentScopeSelectionSchema.safeParse(
      fields.mode === "workspace"
        ? { mode: "workspace", excludedPaths: lines(fields.exclusions) }
        : fields.mode === "subtree"
          ? {
              mode: "subtree",
              relativeRoot: fields.subtree,
              excludedPaths: lines(fields.exclusions),
            }
          : { mode: "exact", relativePaths: lines(fields.paths) },
    );
    if (!scope.success) {
      setFeedback("Review the relative paths and exclusions.");
      return;
    }
    run(
      {
        kind: "task.start-agent",
        taskId: task.taskId,
        workspaceId,
        objective: fields.objective,
        scope: scope.data,
      },
      "agent",
    );
  };
  return (
    <div>
      <div className="field">
        <label htmlFor="task-label">
          {task.agent ? "Task name" : "Chat name"}
        </label>
        <input
          id="task-label"
          value={label}
          maxLength={80}
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>
      <div className="control-row">
        <button
          disabled={disabled("rename") || !label.trim()}
          onClick={() =>
            run({ kind: "task.rename", taskId: task.taskId, label }, "rename")
          }
        >
          Rename
        </button>
        <button
          disabled={disabled("pin")}
          onClick={() =>
            run(
              { kind: "task.pin", taskId: task.taskId, pinned: !task.pinned },
              "pin",
            )
          }
        >
          {task.pinned ? "Unpin" : "Pin"}
        </button>
        <button
          disabled={
            disabled("cancel") ||
            !["running", "event_driven"].includes(task.lifecycle)
          }
          onClick={() =>
            run({ kind: "task.cancel", taskId: task.taskId }, "cancel")
          }
        >
          Cancel work
        </button>
        <button
          disabled={disabled("close")}
          onClick={() =>
            run({ kind: "task.close", taskId: task.taskId }, "close")
          }
        >
          Close chat
        </button>
      </div>
      {resultView}
      <h3>Agent assignment</h3>
      <p className="description">
        Use only the currently approved workspace and scope. Closing this panel
        does not cancel work.
      </p>
      <div className="field">
        <label htmlFor="agent-workspace">Approved folder</label>
        <select
          id="agent-workspace"
          value={workspaceId}
          onChange={(event) => {
            setWorkspaceId(event.target.value);
            const next = authority
              ? { ...authority, workspaceId: event.target.value }
              : null;
            setComposedUnder(next);
            facade.draft.capture(task.taskId, fields, next);
          }}
        >
          {settings?.computer.workspaces.map((workspace) => (
            <option key={workspace.workspaceId} value={workspace.workspaceId}>
              {workspace.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="agent-objective">Assignment</label>
        <textarea
          id="agent-objective"
          value={fields.objective}
          maxLength={8000}
          onChange={(event) =>
            change({ ...fields, objective: event.target.value })
          }
        />
      </div>
      <div className="field">
        <label htmlFor="agent-scope">Scope</label>
        <select
          id="agent-scope"
          value={fields.mode}
          onChange={(event) => change({ ...fields, mode: event.target.value })}
        >
          <option value="workspace">Approved folder</option>
          <option value="subtree">One subfolder</option>
          <option value="exact">Exact files</option>
        </select>
      </div>
      {fields.mode === "subtree" && (
        <div className="field">
          <label htmlFor="agent-subtree">Relative subfolder</label>
          <input
            id="agent-subtree"
            value={fields.subtree}
            onChange={(event) =>
              change({ ...fields, subtree: event.target.value })
            }
          />
        </div>
      )}
      {fields.mode === "exact" && (
        <div className="field">
          <label htmlFor="agent-paths">Relative file paths, one per line</label>
          <textarea
            id="agent-paths"
            value={fields.paths}
            onChange={(event) =>
              change({ ...fields, paths: event.target.value })
            }
          />
        </div>
      )}
      {fields.mode !== "exact" && (
        <div className="field">
          <label htmlFor="agent-exclusions">
            Relative exclusions, one per line
          </label>
          <textarea
            id="agent-exclusions"
            value={fields.exclusions}
            onChange={(event) =>
              change({ ...fields, exclusions: event.target.value })
            }
          />
        </div>
      )}
      {!unchanged && <p role="alert">{AGENT_AUTHORITY_CHANGED}</p>}
      {feedback && <p role="status">{feedback}</p>}
      <div className="control-row">
        <button
          className="primary"
          disabled={
            snapshot.status !== "current" ||
            !authority ||
            !settings?.computer.workspaces.some(
              (workspace) => workspace.workspaceId === workspaceId,
            ) ||
            !unchanged ||
            !fields.objective.trim() ||
            pending === "pending" ||
            pending === "unknown" ||
            task.agent?.phase === "running"
          }
          onClick={submit}
        >
          Run Agent
        </button>
        {task.agent && (
          <button
            disabled={disabled("rejoin")}
            onClick={() =>
              run({ kind: "task.rejoin-agent", taskId: task.taskId }, "rejoin")
            }
          >
            Observe same Agent
          </button>
        )}
        <button
          onClick={() => {
            setComposedUnder(authority);
            facade.draft.capture(task.taskId, fields, authority);
          }}
        >
          Review current authority
        </button>
      </div>
    </div>
  );
}
