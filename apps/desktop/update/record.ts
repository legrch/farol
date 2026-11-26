import { z } from "zod";

// The on-disk update records: preferences, notices, the journal, receipts and
// intents, with the pure comparators over them. These shapes are the stored
// format that earlier installed builds also read, so strictness, literals and
// limits are part of the contract. Nothing here touches the disk.

export const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const UpdatePreferences = z.strictObject({
  schema: z.literal("farol.installed-update-preferences/1"),
  skipped: z
    .strictObject({ version: z.string().max(128), buildId: Digest })
    .nullable(),
  deferredVersion: z.string().max(128).nullable().optional(),
});
// Keep the strict legacy Skip/Later record readable by prior installed builds.
// Notice preferences share this release owner, root and guarded record I/O.
export const NoticePreferences = z.strictObject({
  schema: z.literal("farol.installed-update-notices/1"),
  seenVersion: z.string().max(128).nullable().optional(),
  failureNotice: z
    .strictObject({
      version: z.string().max(128).nullable(),
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/u),
      key: z.string().regex(/^failure:[a-f0-9]{24}$/u),
      seen: z.boolean(),
    })
    .nullable()
    .optional(),
});
// Separate file/schema: older strict Skip/Later and notice readers stay compatible.
export const AutomaticUpdatePreferences = z.discriminatedUnion("schema", [
  z.strictObject({
    schema: z.literal("farol.installed-automatic-update-preference/1"),
    enabled: z.boolean(),
  }),
  z.strictObject({
    schema: z.literal("farol.installed-automatic-update-preference/2"),
    scope: z.literal("download-and-install"),
    enabled: z.boolean(),
  }),
]);
export const InstallOnQuitPreferences = z.strictObject({
  schema: z.literal("farol.installed-install-on-quit-preference/1"),
  scope: z.literal("install-on-normal-quit"),
  enabled: z.boolean(),
});
// A separately scoped write fence survives a lost preference-write ACK. A fresh
// owner must not infer consent from possibly committed, valid-looking bytes.
export const InstallOnQuitUnconfirmed = z.strictObject({
  schema: z.literal("farol.installed-install-on-quit-unconfirmed/1"),
  enabled: z.boolean(),
});
export const AcceptedBuild = z.strictObject({
  digest: Digest,
  version: z.string().max(128),
  buildId: Digest,
});
export const PromotionReceipt = z.strictObject({
  schema: z.literal("farol.promotion-plan/1"),
  operation: z.literal("applied"),
  product: z.literal("Farol"),
  version: z.string().max(128),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceTreeDigest: Digest,
  sourceDirty: z.literal(false),
  artifactSha256: Digest,
  source: z.string().max(4096),
  destination: z.string().max(4096),
  receipt: z.string().max(4096),
  overwrite: z.literal(false),
  legacyMutation: z.literal(false),
  activation: z.strictObject({
    userData: z.string().max(4096),
    drained: z.literal(true),
    obligations: z.array(z.never()).length(0),
  }),
  verifiedDestinationSha256: Digest,
});
// A cold repair is a distinct installer result, never a synthetic live-update receipt.
export const ClosedRepairReceipt = z.strictObject({
  schema: z.literal("farol.closed-repair/1"),
  operationId: z.string().regex(/^[a-f0-9]{32}$/u),
  phase: z.enum(["installed", "rolled_back"]),
  destination: z.string().max(4096),
  userData: z.string().max(4096),
  source: AcceptedBuild,
  target: AcceptedBuild,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceTreeDigest: Digest,
  sourceDirty: z.literal(false),
  previous: z.string().max(4096),
  quarantine: z.string().max(4096),
  quarantined: z.boolean(),
  quitDigest: Digest,
});
export const RepairInode = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
export const ClosedRepairJournal = z.strictObject({
  schema: z.literal("farol.closed-repair-journal/1"),
  phase: z.enum(["installed", "rolled_back"]),
  receipt: ClosedRepairReceipt,
  sourceInode: RepairInode,
  targetInode: RepairInode,
  updatesInode: RepairInode.nullable(),
});
export const Operation = z.strictObject({
  operationId: z.string().regex(/^[a-f0-9]{32}$/u),
  source: AcceptedBuild,
  target: AcceptedBuild,
});
export const Retained = z.strictObject({
  schema: z.literal("farol.ready-update/1"),
  handle: z.string().max(4096),
  manifest: z.unknown(),
  notes: z.string().max(4096).optional(),
  operation: Operation.nullable(),
  downloadId: z
    .string()
    .regex(/^[a-f0-9]{32}$/u)
    .optional(),
  preparation: Operation.optional(),
  archiveReleased: z.boolean().optional(),
  helper: z
    .strictObject({
      pid: z.number().int().min(2),
      processStart: z.string().min(1).max(128).nullable(),
    })
    .nullable()
    .optional(),
});
export const DownloadStage = z.strictObject({
  phase: z.enum(["downloading", "verifying"]).optional(),
  id: z.string().regex(/^[a-f0-9]{32}$/u),
  producer: z.strictObject({
    pid: z.number().int().min(2),
    processStart: z.string().min(1).max(128),
  }),
  identity: z
    .strictObject({
      dev: z.string().regex(/^[0-9]{1,30}$/u),
      ino: z.string().regex(/^[0-9]{1,30}$/u),
      birthtimeNs: z.string().regex(/^[0-9]{1,30}$/u),
    })
    .optional(),
});
export const DownloadIntent = z.strictObject({
  schema: z.literal("farol.update-download-intent/1"),
  download: DownloadStage.optional(),
  buildId: Digest,
  archiveSha256: Digest,
});
export const Journal = Operation.extend({
  schema: z.literal("farol.installed-update-journal/1"),
  phase: z.enum([
    "prepared",
    "predecessor_saved",
    "new_installed",
    "verified",
    "rollback_started",
    "rolled_back",
    "launch_requested",
    "completed",
    "cancelled",
    "cancel_launch_requested",
    "cancel_completed",
    "rollback_launch_requested",
    "rollback_completed",
  ]),
});
export const SavedReceipt = Retained.extend({
  observedAt: z.string().max(64),
  phase: Journal.shape.phase,
  runningBuildId: Digest,
});
export const RestoreIntent = z.strictObject({
  schema: z.literal("farol.update-restore-intent/1"),
  action: z.enum(["recover", "rollback"]),
  operation: Operation,
  priorPhase: Journal.shape.phase,
  notStartedAt: AcceptedBuild.optional(),
  installedBefore: AcceptedBuild.optional(),
  helper: Retained.shape.helper,
});
export const ROLLED_BACK_PHASES = [
  "rolled_back",
  "rollback_launch_requested",
  "rollback_completed",
];
export const CANCELLED_PHASES = [
  "cancelled",
  "cancel_launch_requested",
  "cancel_completed",
];
export const TARGET_PHASES = ["verified", "launch_requested", "completed"];
export const MAX_RECORD_BYTES = 65536;
export const ProcessStart = z
  .string()
  .max(128)
  .regex(
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u,
  );
export const RelaunchHint = z.strictObject({
  operationId: Operation.shape.operationId,
  action: z.enum(["apply", "recover", "rollback"]),
  phase: z.enum(["completed", "cancel_completed", "rollback_completed"]),
  helper: z.strictObject({
    pid: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
    processStart: ProcessStart,
  }),
  buildId: Digest,
});
export const RELAUNCH_ARGUMENT = "--farol-installed-update-relaunch";

export function sameBuild(
  a: z.infer<typeof AcceptedBuild>,
  b: z.infer<typeof AcceptedBuild>,
): boolean {
  return (
    a.digest === b.digest && a.version === b.version && a.buildId === b.buildId
  );
}

export function sameOperation(
  a: z.infer<typeof Operation>,
  b: z.infer<typeof Operation>,
): boolean {
  return (
    a.operationId === b.operationId &&
    sameBuild(a.source, b.source) &&
    sameBuild(a.target, b.target)
  );
}
