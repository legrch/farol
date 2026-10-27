import { createHash, randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import {
  validate,
  type ComputerConnectorOpened,
  type ComputerConnectorVerificationState,
  type Json,
} from "./wire.ts";

// Wire codec only. Go owns challenge admission, List/empty Catalogue and retained
// observation. This adapter cannot synthesize a successful receipt from IDs.
export class ConnectorVerificationBridge {
  private readonly binding;
  private readonly execution;
  constructor(
    private readonly client: Pick<Client, "request">,
    opened: ComputerConnectorOpened,
    private readonly challengeSha256: string,
  ) {
    if (
      !validate("ComputerConnectorOpened", opened) ||
      !/^[a-f0-9]{64}$/u.test(challengeSha256)
    )
      throw new BridgeError("refused", "invalid_connector_verification");
    this.binding = Object.freeze({ ...opened.endpoint.binding });
    this.execution = Object.freeze({ ...opened.execution });
  }
  async observe(checkId?: string): Promise<ComputerConnectorVerificationState> {
    const state = await this.request("computer.connector.verification", {
      binding: this.binding,
      ...(checkId === undefined ? {} : { checkId }),
    });
    if (checkId !== undefined && state.checkId !== checkId)
      throw new BridgeError("unknown", "crossed_connector_verification");
    return state;
  }
  async expectStatusCheck(checkId: string): Promise<void> {
    await this.request("computer.connector.verification", {
      binding: this.binding,
      checkId,
    });
  }
  async verify(
    challenge: string,
    workspaceId: string,
    callId: string,
  ): Promise<ComputerConnectorVerificationState> {
    const body = { challenge, workspaceId, callId };
    if (!validate("ComputerConnectorVerify", body))
      throw new BridgeError("refused", "invalid_connector_verification");
    // A stale or invented setup phrase is not an unavailable authority store.
    // Reject it before IO; Go still owns all actual admission and observation.
    if (
      createHash("sha256").update(challenge).digest("hex") !==
      this.challengeSha256
    )
      throw new BridgeError(
        "refused",
        "CONNECTOR_VERIFICATION_CHALLENGE_MISMATCH",
      );
    const result = await this.request("computer.connector.verify", body);
    if (
      !result.receipt ||
      result.receipt.workspaceId !== workspaceId ||
      result.receipt.challengeSha256 !==
        createHash("sha256").update(challenge).digest("hex")
    )
      throw new BridgeError("unknown", "crossed_connector_verification");
    return result;
  }
  async verifyCatalogue(
    challenge: string,
    callId: string,
  ): Promise<ComputerConnectorVerificationState> {
    const body = { challenge, callId };
    if (!validate("ComputerConnectorCatalogueVerify", body))
      throw new BridgeError("refused", "invalid_connector_verification");
    if (
      createHash("sha256").update(challenge).digest("hex") !==
      this.challengeSha256
    )
      throw new BridgeError(
        "refused",
        "CONNECTOR_VERIFICATION_CHALLENGE_MISMATCH",
      );
    const result = await this.request(
      "computer.connector.catalogueverify",
      body,
    );
    if (!result.catalogueReceipt || result.receipt)
      throw new BridgeError("unknown", "crossed_connector_verification");
    return result;
  }
  private async request(
    method: string,
    body: Json,
  ): Promise<ComputerConnectorVerificationState> {
    const id = randomUUID();
    const out = await this.client.request(method, body, {
      id,
      timeoutMs: 10000,
    });
    if (
      !validate("Outcome", out) ||
      out.requestId !== id ||
      out.operationId !== undefined ||
      out.context.profileId !== this.binding.profileId ||
      out.context.backendGeneration !== this.binding.backendGeneration
    )
      throw new BridgeError("unknown", "crossed_connector_verification");
    if (out.status !== "ok")
      throw new BridgeError(
        out.status,
        out.code ?? "connector_verification_unavailable",
      );
    if (
      out.code !== undefined ||
      !validate("ComputerConnectorVerificationState", out.data)
    )
      throw new BridgeError("unknown", "invalid_connector_verification");
    const state = out.data as unknown as ComputerConnectorVerificationState;
    const same = (expected: object, actual: object) =>
      Object.entries(expected).every(
        ([k, v]) => (actual as Record<string, unknown>)[k] === v,
      );
    if (
      !same(this.binding, state.binding) ||
      (state.receipt !== undefined && state.catalogueReceipt !== undefined) ||
      (state.receipt === undefined && state.catalogueReceipt === undefined) !==
        (state.receiptSha256 === undefined)
    )
      throw new BridgeError("unknown", "crossed_connector_verification");
    const receipt = state.receipt;
    if (
      receipt &&
      (!same(this.binding, receipt.binding) ||
        !same(this.execution, receipt.execution) ||
        receipt.challengeSha256 !== this.challengeSha256 ||
        receipt.entryCount > 500 ||
        createHash("sha256").update(JSON.stringify(receipt)).digest("hex") !==
          state.receiptSha256)
    )
      throw new BridgeError("unknown", "crossed_connector_verification");
    const catalogueReceipt = state.catalogueReceipt;
    if (
      catalogueReceipt &&
      (!same(this.binding, catalogueReceipt.binding) ||
        !same(this.execution, catalogueReceipt.execution) ||
        catalogueReceipt.challengeSha256 !== this.challengeSha256 ||
        catalogueReceipt.workspaceCount !== 0 ||
        createHash("sha256")
          .update(JSON.stringify(catalogueReceipt))
          .digest("hex") !== state.receiptSha256)
    )
      throw new BridgeError("unknown", "crossed_connector_verification");
    return Object.freeze({
      ...state,
      binding: Object.freeze({ ...state.binding }),
      ...(receipt
        ? {
            receipt: Object.freeze({
              ...receipt,
              binding: Object.freeze({ ...receipt.binding }),
              execution: Object.freeze({ ...receipt.execution }),
            }),
          }
        : {}),
      ...(catalogueReceipt
        ? {
            catalogueReceipt: Object.freeze({
              ...catalogueReceipt,
              binding: Object.freeze({ ...catalogueReceipt.binding }),
              execution: Object.freeze({ ...catalogueReceipt.execution }),
            }),
          }
        : {}),
    });
  }
}
