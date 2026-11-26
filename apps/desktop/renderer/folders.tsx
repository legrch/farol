import { useState } from "react";
import type { ApprovedProductWorkspace } from "../../../src/pkg/product-settings/contract";
import {
  folderAccessChecked,
  folderDisplayName,
} from "../../../src/ui/folder-access-state";
import { GuidedWorkspaceAccess } from "../../../src/ui/guided-workspace-access";
import { onboardingFacts } from "../../../src/ui/guided-onboarding";
import type {
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import { intention, soleIntent } from "./intents";
import type { PageProps } from "./page";

export const folderSetupByWindow = new WeakMap<
  RendererFacade,
  { access: GuidedWorkspaceAccess; busy: boolean }
>();

export function Folders(props: PageProps) {
  const { settings, facade, snapshot, actions } = props;
  const [adding, setAdding] = useState(false);
  let flow = folderSetupByWindow.get(facade);
  if (!flow) {
    flow = { access: new GuidedWorkspaceAccess(), busy: false };
    folderSetupByWindow.set(facade, flow);
  }
  const folderFlow = flow;
  async function choose() {
    if (folderFlow.busy || folderFlow.access.requiresReadback()) return;
    folderFlow.busy = true;
    setAdding(true);
    try {
      const picking = facade.getSnapshot();
      const initialFacts = onboardingFacts(
        picking.configuration?.status === "ready"
          ? picking.configuration.settings
          : null,
        picking.buildId ?? "",
      );
      const picked = await actions.run({ kind: "computer.choose-workspace" });
      const before = facade.getSnapshot();
      const evidence = before.evidence;
      if (
        picked?.state !== "applied" ||
        before.destination !== picking.destination ||
        evidence === picking.evidence ||
        !soleIntent(picking, before, "computer.choose-workspace") ||
        evidence?.value.kind !== "computer.workspace-pick" ||
        before.configuration?.status !== "ready" ||
        evidence.revision !== before.configuration.settings.revision ||
        before.buildId !== picking.buildId
      )
        return;
      const result = await actions.run({
        kind: "computer.add-workspace",
        selectionId: evidence.value.selectionId,
        access: "read",
      });
      const current = facade.getSnapshot();
      const selection = current.evidence?.value;
      if (
        result?.state !== "applied" ||
        current.destination !== picking.destination ||
        current.evidence === before.evidence ||
        !soleIntent(before, current, "computer.add-workspace") ||
        selection?.kind !== "computer.workspace-selection" ||
        current.configuration?.status !== "ready" ||
        current.evidence?.revision !==
          current.configuration.settings.revision ||
        current.buildId !== before.buildId ||
        !current.configuration.settings.computer.workspaces.some(
          (item) => item.workspaceId === selection.workspaceId,
        )
      )
        return;
      await folderFlow.access.run(
        {
          settings: () => {
            const configuration = facade.getSnapshot().configuration;
            return configuration?.status === "ready"
              ? configuration.settings
              : null;
          },
          buildId: () => facade.getSnapshot().buildId ?? "",
          issueCheckId: () => crypto.randomUUID(),
          run: async (command) => {
            const outcome = await actions.runClassified(command);
            // Only the local guards prove no dispatch. A null result after
            // entering the facade can hide an effect and must stay unknown.
            if (outcome.state === "not-sent") return "refused";
            const intent = outcome.result;
            return intent?.state === "applied"
              ? "applied"
              : intent?.state === "refused"
                ? "refused"
                : "unknown";
          },
        },
        {
          workspaceId: selection.workspaceId,
          includeGitWithCommands: true,
          ...(initialFacts.available &&
          picking.configuration?.status === "ready" &&
          picking.configuration.settings.computer.commands === "workspace" &&
          picking.configuration.settings.computer.filePolicy ===
            "approved-roots-v1" &&
          picking.configuration.settings.computer.workspaces.every(
            (workspace) => workspace.gitHistoryApproved === true,
          )
            ? { commands: "workspace" as const }
            : {}),
          connectWhenConfigured:
            initialFacts.runtimeCurrent &&
            onboardingFacts(
              current.configuration.settings,
              current.buildId ?? "",
            ).connectionIdentity === initialFacts.connectionIdentity,
          ...(initialFacts.runtimeCurrent &&
          picking.configuration?.status === "ready" &&
          picking.configuration.settings.connectors.secureMcp.runtime
            ? {
                previousRuntimeGeneration:
                  picking.configuration.settings.connectors.secureMcp.runtime
                    .runtimeGeneration,
              }
            : {}),
        },
        onboardingFacts(current.configuration.settings, current.buildId ?? ""),
      );
    } finally {
      folderFlow.busy = false;
      setAdding(false);
    }
  }

  async function remove(workspaceId: string) {
    if (folderFlow.busy || folderFlow.access.requiresReadback()) return;
    const before = facade.getSnapshot();
    if (before.configuration?.status !== "ready") return;
    const initialFacts = onboardingFacts(
      before.configuration.settings,
      before.buildId ?? "",
    );
    const previous = before.configuration.settings.computer;
    const expected = {
      ...previous,
      generation: previous.generation + 1,
      workspaces: previous.workspaces.filter(
        (item) => item.workspaceId !== workspaceId,
      ),
    };
    let remaining: string | undefined;
    folderFlow.busy = true;
    setAdding(true);
    try {
      const result = await actions.run({
        kind: "computer.remove-workspace",
        workspaceId,
      });
      const current = facade.getSnapshot();
      // Follow only this acknowledged removal. A navigation, unknown outcome
      // or any other scope change cannot schedule additional configuration work.
      if (
        result?.state === "applied" &&
        current.destination === before.destination &&
        current.buildId === before.buildId &&
        soleIntent(
          before,
          current,
          "computer.remove-workspace",
          intention("computer.remove-workspace", workspaceId),
        ) &&
        current.configuration?.status === "ready" &&
        JSON.stringify(current.configuration.settings.computer) ===
          JSON.stringify(expected)
      ) {
        remaining =
          current.configuration.settings.computer.workspaces[0]?.workspaceId;
      }
    } finally {
      folderFlow.busy = false;
      setAdding(false);
    }
    // The existing guarded flow checks every retained folder with its saved
    // access/commands, and keeps original unknown effects fenced.
    if (remaining !== undefined) {
      const current = facade.getSnapshot();
      const facts = onboardingFacts(
        current.configuration?.status === "ready"
          ? current.configuration.settings
          : null,
        current.buildId ?? "",
      );
      await update(
        remaining,
        {},
        initialFacts.runtimeCurrent &&
          facts.connectionIdentity === initialFacts.connectionIdentity,
        before.configuration.settings.connectors.secureMcp.runtime
          ?.runtimeGeneration,
      );
    }
  }

  async function update(
    workspaceId: string,
    plan: {
      access?: "read" | "write";
      commands?: "none" | "workspace";
      filePolicy?: "approved-roots-v1";
      gitHistoryApproved?: boolean;
    } = {},
    connectWhenConfigured = false,
    previousRuntimeGeneration?: string,
  ) {
    if (folderFlow.busy || folderFlow.access.requiresReadback()) return;
    folderFlow.busy = true;
    setAdding(true);
    const current = facade.getSnapshot();
    try {
      const computer =
        current.configuration?.status === "ready"
          ? current.configuration.settings.computer
          : null;
      await folderFlow.access.run(
        {
          settings: () => {
            const value = facade.getSnapshot().configuration;
            return value?.status === "ready" ? value.settings : null;
          },
          buildId: () => facade.getSnapshot().buildId ?? "",
          issueCheckId: () => crypto.randomUUID(),
          run: async (command) => {
            const outcome = await actions.runClassified(command);
            return outcome.state === "not-sent" ||
              outcome.result?.state === "refused"
              ? "refused"
              : outcome.result?.state === "applied"
                ? "applied"
                : "unknown";
          },
        },
        {
          workspaceId,
          includeGitWithCommands: true,
          ...(plan.commands === undefined &&
          computer?.commands === "workspace" &&
          computer.filePolicy === "approved-roots-v1" &&
          computer.workspaces.every(
            (workspace) => workspace.gitHistoryApproved === true,
          )
            ? { commands: "workspace" as const }
            : {}),
          ...plan,
          connectWhenConfigured,
          ...(previousRuntimeGeneration ? { previousRuntimeGeneration } : {}),
        },
        onboardingFacts(
          current.configuration?.status === "ready"
            ? current.configuration.settings
            : null,
          current.buildId ?? "",
        ),
      );
    } finally {
      folderFlow.busy = false;
      setAdding(false);
    }
  }
  const paused =
    adding || folderFlow.busy || folderFlow.access.requiresReadback();
  const commandsReady =
    settings.computer.commands === "workspace" &&
    settings.computer.filePolicy === "approved-roots-v1" &&
    settings.computer.workspaces.every(
      (workspace) => workspace.gitHistoryApproved === true,
    );
  return (
    <>
      <div className="setup-workspaces" aria-label="Approved workspaces">
        {settings.computer.workspaces.map((workspace) => {
          const checked =
            workspaceChecked(snapshot, workspace) &&
            !actions.computerPauseReason;
          return (
            <article
              className="setup-workspace-row"
              key={workspace.workspaceId}
              aria-label={`Workspace ${folderDisplayName(workspace)}`}
            >
              <div className="workspace-row-path">
                <strong>{folderDisplayName(workspace)}</strong>
                <p className="description">{workspace.root}</p>
              </div>
              <label>
                Access
                <select
                  className="field"
                  aria-label={`Access for ${folderDisplayName(workspace)}`}
                  value={workspace.access}
                  disabled={
                    paused ||
                    !actions.allowed(
                      "computer.update-access",
                      workspace.workspaceId,
                    )
                  }
                  onChange={(event) =>
                    void update(workspace.workspaceId, {
                      access:
                        event.currentTarget.value === "read" ? "read" : "write",
                    })
                  }
                >
                  <option value="read">Read only</option>
                  <option value="write">Read &amp; write</option>
                </select>
              </label>
              <label className="workspace-commands">
                <input
                  type="checkbox"
                  aria-label={`Commands for ${folderDisplayName(workspace)}`}
                  checked={commandsReady}
                  disabled={
                    paused ||
                    !actions.allowed("computer.update-commands") ||
                    (settings.computer.filePolicy !== "approved-roots-v1" &&
                      !actions.allowed("computer.update-file-policy"))
                  }
                  onChange={(event) =>
                    void update(workspace.workspaceId, {
                      commands: event.currentTarget.checked
                        ? "workspace"
                        : "none",
                      ...(event.currentTarget.checked
                        ? { filePolicy: "approved-roots-v1" as const }
                        : {}),
                    })
                  }
                />
                Commands
              </label>
              <div className="workspace-row-result" role="status">
                {checked ? (
                  <>
                    <span className="setup-success">✓ Works</span>
                    {/* A saved check can go stale (a disk renumbered or
                        remounted). Re-check measures the folder again; a live
                        connection is stopped and restored around it, a stopped
                        one stays stopped. It never widens access. */}
                    <button
                      type="button"
                      className="text-button"
                      disabled={
                        paused ||
                        !actions.allowed(
                          "computer.verify-workspace",
                          workspace.workspaceId,
                        )
                      }
                      onClick={() => void update(workspace.workspaceId)}
                    >
                      Re-check
                    </button>
                  </>
                ) : (
                  <>
                    <span>
                      {actions.computerPauseReason ??
                        "Workspace access has not passed its check."}
                    </span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={
                        paused ||
                        !actions.allowed(
                          "computer.verify-workspace",
                          workspace.workspaceId,
                        )
                      }
                      onClick={() => void update(workspace.workspaceId)}
                    >
                      Check access
                    </button>
                  </>
                )}
              </div>
              {/* From this folder's own saved check, so it survives other
                  configuration results and each folder shows its own note. */}
              {checked && workspace.accessCheck?.writableByOthers === true && (
                <p className="description workspace-row-note" role="note">
                  Other users of this Mac can change files in this folder.
                </p>
              )}
              <button
                type="button"
                className="text-button"
                disabled={
                  paused ||
                  !actions.allowed(
                    "computer.remove-workspace",
                    workspace.workspaceId,
                  )
                }
                onClick={() => void remove(workspace.workspaceId)}
              >
                Remove {folderDisplayName(workspace)}
              </button>
            </article>
          );
        })}
      </div>
      <button
        type="button"
        className={
          settings.computer.workspaces.length === 0 ? "primary" : "subtle"
        }
        disabled={paused || !actions.allowed("computer.choose-workspace")}
        onClick={() => void choose()}
      >
        {adding ? "Checking workspace…" : "+ Add workspace"}
      </button>
      <p className="description">
        Commands lets ChatGPT run Git, tests and builds in approved workspaces,
        including Git history, hooks and your Git configuration. ChatGPT manages
        action confirmations; Farol enforces your approved access. Command
        access is shared by all workspaces.
      </p>
      {settings.computer.commands === "workspace" &&
        settings.computer.filePolicy === "approved-roots-v1" &&
        !commandsReady && (
          <p className="description" role="status">
            Select Commands to enable Git and user settings for the approved
            workspaces.
          </p>
        )}
      {settings.computer.commands === "workspace" &&
        settings.computer.filePolicy !== "approved-roots-v1" && (
          <p className="description" role="status">
            Commands are not enabled by this profile’s earlier access policy.
            Select Commands above to approve command access and check your
            workspaces in one step.
          </p>
        )}
      {settings.computer.commands === "verification" && (
        <p className="description">
          This profile currently allows Git checks only. Select Commands to
          allow workspace commands.
        </p>
      )}
      {settings.computer.workspaces.length === 0 && (
        <p className="description">Add a workspace to continue.</p>
      )}
    </>
  );
}
// Draft admission binds presentation to the exact Computer scope. Local
// selection is never a Computer grant or a replacement for the host guards.
function workspaceChecked(
  snapshot: WindowSnapshot,
  workspace: ApprovedProductWorkspace,
) {
  return (
    snapshot.status === "current" &&
    snapshot.runtime === "ready" &&
    snapshot.configuration?.status === "ready" &&
    !snapshot.configuration.settings.setup.computer.outcomeUnknown &&
    Boolean(
      snapshot.buildId &&
      folderAccessChecked(
        snapshot.configuration.settings,
        workspace,
        snapshot.buildId,
      ),
    )
  );
}
