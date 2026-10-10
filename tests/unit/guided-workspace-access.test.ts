import { describe, expect, it, vi } from "vitest";
import type { ProductConfigurationCommand } from "../../src/pkg/product-settings/contract";
import { onboardingFacts } from "../../src/ui/guided-onboarding";
import {
  GuidedWorkspaceAccess,
  workspaceAccessConfirmation,
  type WorkspaceCommandOutcome,
} from "../../src/ui/guided-workspace-access";
import {
  fixtureBuildId,
  fixtureWorkspaceId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";

// Synthetic settings/admission port; no native filesystem, host or live grant.
function fixture() {
  const settings = guidedSettingsFixture();
  const run = vi.fn<
    (command: ProductConfigurationCommand) => Promise<WorkspaceCommandOutcome>
  >(async (command) => {
    const computer = settings.computer;
    const target =
      "workspaceId" in command
        ? computer.workspaces.find(
            (workspace) => workspace.workspaceId === command.workspaceId,
          )
        : undefined;
    if (command.kind === "connector.stop")
      settings.connectors.secureMcp.runtime = null;
    if (command.kind === "connector.start")
      settings.connectors.secureMcp.runtime = {
        state: "ready",
        computerGeneration: computer.generation,
        connectorGeneration: 1,
        runtimeGeneration: "f".repeat(64),
        buildId: fixtureBuildId,
        observedAt: "2026-01-01T00:00:00.000Z",
      };
    if (command.kind === "computer.update-access" && target) {
      target.access = command.access;
      target.gitHistoryApproved = false;
      computer.generation += 1;
    }
    if (command.kind === "computer.update-commands") {
      computer.commands = command.commands;
      computer.generation += 1;
      computer.workspaces.forEach((workspace) => {
        workspace.gitHistoryApproved = false;
      });
    }
    if (command.kind === "computer.update-git-history" && target) {
      target.gitHistoryApproved = command.approved;
      computer.generation += 1;
    }
    if (
      (command.kind === "computer.verify-workspace" ||
        command.kind === "computer.check-folder") &&
      target
    ) {
      target.accessCheck = {
        ...(command.checkId === undefined ? {} : { checkId: command.checkId }),
        rootIdentity: target.rootIdentity!,
        buildId: fixtureBuildId,
        computerGeneration: computer.generation,
        verifiedAt: "2026-01-01T00:00:00.000Z",
      };
      if (command.kind === "computer.verify-workspace")
        settings.setup.computer.verified = {
          ...settings.setup.computer.verified!,
          workspaceId: target.workspaceId,
          configRevision: computer.generation,
          buildId: fixtureBuildId,
        };
    }
    return "applied" as const;
  });
  let checkCounter = 0;
  const port = {
    settings: () => settings,
    buildId: () => fixtureBuildId,
    issueCheckId: () =>
      `00000000-0000-4000-8000-${String(++checkCounter).padStart(12, "0")}`,
    run,
  };
  const consent = onboardingFacts(settings, fixtureBuildId);
  const controller = new GuidedWorkspaceAccess();
  const plan = {
    workspaceId: fixtureWorkspaceId,
    access: "write" as const,
    commands: "workspace" as const,
    gitHistoryApproved: true,
  };
  return { settings, run, port, consent, controller, plan };
}

describe("one explicit Setup workspace access transition", () => {
  it("pauses before enabling local work and verifies full Git before reconnecting", async () => {
    const f = fixture();
    expect(await f.controller.run(f.port, f.plan, f.consent)).toEqual({
      ok: true,
      reconnected: true,
    });
    expect(f.run.mock.calls.map(([command]) => command.kind)).toEqual([
      "connector.stop",
      "computer.update-access",
      "computer.update-commands",
      "computer.verify-workspace",
      "computer.update-git-history",
      "computer.verify-workspace",
      "connector.start",
    ]);
    expect(f.settings.computer.workspaces[0]).toMatchObject({
      access: "write",
      gitHistoryApproved: true,
    });
    expect(f.settings.computer.commands).toBe("workspace");
  });

  it.each(["build", "computer", "connector", "instance"] as const)(
    "does not report reconnect success from a stale %s witness",
    async (stale) => {
      const f = fixture();
      const previous = f.settings.connectors.secureMcp.runtime!;
      const original = f.run.getMockImplementation()!;
      f.run.mockImplementation(async (command) => {
        const result = await original(command);
        if (command.kind === "connector.start") {
          const runtime = f.settings.connectors.secureMcp.runtime!;
          if (stale === "build") runtime.buildId = "9".repeat(64);
          if (stale === "computer") runtime.computerGeneration = 1;
          if (stale === "connector") runtime.connectorGeneration = 2;
          if (stale === "instance")
            runtime.runtimeGeneration = previous.runtimeGeneration;
        }
        return result;
      });
      expect(await f.controller.run(f.port, f.plan, f.consent)).toEqual({
        ok: false,
        reason: "failed",
      });
      expect(f.settings.computer.workspaces[0]!.access).toBe("write");
      expect(
        f.run.mock.calls.filter(([c]) => c.kind === "connector.start"),
      ).toHaveLength(1);
    },
  );

  it.each(["connector", "instance"] as const)(
    "keeps an unknown reconnect fenced until a fresh matching %s witness is read",
    async (stale) => {
      const f = fixture();
      const previous = f.settings.connectors.secureMcp.runtime!;
      const original = f.run.getMockImplementation()!;
      f.run.mockImplementation(async (command) => {
        const result = await original(command);
        if (command.kind !== "connector.start") return result;
        const runtime = f.settings.connectors.secureMcp.runtime!;
        if (stale === "connector") runtime.connectorGeneration = 2;
        else runtime.runtimeGeneration = previous.runtimeGeneration;
        return "unknown";
      });
      expect(await f.controller.run(f.port, f.plan, f.consent)).toEqual({
        ok: false,
        reason: "unknown",
      });
      const calls = f.run.mock.calls.length;
      expect(f.controller.requiresReadback()).toBe(true);
      expect(f.controller.reconcileReadback(f.settings, fixtureBuildId)).toBe(
        false,
      );
      expect(
        await f.controller.run(
          f.port,
          f.plan,
          onboardingFacts(f.settings, fixtureBuildId),
        ),
      ).toEqual({
        ok: false,
        reason: "unknown",
      });
      expect(f.run).toHaveBeenCalledTimes(calls);
      const runtime = f.settings.connectors.secureMcp.runtime!;
      runtime.connectorGeneration = 1;
      runtime.runtimeGeneration = "f".repeat(64);
      expect(f.controller.reconcileReadback(f.settings, fixtureBuildId)).toBe(
        true,
      );
      expect(f.run).toHaveBeenCalledTimes(calls);
    },
  );

  it("does not start a previously stopped connection", async () => {
    const f = fixture();
    f.settings.connectors.secureMcp.runtime = null;
    expect(
      await f.controller.run(
        f.port,
        { workspaceId: fixtureWorkspaceId, access: "write" },
        f.consent,
      ),
    ).toEqual({ ok: true, reconnected: false });
    expect(f.run.mock.calls.map(([command]) => command.kind)).toEqual([
      "computer.update-access",
      "computer.verify-workspace",
    ]);
  });

  it("checks a newly added folder and starts its already configured connection without another user action", async () => {
    const f = fixture();
    f.settings.connectors.secureMcp.runtime = null;
    const result = await f.controller.run(
      f.port,
      { workspaceId: fixtureWorkspaceId, connectWhenConfigured: true },
      onboardingFacts(f.settings, fixtureBuildId),
    );
    expect(result).toEqual({ ok: true, reconnected: true });
    expect(f.run.mock.calls.map(([command]) => command.kind)).toEqual([
      "computer.verify-workspace",
      "connector.start",
    ]);
  });

  it("does not start an unconfigured connection after automatic folder checking", async () => {
    const f = fixture();
    f.settings.connectors.secureMcp.runtime = null;
    f.settings.connectors.secureMcp.credential = "missing";
    expect(
      await f.controller.run(
        f.port,
        { workspaceId: fixtureWorkspaceId, connectWhenConfigured: true },
        onboardingFacts(f.settings, fixtureBuildId),
      ),
    ).toEqual({ ok: true, reconnected: false });
    expect(f.run.mock.calls.map(([command]) => command.kind)).toEqual([
      "computer.verify-workspace",
    ]);
  });

  it("revokes full Git with read-only access without changing command rights for other folders", async () => {
    const f = fixture();
    f.settings.computer.workspaces[0]!.access = "write";
    f.settings.computer.workspaces[0]!.gitHistoryApproved = true;
    f.settings.computer.commands = "workspace";
    expect(
      (
        await f.controller.run(
          f.port,
          {
            workspaceId: fixtureWorkspaceId,
            access: "read",
            gitHistoryApproved: false,
          },
          f.consent,
        )
      ).ok,
    ).toBe(true);
    expect(f.settings.computer.workspaces[0]).toMatchObject({
      access: "read",
      gitHistoryApproved: false,
    });
    expect(
      f.run.mock.calls.some(
        ([command]) => command.kind === "computer.update-commands",
      ),
    ).toBe(false);
  });

  it("refuses stale consent before pausing or granting anything", async () => {
    const f = fixture();
    f.settings.computer.generation += 1;
    expect(await f.controller.run(f.port, f.plan, f.consent)).toEqual({
      ok: false,
      reason: "changed",
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("does not change access while the prior connector outcome is unknown", async () => {
    const f = fixture();
    f.settings.setup.connect.outcomeUnknown = true;
    expect(await f.controller.run(f.port, f.plan, f.consent)).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("stops after an unacknowledged pause without repeating or applying the plan", async () => {
    const f = fixture();
    f.run.mockRejectedValueOnce(new Error("lost acknowledgement"));
    expect(await f.controller.run(f.port, f.plan, f.consent)).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("does not accept an affirmative reply when the settings mutation did not occur", async () => {
    const f = fixture();
    f.settings.connectors.secureMcp.runtime = null;
    f.run.mockImplementationOnce(async () => "applied" as const);
    expect((await f.controller.run(f.port, f.plan, f.consent)).ok).toBe(false);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.settings.computer.workspaces[0]!.access).toBe("read");
  });

  it("does not reconnect on a failed check and leaves partial changes visible", async () => {
    const f = fixture();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (command) =>
      command.kind === "computer.verify-workspace"
        ? "refused"
        : original(command),
    );
    expect(await f.controller.run(f.port, f.plan, f.consent)).toMatchObject({
      ok: false,
      reason: "failed",
      workspaceId: fixtureWorkspaceId,
    });
    expect(f.settings.computer.workspaces[0]!.access).toBe("write");
    expect(f.settings.connectors.secureMcp.runtime).toBeNull();
    expect(
      f.run.mock.calls.some(([command]) => command.kind === "connector.start"),
    ).toBe(false);
  });

  it("rejects a root replacement during the pause before granting write access", async () => {
    const f = fixture();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementationOnce(async (command) => {
      await original(command);
      f.settings.computer.workspaces[0]!.rootIdentity = {
        device: "1",
        inode: "999",
      };
      return "applied" as const;
    });
    expect((await f.controller.run(f.port, f.plan, f.consent)).ok).toBe(false);
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("names an unready second folder without silently dropping it from scope", async () => {
    const f = fixture();
    const otherId = "00000000-0000-4000-8000-000000000099";
    f.settings.computer.workspaces.push({
      ...f.settings.computer.workspaces[0]!,
      workspaceId: otherId,
      root: "/tmp/other",
      accessCheck: null,
    });
    const consent = onboardingFacts(f.settings, fixtureBuildId);
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (command) =>
      command.kind === "computer.check-folder" &&
      command.workspaceId === otherId
        ? "refused"
        : original(command),
    );
    expect(await f.controller.run(f.port, f.plan, consent)).toMatchObject({
      ok: false,
      reason: "failed",
      workspaceId: otherId,
    });
    expect(f.settings.computer.workspaces).toHaveLength(2);
    expect(
      f.run.mock.calls.some(([command]) => command.kind === "connector.start"),
    ).toBe(false);
  });

  it("serializes access transitions so a second approval cannot race the pause", async () => {
    const f = fixture();
    let resume: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementationOnce(async (command) => {
      await paused;
      return original(command);
    });
    const first = f.controller.run(f.port, f.plan, f.consent);
    expect(await f.controller.run(f.port, f.plan, f.consent)).toEqual({
      ok: false,
      reason: "busy",
    });
    resume!();
    expect((await first).ok).toBe(true);
  });
});

describe("access acknowledgement and revocation boundaries", () => {
  it("requires the exact issued check even when a prior or another check is already green", async () => {
    const f = fixture();
    f.settings.connectors.secureMcp.runtime = null;
    const target = f.settings.computer.workspaces[0]!;
    target.accessCheck = {
      ...target.accessCheck!,
      checkId: "00000000-0000-4000-8000-000000000099",
    };
    const before = structuredClone(f.settings);
    f.run.mockResolvedValueOnce("unknown");
    await f.controller.run(
      f.port,
      { workspaceId: fixtureWorkspaceId },
      onboardingFacts(f.settings, fixtureBuildId),
    );
    const issued = f.run.mock.calls[0]![0];
    if (issued.kind !== "computer.verify-workspace")
      throw new Error("wrong fixture check");
    expect(f.controller.reconcileReadback(before, fixtureBuildId)).toBe(false);
    target.accessCheck!.checkId = "00000000-0000-4000-8000-000000000098";
    expect(f.controller.reconcileReadback(f.settings, fixtureBuildId)).toBe(
      false,
    );
    target.accessCheck!.checkId = issued.checkId;
    expect(f.controller.reconcileReadback(f.settings, fixtureBuildId)).toBe(
      true,
    );
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("requires the pending build for a matching native readback", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce("unknown");
    await f.controller.run(f.port, f.plan, f.consent);
    f.settings.connectors.secureMcp.runtime = null;
    expect(f.controller.reconcileReadback(f.settings, "f".repeat(64))).toBe(
      false,
    );
    expect(f.controller.requiresReadback()).toBe(true);
    expect(f.controller.reconcileReadback(f.settings, fixtureBuildId)).toBe(
      true,
    );
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("fences a lost acknowledgement across later approvals until a matching explicit read", async () => {
    const f = fixture();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementationOnce(async (command) => {
      await original(command);
      return "unknown";
    });
    expect((await f.controller.run(f.port, f.plan, f.consent)).ok).toBe(false);
    expect(f.controller.requiresReadback()).toBe(true);
    expect(await f.controller.run(f.port, f.plan, f.consent)).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.controller.reconcileReadback(f.settings, fixtureBuildId)).toBe(
      true,
    );
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.settings.computer.workspaces[0]!.access).toBe("read");
    expect(f.settings.connectors.secureMcp.runtime).toBeNull();
  });

  it("does not clear an unknown stop from a cached ready snapshot or a changed scope", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce("unknown");
    await f.controller.run(f.port, f.plan, f.consent);
    expect(f.controller.reconcileReadback(f.settings, fixtureBuildId)).toBe(
      false,
    );
    f.settings.connectors.secureMcp.runtime = null;
    f.settings.computer.workspaces[0]!.rootIdentity = {
      device: "1",
      inode: "999",
    };
    expect(f.controller.reconcileReadback(f.settings, fixtureBuildId)).toBe(
      false,
    );
    expect(f.controller.requiresReadback()).toBe(true);
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("does not replay a write failure or accept an older generation as its readback", async () => {
    const f = fixture();
    f.settings.connectors.secureMcp.runtime = null;
    f.run.mockResolvedValueOnce("unknown");
    await f.controller.run(f.port, f.plan, f.consent);
    expect(f.controller.reconcileReadback(f.settings, fixtureBuildId)).toBe(
      false,
    );
    f.settings.computer.workspaces[0]!.access = "write";
    expect(f.controller.reconcileReadback(f.settings, fixtureBuildId)).toBe(
      false,
    );
    f.settings.computer.generation += 1;
    expect(f.controller.reconcileReadback(f.settings, fixtureBuildId)).toBe(
      true,
    );
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.settings.computer.commands).not.toBe("workspace");
  });

  it("requires the current connection witness to reconcile an unknown full verification", async () => {
    const f = fixture();
    f.settings.connectors.secureMcp.runtime = null;
    f.settings.setup.computer.verified = null;
    f.run.mockResolvedValueOnce("unknown");
    await f.controller.run(
      f.port,
      { workspaceId: fixtureWorkspaceId },
      f.consent,
    );
    expect(f.controller.reconcileReadback(f.settings, fixtureBuildId)).toBe(
      false,
    );
    f.settings.setup.computer.verified = {
      profile: "computer.local.read/1",
      workspaceId: fixtureWorkspaceId,
      configRevision: 1,
      buildId: fixtureBuildId,
      runtimeGeneration: "b".repeat(64),
      protocol: "readonly-workspace/1",
      verifiedAt: "2026-01-01T00:00:00.000Z",
    };
    const issued = f.run.mock.calls[0]![0];
    if (issued.kind !== "computer.verify-workspace")
      throw new Error("wrong fixture check");
    f.settings.computer.workspaces[0]!.accessCheck = {
      rootIdentity: f.settings.computer.workspaces[0]!.rootIdentity!,
      buildId: fixtureBuildId,
      computerGeneration: f.settings.computer.generation,
      verifiedAt: "2026-01-01T00:00:00.000Z",
      checkId: issued.checkId,
    };
    expect(f.controller.reconcileReadback(f.settings, fixtureBuildId)).toBe(
      true,
    );
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("revokes Git before verification even when the folder is inaccessible", async () => {
    const f = fixture();
    f.settings.computer.workspaces[0]!.gitHistoryApproved = true;
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (command) =>
      command.kind === "computer.verify-workspace"
        ? "refused"
        : original(command),
    );
    expect(
      (
        await f.controller.run(
          f.port,
          { workspaceId: fixtureWorkspaceId, gitHistoryApproved: false },
          f.consent,
        )
      ).ok,
    ).toBe(false);
    expect(f.settings.computer.workspaces[0]!.gitHistoryApproved).toBe(false);
    expect(f.run.mock.calls.map(([command]) => command.kind)).toEqual([
      "connector.stop",
      "computer.update-git-history",
      "computer.verify-workspace",
    ]);
    expect(f.settings.connectors.secureMcp.runtime).toBeNull();
  });

  it("keeps a read-only downgrade effective when a subsequent folder check fails", async () => {
    const f = fixture();
    f.settings.computer.workspaces[0]!.access = "write";
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (command) =>
      command.kind === "computer.verify-workspace"
        ? "refused"
        : original(command),
    );
    await f.controller.run(
      f.port,
      {
        workspaceId: fixtureWorkspaceId,
        access: "read",
        gitHistoryApproved: false,
      },
      f.consent,
    );
    expect(f.settings.computer.workspaces[0]!.access).toBe("read");
    expect(f.settings.connectors.secureMcp.runtime).toBeNull();
  });

  it("names edits and commands while retaining the complete Git disclosure", () => {
    const f = fixture();
    const approval = workspaceAccessConfirmation(f.plan, "project", true);
    expect(approval.button).toBe("Allow edits & commands");
    expect(approval.copy).toContain("Allow edits & commands in project?");
    expect(approval.copy).toContain("complete Git metadata, history and hooks");
    expect(approval.copy).toContain("your Git settings");
    expect(approval.copy).toContain("sensitive data or past excluded files");
    expect(approval.copy).toContain(
      "No files are deleted and no ChatGPT message is sent",
    );
  });

  it("does not claim file edits in Git-only consent", () => {
    const approval = workspaceAccessConfirmation(
      {
        workspaceId: fixtureWorkspaceId,
        commands: "workspace",
        gitHistoryApproved: true,
      },
      "project",
      true,
    );
    expect(approval.copy).toContain("complete Git metadata");
    expect(approval.copy).toContain("their file permissions stay in place");
    expect(approval.copy).not.toContain("editing");
    expect(approval.button).not.toBe("Allow edits & commands");
    expect(
      workspaceAccessConfirmation(
        {
          workspaceId: fixtureWorkspaceId,
          access: "write",
          commands: "workspace",
          gitHistoryApproved: true,
        },
        "project",
        true,
      ).copy,
    ).toContain("editing");
  });
});
