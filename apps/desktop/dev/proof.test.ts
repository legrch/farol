import { describe, expect, it } from "vitest";
import {
  devProofHarness,
  devProofPreparation,
  devProofReceipt,
  proofAnswerSha256,
  proofSentinel,
} from "../../../tests/support/dev-proof-ports";
import { createDevProof } from "./proof";

// These scripted ports cover refusal order, call order and result handling
// only. Every owner is scripted; none of this qualifies a ChatGPT page, a live
// connector, a native workspace helper or an installation.
function proof(options?: Parameters<typeof devProofHarness>[0]) {
  const harness = devProofHarness(options);
  return { ...harness, devProof: createDevProof(harness.ports) };
}

const failure = (error: string) => ({ ok: false, error });
// A refusal from the configuration owner carries its snapshot, and the result
// schema is strict about it.
const mutationFailure = (f: ReturnType<typeof proof>, error: string) => ({
  ok: false,
  error,
  snapshot: { status: "ready", settings: f.state.settings },
});

describe("dev proof prepare", () => {
  it("refuses outside a dev build and dev profile before reading any owner", async () => {
    const outside = proof({ buildEnvironment: "preview" });
    expect(await outside.devProof.prepare()).toEqual(
      failure("DEV_MCP_PROOF_DEV_ONLY"),
    );
    expect(outside.events).toEqual([]);

    const preview = proof({ runtimeEnvironment: "owner-preview" });
    expect(await preview.devProof.prepare()).toEqual(
      failure("DEV_MCP_PROOF_DEV_ONLY"),
    );
    expect(preview.events).toEqual([]);
  });

  it("refuses without the configuration owner before re-reading admission", async () => {
    const f = proof();
    f.state.configurationPresent = false;
    expect(await f.devProof.prepare()).toEqual(failure("SETTINGS_UNAVAILABLE"));
    expect(f.events).toEqual([]);
  });

  it("refuses while an Agent task holds the authority, before touching state", async () => {
    const f = proof();
    f.state.agentActive = true;
    expect(await f.devProof.prepare()).toEqual(
      failure("CODEX_HOST_TASK_IN_PROGRESS"),
    );
    expect(f.events).toEqual([
      "agentActive",
      "occupied:connector-task",
      "connectorIsRunning",
      "configurationAdmission:dev-proof.prepare",
    ]);
  });

  it("refuses while the connector runs, and stops reading once it is occupied", async () => {
    const running = proof();
    expect(await running.devProof.prepare()).toEqual(
      failure("DEV_MCP_PROOF_CONNECTOR_MUST_STOP"),
    );
    expect(running.events).not.toContain("readPreparation");

    const occupied = proof();
    occupied.admission.acquire("connector-task");
    expect(await occupied.devProof.prepare()).toEqual(
      failure("DEV_MCP_PROOF_CONNECTOR_MUST_STOP"),
    );
    // The occupied connector task short-circuits the runtime read.
    expect(occupied.events).not.toContain("connectorIsRunning");
    expect(occupied.events).not.toContain("readPreparation");
  });

  it("prepares a fresh fixture in order and records the preparation last", async () => {
    const f = proof();
    f.state.connectorRunning = false;
    const result = await f.devProof.prepare();
    expect(result).toMatchObject({
      ok: true,
      evidence: {
        kind: "dev-proof.prepared",
        proofId: "11111111-1111-4111-8111-111111111111",
        allowedPath: "sentinel.txt",
        deniedPath: "outside-link.txt",
        computerGeneration: 1,
      },
    });
    expect(f.events).toEqual([
      "agentActive",
      "occupied:connector-task",
      "connectorIsRunning",
      "configurationAdmission:dev-proof.prepare",
      "readPreparation",
      "snapshot",
      "createFixture",
      "measuredRootIdentity:/tmp/farol-onboarding-fixture",
      "addReadonlyWorkspace:/tmp/farol-onboarding-fixture",
      "snapshot",
      "workspace.list",
      "recordComputerVerification:00000000-0000-4000-8000-000000000001",
      "snapshot",
      "writePreparation",
    ]);
    expect(f.state.preparation).toMatchObject({
      schema: 1,
      environment: "dev",
      proofId: "11111111-1111-4111-8111-111111111111",
      workspaceRoot: "/tmp/farol-onboarding-fixture",
    });
    expect(f.configuration.addReadonlyWorkspace).toHaveBeenCalledWith({
      root: "/tmp/farol-onboarding-fixture",
      label: "Farol Dev verification fixture",
      rootIdentity: { device: "1", inode: "2" },
    });
    expect(f.configuration.recordComputerVerification).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        runtimeGeneration: `runtime-1:${"a".repeat(64)}`,
        protocol: "readonly-workspace/1",
      }),
      { rootIdentity: { device: "1", inode: "2" }, gitMetadata: null },
    );
  });

  it("falls back to the offline runtime label when no runtime is live", async () => {
    const f = proof();
    f.state.connectorRunning = false;
    f.state.runtime = null;
    await f.devProof.prepare();
    expect(f.configuration.recordComputerVerification).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        runtimeGeneration: `runtime-offline:${"a".repeat(64)}`,
      }),
      expect.anything(),
    );
  });

  it("removes the previous proof workspace before creating a new fixture", async () => {
    const f = proof();
    f.state.connectorRunning = false;
    f.state.preparation = devProofPreparation();
    await f.devProof.prepare();
    const removal = f.events.indexOf(
      "removeWorkspace:00000000-0000-4000-8000-000000000001",
    );
    expect(removal).toBeGreaterThan(f.events.indexOf("readPreparation"));
    expect(removal).toBeLessThan(f.events.indexOf("createFixture"));
  });

  it("treats an unreadable previous preparation as none", async () => {
    const f = proof();
    f.state.connectorRunning = false;
    f.state.preparation = devProofPreparation();
    f.state.preparationError = true;
    expect(await f.devProof.prepare()).toMatchObject({ ok: true });
    expect(f.configuration.removeWorkspace).not.toHaveBeenCalled();
  });

  it("stops when the snapshot is not ready, before creating a fixture", async () => {
    const f = proof();
    f.state.connectorRunning = false;
    f.state.snapshotStatuses = ["unavailable"];
    expect(await f.devProof.prepare()).toEqual(failure("SETTINGS_UNAVAILABLE"));
    expect(f.events).not.toContain("createFixture");
  });

  it("returns the removal failure and creates nothing", async () => {
    const f = proof();
    f.state.connectorRunning = false;
    f.state.preparation = devProofPreparation();
    f.state.removeResult = mutationFailure(f, "SETTINGS_UNAVAILABLE");
    expect(await f.devProof.prepare()).toMatchObject(
      failure("SETTINGS_UNAVAILABLE"),
    );
    expect(f.events).not.toContain("createFixture");
  });

  it("stops when the snapshot is not ready after the removal", async () => {
    const f = proof();
    f.state.connectorRunning = false;
    f.state.preparation = devProofPreparation();
    f.state.snapshotStatuses = ["ready", "unavailable"];
    expect(await f.devProof.prepare()).toEqual(failure("SETTINGS_UNAVAILABLE"));
    expect(f.events).toContain(
      "removeWorkspace:00000000-0000-4000-8000-000000000001",
    );
    expect(f.events).not.toContain("createFixture");
  });

  it("refuses an unmeasurable fixture root before adding the workspace", async () => {
    const f = proof();
    f.state.connectorRunning = false;
    f.state.rootIdentity = null;
    expect(await f.devProof.prepare()).toEqual(
      failure("DEV_MCP_PROOF_PREPARE_FAILED"),
    );
    expect(f.configuration.addReadonlyWorkspace).not.toHaveBeenCalled();
  });

  it("returns the add failure before listing the workspace", async () => {
    const f = proof();
    f.state.connectorRunning = false;
    f.state.addResult = mutationFailure(f, "SETTINGS_INPUT_INVALID");
    expect(await f.devProof.prepare()).toMatchObject(
      failure("SETTINGS_INPUT_INVALID"),
    );
    expect(f.events).not.toContain("workspace.list");
  });

  it("stops when the snapshot is not ready after the add", async () => {
    const f = proof();
    f.state.connectorRunning = false;
    f.state.snapshotStatuses = ["ready", "unavailable"];
    expect(await f.devProof.prepare()).toEqual(failure("SETTINGS_UNAVAILABLE"));
    expect(f.events).not.toContain("workspace.list");
  });

  it("fails when the added workspace is not found by root", async () => {
    const f = proof();
    f.state.connectorRunning = false;
    f.state.settings = structuredClone(f.state.settings);
    f.state.settings.computer.workspaces[0]!.root = "/tmp/elsewhere";
    expect(await f.devProof.prepare()).toEqual(
      failure("DEV_MCP_PROOF_PREPARE_FAILED"),
    );
    expect(f.events).not.toContain("workspace.list");
  });

  it("fails when the fixture cannot be listed", async () => {
    for (const listResult of [
      { ok: false as const },
      { ok: true as const, value: { kind: "workspace.text" } },
    ]) {
      const f = proof();
      f.state.connectorRunning = false;
      f.state.listResult = listResult;
      expect(await f.devProof.prepare()).toEqual(
        failure("DEV_MCP_PROOF_PREPARE_FAILED"),
      );
      expect(f.configuration.recordComputerVerification).not.toHaveBeenCalled();
    }
  });

  it("returns the verification failure and writes no preparation", async () => {
    const f = proof();
    f.state.connectorRunning = false;
    f.state.recordResult = mutationFailure(f, "SETTINGS_UNAVAILABLE");
    expect(await f.devProof.prepare()).toMatchObject(
      failure("SETTINGS_UNAVAILABLE"),
    );
    expect(f.events).not.toContain("writePreparation");
  });

  it("stops when the snapshot is not ready after the verification", async () => {
    const f = proof();
    f.state.connectorRunning = false;
    f.state.snapshotStatuses = ["ready", "ready", "unavailable"];
    expect(await f.devProof.prepare()).toEqual(failure("SETTINGS_UNAVAILABLE"));
    expect(f.events).not.toContain("writePreparation");
  });

  it("classifies a thrown owner failure as a prepare failure", async () => {
    const fixture = proof();
    fixture.state.connectorRunning = false;
    fixture.state.fixtureError = true;
    expect(await fixture.devProof.prepare()).toEqual(
      failure("DEV_MCP_PROOF_PREPARE_FAILED"),
    );

    const write = proof();
    write.state.connectorRunning = false;
    write.state.writeError = true;
    expect(await write.devProof.prepare()).toEqual(
      failure("DEV_MCP_PROOF_PREPARE_FAILED"),
    );
    expect(write.state.preparation).toBeNull();
  });
});

describe("dev proof run", () => {
  function ready(options?: Parameters<typeof devProofHarness>[0]) {
    const f = proof(options);
    f.state.preparation = devProofPreparation();
    f.state.receipts = [null, devProofReceipt()];
    return f;
  }

  it("refuses outside a dev build and dev profile before reserving anything", async () => {
    const f = ready({ buildEnvironment: "owner-preview" });
    expect(await f.devProof.run()).toEqual(failure("DEV_MCP_PROOF_DEV_ONLY"));
    expect(f.events).toEqual([]);
  });

  it("refuses when any owner is missing, before reserving the lane", async () => {
    for (const missing of [
      "configurationPresent",
      "routePresent",
      "connectorPresent",
    ] as const) {
      const f = ready();
      f.state[missing] = false;
      expect(await f.devProof.run()).toEqual(failure("SETTINGS_UNAVAILABLE"));
      expect(f.events).toEqual([]);
    }
  });

  it("refuses while another ChatGPT task holds the lane and does not release it", async () => {
    const f = ready();
    const held = f.admission.acquire("chatgpt-task")!;
    expect(await f.devProof.run()).toEqual(failure("CHATGPT_TASK_IN_PROGRESS"));
    expect(f.events).toEqual(["acquire:chatgpt-task"]);
    expect(f.admission.occupied("chatgpt-task")).toBe(true);
    held.release();
  });

  it("releases the lane when the snapshot is not ready", async () => {
    const f = ready();
    f.state.snapshotStatuses = ["unavailable"];
    expect(await f.devProof.run()).toEqual(failure("SETTINGS_UNAVAILABLE"));
    expect(f.events).toEqual([
      "acquire:chatgpt-task",
      "snapshot:unavailable",
      "release:chatgpt-task",
    ]);
    expect(f.admission.occupied("chatgpt-task")).toBe(false);
  });

  it("requires a ready connector, in this check order", async () => {
    const notReady = failure("DEV_MCP_PROOF_CONNECTOR_NOT_READY");

    const runtime = ready();
    runtime.state.settings = structuredClone(runtime.state.settings);
    runtime.state.settings.connectors.secureMcp.runtime = null;
    expect(await runtime.devProof.run()).toEqual(notReady);
    // The runtime state settles it before the connector is asked.
    expect(runtime.events).not.toContain("connectorIsRunning");

    const attachment = ready();
    attachment.state.settings = structuredClone(attachment.state.settings);
    attachment.state.settings.connectors.secureMcp.attachment = null;
    expect(await attachment.devProof.run()).toEqual(notReady);
    expect(attachment.events).not.toContain("connectorIsRunning");

    const stopped = ready();
    stopped.state.connectorRunning = false;
    expect(await stopped.devProof.run()).toEqual(notReady);
    expect(stopped.events).not.toContain("taskAdmissionReady");

    const admission = ready();
    admission.state.taskAdmissionReady = false;
    expect(await admission.devProof.run()).toEqual(notReady);
    expect(admission.events).toContain("taskAdmissionReady");
    expect(admission.events).not.toContain("readPreparation");
    expect(admission.events.at(-1)).toBe("release:chatgpt-task");
  });

  it("refuses without a readable preparation", async () => {
    const missing = ready();
    missing.state.preparation = null;
    expect(await missing.devProof.run()).toEqual(
      failure("DEV_MCP_PROOF_NOT_PREPARED"),
    );
    expect(missing.events).not.toContain("readReceipt");

    const unreadable = ready();
    unreadable.state.preparationError = true;
    expect(await unreadable.devProof.run()).toEqual(
      failure("DEV_MCP_PROOF_NOT_PREPARED"),
    );
  });

  it("refuses a stale preparation before reading a receipt or claiming", async () => {
    const stale: Array<(f: ReturnType<typeof ready>) => void> = [
      (f) => {
        f.state.preparation = devProofPreparation({
          buildId: "b".repeat(64),
        });
      },
      (f) => {
        f.state.preparation = devProofPreparation({ computerGeneration: 2 });
      },
      (f) => {
        f.state.settings = structuredClone(f.state.settings);
        f.state.settings.connectors.secureMcp.runtime!.computerGeneration = 2;
      },
      (f) => {
        f.state.settings = structuredClone(f.state.settings);
        f.state.settings.connectors.secureMcp.runtime!.buildId = "b".repeat(64);
      },
      (f) => {
        f.state.preparation = devProofPreparation({
          workspaceId: "00000000-0000-4000-8000-0000000000ff",
        });
      },
      (f) => {
        f.state.preparation = devProofPreparation({
          workspaceRoot: "/tmp/elsewhere",
        });
      },
      (f) => {
        f.state.settings = structuredClone(f.state.settings);
        delete f.state.settings.computer.workspaces[0]!.rootIdentity;
      },
      (f) => {
        f.state.preparation = {
          ...devProofPreparation(),
          environment: "preview" as never,
        };
      },
    ];
    for (const stage of stale) {
      const f = ready();
      stage(f);
      expect(await f.devProof.run()).toEqual(failure("DEV_MCP_PROOF_STALE"));
      expect(f.events).not.toContain("readReceipt");
      expect(f.events).not.toContain("claimAttempt");
      expect(f.events.at(-1)).toBe("release:chatgpt-task");
    }
  });

  it("never reuses a fixture that already has a receipt", async () => {
    const f = ready();
    f.state.receipts = [devProofReceipt()];
    expect(await f.devProof.run()).toEqual(failure("DEV_MCP_PROOF_STALE"));
    expect(f.events).not.toContain("claimAttempt");
    expect(f.runReadonlyTask).not.toHaveBeenCalled();
  });

  it("treats an unreadable pre-claim receipt as none and proceeds to the claim", async () => {
    const f = ready();
    f.state.receiptError = true;
    expect(await f.devProof.run()).toEqual(
      failure("DEV_MCP_PROOF_RECEIPT_MISSING"),
    );
    expect(f.events).toContain("claimAttempt");
    expect(f.runReadonlyTask).toHaveBeenCalledTimes(1);
  });

  it("does not send when the attempt cannot be claimed", async () => {
    const f = ready();
    f.state.claimError = true;
    expect(await f.devProof.run()).toEqual(failure("DEV_MCP_PROOF_STALE"));
    expect(f.runReadonlyTask).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe("release:chatgpt-task");
  });

  it("fails when the task did not complete with text", async () => {
    for (const taskResult of [
      { state: "failed_before_submit", outputText: proofSentinel },
      { state: "completed", outputText: 7 },
      { state: "completed" },
    ]) {
      const f = ready();
      f.state.taskResult = taskResult;
      expect(await f.devProof.run()).toEqual(
        failure("DEV_MCP_PROOF_CHATGPT_FAILED"),
      );
      expect(f.events.filter((e) => e === "readReceipt")).toHaveLength(1);
    }
  });

  it("fails on an answer that does not match the sentinel digest", async () => {
    const f = ready();
    f.state.taskResult = { state: "completed", outputText: "something else" };
    expect(await f.devProof.run()).toEqual(
      failure("DEV_MCP_PROOF_ANSWER_MISMATCH"),
    );
    expect(f.events.filter((e) => e === "readReceipt")).toHaveLength(1);
  });

  it("trims the answer before hashing it", async () => {
    const f = ready();
    f.state.taskResult = {
      state: "completed",
      outputText: `  ${proofSentinel}\n`,
    };
    expect(await f.devProof.run()).toMatchObject({
      ok: true,
      evidence: { answerSha256: proofAnswerSha256 },
    });
  });

  it("fails when the receipt is missing or half written", async () => {
    const missing = [
      null,
      devProofReceipt({ allowed: null }),
      devProofReceipt({ denied: null }),
    ];
    for (const receipt of missing) {
      const f = ready();
      f.state.receipts = [null, receipt];
      expect(await f.devProof.run()).toEqual(
        failure("DEV_MCP_PROOF_RECEIPT_MISSING"),
      );
    }
    const unreadable = ready();
    unreadable.state.receipts = [null];
    expect(await unreadable.devProof.run()).toEqual(
      failure("DEV_MCP_PROOF_RECEIPT_MISSING"),
    );
  });

  it("rejects a receipt that does not bind to this preparation", async () => {
    const base = devProofReceipt();
    const allowed = base.allowed!;
    const denied = base.denied!;
    const invalid = [
      devProofReceipt({ proofId: "proof-2" }),
      devProofReceipt({ environment: "preview" }),
      devProofReceipt({ buildId: "b".repeat(64) }),
      devProofReceipt({ computerGeneration: 2 }),
      devProofReceipt({ workspaceId: "other" }),
      devProofReceipt({ sentinelSha256: "c".repeat(64) }),
      devProofReceipt({
        allowed: { ...allowed, outputSha256: "c".repeat(64) },
      }),
      devProofReceipt({ allowed: { ...allowed, generation: 2 } }),
      devProofReceipt({ allowed: { ...allowed, taskEpoch: 2 } }),
      devProofReceipt({ denied: { ...denied, generation: 2 } }),
      devProofReceipt({ denied: { ...denied, taskEpoch: 2 } }),
      devProofReceipt({ denied: { ...denied, errorCode: "WORKSPACE_DENIED" } }),
      devProofReceipt({ allowed: { ...allowed, ownerId: "someone" } }),
      devProofReceipt({
        denied: { ...denied, callIdSha256: allowed.callIdSha256 },
      }),
      // Recorded before the claim.
      devProofReceipt({
        allowed: { ...allowed, recordedAt: "2025-12-31T00:00:00.000Z" },
      }),
      // The denied call precedes the allowed one.
      devProofReceipt({
        denied: { ...denied, recordedAt: "2026-01-01T00:00:01.500Z" },
      }),
      devProofReceipt({ denied: { ...denied, sessionId: "other" } }),
      devProofReceipt({ denied: { ...denied, taskId: "other" } }),
      devProofReceipt({ denied: { ...denied, participantId: "other" } }),
      devProofReceipt({ denied: { ...denied, turnId: "other" } }),
    ];
    for (const receipt of invalid) {
      const f = ready();
      f.state.receipts = [null, receipt];
      expect(await f.devProof.run()).toEqual(
        failure("DEV_MCP_PROOF_RECEIPT_INVALID"),
      );
      expect(f.events.at(-1)).toBe("release:chatgpt-task");
    }
  });

  it("verifies in order and releases the lane twice, identity-bound", async () => {
    const f = ready();
    const result = await f.devProof.run();
    expect(result).toMatchObject({
      ok: true,
      evidence: {
        kind: "dev-proof.verified",
        proofId: "11111111-1111-4111-8111-111111111111",
        environment: "dev",
        computerGeneration: 1,
        sentinelSha256: proofAnswerSha256,
        answerSha256: proofAnswerSha256,
        outsideGrantError: "WORKSPACE_PATH_REFUSED",
      },
    });
    expect(f.events).toEqual([
      "acquire:chatgpt-task",
      "snapshot",
      "connectorIsRunning",
      "taskAdmissionReady",
      "readPreparation",
      "readReceipt",
      "claimAttempt",
      "runReadonlyTask",
      "readReceipt",
      "snapshot",
      "release:chatgpt-task",
      "release:chatgpt-task",
    ]);
    expect(f.admission.occupied("chatgpt-task")).toBe(false);
    const prompt = String(f.runReadonlyTask.mock.calls[0]![0]);
    expect(prompt).toContain("computer_workspace_read");
    expect(prompt).toContain("relativePath sentinel.txt");
    expect(prompt).toContain("relativePath outside-link.txt");
  });

  it("releases the lane when the route throws, and does not retry", async () => {
    const f = ready();
    f.runReadonlyTask.mockRejectedValueOnce(
      new Error("provider outcome unknown"),
    );
    await expect(f.devProof.run()).rejects.toThrow("provider outcome unknown");
    expect(f.runReadonlyTask).toHaveBeenCalledTimes(1);
    expect(f.events.slice(-2)).toEqual([
      "release:chatgpt-task",
      "release:chatgpt-task",
    ]);
    expect(f.admission.occupied("chatgpt-task")).toBe(false);
  });
});
