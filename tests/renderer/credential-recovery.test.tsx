import { describe, expect, it, vi } from "vitest";
import {
  ProductSettingsSchema,
  type ProductConfigurationCommand,
  type ProductConfigurationResult,
} from "../../src/pkg/product-settings/contract";
import type { Intent, WindowSnapshot } from "../../src/ui/renderer/contract";
import {
  commandAllowed,
  dependencyFences,
} from "../../src/ui/renderer/command-eligibility";
import { initial } from "../../apps/desktop/renderer/snapshot";
import { runAdmittedConnectorSetup } from "../../apps/desktop/connector-setup-host";
import { buildId, change, mount, readySettings } from "./setup-fixture";

// The Setup form may send its one retry only while main says it holds the
// recovery for the exact fenced document. These tests pin that the renderer's
// copy of that statement is advisory and narrow: one command, one exact match.
// Scripted replies only; main still re-validates, which its own tests pin.
// Failed and refused replies are built by the real connector-setup host, so
// they carry the receipt shape the window actually receives.
const key = "synthetic-key-do-not-retain";
const generation = 3;
const revision = 5;
const tunnelId = "synthetic-tunnel";

function document(at: number, fence: boolean, runtime = false) {
  const value = readySettings();
  if (!runtime) value.connectors.secureMcp.runtime = null;
  else value.connectors.secureMcp.runtime!.connectorGeneration = generation;
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
  setupCheckOrder?: Record<string, number>,
): WindowSnapshot {
  return {
    ...initial,
    status: "current",
    runtime: "ready",
    buildId,
    configuration: { status: "ready", settings },
    intents,
    ...(setupCheckOrder ? { setupCheckOrder } : {}),
    ...(credentialRecovery === undefined ? {} : { credentialRecovery }),
  };
}

const attempt = `settings:connector.save-and-connect:${"1".repeat(36)}`;
const later = `settings:connector.save-and-connect:${"2".repeat(36)}`;
const match = { generation, revision, tunnelId };

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
    ["generation", { ...match, generation: generation + 1 }],
    ["revision", { ...match, revision: revision + 1 }],
    ["both", { ...match, generation: generation - 1, revision: revision - 1 }],
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

// The earlier receipt keeps its recorded outcome forever. Readiness comes from
// the current document: once a later receipt settled over a cleared fence with
// the key stored, the older uncertain attempt no longer fences anything.
describe("an earlier uncertain attempt over a settled document", () => {
  const old: Intent = {
    id: attempt,
    state: "unknown",
    code: "SETTINGS_WRITE_FAILED",
  };
  const applied: Intent = { id: later, state: "applied", code: null };
  const order = { [attempt]: 1, [later]: 2 };
  const unknown = (
    intents: Record<string, Intent>,
    settings = document(revision + 1, false),
    ordering: Record<string, number> | undefined = order,
  ) =>
    dependencyFences(snapshot(null, intents, settings, ordering), "computer")
      .unknown;

  it("stops fencing after a later applied receipt and keeps its own outcome", () => {
    expect(unknown({ [attempt]: old, [later]: applied })).toBe(false);
    expect(old.state).toBe("unknown");
  });

  it("stops fencing after a later known refusal", () => {
    expect(
      unknown({
        [attempt]: old,
        [later]: {
          id: later,
          state: "refused",
          code: "CONNECTOR_START_FAILED",
        },
      }),
    ).toBe(false);
  });

  const unknownLater: Intent = { id: later, state: "unknown", code: null };
  const inFlight: Intent = {
    id: later,
    state: "pending",
    code: null,
    inFlight: true,
  };
  it.each<[string, Record<string, Intent>, Record<string, number> | undefined]>(
    [
      ["no later receipt", { [attempt]: old }, undefined],
      [
        "a later receipt that is itself uncertain",
        { [attempt]: old, [later]: unknownLater },
        undefined,
      ],
      [
        "a later receipt still in flight",
        { [attempt]: old, [later]: inFlight },
        undefined,
      ],
      [
        "a later receipt with no recorded order",
        { [attempt]: old, [later]: applied },
        {},
      ],
      [
        "a receipt older than the uncertain attempt",
        { [attempt]: old, [later]: applied },
        { [attempt]: 2, [later]: 1 },
      ],
      [
        "an unrelated uncertain receipt",
        {
          "settings:general.update:": {
            id: "settings:general.update:",
            state: "unknown",
            code: null,
          },
          [later]: applied,
        },
        undefined,
      ],
    ],
  )("keeps fencing with %s", (_name, intents, ordering) => {
    expect(
      unknown(intents, document(revision + 1, false), ordering ?? order),
    ).toBe(true);
  });

  it("keeps fencing while the fence itself is still set", () => {
    expect(
      unknown(
        { [attempt]: old, [later]: applied },
        document(revision + 1, true),
      ),
    ).toBe(true);
  });

  it("keeps fencing when no key is stored", () => {
    const value = document(revision + 1, false);
    value.connectors.secureMcp.credential = "missing";
    expect(unknown({ [attempt]: old, [later]: applied }, value)).toBe(true);
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

// The reply the window really receives: the connector-setup host maps the
// scripted owner results into the receipt-bearing result.
function setupReply(
  command: Extract<
    ProductConfigurationCommand,
    { kind: "connector.save-and-connect" }
  >,
  owner: {
    before: ProductConfigurationResult["snapshot"];
    save: ProductConfigurationResult;
    start?: ProductConfigurationResult;
  },
) {
  const ok = { ok: true as const, snapshot: owner.before };
  return runAdmittedConnectorSetup(
    { operationId: command.operationId, buildId: command.buildId },
    command.tunnelId,
    {
      admission: () => ok,
      current: () => (owner.save.ok ? owner.save.snapshot : owner.before),
      save: async () => owner.save,
      start: async () => owner.start ?? ok,
    },
  );
}
const ready = (settings: ReturnType<typeof document>) =>
  ({ status: "ready" as const, settings }) as const;

describe("Setup Connect this Mac page over a recoverable credential fence", () => {
  it("enables Connect and explains the retry when the flag matches", async () => {
    const h = await setup(fenced(), match);
    await change(h.inputs()[1]!, key);
    expect(h.button("Connect")!.disabled).toBe(false);
    expect(h.hintText()).toBe(
      "The last key change for tunnel synthetic-tunnel did not finish saving. Enter the same key for that tunnel again to complete it.",
    );
  });

  it("names the original tunnel after the form is remounted", async () => {
    const h = await setup(fenced(), { ...match, tunnelId: "replacement-7" });
    await h.remount();
    expect(h.hintText()).toContain("replacement-7");
    // The saved tunnel field is not what names it: it still holds the old one.
    expect(h.inputs()[0]!.value).toBe(tunnelId);
  });

  it("keeps the generic hint when the recovery names no tunnel", async () => {
    const h = await setup(fenced(), { ...match, tunnelId: null });
    expect(h.hintText()).toBe(
      "The last key change did not finish saving. Enter the same key again to complete it.",
    );
  });

  it("keeps Connect disabled until a key is entered, even with a stored key", async () => {
    const h = await setup(fenced(), match);
    expect(h.inputs()[1]!.value).toBe("");
    expect(h.button("Connect")!.disabled).toBe(true);
    await change(h.inputs()[1]!, key);
    expect(h.button("Connect")!.disabled).toBe(false);
    await change(h.inputs()[1]!, "");
    expect(h.button("Connect")!.disabled).toBe(true);
  });

  it("keeps Connect disabled and silent for a stale flag", async () => {
    const h = await setup(fenced(), { ...match, revision: revision + 1 });
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

  // First attempt: the credential owner reports that the completion save
  // failed, through the real receipt-bearing reply. The fence stays.
  async function failFirstAttempt() {
    const h = await setup(open());
    h.reply(async (command) =>
      command.kind === "connector.save-and-connect"
        ? setupReply(command, {
            before: ready(open()),
            save: {
              ok: false,
              error: "SETTINGS_WRITE_FAILED",
              snapshot: ready(fenced()),
            },
          })
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
    return h;
  }
  const savedReceipts = (h: Awaited<ReturnType<typeof setup>>) =>
    Object.values(h.c.getSnapshot().intents).filter((intent) =>
      intent.id.startsWith("settings:connector.save-and-connect:"),
    );

  it("lets Setup proceed after a settled retry while the old receipt stays unknown", async () => {
    const h = await failFirstAttempt();
    h.reply(async (command) => {
      if (command.kind !== "connector.save-and-connect")
        return { ok: true, snapshot: h.configuration() };
      const settled = document(revision + 1, false, true);
      return {
        ok: true,
        snapshot: ready(settled),
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
      };
    });
    await change(h.inputs()[1]!, key);
    expect(h.button("Connect")!.disabled).toBe(false);
    await h.click("Connect");
    await h.publish(document(revision + 1, false, true), null);

    expect(h.c.getSnapshot().credentialRecovery).toBeNull();
    // History is never reinterpreted: the first attempt stays uncertain.
    expect(savedReceipts(h).map((intent) => intent.state)).toEqual([
      "unknown",
      "applied",
    ]);
    expect(h.gate()).toBe("success");
    expect(h.button("Continue")!.disabled).toBe(false);
  });

  it("shows a known Start refusal normally instead of locking Setup", async () => {
    const h = await failFirstAttempt();
    h.reply(async (command) => {
      if (command.kind !== "connector.save-and-connect")
        return { ok: true, snapshot: h.configuration() };
      const saved = ready(document(revision + 1, false));
      return setupReply(command, {
        before: ready(fenced()),
        save: { ok: true, snapshot: saved },
        start: { ok: false, error: "CONNECTOR_START_FAILED", snapshot: saved },
      });
    });
    await change(h.inputs()[1]!, key);
    await h.click("Connect");
    await h.publish(document(revision + 1, false), null);

    expect(
      savedReceipts(h).map((intent) => [intent.state, intent.code]),
    ).toEqual([
      ["unknown", "SETTINGS_WRITE_FAILED"],
      ["refused", "CONNECTOR_START_FAILED"],
    ]);
    expect(h.gate()).toBe("refused");
    // The form can be used again: nothing uncertain is left to wait for.
    expect(h.inputs()[1]!.disabled).toBe(false);
  });
});
