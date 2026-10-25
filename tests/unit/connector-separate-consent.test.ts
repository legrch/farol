import { describe, expect, it, vi } from "vitest";
import {
  confirmSeparateAppVerificationAttempt,
  type SeparateAppVerification,
} from "../../src/apps/desktop/connector-app-verification-attempt";

// Native confirmation is a controlled port. These tests never show a dialog,
// send a message, claim Computer authority or read an owner profile.
function attempt(): SeparateAppVerification {
  return {
    expected: {
      ownerAuthorized: true,
      appName: "Farol Dev",
      tunnelId: "fixture-tunnel",
      connectorGeneration: 1,
      computerGeneration: 1,
      runtimeGeneration: "a".repeat(64),
      challengeSha256: "b".repeat(64),
      buildId: "c".repeat(64),
      workspaceId: null,
    },
    binding: {
      buildId: "c".repeat(64),
      profileId: "profile",
      backendGeneration: "backend",
      runtimeId: "runtime",
      connectorGeneration: "1",
    },
  };
}
describe("separate test native consent", () => {
  it("never accepts ownerAuthorized from IPC without native confirmation", async () => {
    const confirm = vi.fn(async () => false);
    await expect(
      confirmSeparateAppVerificationAttempt(attempt(), {
        current: () => true,
        confirm,
      }),
    ).rejects.toThrow("CONNECTOR_APP_VERIFICATION_OWNER_CONSENT_REQUIRED");
    expect(confirm).toHaveBeenCalledTimes(1);
  });
  it("does not prompt for a stale request", async () => {
    const confirm = vi.fn(async () => true);
    await expect(
      confirmSeparateAppVerificationAttempt(attempt(), {
        current: () => false,
        confirm,
      }),
    ).rejects.toThrow("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
    expect(confirm).not.toHaveBeenCalled();
  });
  it("rejects approval after the native window or runtime scope changes", async () => {
    let current = true;
    await expect(
      confirmSeparateAppVerificationAttempt(attempt(), {
        current: () => current,
        confirm: async () => {
          current = false;
          return true;
        },
      }),
    ).rejects.toThrow("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
  });
  it("captures an immutable exact scope across the native prompt", async () => {
    const request = attempt();
    const approved = await confirmSeparateAppVerificationAttempt(request, {
      current: () => true,
      confirm: async (captured) => {
        request.expected.tunnelId = "changed-after-request";
        expect(captured.expected.tunnelId).toBe("fixture-tunnel");
        expect(Object.isFrozen(captured.expected)).toBe(true);
        expect(Object.isFrozen(captured.binding)).toBe(true);
        return true;
      },
    });
    expect(approved.expected.tunnelId).toBe("fixture-tunnel");
  });
});
