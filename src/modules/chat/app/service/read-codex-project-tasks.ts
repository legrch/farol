import type {
  CodexProjectTasksHost,
  ProjectTaskMetadata,
  ProjectTasksRequest,
  ProjectTasksResult,
} from "../port/codex-project-tasks";

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/u.test(value);
const cursor = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const nullableText = (
  value: unknown,
  max: number,
): value is string | null | undefined =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.length <= max && !value.includes("\0"));
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );

/** One stored metadata page; it neither chooses a thread nor grants control. */
export async function readCodexProjectTasks(
  host: CodexProjectTasksHost,
  request: ProjectTasksRequest,
  context: Readonly<{ deadlineAt: number; admitted: () => boolean }>,
): Promise<ProjectTasksResult> {
  const unavailable = (code: string): ProjectTasksResult => ({
    status: "unavailable",
    code,
  });
  if (
    !identifier(request.projectId) ||
    typeof request.writerRoot !== "string" ||
    request.writerRoot.length > 4096 ||
    !request.writerRoot.startsWith("/") ||
    request.writerRoot.endsWith("/") ||
    request.writerRoot.includes("\\") ||
    request.writerRoot
      .split("/")
      .slice(1)
      .some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          /[\u0000-\u001f\u007f]/u.test(part),
      ) ||
    (request.cursor !== undefined && !cursor(request.cursor))
  )
    return unavailable("HANDOFF_PROJECT_TASKS_INPUT_INVALID");
  if (!context.admitted())
    return unavailable("HANDOFF_PROJECT_TASKS_ADMISSION_DENIED");
  try {
    const page = object(
      await host.request(
        "thread/list",
        {
          projectId: request.projectId,
          cwd: request.writerRoot,
          cursor: request.cursor ?? null,
          limit: 50,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived: false,
          useStateDbOnly: true,
        },
        context.deadlineAt,
      ),
    );
    if (!context.admitted())
      return unavailable("HANDOFF_PROJECT_TASKS_ADMISSION_DENIED");
    if (
      !page ||
      !Array.isArray(page.data) ||
      page.data.length > 50 ||
      (page.nextCursor !== undefined &&
        page.nextCursor !== null &&
        (!cursor(page.nextCursor) || page.nextCursor === request.cursor))
    )
      return unavailable("HANDOFF_PROJECT_TASKS_UNVERIFIED");
    const tasks: ProjectTaskMetadata[] = [];
    const seen = new Set<string>();
    let bytes = 0;
    for (const value of page.data) {
      const row = object(value);
      if (
        !row ||
        !uuid(row.id) ||
        seen.has(row.id.toLowerCase()) ||
        row.projectId !== request.projectId ||
        row.cwd !== request.writerRoot ||
        !nullableText(row.name, 1000) ||
        !nullableText(row.model, 120) ||
        typeof row.updatedAt !== "number" ||
        !Number.isSafeInteger(row.updatedAt) ||
        row.updatedAt < 0
      )
        return unavailable("HANDOFF_PROJECT_TASKS_UNVERIFIED");
      seen.add(row.id.toLowerCase());
      const title = row.name ?? null;
      const configuredModel = row.model ?? null;
      bytes +=
        new TextEncoder().encode(title ?? "").byteLength +
        new TextEncoder().encode(configuredModel ?? "").byteLength;
      if (bytes > 32768) return unavailable("HANDOFF_PROJECT_TASKS_UNVERIFIED");
      // Deliberately omit prompt preview, transcript, runtime state and local paths.
      tasks.push({
        id: row.id,
        title,
        configuredModel,
        updatedAt: row.updatedAt,
      });
    }
    const nextCursor =
      typeof page.nextCursor === "string" ? page.nextCursor : null;
    return {
      status: "tasks",
      source: "stored",
      snapshot: "non-atomic",
      scope: "selected-writer",
      coverage: "single-page-metadata",
      controlGranted: false,
      tasks,
      nextCursor,
      complete: request.cursor === undefined && nextCursor === null,
    };
  } catch {
    return unavailable("HANDOFF_PROJECT_TASKS_UNAVAILABLE");
  }
}
