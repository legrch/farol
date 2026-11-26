import { describe, expect, it } from "vitest";

import { defaultSettings } from "../../../src/apps/desktop/settings/rules";
import {
  CodexTaskSourceSchema,
  ProductSettingsSchema,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import {
  lastVerifiedAttachmentCapturable,
  legacyAppPendingSeparable,
  legacyVerificationWithdrawalPending,
  taskSourceWithdrawalFloor,
  withLastVerifiedAttachment,
  withLegacyAppPendingSeparated,
  withLegacyVerificationWithdrawn,
  type SecureMcpAttachment,
} from "./legacy";
import { withSecureMcpAppPending } from "./tunnel";

const uuid = "12345678-1234-4234-8234-123456789abc";
const other = "22345678-1234-4234-8234-123456789abc";
const sha = (character: string) => character.repeat(64);
const NOW = "2026-11-26T10:00:00.000Z";

type Connector = ProductSettings["connectors"]["secureMcp"];
type Connect = ProductSettings["setup"]["connect"];
type Workspace = ProductSettings["computer"]["workspaces"][number];

const base = (): ProductSettings => defaultSettings(() => uuid);

function withConnector(
  settings: ProductSettings,
  connector: Partial<Connector> = {},
  connect: Partial<Connect> = {},
  computer: Partial<ProductSettings["computer"]> = {},
): ProductSettings {
  return ProductSettingsSchema.parse({
    ...settings,
    computer: { ...settings.computer, ...computer },
    connectors: {
      ...settings.connectors,
      secureMcp: { ...settings.connectors.secureMcp, ...connector },
    },
    setup: {
      ...settings.setup,
      connect: { ...settings.setup.connect, ...connect },
    },
  });
}

const runtimeRecord = (overrides: Record<string, unknown> = {}) => ({
  state: "ready" as const,
  connectorGeneration: 2,
  runtimeGeneration: sha("1"),
  computerGeneration: 1,
  buildId: sha("2"),
  observedAt: NOW,
  ...overrides,
});

const challengeRecord = (overrides: Record<string, unknown> = {}) => ({
  value: other,
  challengeSha256: sha("4"),
  runtimeGeneration: sha("1"),
  computerGeneration: 1,
  buildId: sha("2"),
  preparedAt: NOW,
  ...overrides,
});

const PENDING_ACTION =
  "Check the pending ChatGPT connection result before sending another check.";

// What an older build saved for an external Send that was never resolved: the
// one outcome-unknown flag, the fixed instruction, a ready runtime and an
// intact challenge, and no separate pending-app record.
function legacyPending(
  connector: Partial<Connector> = {},
  connect: Partial<Connect> = {},
): ProductSettings {
  return withConnector(
    base(),
    {
      generation: 2,
      runtime: runtimeRecord(),
      challenge: challengeRecord(),
      ...connector,
    },
    { outcomeUnknown: true, needsAction: PENDING_ACTION, ...connect },
  );
}

describe("legacy pending app separation", () => {
  it("separates the exact legacy pending-app record", () => {
    expect(legacyAppPendingSeparable(legacyPending())).toBe(true);
  });

  it("separates when the explicit flag was saved as false or absent", () => {
    expect(
      legacyAppPendingSeparable(
        legacyPending({ appVerificationPending: false }),
      ),
    ).toBe(true);
  });

  it.each<[string, ProductSettings]>([
    ["no unknown outcome", legacyPending({}, { outcomeUnknown: false })],
    [
      "the fence is already separate",
      legacyPending({ appVerificationPending: true }),
    ],
    [
      "another instruction",
      legacyPending({}, { needsAction: "Verify the credential again." }),
    ],
    ["no instruction", legacyPending({}, { needsAction: null })],
    ["no runtime", legacyPending({ runtime: null })],
    [
      "a runtime that is not ready",
      legacyPending({ runtime: runtimeRecord({ state: "outcome_unknown" }) }),
    ],
    [
      "a runtime of another connector generation",
      legacyPending({ runtime: runtimeRecord({ connectorGeneration: 1 }) }),
    ],
    [
      "a runtime of another Computer generation",
      legacyPending({
        runtime: runtimeRecord({ computerGeneration: 2 }),
        challenge: challengeRecord({ computerGeneration: 2 }),
      }),
    ],
    ["no challenge", legacyPending({ challenge: null })],
    [
      "a challenge of another runtime",
      legacyPending({
        challenge: challengeRecord({ runtimeGeneration: sha("9") }),
      }),
    ],
    [
      "a challenge of another build",
      legacyPending({ challenge: challengeRecord({ buildId: sha("9") }) }),
    ],
    [
      "a challenge of another Computer generation",
      legacyPending({ challenge: challengeRecord({ computerGeneration: 2 }) }),
    ],
  ])("keeps the original fence for %s", (_, settings) => {
    expect(legacyAppPendingSeparable(settings)).toBe(false);
  });

  it("is a record the current pending transform also writes", () => {
    const current = withSecureMcpAppPending(
      legacyPending({}, { outcomeUnknown: false, needsAction: null }),
    );
    const legacy = withConnector(current, {
      appVerificationPending: undefined,
    });
    expect(legacy.setup.connect.needsAction).toBe(PENDING_ACTION);
    expect(legacyAppPendingSeparable(legacy)).toBe(true);
  });

  it("records the fence and leaves the instruction and unknown flag as saved", () => {
    const before = legacyPending();
    const next = withLegacyAppPendingSeparated(before);
    expect(next.revision).toBe(before.revision + 1);
    expect(next.connectors.secureMcp.appVerificationPending).toBe(true);
    expect(next.connectors.secureMcp).toEqual({
      ...before.connectors.secureMcp,
      appVerificationPending: true,
    });
    expect(next.setup).toBe(before.setup);
    expect(next.computer).toBe(before.computer);
    ProductSettingsSchema.parse(next);
    expect(legacyAppPendingSeparable(next)).toBe(false);
  });
});

const workspaceRecord = (overrides: Partial<Workspace> = {}): Workspace => ({
  workspaceId: uuid,
  root: "/fixture/project",
  label: "Project",
  access: "read",
  excludedPaths: [],
  ...overrides,
});

function withComputerVerified(
  workspaces: Workspace[],
  verifiedFor: string | null = uuid,
): ProductSettings {
  const settings = base();
  return ProductSettingsSchema.parse({
    ...settings,
    computer: { ...settings.computer, workspaces },
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        configured: workspaces.length > 0,
        reachable: "reachable",
        verified: {
          profile: "computer/1",
          configRevision: settings.computer.generation,
          workspaceId: verifiedFor,
          runtimeGeneration: "runtime-1",
          buildId: sha("a"),
          protocol: "computer/v1",
          verifiedAt: NOW,
        },
      },
    },
  });
}

const hostBinding = {
  executablePath: "/fixture/bin/codex",
  executableSha256: sha("a"),
  schemaSha256: sha("b"),
  version: "0.153.4",
};
const hostLocal = {
  executableSha256: hostBinding.executableSha256,
  schemaSha256: hostBinding.schemaSha256,
  buildId: sha("c"),
  verifiedAt: NOW,
};

function taskSourceEvidence() {
  const binding = {
    executablePath: hostBinding.executablePath,
    executableSha256: hostBinding.executableSha256,
    baseSchemaSha256: hostBinding.schemaSha256,
  };
  return CodexTaskSourceSchema.parse({
    handoff: {
      ...binding,
      status: "supported",
      contract: {
        version: hostBinding.version,
        protocol: "codex-app-server/v2",
        schemaSha256: sha("d"),
        projectBoundCreateStatus: true,
      },
    },
    followup: {
      ...binding,
      status: "unavailable",
      code: "CODEX_HOST_FOLLOWUP_UNAVAILABLE",
    },
  });
}

// A Codex host carrying a Task source bound to `sourceGeneration`; the source
// is stale whenever that differs from the host generation.
function withTaskSource(
  settings: ProductSettings,
  hostGeneration: number,
  sourceGeneration: number,
): ProductSettings {
  return ProductSettingsSchema.parse({
    ...settings,
    nativeHosts: {
      ...settings.nativeHosts,
      generation: hostGeneration,
      codex: {
        executablePath: hostBinding.executablePath,
        executableSha256: hostBinding.executableSha256,
        version: hostBinding.version,
        protocol: "codex-app-server/v2",
        schemaSha256: hostBinding.schemaSha256,
        verifiedAt: NOW,
        localVerification: hostLocal,
        taskSource: {
          hostGeneration: sourceGeneration,
          localVerification: hostLocal,
          evidence: taskSourceEvidence(),
        },
      },
    },
  });
}

describe("legacy verification withdrawal", () => {
  it("is not pending for default settings", () => {
    expect(legacyVerificationWithdrawalPending(base())).toBe(false);
  });

  it("is not pending when the verified folder carries its identity", () => {
    const settings = withComputerVerified([
      workspaceRecord({ rootIdentity: { device: "1", inode: "2" } }),
    ]);
    expect(legacyVerificationWithdrawalPending(settings)).toBe(false);
    expect(withLegacyVerificationWithdrawn(settings)).toBe(settings);
  });

  it("is pending for a verified folder saved without an identity", () => {
    const settings = withComputerVerified([workspaceRecord()]);
    expect(legacyVerificationWithdrawalPending(settings)).toBe(true);
    const next = withLegacyVerificationWithdrawn(settings);
    expect(next.setup.computer).toMatchObject({
      reachable: "unknown",
      verified: null,
      needsAction:
        "Verify Project again so Farol binds it to the folder you approved.",
    });
    expect(next.computer).toBe(settings.computer);
    expect(next.revision).toBe(settings.revision);
    expect(legacyVerificationWithdrawalPending(next)).toBe(false);
  });

  it("is pending for a verification naming a folder that is gone", () => {
    const settings = withComputerVerified([], other);
    expect(legacyVerificationWithdrawalPending(settings)).toBe(true);
    expect(
      withLegacyVerificationWithdrawn(settings).setup.computer,
    ).toMatchObject({ verified: null, needsAction: "Verify a folder." });
  });

  it("is pending for a Task source bound to another host generation", () => {
    const settings = withTaskSource(base(), 3, 2);
    expect(legacyVerificationWithdrawalPending(settings)).toBe(true);
    const next = withLegacyVerificationWithdrawn(settings);
    expect(next.nativeHosts.codex?.taskSource).toBeNull();
    expect(next.nativeHosts.generation).toBe(3);
    expect(legacyVerificationWithdrawalPending(next)).toBe(false);
  });

  it("keeps a Task source bound to the current host generation", () => {
    const settings = withTaskSource(base(), 3, 3);
    expect(legacyVerificationWithdrawalPending(settings)).toBe(false);
    expect(withLegacyVerificationWithdrawn(settings)).toBe(settings);
  });

  it("withdraws both at once", () => {
    const stale = withTaskSource(
      withComputerVerified([workspaceRecord()]),
      3,
      2,
    );
    expect(legacyVerificationWithdrawalPending(stale)).toBe(true);
    const next = withLegacyVerificationWithdrawn(stale);
    expect(next.setup.computer.verified).toBeNull();
    expect(next.nativeHosts.codex?.taskSource).toBeNull();
  });
});

describe("task source withdrawal floor", () => {
  const stale = withTaskSource(base(), 3, 2);
  const withdrawn = withLegacyVerificationWithdrawn(stale);

  it("starts the floor at the host generation that withdrew the source", () => {
    expect(taskSourceWithdrawalFloor(stale, withdrawn, null)).toBe(3);
  });

  it("raises a lower floor", () => {
    expect(taskSourceWithdrawalFloor(stale, withdrawn, 1)).toBe(3);
  });

  it("never lowers a floor already held", () => {
    expect(taskSourceWithdrawalFloor(stale, withdrawn, 7)).toBe(7);
  });

  it("keeps the floor when no source was dropped", () => {
    const computer = withComputerVerified([workspaceRecord()]);
    const next = withLegacyVerificationWithdrawn(computer);
    expect(taskSourceWithdrawalFloor(computer, next, null)).toBeNull();
    expect(taskSourceWithdrawalFloor(computer, next, 4)).toBe(4);
  });

  it("keeps the floor when the source survived", () => {
    const bound = withTaskSource(base(), 3, 3);
    expect(taskSourceWithdrawalFloor(bound, bound, 2)).toBe(2);
  });
});

const attachmentRecord = (
  overrides: Partial<SecureMcpAttachment> = {},
): SecureMcpAttachment => ({
  tunnelId: "tunnel-1",
  workspaceId: null,
  connectorGeneration: 2,
  runtimeGeneration: sha("1"),
  computerGeneration: 1,
  buildId: sha("2"),
  challengeSha256: sha("4"),
  receiptSha256: sha("5"),
  verifiedAt: NOW,
  ...overrides,
});

const clientFields = {
  executablePath: "/fixture/bin/tunnel-client",
  executableSha256: sha("a"),
  version: "1.2.3",
  protocol: "openai-tunnel-client/v1",
  verifiedAt: NOW,
} as const;

const verifiedRecord = (overrides: Record<string, unknown> = {}) => ({
  profile: "farol",
  configRevision: 2,
  workspaceId: null,
  runtimeGeneration: sha("1"),
  buildId: sha("2"),
  protocol: "openai-tunnel-client/v1",
  verifiedAt: NOW,
  ...overrides,
});

// An older Dev profile that kept only the live attachment, with a matching
// ready runtime and a completed connect check, and no approved folder.
function liveAttachmentOnly(
  connector: Partial<Connector> = {},
  connect: Partial<Connect> = {},
  workspaces: Workspace[] = [],
): ProductSettings {
  return withConnector(
    base(),
    {
      generation: 2,
      tunnelId: "tunnel-1",
      tunnelClient: clientFields,
      credential: "stored",
      runtime: runtimeRecord(),
      attachment: attachmentRecord(),
      lastVerifiedAttachment: null,
      ...connector,
    },
    { verified: verifiedRecord(), ...connect },
    { workspaces },
  );
}

describe("last verified attachment capture", () => {
  it("captures a matching live attachment for a profile with no folder", () => {
    const settings = liveAttachmentOnly();
    expect(lastVerifiedAttachmentCapturable(settings)).toEqual(
      attachmentRecord(),
    );
  });

  it("captures an attachment bound to an approved folder", () => {
    const settings = liveAttachmentOnly(
      { attachment: attachmentRecord({ workspaceId: uuid }) },
      { verified: verifiedRecord({ workspaceId: uuid }) },
      [workspaceRecord()],
    );
    expect(lastVerifiedAttachmentCapturable(settings)?.workspaceId).toBe(uuid);
  });

  it.each<[string, ProductSettings]>([
    [
      "a proof already saved",
      liveAttachmentOnly({ lastVerifiedAttachment: attachmentRecord() }),
    ],
    ["no live attachment", liveAttachmentOnly({ attachment: null })],
    ["no runtime", liveAttachmentOnly({ runtime: null })],
    [
      "a runtime that is not ready",
      liveAttachmentOnly({ runtime: runtimeRecord({ state: "unreachable" }) }),
    ],
    ["another tunnel", liveAttachmentOnly({ tunnelId: "tunnel-2" })],
    ["another connector generation", liveAttachmentOnly({ generation: 3 })],
    [
      "another runtime generation",
      liveAttachmentOnly({
        runtime: runtimeRecord({ runtimeGeneration: sha("9") }),
      }),
    ],
    [
      "another runtime build",
      liveAttachmentOnly({ runtime: runtimeRecord({ buildId: sha("9") }) }),
    ],
    [
      "a runtime of another Computer generation",
      liveAttachmentOnly({ runtime: runtimeRecord({ computerGeneration: 2 }) }),
    ],
    [
      "an attachment of another Computer generation",
      liveAttachmentOnly({
        attachment: attachmentRecord({ computerGeneration: 2 }),
      }),
    ],
    ["no completed connect check", liveAttachmentOnly({}, { verified: null })],
    [
      "a check of another config revision",
      liveAttachmentOnly(
        {},
        { verified: verifiedRecord({ configRevision: 1 }) },
      ),
    ],
    [
      "a check of another folder",
      liveAttachmentOnly(
        {},
        { verified: verifiedRecord({ workspaceId: uuid }) },
      ),
    ],
    [
      "a check of another runtime",
      liveAttachmentOnly(
        {},
        { verified: verifiedRecord({ runtimeGeneration: sha("9") }) },
      ),
    ],
    [
      "a check of another build",
      liveAttachmentOnly(
        {},
        { verified: verifiedRecord({ buildId: sha("9") }) },
      ),
    ],
    [
      "a folderless attachment while a folder is approved",
      liveAttachmentOnly({}, {}, [workspaceRecord()]),
    ],
    [
      "an attachment naming a folder that is not approved",
      liveAttachmentOnly(
        { attachment: attachmentRecord({ workspaceId: uuid }) },
        { verified: verifiedRecord({ workspaceId: uuid }) },
        [workspaceRecord({ workspaceId: other })],
      ),
    ],
  ])("captures nothing for %s", (_, settings) => {
    expect(lastVerifiedAttachmentCapturable(settings)).toBeNull();
  });

  it("records the captured proof without touching the live attachment", () => {
    const before = liveAttachmentOnly();
    const attachment = lastVerifiedAttachmentCapturable(before);
    expect(attachment).not.toBeNull();
    const next = withLastVerifiedAttachment(
      before,
      attachment as SecureMcpAttachment,
    );
    expect(next.revision).toBe(before.revision + 1);
    expect(next.connectors.secureMcp.lastVerifiedAttachment).toEqual(
      attachmentRecord(),
    );
    expect(next.connectors.secureMcp.attachment).toBe(
      before.connectors.secureMcp.attachment,
    );
    expect(next.setup).toBe(before.setup);
    ProductSettingsSchema.parse(next);
    expect(lastVerifiedAttachmentCapturable(next)).toBeNull();
  });
});
