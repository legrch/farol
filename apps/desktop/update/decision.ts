import type { z } from "zod";
import { sameBuild } from "./record";
import type { AcceptedBuild, Journal, Operation } from "./record";

// The startup decision over an authenticated update operation: what a fresh
// owner may conclude from the observed helper and the installed build. This is
// a pure table. It grants no write, launch, or retry authority.

export type HelperObservation = "live" | "ended" | "unknown";
export type StartupHelperState = "running" | "exited" | "unknown";

export function startupHelperState(
  status: HelperObservation,
): StartupHelperState {
  return status === "live"
    ? "running"
    : status === "ended"
      ? "exited"
      : "unknown";
}

/**
 * Startup decision table (after operation/binding/manifest authentication):
 * phase = none, prepared, predecessor_saved, new_installed, verified,
 * launch_requested, completed, rollback_started, rolled_back, cancelled,
 * cancel_launch_requested, cancel_completed, rollback_launch_requested,
 * rollback_completed. Every phase has exactly the same rows:
 * helper       installed       running       action          mayStart
 * running      any             any           wait            false
 * unknown      any             any           refuse          false
 * exited       neither         any           refuse          false
 * exited       target          target        completed       true
 * exited       target          source/other  completed       false
 * exited       source          source        rolled_back     true
 * exited       source          target/other  rolled_back     false
 * A missing journal means none only inside an authenticated operation; no
 * operation uses the ordinary install/adoption baseline. Historical phases are
 * evidence, never a reason to replay an effect or reopen a settled operation.
 * Companions only determine rollback availability, identically on every restart.
 * This pure decision grants no write, launch, or retry authority.
 */
export function installedUpdateStartupDecision(input: {
  phase: z.infer<typeof Journal>["phase"] | null;
  helper: StartupHelperState;
  installed: z.infer<typeof AcceptedBuild>;
  running: Pick<z.infer<typeof AcceptedBuild>, "version" | "buildId">;
  operation: z.infer<typeof Operation>;
}): {
  action: "completed" | "rolled_back" | "wait" | "refuse";
  mayStart: boolean;
} {
  if (input.helper === "running") return { action: "wait", mayStart: false };
  if (input.helper === "unknown") return { action: "refuse", mayStart: false };
  const accepted = [input.operation.target, input.operation.source].find(
    (build) => sameBuild(input.installed, build),
  );
  if (!accepted) return { action: "refuse", mayStart: false };
  return {
    action: sameBuild(accepted, input.operation.target)
      ? "completed"
      : "rolled_back",
    mayStart:
      input.running.buildId === accepted.buildId &&
      input.running.version === accepted.version,
  };
}
