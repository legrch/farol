import { describe, expect, it, vi } from "vitest";
import type { ProductConfigurationCommand } from "../../src/pkg/product-settings/contract";
import {
  onboardingFacts,
  type OnboardingFacts,
} from "../../src/ui/guided-onboarding";
import {
  completedStepAction,
  connectionDraftChanged,
  firstIncompleteSetupStep,
  GuidedConnectionUpdate,
  GuidedCredentialSave,
  onboardingPrerequisite,
  progressWithConnectionDraft,
} from "../../src/ui/guided-onboarding-actions";
import {
  fixtureBuildId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";

const saved = (): OnboardingFacts =>
  onboardingFacts(guidedSettingsFixture(), fixtureBuildId);
const replacement = "synthetic-replacement-key-not-a-secret";

it("aligns Continue with remembered setup and refreshes a stale connection before app verification", () => {
  const current = [true, true, false, false, false];
  expect(
    completedStepAction(2, current, [true, true, true, false, false]),
  ).toBe("reconnect-and-continue");
  expect(completedStepAction(3, current, [true, true, true, true, true])).toBe(
    "continue",
  );
  expect(completedStepAction(2, current, [true, true, true, true, true])).toBe(
    "continue",
  );
  expect(
    completedStepAction(3, current, [true, true, true, false, false]),
  ).toBe(null);
});
function harness(initial = saved()) {
  let current = { ...initial };
  const run = vi.fn(async (command: ProductConfigurationCommand) => {
    if (command.kind === "connector.stop") {
      current = {
        ...current,
        runtime: "stopped",
        runtimeCurrent: false,
        attachmentCurrent: false,
      };
    }
    if (command.kind === "connector.configure") {
      current = {
        ...current,
        tunnelId: command.tunnelId,
        credentialStored: true,
      };
    }
    if (command.kind === "connector.start") {
      current = { ...current, runtime: "ready", runtimeCurrent: true };
    }
    return true;
  });
  return {
    run,
    read: () => current,
    set: (next: OnboardingFacts) => {
      current = next;
    },
  };
}

describe("owner-editable onboarding connection", () => {
  it("keeps a saved key for the same tunnel when replacement is blank", async () => {
    const port = harness();
    expect(
      await new GuidedCredentialSave().run(port, {
        tunnelId: port.read().tunnelId!,
        runtimeKey: "",
      }),
    ).toEqual({ ok: true });
    expect(port.run).not.toHaveBeenCalled();
  });
  it("requires a new key before changing tunnels, without stopping the old one", async () => {
    const port = harness();
    expect(
      await new GuidedCredentialSave().run(port, {
        tunnelId: "tunnel_other",
        runtimeKey: "",
      }),
    ).toEqual({ ok: false, reason: "new-key-required" });
    expect(port.run).not.toHaveBeenCalled();
  });
  it("validates a replacement before pausing an otherwise working connection", async () => {
    const port = harness();
    expect(
      await new GuidedConnectionUpdate().run(port, {
        tunnelId: port.read().tunnelId!,
        runtimeKey: "short",
      }),
    ).toEqual({ ok: false, reason: "invalid-fields" });
    expect(port.run).not.toHaveBeenCalled();
  });
  it("requires a new key for a different tunnel before stopping the old one", async () => {
    const port = harness();
    expect(
      await new GuidedConnectionUpdate().run(port, {
        tunnelId: "tunnel_other",
        runtimeKey: "",
      }),
    ).toEqual({ ok: false, reason: "new-key-required" });
    expect(port.run).not.toHaveBeenCalled();
  });
  it("replaces a key from one explicit Save and reconnect action", async () => {
    const port = harness();
    const tunnelId = port.read().tunnelId!;
    expect(
      await new GuidedConnectionUpdate().run(port, {
        tunnelId,
        runtimeKey: replacement,
      }),
    ).toEqual({ ok: true });
    expect(port.run.mock.calls.map(([command]) => command.kind)).toEqual([
      "connector.stop",
      "connector.configure",
      "connector.start",
    ]);
    expect(port.run.mock.calls[1]?.[0]).toEqual({
      kind: "connector.configure",
      tunnelId,
      runtimeKey: replacement,
    });
  });
  it("reconnects stale build evidence without asking for the stored key again", async () => {
    const port = harness({
      ...saved(),
      runtimeCurrent: false,
      attachmentCurrent: false,
    });
    expect(
      await new GuidedConnectionUpdate().run(port, {
        tunnelId: port.read().tunnelId!,
        runtimeKey: "",
      }),
    ).toEqual({ ok: true });
    expect(port.run.mock.calls.map(([command]) => command.kind)).toEqual([
      "connector.stop",
      "connector.start",
    ]);
  });
  it("does not restart an unchanged current connection by accident", async () => {
    const port = harness();
    expect(
      await new GuidedConnectionUpdate().run(port, {
        tunnelId: port.read().tunnelId!,
        runtimeKey: "",
      }),
    ).toEqual({ ok: true });
    expect(port.run).not.toHaveBeenCalled();
  });
  it("permits a deliberate reconnect of the current connection", async () => {
    const port = harness();
    expect(
      await new GuidedConnectionUpdate().run(
        port,
        { tunnelId: port.read().tunnelId!, runtimeKey: "" },
        true,
      ),
    ).toEqual({ ok: true });
    expect(port.run.mock.calls.map(([command]) => command.kind)).toEqual([
      "connector.stop",
      "connector.start",
    ]);
  });
  it.each(["connector.stop", "connector.configure", "connector.start"])(
    "never continues or retries after %s fails",
    async (failed) => {
      const port = harness();
      const original = port.run;
      port.run = vi.fn(async (command) =>
        command.kind === failed ? false : original(command),
      );
      expect(
        (
          await new GuidedConnectionUpdate().run(port, {
            tunnelId: port.read().tunnelId!,
            runtimeKey: replacement,
          })
        ).ok,
      ).toBe(false);
      const calls = port.run.mock.calls.map(([command]) => command.kind);
      expect(calls.at(-1)).toBe(failed);
      expect(calls.filter((kind) => kind === failed)).toHaveLength(1);
    },
  );
  it("requires observed stopped state, not a successful-looking reply", async () => {
    const port = harness();
    port.run = vi.fn(async () => true);
    expect(
      await new GuidedConnectionUpdate().run(port, {
        tunnelId: port.read().tunnelId!,
        runtimeKey: replacement,
      }),
    ).toEqual({ ok: false, reason: "state-changed" });
    expect(port.run).toHaveBeenCalledTimes(1);
  });
  it("does not apply a draft if the workspace changes during stop", async () => {
    const port = harness();
    const original = port.run;
    port.run = vi.fn(async (command) => {
      const ok = await original(command);
      port.set({ ...port.read(), authority: "different-folder-generation" });
      return ok;
    });
    expect(
      await new GuidedConnectionUpdate().run(port, {
        tunnelId: port.read().tunnelId!,
        runtimeKey: replacement,
      }),
    ).toEqual({ ok: false, reason: "state-changed" });
    expect(port.run).toHaveBeenCalledTimes(1);
  });
  it.each(["outcome_unknown", "ready"] as const)(
    "does not erase an unknown outcome in state %s",
    async (runtime) => {
      const port = harness({ ...saved(), runtime, outcomeUnknown: true });
      expect(
        await new GuidedConnectionUpdate().run(port, {
          tunnelId: port.read().tunnelId!,
          runtimeKey: replacement,
        }),
      ).toEqual({ ok: false, reason: "inspect-existing-operation" });
      expect(port.run).not.toHaveBeenCalled();
    },
  );
  it("does not reconnect after an unconfirmed stop", async () => {
    const port = harness();
    port.run = vi.fn(async () => {
      throw new Error("reply lost");
    });
    expect(
      await new GuidedConnectionUpdate().run(port, {
        tunnelId: port.read().tunnelId!,
        runtimeKey: replacement,
      }),
    ).toEqual({ ok: false, reason: "inspect-existing-operation" });
    expect(port.run).toHaveBeenCalledTimes(1);
  });
  it("rejects a second click while a save is in flight", async () => {
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
    const update = new GuidedConnectionUpdate();
    const values = { tunnelId: port.read().tunnelId!, runtimeKey: replacement };
    const first = update.run(port, values);
    expect(await update.run(port, values)).toEqual({
      ok: false,
      reason: "busy",
    });
    release();
    expect(await first).toEqual({ ok: true });
  });
});

describe("setup navigation and truthful draft states", () => {
  it("keeps stored secrets absent from the input model", () => {
    const facts = saved();
    expect(
      connectionDraftChanged(facts, {
        tunnelId: facts.tunnelId!,
        runtimeKey: "",
      }),
    ).toBe(false);
    expect(
      connectionDraftChanged(facts, {
        tunnelId: facts.tunnelId!,
        runtimeKey: replacement,
      }),
    ).toBe(true);
    expect(
      connectionDraftChanged(facts, {
        tunnelId: "tunnel_changed",
        runtimeKey: "",
      }),
    ).toBe(true);
  });
  it("never paints unsaved connection changes or dependent app proof green", () => {
    expect(
      progressWithConnectionDraft([true, true, true, true, true], true),
    ).toEqual([true, true, false, false, false]);
    expect(
      progressWithConnectionDraft([true, true, true, true, true], false),
    ).toEqual([true, true, true, true, true]);
  });
  it("overview sends the owner to the first real unfinished step, not to itself", () => {
    expect(firstIncompleteSetupStep([true, true, false, false, false])).toBe(2);
    expect(
      firstIncompleteSetupStep([true, true, true, true, false]),
    ).toBeNull();
  });
  it("allows revisiting completed pages while offering a direct prerequisite action", () => {
    const progress = [true, true, false, false, false];
    expect(onboardingPrerequisite(0, progress)).toBeNull();
    expect(onboardingPrerequisite(1, progress)).toBeNull();
    expect(onboardingPrerequisite(2, progress)).toBeNull();
    expect(onboardingPrerequisite(3, progress)).toBe(2);
    expect(onboardingPrerequisite(3, [false, true, true, false, false])).toBe(
      0,
    );
  });
});
