import { describe, expect, it, vi } from "vitest";
import { commandAllowed } from "../../src/ui/renderer/command-eligibility";
import { computerSetup } from "../../src/ui/renderer/computer-setup";
import { WindowController } from "../../src/ui/renderer/controller";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
import { bootstrap, fixture, settings, signInReply } from "./fixture";

// Pure projections over real controller doubles. No host/provider acceptance.
const buildId = "3".repeat(64);
const runtimeGeneration = "a".repeat(64);
const workspaceId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-10-02T20:00:00.000Z";
function configured() {
  const value = settings();
  value.computer.workspaces = [
    {
      workspaceId,
      root: "/approved/project",
      label: "Project",
      access: "read",
      excludedPaths: [],
      rootIdentity: { device: "1", inode: "2" },
      accessCheck: {
        buildId,
        computerGeneration: 1,
        verifiedAt: timestamp,
        rootIdentity: { device: "1", inode: "2" },
      },
    },
  ];
  const witness = {
    profile: "farol-next",
    configRevision: 1,
    workspaceId,
    runtimeGeneration,
    buildId,
    protocol: "secure-mcp",
    verifiedAt: timestamp,
  };
  value.setup.computer.verified = witness;
  value.setup.connect.verified = witness;
  value.connectors.secureMcp = {
    ...value.connectors.secureMcp,
    tunnelId: "owner-tunnel",
    credential: "stored",
    tunnelClient: {
      executablePath: "/approved/tunnel",
      executableSha256: "b".repeat(64),
      version: "1.0.0",
      protocol: "openai-tunnel-client/v1",
      verifiedAt: timestamp,
    },
    runtime: {
      state: "ready",
      connectorGeneration: 1,
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      observedAt: timestamp,
    },
    challenge: {
      value: "33333333-3333-4333-8333-333333333333",
      challengeSha256: "c".repeat(64),
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      preparedAt: timestamp,
    },
    attachment: {
      tunnelId: "owner-tunnel",
      workspaceId,
      connectorGeneration: 1,
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      challengeSha256: "c".repeat(64),
      receiptSha256: "d".repeat(64),
      verifiedAt: timestamp,
    },
  };
  return ProductSettingsSchema.parse(value);
}
async function snapshot(value = configured()) {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    configuration: { status: "ready", settings: value },
  });
  const c = new WindowController(f.api);
  try {
    await c.start();
    return c.getSnapshot();
  } finally {
    c.dispose();
  }
}
describe("current Computer setup projection", () => {
  it("verifies an empty catalogue without marking workspace access verified", async () => {
    const value = configured();
    const workspace = value.computer.workspaces[0]!;
    value.computer.workspaces = [];
    value.setup.computer.verified = null;
    value.setup.connect.verified!.workspaceId = null;
    value.connectors.secureMcp.attachment!.workspaceId = null;
    const setup = computerSetup(await snapshot(value));
    expect(setup.ready).toBe(true);
    expect(setup.localConnectionCurrent).toBe(true);
    expect(setup.externalAccessVerified).toBe(true);
    expect(setup.workspacesVerified).toBe(false);
    expect(setup.next).toBe(
      "Connection verified. No workspace access is enabled.",
    );
    value.computer.workspaces = [workspace];
    expect(computerSetup(await snapshot(value)).ready).toBe(false);
  });
  it("offers the catalogue challenge and Start for a configured empty workspace selection", async () => {
    const value = configured();
    value.computer.workspaces = [];
    value.setup.computer.verified = null;
    value.setup.connect.verified = null;
    value.connectors.secureMcp.attachment = null;
    const running = computerSetup(await snapshot(value));
    expect(running.ready).toBe(false);
    expect(running.externalChallenge).toMatchObject({
      workspaceId: null,
      root: null,
      value: value.connectors.secureMcp.challenge!.value,
    });
    expect(running.canCheckAttachment).toBe(true);
    value.connectors.secureMcp.runtime = null;
    value.connectors.secureMcp.challenge = null;
    const stopped = computerSetup(await snapshot(value));
    expect(stopped.canStart).toBe(true);
    expect(stopped.externalChallenge).toBeNull();
    expect(stopped.workspacesVerified).toBe(false);
  });
  it("external Computer readiness needs no embedded login", async () => {
    const setup = computerSetup(await snapshot());
    expect(setup.ready).toBe(true);
    expect(setup.label).toBe("Computer ready");
    expect(setup.embeddedChatGPT).toBe("Current sign-in is unknown");
    expect(setup.canStart).toBe(false);
    expect(setup.canReconnect).toBe(true);
  });
  it("login alone never means Computer ready", async () => {
    const value = settings();
    value.setup.chatgpt.verified = configured().setup.computer.verified;
    const setup = computerSetup(await snapshot(value));
    expect(setup.ready).toBe(false);
    expect(setup.embeddedChatGPT).toBe("Current sign-in is unknown");
  });
  it.each([
    "folder-build",
    "folder-generation",
    "folder-missing",
    "unchecked",
    "runtime-build",
    "runtime-generation",
    "connector-generation",
    "attachment-workspace",
    "attachment-tunnel",
    "witness-build",
    "witness-generation",
    "witness-runtime",
    "witness-workspace",
    "challenge-hash",
    "history-only",
  ])("does not reuse stale or mismatched readiness: %s", async (mismatch) => {
    const value = configured();
    const connector = value.connectors.secureMcp;
    if (mismatch === "folder-build")
      value.setup.computer.verified!.buildId = "e".repeat(64);
    if (mismatch === "folder-generation") value.computer.generation++;
    if (mismatch === "folder-missing")
      value.setup.computer.verified!.workspaceId =
        "44444444-4444-4444-8444-444444444444";
    if (mismatch === "unchecked")
      value.computer.workspaces[0]!.accessCheck = null;
    if (mismatch === "runtime-build")
      connector.runtime!.buildId = "e".repeat(64);
    if (mismatch === "runtime-generation")
      connector.runtime!.runtimeGeneration = "e".repeat(64);
    if (mismatch === "connector-generation") connector.generation++;
    if (mismatch === "attachment-workspace")
      connector.attachment!.workspaceId =
        "44444444-4444-4444-8444-444444444444";
    if (mismatch === "attachment-tunnel")
      connector.attachment!.tunnelId = "other-tunnel";
    if (mismatch === "witness-build")
      value.setup.connect.verified!.buildId = "e".repeat(64);
    if (mismatch === "witness-generation")
      value.setup.connect.verified!.configRevision++;
    if (mismatch === "witness-runtime")
      value.setup.connect.verified!.runtimeGeneration = "e".repeat(64);
    if (mismatch === "witness-workspace")
      value.setup.connect.verified!.workspaceId =
        "44444444-4444-4444-8444-444444444444";
    if (mismatch === "challenge-hash")
      connector.attachment!.challengeSha256 = "e".repeat(64);
    if (mismatch === "history-only") {
      connector.lastVerifiedAttachment = connector.attachment;
      connector.attachment = null;
    }
    expect(computerSetup(await snapshot(value)).ready).toBe(false);
  });
  it.each(["ready", "unreachable", "outcome_unknown"] as const)(
    "Start always requires a null runtime, including %s",
    async (state) => {
      const value = configured();
      value.connectors.secureMcp.runtime!.state = state;
      const setup = computerSetup(await snapshot(value));
      expect(setup.canStart).toBe(false);
      expect(setup.canReconnect).toBe(state !== "outcome_unknown");
    },
  );
  it("allows explicit Start only after host state records a stopped runtime", async () => {
    const value = configured();
    value.connectors.secureMcp.runtime = null;
    value.connectors.secureMcp.challenge = null;
    value.connectors.secureMcp.attachment = null;
    const setup = computerSetup(await snapshot(value));
    expect(setup.ready).toBe(false);
    expect(setup.canStart).toBe(true);
    expect(setup.canReconnect).toBe(false);
  });
  it.each(["pending", "refused", "unknown"] as const)(
    "keeps independent optional Model/Chat browser %s separate from Computer",
    async (state) => {
      const current = await snapshot();
      for (const kind of [
        "model.preview",
        "model.apply",
        "model.rollback",
        "model.rotate-token",
        "model.status",
        "chatgpt.open-browser",
        "chatgpt.present-browser",
        "chatgpt.toggle-sidebar",
      ]) {
        const id = `settings:${kind}:`;
        const next = {
          ...current,
          intents: { [id]: { id, state, code: null } },
        };
        expect(computerSetup(next).ready).toBe(true);
        expect(computerSetup(next).canReconnect).toBe(true);
        expect(commandAllowed(next, "connector.repair")).toBe(true);
      }
    },
  );
  it("keeps retained optional Chat readiness unknown without changing Computer evidence", async () => {
    const value = configured();
    value.setup.chatgpt.outcomeUnknown = true;
    const current = await snapshot(value);
    expect(computerSetup(current).ready).toBe(true);
    expect(computerSetup(current).embeddedChatGPT).toBe("Outcome unknown");
    expect(commandAllowed(current, "connector.repair")).toBe(true);
    expect(commandAllowed(current, "chatgpt.verify")).toBe(false);
    expect(current.configuration).toEqual({ status: "ready", settings: value });
  });
  it.each([
    "chatgpt.open-sign-in",
    "chatgpt.verify",
    "general.update",
    "connector.repair",
    "computer.check-folder",
    "unclassified",
  ])("preserves shared-writer or unclassified unknown: %s", async (kind) => {
    const current = await snapshot();
    const id = `settings:${kind}:`;
    const next = {
      ...current,
      intents: { [id]: { id, state: "unknown" as const, code: null } },
    };
    expect(computerSetup(next).ready).toBe(false);
    expect(commandAllowed(next, "connector.repair")).toBe(false);
    expect(commandAllowed(next, "model.status")).toBe(false);
  });
  it.each(["computer", "connect", "hosts", "verify"] as const)(
    "keeps actual owner uncertainty fenced: %s",
    async (step) => {
      const value = configured();
      value.setup[step].outcomeUnknown = true;
      expect(computerSetup(await snapshot(value)).ready).toBe(false);
    },
  );
  it("allows a new model observation without retrying an unknown status or clearing an unknown apply", async () => {
    const current = await snapshot();
    const id = "settings:model.apply:";
    const unknown = { id, state: "unknown" as const, code: null };
    const next = { ...current, intents: { [id]: unknown } };
    expect(commandAllowed(next, "model.status")).toBe(true);
    expect(commandAllowed(next, "model.apply")).toBe(false);
    expect(commandAllowed(next, "model.rollback")).toBe(false);
    expect(commandAllowed(next, "connector.repair")).toBe(true);
    expect(commandAllowed(next, "computer.check-folder", workspaceId)).toBe(
      true,
    );
    expect(commandAllowed(next, "computer.check-folder", "missing")).toBe(
      false,
    );
    const observation = "settings:model.status:";
    expect(
      commandAllowed(
        {
          ...next,
          intents: {
            ...next.intents,
            [observation]: { id: observation, state: "unknown", code: null },
          },
        },
        "model.status",
      ),
    ).toBe(false);
    expect(next.intents[id]).toBe(unknown);
  });
  it("fails closed for missing retention, mismatched intent IDs and uncertain writer refusals", async () => {
    const current = await snapshot();
    const local = {
      id: "settings:model.apply:",
      state: "unknown" as const,
      code: null,
    };
    expect(
      commandAllowed(current, "connector.repair", undefined, [local]),
    ).toBe(false);
    expect(
      computerSetup({ ...current, intents: { foreign: local } }).ready,
    ).toBe(false);
    expect(
      computerSetup({
        ...current,
        intents: {
          [local.id]: {
            ...local,
            state: "refused",
            code: "SETTINGS_WRITE_FAILED",
          },
        },
      }).ready,
    ).toBe(false);
    expect(
      computerSetup({
        ...current,
        intents: {
          "settings:model.apply:foreign": {
            ...local,
            id: "settings:model.apply:foreign",
          },
        },
      }).ready,
    ).toBe(false);
  });
  it.each(["pending", "unknown", "stale"])(
    "fences presentation and commands for %s",
    async (fence) => {
      const current = await snapshot();
      const next =
        fence === "stale"
          ? { ...current, status: "stale" as const }
          : {
              ...current,
              intents: {
                ...current.intents,
                foreign: {
                  id: "foreign",
                  state: fence as "pending" | "unknown",
                  code: null,
                },
              },
            };
      const setup = computerSetup(next);
      expect(setup.ready).toBe(false);
      expect(setup.canReconnect).toBe(false);
      expect(setup.externalChallenge).toBeNull();
    },
  );
});

describe("external verification challenge provenance", () => {
  it("uses the exact verified workspace even when another saved folder comes first", async () => {
    const value = configured();
    value.connectors.secureMcp.attachment = null;
    value.setup.connect.verified = null;
    const other = structuredClone(value.computer.workspaces[0]!);
    other.workspaceId = "44444444-4444-4444-8444-444444444444";
    other.root = "/other/folder";
    value.computer.workspaces.unshift(other);
    const setup = computerSetup(await snapshot(value));
    expect(setup.externalChallenge).toEqual({
      value: value.connectors.secureMcp.challenge!.value,
      workspaceId,
      root: "/approved/project",
      tunnelId: "owner-tunnel",
    });
  });
  it.each(["build", "runtime", "computer", "connector", "missing-workspace"])(
    "hides a mismatched challenge instead of selecting another grant: %s",
    async (mismatch) => {
      const value = configured();
      const connector = value.connectors.secureMcp;
      connector.attachment = null;
      value.setup.connect.verified = null;
      if (mismatch === "build") connector.challenge!.buildId = "e".repeat(64);
      if (mismatch === "runtime")
        connector.challenge!.runtimeGeneration = "e".repeat(64);
      if (mismatch === "computer") connector.challenge!.computerGeneration++;
      if (mismatch === "connector") connector.generation++;
      if (mismatch === "missing-workspace")
        value.setup.computer.verified!.workspaceId =
          "44444444-4444-4444-8444-444444444444";
      expect(computerSetup(await snapshot(value)).externalChallenge).toBeNull();
    },
  );
});

// Account status is a window read; external Computer evidence has its own fence.
describe("embedded sign-in and external Computer are independent", () => {
  it.each(["authenticated", "signed_out", "unknown"] as const)(
    "%s current account state supersedes saved Ready without changing external readiness or command eligibility",
    async (state) => {
      const value = configured();
      value.setup.chatgpt.verified = {
        ...value.setup.computer.verified!,
        workspaceId: null,
      };
      const f = fixture();
      vi.mocked(f.api.bootstrap).mockResolvedValue({
        ...bootstrap(),
        configuration: { status: "ready", settings: value },
      });
      vi.mocked(f.api.configure).mockImplementation(async (command) =>
        command.kind === "chatgpt.observe-sign-in"
          ? signInReply(command, state)
          : {},
      );
      const c = new WindowController(f.api);
      try {
        await c.start();
        const before = computerSetup(c.getSnapshot());
        c.navigate({ area: "setup", setupStep: "signin" });
        await Promise.resolve();
        const after = computerSetup(c.getSnapshot());
        expect(after.embeddedChatGPT).toBe(
          state === "authenticated"
            ? "Signed in"
            : state === "signed_out"
              ? "Signed out"
              : "Current sign-in is unknown",
        );
        expect(after.ready).toBe(true);
        expect(after.externalAccessVerified).toBe(true);
        expect(after.canVerifyEmbeddedApp).toBe(before.canVerifyEmbeddedApp);
        expect(commandAllowed(c.getSnapshot(), "connector.repair")).toBe(true);
      } finally {
        c.dispose();
      }
    },
  );
});
