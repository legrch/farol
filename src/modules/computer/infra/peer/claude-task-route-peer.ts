import {
  ClaudeTaskCreateSchema,
  ClaudeTaskStatusSchema,
  type ClaudeTaskRoute,
} from "../../../chat/contract/claude-task-route";
export type ClaudeTaskRoutePeer = ClaudeTaskRoute;
export function parseClaudeCreate(value: unknown, key: string) {
  const parsed = ClaudeTaskCreateSchema.safeParse(value);
  return parsed.success &&
    (parsed.data.status === "refused" ||
      parsed.data.dispatchId === key.toLowerCase())
    ? parsed.data
    : { status: "outcome_unknown" as const, dispatchId: key.toLowerCase() };
}
export function parseClaudeStatus(value: unknown, key: string) {
  const parsed = ClaudeTaskStatusSchema.safeParse(value);
  return parsed.success &&
    (parsed.data.status === "refused" ||
      parsed.data.status === "unknown" ||
      parsed.data.dispatchId === key.toLowerCase())
    ? parsed.data
    : { status: "outcome_unknown" as const, dispatchId: key.toLowerCase() };
}
