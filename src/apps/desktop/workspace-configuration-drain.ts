import type { ProductConfigurationCommand } from "../../pkg/product-settings/contract";

export type WorkspaceConfigurationCommand = Readonly<
  Extract<
    ProductConfigurationCommand,
    {
      kind:
        | "computer.add-workspace"
        | "computer.update-access"
        | "computer.remove-workspace";
    }
  >
>;

// Only true confirms a phase. False is an explicit refusal; unknown (including
// a thrown or malformed reply) supplies no evidence of process/effect absence.
export type WorkspaceConfigurationConfirmation = true | false | "unknown";
export type WorkspaceConfigurationDrainPhase =
  "admission" | "stop" | "record-stopped" | "apply";

export type WorkspaceConfigurationDrainPorts<Result> = Readonly<{
  current(): boolean;
  stop(): Promise<WorkspaceConfigurationConfirmation>;
  recordStopped(): Promise<WorkspaceConfigurationConfirmation>;
  apply(command: WorkspaceConfigurationCommand): Promise<Result>;
}>;

type CurrentRefusal = Readonly<{
  status: "refused";
  phase: WorkspaceConfigurationDrainPhase;
  error: "WORKSPACE_CONFIGURATION_NOT_CURRENT";
}>;

export type WorkspaceConfigurationDrainResult<Result> =
  | Readonly<{ status: "completed"; phase: "apply"; result: Result }>
  | CurrentRefusal
  | Readonly<{
      status: "refused";
      phase: "admission";
      error:
        | "WORKSPACE_CONFIGURATION_ATTEMPT_CONSUMED"
        | "WORKSPACE_CONFIGURATION_INPUT_INVALID";
    }>
  | Readonly<{
      status: "refused";
      phase: "stop" | "record-stopped";
      error: "WORKSPACE_CONFIGURATION_PHASE_REFUSED";
    }>
  | Readonly<{
      status: "unknown";
      phase: "stop" | "record-stopped" | "apply";
      error: "WORKSPACE_CONFIGURATION_PHASE_UNCONFIRMED";
    }>
  | Readonly<{
      status: "stale";
      phase: "stop" | "record-stopped";
      error: "WORKSPACE_CONFIGURATION_NOT_CURRENT";
    }>
  | Readonly<{
      status: "stale";
      phase: "apply";
      error: "WORKSPACE_CONFIGURATION_NOT_CURRENT";
      result: Result;
    }>;

/**
 * One attempt for an already admitted command, inside the original authority-
 * change reservation's callback. The caller retains that reservation through
 * run() settling; this sequencer never acquires or releases authority.
 *
 * The Lead supplies current() for the exact reservation, permission/Settings
 * generations and Quit/update fences. stop() delegates to the original
 * controlled drain; recordStopped() confirms the original stopped-state
 * publication/readback. These owners must map only confirmed outcomes to true.
 * apply() invokes the original configuration once. No journal, recovery, flag
 * reset or restart belongs here. Completed means a current original reply was
 * received, including any refusal in that opaque reply, not mutation success.
 */
export class WorkspaceConfigurationDrain<Result> {
  private consumed = false;

  constructor(
    private readonly command: WorkspaceConfigurationCommand,
    private readonly ports: WorkspaceConfigurationDrainPorts<Result>,
  ) {}

  async run(): Promise<WorkspaceConfigurationDrainResult<Result>> {
    if (this.consumed) {
      return {
        status: "refused",
        phase: "admission",
        error: "WORKSPACE_CONFIGURATION_ATTEMPT_CONSUMED",
      };
    }
    // Consume synchronously, including invalid entry and synchronous reentry.
    this.consumed = true;
    if (
      !this.command ||
      ![
        "computer.add-workspace",
        "computer.update-access",
        "computer.remove-workspace",
      ].includes(this.command.kind) ||
      typeof this.ports?.stop !== "function" ||
      typeof this.ports.recordStopped !== "function" ||
      typeof this.ports.apply !== "function"
    ) {
      return {
        status: "refused",
        phase: "admission",
        error: "WORKSPACE_CONFIGURATION_INPUT_INVALID",
      };
    }
    if (!this.isCurrent()) return this.notCurrent("admission");

    for (const phase of ["stop", "record-stopped"] as const) {
      if (!this.isCurrent()) return this.notCurrent(phase);
      let confirmation: WorkspaceConfigurationConfirmation;
      try {
        confirmation =
          phase === "stop"
            ? await this.ports.stop()
            : await this.ports.recordStopped();
      } catch {
        // Recheck even on rejection, without turning uncertainty into refusal.
        this.isCurrent();
        return this.unconfirmed(phase);
      }
      const current = this.isCurrent();
      if (confirmation === false) {
        return {
          status: "refused",
          phase,
          error: "WORKSPACE_CONFIGURATION_PHASE_REFUSED",
        };
      }
      if (confirmation !== true) return this.unconfirmed(phase);
      if (!current) {
        return {
          status: "stale",
          phase,
          error: "WORKSPACE_CONFIGURATION_NOT_CURRENT",
        };
      }
    }

    if (!this.isCurrent()) return this.notCurrent("apply");
    let result: Result;
    try {
      result = await this.ports.apply(this.command);
    } catch {
      this.isCurrent();
      return this.unconfirmed("apply");
    }
    if (!this.isCurrent()) {
      return {
        status: "stale",
        phase: "apply",
        error: "WORKSPACE_CONFIGURATION_NOT_CURRENT",
        result,
      };
    }
    return { status: "completed", phase: "apply", result };
  }

  private isCurrent(): boolean {
    try {
      // A missing predicate, throw, Promise or truthy non-boolean fails closed.
      return (
        typeof this.ports?.current === "function" &&
        this.ports.current() === true
      );
    } catch {
      return false;
    }
  }

  private notCurrent(phase: WorkspaceConfigurationDrainPhase): CurrentRefusal {
    return {
      status: "refused",
      phase,
      error: "WORKSPACE_CONFIGURATION_NOT_CURRENT",
    };
  }

  private unconfirmed(
    phase: "stop" | "record-stopped" | "apply",
  ): WorkspaceConfigurationDrainResult<Result> {
    return {
      status: "unknown",
      phase,
      error: "WORKSPACE_CONFIGURATION_PHASE_UNCONFIRMED",
    };
  }
}
