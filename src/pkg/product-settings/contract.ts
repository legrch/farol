import type { z } from "zod";
import { ProductConfigurationCommandSchema } from "./command.ts";
import {
  DiscoveryCandidateSchema,
  ProductConfigurationEvidenceSchema,
} from "./evidence.ts";
import { ProductConfigurationResultSchema } from "./result.ts";
import {
  ProductConfigurationSnapshotSchema,
  ProductGeneralSettingsSchema,
  ProductSettingsSchema,
} from "./settings.ts";
import { SecureMcpConnectorSchema } from "./connector.ts";
import { CodexHostSelectionSchema } from "./codex.ts";
import {
  ApprovedProductWorkspaceSchema,
  PendingWorkspaceEditDeliverySchema,
} from "./workspace.ts";
import { SetupStepIdSchema } from "./setup.ts";

export { WorkspaceAccessCheckIdSchema } from "./scalar.ts";
export {
  CodexAgentVerificationFieldsSchema,
  CodexHostSelectionSchema,
  CodexTaskSelectionSchema,
  CodexTaskSourceRecordSchema,
  CodexTaskSourceSchema,
} from "./codex.ts";
export type {
  CodexTaskSelection,
  CodexTaskSource,
  CodexTaskSourceRecord,
} from "./codex.ts";
export {
  ConnectorSetupReceiptSchema,
  SecureMcpAppSelectionSchema,
  SecureMcpConnectorSchema,
  SeparateAppVerificationScopeSchema,
} from "./connector.ts";
export type { SeparateAppVerificationScope } from "./connector.ts";
export {
  ApprovedProductWorkspaceSchema,
  PendingWorkspaceEditDeliverySchema,
  WorkspaceContinuitySchema,
  WorkspaceGitMetadataSchema,
  WorkspaceRootIdentitySchema,
} from "./workspace.ts";
export type {
  WorkspaceContinuity,
  WorkspaceGitMetadata,
  WorkspaceRootIdentity,
} from "./workspace.ts";
export {
  SetupReadinessSchema,
  SetupStepIdSchema,
  SetupVerificationSchema,
} from "./setup.ts";
export {
  ProductConfigurationSnapshotSchema,
  ProductGeneralSettingsSchema,
  ProductSettingsSchema,
} from "./settings.ts";
export { ProductConfigurationCommandSchema } from "./command.ts";
export { ProductConfigurationEvidenceSchema } from "./evidence.ts";
export { ProductConfigurationResultSchema } from "./result.ts";

export type ProductGeneralSettings = z.infer<
  typeof ProductGeneralSettingsSchema
>;
export type ApprovedProductWorkspace = z.infer<
  typeof ApprovedProductWorkspaceSchema
>;
export type CodexHostSelection = z.infer<typeof CodexHostSelectionSchema>;
export type SecureMcpConnector = z.infer<typeof SecureMcpConnectorSchema>;
export type SetupStepId = z.infer<typeof SetupStepIdSchema>;
export type ProductSettings = z.infer<typeof ProductSettingsSchema>;
export type PendingWorkspaceEditDelivery = z.infer<
  typeof PendingWorkspaceEditDeliverySchema
>;
export type ProductConfigurationSnapshot = z.infer<
  typeof ProductConfigurationSnapshotSchema
>;
export type ProductConfigurationCommand = z.infer<
  typeof ProductConfigurationCommandSchema
>;
export type ProductConfigurationEvidence = z.infer<
  typeof ProductConfigurationEvidenceSchema
>;
export type ProductDiscoveryCandidate = z.infer<
  typeof DiscoveryCandidateSchema
>;
export type ProductConfigurationResult = z.infer<
  typeof ProductConfigurationResultSchema
>;
