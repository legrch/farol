import type {
  TaskHistoryItem,
  TaskHistoryRequest,
  TaskHistoryResult,
  TaskHistoryHost,
} from "../port/codex-task-history";

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/u.test(value);
export const historyCursor = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !/[\u0000-\u001f\u007f]/u.test(value);
function cursor(page: Record<string, unknown>): string | null | false {
  if (page.nextCursor === undefined || page.nextCursor === null) return null;
  return historyCursor(page.nextCursor) ? page.nextCursor : false;
}

/** Read only one explicitly selected turn. No task or local journal effects. */
export async function readCodexTaskHistory(
  host: TaskHistoryHost,
  request: TaskHistoryRequest,
  writerRoot: string,
  deadlineAt: number,
  isAdmitted: () => boolean,
): Promise<TaskHistoryResult> {
  const unavailable = (): TaskHistoryResult => ({
    status: "unavailable",
    threadId: request.threadId,
    turnId: request.turnId,
    code: "HANDOFF_HISTORY_UNAVAILABLE",
  });
  const refused = (): TaskHistoryResult => ({
    status: "refused",
    threadId: request.threadId,
    turnId: request.turnId,
    code: "HANDOFF_HISTORY_READ_REVOKED",
  });
  const read = async (method: string, params: unknown) => {
    if (!isAdmitted()) throw new Error("HISTORY_REVOKED");
    const value = await host.request(method, params, deadlineAt);
    if (!isAdmitted()) throw new Error("HISTORY_REVOKED");
    return object(value);
  };
  const exactThread = async () => {
    const response = await read("thread/read", {
      threadId: request.threadId,
      includeTurns: false,
    });
    const thread = object(response?.thread);
    return (
      thread?.id === request.threadId &&
      thread.projectId === request.projectId &&
      thread.cwd === writerRoot
    );
  };
  try {
    if (!(await exactThread())) return unavailable();
    let turnStatus:
      "inProgress" | "completed" | "failed" | "interrupted" | null = null;
    let next: string | null = null;
    const seenCursors = new Set<string>();
    const seenTurns = new Set<string>();
    for (let index = 0; index < 32; index++) {
      const page = await read("thread/turns/list", {
        threadId: request.threadId,
        cursor: next,
        limit: 100,
        itemsView: "notLoaded",
        sortDirection: "desc",
      });
      if (!page || !Array.isArray(page.data) || page.data.length > 100)
        return unavailable();
      for (const value of page.data) {
        const turn = object(value);
        if (
          !identifier(turn?.id) ||
          seenTurns.has(turn.id) ||
          !["inProgress", "completed", "failed", "interrupted"].includes(
            turn.status as string,
          )
        )
          return unavailable();
        seenTurns.add(turn.id);
        if (turn.id === request.turnId)
          turnStatus = turn.status as NonNullable<typeof turnStatus>;
      }
      const following = cursor(page);
      if (
        following === false ||
        (following !== null && seenCursors.has(following))
      )
        return unavailable();
      if (turnStatus !== null) break;
      if (following === null)
        return {
          status: "refused",
          threadId: request.threadId,
          turnId: request.turnId,
          code: "HANDOFF_HISTORY_TURN_MISSING",
        };
      seenCursors.add(following);
      next = following;
    }
    if (turnStatus === null) return unavailable();
    const sortDirection = request.tail ? "desc" : "asc";
    const page = await read("thread/items/list", {
      threadId: request.threadId,
      turnId: request.turnId,
      cursor: request.cursor ?? null,
      limit: 50,
      sortDirection,
    });
    if (!page || !Array.isArray(page.data) || page.data.length > 50)
      return unavailable();
    const nextCursor = cursor(page);
    if (
      nextCursor === false ||
      (nextCursor !== null && nextCursor === request.cursor)
    )
      return unavailable();
    const items: TaskHistoryItem[] = [];
    const ids = new Set<string>();
    let bytes = 0;
    const text = (value: unknown): value is string => {
      if (typeof value !== "string" || value.includes("\0")) return false;
      bytes += new TextEncoder().encode(value).byteLength;
      return bytes <= 32768;
    };
    for (const value of page.data) {
      const entry = object(value);
      const item = object(entry?.item);
      if (
        entry?.turnId !== request.turnId ||
        !identifier(item?.id) ||
        ids.has(item.id) ||
        typeof item.type !== "string" ||
        !/^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(item.type)
      )
        return unavailable();
      ids.add(item.id);
      if (item.type === "agentMessage") {
        if (
          !text(item.text) ||
          (item.phase !== undefined &&
            item.phase !== null &&
            !["commentary", "final_answer"].includes(item.phase as string))
        )
          return unavailable();
        items.push({
          id: item.id,
          kind: "agent_message",
          text: item.text,
          phase:
            item.phase === undefined || item.phase === null
              ? null
              : (item.phase as "commentary" | "final_answer"),
        });
      } else if (item.type === "userMessage") {
        if (!Array.isArray(item.content) || item.content.length > 100)
          return unavailable();
        const parts: string[] = [];
        let omittedContent = 0;
        for (const raw of item.content) {
          const content = object(raw);
          if (
            !content ||
            typeof content.type !== "string" ||
            !/^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(content.type)
          )
            return unavailable();
          if (content.type === "text") {
            if (!text(content.text)) return unavailable();
            parts.push(content.text);
          } else omittedContent++;
        }
        items.push({
          id: item.id,
          kind: "user_message",
          parts,
          omittedContent,
        });
      } else items.push({ id: item.id, kind: "omitted", type: item.type });
    }
    if (!(await exactThread())) return unavailable();
    if (!isAdmitted()) return refused();
    return {
      status: "history",
      source: "stored",
      snapshot: "non-atomic",
      coverage: "single-page-text-only",
      threadId: request.threadId,
      turnId: request.turnId,
      turnStatus,
      sortDirection,
      items,
      nextCursor,
      complete: request.cursor === undefined && nextCursor === null,
    };
  } catch {
    return isAdmitted() ? unavailable() : refused();
  }
}
