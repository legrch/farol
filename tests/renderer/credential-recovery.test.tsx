import { describe, expect, it, vi } from "vitest";
import {
  ProductSettingsSchema,
  type ProductConfigurationCommand,
} from "../../src/pkg/product-settings/contract";
import type { Intent, WindowSnapshot } from "../../src/ui/renderer/contract";
import { commandAllowed } from "../../src/ui/renderer/command-eligibility";
import { initial } from "../../apps/desktop/renderer/snapshot";
import { buildId, change, mount, readySettings } from "./setup-fixture";

// The Setup form may send its one retry only while main says it holds the
// recovery for the exact fenced document. These tests pin that the renderer's
// copy of that statement is advisory and narrow: one command, one exact match.
// Scripted replies only; main still re-validates, which its own tests pin.
const key = "synthetic-key-do-not-retain";
const generation = 3;
const revision = 5;

function document(at: number, fence: boolean) {
  const value = readySettings();
  value.connectors.secureMcp.runtime = null;
  value.connectors.secureMcp.generation = generation;
  value.revision = at;
  value.setup.connect.outcomeUnknown = fence;
  return ProductSettingsSchema.parse(value);
}
const fenced = () => document(revision, true);
const open = (at = revision - 1) => document(at, false);

function snapshot(
  credentialRecovery: WindowSnapshot["credentialRecovery"],
  intents: Record<string, Intent> = {},
  settings = fenced(),
): WindowSnapshot {
  return {
    ...initial,
    status: "current",
    runtime: "ready",
    buildId,
    configuration: { status: "ready", settings },
    intents,
    ...(credentialRecovery === undefined ? {} : { credentialRecovery }),
  };
}

const attempt = `settings:connector.save-and-connect:${"1".repeat(36)}`;
const match = { generation, revision };

describe("save-and-connect eligibility over a recoverable credential fence", () => {
  it("refuses with no recovery flag", () => {
    expect(
      commandAllowed(snapshot(undefined), "connector.save-and-connect"),
    ).toBe(false);
    expect(commandAllowed(snapshot(null), "connector.save-and-connect")).toBe(
      false,
    );
  });

  it("allows only save-and-connect when the flag matches generation and revision", () => {
    const current = snapshot(match);
    expect(commandAllowed(current, "connector.save-and-connect")).toBe(true);
    for (const kind of [
      "connector.configure",
      "connector.start",
      "connector.repair",
      "connector.stop",
      "connector.discover-client",
      "connector.select-client",
      "connector.check-health",
      "computer.choose-workspace",
    ] as const)
      expect(commandAllowed(current, kind), kind).toBe(false);
  });

  it.each([
    ["generation", { generation: generation + 1, revision }],
    ["revision", { generation, revision: revision + 1 }],
    ["both", { generation: generation - 1, revision: revision - 1 }],
  ])("refuses a stale flag that names another %s", (_name, stale) => {
    expect(commandAllowed(snapshot(stale), "connector.save-and-connect")).toBe(
      false,
    );
  });

  it("keeps an uncertain runtime refused even with a matching flag", () => {
    const value = fenced();
    value.connectors.secureMcp.runtime = {
      state: "outcome_unknown",
      connectorGeneration: 1,
      computerGeneration: 1,
      runtimeGeneration: "a".repeat(64),
      buildId,
      observedAt: "2026-10-02T20:00:00.000Z",
    };
    expect(
      commandAllowed(snapshot(match, {}, value), "connector.save-and-connect"),
    ).toBe(false);
  });

  it("passes the earlier failed save-and-connect attempt, and nothing else", () => {
    const failed: Intent = {
      id: attempt,
      state: "unknown",
      code: "SETTINGS_WRITE_FAILED",
    };
    expect(
      commandAllowed(
        snapshot(match, { [attempt]: failed }),
        "connector.save-and-connect",
      ),
    ).toBe(true);
    expect(
      commandAllowed(
        snapshot(null, { [attempt]: failed }),
        "connector.save-and-connect",
      ),
    ).toBe(false);
    // An unrelated uncertain write still fences the retry.
    const other: Intent = {
      id: "settings:general.update:",
      state: "unknown",
      code: "SETTINGS_WRITE_FAILED",
    };
    expect(
      commandAllowed(
        snapshot(match, { [attempt]: failed, [other.id]: other }),
        "connector.save-and-connect",
      ),
    ).toBe(false);
    // So does a retry that is already in flight.
    expect(
      commandAllowed(
        snapshot(match, {
          [attempt]: {
            id: attempt,
            state: "pending",
            code: null,
            inFlight: true,
          },
        }),
        "connector.save-and-connect",
      ),
    ).toBe(false);
  });
});

async function setup(
  value = fenced(),
  recovery?: WindowSnapshot["credentialRecovery"],
) {
  const h = await mount({
    step: "connection",
    value,
    ...(recovery === undefined ? {} : { credentialRecovery: recovery }),
  });
  const inputs = () =>
    h.host.querySelectorAll<HTMLInputElement>(".connection-credentials input");
  const sent = () =>
    vi
      .mocked(h.f.api.configure)
      .mock.calls.map(([command]) => command as ProductConfigurationCommand)
      .filter((command) => command.kind !== "chatgpt.observe-sign-in");
  const hintText = () =>
    h.host.querySelector<HTMLElement>(".connection-recovery-hint")?.textContent;
  const gate = () =>
    h.host
      .querySelector<HTMLElement>(".setup-gate-status")!
      .getAttribute("data-result-state");
  return { ...h, inputs, sent, hintText, gate };
}

describe("Setup Connect this Mac page over a recoverable credential fence", () => {
  it("enables Connect and explains the retry when the flag matches", async () => {
    const h = await setup(fenced(), match);
    await change(h.inputs()[1]!, key);
    expect(h.button("Connect")!.disabled).toBe(false);
    expect(h.hintText()).toBe(
      "The last key change did not finish saving. Enter the same key again to complete it.",
    );
  });

  it("keeps Connect disabled and silent for a stale flag", async () => {
    const h = await setup(fenced(), { generation, revision: revision + 1 });
    await change(h.inputs()[1]!, key);
    expect(h.button("Connect")!.disabled).toBe(true);
    expect(h.hintText()).toBeUndefined();
  });

  it("keeps Connect disabled and silent with no flag", async () => {
    const h = await setup(fenced());
    await change(h.inputs()[1]!, key);
    expect(h.button("Connect")!.disabled).toBe(true);
    expect(h.hintText()).toBeUndefined();
  });

  it("retries once through the form and retires the failed attempt when it settles", async () => {
    const h = await setup(open());
    // First attempt: main reports that the completion save failed. The fence stays.
    h.reply(async (command) =>
      command.kind === "connector.save-and-connect"
        ? {
            ok: false,
            error: "SETTINGS_WRITE_FAILED",
            snapshot: { status: "ready", settings: fenced() },
          }
        : { ok: true, snapshot: h.configuration() },
    );
    await change(h.inputs()[1]!, key);
    await h.click("Connect");
    expect(h.sent().map((c) => c.kind)).toEqual(["connector.save-and-connect"]);
    expect(h.gate()).toBe("unknown");
    expect(h.button("Connect")!.disabled).toBe(true);

    // Main now publishes the recovery it retained; the form may retry once.
    await h.publish(fenced(), match);
    expect(h.c.getSnapshot().credentialRecovery).toEqual(match);
    h.reply(async (command) =>
      command.kind === "connector.save-and-connect"
        ? {
            ok: true,
            snapshot: { status: "ready", settings: open(revision + 1) },
            connectorSetup: {
              kind: command.kind,
              operationId: command.operationId,
              buildId: command.buildId,
              state: "completed" as const,
              stoppedAt: "complete" as const,
              credentials: "saved" as const,
              connection: "connected" as const,
              code: null,
              externalVerification: "not-proven" as const,
            },
          }
        : { ok: true, snapshot: h.configuration() },
    );
    await change(h.inputs()[1]!, key);
    expect(h.button("Connect")!.disabled).toBe(false);
    await h.click("Connect");
    expect(
      h.sent().filter((c) => c.kind === "connector.save-and-connect"),
    ).toHaveLength(2);

    // The retry completed the very change the failed attempt began: the
    // earlier uncertain receipt no longer fences Setup once main drops the flag.
    await h.publish(open(revision + 1), null);
    expect(h.c.getSnapshot().credentialRecovery).toBeNull();
    const attempts = Object.values(h.c.getSnapshot().intents).filter((intent) =>
      intent.id.startsWith("settings:connector.save-and-connect:"),
    );
    expect(attempts.map((intent) => intent.state)).toEqual([
      "applied",
      "applied",
    ]);
    expect(h.gate()).not.toBe("unknown");
  });
});
