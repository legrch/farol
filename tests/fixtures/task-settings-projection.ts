// Test-only retained f892 projection oracle. This is never a production fallback.
// Its synthetic port verifies settings-owner ordering only. Real Go parity is a
// separate inherited-pipe contract check; this fixture grants no authority.
import { resolveOwnerTaskModel } from "../../src/apps/desktop/owner-config.ts";
import {
  TaskExecutionSettingsSchema,
  taskPolicyIdentity,
} from "../../src/pkg/owner-config/contract.ts";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract.ts";
import type { TaskSettingsComparator } from "../../apps/desktop/bridge/task-current-settings.ts";

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

export const fixtureTaskSettingsCompare: TaskSettingsComparator = async (
  before,
  candidate,
) =>
  JSON.stringify(taskSettingsProjection(before)) !==
  JSON.stringify(taskSettingsProjection(candidate));
