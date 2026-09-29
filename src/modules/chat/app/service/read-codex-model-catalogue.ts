import type {
  CodexCatalogueModel,
  CodexModelCatalogue,
  CodexModelCatalogueHost,
  CodexModelCatalogueResult,
  CodexModelCheck,
} from "../port/codex-model-catalogue";

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const DISPLAY_CACHE_MS = 60_000;
const MAX_READ_MS = 20_000;
const token = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u0020\u007f]/u.test(value);
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function parseModel(value: unknown): CodexCatalogueModel | null {
  const row = object(value);
  if (
    !row ||
    !token(row.id, 160) ||
    !token(row.model, 120) ||
    !/^[A-Za-z0-9_.\/-]+$/u.test(row.model) ||
    typeof row.displayName !== "string" ||
    row.displayName.length > 240 ||
    /[\u0000-\u001f\u007f]/u.test(row.displayName) ||
    typeof row.hidden !== "boolean" ||
    !Array.isArray(row.supportedReasoningEfforts) ||
    row.supportedReasoningEfforts.length > 32
  )
    return null;
  const efforts: string[] = [];
  for (const raw of row.supportedReasoningEfforts) {
    const option = object(raw);
    if (
      !option ||
      !token(option.reasoningEffort, 40) ||
      !/^[A-Za-z0-9_-]+$/u.test(option.reasoningEffort) ||
      efforts.includes(option.reasoningEffort)
    )
      return null;
    efforts.push(option.reasoningEffort);
  }
  const defaultEffort = row.defaultReasoningEffort;
  if (
    defaultEffort !== undefined &&
    defaultEffort !== null &&
    (!token(defaultEffort, 40) || !efforts.includes(defaultEffort))
  )
    return null;
  // An effort-capable catalogue must tell us its suggested default. Do not guess.
  if (
    efforts.length > 0 &&
    (defaultEffort === undefined || defaultEffort === null)
  )
    return null;
  return Object.freeze({
    id: row.id,
    model: row.model,
    displayName: row.displayName,
    hidden: row.hidden,
    supportedEfforts: Object.freeze(efforts),
    ...(typeof defaultEffort === "string" ? { defaultEffort } : {}),
  });
}

/** One instance belongs to one existing serving connection, never an independent daemon.
 * Display cache is not admission evidence. Every check issues a fresh bounded read.
 * model/list is the runtime's catalogue, not a guarantee of backend entitlement or quota.
 */
export class ReadCodexModelCatalogue implements CodexModelCatalogue {
  private cache: Extract<
    CodexModelCatalogueResult,
    { status: "ready" }
  > | null = null;
  private generation = 0;
  private sequence = 0;

  constructor(
    private readonly host: CodexModelCatalogueHost,
    private readonly now: () => number,
  ) {}

  isCurrent(scope: string, observedAt: number): boolean {
    const now = this.now();
    return (
      scope === this.scope() &&
      now >= observedAt &&
      now - observedAt < MAX_READ_MS
    );
  }

  invalidate(): void {
    this.generation++;
    this.cache = null;
  }

  private scope(): string {
    return `${this.generation}:${this.host.modelCatalogueScope?.() ?? "injected-host"}`;
  }

  async read(
    options: Readonly<{
      fresh?: boolean;
      deadlineAt?: number;
      signal?: AbortSignal | undefined;
    }> = {},
  ): Promise<CodexModelCatalogueResult> {
    const startedAt = this.now();
    const deadline = Math.min(
      options.deadlineAt ?? Infinity,
      startedAt + MAX_READ_MS,
    );
    const scope = this.scope();
    if (
      options.signal?.aborted ||
      (options.deadlineAt !== undefined &&
        (!Number.isSafeInteger(options.deadlineAt) ||
          options.deadlineAt < 0)) ||
      startedAt >= deadline
    )
      return { status: "unavailable", code: "TASK_MODEL_CATALOG_UNAVAILABLE" };
    if (
      !options.fresh &&
      this.cache &&
      this.cache.scope === scope &&
      startedAt >= this.cache.observedAt &&
      startedAt - this.cache.observedAt < DISPLAY_CACHE_MS
    )
      return this.cache;
    const sequence = ++this.sequence;
    const fail = (
      code: Extract<
        CodexModelCatalogueResult,
        { status: "unavailable" }
      >["code"],
    ): CodexModelCatalogueResult => {
      if (sequence === this.sequence) this.cache = null;
      return { status: "unavailable", code };
    };
    const models: CodexCatalogueModel[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (this.scope() !== scope) return fail("TASK_MODEL_CATALOG_CHANGED");
      if (options.signal?.aborted || this.now() >= deadline)
        return fail("TASK_MODEL_CATALOG_UNAVAILABLE");
      let response: Record<string, unknown> | null;
      try {
        response = object(
          await this.host.request(
            "model/list",
            {
              limit: PAGE_SIZE,
              includeHidden: true,
              ...(cursor === null ? {} : { cursor }),
            },
            deadline,
          ),
        );
      } catch {
        return fail("TASK_MODEL_CATALOG_UNAVAILABLE");
      }
      if (this.scope() !== scope) return fail("TASK_MODEL_CATALOG_CHANGED");
      if (options.signal?.aborted || this.now() >= deadline)
        return fail("TASK_MODEL_CATALOG_UNAVAILABLE");
      if (
        !response ||
        !Array.isArray(response.data) ||
        response.data.length > PAGE_SIZE
      )
        return fail("TASK_MODEL_CATALOG_INVALID");
      for (const raw of response.data) {
        const row = parseModel(raw);
        if (!row) return fail("TASK_MODEL_CATALOG_INVALID");
        if (ids.has(row.id) || names.has(row.model))
          return fail("TASK_MODEL_CATALOG_AMBIGUOUS");
        ids.add(row.id);
        names.add(row.model);
        models.push(row);
      }
      if (response.nextCursor === null || response.nextCursor === undefined) {
        const ready = Object.freeze({
          status: "ready" as const,
          source: "model/list" as const,
          scope,
          observedAt: this.now(),
          models: Object.freeze(models),
        });
        if (sequence === this.sequence) this.cache = ready;
        return ready;
      }
      if (!token(response.nextCursor, 4096) || cursors.has(response.nextCursor))
        return fail("TASK_MODEL_CATALOG_INVALID");
      cursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    return fail("TASK_MODEL_CATALOG_INCOMPLETE");
  }

  async check(
    model: string,
    effort: string | undefined,
    options: Readonly<{
      deadlineAt?: number;
      resolveDefault?: boolean;
      signal?: AbortSignal | undefined;
    }> = {},
  ): Promise<CodexModelCheck> {
    const catalogue = await this.read({
      fresh: true,
      signal: options.signal,
      ...(options.deadlineAt === undefined
        ? {}
        : { deadlineAt: options.deadlineAt }),
    });
    const refused = (
      code: string,
      available: "yes" | "no" | "unknown",
    ): CodexModelCheck => ({
      status: "refused",
      code,
      configuredModel: model,
      ...(effort === undefined ? {} : { configuredEffort: effort }),
      available,
      availableModels: catalogue.status === "ready" ? catalogue.models : [],
    });
    if (catalogue.status !== "ready") return refused(catalogue.code, "unknown");
    // model is the executable string. id/displayName/upgrade are never aliases.
    const selected = catalogue.models.find((entry) => entry.model === model);
    if (!selected) return refused("TASK_MODEL_UNAVAILABLE", "no");
    if (effort !== undefined && !selected.supportedEfforts.includes(effort))
      return refused("TASK_EFFORT_UNAVAILABLE", "yes");
    if (
      effort === undefined &&
      options.resolveDefault === false &&
      selected.supportedEfforts.length > 0
    )
      return refused("TASK_EFFORT_BINDING_UNKNOWN", "yes");
    const effectiveEffort =
      effort ??
      (options.resolveDefault === false ? undefined : selected.defaultEffort);
    return {
      status: "available",
      model: selected,
      ...(effectiveEffort === undefined ? {} : { effort: effectiveEffort }),
      observedAt: catalogue.observedAt,
      scope: catalogue.scope,
    };
  }
}
