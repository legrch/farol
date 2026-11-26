import { describe, expect, it } from "vitest";

import { defaultSettings } from "../../../src/apps/desktop/settings/rules";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import {
  workspaceConsentDigest,
  type ContinuityWriteFence,
  type ContinuityWriteIntent,
} from "../../../src/apps/desktop/workspace-continuity-writer";
import { continuityCommitAdmissible } from "./continuity";

const uuid = "12345678-1234-4234-8234-123456789abc";
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sha = (character: string) => character.repeat(64);

const base = (): ProductSettings => defaultSettings(() => uuid);

function intentFor(settings: ProductSettings): ContinuityWriteIntent {
  return {
    operationId,
    workspaceId,
    expectedRevision: settings.revision,
    expectedGeneration: settings.computer.generation,
    expectedConsentSha256: workspaceConsentDigest(settings),
    rootIdentity: { device: "99", inode: "42" },
    continuity: {
      schema: "farol.workspace-continuity/1",
      computerId: settings.computer.computerId,
      workspaceId,
      root: "/synthetic/approved",
      filesystem: "apfs",
      volumeUuid: "11111111-2222-3333-4444-555555555555",
      fileId: "42",
      birthSeconds: "1700000000",
      birthNanoseconds: "0",
      enrollment: {
        operationId,
        selectedAt: "2026-11-10T08:00:00.000Z",
        policySha256: sha("a"),
      },
    },
  };
}

const fence: ContinuityWriteFence = {
  current: () => true,
  withdrawalAcknowledged: () => true,
  requalifyNative: async () => true,
};

const unknownRuntime = (settings: ProductSettings): ProductSettings =>
  ProductSettingsSchema.parse({
    ...settings,
    setup: {
      ...settings.setup,
      connect: { ...settings.setup.connect, outcomeUnknown: true },
    },
  });

describe("continuityCommitAdmissible", () => {
  it("admits a well-formed intent against loaded, unfenced settings", () => {
    const settings = base();
    expect(
      continuityCommitAdmissible(intentFor(settings), settings, false, fence),
    ).toBe(true);
  });

  it("refuses an intent that does not parse", () => {
    const settings = base();
    expect(
      continuityCommitAdmissible(
        { ...intentFor(settings), extra: true },
        settings,
        false,
        fence,
      ),
    ).toBe(false);
    expect(continuityCommitAdmissible(null, settings, false, fence)).toBe(
      false,
    );
    expect(
      continuityCommitAdmissible(
        { ...intentFor(settings), expectedRevision: -1 },
        settings,
        false,
        fence,
      ),
    ).toBe(false);
  });

  it("refuses when no settings are loaded", () => {
    expect(
      continuityCommitAdmissible(intentFor(base()), null, false, fence),
    ).toBe(false);
  });

  it("refuses while delivery is fenced", () => {
    const settings = base();
    expect(
      continuityCommitAdmissible(intentFor(settings), settings, true, fence),
    ).toBe(false);
  });

  it("keeps an outcome-unknown connector refused, never admitted", () => {
    const settings = unknownRuntime(base());
    expect(
      continuityCommitAdmissible(intentFor(settings), settings, false, fence),
    ).toBe(false);
  });

  it("admits when the unknown flag belongs to a pending app check", () => {
    const settings = ProductSettingsSchema.parse({
      ...base(),
      connectors: {
        ...base().connectors,
        secureMcp: {
          ...base().connectors.secureMcp,
          appVerificationPending: true,
        },
      },
      setup: {
        ...base().setup,
        connect: { ...base().setup.connect, outcomeUnknown: true },
      },
    });
    expect(
      continuityCommitAdmissible(intentFor(settings), settings, false, fence),
    ).toBe(true);
  });

  it.each<[string, unknown]>([
    ["no fence", undefined],
    ["an empty fence", {}],
    ["no currentness", { ...fence, current: undefined }],
    [
      "no withdrawal acknowledgement",
      { ...fence, withdrawalAcknowledged: "yes" },
    ],
    ["no native requalification", { ...fence, requalifyNative: null }],
  ])("refuses %s", (_, candidate) => {
    const settings = base();
    expect(
      continuityCommitAdmissible(
        intentFor(settings),
        settings,
        false,
        candidate as ContinuityWriteFence | undefined,
      ),
    ).toBe(false);
  });

  it("never calls the fence", () => {
    const settings = base();
    const calls: string[] = [];
    const spy: ContinuityWriteFence = {
      current: () => (calls.push("current"), true),
      withdrawalAcknowledged: () => (calls.push("ack"), true),
      requalifyNative: async () => (calls.push("requalify"), true),
    };
    expect(
      continuityCommitAdmissible(intentFor(settings), settings, false, spy),
    ).toBe(true);
    expect(calls).toEqual([]);
  });
});
