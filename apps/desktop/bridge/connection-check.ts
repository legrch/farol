import { createHash, randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import {
  validate,
  type Json,
  type ComputerCheckClaimRequest,
  type ComputerCheckClaimResponse,
  type ComputerCheckPrepareRequest,
  type ComputerCheckPrepareResponse,
  type ComputerCheckAdvanceRequest,
  type ComputerCheckAdvanceResponse,
  type ComputerCheckObserveResponse,
} from "./wire.ts";

// A trusted Desktop-to-Go pipe, never a renderer-selected authority. The
// original UUID survives all short RPCs; each phase RPC has a separate effect
// ID. Unknown replies are observation-only and never trigger a new Send.
export class ConnectionCheckBridge {
  constructor(
    private readonly client: Pick<Client, "request" | "verifiedContext">,
  ) {}

  private async call<T>(
    method:
      | "computer.check.claim"
      | "computer.check.prepare"
      | "computer.check.advance"
      | "computer.check.observe",
    body: Json,
    responseName: string,
    operationId?: string,
  ): Promise<T> {
    const requestId = randomUUID();
    const context = this.client.verifiedContext;
    const outcome = await this.client.request(method, body, {
      id: requestId,
      ...(operationId === undefined ? {} : { operationId }),
      timeoutMs: method === "computer.check.observe" ? 5_000 : 8_000,
    });
    if (
      !validate("Outcome", outcome) ||
      outcome.requestId !== requestId ||
      outcome.operationId !== operationId ||
      outcome.context.profileId !== context.profileId ||
      outcome.context.backendGeneration !== context.backendGeneration
    )
      throw new BridgeError("unknown", "connection_check_crossed_reply");
    if (outcome.status !== "ok")
      throw new BridgeError(
        outcome.status,
        outcome.code ?? "connection_check_unavailable",
      );
    if (outcome.code !== undefined || !validate(responseName, outcome.data))
      throw new BridgeError("unknown", "connection_check_invalid_reply");
    return outcome.data as T;
  }

  async claim(
    input: ComputerCheckClaimRequest,
  ): Promise<ComputerCheckClaimResponse> {
    if (!validate("ComputerCheckClaimRequest", input))
      throw new BridgeError("refused", "connection_check_invalid_claim");
    const value = await this.call<ComputerCheckClaimResponse>(
      "computer.check.claim",
      input as unknown as Json,
      "ComputerCheckClaimResponse",
      input.operationId,
    );
    if (
      value.operationId !== input.operationId ||
      (value.first && value.phase !== "claimed")
    )
      throw new BridgeError("unknown", "connection_check_claim_crossed");
    return Object.freeze({ ...value });
  }

  async prepare(
    input: ComputerCheckPrepareRequest,
  ): Promise<ComputerCheckPrepareResponse> {
    if (!validate("ComputerCheckPrepareRequest", input))
      throw new BridgeError("refused", "connection_check_invalid_scope");
    const value = await this.call<ComputerCheckPrepareResponse>(
      "computer.check.prepare",
      input as unknown as Json,
      "ComputerCheckPrepareResponse",
      randomUUID(),
    );
    if (
      value.operationId !== input.operationId ||
      value.phase !== "prepared" ||
      value.mode !== input.mode ||
      value.documentDigest !== input.documentDigest ||
      (value.mode === "status") !== (value.checkId !== undefined) ||
      createHash("sha256").update(value.prompt).digest("hex") !==
        value.promptDigest
    )
      throw new BridgeError("unknown", "connection_check_prepared_crossed");
    return Object.freeze({ ...value });
  }

  async advance(
    input: ComputerCheckAdvanceRequest,
  ): Promise<ComputerCheckAdvanceResponse> {
    if (!validate("ComputerCheckAdvanceRequest", input))
      throw new BridgeError("refused", "connection_check_invalid_phase");
    const value = await this.call<ComputerCheckAdvanceResponse>(
      "computer.check.advance",
      input as unknown as Json,
      "ComputerCheckAdvanceResponse",
      randomUUID(),
    );
    if (
      value.operationId !== input.operationId ||
      (input.stage === "dispatch" &&
        (value.phase !== "dispatch_intent" || value.sendAuthorized !== true)) ||
      (input.stage !== "dispatch" && value.sendAuthorized !== false) ||
      (input.stage === "confirm" &&
        (value.phase !== "verified" || value.receiptDigest === undefined)) ||
      (input.stage === "refuse" && value.phase !== "refused_before_send") ||
      (input.stage === "sent" && value.phase !== "send_acknowledged") ||
      (input.stage === "unknown" && value.phase !== "outcome_unknown")
    )
      throw new BridgeError("unknown", "connection_check_phase_crossed");
    return Object.freeze({ ...value });
  }

  async observe(operationId: string): Promise<ComputerCheckObserveResponse> {
    const input = { operationId };
    if (!validate("ComputerCheckObserveRequest", input))
      throw new BridgeError("refused", "connection_check_invalid_observation");
    const value = await this.call<ComputerCheckObserveResponse>(
      "computer.check.observe",
      input,
      "ComputerCheckObserveResponse",
    );
    if (
      value.operationId !== operationId ||
      value.delivery !== "not_recorded" ||
      (value.phase === "verified") !== (value.receiptDigest !== undefined) ||
      (value.phase === "claimed" && value.mode !== undefined) ||
      (value.phase !== "claimed" &&
        value.phase !== "refused_before_send" &&
        value.mode === undefined) ||
      (value.phase === "verified" && !value.receiptAvailable) ||
      ((value.phase === "claimed" ||
        value.phase === "prepared" ||
        value.phase === "refused_before_send") &&
        value.receiptAvailable)
    )
      throw new BridgeError("unknown", "connection_check_observation_crossed");
    return Object.freeze({ ...value });
  }
}
