import { z } from "zod";
const Id = z.string().uuid();
const Code = z.string().regex(/^[A-Z][A-Z0-9_]{0,119}$/u);
const Refused = z.strictObject({ status: z.literal("refused"), code: Code });
const Unknown = z.strictObject({
  status: z.literal("outcome_unknown"),
  dispatchId: Id,
});
export const ClaudeTaskCreateSchema = z.union([
  Refused,
  Unknown,
  z
    .strictObject({
      status: z.literal("dispatched"),
      dispatchId: Id,
      sessionId: Id,
      evidence: z.literal("local-process-start"),
      nativeVisibility: z.literal("not-qualified"),
    })
    .refine((v) => v.dispatchId === v.sessionId),
]);
export const ClaudeTaskStatusSchema = z.union([
  Refused,
  Unknown,
  z.strictObject({ status: z.literal("unknown") }),
  z
    .strictObject({
      status: z.literal("known"),
      dispatchId: Id,
      sessionId: Id,
      lifecycle: z.enum(["running", "completed", "failed", "needs_input"]),
      actualModel: z.string().min(1).max(120),
      configuredModel: z.string().min(1).max(120),
      proof: z.enum(["local-process", "recorded-terminal"]),
      nativeVisibility: z.literal("not-qualified"),
      text: z
        .string()
        .refine(
          (v) =>
            !v.includes("\0") &&
            new TextEncoder().encode(v).byteLength <= 32768,
        ),
      exitCode: z.number().int().min(0).max(1).nullable(),
    })
    .refine(
      (v) =>
        v.dispatchId === v.sessionId &&
        v.actualModel === v.configuredModel &&
        (v.lifecycle === "running"
          ? v.proof === "local-process" && v.exitCode === null && v.text === ""
          : v.proof === "recorded-terminal" &&
            v.exitCode !== null &&
            (v.lifecycle === "failed" || v.exitCode === 0)),
    ),
]);
export interface ClaudeTaskRoute {
  create(
    request: Readonly<{
      key: string;
      workspaceId: string;
      projectId: string;
      message: string;
      harness?: string | undefined;
      model?: string | undefined;
      effort?: string | undefined;
    }>,
  ): Promise<z.infer<typeof ClaudeTaskCreateSchema>>;
  status(dispatchId: string): Promise<z.infer<typeof ClaudeTaskStatusSchema>>;
}

/** Consumer-owned process port, implemented by the existing Computer sandbox. */
export interface ClaudeCommandRunner {
  start(
    request: Readonly<{
      key: string;
      workspaceId: string;
      command: string;
      stdin: string;
      deadlineAt: number;
    }>,
  ): Promise<string>;
  read(handle: string): Promise<
    Readonly<{
      state: "running" | "exited";
      stdout: string;
      exitCode: number | null;
      exitSignal: string | null;
      groupCleanup: "pending" | "confirmed" | "unverified";
      truncated: boolean;
      interrupted: boolean;
    }>
  >;
}
