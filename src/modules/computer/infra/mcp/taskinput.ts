import { z } from "zod";
import {
  TaskEffortSchema,
  TaskNameSchema,
} from "../../../../pkg/owner-config/contract";
import { IdentifierSchema } from "./fileinput";

export const DispatchIdSchema = z.string().uuid();
export const CodexTaskTextSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine((value) => !value.includes("\0"))
  .refine((value) => new TextEncoder().encode(value).byteLength <= 8_192);
export const CodexTaskCreateInputSchema = z.strictObject({
  key: DispatchIdSchema,
  workspaceId: IdentifierSchema,
  projectId: IdentifierSchema,
  message: CodexTaskTextSchema,
  harness: TaskNameSchema.optional(),
  model: TaskNameSchema.optional(),
  effort: TaskEffortSchema.optional(),
});
export const CodexProjectResolveInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  preferredProjectId: IdentifierSchema.optional(),
});
export const CodexProjectPreferenceInputSchema = z.strictObject({
  key: z.string().uuid(),
  workspaceId: IdentifierSchema,
  projectId: IdentifierSchema,
  operation: z.enum(["remember", "read"]),
});
export const CodexProjectTasksInputSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  projectId: IdentifierSchema,
  scope: z
    .enum(["selected-writer", "canonical-and-selected-writer"])
    .optional(),
  cursor: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
    .optional(),
});
export const CodexTaskReadInputSchema = z.strictObject({
  dispatchId: DispatchIdSchema,
});
export const CodexTaskObserveInputSchema = z.strictObject({
  threadId: DispatchIdSchema,
  workspaceId: IdentifierSchema,
  projectId: IdentifierSchema,
});
export const CodexTaskAdoptInputSchema = CodexTaskObserveInputSchema.extend({
  turnId: DispatchIdSchema,
});
export const CodexTaskHistoryInputSchema = CodexTaskAdoptInputSchema.extend({
  cursor: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
    .optional(),
  tail: z.boolean().optional(),
});
export const CodexTaskContinueInputSchema = z.strictObject({
  key: DispatchIdSchema,
  dispatchId: DispatchIdSchema,
  message: CodexTaskTextSchema,
});
export const CodexTaskMessageInputSchema = z.strictObject({
  key: DispatchIdSchema,
  dispatchId: DispatchIdSchema,
  workspaceId: IdentifierSchema,
  projectId: IdentifierSchema,
  message: CodexTaskTextSchema,
  model: z.string().min(1).max(120),
  reasoningEffort: z.string().min(1).max(40).optional(),
});
export const CodexTaskTitleInputSchema = z.strictObject({
  key: DispatchIdSchema,
  dispatchId: DispatchIdSchema,
  workspaceId: IdentifierSchema,
  projectId: IdentifierSchema,
  expectedTitle: z
    .string()
    .max(1000)
    .refine((value) => !value.includes("\0"))
    .nullable(),
  title: z
    .string()
    .min(1)
    .max(1000)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        !value.includes("\0") &&
        new TextEncoder().encode(value).byteLength <= 1000,
    ),
});
export const SavedChatCreateInputSchema = z.strictObject({
  key: DispatchIdSchema,
  title: z.string().min(1).max(80),
  firstMessage: z
    .string()
    .min(1)
    .max(8192)
    .refine((value) => !value.includes("\0"))
    .refine((value) => new TextEncoder().encode(value).byteLength <= 8192),
});
export const SavedChatStatusInputSchema = z.strictObject({
  dispatchId: DispatchIdSchema,
  recheck: z.boolean().optional(),
});
