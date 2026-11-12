import { randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import {
  validate,
  type ComputerStopAdmitRequest,
  type ComputerStopAdmitResponse,
  type ComputerStopAdvanceRequest,
  type ComputerStopAdvanceResponse,
  type ComputerStopRefuseResponse,
  type ComputerStopStatusResponse,
  type Json,
} from "./wire.ts";

// Trusted inherited Desktop-Go pipe only. The Go owner confirms durable
// original intent and generates the lifetime admission; this adapter cannot
// supply a certificate, a success boolean or current Computer authority.
// Each effect is attempted exactly once with its original RPC operation ID.
export class OriginalStopBridge {
  constructor(
    private readonly client: Pick<Client, "request" | "verifiedContext">,
  ) {}

  private async call<T>(
    method:
      | "computer.stop.admit"
      | "computer.stop.advance"
      | "computer.stop.refuse"
      | "computer.stop.status",
    body: Json,
    shape: string,
    operationId?: string,
  ): Promise<T> {
    const id = randomUUID();
    const context = this.client.verifiedContext;
    const out = await this.client.request(method, body, {
      id,
      ...(operationId === undefined ? {} : { operationId }),
      timeoutMs: method === "computer.stop.status" ? 5_000 : 8_000,
    });
    if (
      !validate("Outcome", out) ||
      out.requestId !== id ||
      out.operationId !== operationId ||
      out.context.profileId !== context.profileId ||
      out.context.backendGeneration !== context.backendGeneration
    )
      throw new BridgeError("unknown", "computer_original_stop_crossed");
    if (out.status !== "ok")
      throw new BridgeError(
        out.status,
        out.code ?? "computer_original_stop_unavailable",
      );
    if (out.code !== undefined || !validate(shape, out.data))
      throw new BridgeError("unknown", "computer_original_stop_invalid");
    return out.data as T;
  }

  async status(): Promise<ComputerStopStatusResponse> {
    const value = await this.call<ComputerStopStatusResponse>(
      "computer.stop.status",
      {},
      "ComputerStopStatusResponse",
    );
    if (
      (value.pendingOperationId === undefined) !==
        (value.pendingPhase === undefined) ||
      (value.pendingOperationId !== undefined && !value.restricted) ||
      (value.restricted && value.pendingOperationId === undefined) ||
      (value.present === false && (value.restricted || value.entryCount !== 0))
    )
      throw new BridgeError("unknown", "computer_original_stop_status_crossed");
    return Object.freeze({ ...value });
  }

  async begin(
    input: ComputerStopAdmitRequest,
  ): Promise<ComputerStopAdmitResponse> {
    if (!validate("ComputerStopAdmitRequest", input))
      throw new BridgeError("refused", "computer_original_stop_input_invalid");
    const value = await this.call<ComputerStopAdmitResponse>(
      "computer.stop.admit",
      input as unknown as Json,
      "ComputerStopAdmitResponse",
      input.operationId,
    );
    if (
      !value.first ||
      value.parentOperationId !== input.operationId ||
      value.phase !== "stop_intent" ||
      value.stopEffectId !== input.stopEffectId
    )
      throw new BridgeError(
        "unknown",
        "computer_original_stop_admission_crossed",
      );
    return Object.freeze({ ...value });
  }

  async advance(
    input: ComputerStopAdvanceRequest,
  ): Promise<ComputerStopAdvanceResponse> {
    if (!validate("ComputerStopAdvanceRequest", input))
      throw new BridgeError("refused", "computer_original_stop_phase_invalid");
    const value = await this.call<ComputerStopAdvanceResponse>(
      "computer.stop.advance",
      input as unknown as Json,
      "ComputerStopAdvanceResponse",
      randomUUID(),
    );
    if (
      value.parentOperationId !== input.parentOperationId ||
      value.phase !== input.phase ||
      value.delivery !== "not_recorded"
    )
      throw new BridgeError("unknown", "computer_original_stop_phase_crossed");
    return Object.freeze({ ...value });
  }

  async refuse(parentOperationId: string): Promise<ComputerStopRefuseResponse> {
    if (!validate("ComputerStopRefuseRequest", { parentOperationId }))
      throw new BridgeError(
        "refused",
        "computer_original_stop_refusal_invalid",
      );
    const value = await this.call<ComputerStopRefuseResponse>(
      "computer.stop.refuse",
      { parentOperationId },
      "ComputerStopRefuseResponse",
      randomUUID(),
    );
    if (
      value.parentOperationId !== parentOperationId ||
      value.phase !== "refused_before_stop"
    )
      throw new BridgeError(
        "unknown",
        "computer_original_stop_refusal_crossed",
      );
    return Object.freeze({ ...value });
  }
}
