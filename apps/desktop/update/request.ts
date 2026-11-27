import type { ClosedInstalledPredecessor } from "../../../src/apps/desktop/installed-predecessor";
import type { z } from "zod";
import type { AcceptedBuild, Operation } from "./record";

// The request the installed-update runtime hands the helper for one apply or
// one restore. Each is a value built from what the caller holds: it starts no
// helper, reads no clock and keeps the caller's own admission and record order.

type Build = z.infer<typeof AcceptedBuild>;
type OperationRecord = z.infer<typeof Operation>;

/** The helper is told the drain was reconciled against exactly this pair. */
function reconciled(source: Build, target: Build) {
  return {
    status: "reconciled" as const,
    acceptedSource: source.buildId,
    acceptedTarget: target.buildId,
  };
}

/** The request that restores or rolls back one retained operation. */
export function restoreRequest(input: {
  action: "recover" | "rollback";
  operation: OperationRecord;
  installLocation: "shared" | "legacy";
  pid: number;
  processStart: string;
  presentation?: "sidecar-only";
}) {
  const { action, operation: op } = input;
  return {
    action,
    ...op,
    installLocation: input.installLocation,
    drain: reconciled(op.source, op.target),
    pid: input.pid,
    processStart: input.processStart,
    waitSeconds: 120,
    relaunch: true,
    ...(input.presentation ? { relaunchPresentation: input.presentation } : {}),
  };
}

/** The request that applies one prepared update. */
export function applyRequest(input: {
  installLocation: "shared" | "legacy";
  operationId: string;
  source: Build;
  target: Build;
  supervisedPredecessor?: Pick<
    ClosedInstalledPredecessor,
    "pid" | "startedAt" | "quitDigest" | "stateIdentity"
  >;
  quitApply: boolean;
  ownPid: number;
  processStart: string;
  presentation?: "sidecar-only";
}) {
  const supervised = input.supervisedPredecessor;
  return {
    action: "apply" as const,
    installLocation: input.installLocation,
    operationId: input.operationId,
    source: input.source,
    target: input.target,
    drain: reconciled(input.source, input.target),
    ...(supervised
      ? {
          predecessor: {
            kind: "confirmed_closed" as const,
            startedAt: supervised.startedAt,
            lastQuitSha256: supervised.quitDigest,
            stateIdentity: supervised.stateIdentity,
          },
        }
      : {}),
    pid: supervised?.pid ?? input.ownPid,
    processStart: input.processStart,
    waitSeconds: 120,
    // First-transition recovery must be qualified before the target
    // can write its state. Ordinary installed updates still relaunch.
    relaunch: !supervised && !input.quitApply,
    ...(!supervised && !input.quitApply && input.presentation
      ? { relaunchPresentation: input.presentation }
      : {}),
  };
}
