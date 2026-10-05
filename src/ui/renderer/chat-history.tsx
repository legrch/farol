import { useRef, useState } from "react";
import {
  sameHistoryContext,
  type ChatHistoryQuery,
  type ChatHistoryReply,
} from "../../pkg/ipc/chat-history";
import type { RendererFacade, WindowSnapshot } from "./contract";

/** Explicit local reads only. Unmounting never ACKs, resumes or creates work. */
export function ChatHistory({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const [page, setPage] = useState<
    (ChatHistoryReply & { epoch: number }) | null
  >(null);
  const [answer, setAnswer] = useState<
    (ChatHistoryReply & { epoch: number }) | null
  >(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const available =
    snapshot.status === "current" && snapshot.chatHistoryContext !== null;
  const visiblePage =
    available &&
    page?.value.kind === "page" &&
    page.epoch === snapshot.chatHistoryEpoch &&
    sameHistoryContext(page.context, snapshot.chatHistoryContext)
      ? page.value
      : null;
  const visibleAnswer =
    visiblePage &&
    answer?.value.kind === "result" &&
    answer.epoch === snapshot.chatHistoryEpoch &&
    sameHistoryContext(answer.context, snapshot.chatHistoryContext)
      ? answer.value
      : null;
  async function read(query: ChatHistoryQuery) {
    if (busy.current || !available) return;
    busy.current = true;
    setPending(true);
    setError("");
    if (query.kind === "list") {
      setPage(null);
      setAnswer(null);
    } else setAnswer(null);
    try {
      const reply = await facade.readChatHistory(query);
      const current = { ...reply, epoch: snapshot.chatHistoryEpoch };
      if (reply.value.kind === "page") setPage(current);
      else setAnswer(current);
    } catch {
      setPage(null);
      setAnswer(null);
      setError(
        "Saved answers are unavailable. Refresh the app state before reading again.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <section className="settings-group" aria-label="Saved Chat answers">
      <div className="section-heading">
        <h2>Saved Chat answers</h2>
        <button
          type="button"
          disabled={!available || pending}
          onClick={() => void read({ kind: "list", offset: 0 })}
        >
          Load saved answers
        </button>
      </div>
      <p className="description">
        Read answers retained before the last clean restart. These saved answers
        cannot be continued here.
      </p>
      {!available && (
        <p role="status">
          Saved answers are unavailable in the current app state.
        </p>
      )}
      {pending && <p role="status">Reading saved answers…</p>}
      {error && <p role="status">{error}</p>}
      {visiblePage && (
        <>
          {visiblePage.total === 0 ? (
            <p>No saved answers from an earlier app session.</p>
          ) : (
            <>
              <p>
                {visiblePage.offset + 1}–
                {visiblePage.offset + visiblePage.entries.length} of{" "}
                {visiblePage.total} saved answers
              </p>
              <ul>
                {visiblePage.entries.map((e) => (
                  <li
                    key={JSON.stringify([
                      e.key.backendGeneration,
                      e.key.operationId,
                    ])}
                  >
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void read({
                          kind: "result",
                          offset: visiblePage.offset,
                          key: e.key,
                        })
                      }
                    >
                      Read turn {e.turnGeneration}
                    </button>
                    <span className="description"> · {e.conversationId}</span>
                  </li>
                ))}
              </ul>
              <div className="control-row">
                <button
                  type="button"
                  disabled={pending || visiblePage.offset === 0}
                  onClick={() =>
                    void read({
                      kind: "list",
                      offset: Math.max(0, visiblePage.offset - 32),
                    })
                  }
                >
                  Previous answers
                </button>
                <button
                  type="button"
                  disabled={
                    pending ||
                    visiblePage.offset + visiblePage.entries.length >=
                      visiblePage.total
                  }
                  onClick={() =>
                    void read({ kind: "list", offset: visiblePage.offset + 32 })
                  }
                >
                  Next answers
                </button>
              </div>
            </>
          )}
        </>
      )}
      {visibleAnswer && (
        <article
          aria-label="Saved answer"
          data-result-id={visibleAnswer.entry.resultId}
        >
          <h3>Turn {visibleAnswer.entry.turnGeneration}</h3>
          <p
            className="notice"
            style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          >
            {visibleAnswer.text}
          </p>
          <details>
            <summary>Details</summary>
            <p>Conversation: {visibleAnswer.entry.conversationId}</p>
            <p>Result: {visibleAnswer.entry.resultId}</p>
          </details>
        </article>
      )}
    </section>
  );
}
