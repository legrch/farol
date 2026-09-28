import type {
  CodexProjectCatalogueHost,
  ProjectCatalogueResult,
  ProjectMatch,
} from "../port/codex-project-catalogue";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function unavailable(code: string): ProjectCatalogueResult {
  return { status: "unavailable", complete: false, code };
}
function absolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 1 &&
    value.length <= 4096 &&
    value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("\\") &&
    value
      .split("/")
      .slice(1)
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          !/[\u0000-\u001f\u007f]/u.test(part),
      )
  );
}

// One bounded, complete catalogue read. Partial pages cannot prove absence.
// Only projects naming the approved canonical root are returned to the caller.
export async function resolveCodexProjectCatalogue(
  host: CodexProjectCatalogueHost,
  root: string,
  preferredProjectId?: string,
  deadlineAt?: number,
  isAdmitted?: () => boolean,
): Promise<ProjectCatalogueResult> {
  const matches: ProjectMatch[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 1; page <= 32; page++) {
    if (isAdmitted && !isAdmitted())
      return unavailable("HANDOFF_PROJECT_CATALOGUE_INTERRUPTED");
    let response;
    try {
      response = object(
        await host.request("project/list", { cursor, limit: 100 }, deadlineAt),
      );
    } catch {
      return unavailable("HANDOFF_PROJECT_CATALOGUE_UNAVAILABLE");
    }
    if (isAdmitted && !isAdmitted())
      return unavailable("HANDOFF_PROJECT_CATALOGUE_INTERRUPTED");
    if (
      !response ||
      !Array.isArray(response.data) ||
      response.data.length > 100
    )
      return unavailable("HANDOFF_PROJECT_CATALOGUE_INVALID");
    for (const raw of response.data) {
      const project = object(raw);
      if (
        !project ||
        typeof project.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,120}$/u.test(project.id) ||
        ids.has(project.id) ||
        !Array.isArray(project.roots) ||
        project.roots.some((rawRoot) => !absolutePath(object(rawRoot)?.path))
      )
        return unavailable("HANDOFF_PROJECT_CATALOGUE_INVALID");
      ids.add(project.id);
      if (project.roots.some((rawRoot) => object(rawRoot)?.path === root)) {
        if (
          project.name !== undefined &&
          (typeof project.name !== "string" || project.name.length > 200)
        )
          return unavailable("HANDOFF_PROJECT_CATALOGUE_INVALID");
        matches.push({
          projectId: project.id,
          name: typeof project.name === "string" ? project.name : null,
        });
        if (matches.length > 32)
          return unavailable("HANDOFF_PROJECT_MATCH_LIMIT");
      }
    }
    if (response.nextCursor === null || response.nextCursor === undefined) {
      matches.sort((a, b) => a.projectId.localeCompare(b.projectId));
      const requested =
        preferredProjectId === undefined
          ? null
          : matches.find((match) => match.projectId === preferredProjectId);
      const selected =
        preferredProjectId === undefined
          ? matches.length === 1
            ? matches[0]
            : null
          : requested;
      return {
        status: selected
          ? "resolved"
          : preferredProjectId !== undefined
            ? "stale_preference"
            : matches.length === 0
              ? "missing"
              : "ambiguous",
        complete: true,
        pages: page,
        matches,
        selectedProjectId: selected?.projectId ?? null,
        selection: selected
          ? preferredProjectId === undefined
            ? "unique-root"
            : "requested-id"
          : null,
      };
    }
    if (
      typeof response.nextCursor !== "string" ||
      response.nextCursor.length === 0 ||
      response.nextCursor.length > 4096 ||
      cursors.has(response.nextCursor)
    )
      return unavailable("HANDOFF_PROJECT_CATALOGUE_CURSOR_INVALID");
    cursor = response.nextCursor;
    cursors.add(cursor);
  }
  return unavailable("HANDOFF_PROJECT_CATALOGUE_PAGE_LIMIT");
}
