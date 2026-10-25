import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimConnectorAppVerificationAttempt,
  connectorAppVerificationAttemptExists,
  prepareConnectorAppVerificationAttempt,
  type SeparateAppVerification,
} from "../../src/apps/desktop/connector-app-verification-attempt";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("one-shot connector app verification", () => {
  function separate(challengeSha256: string): SeparateAppVerification {
    return {
      expected: {
        ownerAuthorized: true,
        appName: "Farol Dev",
        tunnelId: "synthetic-tunnel",
        connectorGeneration: 3,
        computerGeneration: 2,
        runtimeGeneration: "d".repeat(64),
        challengeSha256,
        buildId: "e".repeat(64),
        workspaceId: null,
      },
      binding: {
        buildId: "e".repeat(64),
        profileId: "profile",
        backendGeneration: "backend",
        runtimeId: "runtime",
        connectorGeneration: "3",
      },
    };
  }

  it("durably binds a separate check before pending without replacing the old UNKNOWN claim", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "farol-app-verify-"));
    roots.push(root);
    const old = "a".repeat(64),
      fresh = "b".repeat(64);
    await claimConnectorAppVerificationAttempt(root, old);
    const oldPath = path.join(root, `app-verification-${old}.json`);
    const oldBytes = await readFile(oldPath);
    const target = path.join(root, `app-verification-${fresh}.json`);
    const scope = separate(fresh);
    let pendingWrites = 0;
    await prepareConnectorAppVerificationAttempt(
      root,
      fresh,
      async () => {
        const record = JSON.parse(await readFile(target, "utf8"));
        expect(record).toMatchObject({
          schema: 2,
          expected: scope.expected,
          binding: scope.binding,
          predecessorOutcome: "unknown",
          kind: "owner-authorized-separate-check",
        });
        expect(record.attemptId).toMatch(/^[a-f0-9-]{36}$/u);
        pendingWrites++;
        return true;
      },
      scope,
    );
    expect(await readFile(oldPath)).toEqual(oldBytes);
    await expect(
      prepareConnectorAppVerificationAttempt(
        root,
        fresh,
        async () => {
          pendingWrites++;
          return true;
        },
        scope,
      ),
    ).rejects.toThrow("CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED");
    expect(pendingWrites).toBe(1);
  });

  it("cannot use separate consent to replay an already claimed challenge", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "farol-app-verify-"));
    roots.push(root);
    const digest = "c".repeat(64);
    await claimConnectorAppVerificationAttempt(root, digest);
    await expect(
      claimConnectorAppVerificationAttempt(root, digest, separate(digest)),
    ).rejects.toThrow("CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED");
    const record = JSON.parse(
      await readFile(
        path.join(root, `app-verification-${digest}.json`),
        "utf8",
      ),
    );
    expect(record.schema).toBe(1);
    expect(record.attemptId).toBeUndefined();
  });

  it.each(["build", "generation", "challenge", "consent"])(
    "refuses a mismatched separate %s before pending",
    async (changed) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "farol-app-verify-"));
      roots.push(root);
      const digest = "c".repeat(64);
      const scope = separate(digest);
      if (changed === "build")
        Object.assign(scope.binding, { buildId: "f".repeat(64) });
      if (changed === "generation")
        Object.assign(scope.binding, { connectorGeneration: "4" });
      if (changed === "challenge")
        scope.expected.challengeSha256 = "a".repeat(64);
      if (changed === "consent")
        Object.assign(scope.expected, { ownerAuthorized: false });
      let pendingWrites = 0;
      await expect(
        prepareConnectorAppVerificationAttempt(
          root,
          digest,
          async () => {
            pendingWrites++;
            return true;
          },
          scope,
        ),
      ).rejects.toThrow("CONNECTOR_SEPARATE_APP_SCOPE_INVALID");
      expect(pendingWrites).toBe(0);
      expect(await connectorAppVerificationAttemptExists(root, digest)).toBe(
        false,
      );
    },
  );

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

  it("never persists pending uncertainty when the one-shot claim fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "farol-app-verify-"));
    roots.push(root);
    const challenge = "c".repeat(64);
    await claimConnectorAppVerificationAttempt(root, challenge);
    let pendingWrites = 0;
    await expect(
      prepareConnectorAppVerificationAttempt(root, challenge, async () => {
        pendingWrites += 1;
        return true;
      }),
    ).rejects.toThrow("CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED");
    expect(pendingWrites).toBe(0);
  });
});
