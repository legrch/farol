import type { HandoffHost } from "../port/handoff";
import { identifier, object } from "./handoffvalidation";

export async function exactProject(
  host: HandoffHost,
  projectId: string,
  root: string,
): Promise<boolean> {
  const matched: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 32; page += 1) {
    const response = object(
      await host.request("project/list", { cursor, limit: 100 }),
    );
    if (!response || !Array.isArray(response.data)) return false;
    for (const item of response.data) {
      const project = object(item);
      if (
        !project ||
        !identifier(project.id) ||
        !Array.isArray(project.roots)
      ) {
        return false;
      }
      if (project.roots.some((entry) => object(entry)?.path === root)) {
        matched.push(project.id);
      }
    }
    if (response.nextCursor === null || response.nextCursor === undefined) {
      return matched.length === 1 && matched[0] === projectId;
    }
    if (
      typeof response.nextCursor !== "string" ||
      response.nextCursor.length === 0 ||
      seen.has(response.nextCursor)
    ) {
      return false;
    }
    cursor = response.nextCursor;
    seen.add(cursor);
  }
  return false;
}
