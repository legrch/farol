import { describe, expect, it, vi } from "vitest";
import type { ProductConfigurationCommand } from "../../src/pkg/product-settings/contract";
import { GuidedCredentialSave } from "../../src/ui/guided-onboarding-actions";
import {
  onboardingFacts,
  type OnboardingFacts,
} from "../../src/ui/guided-onboarding";
import {
  fixtureBuildId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";

const values = {
  tunnelId: "tunnel_new",
  runtimeKey: "test-only-".repeat(4),
};
function harness(overrides: Partial<OnboardingFacts> = {}) {
  let facts = {
    ...onboardingFacts(guidedSettingsFixture(), fixtureBuildId),
    ...overrides,
  };
  const run = vi.fn(async (command: ProductConfigurationCommand) => {
    if (command.kind === "connector.stop")
      facts = {
        ...facts,
        runtime: "stopped",
        runtimeCurrent: false,
        attachmentCurrent: false,
      };
    if (command.kind === "connector.configure")
      facts = {
        ...facts,
        tunnelId: command.tunnelId,
        credentialStored: true,
        connectionIdentity: "new-credentials",
      };
    return true;
  });
  return {
    read: () => facts,
    set: (next: Partial<OnboardingFacts>) => {
      facts = { ...facts, ...next };
    },
    run,
  };
}

describe("save credentials independently of connection verification", () => {
  it("saves from a fresh profile without sign-in or folders and does not start", async () => {
    const port = harness({
      runtime: "stopped",
      chat: "not-configured",
      folder: "not-configured",
      hasFolder: false,
      credentialStored: false,
      tunnelId: null,
    });
    expect(await new GuidedCredentialSave().run(port, values)).toEqual({
      ok: true,
    });
    expect(port.run.mock.calls.map(([command]) => command.kind)).toEqual([
      "connector.configure",
    ]);
    expect(port.read().runtime).toBe("stopped");
  });
  it("stops once, stores once, and leaves activation to the owner", async () => {
    const port = harness();
    expect(await new GuidedCredentialSave().run(port, values)).toEqual({
      ok: true,
    });
    expect(port.run.mock.calls.map(([command]) => command.kind)).toEqual([
      "connector.stop",
      "connector.configure",
    ]);
    expect(port.read().runtimeCurrent).toBe(false);
  });
  it.each([
    "",
    "short",
    "••••••••",
    "sk-admin-12345678901234567890",
    "sk-runtime-key with spaces",
  ])(
    "rejects an invalid replacement before stopping: %s",
    async (runtimeKey) => {
      const port = harness();
      expect(
        (await new GuidedCredentialSave().run(port, { ...values, runtimeKey }))
          .ok,
      ).toBe(false);
      expect(port.run).not.toHaveBeenCalled();
    },
  );
  it("refuses an unknown previous result without discarding it", async () => {
    const port = harness({ outcomeUnknown: true });
    expect(await new GuidedCredentialSave().run(port, values)).toEqual({
      ok: false,
      reason: "inspect-existing-operation",
    });
    expect(port.run).not.toHaveBeenCalled();
  });
  it.each(["authority", "connectionIdentity"] as const)(
    "stops the sequence on %s drift",
    async (field) => {
      const port = harness();
      const original = port.run;
      port.run = vi.fn(async (command: ProductConfigurationCommand) => {
        await original(command);
        port.set({ [field]: "changed-outside-this-action" });
        return true;
      });
      expect(await new GuidedCredentialSave().run(port, values)).toEqual({
        ok: false,
        reason: "state-changed",
      });
      expect(port.run).toHaveBeenCalledTimes(1);
    },
  );
  it("does not store a key after an unconfirmed stop", async () => {
    const port = harness();
    port.run = vi.fn(async () => {
      throw new Error("lost reply");
    });
    expect((await new GuidedCredentialSave().run(port, values)).ok).toBe(false);
    expect(port.run).toHaveBeenCalledTimes(1);
  });
  it("requires the stored state, not just a successful-looking response", async () => {
    const port = harness({ runtime: "stopped" });
    port.run = vi.fn(async () => true);
    expect(await new GuidedCredentialSave().run(port, values)).toEqual({
      ok: false,
      reason: "state-changed",
    });
  });
  it("rejects duplicate clicks while a save is in progress", async () => {
    const port = harness({ runtime: "stopped" });
    const original = port.run;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    port.run = vi.fn(async (command: ProductConfigurationCommand) => {
      await waiting;
      return original(command);
    });
    const save = new GuidedCredentialSave();
    const first = save.run(port, values);
    expect(await save.run(port, values)).toEqual({ ok: false, reason: "busy" });
    release();
    expect(await first).toEqual({ ok: true });
    expect(port.run).toHaveBeenCalledTimes(1);
  });
});
