import { useState, useSyncExternalStore } from "react";
import type { Intent, WindowSnapshot } from "../../../src/ui/renderer/contract";
import { unresolvedActions, type UnresolvedAction } from "./unresolved-actions";

const eventName = "farol-activity-read";
const limit = 2048;
const fingerprint = (row: UnresolvedAction) =>
  JSON.stringify([row.id, row.state, row.code ?? null]);
function subscribe(listener: () => void) {
  window.addEventListener(eventName, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(eventName, listener);
    window.removeEventListener("storage", listener);
  };
}
function read(key: string | null): string {
  try {
    return key ? (localStorage.getItem(key) ?? "[]") : "[]";
  } catch {
    return "[]";
  }
}
function parsed(text: string): string[] {
  try {
    const rows: unknown = JSON.parse(text);
    return Array.isArray(rows) &&
      rows.length <= limit &&
      rows.every((row) => typeof row === "string" && row.length <= 1024)
      ? rows
      : [];
  } catch {
    return [];
  }
}
/** Read receipts are presentation preferences. They never resolve an operation,
 * clear its durable journal or change any command/authority fence. */
export function useActivityNotifications(
  snapshot: WindowSnapshot,
  retained: readonly Intent[] = [],
) {
  const computer =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings.computer.computerId
      : null;
  const key = computer ? `farol.activity.read.v1:${computer}` : null;
  const text = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => "[]",
  );
  const [error, setError] = useState<string | null>(null);
  const acknowledged = new Set(parsed(text));
  const rows = unresolvedActions(snapshot, retained).filter(
    (row) => !row.inProgress,
  );
  const isUnread = (row: UnresolvedAction) =>
    !acknowledged.has(fingerprint(row));
  const unread = rows.filter(isUnread);
  function markRead(selected: readonly UnresolvedAction[] = unread) {
    if (!key) return;
    try {
      const next = new Set(parsed(read(key)));
      for (const row of selected) {
        next.delete(fingerprint(row));
        next.add(fingerprint(row));
      }
      localStorage.setItem(key, JSON.stringify([...next].slice(-limit)));
      setError(null);
      window.dispatchEvent(new Event(eventName));
    } catch {
      setError(
        "Read status could not be saved. Your history is still available in Activity.",
      );
    }
  }
  return { rows, unread, markRead, error, isUnread };
}
