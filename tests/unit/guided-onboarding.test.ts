import { describe, expect, it, vi } from "vitest";
import {
  GuidedActivation,
  defaultOnboardingFolderChoice,
  externalConnectorChallengeAllowed,
  onboardingCompletedSteps,
  onboardingProgress,
  onboardingProgressForFolderChoice,
  onboardingFacts,
  selectedOnboardingWorkspace,
  type OnboardingFacts,
} from "../../src/ui/guided-onboarding";

import {
  fixtureBuildId,
  fixtureWorkspaceId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";

const empty: OnboardingFacts = {
  available: true,
  chat: "not-configured",
  folder: "not-configured",
  hasFolder: false,
  authority: "build-a:1:workspace-a",
  connectionIdentity: "connector-a:1",
  verificationIdentity: null,
  client: false,
  tunnelId: null,
  credentialStored: false,
  runtime: "stopped",
  runtimeCurrent: false,
  attachmentCurrent: false,
  outcomeUnknown: false,
};
const prepared: OnboardingFacts = {
  ...empty,
  chat: "ready",
  folder: "ready",
  hasFolder: true,
};

describe("guided onboarding progress", () => {
  it("keeps completed setup visible across a build update without claiming current runtime readiness", () => {
    const settings = guidedSettingsFixture();
    expect(
      onboardingProgress(onboardingFacts(settings, "f".repeat(64))),
    ).toEqual([true, true, false, false, false]);
    expect(onboardingCompletedSteps(settings)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    settings.computer.generation += 1;
    expect(onboardingCompletedSteps(settings)[4]).toBe(false);
  });

  it("remembers a successful app check after its runtime stops, without claiming live access", () => {
    const settings = guidedSettingsFixture();
    settings.connectors.secureMcp.lastVerifiedAttachment =
      settings.connectors.secureMcp.attachment;
    settings.connectors.secureMcp.runtime = null;
    settings.connectors.secureMcp.attachment = null;
    settings.setup.connect.verified = null;
    expect(onboardingCompletedSteps(settings)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(
      onboardingProgress(onboardingFacts(settings, fixtureBuildId)),
    ).toEqual([true, true, false, false, false]);
    settings.connectors.secureMcp.generation += 1;
    expect(onboardingCompletedSteps(settings)[3]).toBe(false);
  });

  it("accepts current folder access checks after an update without promoting the older Computer witness", () => {
    const settings = guidedSettingsFixture();
    const newBuildId = "f".repeat(64);
    settings.connectors.secureMcp.runtime!.buildId = newBuildId;
    settings.computer.workspaces[0]!.accessCheck!.buildId = newBuildId;
    settings.connectors.secureMcp.attachment = null;
    settings.setup.connect.verified = null;
    expect(settings.setup.computer.verified?.buildId).toBe(fixtureBuildId);
    expect(onboardingFacts(settings, newBuildId).folder).toBe("ready");
    expect(onboardingProgress(onboardingFacts(settings, newBuildId))[2]).toBe(
      true,
    );
    expect(onboardingCompletedSteps(settings)[2]).toBe(true);
    settings.computer.workspaces[0]!.rootIdentity!.inode = "changed";
    expect(onboardingFacts(settings, newBuildId).folder).not.toBe("ready");
  });

  it("does not carry a saved completion across a changed folder or attachment", () => {
    const settings = guidedSettingsFixture();
    settings.computer.workspaces[0]!.rootIdentity!.inode = "changed";
    expect(onboardingCompletedSteps(settings)[1]).toBe(false);
    const changedAttachment = guidedSettingsFixture();
    changedAttachment.connectors.secureMcp.attachment!.buildId = "f".repeat(64);
    expect(onboardingCompletedSteps(changedAttachment)[3]).toBe(false);
  });
  it("treats folder sharing as optional without claiming a connection", () => {
    expect(onboardingProgress(empty)).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(onboardingProgress({ ...empty, chat: "action-required" })[0]).toBe(
      false,
    );
  });
  it("requires a running current tunnel, not just a saved key", () => {
    expect(
      onboardingProgress({
        ...prepared,
        client: true,
        tunnelId: "tunnel_test",
        credentialStored: true,
      })[2],
    ).toBe(false);
  });
  it("does not infer the ChatGPT app attachment from a running local tunnel", () => {
    const running = {
      ...prepared,
      runtime: "ready" as const,
      runtimeCurrent: true,
    };
    expect(onboardingProgress(running)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(onboardingProgress({ ...running, attachmentCurrent: true })).toEqual(
      [true, true, true, true, true],
    );
  });
  it("invalidates ready on folder or runtime drift and on unknown outcomes", () => {
    const ready = {
      ...prepared,
      runtime: "ready" as const,
      runtimeCurrent: true,
      attachmentCurrent: true,
    };
    expect(onboardingProgress({ ...ready, folder: "action-required" })[4]).toBe(
      false,
    );
    expect(onboardingProgress({ ...ready, runtimeCurrent: false })[4]).toBe(
      false,
    );
    expect(onboardingProgress({ ...ready, outcomeUnknown: true })[4]).toBe(
      false,
    );
  });
  it("does not require advanced Codex/Agent verification for basic onboarding", () => {
    expect(
      onboardingProgress({
        ...prepared,
        runtime: "ready",
        runtimeCurrent: true,
        attachmentCurrent: true,
      })[4],
    ).toBe(true);
  });
});

describe("onboarding snapshot projection", () => {
  it("never silently chooses a stale saved grant for folder verification", () => {
    const settings = guidedSettingsFixture();
    expect(defaultOnboardingFolderChoice(settings, fixtureBuildId)).toBe(
      fixtureWorkspaceId,
    );
    settings.computer.workspaces.unshift({
      ...settings.computer.workspaces[0]!,
      workspaceId: "00000000-0000-4000-8000-000000000099",
      root: "/Users/ac",
      label: "Home",
    });
    expect(defaultOnboardingFolderChoice(settings, fixtureBuildId)).toBe(
      fixtureWorkspaceId,
    );
    settings.computer.generation += 1;
    expect(defaultOnboardingFolderChoice(settings, fixtureBuildId)).toBe("new");
    expect(defaultOnboardingFolderChoice(settings, "f".repeat(64))).toBe("new");
    expect(selectedOnboardingWorkspace(settings, "new")).toBeNull();
    expect(
      selectedOnboardingWorkspace(settings, fixtureWorkspaceId)?.root,
    ).toBe("/tmp/farol-onboarding-fixture");
    expect(
      selectedOnboardingWorkspace(settings, "not-an-existing-workspace"),
    ).toBeNull();
  });
  it("does not carry Ready badges to a newly selected folder", () => {
    const ready = onboardingFacts(guidedSettingsFixture(), fixtureBuildId);
    expect(onboardingProgressForFolderChoice(ready, true)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(onboardingProgressForFolderChoice(ready, false)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });
  it("does not reuse an attachment for another saved and verified folder", () => {
    const settings = guidedSettingsFixture();
    const otherWorkspace = {
      ...settings.computer.workspaces[0]!,
      workspaceId: "00000000-0000-4000-8000-000000000099",
      root: "/tmp/farol-onboarding-other-fixture",
      label: "Other project",
    };
    settings.computer.workspaces.push(otherWorkspace);
    settings.setup.computer.verified = {
      ...settings.setup.computer.verified!,
      workspaceId: otherWorkspace.workspaceId,
    };
    expect(defaultOnboardingFolderChoice(settings, fixtureBuildId)).toBe(
      otherWorkspace.workspaceId,
    );
    const facts = onboardingFacts(settings, fixtureBuildId);
    expect(facts.folder).toBe("ready");
    expect(facts.attachmentCurrent).toBe(false);
    expect(onboardingProgressForFolderChoice(facts, true)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
  it("keeps the optional folder choice complete across a build while connection proof expires", () => {
    const settings = guidedSettingsFixture();
    const progress = onboardingProgress(
      onboardingFacts(settings, "f".repeat(64)),
    );
    expect(progress[1]).toBe(true);
    expect(progress[2]).toBe(false);
  });
  it("keeps zero approved folders optional without inheriting old app proof", () => {
    const settings = guidedSettingsFixture();
    settings.computer.workspaces = [];
    expect(
      onboardingProgress(onboardingFacts(settings, fixtureBuildId))[1],
    ).toBe(true);
    expect(onboardingCompletedSteps(settings)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
  it("uses actual settings without advanced host or Agent readiness", () => {
    expect(
      onboardingProgress(
        onboardingFacts(guidedSettingsFixture(), fixtureBuildId),
      ),
    ).toEqual([true, true, true, true, true]);
    expect(onboardingProgress(onboardingFacts(null, fixtureBuildId))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
  it.each(["build", "computer", "connector", "tunnel", "workspace", "runtime"])(
    "rejects stale %s attachment evidence",
    (field) => {
      const settings = guidedSettingsFixture();
      const attachment = settings.connectors.secureMcp.attachment!;
      if (field === "build") attachment.buildId = "f".repeat(64);
      if (field === "computer") attachment.computerGeneration += 1;
      if (field === "connector") attachment.connectorGeneration += 1;
      if (field === "tunnel") attachment.tunnelId = "different_tunnel";
      if (field === "workspace")
        attachment.workspaceId = "00000000-0000-4000-8000-000000000099";
      if (field === "runtime") attachment.runtimeGeneration = "f".repeat(64);
      expect(onboardingFacts(settings, fixtureBuildId).attachmentCurrent).toBe(
        false,
      );
      expect(
        onboardingProgress(onboardingFacts(settings, fixtureBuildId))[4],
      ).toBe(false);
    },
  );
  it("does not trust ready runtime evidence after a connector or build changes", () => {
    const settings = guidedSettingsFixture();
    expect(onboardingFacts(settings, "f".repeat(64)).runtimeCurrent).toBe(
      false,
    );
    settings.connectors.secureMcp.generation += 1;
    expect(onboardingFacts(settings, fixtureBuildId).runtimeCurrent).toBe(
      false,
    );
  });
  it("a missing local dependency or credential never looks activated", () => {
    const settings = guidedSettingsFixture();
    settings.connectors.secureMcp.tunnelClient = null;
    expect(onboardingFacts(settings, fixtureBuildId).runtimeCurrent).toBe(
      false,
    );
    settings.connectors.secureMcp =
      guidedSettingsFixture().connectors.secureMcp;
    settings.connectors.secureMcp.credential = "missing";
    expect(onboardingFacts(settings, fixtureBuildId).runtimeCurrent).toBe(
      false,
    );
  });
});

describe("single-action tunnel activation", () => {
  function harness(initial = prepared) {
    let current = { ...initial };
    const commands: string[] = [];
    const run = vi.fn(async (command: { kind: string }) => {
      commands.push(command.kind);
      if (command.kind === "connector.discover-client")
        current = { ...current, client: true };
      if (command.kind === "connector.configure")
        current = {
          ...current,
          tunnelId: "tunnel_test",
          credentialStored: true,
        };
      if (command.kind === "connector.start")
        current = { ...current, runtime: "ready", runtimeCurrent: true };
      return true;
    });
    return {
      commands,
      run,
      read: () => current,
      set: (value: OnboardingFacts) => {
        current = value;
      },
    };
  }
  const values = {
    tunnelId: "tunnel_test",
    runtimeKey: "synthetic-fixture-key-not-a-secret",
  };

  it("discovers, saves and starts in order from one explicit action", async () => {
    const port = harness();
    expect(await new GuidedActivation().run(port, values)).toEqual({
      ok: true,
    });
    expect(port.commands).toEqual([
      "connector.discover-client",
      "connector.configure",
      "connector.start",
    ]);
  });
  it("starts a connection without a folder or any file verification", async () => {
    const port = harness({
      ...prepared,
      hasFolder: false,
      folder: "not-configured",
    });
    expect(await new GuidedActivation().run(port, values)).toEqual({
      ok: true,
    });
    expect(port.commands).toEqual([
      "connector.discover-client",
      "connector.configure",
      "connector.start",
    ]);
    expect(port.read().folder).toBe("not-configured");
  });
  it("stops empty-catalogue activation if authority changes during discovery", async () => {
    const port = harness({
      ...prepared,
      hasFolder: false,
      folder: "not-configured",
    });
    const original = port.run;
    port.run = vi.fn(async (command) => {
      const result = await original(command);
      port.set({ ...port.read(), authority: "new-workspace-generation" });
      return result;
    });
    expect(await new GuidedActivation().run(port, values)).toEqual({
      ok: false,
      reason: "state-changed",
    });
    expect(port.commands).toEqual(["connector.discover-client"]);
  });
  it("rejects double-clicks synchronously, before the first awaited result", async () => {
    const port = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = port.run;
    port.run = vi.fn(async (command) => {
      await gate;
      return original(command);
    });
    const activation = new GuidedActivation();
    const first = activation.run(port, values);
    expect(await activation.run(port, values)).toEqual({
      ok: false,
      reason: "busy",
    });
    release();
    expect(await first).toEqual({ ok: true });
    expect(
      port.commands.filter((kind) => kind === "connector.start"),
    ).toHaveLength(1);
  });
  it.each([
    "connector.discover-client",
    "connector.configure",
    "connector.start",
  ])("does not continue or retry after %s fails", async (failed) => {
    const port = harness();
    const original = port.run;
    port.run = vi.fn(async (command) =>
      command.kind === failed ? false : original(command),
    );
    expect((await new GuidedActivation().run(port, values)).ok).toBe(false);
    const attempted = port.run.mock.calls.map(([command]) => command.kind);
    expect(attempted.at(-1)).toBe(failed);
    expect(attempted.filter((kind) => kind === failed)).toHaveLength(1);
  });
  it("reuses a stored key only for the same tunnel, without resaving it", async () => {
    const port = harness({
      ...prepared,
      client: true,
      tunnelId: "tunnel_test",
      credentialStored: true,
    });
    expect(
      await new GuidedActivation().run(port, {
        tunnelId: "tunnel_test",
        runtimeKey: "",
      }),
    ).toEqual({ ok: true });
    expect(port.commands).toEqual(["connector.start"]);
  });
  it("requires a new key for a different tunnel", async () => {
    const port = harness({
      ...prepared,
      client: true,
      tunnelId: "tunnel_old",
      credentialStored: true,
    });
    expect(
      await new GuidedActivation().run(port, {
        tunnelId: "tunnel_test",
        runtimeKey: "",
      }),
    ).toEqual({ ok: false, reason: "new-key-required" });
    expect(port.run).not.toHaveBeenCalled();
  });
  it("never implicitly repairs an unknown runtime outcome", async () => {
    const port = harness({
      ...prepared,
      runtime: "outcome_unknown",
      outcomeUnknown: true,
    });
    expect(await new GuidedActivation().run(port, values)).toEqual({
      ok: false,
      reason: "inspect-existing-operation",
    });
    expect(port.run).not.toHaveBeenCalled();
  });
  it("stops if the approved folder/build authority changes while awaiting discovery", async () => {
    const port = harness();
    const original = port.run;
    port.run = vi.fn(async (command) => {
      const result = await original(command);
      port.set({ ...port.read(), authority: "different-generation" });
      return result;
    });
    expect(await new GuidedActivation().run(port, values)).toEqual({
      ok: false,
      reason: "state-changed",
    });
    expect(port.commands).toEqual(["connector.discover-client"]);
  });
  it("requires current local evidence after a successful start reply", async () => {
    const port = harness({
      ...prepared,
      client: true,
      tunnelId: "tunnel_test",
      credentialStored: true,
    });
    port.run = vi.fn(async () => true);
    expect(
      await new GuidedActivation().run(port, {
        tunnelId: "tunnel_test",
        runtimeKey: "",
      }),
    ).toEqual({ ok: false, reason: "runtime-not-ready" });
  });
});

describe("ordinary ChatGPT Computer setup", () => {
  it("allows Computer setup without claiming an embedded ChatGPT sign-in", () => {
    const settings = guidedSettingsFixture();
    settings.setup.chatgpt.verified = null;
    settings.setup.chatgpt.configured = false;
    settings.setup.chatgpt.reachable = "unknown";
    const facts = onboardingFacts(settings, fixtureBuildId);
    expect(facts.chat).not.toBe("ready");
    expect(onboardingProgress(facts, "external")).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(onboardingProgress(facts)[0]).toBe(false);
    expect(onboardingCompletedSteps(settings, "external")[4]).toBe(true);
    expect(settings.setup.chatgpt.verified).toBeNull();
  });
  it("keeps external attachment unverified without the current receipt", () => {
    const settings = guidedSettingsFixture();
    settings.connectors.secureMcp.attachment = null;
    settings.setup.connect.verified = null;
    expect(
      onboardingProgress(onboardingFacts(settings, fixtureBuildId), "external"),
    ).toEqual([true, true, true, false, false]);
    settings.setup.connect.outcomeUnknown = true;
    expect(
      onboardingProgress(
        onboardingFacts(settings, fixtureBuildId),
        "external",
      )[2],
    ).toBe(false);
  });
});

describe("external connector challenge presentation", () => {
  const current = {
    ...prepared,
    runtime: "ready" as const,
    runtimeCurrent: true,
    verificationIdentity: "current-challenge",
  };
  it("offers only the current unused challenge", () => {
    expect(externalConnectorChallengeAllowed(current)).toBe(true);
    expect(
      externalConnectorChallengeAllowed({
        ...current,
        attachmentCurrent: true,
      }),
    ).toBe(false);
  });
  it("withholds stale or unknown challenges", () => {
    expect(
      externalConnectorChallengeAllowed({ ...current, runtimeCurrent: false }),
    ).toBe(false);
    expect(
      externalConnectorChallengeAllowed({ ...current, outcomeUnknown: true }),
    ).toBe(false);
    expect(
      externalConnectorChallengeAllowed({
        ...current,
        verificationIdentity: null,
      }),
    ).toBe(false);
  });
});
