import { identifier, object } from "./handoffvalidation";

type Fields = Record<string, unknown> | null;

export const TURN_STATUSES = [
  "inProgress",
  "completed",
  "failed",
  "interrupted",
];

export function knownTurnStatus(status: unknown): status is string {
  return typeof status === "string" && TURN_STATUSES.includes(status);
}

export type ObservedTurns = Readonly<{
  turns: ReadonlyArray<Readonly<{ id: string; status: string }>>;
  hasMoreTurns: boolean;
}>;

/** One bounded `thread/turns/list` page, or null when its shape is unverified. */
export function observedTurns(page: Fields): ObservedTurns | null {
  if (
    !Array.isArray(page?.data) ||
    page.data.length > 100 ||
    (page.nextCursor !== null &&
      (typeof page.nextCursor !== "string" || page.nextCursor.length === 0))
  )
    return null;
  const turns = page.data.map(object);
  if (
    turns.some(
      (turn) => !identifier(turn?.id) || !knownTurnStatus(turn?.status),
    )
  )
    return null;
  return {
    turns: turns.map((turn) => ({
      id: turn!.id as string,
      status: turn!.status as string,
    })),
    hasMoreTurns: page.nextCursor !== null,
  };
}

/** The newest listed turn is exactly this turn, in exactly this status. */
export function latestTurnIs(
  latest: Fields,
  turnId: string | undefined,
  status: string,
): boolean {
  const turn = object(Array.isArray(latest?.data) ? latest.data[0] : null);
  return turn?.id === turnId && turn?.status === status;
}

/** The child turn directly follows the parent turn in a two-turn newest page. */
export function continuationFollows(
  response: Fields,
  turnId: string,
  parentTurnId: string | undefined,
): boolean {
  const data = response?.data;
  return (
    Array.isArray(data) &&
    data.length >= 2 &&
    object(data[0])?.id === turnId &&
    object(data[1])?.id === parentTurnId
  );
}

export type StatusPage =
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "found"; status: string }>
  | Readonly<{ kind: "absent"; nextCursor: unknown }>;

/** Locate one turn in a bounded page; duplicates or unknown statuses are invalid. */
export function statusPage(
  turns: Fields,
  turnId: string | undefined,
): StatusPage {
  if (!turns || !Array.isArray(turns.data) || turns.data.length > 100)
    return { kind: "invalid" };
  const matches = turns.data.map(object).filter((item) => item?.id === turnId);
  if (matches.length > 1) return { kind: "invalid" };
  const match = matches[0];
  if (match) {
    if (!knownTurnStatus(match.status)) return { kind: "invalid" };
    return { kind: "found", status: match.status };
  }
  return { kind: "absent", nextCursor: turns.nextCursor };
}

/** The next status cursor, or null to stop paging. */
export function statusNextCursor(
  next: unknown,
  seen: ReadonlySet<string>,
): string | null {
  return next === null || typeof next !== "string" || seen.has(next)
    ? null
    : next;
}

/** The next items cursor, or null to stop paging (a non-null stop is a failure). */
export function itemsNextCursor(
  next: unknown,
  seen: ReadonlySet<string>,
): string | null {
  return typeof next !== "string" || next.length === 0 || seen.has(next)
    ? null
    : next;
}

export type FinalAnswer = Readonly<{ id: string; text: string }>;

/** Fold one items page into the single explicit final answer, or null when unverified. */
export function foldFinalAnswer(
  data: ReadonlyArray<unknown>,
  turnId: string,
  initial: FinalAnswer | null,
): Readonly<{ final: FinalAnswer | null }> | null {
  let final = initial;
  for (const value of data) {
    const entry = object(value);
    const item = object(entry?.item);
    if (entry?.turnId !== turnId || !item || !identifier(item.id)) return null;
    if (item.type === "agentMessage" && item.phase === "final_answer") {
      if (
        final !== null ||
        typeof item.text !== "string" ||
        item.text.length === 0 ||
        item.text.length > 256 * 1024
      )
        return null;
      final = { id: item.id, text: item.text };
    }
  }
  return { final };
}
