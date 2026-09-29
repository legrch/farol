import type {
  ProductConfigurationCommand,
  ProductSettings,
} from "../pkg/product-settings/contract";
import { folderAccessChecked } from "./folder-access-state";
import { onboardingFacts } from "./guided-onboarding";

export interface WorkspaceAccessPlan {
  readonly workspaceId: string;
  readonly access?: "read" | "write";
  readonly commands?: "none" | "verification" | "workspace";
  readonly gitHistoryApproved?: boolean;
}
export type WorkspaceCommandOutcome = "applied" | "refused" | "unknown";

export interface WorkspaceAccessPort {
  readonly settings: () => ProductSettings | null;
  readonly buildId: () => string;
  readonly run: (
    command: ProductConfigurationCommand,
  ) => Promise<WorkspaceCommandOutcome>;
}
export type WorkspaceAccessResult =
  | Readonly<{ ok: true; reconnected: boolean }>
  | Readonly<{
      ok: false;
      reason: "busy" | "changed" | "unknown" | "failed";
      workspaceId?: string;
    }>;

function scopeIdentity(settings: ProductSettings): string {
  return JSON.stringify([
    settings.computer.computerId,
    settings.computer.workspaces.map((workspace) => [
      workspace.workspaceId,
      workspace.root,
      workspace.rootIdentity,
      workspace.excludedPaths,
    ]),
  ]);
}

function reconnectedRuntimeCurrent(
  settings: ProductSettings,
  buildId: string,
  previousRuntimeGeneration: string | null,
): boolean {
  const runtime = settings.connectors.secureMcp.runtime;
  return (
    onboardingFacts(settings, buildId).runtimeCurrent &&
    runtime !== null &&
    runtime.runtimeGeneration !== previousRuntimeGeneration
  );
}

// An explicit UI approval is a plan, not a grant. Every effect still goes
// through the existing backend admission, verification and settings owner.
export class GuidedWorkspaceAccess {
  private busy = false;
  private unconfirmed: Readonly<{
    command: ProductConfigurationCommand;
    generation: number;
    scope: string;
    connectionIdentity: string;
    previousRuntimeGeneration: string | null;
  }> | null = null;

  requiresReadback(): boolean {
    return this.unconfirmed !== null;
  }

  // Called only after an explicit native snapshot read, never after a cached
  // render or a timer. A mismatch stays unknown and performs no new effect.
  reconcileReadback(settings: ProductSettings, buildId: string): boolean {
    const pending = this.unconfirmed;
    if (
      !pending ||
      settings.computer.generation !== pending.generation ||
      scopeIdentity(settings) !== pending.scope ||
      onboardingFacts(settings, buildId).connectionIdentity !==
        pending.connectionIdentity ||
      onboardingFacts(settings, buildId).outcomeUnknown
    )
      return false;
    const command = pending.command;
    const target =
      "workspaceId" in command
        ? settings.computer.workspaces.find(
            (workspace) => workspace.workspaceId === command.workspaceId,
          )
        : undefined;
    let confirmed = false;
    if (command.kind === "connector.stop")
      confirmed = onboardingFacts(settings, buildId).runtime === "stopped";
    if (command.kind === "connector.start")
      confirmed = reconnectedRuntimeCurrent(
        settings,
        buildId,
        pending.previousRuntimeGeneration,
      );
    if (command.kind === "computer.update-access")
      confirmed = target?.access === command.access;
    if (command.kind === "computer.update-commands")
      confirmed = settings.computer.commands === command.commands;
    if (command.kind === "computer.update-git-history")
      confirmed =
        target !== undefined &&
        (target.gitHistoryApproved === true) === command.approved;
    if (
      command.kind === "computer.verify-workspace" ||
      command.kind === "computer.check-folder"
    )
      confirmed =
        target !== undefined &&
        folderAccessChecked(settings, target, buildId) &&
        (command.kind === "computer.check-folder" ||
          (settings.setup.computer.verified?.workspaceId ===
            command.workspaceId &&
            settings.setup.computer.verified.configRevision ===
              settings.computer.generation &&
            settings.setup.computer.verified.buildId === buildId &&
            settings.setup.computer.reachable === "reachable" &&
            !settings.setup.computer.outcomeUnknown));
    if (confirmed) this.unconfirmed = null;
    return confirmed;
  }

  async run(
    port: WorkspaceAccessPort,
    plan: WorkspaceAccessPlan,
    consent: Readonly<{ authority: string; connectionIdentity: string }>,
  ): Promise<WorkspaceAccessResult> {
    if (this.busy) return { ok: false, reason: "busy" };
    if (this.unconfirmed) return { ok: false, reason: "unknown" };
    const initial = port.settings();
    const facts = onboardingFacts(initial, port.buildId());
    if (
      !initial ||
      facts.authority !== consent.authority ||
      facts.connectionIdentity !== consent.connectionIdentity ||
      !initial.computer.workspaces.some(
        (workspace) => workspace.workspaceId === plan.workspaceId,
      )
    )
      return { ok: false, reason: "changed" };
    if (facts.outcomeUnknown) return { ok: false, reason: "unknown" };
    const scope = scopeIdentity(initial);
    const previousRuntimeGeneration =
      initial.connectors.secureMcp.runtime?.runtimeGeneration ?? null;
    let generation = initial.computer.generation;
    const current = (): ProductSettings | null => {
      const settings = port.settings();
      if (
        !settings ||
        settings.computer.generation !== generation ||
        scopeIdentity(settings) !== scope ||
        onboardingFacts(settings, port.buildId()).connectionIdentity !==
          consent.connectionIdentity ||
        onboardingFacts(settings, port.buildId()).outcomeUnknown
      )
        return null;
      return settings;
    };
    const run = async (
      command: ProductConfigurationCommand,
      delta = 0,
    ): Promise<boolean> => {
      if (!current()) return false;
      const pending = {
        command,
        generation: generation + delta,
        scope,
        connectionIdentity: consent.connectionIdentity,
        previousRuntimeGeneration,
      };
      let outcome: WorkspaceCommandOutcome;
      try {
        outcome = await port.run(command);
      } catch {
        outcome = "unknown";
      }
      if (outcome === "unknown") this.unconfirmed = pending;
      if (outcome !== "applied") return false;
      generation += delta;
      return current() !== null;
    };
    this.busy = true;
    try {
      if (facts.runtime !== "stopped") {
        if (
          !(await run({ kind: "connector.stop" })) ||
          onboardingFacts(current(), port.buildId()).runtime !== "stopped"
        )
          return { ok: false, reason: this.unconfirmed ? "unknown" : "failed" };
      }
      if (
        plan.access !== undefined &&
        current()?.computer.workspaces.find(
          (workspace) => workspace.workspaceId === plan.workspaceId,
        )?.access !== plan.access
      ) {
        if (
          !(await run(
            {
              kind: "computer.update-access",
              workspaceId: plan.workspaceId,
              access: plan.access,
            },
            1,
          ))
        )
          return { ok: false, reason: this.unconfirmed ? "unknown" : "failed" };
      }
      if (
        plan.commands !== undefined &&
        current()?.computer.commands !== plan.commands
      ) {
        if (
          !(await run(
            { kind: "computer.update-commands", commands: plan.commands },
            1,
          ))
        )
          return { ok: false, reason: this.unconfirmed ? "unknown" : "failed" };
      }
      // Revocation must land even when the folder can no longer be opened.
      if (
        plan.gitHistoryApproved === false &&
        current()?.computer.workspaces.find(
          (workspace) => workspace.workspaceId === plan.workspaceId,
        )?.gitHistoryApproved === true
      ) {
        if (
          !(await run(
            {
              kind: "computer.update-git-history",
              workspaceId: plan.workspaceId,
              approved: false,
            },
            1,
          ))
        )
          return { ok: false, reason: this.unconfirmed ? "unknown" : "failed" };
      }
      if (
        !(await run({
          kind: "computer.verify-workspace",
          workspaceId: plan.workspaceId,
        }))
      )
        return {
          ok: false,
          reason: this.unconfirmed ? "unknown" : "failed",
          workspaceId: plan.workspaceId,
        };
      const target = current()?.computer.workspaces.find(
        (workspace) => workspace.workspaceId === plan.workspaceId,
      );
      if (
        !target ||
        (plan.access !== undefined && target.access !== plan.access) ||
        (plan.commands !== undefined &&
          current()?.computer.commands !== plan.commands) ||
        !folderAccessChecked(current()!, target, port.buildId())
      )
        return { ok: false, reason: "changed" };
      if (
        plan.gitHistoryApproved !== undefined &&
        (target.gitHistoryApproved === true) !== plan.gitHistoryApproved
      ) {
        if (
          !(await run(
            {
              kind: "computer.update-git-history",
              workspaceId: plan.workspaceId,
              approved: plan.gitHistoryApproved,
            },
            1,
          )) ||
          !(await run({
            kind: "computer.verify-workspace",
            workspaceId: plan.workspaceId,
          }))
        )
          return {
            ok: false,
            reason: this.unconfirmed ? "unknown" : "failed",
            workspaceId: plan.workspaceId,
          };
      }
      const after = current();
      const verified = after?.computer.workspaces.find(
        (workspace) => workspace.workspaceId === plan.workspaceId,
      );
      if (
        !after ||
        !verified ||
        (plan.gitHistoryApproved !== undefined &&
          (verified.gitHistoryApproved === true) !== plan.gitHistoryApproved) ||
        !folderAccessChecked(after, verified, port.buildId())
      )
        return { ok: false, reason: "changed" };
      for (const workspace of after.computer.workspaces) {
        if (
          !folderAccessChecked(current()!, workspace, port.buildId()) &&
          !(await run({
            kind: "computer.check-folder",
            workspaceId: workspace.workspaceId,
          }))
        )
          return {
            ok: false,
            reason: this.unconfirmed ? "unknown" : "failed",
            workspaceId: workspace.workspaceId,
          };
        const settings = current();
        const checked = settings?.computer.workspaces.find(
          (item) => item.workspaceId === workspace.workspaceId,
        );
        if (
          !settings ||
          !checked ||
          !folderAccessChecked(settings, checked, port.buildId())
        )
          return {
            ok: false,
            reason: "changed",
            workspaceId: workspace.workspaceId,
          };
      }
      if (facts.runtime === "ready") {
        if (!(await run({ kind: "connector.start" })))
          return { ok: false, reason: this.unconfirmed ? "unknown" : "failed" };
        const reconnected = current();
        if (
          !reconnected ||
          !reconnectedRuntimeCurrent(
            reconnected,
            port.buildId(),
            previousRuntimeGeneration,
          )
        )
          return { ok: false, reason: "failed" };
        return { ok: true, reconnected: true };
      }
      return { ok: true, reconnected: false };
    } catch {
      return { ok: false, reason: "unknown" };
    } finally {
      this.busy = false;
    }
  }
}

// Describe only the requested changes. Git-only consent never grants file edits.
export function workspaceAccessConfirmation(
  plan: WorkspaceAccessPlan,
  name: string,
  paused: boolean,
): Readonly<{ copy: string; button: string }> {
  const localWork =
    plan.access === "write" &&
    plan.commands === "workspace" &&
    plan.gitHistoryApproved === true;
  const changes: string[] = [];
  if (plan.access !== undefined)
    changes.push(
      plan.access === "write"
        ? "Allow reading and editing this folder's files."
        : "Use read-only file access.",
    );
  if (plan.commands !== undefined)
    changes.push(
      `Command mode becomes ${plan.commands} for all listed approved folders; their file permissions stay in place.`,
    );
  if (plan.gitHistoryApproved === true)
    changes.push(
      "Allow complete Git metadata, history and hooks for this folder and your Git settings (including Git includes and hooks). They may include sensitive data or past excluded files.",
    );
  if (plan.gitHistoryApproved === false)
    changes.push(
      "Revoke full Git history and user-settings approval for this folder.",
    );
  if (changes.length === 0)
    changes.push(
      "Check this folder's existing access without granting new permissions.",
    );
  return {
    copy: `${localWork ? "Allow edits & commands" : "Update access"} in ${name}? ${changes.join(" ")}${paused ? " The connection will pause while access is checked." : ""} No files are deleted and no ChatGPT message is sent.`,
    button: localWork ? "Allow edits & commands" : "Apply and check",
  };
}
