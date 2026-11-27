import { z } from "zod";
import { CHATGPT_MODEL_ID } from "../../../../pkg/model-route/contract";

export const boundedId = z.string().min(1).max(200);

export const threadStartSchema = z
  .object({
    model: z.enum(["gpt-6-astra", CHATGPT_MODEL_ID]),
    thread: z
      .object({
        id: boundedId,
        parentThreadId: boundedId.nullable().optional(),
        modelProvider: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const turnStartSchema = z
  .object({
    turn: z
      .object({
        id: boundedId,
        status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
      })
      .passthrough(),
  })
  .passthrough();

export const collabItemSchema = z
  .object({
    id: boundedId,
    type: z.literal("collabAgentToolCall"),
    tool: z.enum([
      "spawnAgent",
      "sendInput",
      "resumeAgent",
      "wait",
      "closeAgent",
      "sendMessage",
      "followupTask",
      "interruptAgent",
      "listAgents",
    ]),
    status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
    senderThreadId: boundedId,
    receiverThreadIds: z.array(boundedId).max(16),
    agentsStates: z.record(z.string(), z.unknown()),
    model: z.string().nullable().optional(),
    prompt: z
      .string()
      .max(128 * 1_024)
      .nullable()
      .optional(),
  })
  .passthrough();

export const itemCompletedSchema = z
  .object({
    threadId: boundedId,
    turnId: boundedId,
    item: collabItemSchema,
  })
  .passthrough();

export const turnCompletedSchema = z
  .object({
    threadId: boundedId,
    turn: z
      .object({
        id: boundedId,
        status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
      })
      .passthrough(),
  })
  .passthrough();

export const authorityArgumentsSchema = z.strictObject({
  assignmentId: boundedId,
  authorityId: boundedId,
  participantId: boundedId,
  role: z.enum(["agent", "critic"]),
  proof: z.string().min(1).max(200),
});

export const workspaceArgumentsSchema = z.strictObject({
  assignmentId: boundedId,
  authorityId: boundedId,
  participantId: boundedId,
  proof: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const relativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => {
    if (value === ".") return true;
    return (
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== "..") &&
      [...value].every((character) => {
        const code = character.codePointAt(0);
        return code !== undefined && code >= 32 && code !== 127;
      })
    );
  });

export const computerOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("workspace.read"),
    relativePath: relativePathSchema.refine((value) => value !== "."),
    range: z
      .strictObject({
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        length: z
          .number()
          .int()
          .min(4)
          .max(256 * 1_024),
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("workspace.list"),
    relativePath: relativePathSchema,
  }),
  z.strictObject({
    kind: z.literal("workspace.search"),
    relativePath: relativePathSchema,
    pattern: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) =>
        [...value].every((character) => {
          const code = character.codePointAt(0);
          return code !== undefined && code >= 32 && code !== 127;
        }),
      ),
  }),
  z.strictObject({
    kind: z.literal("verification.run"),
    command: z.enum(["git.status", "git.head"]),
    relativePath: z.literal("."),
  }),
]);

export const computerArgumentsSchema = z.strictObject({
  assignmentId: boundedId,
  authorityId: boundedId,
  participantId: boundedId,
  proof: z.string().regex(/^[a-f0-9]{64}$/u),
  workspaceId: boundedId,
  operation: computerOperationSchema,
});

export const authorityCallSchema = z.strictObject({
  threadId: boundedId,
  turnId: boundedId,
  callId: boundedId,
  namespace: z.string().nullable().optional(),
  tool: z.literal("farol_agent_authority"),
  arguments: authorityArgumentsSchema,
});

export const workspaceCallSchema = z.strictObject({
  threadId: boundedId,
  turnId: boundedId,
  callId: boundedId,
  namespace: z.string().nullable().optional(),
  tool: z.literal("farol_agent_workspace_probe"),
  arguments: workspaceArgumentsSchema,
});

export const computerCallSchema = z.strictObject({
  threadId: boundedId,
  turnId: boundedId,
  callId: boundedId,
  namespace: z.string().nullable().optional(),
  tool: z.literal("farol_agent_computer"),
  arguments: computerArgumentsSchema,
});

export const dynamicToolItemSchema = z
  .object({
    id: boundedId,
    type: z.literal("dynamicToolCall"),
    tool: z.literal("farol_agent_authority"),
    status: z.enum(["inProgress", "completed", "failed"]),
    success: z.boolean().nullable().optional(),
    arguments: authorityArgumentsSchema,
  })
  .passthrough();

export const workspaceDynamicToolItemSchema = z
  .object({
    id: boundedId,
    type: z.literal("dynamicToolCall"),
    tool: z.literal("farol_agent_workspace_probe"),
    status: z.enum(["inProgress", "completed", "failed"]),
    success: z.boolean().nullable().optional(),
    arguments: workspaceArgumentsSchema,
  })
  .passthrough();

export const computerDynamicToolItemSchema = z
  .object({
    id: boundedId,
    type: z.literal("dynamicToolCall"),
    tool: z.literal("farol_agent_computer"),
    status: z.enum(["inProgress", "completed", "failed"]),
    success: z.boolean().nullable().optional(),
    arguments: computerArgumentsSchema,
  })
  .passthrough();

export const historyItemSchema = z.union([
  collabItemSchema,
  dynamicToolItemSchema,
  workspaceDynamicToolItemSchema,
  computerDynamicToolItemSchema,
]);

export const historyTurnSchema = z
  .object({
    id: boundedId,
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    items: z.array(z.unknown()),
  })
  .passthrough();

// Candidate evidence requirement follows the existing retainedThreadSchema in
// src/apps/desktop/codex-chatgpt-host-route.ts, not an attested host capability.
// inspectCodexHostContract does not verify that ThreadReadResponse exposes model
// or modelProvider, and Agent's persisted correlation has no admitted route
// binding. Neutral recovery remains unavailable for production composition
// until genuine host-contract evidence establishes these fields for both
// parent and child. Missing metadata is refused; fixtures cannot close this gap.
export const threadReadSchema = z
  .object({
    thread: z
      .object({
        id: boundedId,
        model: z.unknown().optional(),
        modelProvider: z.unknown().optional(),
        parentThreadId: boundedId.nullable().optional(),
        agentRole: z.string().min(1).max(200).nullable().optional(),
        source: z.unknown(),
        status: z
          .object({
            type: z.enum(["notLoaded", "idle", "systemError", "active"]),
          })
          .passthrough(),
        turns: z.array(historyTurnSchema),
      })
      .passthrough(),
  })
  .passthrough();

export type ThreadSnapshot = z.infer<typeof threadReadSchema>["thread"];

export function parseHistoryItems(turn: z.infer<typeof historyTurnSchema>) {
  return turn.items.flatMap((candidate) => {
    const parsed = historyItemSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}
