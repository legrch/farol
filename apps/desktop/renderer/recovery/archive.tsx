import { useEffect, useRef, useState } from "react";
import {
  RecoveryReadResultSchema,
  type RecoveryArchiveEntry,
  type RecoveryReadResult,
  type StartupRecoveryAPI,
} from "./contract";

type Reply = Extract<
  Extract<RecoveryReadResult, { status: "ok" }>["data"],
  { kind: "archive-read" }
>;
type Phase =
  | "idle"
  | "loading"
  | "reading"
  | "ready"
  | "refused"
  | "unavailable"
  | "unknown";
export function StoredReplies({
  api,
  available,
  starting,
  otherBusy,
  onBusy,
  context = "recovery",
}: {
  api: Pick<StartupRecoveryAPI, "read">;
  available: boolean;
  starting: boolean;
  otherBusy: boolean;
  onBusy(value: boolean): void;
  context?: "recovery" | "retired";
}) {
  const [rows, setRows] = useState<RecoveryArchiveEntry[]>([]);
  const [next, setNext] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [unresolved, setUnresolved] = useState(false);
  const [reply, setReply] = useState<Reply | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const epoch = useRef(0),
    pending = useRef(false);
  useEffect(() => {
    const current = ++epoch.current;
    return () => {
      epoch.current = current + 1;
    };
  }, [api]);
  const failed =
    phase === "unknown" || phase === "unavailable" || phase === "refused";
  const busy = phase === "loading" || phase === "reading";
  const disabled = !available || busy || otherBusy || failed;
  const perform = async (selected?: RecoveryArchiveEntry) => {
    if (
      disabled ||
      pending.current ||
      (selected && reply?.summary.key === selected.key)
    )
      return;
    if (!selected && loaded && next === "") return;
    const current = epoch.current;
    pending.current = true;
    onBusy(true);
    setPhase(selected ? "reading" : "loading");
    const after = loaded ? next : "";
    try {
      const result = RecoveryReadResultSchema.parse(
        await api.read(
          selected
            ? {
                kind: "archive-read",
                key: selected.key,
                digest: selected.digest,
              }
            : { kind: "archive-list", after },
        ),
      );
      if (epoch.current !== current) return;
      if (result.status !== "ok") {
        setPhase(result.status);
        return;
      }
      if (selected) {
        if (result.data.kind !== "archive-read")
          throw Error("crossed_stored_reply");
        const actual = result.data.summary;
        if (
          (Object.keys(selected) as (keyof RecoveryArchiveEntry)[]).some(
            (key) => selected[key] !== actual[key],
          ) ||
          new TextEncoder().encode(result.data.text).length !== actual.bytes
        )
          throw Error("crossed_stored_reply");
        setReply(result.data);
      } else {
        if (result.data.kind !== "archive-list" || result.data.after !== after)
          throw Error("crossed_stored_page");
        let previous = after;
        for (const entry of result.data.entries) {
          if (
            entry.key <= previous ||
            rows.some((row) => row.key === entry.key)
          )
            throw Error("crossed_stored_page");
          previous = entry.key;
        }
        if (
          result.data.next !== "" &&
          (result.data.entries.length !== 32 || result.data.next !== previous)
        )
          throw Error("crossed_stored_cursor");
        setRows([...rows, ...result.data.entries]);
        setNext(result.data.next);
        setUnresolved(unresolved || result.data.unresolved);
        setLoaded(true);
      }
      setPhase("ready");
    } catch {
      if (epoch.current === current) setPhase("unknown");
    } finally {
      pending.current = false;
      if (epoch.current === current) onBusy(false);
    }
  };
  return (
    <section
      className="recovery-archive"
      aria-labelledby="stored-replies-title"
    >
      <h3 id="stored-replies-title">Stored replies</h3>
      <p className="recovery-note">
        These are stored copies. Previous outcomes remain unconfirmed; nothing
        will be sent or repeated.
      </p>
      {context === "retired" ? (
        <p className="recovery-note">
          Copies preserved from interrupted app sessions are available here
          separately from confirmed saved answers.
        </p>
      ) : null}
      {starting ? (
        <p role="status">Starting the stored reply reader…</p>
      ) : !available ? (
        <p role="status">
          {context === "recovery"
            ? "Stored replies are unavailable for this recovery session. Original records remain in place."
            : "Stored replies are unavailable in this app session. Original records remain in place."}
        </p>
      ) : null}
      {!loaded ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => void perform()}
        >
          Load stored replies
        </button>
      ) : null}
      {busy ? (
        <p role="status">
          {phase === "reading"
            ? "Reading the stored copy…"
            : "Reading stored replies…"}
        </p>
      ) : null}
      {failed ? (
        <p role="alert">
          This stored read could not be confirmed. The reader is paused and
          original records remain in place.{" "}
          {context === "recovery"
            ? "You can inspect available folders or Quit."
            : "Other app functions remain independent of this reader."}
        </p>
      ) : null}
      {loaded && rows.length === 0 ? (
        <p>No readable stored replies were found in this observation.</p>
      ) : null}
      {unresolved ? (
        <p className="recovery-note">
          Some records remain unresolved or cannot be displayed.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="recovery-reply-list" aria-label="Stored reply copies">
          {rows.map((entry, index) => (
            <li key={entry.key}>
              <button
                type="button"
                aria-label={`Open stored reply ${index + 1}`}
                aria-pressed={reply?.summary.key === entry.key}
                disabled={disabled}
                onClick={() => void perform(entry)}
              >
                <span>Stored reply {index + 1}</span>
                <small>{entry.conversationId || entry.resultId}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {loaded && next !== "" ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => void perform()}
        >
          Load more replies
        </button>
      ) : null}
      {reply ? (
        <div className="recovery-stored-copy">
          <div className="recovery-section-heading">
            <h3>Stored copy</h3>
            <span>Outcome unconfirmed</span>
          </div>
          <div
            className="recovery-copy-text"
            role="region"
            aria-label="Stored reply text"
            tabIndex={0}
          >
            <pre>{reply.text}</pre>
          </div>
          {reply.text === "" ? (
            <p className="recovery-note">This stored reply is empty.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
