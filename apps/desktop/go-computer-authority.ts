import { randomUUID } from "node:crypto";
import {
  codexTaskCurrentSource,
  codexTaskReadCurrentSource,
} from "./task-current-settings";
import { BridgeError, type Client } from "./bridge/client";
import {
  validate,
  validUnicode,
  type Context,
  type Json,
  type ComputerAuthorityDeactivateResponse,
  type ComputerAuthorityPublication,
  type ChatComputerAdmissionRequest,
  type ChatComputerAdmissionResponse,
  type ComputerSettingsListResponse,
  type ComputerSettingsSnapshotResponse,
} from "./bridge/wire";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";
import { ownerSettingsComputerApproval } from "../../src/modules/computer/infra/repo/owner-settings-computer-approval";
import type { ComputerSettingsPublication } from "../../src/apps/desktop/product-configuration";

// Wire entries are one native UTF-8 component, with a trailing slash only for
// a directory. Validate before any caller can persist verification evidence.
function settingsEntry(value: unknown): value is string {
  if (typeof value !== "string" || !validUnicode(value)) return false;
  const name = value.endsWith("/") ? value.slice(0, -1) : value;
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !/[\\/\u0000-\u001f\u007f]/u.test(name) &&
    Buffer.byteLength(name, "utf8") <= 255
  );
}

// Trusted desktop composition only. Go owns approval, live admission and durable
// effects. This adapter retains exact acknowledgements and never reconstructs
// authority from settings after an unknown response or restarts the backend.
export class GoComputerAuthority {
  private blocked = false;
  private pending = false;
  private publication: ComputerAuthorityPublication | undefined;
  private ownerPublication: ComputerAuthorityPublication | undefined;
  private settingsInFlight = false;
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
    this.ownerPublication = undefined;
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
          // Configured but unbound folders are not an explicit empty selection.
          // Keep them inactive until their physical identities are verified.
          if (
            settings.computer.workspaces.length > 0 &&
            approval.workspaces.length === 0
          ) {
            this.pending = false;
            return;
          }
          const taskRead = codexTaskReadCurrentSource(settings, now);
          const taskCodex =
            taskRead?.source ?? codexTaskCurrentSource(settings, now);
          const request = {
            fence: receipt.fence,
            expectedStoreRevision: receipt.storeRevision,
            settingsRevision: String(settings.revision),
            approval,
            // This producer projects persisted owner settings until their
            // explicit withdrawal; unrelated bounded grants remain finite.
            renewableOwnerConsent: true,
            ...(taskCodex === undefined ? {} : { taskCodex }),
            ...(taskRead === undefined
              ? {}
              : { taskCodexRead: taskRead.reference }),
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
          const known = Object.freeze({ ...published });
          // An explicit empty approval may connect and verify its catalogue,
          // but cannot become a Chat file-read admission in this adapter.
          this.publication =
            approval.workspaces.length === 0 ? undefined : known;
          this.ownerPublication = known;
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

  // An explicit Settings read uses the known owner publication, without a
  // synthetic Chat admission or a renewed approval. Withdrawal remains able to
  // invalidate this call while native IO is in progress.
  async listSettings(
    computerGeneration: number,
    workspaceId: string,
    relativePath: string,
  ): Promise<
    Omit<ComputerSettingsListResponse, "entries"> & { entries: string[] }
  > {
    return this.settingsWorkspace(
      "list",
      computerGeneration,
      workspaceId,
      relativePath,
    ) as Promise<
      Omit<ComputerSettingsListResponse, "entries"> & { entries: string[] }
    >;
  }

  snapshotSettings(
    computerGeneration: number,
    workspaceId: string,
    relativePath: string,
  ): Promise<ComputerSettingsSnapshotResponse> {
    return this.settingsWorkspace(
      "snapshot",
      computerGeneration,
      workspaceId,
      relativePath,
    ) as Promise<ComputerSettingsSnapshotResponse>;
  }

  // Exact previously acknowledged publication for the trusted host adapter.
  // This performs no renewal, admission or transport and grants nothing locally.
  settingsMutationPublication(
    computerGeneration: number,
  ): ComputerAuthorityPublication {
    const publication = this.ownerPublication;
    if (
      this.blocked ||
      this.pending ||
      !publication ||
      publication.generation !== String(computerGeneration)
    )
      throw new BridgeError("unavailable", "computer_publication_unavailable");
    return { ...publication };
  }

  private async settingsWorkspace(
    kind: "list" | "snapshot",
    computerGeneration: number,
    workspaceId: string,
    relativePath: string,
  ): Promise<
    | (Omit<ComputerSettingsListResponse, "entries"> & { entries: string[] })
    | ComputerSettingsSnapshotResponse
  > {
    const schema =
      kind === "list" ? "ComputerSettingsList" : "ComputerSettingsSnapshot";
    const publication = this.ownerPublication;
    if (
      this.blocked ||
      this.pending ||
      this.settingsInFlight ||
      !publication ||
      publication.generation !== String(computerGeneration)
    )
      throw new BridgeError("unavailable", "computer_publication_unavailable");
    const body = { publication, workspaceId, relativePath };
    if (!validate(`${schema}Request`, body))
      throw new BridgeError("refused", "invalid_settings_workspace_request");
    this.settingsInFlight = true;
    try {
      const id = randomUUID();
      const outcome = await this.client.request(
        `computer.settings.${kind}`,
        body as unknown as Json,
        { id, timeoutMs: 16_000 },
      );
      if (
        !validate("Outcome", outcome) ||
        outcome.requestId !== id ||
        outcome.operationId !== undefined ||
        outcome.context.profileId !== this.context.profileId ||
        outcome.context.backendGeneration !== this.context.backendGeneration
      )
        throw new BridgeError("unknown", "crossed_settings_workspace_result");
      if (outcome.status !== "ok")
        throw new BridgeError(
          outcome.status,
          outcome.code ?? "settings_workspace_failed",
        );
      if (
        outcome.code !== undefined ||
        !validate(`${schema}Response`, outcome.data)
      )
        throw new BridgeError("unknown", "invalid_settings_workspace_result");
      const result = outcome.data as unknown as
        ComputerSettingsListResponse | ComputerSettingsSnapshotResponse;
      if (kind === "list") {
        const entries = (result as ComputerSettingsListResponse).entries;
        if (
          !Array.isArray(entries) ||
          entries.length > 500 ||
          !entries.every(settingsEntry) ||
          new Set(
            entries.map((entry: string) =>
              entry.endsWith("/") ? entry.slice(0, -1) : entry,
            ),
          ).size !== entries.length
        )
          throw new BridgeError("unknown", "invalid_settings_workspace_result");
      }
      if (
        result.workspaceId !== workspaceId ||
        result.relativePath !== relativePath ||
        (
          Object.keys(publication) as (keyof ComputerAuthorityPublication)[]
        ).some((key) => result.publication[key] !== publication[key])
      )
        throw new BridgeError("unknown", "crossed_settings_workspace_result");
      if (this.ownerPublication !== publication || this.pending || this.blocked)
        throw new BridgeError("refused", "settings_workspace_withdrawn");
      const copied = {
        ...result,
        publication: { ...result.publication },
        root: { ...result.root },
      };
      if (kind === "list")
        return {
          ...copied,
          entries: [
            ...((result as ComputerSettingsListResponse).entries as string[]),
          ],
        };
      return copied as ComputerSettingsSnapshotResponse;
    } catch (error) {
      if (!(error instanceof BridgeError) || error.state === "unknown")
        this.blocked = true;
      throw error;
    } finally {
      this.settingsInFlight = false;
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
