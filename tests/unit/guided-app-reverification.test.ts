import { describe, expect, it, vi } from "vitest";
import type { ProductConfigurationCommand } from "../../src/pkg/product-settings/contract";
import { GuidedFreshAppVerification } from "../../src/ui/guided-onboarding-actions";
import {
  onboardingFacts,
  type OnboardingFacts,
} from "../../src/ui/guided-onboarding";
import {
  fixtureBuildId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";

const initial = (): OnboardingFacts => ({
  ...onboardingFacts(guidedSettingsFixture(), fixtureBuildId),
  verificationIdentity: "old-attempt",
});

function harness() {
  let facts = initial();
  const run = vi.fn(async (command: ProductConfigurationCommand) => {
    if (command.kind === "connector.repair")
      facts = {
        ...facts,
        verificationIdentity: "fresh-attempt",
        attachmentCurrent: false,
      };
    if (command.kind === "connector.verify-app")
      facts = { ...facts, attachmentCurrent: true };
    return true;
  });
  return {
    read: () => facts,
    run,
    set: (next: OnboardingFacts) => {
      facts = next;
    },
  };
}

describe("explicit fresh Farol Dev app verification", () => {
  it("requires a new runtime/challenge before sending exactly one message", async () => {
    const port = harness();
    expect(await new GuidedFreshAppVerification().run(port)).toEqual({
      ok: true,
    });
    expect(port.run.mock.calls.map(([command]) => command.kind)).toEqual([
      "connector.repair",
      "connector.verify-app",
    ]);
  });

  it("refuses an unchanged challenge before a model submission", async () => {
    const port = harness();
    port.run = vi.fn(async () => true);
    expect(await new GuidedFreshAppVerification().run(port)).toEqual({
      ok: false,
      reason: "state-changed",
    });
    expect(port.run.mock.calls.map(([command]) => command.kind)).toEqual([
      "connector.repair",
    ]);
  });

  it.each(["authority", "connectionIdentity", "verificationIdentity"] as const)(
    "refuses changed %s before a model submission",
    async (field) => {
      const port = harness();
      const original = port.run;
      port.run = vi.fn(async (command) => {
        const result = await original(command);
        port.set({ ...port.read(), [field]: "changed" });
        return result;
      });
      // A changed verification identity is expected once, so a second change
      // is tested by removing the fresh attempt entirely.
      if (field === "verificationIdentity") {
        port.run = vi.fn(async () => {
          port.set({ ...port.read(), verificationIdentity: null });
          return true;
        });
      }
      expect((await new GuidedFreshAppVerification().run(port)).ok).toBe(false);
      expect(port.run).toHaveBeenCalledTimes(1);
    },
  );

  it("does not restart or resend an unknown previous outcome", async () => {
    const port = harness();
    port.set({ ...port.read(), outcomeUnknown: true });
    expect(await new GuidedFreshAppVerification().run(port)).toEqual({
      ok: false,
      reason: "inspect-existing-operation",
    });
    expect(port.run).not.toHaveBeenCalled();
  });

  it("stops after an unconfirmed repair", async () => {
    const port = harness();
    port.run = vi.fn(async () => false);
    expect(await new GuidedFreshAppVerification().run(port)).toEqual({
      ok: false,
      reason: "command-failed",
    });
    expect(port.run).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed app submission", async () => {
    const port = harness();
    const original = port.run;
    port.run = vi.fn(async (command) =>
      command.kind === "connector.verify-app" ? false : original(command),
    );
    expect(await new GuidedFreshAppVerification().run(port)).toEqual({
      ok: false,
      reason: "command-failed",
    });
    expect(port.run.mock.calls.map(([command]) => command.kind)).toEqual([
      "connector.repair",
      "connector.verify-app",
    ]);
  });

  it("rejects an attachment to a different attempt after the send", async () => {
    const port = harness();
    const original = port.run;
    port.run = vi.fn(async (command) => {
      const result = await original(command);
      if (command.kind === "connector.verify-app")
        port.set({ ...port.read(), verificationIdentity: "other-attempt" });
      return result;
    });
    expect(await new GuidedFreshAppVerification().run(port)).toEqual({
      ok: false,
      reason: "state-changed",
    });
  });

  it("blocks a second click while the first operation is in flight", async () => {
    const port = harness();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = port.run;
    port.run = vi.fn(async (command) => {
      await waiting;
      return original(command);
    });
    const verification = new GuidedFreshAppVerification();
    const first = verification.run(port);
    expect(await verification.run(port)).toEqual({ ok: false, reason: "busy" });
    release();
    expect(await first).toEqual({ ok: true });
  });
});
