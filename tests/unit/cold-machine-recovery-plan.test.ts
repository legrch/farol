import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { qualifyColdMachineRecoveryPlan } from "../../src/apps/desktop/cold-machine-recovery-plan";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })),
  );
});
const before = "00000000-0000-4000-8000-000000000001",
  after = "00000000-0000-4000-8000-000000000002";
const sha = (b: string) => createHash("sha256").update(b).digest("hex");
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-cold-plan-test-")),
  );
  roots.push(root);
  const stateRoot = path.join(root, "state");
  await fs.mkdir(stateRoot, { mode: 0o700 });
  const names = [
    "running.json",
    "last-quit.json",
    "config.json",
    "go-core/profile.json",
    "go-core/computer/computer-access.json",
  ];
  const hashes: Record<string, string> = {};
  for (const n of names) {
    const f = path.join(stateRoot, n);
    await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
    await fs.writeFile(f, n, { mode: 0o600 });
    hashes[n] = sha(n);
  }
  const records = [{ key: "a".repeat(64) + ".json", sha256: "b".repeat(64) }];
  const plan = {
    schema: "farol.cold-machine-recovery-proposal/1",
    operationId: "00000000-0000-4000-8000-000000000003",
    preparedAt: "2026-10-13T00:00:00.000Z",
    beforeBootSessionUUID: before,
    selectedStateSHA256: hashes,
    retainedRecords: records,
    recoveryAuthorized: false,
    restartRequested: false,
    scope: "Synthetic owner-plan fixture; no hardware transition.",
  };
  const planPath = path.join(root, "plan.json");
  const raw = JSON.stringify(plan);
  await fs.writeFile(planPath, raw, { mode: 0o600 });
  const input = {
    planPath,
    expectedPlanSHA256: sha(raw),
    stateRoot,
    expectedRunSHA256: hashes["running.json"]!,
    expectedQuitSHA256: hashes["last-quit.json"]!,
    expectedConfigSHA256: hashes["config.json"]!,
    selectedRecords: records.map((r) => ({ Key: r.key, SHA256: r.sha256 })),
    currentBootSession: async () => after,
  };
  return { input, plan, planPath, stateRoot };
}
it("qualifies only the pinned before-session and complete unchanged failure scope", async () => {
  const f = await fixture();
  const q = await qualifyColdMachineRecoveryPlan(f.input);
  expect(q.beforeBootSession).toBe(before);
  await q.recheck();
  expect(
    await fs.readFile(path.join(f.stateRoot, "running.json"), "utf8"),
  ).toBe("running.json");
});
it("refuses the same machine session even after an app restart", async () => {
  const f = await fixture();
  await expect(
    qualifyColdMachineRecoveryPlan({
      ...f.input,
      currentBootSession: async () => before,
    }),
  ).rejects.toThrow("COLD_MACHINE_RESTART_NOT_OBSERVED");
});
it.each(["hash", "scope", "inventory", "alias", "mode", "state"])(
  "refuses a crossed %s before allowing maintenance",
  async (name) => {
    const f = await fixture();
    switch (name) {
      case "hash":
        f.input.expectedPlanSHA256 = "c".repeat(64);
        break;
      case "scope":
        f.input.expectedQuitSHA256 = "c".repeat(64);
        break;
      case "inventory":
        f.input.selectedRecords = [];
        break;
      case "alias":
        await fs.rename(f.planPath, f.planPath + ".actual");
        await fs.symlink(f.planPath + ".actual", f.planPath);
        break;
      case "mode":
        await fs.chmod(f.planPath, 0o644);
        break;
      case "state":
        await fs.writeFile(path.join(f.stateRoot, "running.json"), "changed");
        break;
    }
    await expect(qualifyColdMachineRecoveryPlan(f.input)).rejects.toThrow();
  },
);
it("rechecks the same selected session and hashes rather than reauthorizing", async () => {
  const f = await fixture();
  let current = after;
  const q = await qualifyColdMachineRecoveryPlan({
    ...f.input,
    currentBootSession: async () => current,
  });
  current = before;
  await expect(q.recheck()).rejects.toThrow("COLD_MACHINE_PLAN_CHANGED");
});
it("refuses changed original state during final readback", async () => {
  const f = await fixture();
  const q = await qualifyColdMachineRecoveryPlan(f.input);
  await fs.writeFile(path.join(f.stateRoot, "config.json"), "changed");
  await expect(q.recheck()).rejects.toThrow("COLD_MACHINE_PLAN_STATE_CHANGED");
});
