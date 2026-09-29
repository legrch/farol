export type CodexCatalogueModel = Readonly<{
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  supportedEfforts: readonly string[];
  defaultEffort?: string | undefined;
}>;

export type CodexModelCatalogueResult =
  | Readonly<{
      status: "ready";
      source: "model/list";
      // A local connection epoch, never proof of account or Desktop identity.
      scope: string;
      observedAt: number;
      models: readonly CodexCatalogueModel[];
    }>
  | Readonly<{
      status: "unavailable";
      code:
        | "TASK_MODEL_CATALOG_UNAVAILABLE"
        | "TASK_MODEL_CATALOG_INVALID"
        | "TASK_MODEL_CATALOG_INCOMPLETE"
        | "TASK_MODEL_CATALOG_AMBIGUOUS"
        | "TASK_MODEL_CATALOG_CHANGED";
    }>;

export type CodexModelCheck =
  | Readonly<{
      status: "available";
      model: CodexCatalogueModel;
      effort?: string | undefined;
      observedAt: number;
      scope: string;
    }>
  | Readonly<{
      status: "refused";
      code: string;
      configuredModel: string;
      configuredEffort?: string | undefined;
      available: "yes" | "no" | "unknown";
      availableModels: readonly CodexCatalogueModel[];
    }>;

export interface CodexModelCatalogueHost {
  request(
    method: string,
    params: unknown,
    deadlineAt?: number,
  ): Promise<unknown>;
  /** Changes on reconnect, login/account notification, or loss of this client. */
  modelCatalogueScope?(): string;
}

export interface CodexModelCatalogue {
  read(
    options?: Readonly<{
      fresh?: boolean;
      deadlineAt?: number;
      signal?: AbortSignal | undefined;
    }>,
  ): Promise<CodexModelCatalogueResult>;
  check(
    model: string,
    effort: string | undefined,
    options?: Readonly<{
      deadlineAt?: number;
      // New dispatch resolves an omitted effort once. Legacy continuation does not.
      resolveDefault?: boolean;
      signal?: AbortSignal | undefined;
    }>,
  ): Promise<CodexModelCheck>;
  isCurrent(scope: string, observedAt: number): boolean;
  invalidate(): void;
}
