import { useRef, useState } from "react";
import type { Intent, RendererFacade, WindowSnapshot } from "./contract";
import { folderAccessChecked } from "../folder-access-state";
import { ReadConversation } from "./read-conversation";

export type ChatReadonlyProps = Readonly<{
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}>;
type Evidence = NonNullable<WindowSnapshot["evidence"]>;
type Preview = Extract<
  Evidence["value"],
  { kind: "chatgpt.readonly-task-preview" }
>;
const PREPARE = "chat-readonly:prepare:";
const DISCARD = "chat-readonly:discard:";
const LIMITATION =
  "This preview's current state is unavailable. Keep it on hold; preparing or discarding it again is unavailable here.";
const UNKNOWN =
  "The result is unknown. The preview may still exist. Do not repeat this action.";

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
function discarded(snapshot: WindowSnapshot, operationId: string): boolean {
  const suffix = `:${operationId}`;
  return Object.values(snapshot.intents).some((intent) => {
    if (
      intent.state !== "applied" ||
      !intent.id.startsWith(`${DISCARD}${PREPARE}`) ||
      !intent.id.endsWith(suffix)
    )
      return false;
    const prepareId = intent.id.slice(DISCARD.length, -suffix.length);
    return snapshot.intents[prepareId]?.state === "applied";
  });
}
function previewEvidence(snapshot: WindowSnapshot): Evidence | null {
  const evidence = snapshot.evidence;
  // A successful exact Discard can leave evidence behind when its response
  // snapshot loses the request-order race. Project only that operation away;
  // refused/unknown intents and other operations remain visible and fenced.
  return evidence?.value.kind === "chatgpt.readonly-task-preview" &&
    !discarded(snapshot, evidence.value.operationId)
    ? evidence
    : null;
}
function boundPreview(snapshot: WindowSnapshot) {
  const retained = snapshot.readPreview;
  return snapshot.status === "current" &&
    retained &&
    retained.prepareIntention.startsWith(PREPARE) &&
    retained.revision === settings(snapshot)?.revision &&
    retained.buildId === snapshot.buildId &&
    snapshot.intents[retained.prepareIntention]?.state === "applied" &&
    snapshot.intents[retained.evidenceIntention]?.state === "applied" &&
    !discarded(snapshot, retained.value.operationId) &&
    verifiedWorkspace(snapshot, retained.value.workspaceId)
    ? retained
    : null;
}
function feedback(result: Intent, action: "Prepare" | "Discard"): string {
  if (result.state === "unknown") return UNKNOWN;
  if (result.code === "CHATGPT_PROMPT_TOO_LARGE")
    return "The file and its context exceed the 8192-byte message limit. Choose a smaller text file.";
  if (result.state !== "applied")
    return `${action} was refused. Check the current status before continuing.`;
  return action === "Discard"
    ? "The exact preview was discarded."
    : "Review the selected file metadata below.";
}

/** Safe metadata only. Every command belongs to an explicit user intention. */
export function ChatReadonly({ snapshot, facade }: ChatReadonlyProps) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const busy = useRef(false);
  const current = boundPreview(snapshot);
  const preview = current?.value;
  // The controller retains correlated receipts across component remounts. It
  // cannot recover an operation from a different window or backend lifetime.
  const visibleEvidence = snapshot.readPreview ?? previewEvidence(snapshot);
  const visiblePreview: Preview | null =
    visibleEvidence?.value.kind === "chatgpt.readonly-task-preview"
      ? visibleEvidence.value
      : null;
  const submission = visiblePreview
    ? snapshot.intents[`chat-readonly:send:${visiblePreview.operationId}`]
    : undefined;
  const retained = unresolvedPrepare(snapshot) || visiblePreview !== null;
  const outcomeUnknown =
    uncertain ||
    Object.values(snapshot.intents).some(
      (intent) => intent.state === "unknown",
    );
  const paused = pending || uncertain || fenced(snapshot);
  const discardId =
    preview && current
      ? `${DISCARD}${current.prepareIntention}:${preview.operationId}`
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
      previewEvidence(before) !== null ||
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
    setMessage("Choose a text file in the system picker…");
    try {
      const result = await facade.configure(
        { kind: "chatgpt.prepare-readonly-task", workspaceId },
        intention,
      );
      const retained = boundPreview(facade.getSnapshot());
      if (
        result.state === "applied" &&
        retained?.prepareIntention !== intention
      )
        setMessage(LIMITATION);
      else setMessage(feedback(result, "Prepare"));
      if (result.state === "unknown") setUncertain(true);
    } catch {
      setUncertain(true);
      setMessage(UNKNOWN);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function discard() {
    const current = facade.getSnapshot();
    const exact = boundPreview(current);
    if (busy.current || uncertain || fenced(current) || !exact) return;
    const intention = `${DISCARD}${exact.prepareIntention}:${exact.value.operationId}`;
    if (current.intents[intention]) return;
    busy.current = true;
    setPending(true);
    setMessage("Discarding the exact preview…");
    try {
      const result = await facade.configure(
        {
          kind: "chatgpt.cancel-readonly-task",
          operationId: exact.value.operationId,
        },
        intention,
      );
      if (result.state === "unknown") setUncertain(true);
      setMessage(feedback(result, "Discard"));
    } catch {
      setUncertain(true);
      setMessage(UNKNOWN);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function accountAction(action: "inspect" | "approve") {
    const state = facade.getSnapshot();
    const exact = boundPreview(state);
    if (busy.current || uncertain || fenced(state) || !exact) return;
    const account = exact.value.account;
    if (action === "approve" && account?.state !== "observed") return;
    if (action === "inspect" && account) return;
    const intention = `chat-readonly:${action}:${exact.prepareIntention}:${exact.value.operationId}`;
    if (state.intents[intention]) return;
    busy.current = true;
    setPending(true);
    setMessage(
      action === "inspect"
        ? "Reading the current ChatGPT account…"
        : "Confirming this account…",
    );
    try {
      const command =
        action === "inspect"
          ? {
              kind: "chatgpt.inspect-readonly-account" as const,
              operationId: exact.value.operationId,
            }
          : {
              kind: "chatgpt.approve-readonly-account" as const,
              operationId: exact.value.operationId,
              confirmationId: account!.confirmationId,
            };
      const result = await facade.configure(command, intention);
      if (result.state === "unknown") {
        setUncertain(true);
        setMessage(UNKNOWN);
      } else if (result.state !== "applied")
        setMessage(
          "The account could not be confirmed. Discard this preview before starting again.",
        );
      else
        setMessage(
          action === "inspect"
            ? "The current account was observed. Confirm it only if it is the account you intend to use."
            : "",
        );
    } catch {
      setUncertain(true);
      setMessage(UNKNOWN);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const accountAttempted = (action: "inspect" | "approve") =>
    Boolean(
      current &&
      snapshot.intents[
        `chat-readonly:${action}:${current.prepareIntention}:${current.value.operationId}`
      ],
    );
  async function send() {
    const before = facade.getSnapshot();
    const owner = boundPreview(before);
    if (
      busy.current ||
      uncertain ||
      fenced(before) ||
      before.readConversation ||
      !owner?.value.sendAvailable ||
      owner?.value.account?.state !== "approved"
    )
      return;
    const intention = `chat-readonly:send:${owner.value.operationId}`;
    if (before.intents[intention]) return;
    busy.current = true;
    setPending(true);
    try {
      const result = await facade.configure(
        {
          kind: "chatgpt.submit-readonly-task",
          operationId: owner.value.operationId,
        },
        intention,
      );
      if (result.state === "unknown") setUncertain(true);
      if (result.state !== "applied")
        setMessage(
          result.state === "unknown"
            ? UNKNOWN
            : "Send is unavailable for the current account and model route. The file has not been resent.",
        );
    } catch {
      setUncertain(true);
      setMessage(UNKNOWN);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function conversationAction(
    action: "observe" | "ack" | "follow",
    prompt?: string,
  ) {
    const before = facade.getSnapshot();
    const retained = before.readConversation;
    const view = retained?.turns.at(-1)?.view;
    if (
      busy.current ||
      uncertain ||
      fenced(before) ||
      !retained ||
      !view ||
      retained.buildId !== before.buildId ||
      retained.revision !== settings(before)?.revision
    ) {
      if (action === "observe") return;
      throw new Error("READ_CONVERSATION_NOT_APPLIED");
    }
    const base = { operationId: retained.operationId, handleId: view.handleId };
    const command =
      action === "observe"
        ? {
            ...base,
            kind: "chatgpt.observe-readonly-conversation" as const,
            cursor: view.cursor,
          }
        : action === "ack" && view.result && !view.result.acknowledged
          ? {
              ...base,
              kind: "chatgpt.ack-readonly-conversation" as const,
              resultId: view.result.resultId,
              cursor: view.cursor,
            }
          : action === "follow" && view.followReady && prompt !== undefined
            ? {
                ...base,
                kind: "chatgpt.follow-readonly-conversation" as const,
                prompt,
              }
            : null;
    if (!command) throw new Error("READ_CONVERSATION_NOT_APPLIED");
    busy.current = true;
    setPending(true);
    try {
      const result = await facade.configure(
        command,
        `chat-readonly:${action}:${view.handleId}`,
      );
      if (result.state === "unknown") setUncertain(true);
      if (result.state !== "applied") {
        setMessage(
          result.state === "unknown"
            ? UNKNOWN
            : "The conversation action was refused. Its retained result remains available.",
        );
        throw new Error("READ_CONVERSATION_NOT_APPLIED");
      }
    } catch (error) {
      if (!(
        error instanceof Error &&
        error.message === "READ_CONVERSATION_NOT_APPLIED"
      )) {
        setUncertain(true);
        setMessage(UNKNOWN);
      }
      throw error;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const conversation = snapshot.readConversation;
  const latest = conversation?.turns.at(-1);
  if (conversation && latest)
    return (
      <section
        className="settings-group"
        aria-label="Read-only Chat conversation"
      >
        <ReadConversation
          view={latest.view}
          text={latest.text}
          history={conversation.turns.slice(0, -1)}
          busy={pending}
          blocked={
            uncertain ||
            fenced(snapshot) ||
            conversation.buildId !== snapshot.buildId ||
            conversation.revision !== settings(snapshot)?.revision
          }
          onObserve={() => conversationAction("observe")}
          onAcknowledge={() => conversationAction("ack")}
          onFollow={(prompt) => conversationAction("follow", prompt)}
        />
        {message && <p role="status">{message}</p>}
      </section>
    );
  return (
    <section className="settings-group" aria-label="Read-only file preview">
      <h2>Read-only file preview</h2>
      <p className="description">
        Choose a verified read-only folder, then select one text file in the
        system picker. Nothing is sent to ChatGPT until you review the file,
        confirm the account and choose Send.
      </p>
      <p className="description">
        You may see a file selected earlier. Check its path before continuing.
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
            . An expired preview may still need to be discarded.
          </p>
          <div className="control-row">
            <button
              type="button"
              onClick={() => facade.navigate({ area: "chatgpt" })}
            >
              Open ChatGPT
            </button>
            {!preview?.account ? (
              <button
                type="button"
                disabled={paused || !preview || accountAttempted("inspect")}
                onClick={() => void accountAction("inspect")}
              >
                Inspect current account
              </button>
            ) : preview.account.state === "observed" ? (
              <button
                type="button"
                disabled={paused || !preview || accountAttempted("approve")}
                onClick={() => void accountAction("approve")}
              >
                Use this account
              </button>
            ) : (
              <>
                <p role="status">
                  {submission
                    ? submission.state === "pending"
                      ? "Submission is pending. Do not send this preview again."
                      : "Submission was attempted. Check its result before continuing."
                    : "Account confirmed for this preview. Nothing has been sent."}
                </p>
                {preview.sendAvailable && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void send()}
                    disabled={
                      paused ||
                      Boolean(
                        snapshot.intents[
                          `chat-readonly:send:${preview.operationId}`
                        ],
                      )
                    }
                  >
                    Send to ChatGPT
                  </button>
                )}
                {!preview.sendAvailable && (
                  <p className="description">
                    Sending from this preview is unavailable for the current
                    model route.
                  </p>
                )}
              </>
            )}
          </div>
          <p className="description">
            Check the account open in ChatGPT before confirming it for this
            file.
          </p>
          <details>
            <summary>Details</summary>
            <p>
              Operation: <code>{visiblePreview.operationId}</code>
            </p>
            <p>Configuration revision: {visibleEvidence?.revision}</p>
          </details>
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
      {paused && !outcomeUnknown && (
        <p role="status">
          Actions are paused while an action is in progress or the current state
          is unavailable.
        </p>
      )}
      {outcomeUnknown && <p role="status">{UNKNOWN}</p>}
      {blocked && <p role="alert">{LIMITATION}</p>}
      {!outcomeUnknown && message && <p role="status">{message}</p>}
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
