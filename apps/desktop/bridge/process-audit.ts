import { BridgeError, type Client } from "./client";
import {
  validate,
  type ComputerProcessAuditRequest,
  type ComputerProcessAuditResult,
  type ComputerProcessTerminalAudit,
} from "./wire";

// The caller supplies a reference retained from the authenticated original
// operation. This read neither starts a process nor changes its result.
export class ProcessAuditBridge {
  constructor(private readonly client: Pick<Client, "request">) {}

  async read(
    reference: ComputerProcessAuditRequest,
  ): Promise<ComputerProcessTerminalAudit | null> {
    if (!validate("ComputerProcessAuditRequest", reference))
      throw new BridgeError("refused", "process_audit_reference_invalid");
    const outcome = await this.client.request(
      "computer.process.audit",
      { ...reference },
    );
    if (
      outcome.status !== "ok" ||
      !validate("ComputerProcessAuditResult", outcome.data)
    )
      throw new BridgeError("unknown", "process_audit_unavailable");
    const result = outcome.data as unknown as ComputerProcessAuditResult;
    if (result.state === "not_observed" && result.fact === undefined)
      return null;
    const fact = result.fact;
    if (
      result.state !== "observed" ||
      !fact ||
      fact.operationId !== reference.operationId ||
      fact.buildId !== reference.buildId ||
      fact.runtimeId !== reference.runtimeId ||
      !fact.rootWaited ||
      !fact.outputDrained ||
      fact.groupCleanup === "pending" ||
      fact.descendantCleanup === "pending" ||
      !(fact.exitCode !== undefined
        ? fact.exitCode <= 255 && fact.exitSignal === 0
        : fact.exitSignal >= 1 && fact.exitSignal <= 128)
    )
      throw new BridgeError("unknown", "process_audit_crossed_or_invalid");
    return Object.freeze({ ...fact });
  }
}
