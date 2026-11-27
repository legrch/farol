import { z } from "zod";
import { IdentifierSchema } from "./scalar.ts";
import {
  ApprovedProductWorkspaceSchema,
  PendingWorkspaceEditDeliverySchema,
} from "./workspace.ts";
import { CodexHostSelectionSchema, CodexTaskSelectionSchema } from "./codex.ts";
import {
  DefaultSecureMcpConnector,
  SecureMcpConnectorSchema,
} from "./connector.ts";
import { SetupReadinessSchema, SetupStepIdSchema } from "./setup.ts";

export const ProductGeneralSettingsSchema = z.strictObject({
  openAtLaunch: z.enum(["home", "browser", "computer", "activity", "settings"]),
  sidebarDefault: z.enum(["full", "rail"]),
  activityDetail: z.enum(["summary", "technical"]),
});

export const ProductSettingsSchema = z.strictObject({
  schema: z.literal(1),
  revision: z.number().int().positive(),
  general: ProductGeneralSettingsSchema,
  // Human-editable model policy lives in this existing document. Validate the
  // subsection at resolution so a malformed task policy cannot disable Computer.
  tasks: z.unknown().optional(),
  computer: z
    .strictObject({
      computerId: IdentifierSchema,
      generation: z.number().int().positive(),
      name: z.string().trim().min(1).max(80),
      commands: z.enum(["none", "verification", "workspace"]).default("none"),
      // Missing is the historical protected-files policy, never implicit consent.
      filePolicy: z.enum(["", "approved-roots-v1"]).optional(),
      workspaces: z.array(ApprovedProductWorkspaceSchema).max(64),
      pendingEdit: PendingWorkspaceEditDeliverySchema.nullable().default(null),
    })
    .superRefine((computer, context) => {
      for (const [index, workspace] of computer.workspaces.entries()) {
        if (
          workspace.continuity !== undefined &&
          workspace.continuity.computerId !== computer.computerId
        )
          context.addIssue({
            code: "custom",
            path: ["workspaces", index, "continuity", "computerId"],
            message: "continuity computer does not match owner Settings",
          });
      }
    }),
  nativeHosts: z
    .strictObject({
      generation: z.number().int().positive(),
      codex: CodexHostSelectionSchema.nullable(),
      taskRoute: CodexTaskSelectionSchema.nullable().default(null),
    })
    .default({ generation: 1, codex: null, taskRoute: null }),
  connectors: z
    .strictObject({
      secureMcp: SecureMcpConnectorSchema,
    })
    .default({ secureMcp: DefaultSecureMcpConnector }),
  setup: z.strictObject({
    journey: z
      .strictObject({
        currentStep: SetupStepIdSchema,
        dismissed: z.boolean(),
      })
      .default({ currentStep: "chatgpt", dismissed: false }),
    chatgpt: SetupReadinessSchema,
    computer: SetupReadinessSchema,
    connect: SetupReadinessSchema,
    hosts: SetupReadinessSchema,
    verify: SetupReadinessSchema,
  }),
});

export const ProductConfigurationSnapshotSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("ready"),
      settings: ProductSettingsSchema,
    }),
    z.strictObject({
      status: z.literal("error"),
      error: z.enum([
        "SETTINGS_CORRUPT",
        "CONFIG_RENAME_REQUIRED",
        "SETTINGS_UNSAFE",
        "SETTINGS_READ_FAILED",
      ]),
    }),
  ],
);
