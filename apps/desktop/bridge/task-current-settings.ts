import { randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import { parseJSON } from "./frame.ts";
import {
  validate,
  type Json,
  type TaskCurrentSettingsCompareResponse,
} from "./wire.ts";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract.ts";

export type TaskSettingsComparator = (
  before: ProductSettings,
  candidate: ProductSettings,
) => Promise<boolean>;

// Lossless transport mapping of parsed/defaulted settings. Go selects matching
// workspaces, policy identity, negative evidence, ordering and equality.
export function taskSettingsFacts(settings: unknown): Json {
  const parsed = ProductSettingsSchema.safeParse(settings);
  if (!parsed.success) return { status: "settings-invalid" };
  const s = parsed.data;
  return parseJSON(
    JSON.stringify({
      status: "parsed",
      tasks: s.tasks ?? null,
      nativeHosts: {
        generation: String(s.nativeHosts.generation),
        route: s.nativeHosts.taskRoute,
        host: s.nativeHosts.codex,
      },
      computer: {
        computerId: s.computer.computerId,
        generation: String(s.computer.generation),
        workspaces: s.computer.workspaces.map((workspace) => ({
          workspaceId: workspace.workspaceId,
          root: workspace.root,
          access: workspace.access,
          rootIdentity: workspace.rootIdentity ?? null,
          gitMetadata: workspace.gitMetadata ?? null,
          excludedPaths: workspace.excludedPaths,
          gitHistoryApproved: workspace.gitHistoryApproved ?? null,
        })),
      },
      setup: {
        verified: s.setup.computer.verified,
        reachable: s.setup.computer.reachable,
        outcomeUnknown: s.setup.computer.outcomeUnknown,
      },
    }),
  ) as Json;
}

// One original read, without a local comparison policy, retry or fallback.
export class TaskCurrentSettingsBridge {
  constructor(
    private readonly client: Pick<Client, "request" | "verifiedContext">,
  ) {}

  async compare(
    before: ProductSettings,
    candidate: ProductSettings,
  ): Promise<boolean> {
    const revisions = [before.revision, candidate.revision];
    if (
      revisions.some(
        (revision) => !Number.isSafeInteger(revision) || revision < 0,
      )
    )
      throw new BridgeError("refused", "task_settings_revision_invalid");
    const context = { ...this.client.verifiedContext };
    if (!validate("Context", context))
      throw new BridgeError("unavailable", "task_settings_context_invalid");
    const body = {
      beforeRevision: String(revisions[0]),
      candidateRevision: String(revisions[1]),
      before: JSON.stringify(taskSettingsFacts(before)),
      candidate: JSON.stringify(taskSettingsFacts(candidate)),
    };
    if (!validate("TaskCurrentSettingsCompareRequest", body))
      throw new BridgeError("refused", "task_settings_request_invalid");
    const id = randomUUID();
    const outcome = await this.client.request("task.settings.compare", body, {
      id,
    });
    const current = this.client.verifiedContext;
    if (
      !validate("Outcome", outcome) ||
      outcome.requestId !== id ||
      outcome.operationId !== undefined ||
      outcome.context.profileId !== context.profileId ||
      outcome.context.backendGeneration !== context.backendGeneration ||
      current.profileId !== context.profileId ||
      current.backendGeneration !== context.backendGeneration
    )
      throw new BridgeError("unknown", "task_settings_response_context");
    if (outcome.status !== "ok")
      throw new BridgeError(
        outcome.status,
        outcome.code ?? "task_settings_unavailable",
      );
    if (!validate("TaskCurrentSettingsCompareResponse", outcome.data))
      throw new BridgeError("unknown", "task_settings_response_invalid");
    const result =
      outcome.data as unknown as TaskCurrentSettingsCompareResponse;
    if (
      result.beforeRevision !== body.beforeRevision ||
      result.candidateRevision !== body.candidateRevision
    )
      throw new BridgeError("unknown", "task_settings_response_revision");
    return result.changed;
  }
}
