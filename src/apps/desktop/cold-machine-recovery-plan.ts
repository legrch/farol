import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const BootSession = z
  .string()
  .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
const StateNames = [
  "running.json",
  "last-quit.json",
  "config.json",
  "go-core/profile.json",
  "go-core/computer/computer-access.json",
] as const;
const Plan = z.strictObject({
  schema: z.literal("farol.cold-machine-recovery-proposal/1"),
  operationId: z.string().uuid(),
  preparedAt: z.string().datetime({ offset: true }),
  beforeBootSessionUUID: BootSession,
  selectedStateSHA256: z.strictObject(
    Object.fromEntries(StateNames.map((n) => [n, Digest])),
  ),
  retainedRecords: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-f0-9]{64}\.json$/u),
        sha256: Digest,
      }),
    )
    .min(1)
    .max(128),
  recoveryAuthorized: z.literal(false),
  restartRequested: z.literal(false),
  scope: z.string().min(1).max(1024),
});
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function bytes(file: string): Promise<Buffer> {
  const f = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const a = await f.stat();
    if (
      !a.isFile() ||
      a.nlink !== 1 ||
      a.uid !== process.geteuid?.() ||
      (a.mode & 0o777) !== 0o600 ||
      a.size > 65536 ||
      (await fs.realpath(file)) !== file
    )
      throw Error("COLD_MACHINE_PLAN_FILE_UNSAFE");
    const data = Buffer.alloc(65537);
    const { bytesRead } = await f.read(data, 0, data.length, 0);
    const b = await f.stat(),
      named = await fs.lstat(file);
    if (
      bytesRead !== a.size ||
      b.size !== a.size ||
      b.mtimeMs !== a.mtimeMs ||
      b.ctimeMs !== a.ctimeMs ||
      named.dev !== a.dev ||
      named.ino !== a.ino
    )
      throw Error("COLD_MACHINE_PLAN_CHANGED");
    return data.subarray(0, bytesRead);
  } finally {
    await f.close();
  }
}

// A local trusted owner selects the genuine pre-restart plan by independent hash.
// This grants no action and never runs during startup, reconnect or updates.
// Caller-supplied current sessions, clocks and restart booleans are not accepted.
export async function qualifyColdMachineRecoveryPlan(
  input: Readonly<{
    planPath: string;
    expectedPlanSHA256: string;
    stateRoot: string;
    expectedRunSHA256: string;
    expectedQuitSHA256: string;
    expectedConfigSHA256: string;
    selectedRecords: readonly Readonly<{ Key: string; SHA256: string }>[];
    currentBootSession(): Promise<string>;
  }>,
) {
  if (
    !path.isAbsolute(input.planPath) ||
    path.normalize(input.planPath) !== input.planPath ||
    !Digest.safeParse(input.expectedPlanSHA256).success
  )
    throw Error("COLD_MACHINE_PLAN_SELECTION_INVALID");
  const raw = await bytes(input.planPath);
  if (digest(raw) !== input.expectedPlanSHA256)
    throw Error("COLD_MACHINE_PLAN_DIGEST_MISMATCH");
  const plan = Plan.parse(JSON.parse(raw.toString("utf8")));
  if (
    plan.selectedStateSHA256["running.json"] !== input.expectedRunSHA256 ||
    plan.selectedStateSHA256["last-quit.json"] !== input.expectedQuitSHA256 ||
    plan.selectedStateSHA256["config.json"] !== input.expectedConfigSHA256
  )
    throw Error("COLD_MACHINE_PLAN_SCOPE_MISMATCH");
  const records = [...input.selectedRecords]
    .map((r) => ({ key: r.Key, sha256: r.SHA256 }))
    .sort((a, b) => a.key.localeCompare(b.key));
  if (
    new Set(records.map((r) => r.key)).size !== records.length ||
    JSON.stringify(records) !== JSON.stringify(plan.retainedRecords)
  )
    throw Error("COLD_MACHINE_PLAN_INVENTORY_MISMATCH");
  const current = BootSession.parse(await input.currentBootSession());
  if (current === plan.beforeBootSessionUUID)
    throw Error("COLD_MACHINE_RESTART_NOT_OBSERVED");
  const recheck = async () => {
    if (
      (await input.currentBootSession()) !== current ||
      !raw.equals(await bytes(input.planPath))
    )
      throw Error("COLD_MACHINE_PLAN_CHANGED");
    for (const name of StateNames) {
      if (
        digest(await bytes(path.join(input.stateRoot, name))) !==
        plan.selectedStateSHA256[name]
      )
        throw Error("COLD_MACHINE_PLAN_STATE_CHANGED");
    }
  };
  await recheck();
  return Object.freeze({
    beforeBootSession: plan.beforeBootSessionUUID,
    recheck,
  });
}
