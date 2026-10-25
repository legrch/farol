import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { closedRecoveryHostMechanics as host } from "../../../src/apps/desktop/closed-empty-chat-recovery";
import {
  maintenanceFailureCode,
  type MaintenanceObservation,
} from "./diagnostics";

export type MaintenanceAssessment = "SAFE_TO_APPLY" | "UNSAFE" | "UNKNOWN";
export type MaintenanceSelection = Readonly<{
  buildId: string;
  failedRunSha256: string;
  configSha256: string;
  operationId: string;
  hostLifetimeId: string;
  childLaunchId: string;
  backendGeneration: string;
}>;
export type MaintenanceAttempt = Readonly<{
  observe(value: MaintenanceObservation): void;
  selected(selection: MaintenanceSelection): Promise<void>;
  beforePreparation(): Promise<void>;
  completed(result: {
    phase: "prepared_for_cold_start";
    operationId: string;
  }): Promise<void>;
  failed(error: unknown): Promise<void>;
}>;
export type MaintenanceReceiptNotice = Readonly<{
  attemptId: string;
  outcome: MaintenanceAssessment;
  phase: "observing" | "preparing" | "completed" | "failed";
  confirmed: boolean;
}>;
const maximumBytes = 65536;
const maximumObservations = 96;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const unsafeBeforePreparation = new Set([
  "STARTUP_PRESERVED_SELECTION_INVALID",
  "STARTUP_PRESERVED_SELECTION_CHANGED",
  "CLOSED_COMPUTER_RECOVERY_WORK_PENDING",
  "CLOSED_COMPUTER_RECOVERY_APP_ACTIVE",
  "CLOSED_COMPUTER_RECOVERY_ROOT_UNSAFE",
  "CLOSED_COMPUTER_RECOVERY_FILE_UNSAFE",
  "core_resources_unqualified",
  "core_artifact_changed",
  "invalid_core_artifact",
  "native_profile_storage_invalid",
  "preserved_inspection_selection_invalid",
]);
const sum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

// This records one attempt, not predecessor drain or permission to retry. A
// SAFE_TO_APPLY observation still needs fresh original admission checks. A
// completed preparation is UNSAFE to apply twice; it is not a failed recovery.
export async function beginStartupMaintenanceAttempt(
  input: Readonly<{
    stateRoot: string;
    buildId: string;
    report?: (notice: MaintenanceReceiptNotice) => void;
  }>,
): Promise<MaintenanceAttempt> {
  const attemptId = randomUUID();
  let phase: MaintenanceReceiptNotice["phase"] = "observing";
  let outcome: MaintenanceAssessment = "UNKNOWN";
  const report = (confirmed: boolean) => {
    try {
      input.report?.(
        Object.freeze({
          attemptId,
          phase,
          outcome: confirmed ? outcome : "UNKNOWN",
          confirmed,
        }),
      );
    } catch {
      /* A diagnostic sink cannot alter an original operation. */
    }
  };
  try {
    if (
      !path.isAbsolute(input.stateRoot) ||
      path.resolve(input.stateRoot) !== input.stateRoot ||
      !/^[a-f0-9]{64}$/u.test(input.buildId)
    )
      throw Error("STARTUP_MAINTENANCE_RECEIPT_UNAVAILABLE");
    const stateIdentity = await host.privateRoot(input.stateRoot);
    const run = await host.snapshot(
      path.join(input.stateRoot, "running.json"),
      4096,
    );
    const configuration = await host.snapshot(
      path.join(input.stateRoot, "config.json"),
      256 * 1024,
    );
    const directory = path.join(
      input.stateRoot,
      "startup-maintenance-receipts",
    );
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const directoryIdentity = await host.privateRoot(directory);
    const file = path.join(directory, `${attemptId}.json`);
    const startedAt = new Date().toISOString();
    let operationId: string | null = null;
    let selection: MaintenanceSelection | null = null;
    let preparationMayHaveStarted = false;
    let terminal = false;
    let truncated = false;
    const observations: MaintenanceObservation[] = [];
    let retained: Awaited<ReturnType<typeof host.snapshot>> | undefined;
    let result: "prepared_for_cold_start" | null = null;
    let code: string | null = null;
    const verifyDirectory = async () => {
      const state = await host.privateRoot(input.stateRoot);
      if (state.dev !== stateIdentity.dev || state.ino !== stateIdentity.ino)
        throw Error("STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED");
      const current = await host.privateRoot(directory);
      if (
        current.dev !== directoryIdentity.dev ||
        current.ino !== directoryIdentity.ino
      )
        throw Error("STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED");
    };
    const syncDirectory = async () => {
      const handle = await fs.open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const current = await handle.stat();
        if (
          current.dev !== directoryIdentity.dev ||
          current.ino !== directoryIdentity.ino
        )
          throw Error("STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED");
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    const publish = async () => {
      const bytes = Buffer.from(
        JSON.stringify({
          schema: "farol.startup-maintenance-attempt/1",
          attemptId,
          assessmentScope: "prior-attempt-reapplication",
          buildId: input.buildId,
          pid: process.pid,
          failedRunSha256: sum(run.bytes),
          configSha256: sum(configuration.bytes),
          operationId,
          selection,
          stateRootIdentity: {
            device: String(stateIdentity.dev),
            inode: String(stateIdentity.ino),
          },
          startedAt,
          observedAt: new Date().toISOString(),
          phase,
          outcome,
          preparationMayHaveStarted,
          result,
          code,
          observations: [...observations],
          observationsTruncated: truncated,
        }) + "\n",
      );
      if (bytes.length > maximumBytes)
        throw Error("STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED");
      await verifyDirectory();
      const previous = retained;
      if (previous) await host.unchanged(file, previous);
      const target = previous
        ? path.join(directory, `.${attemptId}.${randomUUID()}.tmp`)
        : file;
      const handle = await fs.open(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const written = await host.snapshot(target, maximumBytes);
      if (!written.bytes.equals(bytes))
        throw Error("STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED");
      await verifyDirectory();
      if (previous) {
        await host.unchanged(file, previous);
        await fs.rename(target, file);
      }
      await syncDirectory();
      await verifyDirectory();
      const confirmed = await host.snapshot(file, maximumBytes);
      if (
        !confirmed.bytes.equals(bytes) ||
        confirmed.device !== written.device ||
        confirmed.inode !== written.inode
      )
        throw Error("STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED");
      retained = confirmed;
      report(true);
    };
    // A partial first write is never positive evidence: the initial outcome is
    // UNKNOWN. No maintenance or child may start if this write is unconfirmed.
    await publish();
    const checkpoint = async () => {
      try {
        await publish();
      } catch {
        report(false);
        throw Error("STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED");
      }
    };
    const finalObservation = async () => {
      try {
        await publish();
      } catch {
        report(
          false,
        ); /* Do not infer durable publication or replace the original result. */
      }
    };
    return Object.freeze({
      observe(value: MaintenanceObservation) {
        if (terminal) return;
        if (observations.length >= maximumObservations) {
          truncated = true;
          return;
        }
        observations.push(Object.freeze({ ...value }));
      },
      async selected(value: MaintenanceSelection) {
        if (
          terminal ||
          operationId !== null ||
          !uuid.test(value.operationId) ||
          value.buildId !== input.buildId ||
          value.failedRunSha256 !== sum(run.bytes) ||
          value.configSha256 !== sum(configuration.bytes) ||
          ![
            value.hostLifetimeId,
            value.childLaunchId,
            value.backendGeneration,
          ].every((v) => /^[A-Za-z0-9:_-]{1,120}$/u.test(v))
        )
          throw Error("STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED");
        operationId = value.operationId;
        selection = Object.freeze({
          buildId: value.buildId,
          failedRunSha256: value.failedRunSha256,
          configSha256: value.configSha256,
          operationId,
          hostLifetimeId: value.hostLifetimeId,
          childLaunchId: value.childLaunchId,
          backendGeneration: value.backendGeneration,
        });
        // Persist the exact selection before any discovery child can launch.
        await checkpoint();
      },
      async beforePreparation() {
        if (terminal || preparationMayHaveStarted || operationId === null)
          throw Error("STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED");
        try {
          await host.unchanged(path.join(input.stateRoot, "running.json"), run);
          await host.unchanged(
            path.join(input.stateRoot, "config.json"),
            configuration,
          );
        } catch {
          throw Error("STARTUP_MAINTENANCE_RECEIPT_UNCONFIRMED");
        }
        phase = "preparing";
        preparationMayHaveStarted = true;
        // This must be durable before entering the existing effectful owner.
        await checkpoint();
      },
      async completed(value: {
        phase: "prepared_for_cold_start";
        operationId: string;
      }) {
        if (terminal) return;
        terminal = true;
        if (
          preparationMayHaveStarted &&
          value.phase === "prepared_for_cold_start" &&
          value.operationId === operationId
        ) {
          phase = "completed";
          outcome = "UNSAFE";
          result = value.phase;
        } else {
          phase = "failed";
          outcome = "UNKNOWN";
        }
        await finalObservation();
      },
      async failed(error: unknown) {
        if (terminal) return;
        terminal = true;
        phase = "failed";
        const last = observations.at(-1);
        // Reuse the original filtered observation, rather than reading mutable
        // exception fields again after the stage already captured its failure.
        const observedFailure =
          last?.event === "end" &&
          last.result !== "returned" &&
          last.result !== "pending";
        code =
          (observedFailure ? last.code : null) ?? maintenanceFailureCode(error);
        const discoveryBegan = observations.some(
          (v) => v.stage === "discovery" && v.event === "begin",
        );
        if (
          !preparationMayHaveStarted &&
          !truncated &&
          !discoveryBegan &&
          operationId !== null &&
          last?.stage === "resources" &&
          last.result === "refused" &&
          last.code === "core_resources_deadline_expired" &&
          code === "core_resources_deadline_expired"
        )
          outcome = "SAFE_TO_APPLY";
        else if (
          !preparationMayHaveStarted &&
          unsafeBeforePreparation.has(code)
        )
          outcome = "UNSAFE";
        else outcome = "UNKNOWN";
        await finalObservation();
      },
    });
  } catch {
    report(false);
    throw Error("STARTUP_MAINTENANCE_RECEIPT_UNAVAILABLE");
  }
}
