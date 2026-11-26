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
  recoveryRetries?: Record<string, typeof match>,
): WindowSnapshot {
  return {
    ...initial,
    status: "current",
    runtime: "ready",
    buildId,
    configuration: { status: "ready", settings },
    intents,
    ...(setupCheckOrder ? { setupCheckOrder } : {}),
    ...(recoveryRetries ? { recoveryRetries } : {}),
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
// the current document: an uncertain attempt stops fencing only when a later
// retry that named the same fence identity saved the key, and the snapshot now
// shows the fence settled past that identity with the key stored. A refusal
// that did not save the key never outgrows it.
describe("an earlier uncertain attempt over a settled document", () => {
  const old: Intent = {
    id: attempt,
    state: "unknown",
    code: "SETTINGS_WRITE_FAILED",
  };
  const receipt = (
    credentials: "saved" | "refused" | "not-started",
    connection: "connected" | "refused" | "not-started" | "unknown",
    code: string | null,
  ) =>
    ({
      kind: "connector.save-and-connect",
      operationId: "2".repeat(8) + "-2222-4222-8222-" + "2".repeat(12),
      buildId,
      state: code === null ? "completed" : "refused",
      stoppedAt: "complete",
      credentials,
      connection,
      code,
      externalVerification: "not-proven",
    }) as NonNullable<Intent["connectorSetup"]>;
  const applied: Intent = {
    id: later,
    state: "applied",
    code: null,
    connectorSetup: receipt("saved", "connected", null),
  };
  const startRefused: Intent = {
    id: later,
    state: "refused",
    code: "CONNECTOR_START_FAILED",
    connectorSetup: receipt("saved", "refused", "CONNECTOR_START_FAILED"),
  };
  const order = { [attempt]: 1, [later]: 2 };
  const retries = { [later]: match };
  const unknown = (
    intents: Record<string, Intent>,
    options: {
      settings?: ReturnType<typeof document>;
      ordering?: Record<string, number>;
      retries?: Record<string, typeof match>;
    } = {},
  ) =>
    dependencyFences(
      snapshot(
        null,
        intents,
        options.settings ?? document(revision + 1, false),
        options.ordering ?? order,
        options.retries ?? retries,
      ),
      "computer",
    ).unknown;

  it("stops fencing after a later recovery retry that applied, and keeps its own outcome", () => {
    expect(unknown({ [attempt]: old, [later]: applied })).toBe(false);
    expect(old.state).toBe("unknown");
  });

  it("stops fencing after a recovery retry whose key was saved and whose Start was refused", () => {
    expect(unknown({ [attempt]: old, [later]: startRefused })).toBe(false);
  });

  const refused = (
    code: string,
    credentials: "refused" | "not-started",
  ): Intent => ({
    id: later,
    state: "refused",
    code,
    connectorSetup: receipt(credentials, "not-started", code),
  });
  it.each<[string, Record<string, Intent>, Parameters<typeof unknown>[1]]>([
    ["no later receipt", { [attempt]: old }, {}],
    [
      "a later unrelated refusal that carried no recovery",
      { [attempt]: old, [later]: refused("CONNECTOR_START_FAILED", "refused") },
      { retries: {} },
    ],
    [
      "a pre-admission refusal of a recovery retry",
      {
        [attempt]: old,
        [later]: refused("AUTHORITY_CHANGE_IN_PROGRESS", "not-started"),
      },
      {},
    ],
    [
      "a stale-recovery refusal",
      {
        [attempt]: old,
        [later]: refused("CONNECTOR_RECOVERY_STALE", "not-started"),
      },
      {},
    ],
    [
      "a recovery retry whose credential step was refused",
      {
        [attempt]: old,
        [later]: refused("CONNECTOR_CREDENTIAL_STORE_FAILED", "refused"),
      },
      {},
    ],
    [
      "an applied receipt that carried no recovery",
      { [attempt]: old, [later]: applied },
      { retries: {} },
    ],
    [
      "a refusal with no receipt at all",
      {
        [attempt]: old,
        [later]: { id: later, state: "refused", code: "X" },
      },
      {},
    ],
    [
      "a later receipt that is itself uncertain",
      { [attempt]: old, [later]: { id: later, state: "unknown", code: null } },
      {},
    ],
    [
      "a later receipt still in flight",
      {
        [attempt]: old,
        [later]: { id: later, state: "pending", code: null, inFlight: true },
      },
      {},
    ],
    [
      "a later receipt with no recorded order",
      { [attempt]: old, [later]: applied },
      { ordering: {} },
    ],
    [
      "a receipt older than the uncertain attempt",
      { [attempt]: old, [later]: applied },
      { ordering: { [attempt]: 2, [later]: 1 } },
    ],
    [
      "a retry that named a fence the document has not moved past",
      { [attempt]: old, [later]: applied },
      { retries: { [later]: { ...match, revision: revision + 1 } } },
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
      {},
    ],
  ])("keeps fencing with %s", (_name, intents, options) => {
    expect(unknown(intents, options)).toBe(true);
  });

  it("keeps fencing while the fence itself is still set", () => {
    expect(
      unknown(
        { [attempt]: old, [later]: applied },
        { settings: document(revision + 1, true) },
      ),
    ).toBe(true);
  });

  it("keeps fencing when no key is stored", () => {
    const value = document(revision + 1, false);
    value.connectors.secureMcp.credential = "missing";
    expect(
      unknown({ [attempt]: old, [later]: applied }, { settings: value }),
    ).toBe(true);
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
    admission?: ProductConfigurationResult;
  },
) {
  const ok = { ok: true as const, snapshot: owner.before };
  return runAdmittedConnectorSetup(
    { operationId: command.operationId, buildId: command.buildId },
    command.tunnelId,
    {
      admission: () => owner.admission ?? ok,
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

    // Only the retry names the fence it recovers; the first attempt did not.
    const saves = h
      .sent()
      .filter((c) => c.kind === "connector.save-and-connect");
    expect(
      saves.map((c) => ("recovery" in c ? c.recovery : undefined)),
    ).toEqual([undefined, match]);
    expect(h.c.getSnapshot().credentialRecovery).toBeNull();
    // History is never reinterpreted: the first attempt stays uncertain.
    expect(savedReceipts(h).map((intent) => intent.state)).toEqual([
      "unknown",
      "applied",
    ]);
    expect(h.gate()).toBe("success");
    expect(h.button("Continue")!.disabled).toBe(false);
  });

  it("keeps Setup fenced after a recovery retry that main refused as stale", async () => {
    const h = await failFirstAttempt();
    h.reply(async (command) =>
      command.kind === "connector.save-and-connect"
        ? setupReply(command, {
            before: ready(fenced()),
            save: { ok: true, snapshot: ready(fenced()) },
            admission: {
              ok: false,
              error: "CONNECTOR_RECOVERY_STALE",
              snapshot: ready(fenced()),
            },
          })
        : { ok: true, snapshot: h.configuration() },
    );
    await change(h.inputs()[1]!, key);
    await h.click("Connect");

    expect(
      savedReceipts(h).map((intent) => [intent.state, intent.code]),
    ).toEqual([
      ["unknown", "SETTINGS_WRITE_FAILED"],
      ["refused", "CONNECTOR_RECOVERY_STALE"],
    ]);
    expect(h.gate()).toBe("unknown");
  });

  it("drops a recovery flag that names a document the window no longer holds", async () => {
    const h = await setup(fenced(), match);
    expect(h.c.getSnapshot().credentialRecovery).toEqual(match);
    // The fence settles elsewhere; main's earlier statement is now stale.
    await h.publish(open(revision + 1));
    expect(h.c.getSnapshot().credentialRecovery).toBeNull();
    expect(h.hintText()).toBeUndefined();
    await change(h.inputs()[1]!, key);
    expect(
      commandAllowed(h.c.getSnapshot(), "connector.save-and-connect"),
    ).toBe(true);
    // A statement about another revision never survives adoption either.
    await h.publish(document(revision + 4, true), {
      ...match,
      revision: revision + 3,
    });
    expect(h.c.getSnapshot().credentialRecovery).toBeNull();
    expect(
      commandAllowed(h.c.getSnapshot(), "connector.save-and-connect"),
    ).toBe(false);
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
