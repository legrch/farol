import { describe, expect, it } from "vitest";
import {
  ProductConfigurationEvidenceSchema,
  ProductConfigurationSnapshotSchema,
  ProductSettingsSchema,
} from "../../src/pkg/product-settings/contract";
import { onboardingFacts } from "../../src/ui/guided-onboarding";

// Synthetic persisted documents only. No settings store, provider, socket,
// native host or operation is opened; retained proof is not live authority.
const workspaceId = "00000000-0000-4000-8000-000000000001";
const buildId = "a".repeat(64);
const attachment = {
  tunnelId: "synthetic",
  workspaceId,
  connectorGeneration: 7,
  runtimeGeneration: "b".repeat(64),
  computerGeneration: 8,
  buildId,
  challengeSha256: "c".repeat(64),
  receiptSha256: "d".repeat(64),
  verifiedAt: "2026-10-11T12:00:00.000Z",
};
const blank = {
  visited: false,
  skipped: false,
  configured: false,
  reachable: "unknown",
  verified: null,
  needsAction: null,
  unavailable: null,
  outcomeUnknown: false,
};
function document() {
  const settings = ProductSettingsSchema.parse({
    schema: 1,
    revision: 27,
    general: {
      openAtLaunch: "home",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    tasks: { retained: "synthetic-policy" },
    computer: {
      computerId: workspaceId,
      generation: 8,
      name: "Synthetic Mac",
      workspaces: [],
    },
    setup: {
      chatgpt: blank,
      computer: blank,
      connect: blank,
      hosts: blank,
      verify: blank,
    },
  });
  return {
    ...settings,
    connectors: {
      secureMcp: {
        ...settings.connectors.secureMcp,
        generation: 7,
        tunnelId: "synthetic",
        credential: "stored" as const,
        runtime: {
          state: "ready" as const,
          connectorGeneration: 7,
          runtimeGeneration: attachment.runtimeGeneration,
          computerGeneration: 8,
          buildId,
          observedAt: attachment.verifiedAt,
        },
        challenge: {
          value: "00000000-0000-4000-8000-000000000002",
          challengeSha256: attachment.challengeSha256,
          runtimeGeneration: attachment.runtimeGeneration,
          computerGeneration: 8,
          buildId,
          preparedAt: attachment.verifiedAt,
        },
        attachment: { ...attachment },
        lastVerifiedAttachment: { ...attachment },
      },
    },
  };
}

describe("persisted attachment reader bridge", () => {
  it.each([workspaceId, null])(
    "roundtrips current/future proof without replacement or stripping (%s)",
    (id) => {
      const saved = document();
      const raw = {
        ...saved,
        connectors: {
          secureMcp: {
            ...saved.connectors.secureMcp,
            attachment: { ...attachment, workspaceId: id },
            lastVerifiedAttachment: { ...attachment, workspaceId: id },
          },
        },
      };
      const serialized = JSON.stringify(raw);
      const parsed = ProductSettingsSchema.parse(JSON.parse(serialized));
      expect(JSON.stringify(parsed)).toBe(serialized);
      expect(
        ProductConfigurationSnapshotSchema.parse({
          status: "ready",
          settings: raw,
        }),
      ).toEqual({ status: "ready", settings: raw });
      expect(parsed.connectors.secureMcp.attachment).toEqual(
        raw.connectors.secureMcp.attachment,
      );
      expect(parsed.connectors.secureMcp.lastVerifiedAttachment).toEqual(
        raw.connectors.secureMcp.lastVerifiedAttachment,
      );
      if (id === null)
        expect(onboardingFacts(parsed, buildId).attachmentCurrent).toBe(false);
    },
  );

  it("keeps producer evidence workspace-bound", () => {
    const evidence = {
      kind: "connector.attachment",
      runtimeGeneration: attachment.runtimeGeneration,
      computerGeneration: 8,
      workspaceId,
      challengeSha256: attachment.challengeSha256,
      receiptSha256: attachment.receiptSha256,
    };
    expect(ProductConfigurationEvidenceSchema.safeParse(evidence).success).toBe(
      true,
    );
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        ...evidence,
        workspaceId: null,
      }).success,
    ).toBe(false);
  });

  it.each(["attachment", "lastVerifiedAttachment"] as const)(
    "rejects malformed retained %s",
    (field) => {
      for (const value of ["", 7, undefined]) {
        const saved = document();
        const raw = {
          ...saved,
          connectors: {
            secureMcp: {
              ...saved.connectors.secureMcp,
              [field]: { ...attachment, workspaceId: value },
            },
          },
        };
        expect(
          ProductSettingsSchema.safeParse(JSON.parse(JSON.stringify(raw)))
            .success,
        ).toBe(false);
      }
      for (const patch of [
        { receiptSha256: "bad" },
        { connectorGeneration: 0 },
        { unknown: true },
      ]) {
        const saved = document();
        expect(
          ProductSettingsSchema.safeParse({
            ...saved,
            connectors: {
              secureMcp: {
                ...saved.connectors.secureMcp,
                [field]: { ...attachment, workspaceId: null, ...patch },
              },
            },
          }).success,
        ).toBe(false);
      }
    },
  );
});
