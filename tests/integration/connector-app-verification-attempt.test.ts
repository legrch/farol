import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimConnectorAppVerificationAttempt,
  connectorAppVerificationAttemptExists,
} from "../../src/apps/desktop/connector-app-verification-attempt";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("one-shot connector app verification", () => {
  it("allows one dispatch intent per challenge, durably across callers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "farol-app-verify-"));
    roots.push(root);
    const challenge = "a".repeat(64);
    expect(await connectorAppVerificationAttemptExists(root, challenge)).toBe(
      false,
    );
    await claimConnectorAppVerificationAttempt(root, challenge);
    expect(await connectorAppVerificationAttemptExists(root, challenge)).toBe(
      true,
    );
    await expect(
      claimConnectorAppVerificationAttempt(root, challenge),
    ).rejects.toThrow("CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED");
    expect(
      await connectorAppVerificationAttemptExists(root, "b".repeat(64)),
    ).toBe(false);
  });

  it("rejects unsafe challenge identities before creating an attempt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "farol-app-verify-"));
    roots.push(root);
    await expect(
      claimConnectorAppVerificationAttempt(root, "../bad"),
    ).rejects.toThrow("CONNECTOR_APP_VERIFICATION_CHALLENGE_INVALID");
  });
});
