import assert from "node:assert/strict";
import { it } from "vitest";
import { observeConnectionStatus } from "../../apps/desktop/bridge/connection-status.ts";

// Port-level projection tests only. A fabricated observation is not native Go,
// a validated bridge response, a tunnel connection or a current permission.
const binding = {
  buildId: "build",
  profileId: "profile",
  backendGeneration: "backend",
  runtimeId: "runtime",
  connectorGeneration: "1",
};
const execution = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: "1",
  participantId: "participant",
  turnId: "turn",
  generation: "1",
};
function state(verified = false) {
  const receipt = {
    binding,
    execution,
    challengeSha256: "a".repeat(64),
    workspaceId: "workspace",
    callIdSha256: "b".repeat(64),
    entryCount: 2,
    truncated: false,
  };
  return Object.freeze({
    binding,
    ...(verified ? { receipt, receiptSha256: "c".repeat(64) } : {}),
  });
}
it("responding without an attachment proof is not verified", async () => {
  const observed = state();
  const out = await observeConnectionStatus(
    { observe: async () => observed },
    { workspaceMutations: false, processes: false },
  );
  assert.equal(out.connection, "responding");
  assert.equal(out.attachment, "not_checked");
  assert.equal(out.verification, observed);
  assert.equal(out.newFileOrCommandTests, false);
});
it("returns the original verified observation without rebuilding its receipt", async () => {
  const observed = state(true);
  const before = JSON.stringify(observed);
  const out = await observeConnectionStatus(
    { observe: async () => observed },
    { workspaceMutations: true, processes: false },
  );
  assert.equal(out.attachment, "verified");
  assert.equal(out.verification, observed);
  assert.equal(out.verification.receipt, observed.receipt);
  assert.equal(JSON.stringify(observed), before);
  assert.equal(out.capabilities.fileMutations, "registered_not_tested");
});
it("a second health read observes again and never calls verification", async () => {
  let observations = 0,
    verifications = 0;
  const port = {
    observe: async () => {
      observations++;
      return state(true);
    },
    verify: async () => {
      verifications++;
      throw new Error("must not verify");
    },
  };
  await observeConnectionStatus(port, {
    workspaceMutations: true,
    processes: false,
  });
  await observeConnectionStatus(port, {
    workspaceMutations: true,
    processes: false,
  });
  assert.equal(observations, 2);
  assert.equal(verifications, 0);
});
for (const writes of [false, true])
  for (const processes of [false, true]) {
    it(`reports registration, never acceptance, for writes=${writes} shell=${processes}`, async () => {
      const out = await observeConnectionStatus(
        { observe: async () => state(true) },
        { workspaceMutations: writes, processes },
      );
      assert.equal(out.capabilities.fileReads, "registered_not_tested");
      assert.equal(
        out.capabilities.fileMutations,
        writes ? "registered_not_tested" : "not_registered",
      );
      assert.equal(
        out.capabilities.shell,
        processes ? "registered_not_tested" : "not_registered",
      );
      assert.equal(out.capabilities.tasks, "not_registered");
      assert.equal(out.newFileOrCommandTests, false);
    });
  }
for (const code of [
  "COMPUTER_AUTHORITY_STORE_UNAVAILABLE",
  "AUTHORITY_EXPIRED",
  "COMPUTER_MCP_STOPPING",
  "outcome_unknown",
]) {
  it(`preserves ${code} and does not retry or emit success`, async () => {
    const error = Object.assign(new Error(code), { code });
    let calls = 0;
    await assert.rejects(
      observeConnectionStatus(
        {
          observe: async () => {
            calls++;
            throw error;
          },
        },
        { workspaceMutations: true, processes: true },
      ),
      (actual: unknown) => actual === error,
    );
    assert.equal(calls, 1);
  });
}
it("captures exposure before a delayed observation", async () => {
  const exposure = { workspaceMutations: false, processes: false };
  let complete!: (s: ReturnType<typeof state>) => void;
  const pending = observeConnectionStatus(
    {
      observe: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    },
    exposure,
  );
  exposure.workspaceMutations = true;
  exposure.processes = true;
  complete(state(true));
  const out = await pending;
  assert.equal(out.capabilities.fileMutations, "not_registered");
  assert.equal(out.capabilities.shell, "not_registered");
});
it("does not cache a proof across independent status calls", async () => {
  let current = state(true);
  const port = { observe: async () => current };
  assert.equal(
    (
      await observeConnectionStatus(port, {
        workspaceMutations: false,
        processes: false,
      })
    ).attachment,
    "verified",
  );
  current = state(false);
  assert.equal(
    (
      await observeConnectionStatus(port, {
        workspaceMutations: false,
        processes: false,
      })
    ).attachment,
    "not_checked",
  );
});
it("freezes generated status and registration metadata", async () => {
  const out = await observeConnectionStatus(
    { observe: async () => state() },
    { workspaceMutations: false, processes: false },
  );
  assert.ok(Object.isFrozen(out));
  assert.ok(Object.isFrozen(out.capabilities));
});
