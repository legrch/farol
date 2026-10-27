import { describe, expect, it } from "vitest";
import { resumedConnectorCheck } from "../../src/apps/desktop/connector-resume-policy";
import { type ProductSettings } from "../../src/pkg/product-settings/contract";
import {
  fixtureBuildId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";

// Configuration policy only; no provider, browser or native-process witness.
function fixture() {
  const before = guidedSettingsFixture();
  before.connectors.secureMcp.chatgptApp = {
    name: "Farol Dev",
    tunnelId: before.connectors.secureMcp.tunnelId!,
    connectorGeneration: 1,
  };
  const after = structuredClone(before);
  const connector = after.connectors.secureMcp;
  connector.lastVerifiedAttachment = connector.attachment;
  connector.attachment = null;
  connector.runtime!.runtimeGeneration = "f".repeat(64);
  connector.challenge = {
    value: "00000000-0000-4000-8000-000000000099",
    challengeSha256: "e".repeat(64),
    runtimeGeneration: "f".repeat(64),
    computerGeneration: 1,
    buildId: fixtureBuildId,
    preparedAt: "2026-01-02T00:00:00.000Z",
  };
  const check = () =>
    resumedConnectorCheck(
      { status: "ready", settings: before },
      { status: "ready", settings: after },
      fixtureBuildId,
    );
  return { before, after, check };
}

describe("automatic attachment check after connector resume", () => {
  it("checks only the fresh challenge and preserves the completed history", () => {
    const f = fixture();
    const original = structuredClone({ before: f.before, after: f.after });
    expect(f.check()).toMatchObject({
      appName: "Farol Dev",
      runtimeGeneration: "f".repeat(64),
      challengeSha256: "e".repeat(64),
      buildId: fixtureBuildId,
    });
    expect(f.before).toEqual(original.before);
    expect(f.after).toEqual(original.after);
  });

  it.each<[string, (before: ProductSettings, after: ProductSettings) => void]>([
    [
      "first install",
      (b) => {
        b.connectors.secureMcp.attachment = null;
        b.connectors.secureMcp.lastVerifiedAttachment = null;
      },
    ],
    [
      "earlier UNKNOWN",
      (b) => {
        b.setup.connect.outcomeUnknown = true;
      },
    ],
    [
      "earlier pending Send",
      (b) => {
        b.connectors.secureMcp.appVerificationPending = true;
      },
    ],
    [
      "current UNKNOWN",
      (_, a) => {
        a.setup.connect.outcomeUnknown = true;
      },
    ],
    [
      "current pending Send",
      (_, a) => {
        a.connectors.secureMcp.appVerificationPending = true;
      },
    ],
    [
      "unknown sign-in",
      (_, a) => {
        a.setup.chatgpt.outcomeUnknown = true;
      },
    ],
    [
      "changed app",
      (_, a) => {
        a.connectors.secureMcp.chatgptApp!.name = "Other app";
      },
    ],
    [
      "changed tunnel",
      (_, a) => {
        a.connectors.secureMcp.tunnelId = "other-tunnel";
      },
    ],
    [
      "old runtime",
      (b, a) => {
        a.connectors.secureMcp.runtime!.runtimeGeneration =
          b.connectors.secureMcp.runtime!.runtimeGeneration;
      },
    ],
    [
      "old challenge",
      (b, a) => {
        a.connectors.secureMcp.challenge!.challengeSha256 =
          b.connectors.secureMcp.attachment!.challengeSha256;
      },
    ],
    [
      "already confirmed",
      (b, a) => {
        a.connectors.secureMcp.attachment = b.connectors.secureMcp.attachment;
      },
    ],
    [
      "stopped",
      (_, a) => {
        a.connectors.secureMcp.runtime = null;
      },
    ],
    [
      "stale Computer generation",
      (_, a) => {
        a.computer.generation++;
      },
    ],
    [
      "stale build",
      (_, a) => {
        a.connectors.secureMcp.runtime!.buildId = "0".repeat(64);
      },
    ],
  ])("does not send for %s", (_, mutate) => {
    const f = fixture();
    mutate(f.before, f.after);
    const before = structuredClone(f.before),
      after = structuredClone(f.after);
    expect(f.check()).toBeNull();
    expect(f.before).toEqual(before);
    expect(f.after).toEqual(after);
  });
});
