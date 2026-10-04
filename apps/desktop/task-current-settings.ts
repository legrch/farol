import { resolveOwnerTaskModel } from "../../src/apps/desktop/owner-config.ts";
import {
  TaskExecutionSettingsSchema,
  taskPolicyIdentity,
} from "../../src/pkg/owner-config/contract.ts";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract.ts";
import { validate, type TaskCodexSource } from "./bridge/wire.ts";

// Trusted host mapping only. Saved source evidence issues no approval, Task
// admission, account or native qualification. Root supplies profile/host/scratch
// and validates its current Computer publication and physical restrictions.
const maximumGrantMs = 12 * 60 * 60 * 1000;
const positiveGeneration = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

/** Complete Task-relevant input for a pre-write comparison, with no clock. */
export function taskSettingsProjection(settings: ProductSettings): unknown {
  const parsed = ProductSettingsSchema.safeParse(settings);
  if (!parsed.success) return { status: "settings-invalid" };
  const s = parsed.data;
  const resolved = resolveOwnerTaskModel(s, { harness: "codex" });
  const policy = TaskExecutionSettingsSchema.safeParse(s.tasks);
  const route = s.nativeHosts.taskRoute;
  const host = s.nativeHosts.codex;
  const matches =
    route === null
      ? []
      : s.computer.workspaces.filter(
          (workspace) => workspace.workspaceId === route.workspaceId,
        );
  // Fixed keys and sorted set-like inputs make insertion order/UI edits inert.
  // Keep negative/missing evidence too: comparing only a positive DTO would
  // erase the metadata that must withdraw a retained Task source before save.
  return {
    status: "parsed",
    policyIdentity: policy.success ? taskPolicyIdentity(policy.data) : null,
    model:
      resolved.status === "ready"
        ? {
            status: resolved.status,
            configSha256: resolved.configSha256,
            harness: resolved.selection.harness,
            modelAlias: resolved.selection.modelAlias,
            model: resolved.selection.model,
            effort: resolved.selection.effort ?? null,
          }
        : { status: resolved.status },
    nativeHosts: {
      generation: s.nativeHosts.generation,
      route: route === null ? null : structuredClone(route),
      host:
        host === null
          ? null
          : {
              executablePath: host.executablePath,
              executableSha256: host.executableSha256,
              version: host.version,
              protocol: host.protocol,
              baseSchemaSha256: host.schemaSha256,
              localVerification: structuredClone(host.localVerification),
              taskSource: structuredClone(host.taskSource ?? null),
            },
    },
    computer: {
      computerId: s.computer.computerId,
      generation: s.computer.generation,
      selectedWorkspaceId: route?.workspaceId ?? null,
      unique: matches.length === 1,
      workspaces: matches
        .map((workspace) => ({
          workspaceId: workspace.workspaceId,
          root: workspace.root,
          access: workspace.access,
          rootIdentity: structuredClone(workspace.rootIdentity ?? null),
          gitMetadata: structuredClone(workspace.gitMetadata ?? null),
          excludedPaths: [...workspace.excludedPaths].sort(),
          gitHistoryApproved: workspace.gitHistoryApproved ?? null,
        }))
        .sort((a, b) => {
          const left = JSON.stringify(a),
            right = JSON.stringify(b);
          return left < right ? -1 : left > right ? 1 : 0;
        }),
    },
    setup: {
      verified: structuredClone(s.setup.computer.verified),
      reachable: s.setup.computer.reachable,
      outcomeUnknown: s.setup.computer.outcomeUnknown,
    },
  };
}

/** Project the exact saved Codex route; unavailable inputs stay absent. */
export function codexTaskCurrentSource(
  settings: ProductSettings,
  nowMs: number,
): TaskCodexSource | undefined {
  const parsed = ProductSettingsSchema.safeParse(settings);
  if (!parsed.success || !Number.isSafeInteger(nowMs)) return undefined;
  const s = parsed.data;
  const route = s.nativeHosts.taskRoute;
  const host = s.nativeHosts.codex;
  if (!route || !host || route.harness !== "codex") return undefined;
  const resolved = resolveOwnerTaskModel(s, { harness: "codex" });
  if (resolved.status !== "ready") return undefined;
  const matches = s.computer.workspaces.filter(
    (workspace) => workspace.workspaceId === route.workspaceId,
  );
  if (matches.length !== 1) return undefined;
  const workspace = matches[0]!;
  const verified = s.setup.computer.verified;
  const record = host.taskSource;
  const local = host.localVerification;
  if (
    !workspace.rootIdentity ||
    !workspace.gitMetadata ||
    !verified ||
    !record ||
    !local
  )
    return undefined;
  // Go Selection cannot enforce excluded paths or restricted Git visibility.
  // A pre-write fence does not justify projecting a wider provider permission.
  if (
    workspace.excludedPaths.length !== 0 ||
    workspace.gitHistoryApproved !== true
  )
    return undefined;
  if (
    ![
      s.nativeHosts.generation,
      s.computer.generation,
      route.hostGeneration,
      route.computerGeneration,
      record.hostGeneration,
      verified.configRevision,
    ].every(positiveGeneration) ||
    route.hostGeneration !== s.nativeHosts.generation ||
    route.computerGeneration !== s.computer.generation ||
    record.hostGeneration !== s.nativeHosts.generation ||
    verified.workspaceId !== route.workspaceId ||
    verified.configRevision !== s.computer.generation ||
    workspace.gitMetadata.commonDirectory !== route.gitCommonDirectory ||
    (route.execution.sandbox === "workspace-write" &&
      workspace.access !== "write")
  )
    return undefined;
  if (
    local.executableSha256 !== host.executableSha256 ||
    local.schemaSha256 !== host.schemaSha256 ||
    record.localVerification.executableSha256 !== local.executableSha256 ||
    record.localVerification.schemaSha256 !== local.schemaSha256 ||
    record.localVerification.buildId !== local.buildId ||
    record.localVerification.verifiedAt !== local.verifiedAt
  )
    return undefined;
  const { handoff, followup } = record.evidence;
  if (
    [handoff, followup].some(
      (witness) =>
        witness.executablePath !== host.executablePath ||
        witness.executableSha256 !== host.executableSha256 ||
        witness.baseSchemaSha256 !== host.schemaSha256,
    ) ||
    handoff.status !== "supported" ||
    handoff.contract.version !== host.version ||
    handoff.contract.protocol !== host.protocol ||
    handoff.contract.projectBoundCreateStatus !== true ||
    handoff.contract.schemaSha256 === host.schemaSha256
  )
    return undefined;
  if (
    followup.status === "supported" &&
    (followup.contract.kind !== "codex-followup-schema/v1" ||
      followup.contract.protocol !== host.protocol ||
      followup.contract.baseSchemaSha256 !== handoff.contract.schemaSha256 ||
      followup.contract.schemaSha256 === handoff.contract.schemaSha256 ||
      followup.contract.schemaSha256 === host.schemaSha256)
  )
    return undefined;
  const paths = [
    host.executablePath,
    route.socketPath,
    route.expectedCodexHome,
    route.projectRoot,
    route.gitCommonDirectory,
    workspace.root,
    workspace.gitMetadata.commonDirectory,
    workspace.gitMetadata.gitDirectory,
  ];
  // ProductSettings already parses canonical absolute paths; Go excludes root.
  if (paths.some((path) => path === "/")) return undefined;
  const grantedMs = Date.parse(route.approvedAt);
  const expiry = new Date(route.expiresAt);
  if (
    !Number.isSafeInteger(grantedMs) ||
    Number.isNaN(expiry.valueOf()) ||
    route.expiresAt <= grantedMs ||
    route.expiresAt - grantedMs > maximumGrantMs ||
    nowMs < grantedMs ||
    nowMs >= route.expiresAt
  )
    return undefined;
  const source: TaskCodexSource = {
    projectId: route.projectId,
    workspaceId: route.workspaceId,
    project: {
      path: route.projectRoot,
      device: route.projectIdentity.device,
      inode: route.projectIdentity.inode,
      gitCommonDirectory: route.gitCommonDirectory,
    },
    writer: {
      path: workspace.root,
      device: workspace.rootIdentity.device,
      inode: workspace.rootIdentity.inode,
      gitCommonDirectory: workspace.gitMetadata.commonDirectory,
    },
    modelAlias: resolved.selection.modelAlias,
    model: resolved.selection.model,
    ...(resolved.selection.effort === undefined
      ? {}
      : { effort: resolved.selection.effort }),
    configDigest: resolved.configSha256,
    executablePath: host.executablePath,
    executableSha256: host.executableSha256,
    protocol: handoff.contract.protocol,
    baseSchemaSha256: host.schemaSha256,
    handoffSchemaSha256: handoff.contract.schemaSha256,
    ...(followup.status === "supported"
      ? { followup: { ...followup.contract } }
      : {}),
    socketPath: route.socketPath,
    expectedCodexHome: route.expectedCodexHome,
    sandbox: route.execution.sandbox,
    approvalPolicy: route.execution.approvalPolicy,
    grantedAt: route.approvedAt,
    expiresAt: expiry.toISOString(),
    hostGeneration: String(s.nativeHosts.generation),
    computerGeneration: String(s.computer.generation),
    grantHostGeneration: String(route.hostGeneration),
    grantComputerGeneration: String(route.computerGeneration),
    verifiedWorkspaceId: verified.workspaceId!,
    verifiedComputerGeneration: String(verified.configRevision),
    access: workspace.access,
    projectBoundCreateStatus: handoff.contract.projectBoundCreateStatus,
  };
  return validate("TaskCodexSource", source) ? source : undefined;
}
