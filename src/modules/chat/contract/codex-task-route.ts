import { z } from "zod";

const Identifier = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/u);
const AbsolutePath = z
  .string()
  .min(2)
  .max(4096)
  .refine(
    (value) =>
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
        ),
  );
const Match = z.strictObject({
  projectId: Identifier,
  name: z.string().max(200).nullable(),
});
const Known = z
  .strictObject({
    status: z.enum(["resolved", "missing", "ambiguous", "stale_preference"]),
    workspaceId: Identifier,
    writerRoot: AbsolutePath,
    projectRoot: AbsolutePath,
    complete: z.literal(true),
    pages: z.number().int().min(1).max(32),
    matches: z.array(Match).max(32).readonly(),
    selectedProjectId: Identifier.nullable(),
    selection: z.enum(["unique-root", "requested-id"]).nullable(),
  })
  .refine((value) => {
    if (
      new Set(value.matches.map((match) => match.projectId)).size !==
      value.matches.length
    )
      return false;
    if (value.status === "resolved")
      return (
        value.selectedProjectId !== null &&
        value.selection !== null &&
        value.matches.some(
          (match) => match.projectId === value.selectedProjectId,
        ) &&
        (value.selection !== "unique-root" || value.matches.length === 1)
      );
    return (
      value.selectedProjectId === null &&
      value.selection === null &&
      (value.status === "missing"
        ? value.matches.length === 0
        : value.status === "ambiguous"
          ? value.matches.length > 1
          : true)
    );
  });
export const CodexProjectResolutionSchema = z.union([
  Known,
  z.strictObject({
    status: z.literal("unavailable"),
    workspaceId: Identifier,
    writerRoot: AbsolutePath,
    projectRoot: AbsolutePath,
    complete: z.literal(false),
    code: Identifier,
  }),
  z.strictObject({
    status: z.literal("refused"),
    workspaceId: Identifier,
    code: Identifier,
  }),
]);
export type CodexProjectResolution = z.infer<
  typeof CodexProjectResolutionSchema
>;

const HistoryId = z.string().uuid();
const HistoryItem = z.union([
  z.strictObject({
    id: Identifier,
    kind: z.literal("user_message"),
    parts: z.array(z.string()).max(100).readonly(),
    omittedContent: z.number().int().min(0).max(100),
  }),
  z.strictObject({
    id: Identifier,
    kind: z.literal("agent_message"),
    text: z.string(),
    phase: z.enum(["commentary", "final_answer"]).nullable(),
  }),
  z.strictObject({
    id: Identifier,
    kind: z.literal("omitted"),
    type: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/u),
  }),
]);
export const CodexTaskHistorySchema = z.union([
  z
    .strictObject({
      status: z.literal("history"),
      source: z.literal("stored"),
      snapshot: z.literal("non-atomic"),
      coverage: z.literal("single-page-text-only"),
      threadId: HistoryId,
      turnId: HistoryId,
      turnStatus: z.enum(["inProgress", "completed", "failed", "interrupted"]),
      sortDirection: z.enum(["asc", "desc"]),
      items: z.array(HistoryItem).max(50).readonly(),
      nextCursor: z
        .string()
        .min(1)
        .max(4096)
        .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
        .nullable(),
      complete: z.boolean(),
    })
    .refine((value) => {
      const text = value.items.flatMap((item) =>
        item.kind === "user_message"
          ? item.parts
          : item.kind === "agent_message"
            ? [item.text]
            : [],
      );
      return (
        (!value.complete || value.nextCursor === null) &&
        new Set(value.items.map((item) => item.id)).size ===
          value.items.length &&
        text.every((part) => !part.includes("\0")) &&
        text.reduce(
          (bytes, part) => bytes + new TextEncoder().encode(part).byteLength,
          0,
        ) <= 32768
      );
    }),
  z.strictObject({
    status: z.enum(["refused", "unavailable"]),
    threadId: HistoryId,
    turnId: HistoryId,
    code: Identifier,
  }),
]);
export type CodexTaskHistory = z.infer<typeof CodexTaskHistorySchema>;

/** Published task route; a folder-read grant does not construct this port. */
export interface CodexTaskRoute {
  /** Read saved projects at the exact approved canonical root; no effects. */
  resolveProject?(
    request: Readonly<{
      workspaceId: string;
      preferredProjectId?: string | undefined;
    }>,
    context?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<CodexProjectResolution>;
  readonly observeEnabled?: boolean;
  /** Stored text-only history for the exact selected thread and turn; no effects. */
  history?(
    request: Readonly<{
      threadId: string;
      turnId: string;
      workspaceId: string;
      projectId: string;
      cursor?: string | undefined;
      tail?: boolean | undefined;
    }>,
    context?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<CodexTaskHistory>;
  /** Inspect only the exact owner-selected thread in the approved project. */
  observe?(
    request: Readonly<{
      threadId: string;
      workspaceId: string;
      projectId: string;
    }>,
  ): Promise<
    | Readonly<{
        status: "observed";
        threadId: string;
        title: string | null;
        model: string | null;
        turns: ReadonlyArray<Readonly<{ id: string; status: string }>>;
        hasMoreTurns: boolean;
      }>
    | Readonly<{ status: "refused"; code: string }>
    | Readonly<{ status: "outcome_unknown"; threadId: string }>
  >;
  /** Persist a read-only handle for one verified turn of the selected thread. */
  adopt?(
    request: Readonly<{
      threadId: string;
      turnId: string;
      workspaceId: string;
      projectId: string;
    }>,
  ): Promise<
    | Readonly<{ status: "adopted"; dispatchId: string }>
    | Readonly<{ status: "refused"; code: string }>
    | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
  >;
  /** Control is advertised only after the serving host is qualified. */
  readonly controlCapabilities?: Readonly<{
    message: boolean;
    continue?: boolean;
  }>;
  message(
    request: Readonly<{
      key: string;
      dispatchId: string;
      workspaceId: string;
      projectId: string;
      message: string;
      model: string;
      reasoningEffort?: string | undefined;
    }>,
  ): Promise<
    | Readonly<{ status: "steered"; dispatchId: string; turnId: string }>
    | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
    | Readonly<{ status: "refused"; code: string }>
  >;
  /** A new dispatch in the same verified thread; not a second task. */
  continue?(
    request: Readonly<{
      key: string;
      dispatchId: string;
      message: string;
    }>,
  ): ReturnType<CodexTaskRoute["create"]>;
  create(
    request: Readonly<{
      key: string;
      workspaceId: string;
      projectId: string;
      message: string;
      harness?: string | undefined;
      /** Configured alias, not a provider model identifier. */
      model?: string | undefined;
      effort?: string | undefined;
    }>,
  ): Promise<
    | Readonly<{
        status: "dispatched";
        dispatchId: string;
        threadId: string;
        turnId: string;
      }>
    | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
    | Readonly<{ status: "refused"; code: string }>
  >;
  status(dispatchId: string): Promise<
    | Readonly<{ status: "unknown" }>
    | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
    | Readonly<{
        status: "known";
        dispatchId: string;
        threadId: string;
        turnId: string;
        turnStatus: string;
      }>
  >;
  result(dispatchId: string): Promise<
    | Readonly<{ status: "unknown" }>
    | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
    | Readonly<{
        status: "running" | "failed" | "interrupted";
        dispatchId: string;
        threadId: string;
        turnId: string;
      }>
    | Readonly<{
        status: "completed";
        dispatchId: string;
        threadId: string;
        turnId: string;
        finalItemId: string;
        text: string;
      }>
  >;
}
