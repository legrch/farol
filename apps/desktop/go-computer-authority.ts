import { randomUUID } from "node:crypto";
import { codexTaskCurrentSource } from "./task-current-settings";
import { BridgeError, type Client } from "./bridge/client";
import {
  validate,
  type Context,
  type Json,
  type ComputerAuthorityDeactivateResponse,
  type ComputerAuthorityPublication,
  type ChatComputerAdmissionRequest,
  type ChatComputerAdmissionResponse,
} from "./bridge/wire";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";
import { ownerSettingsComputerApproval } from "../../src/modules/computer/infra/repo/owner-settings-computer-approval";
import type { ComputerSettingsPublication } from "../../src/apps/desktop/product-configuration";

// Trusted desktop composition only. Go owns approval, live admission and durable
// effects. This adapter retains exact acknowledgements and never reconstructs
// authority from settings after an unknown response or restarts the backend.
export class GoComputerAuthority {
  private blocked = false;
  private pending = false;
  private publication: ComputerAuthorityPublication | undefined;
  private readonly context: Context;
  constructor(
    private readonly client: Pick<Client, "request">,
    context: Context,
    private readonly now: () => number = Date.now,
  ) {
    if (!validate("Context", context))
      throw new BridgeError("refused", "invalid_core_context");
    this.context = Object.freeze({ ...context });
  }

  async withdraw(): Promise<ComputerSettingsPublication> {
    if (this.blocked || this.pending)
      throw new BridgeError("unavailable", "computer_publication_unavailable");
    this.pending = true;
    this.publication = undefined;
    const receipt = await this.effect<ComputerAuthorityDeactivateResponse>(
      "computer.authority.deactivate",
      {},
      "ComputerAuthorityDeactivateResponse",
    );
    let consumed = false;
    return Object.freeze({
      publish: async (settings: ProductSettings): Promise<void> => {
        if (consumed || this.blocked)
          throw new BridgeError("refused", "computer_publication_consumed");
        consumed = true;
        try {
          const now = this.now();
          const approval = ownerSettingsComputerApproval(settings, now);
          // Fresh setup (or removing the last bound workspace) has no grant to
          // publish. The acknowledged withdrawal above keeps Go inactive; do
          // not submit an invalid empty approval or retain an admission receipt.
          if (approval.workspaces.length === 0) {
            this.pending = false;
            return;
          }
          const taskCodex = codexTaskCurrentSource(settings, now);
          const request = {
            fence: receipt.fence,
            expectedStoreRevision: receipt.storeRevision,
            settingsRevision: String(settings.revision),
            approval,
            ...(taskCodex === undefined ? {} : { taskCodex }),
          };
          if (!validate("ComputerAuthorityPublishRequest", request))
            throw new BridgeError("refused", "invalid_computer_publication");
          const operation = randomUUID();
          const published = await this.effect<ComputerAuthorityPublication>(
            "computer.authority.publish",
            request as unknown as Json,
            "ComputerAuthorityPublication",
            operation,
          );
          if (
            published.fence !== receipt.fence ||
            BigInt(published.storeRevision) !==
              BigInt(receipt.storeRevision) + 1n ||
            published.settingsRevision !== request.settingsRevision ||
            published.generation !== String(approval.generation) ||
            published.publishOperationId !== operation
          )
            throw new BridgeError("unknown", "crossed_computer_publication");
          this.publication = Object.freeze({ ...published });
          this.pending = false;
        } catch (error) {
          this.blocked = true;
          throw error;
        }
      },
    });
  }

  async admitRead(
    intent: Omit<ChatComputerAdmissionRequest, "publication">,
  ): Promise<ChatComputerAdmissionResponse> {
    if (this.blocked || this.pending || !this.publication)
      throw new BridgeError("unavailable", "computer_publication_unavailable");
    const request = {
      ...intent,
      workspaceIds: [...intent.workspaceIds],
      publication: this.publication,
    };
    if (!validate("ChatComputerAdmissionRequest", request))
      throw new BridgeError("refused", "invalid_read_intent");
    this.pending = true;
    try {
      const operation = randomUUID();
      const admitted = await this.effect<ChatComputerAdmissionResponse>(
        "chat.turn",
        request as unknown as Json,
        "ChatComputerAdmissionResponse",
        operation,
      );
      if (
        admitted.ownerId !== "owner-desktop" ||
        admitted.sessionId !== request.sessionId ||
        admitted.taskId !== request.taskId ||
        admitted.turnId !== request.turnId ||
        admitted.taskEpoch !== "1" ||
        admitted.generation !== "1" ||
        admitted.admissionOperationId !== operation ||
        BigInt(admitted.storeRevision) !==
          BigInt(request.publication.storeRevision) + 1n
      )
        throw new BridgeError("unknown", "crossed_computer_admission");
      // This acknowledgement describes the actual Go-created owner. It does not
      // grant authority locally; each subsequent Computer call is checked in Go.
      this.pending = false;
      this.publication = undefined;
      return Object.freeze({ ...admitted });
    } catch (error) {
      this.blocked = true;
      throw error;
    }
  }

  private async effect<T>(
    method: string,
    body: Json,
    schema: string,
    operation = randomUUID(),
  ): Promise<T> {
    const id = randomUUID();
    try {
      const outcome = await this.client.request(method, body, {
        id,
        operationId: operation,
      });
      if (
        !validate("Outcome", outcome) ||
        outcome.requestId !== id ||
        outcome.operationId !== operation ||
        outcome.context.profileId !== this.context.profileId ||
        outcome.context.backendGeneration !== this.context.backendGeneration
      )
        throw new BridgeError("unknown", "crossed_computer_acknowledgement");
      if (outcome.status !== "ok")
        throw new BridgeError(
          outcome.status,
          outcome.code ?? "computer_publication_failed",
        );
      if (outcome.code !== undefined || !validate(schema, outcome.data))
        throw new BridgeError("unknown", "invalid_computer_acknowledgement");
      return outcome.data as T;
    } catch (error) {
      this.blocked = true;
      throw error;
    }
  }
}
