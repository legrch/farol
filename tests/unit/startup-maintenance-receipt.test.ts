import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "../../apps/desktop/bridge/client";
import {
  beginStartupMaintenanceAttempt,
  type MaintenanceReceiptNotice,
} from "../../apps/desktop/recovery/receipt";
import { observeMaintenance } from "../../apps/desktop/recovery/diagnostics";
import type { MaintenanceObservation } from "../../apps/desktop/recovery/diagnostics";

// Real private files and durable readback, synthetic lifecycle facts only.
// Retain fixtures, including incomplete receipts. No owner profile, native Go,
// child terminal, effect recovery or new admission is established by these tests.
afterEach(() => vi.restoreAllMocks());
const runBytes = "synthetic previous unconfirmed run\n";
const configBytes = JSON.stringify({
  privateFixtureValue: "fixture-private-do-not-log",
});
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const selection = {
  buildId: "a".repeat(64),
  failedRunSha256: digest(runBytes),
  configSha256: digest(configBytes),
  operationId: "e9f22b1d-53b5-4cc5-83d2-4ccda40388be",
  hostLifetimeId: "fixture-host",
  childLaunchId: "fixture-child",
  backendGeneration: "fixture-backend",
};
const event = (
  stage: MaintenanceObservation["stage"],
  result: MaintenanceObservation["result"],
  code: string | null = null,
): MaintenanceObservation => ({
  stage,
  event: result === "pending" ? "begin" : "end",
  result,
  code,
  monotonicMs: 10,
  elapsedMs: 1,
});
async function fixture() {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-maintenance-receipt-")),
  );
  const stateRoot = path.join(base, "Farol Dev", "farol-state");
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const running = path.join(stateRoot, "running.json"),
    config = path.join(stateRoot, "config.json");
  await fs.writeFile(running, runBytes, {
    mode: 0o600,
  });
  await fs.writeFile(config, configBytes, { mode: 0o600 });
  const originalRun = await fs.stat(running),
    originalConfig = await fs.readFile(config);
  const notices: MaintenanceReceiptNotice[] = [];
  const input = {
    stateRoot,
    buildId: "a".repeat(64),
    report: (n: MaintenanceReceiptNotice) => notices.push(n),
  };
  const read = async () => {
    const root = path.join(stateRoot, "startup-maintenance-receipts");
    const name = (await fs.readdir(root)).find((n) =>
      /^[a-f0-9-]{36}\.json$/u.test(n),
    )!;
    return {
      file: path.join(root, name),
      value: JSON.parse(await fs.readFile(path.join(root, name), "utf8")),
    };
  };
  console.info("Retained receipt fixture:", base);
  return {
    base,
    stateRoot,
    running,
    config,
    originalRun,
    originalConfig,
    input,
    notices,
    read,
  };
}

describe("durable startup maintenance attempt", () => {
  it("pins its initial root/build/report instead of rereading caller-owned inputs", async () => {
    const f = await fixture(),
      attempt = await beginStartupMaintenanceAttempt(f.input);
    f.input.stateRoot = path.join(f.base, "different-root");
    f.input.buildId = "private-invalid-binding /Users/secret";
    f.input.report = () => {
      throw Error("changed sink");
    };
    await attempt.selected(selection);
    const receipt = (await f.read()).value;
    expect(receipt.buildId).toBe(selection.buildId);
    expect(JSON.stringify(receipt)).not.toContain("/Users/secret");
    expect(f.notices.at(-1)).toMatchObject({ confirmed: true });
  });
  it("validates and stores the same single snapshot of selected correlation fields", async () => {
    const f = await fixture(),
      attempt = await beginStartupMaintenanceAttempt(f.input);
    const getter = vi
      .fn()
      .mockReturnValueOnce(selection.hostLifetimeId)
      .mockReturnValue("/Users/secret");
    const mutable = { ...selection };
    Object.defineProperty(mutable, "hostLifetimeId", { get: getter });
    await attempt.selected(mutable);
    expect(getter).toHaveBeenCalledOnce();
    expect((await f.read()).value.selection.hostLifetimeId).toBe(
      selection.hostLifetimeId,
    );
    expect(JSON.stringify((await f.read()).value)).not.toContain(
      "/Users/secret",
    );
  });

  it("refuses a selected binding from another run, configuration or build", async () => {
    for (const field of [
      "buildId",
      "failedRunSha256",
      "configSha256",
    ] as const) {
      const f = await fixture(),
        attempt = await beginStartupMaintenanceAttempt(f.input);
      await expect(
        attempt.selected({ ...selection, [field]: "e".repeat(64) }),
      ).rejects.toThrow("STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED");
      expect((await f.read()).value).toMatchObject({
        outcome: "UNKNOWN",
        operationId: null,
      });
    }
  });
  it("withholds preparation after the original selected configuration changes", async () => {
    const f = await fixture(),
      attempt = await beginStartupMaintenanceAttempt(f.input);
    await attempt.selected(selection);
    await fs.writeFile(f.config, "changed fixture configuration");
    await expect(attempt.beforePreparation()).rejects.toThrow(
      "STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED",
    );
    expect((await f.read()).value).toMatchObject({
      phase: "observing",
      outcome: "UNKNOWN",
      preparationMayHaveStarted: false,
    });
    expect(await fs.readFile(f.config, "utf8")).toBe(
      "changed fixture configuration",
    );
  });

  it("uses the original error snapshot and cannot upgrade a changing getter to safe", async () => {
    const f = await fixture(),
      attempt = await beginStartupMaintenanceAttempt(f.input);
    await attempt.selected(selection);
    const error = new BridgeError("refused", "core_resources_unqualified");
    const getter = vi
      .fn()
      .mockReturnValueOnce("core_resources_unqualified")
      .mockReturnValue("core_resources_deadline_expired");
    Object.defineProperty(error, "code", { get: getter });
    await expect(
      observeMaintenance("resources", attempt.observe, () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await attempt.failed(error);
    expect(getter).toHaveBeenCalledOnce();
    expect((await f.read()).value).toMatchObject({
      outcome: "UNSAFE",
      code: "core_resources_unqualified",
    });
  });
  it.each([
    "STARTUP_RECOVERY_HOST_UNCONFIRMED",
    "CLOSED_COMPUTER_RECOVERY_PROCESS_UNVERIFIED",
  ])("keeps missing proof %s UNKNOWN", async (code) => {
    const f = await fixture(),
      attempt = await beginStartupMaintenanceAttempt(f.input);
    await attempt.failed(Error(code));
    expect((await f.read()).value.outcome).toBe("UNKNOWN");
  });

  it("retains UNKNOWN before dispatch and the exact selection before a child can launch", async () => {
    const f = await fixture();
    const attempt = await beginStartupMaintenanceAttempt(f.input);
    let r = await f.read();
    expect(r.value).toMatchObject({
      schema: "farol.startup-maintenance-attempt/1",
      phase: "observing",
      outcome: "UNKNOWN",
      preparationMayHaveStarted: false,
      operationId: null,
      result: null,
    });
    expect((await fs.stat(r.file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(r.file))).mode & 0o777).toBe(0o700);
    await attempt.selected(selection);
    r = await f.read();
    expect(r.value.selection).toEqual(selection);
    expect(r.value.operationId).toBe(selection.operationId);
    expect(r.value.failedRunSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(r.value.stateRootIdentity.inode).toBe(
      String((await fs.stat(f.stateRoot)).ino),
    );
    // An abandoned observer is not a success or evidence of predecessor drain.
    expect(r.value.outcome).toBe("UNKNOWN");
    expect(await fs.readFile(f.config)).toEqual(f.originalConfig);
    const after = await fs.stat(f.running);
    expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([
      f.originalRun.ino,
      f.originalRun.mtimeMs,
      f.originalRun.ctimeMs,
    ]);
    expect(JSON.stringify(r.value)).not.toContain(f.base);
    expect(JSON.stringify(r.value)).not.toContain("fixture-private-do-not-log");
  });

  it("records a known pre-child resource deadline as nondispatch, without granting admission", async () => {
    const f = await fixture(),
      attempt = await beginStartupMaintenanceAttempt(f.input);
    await attempt.selected(selection);
    attempt.observe(
      event("resources", "refused", "core_resources_deadline_expired"),
    );
    await attempt.failed(
      new BridgeError("refused", "core_resources_deadline_expired"),
    );
    expect((await f.read()).value).toMatchObject({
      phase: "failed",
      outcome: "SAFE_TO_APPLY",
      preparationMayHaveStarted: false,
      assessmentScope: "prior-attempt-reapplication",
    });
    expect(await fs.readFile(f.running, "utf8")).toBe(
      "synthetic previous unconfirmed run\n",
    );
  });

  it("keeps a discovery cleanup uncertainty UNKNOWN with its original correlation", async () => {
    const f = await fixture(),
      attempt = await beginStartupMaintenanceAttempt(f.input);
    await attempt.selected(selection);
    attempt.observe(event("discovery", "pending"));
    attempt.observe(
      event("discovery", "unknown", "preserved_inspection_cleanup_unconfirmed"),
    );
    await attempt.failed(
      new BridgeError("unknown", "preserved_inspection_cleanup_unconfirmed"),
    );
    expect((await f.read()).value).toMatchObject({
      outcome: "UNKNOWN",
      operationId: selection.operationId,
      code: "preserved_inspection_cleanup_unconfirmed",
    });
  });

  it("does not label a deadline safe after discovery or after preparation began", async () => {
    for (const stage of ["discovery", "preparation"] as const) {
      const f = await fixture(),
        attempt = await beginStartupMaintenanceAttempt(f.input);
      await attempt.selected(selection);
      if (stage === "discovery") attempt.observe(event("discovery", "pending"));
      else await attempt.beforePreparation();
      attempt.observe(
        event("resources", "refused", "core_resources_deadline_expired"),
      );
      await attempt.failed(
        new BridgeError("refused", "core_resources_deadline_expired"),
      );
      expect((await f.read()).value.outcome).toBe("UNKNOWN");
    }
  });

  it("persists UNKNOWN before entering preparation and keeps it across an abandoned attempt", async () => {
    const f = await fixture(),
      attempt = await beginStartupMaintenanceAttempt(f.input);
    await attempt.selected(selection);
    await attempt.beforePreparation();
    expect((await f.read()).value).toMatchObject({
      phase: "preparing",
      outcome: "UNKNOWN",
      preparationMayHaveStarted: true,
      operationId: selection.operationId,
    });
    // Deliberately no completed/failed callback: simulate original host loss.
  });

  it("records successful maintenance as unsafe to apply twice, without fabricating old terminal facts", async () => {
    const f = await fixture(),
      attempt = await beginStartupMaintenanceAttempt(f.input);
    await attempt.selected(selection);
    await attempt.beforePreparation();
    // The existing effect owner may move the original marker before returning.
    await fs.rename(f.running, path.join(f.stateRoot, "fixture-retained-run"));
    await attempt.completed({
      phase: "prepared_for_cold_start",
      operationId: selection.operationId,
    });
    const receipt = (await f.read()).value;
    expect(receipt).toMatchObject({
      phase: "completed",
      outcome: "UNSAFE",
      result: "prepared_for_cold_start",
      preparationMayHaveStarted: true,
    });
    expect(receipt).not.toHaveProperty("drained");
    expect(receipt).not.toHaveProperty("originalChildTerminal");
    const bytes = JSON.stringify(receipt);
    await attempt.failed(Error("later unrelated outer failure"));
    expect(JSON.stringify((await f.read()).value)).toBe(bytes);
  });

  it("keeps a known precondition refusal UNSAFE", async () => {
    const f = await fixture(),
      attempt = await beginStartupMaintenanceAttempt(f.input);
    attempt.observe(
      event("selection", "unknown", "STARTUP_PRESERVED_SELECTION_CHANGED"),
    );
    await attempt.failed(Error("STARTUP_PRESERVED_SELECTION_CHANGED"));
    expect((await f.read()).value).toMatchObject({
      outcome: "UNSAFE",
      preparationMayHaveStarted: false,
    });
  });

  it("withholds preparation if its write-ahead receipt cannot be confirmed", async () => {
    const f = await fixture(),
      attempt = await beginStartupMaintenanceAttempt(f.input);
    await attempt.selected(selection);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(
      Error("private file failure /Users/secret"),
    );
    await expect(attempt.beforePreparation()).rejects.toThrow(
      "STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED",
    );
    expect((await f.read()).value).toMatchObject({
      outcome: "UNKNOWN",
      phase: "observing",
    });
    await attempt.failed(Error("STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED"));
    expect((await f.read()).value.outcome).toBe("UNKNOWN");
    expect(JSON.stringify(f.notices)).not.toContain("/Users/secret");
  });

  it("does not replace a real returned outcome with final-receipt IO failure", async () => {
    const f = await fixture(),
      attempt = await beginStartupMaintenanceAttempt(f.input);
    await attempt.selected(selection);
    await attempt.beforePreparation();
    vi.spyOn(fs, "rename").mockRejectedValueOnce(
      Error("private final IO failure"),
    );
    await expect(
      attempt.completed({
        phase: "prepared_for_cold_start",
        operationId: selection.operationId,
      }),
    ).resolves.toBeUndefined();
    expect((await f.read()).value).toMatchObject({
      outcome: "UNKNOWN",
      phase: "preparing",
    });
    expect(f.notices.at(-1)).toMatchObject({ confirmed: false });
  });

  it("retains an unconfirmed notice when final rename occurred but acknowledgement was lost", async () => {
    const f = await fixture(),
      attempt = await beginStartupMaintenanceAttempt(f.input);
    await attempt.selected(selection);
    await attempt.beforePreparation();
    const original = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw Error("lost final storage acknowledgement");
    });
    await expect(
      attempt.completed({
        phase: "prepared_for_cold_start",
        operationId: selection.operationId,
      }),
    ).resolves.toBeUndefined();
    expect((await f.read()).value).toMatchObject({
      phase: "completed",
      outcome: "UNSAFE",
    });
    expect(f.notices.at(-1)).toMatchObject({
      confirmed: false,
      outcome: "UNKNOWN",
    });
  });
  it("refuses a replaced receipt rather than following a symlink or overwriting another file", async () => {
    const f = await fixture(),
      attempt = await beginStartupMaintenanceAttempt(f.input);
    await attempt.selected(selection);
    const { file } = await f.read(),
      outside = path.join(f.base, "outside.json");
    await fs.writeFile(outside, "keep outside", { mode: 0o600 });
    await fs.rename(file, file + ".retained");
    await fs.symlink(outside, file);
    await expect(attempt.beforePreparation()).rejects.toThrow(
      "STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED",
    );
    expect(await fs.readFile(outside, "utf8")).toBe("keep outside");
  });

  it("does not enter maintenance when the initial private journal cannot be established", async () => {
    const f = await fixture(),
      outside = path.join(f.base, "outside");
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.symlink(
      outside,
      path.join(f.stateRoot, "startup-maintenance-receipts"),
    );
    await expect(beginStartupMaintenanceAttempt(f.input)).rejects.toThrow(
      "STARTUP_MAINTENANCE_RECEIPT_UNAVAILABLE",
    );
    expect(await fs.readdir(outside)).toEqual([]);
    expect(f.notices.at(-1)).toMatchObject({
      outcome: "UNKNOWN",
      confirmed: false,
    });
  });

  it("keeps arbitrary exception text and failing output sinks out of the journal", async () => {
    const f = await fixture();
    const attempt = await beginStartupMaintenanceAttempt({
      ...f.input,
      report: () => {
        throw Error("sink-private");
      },
    });
    await attempt.failed(Error("private-data /Users/secret/token"));
    expect((await f.read()).value).toMatchObject({
      outcome: "UNKNOWN",
      code: "UNCLASSIFIED_MAINTENANCE_FAILURE",
    });
    expect(JSON.stringify((await f.read()).value)).not.toContain(
      "/Users/secret",
    );
  });
});
