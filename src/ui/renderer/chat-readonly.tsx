import { useRef, useState } from "react";
import type { Intent, RendererFacade, WindowSnapshot } from "./contract";
import { folderAccessChecked } from "../folder-access-state";

export type ChatReadonlyProps = Readonly<{
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}>;
type Evidence = NonNullable<WindowSnapshot["evidence"]>;
type Preview = Extract<
  Evidence["value"],
  { kind: "chatgpt.readonly-task-preview" }
>;
type Reviewed = Readonly<{
  facade: RendererFacade;
  intention: string;
  evidence: Evidence;
}>;
const PREPARE = "chat-readonly:prepare:";
const DISCARD = "chat-readonly:discard:";
const LIMITATION =
  "The retained preview cannot be safely restored or retired here. The current interface has no read-only preview observation with request correlation. Do not prepare again; ask for the retained operation to be reconciled.";

function settings(snapshot: WindowSnapshot) {
  return snapshot.configuration?.status === "ready"
    ? snapshot.configuration.settings
    : null;
}
function fenced(snapshot: WindowSnapshot): boolean {
  const value = settings(snapshot);
  return (
    snapshot.status !== "current" ||
    !value ||
    Object.values(snapshot.intents).some(
      (intent) => intent.state === "pending" || intent.state === "unknown",
    ) ||
    Boolean(
      value.computer.pendingEdit ||
      Object.values(value.setup).some(
        (step) => "outcomeUnknown" in step && step.outcomeUnknown,
      ) ||
      value.connectors.secureMcp.runtime?.state === "outcome_unknown",
    )
  );
}
function verifiedWorkspace(snapshot: WindowSnapshot, workspaceId: string) {
  const value = settings(snapshot);
  const workspace = value?.computer.workspaces.find(
    (item) => item.workspaceId === workspaceId,
  );
  const check = value?.setup.computer.verified;
  // Mirror the existing prepare boundary, including its single verified folder.
  // A saved access badge is presentation evidence, never an authority grant.
  return value &&
    workspace?.access === "read" &&
    snapshot.buildId &&
    check?.workspaceId === workspaceId &&
    check.configRevision === value.computer.generation &&
    folderAccessChecked(value, workspace, snapshot.buildId) &&
    value.setup.chatgpt.verified
    ? workspace
    : null;
}
function unresolvedPrepare(snapshot: WindowSnapshot): boolean {
  return Object.values(snapshot.intents).some((intent) => {
    if (!intent.id.startsWith(PREPARE)) return false;
    if (intent.state === "refused")
      return [
        "CHATGPT_TASK_REQUIRES_REVIEW",
        "CHATGPT_TASK_PREVIEW_PENDING",
        "CHATGPT_TASK_IN_PROGRESS",
      ].includes(intent.code ?? "");
    return !Object.values(snapshot.intents).some(
      (discard) =>
        discard.id.startsWith(`${DISCARD}${intent.id}:`) &&
        discard.state === "applied",
    );
  });
}
function boundPreview(snapshot: WindowSnapshot, reviewed: Reviewed | null) {
  const value = settings(snapshot);
  const evidence = reviewed?.evidence;
  return reviewed &&
    evidence?.value.kind === "chatgpt.readonly-task-preview" &&
    snapshot.evidence === evidence &&
    evidence.revision === value?.revision &&
    snapshot.intents[reviewed.intention]?.state === "applied" &&
    verifiedWorkspace(snapshot, evidence.value.workspaceId)
    ? evidence.value
    : null;
}
function feedback(result: Intent, action: "Prepare" | "Discard"): string {
  if (result.state === "unknown")
    return `${action} outcome unknown. Do not repeat this action. ${LIMITATION}`;
  if (result.state !== "applied")
    return `${action} was refused. Check the current status before continuing.`;
  return action === "Discard"
    ? "The exact preview was discarded."
    : "Review the selected file metadata below.";
}

/** Safe metadata only. Every command belongs to an explicit user intention. */
export function ChatReadonly({ snapshot, facade }: ChatReadonlyProps) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [reviewed, setReviewed] = useState<Reviewed | null>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const busy = useRef(false);
  const currentReviewed = reviewed?.facade === facade ? reviewed : null;
  const preview = boundPreview(snapshot, currentReviewed);
  // Retain metadata for explanation, but never reinterpret it as current proof.
  const visiblePreview: Preview | null =
    currentReviewed?.evidence.value.kind === "chatgpt.readonly-task-preview"
      ? currentReviewed.evidence.value
      : snapshot.evidence?.value.kind === "chatgpt.readonly-task-preview"
        ? snapshot.evidence.value
        : null;
  const retained = unresolvedPrepare(snapshot) || visiblePreview !== null;
  const paused = pending || uncertain || fenced(snapshot);
  const discardId =
    preview && currentReviewed
      ? `${DISCARD}${currentReviewed.intention}:${preview.operationId}`
      : null;
  const discardAttempted = Boolean(discardId && snapshot.intents[discardId]);
  const blocked = retained && !pending && (!preview || discardAttempted);

  async function prepare() {
    const before = facade.getSnapshot();
    if (
      busy.current ||
      uncertain ||
      fenced(before) ||
      unresolvedPrepare(before) ||
      before.evidence?.value.kind === "chatgpt.readonly-task-preview" ||
      !verifiedWorkspace(before, workspaceId)
    )
      return;
    const revision = settings(before)!.revision;
    // Allocate only on click, from window-owned intent history. The facade's
    // synchronous latch owns dispatch deduplication; no component operation store.
    const ordinal = Object.keys(before.intents).filter((id) =>
      id.startsWith(PREPARE),
    ).length;
    const intention = `${PREPARE}${workspaceId}:${revision}:${ordinal}`;
    busy.current = true;
    setPending(true);
    setReviewed(null);
    setMessage("Choose a text file in the system picker…");
    try {
      const result = await facade.configure(
        { kind: "chatgpt.prepare-readonly-task", workspaceId },
        intention,
      );
      const after = facade.getSnapshot();
      const evidence = after.evidence;
      const soleIntent = Object.entries(after.intents).every(
        ([id, intent]) => id === intention || before.intents[id] === intent,
      );
      // Evidence has no request ID. Accept only a fresh, sole-intent response
      // at the unchanged configuration revision and selected workspace.
      if (
        result.id === intention &&
        result.state === "applied" &&
        after.intents[intention]?.state === "applied" &&
        after.status === "current" &&
        soleIntent &&
        after.buildId === before.buildId &&
        settings(after)?.revision === revision &&
        evidence !== before.evidence &&
        evidence?.revision === revision &&
        evidence.value.kind === "chatgpt.readonly-task-preview" &&
        evidence.value.workspaceId === workspaceId &&
        verifiedWorkspace(after, workspaceId)
      ) {
        setReviewed({ facade, intention, evidence });
        setMessage(feedback(result, "Prepare"));
      } else if (result.state === "applied") {
        setMessage(LIMITATION);
      } else {
        setMessage(feedback(result, "Prepare"));
      }
      if (result.state === "unknown") setUncertain(true);
    } catch {
      setUncertain(true);
      setMessage(
        `Prepare outcome unknown. Do not repeat this action. ${LIMITATION}`,
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function discard() {
    const current = facade.getSnapshot();
    const exact = boundPreview(current, currentReviewed);
    if (
      busy.current ||
      uncertain ||
      fenced(current) ||
      !exact ||
      !currentReviewed
    )
      return;
    const intention = `${DISCARD}${currentReviewed.intention}:${exact.operationId}`;
    if (current.intents[intention]) return;
    busy.current = true;
    setPending(true);
    setMessage("Discarding the exact preview…");
    try {
      const result = await facade.configure(
        {
          kind: "chatgpt.cancel-readonly-task",
          operationId: exact.operationId,
        },
        intention,
      );
      if (result.id === intention && result.state === "applied")
        setReviewed(null);
      if (result.state === "unknown") setUncertain(true);
      setMessage(feedback(result, "Discard"));
    } catch {
      setUncertain(true);
      setMessage(
        `Discard outcome unknown. Do not repeat this action. ${LIMITATION}`,
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <section className="settings-group" aria-label="Read-only file preview">
      <h2>Read-only file preview</h2>
      <p className="description">
        Choose a verified read-only folder, then select one text file in the
        system picker. File contents stay with the existing preview owner; only
        metadata appears here.
      </p>
      <p className="description">
        An existing preview may return a previously selected file. Check its
        path and operation. Recovery after a window reload is unavailable here;
        expiry alone does not confirm retirement.
      </p>
      <div className="control-row">
        <label>
          Read-only folder{" "}
          <select
            value={workspaceId}
            disabled={paused || retained}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            <option value="">Choose a verified folder…</option>
            {settings(snapshot)
              ?.computer.workspaces.filter((workspace) =>
                verifiedWorkspace(snapshot, workspace.workspaceId),
              )
              .map((workspace) => (
                <option
                  key={workspace.workspaceId}
                  value={workspace.workspaceId}
                >
                  {workspace.label} · {workspace.root}
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          className="primary"
          disabled={
            paused || retained || !verifiedWorkspace(snapshot, workspaceId)
          }
          onClick={() => void prepare()}
        >
          Choose file…
        </button>
      </div>
      {visiblePreview && (
        <section aria-label="Selected file metadata">
          <h3>
            {visiblePreview.workspaceLabel} / {visiblePreview.relativePath}
          </h3>
          <p>
            {visiblePreview.bytes} bytes · {visiblePreview.contextCharacters} of{" "}
            {visiblePreview.contextLimit} context characters
          </p>
          {visiblePreview.contextTruncated && (
            <p role="alert">
              Context is truncated. Only part of this file was prepared.
            </p>
          )}
          <p>
            Expires at{" "}
            <time dateTime={visiblePreview.expiresAt}>
              {visiblePreview.expiresAt}
            </time>
            . Expiry does not confirm discard.
          </p>
          <p>
            Operation: <code>{visiblePreview.operationId}</code>
          </p>
          <p>
            Configuration revision:{" "}
            {currentReviewed?.evidence.revision ?? snapshot.evidence?.revision}
          </p>
          {visiblePreview.excludedPaths.length > 0 ? (
            <ul>
              {visiblePreview.excludedPaths.map((path) => (
                <li key={path}>Excluded: {path}</li>
              ))}
            </ul>
          ) : (
            <p className="description">
              No custom exclusions. Credential defaults remain denied.
            </p>
          )}
        </section>
      )}
      {paused && (
        <p role="status">
          Actions are paused while state is stale, unavailable, pending, or
          unknown.
        </p>
      )}
      {blocked && <p role="alert">{LIMITATION}</p>}
      {message && <p role="status">{message}</p>}
      {retained && (
        <div className="control-row">
          <button
            type="button"
            disabled={paused || !preview || discardAttempted}
            onClick={() => void discard()}
          >
            Discard preview
          </button>
        </div>
      )}
    </section>
  );
}
