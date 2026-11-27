import { z } from "zod";
import { TaskModelBindingSchema } from "../../../../pkg/owner-config/contract";
import type { HandoffRecord } from "../../app/service/persistent-codex-handoff";
import { validKey } from "./journallayout";

const PreferencePath = z
  .string()
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
export const ProjectPreferenceRecordSchema = z.strictObject({
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/u),
  project: z.strictObject({
    root: PreferencePath,
    device: z.string().regex(/^[0-9]+$/u),
    inode: z.string().regex(/^[0-9]+$/u),
    gitCommonDirectory: PreferencePath,
  }),
});

export const ProjectPreferenceSelectionSchema = z.strictObject({
  key: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    ),
});

const CatalogueObservationSchema = z.strictObject({
  modelId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[^\s\u0000-\u001f\u007f]+$/u),
  observedAt: z.number().int().nonnegative().safe(),
  scope: z
    .string()
    .min(1)
    .max(240)
    .regex(/^[^\s\u0000-\u001f\u007f]+$/u),
});

export const DispatchAttemptSchema = z.strictObject({
  attempt: z.number().int().min(0).max(31),
});
export const MAX_DISPATCH_ATTEMPTS = 32;

/** The reservation fields persisted at reserve time, before any progress record. */
export type ReservationRecord = Omit<
  HandoffRecord,
  "threadIntent" | "turnIntent" | "threadId" | "turnId"
>;

export function stringRecord(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,120}$/u.test(value)) {
    throw new Error("HANDOFF_JOURNAL_INVALID");
  }
  return value;
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function isRecordObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored message/title intent: a valid key plus a sha256 hex digest. */
export function isIntentBinding(
  value: Record<string, unknown>,
): value is { key: string; digest: string } {
  return validKey(String(value.key)) && isDigest(value.digest);
}

/** Validate the stored reservation exactly as written by `reserve`. */
export function parseReservation(base: unknown): ReservationRecord {
  if (typeof base !== "object" || Array.isArray(base)) {
    throw new Error("HANDOFF_JOURNAL_INVALID");
  }
  const record = base as Partial<HandoffRecord>;
  if (
    typeof record.requestDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.requestDigest) ||
    (record.adopted !== undefined && record.adopted !== true) ||
    (record.model !== undefined &&
      (typeof record.model !== "string" ||
        !/^[A-Za-z0-9_.\/-]{1,120}$/u.test(record.model))) ||
    (record.continuedFrom !== undefined &&
      (typeof record.continuedFrom !== "string" ||
        !validKey(record.continuedFrom))) ||
    record.continuationVerified !== undefined ||
    (record.dispatchProtocol !== undefined && record.dispatchProtocol !== 1) ||
    (record.reasoningEffort !== undefined &&
      (typeof record.reasoningEffort !== "string" ||
        !/^[A-Za-z0-9_-]{1,40}$/u.test(record.reasoningEffort))) ||
    typeof record.workspaceId !== "string" ||
    typeof record.projectId !== "string" ||
    !record.workspace ||
    typeof record.workspace.root !== "string" ||
    typeof record.workspace.device !== "string" ||
    typeof record.workspace.inode !== "string" ||
    typeof record.workspace.gitCommonDirectory !== "string" ||
    !record.workspace.project ||
    typeof record.workspace.project.root !== "string" ||
    typeof record.workspace.project.device !== "string" ||
    typeof record.workspace.project.inode !== "string" ||
    typeof record.workspace.project.gitCommonDirectory !== "string" ||
    record.workspace.project.gitCommonDirectory !==
      record.workspace.gitCommonDirectory ||
    !record.workspace.execution ||
    !["read-only", "workspace-write"].includes(
      record.workspace.execution.sandbox,
    ) ||
    !["untrusted", "on-request"].includes(
      record.workspace.execution.approvalPolicy,
    )
  ) {
    throw new Error("HANDOFF_JOURNAL_INVALID");
  }
  if (
    record.modelCatalogue !== undefined &&
    !CatalogueObservationSchema.safeParse(record.modelCatalogue).success
  )
    throw new Error("HANDOFF_JOURNAL_CATALOGUE_INVALID");
  if (record.modelBinding !== undefined) {
    const binding = TaskModelBindingSchema.safeParse(record.modelBinding);
    if (
      !binding.success ||
      binding.data.selection.harness !== "codex" ||
      binding.data.selection.model !== record.model ||
      binding.data.selection.effort !== record.reasoningEffort
    ) {
      throw new Error("HANDOFF_JOURNAL_MODEL_BINDING_INVALID");
    }
  }
  return record as ReservationRecord;
}
