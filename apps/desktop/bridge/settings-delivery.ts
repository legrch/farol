import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BridgeError, type Client } from "./client.ts";
import {
  validate,
  type Context,
  type Json,
  type ComputerSettingsEditRequest,
  type ComputerSettingsMutationResponse,
  type SettingsDeliveryACKResult,
  type SettingsDeliveryResult,
  type SettingsStorePending,
} from "./wire.ts";

const limit = 4096;
const timeoutMs = 15_000;
type Binding = Omit<SettingsStorePending, "submittedAt">;
type Correlation = {
  binding?: Binding;
  pending?: SettingsStorePending;
  offer?: SettingsDeliveryResult;
  ack?: Promise<SettingsDeliveryACKResult>;
};

function binding(pending: SettingsStorePending): Binding {
  const { submittedAt: _, ...selected } = pending;
  return selected;
}

function invalid(code: string): never {
  throw new BridgeError("unknown", code);
}

// One verified peer, bounded transport evidence only. Go owns all pending,
// Offer, ACK, mutation and storage policy. No delivery receipt exists locally
// until an exact offer has passed validation; no receipt ID is synthesized.
export class SettingsDeliveryBridge {
  private readonly peer: Readonly<Context>;
  private readonly correlations = new Map<string, Correlation>();
  private calls = 0;

  constructor(
    private readonly client: Pick<Client, "request" | "verifiedContext">,
  ) {
    const peer = client.verifiedContext;
    if (!validate("Context", peer))
      throw new BridgeError("refused", "settings_delivery_context_invalid");
    this.peer = Object.freeze({ ...peer });
  }

  async apply(
    operationId: string,
    input: ComputerSettingsEditRequest,
  ): Promise<SettingsDeliveryResult> {
    const request = structuredClone(input);
    const body = { deadlineMillis: this.deadline(), request };
    if (
      !validate("id", operationId) ||
      !validate("SettingsDeliveryApply", body) ||
      request.edits.length < 1 ||
      request.edits.length > 256 ||
      !this.positiveSafe(request.publication.generation) ||
      Buffer.byteLength(JSON.stringify(body), "utf8") > 512 * 1024
    )
      throw new BridgeError("refused", "invalid_settings_delivery_request");
    this.samePeer();
    if (this.correlations.has(operationId))
      throw new BridgeError("refused", "settings_delivery_attempt_consumed");
    const selected: Binding = {
      backend: "go-owner-v2",
      operationId,
      profileId: this.peer.profileId,
      workspaceId: request.workspaceId,
      relativePath: request.relativePath,
      computerGeneration: request.publication.generation,
      beforeSHA256: request.expectedSHA256,
    };
    // Reserve before invoking transport, including a local non-dispatch failure.
    const entry = this.reserve(operationId);
    entry.binding = selected;
    const data = await this.call(
      "computer.settings.delivery.apply",
      body,
      operationId,
    );
    return this.accept(data, entry, selected);
  }

  async observe(input: SettingsStorePending): Promise<SettingsDeliveryResult> {
    const pending = structuredClone(input);
    const body = { deadlineMillis: this.deadline(), pending };
    if (
      !validate("SettingsDeliveryObserve", body) ||
      pending.profileId !== this.peer.profileId ||
      !this.positiveSafe(pending.computerGeneration)
    )
      throw new BridgeError("refused", "invalid_settings_delivery_request");
    this.samePeer();
    const entry = this.reserve(pending.operationId);
    const selected = binding(pending);
    this.checkBinding(entry, selected, pending);
    // Retain the exact timestamp string, including nanoseconds, even on loss.
    entry.binding = selected;
    entry.pending = pending;
    const data = await this.call(
      "computer.settings.delivery.observe",
      body,
      this.effectId(pending.operationId),
    );
    return this.accept(data, entry, selected, pending);
  }

  async acknowledge(operationId: string): Promise<SettingsDeliveryACKResult> {
    if (!validate("id", operationId))
      throw new BridgeError("refused", "invalid_settings_delivery_request");
    const entry = this.reserve(operationId);
    if (!entry.ack) {
      const offer = entry.offer;
      // Consume the invocation before any request or reentrant client code.
      // Observation cannot replace this promise, including its original error.
      entry.ack = Promise.resolve().then(async () => {
        this.samePeer();
        if (!offer?.receiptId)
          throw new BridgeError("refused", "settings_delivery_offer_missing");
        const body = {
          deadlineMillis: this.deadline(),
          receiptId: offer.receiptId,
          pending: structuredClone(offer.pending),
        };
        const data = await this.call(
          "computer.settings.delivery.ack",
          body,
          this.effectId(operationId),
        );
        if (!validate("SettingsDeliveryACKResult", data))
          invalid("invalid_settings_delivery_ack");
        const out = data as unknown as SettingsDeliveryACKResult;
        if (
          !out.acknowledged ||
          out.receiptId !== offer.receiptId ||
          !isDeepStrictEqual(out.pending, offer.pending)
        )
          invalid("crossed_settings_delivery_ack");
        return structuredClone(out);
      });
    }
    const out = await entry.ack;
    this.samePeer();
    return structuredClone(out);
  }

  private deadline(): string {
    return String(Date.now() + 14_000);
  }

  private positiveSafe(value: string): boolean {
    const n = BigInt(value);
    return n > 0n && n <= BigInt(Number.MAX_SAFE_INTEGER);
  }

  private samePeer(): void {
    const current = this.client.verifiedContext;
    if (
      !validate("Context", current) ||
      current.profileId !== this.peer.profileId ||
      current.backendGeneration !== this.peer.backendGeneration
    )
      invalid("settings_delivery_peer_changed");
  }

  private reserve(operationId: string): Correlation {
    let entry = this.correlations.get(operationId);
    if (!entry) {
      if (this.correlations.size >= limit)
        throw new BridgeError("refused", "settings_delivery_retention_full");
      entry = {};
      this.correlations.set(operationId, entry);
    }
    return entry;
  }

  private effectId(original: string): string {
    const id = randomUUID();
    if (id === original) invalid("settings_delivery_transport_id_collision");
    return id;
  }

  private async call(
    method: string,
    body: { deadlineMillis: string },
    operationId: string,
  ): Promise<Json | undefined> {
    this.samePeer();
    if (this.calls >= limit)
      throw new BridgeError("refused", "settings_delivery_call_budget");
    this.calls++;
    const id = randomUUID();
    const until = Number(body.deadlineMillis) + 1000;
    const remaining = until - Date.now();
    if (remaining <= 0 || remaining > timeoutMs)
      invalid("settings_delivery_deadline_invalid");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const lost = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new BridgeError("unknown", "settings_delivery_timeout")),
          remaining,
        );
      });
      const outcome = await Promise.race([
        this.client.request(method, structuredClone(body) as unknown as Json, {
          id,
          operationId,
          timeoutMs: remaining,
        }),
        lost,
      ]);
      this.samePeer();
      if (Date.now() >= until) invalid("settings_delivery_response_late");
      if (
        !validate("Outcome", outcome) ||
        outcome.requestId !== id ||
        outcome.operationId !== operationId ||
        !isDeepStrictEqual(outcome.context, this.peer)
      )
        invalid("crossed_settings_delivery_outcome");
      if (outcome.status !== "ok") {
        if (outcome.code === undefined || outcome.data !== undefined)
          invalid("invalid_settings_delivery_outcome");
        throw new BridgeError(outcome.status, outcome.code);
      }
      if (outcome.code !== undefined)
        invalid("invalid_settings_delivery_outcome");
      return structuredClone(outcome.data);
    } finally {
      clearTimeout(timer);
    }
  }

  private checkBinding(
    entry: Correlation,
    selected: Binding,
    pending?: SettingsStorePending,
  ): void {
    if (
      (entry.binding && !isDeepStrictEqual(entry.binding, selected)) ||
      (entry.pending && pending && !isDeepStrictEqual(entry.pending, pending))
    )
      invalid("crossed_settings_delivery_pending");
  }

  private accept(
    data: Json | undefined,
    entry: Correlation,
    selected: Binding,
    observed?: SettingsStorePending,
  ): SettingsDeliveryResult {
    this.samePeer();
    if (!validate("SettingsDeliveryResult", data))
      invalid("invalid_settings_delivery_result");
    const out = data as unknown as SettingsDeliveryResult;
    if (
      !isDeepStrictEqual(binding(out.pending), selected) ||
      (observed && !isDeepStrictEqual(out.pending, observed))
    )
      invalid("crossed_settings_delivery_pending");
    this.checkBinding(entry, selected, out.pending);
    if (out.state === "pending") {
      if (
        out.receiptId !== undefined ||
        out.result !== undefined ||
        out.retention !== undefined ||
        entry.offer !== undefined
      )
        invalid("invalid_settings_delivery_pending");
    } else {
      if (!out.receiptId || !out.result || !out.retention)
        invalid("invalid_settings_delivery_offer");
      this.checkResult(out.result, out.pending);
      if (out.retention !== out.result.publication)
        invalid("invalid_settings_delivery_retention");
      if (entry.offer && !isDeepStrictEqual(entry.offer, out))
        invalid("crossed_settings_delivery_offer");
      for (const other of this.correlations.values())
        if (other !== entry && other.offer?.receiptId === out.receiptId)
          invalid("crossed_settings_delivery_receipt");
      entry.offer = structuredClone(out);
    }
    entry.pending = structuredClone(out.pending);
    return structuredClone(out);
  }

  private checkResult(
    result: ComputerSettingsMutationResponse,
    pending: SettingsStorePending,
  ): void {
    if (
      result.operationId !== pending.operationId ||
      result.workspaceId !== pending.workspaceId ||
      result.computerGeneration !== pending.computerGeneration
    )
      invalid("crossed_settings_delivery_result");
    if (result.phase === "completed") {
      const receipt = result.receipt;
      if (
        result.failure !== undefined ||
        !receipt ||
        receipt.operation !== "edit" ||
        receipt.relativePath !== pending.relativePath ||
        receipt.beforeSHA256 !== pending.beforeSHA256 ||
        BigInt(receipt.bytes) > 8n * 1024n * 1024n ||
        receipt.replacements < 1 ||
        receipt.replacements > 256
      )
        invalid("crossed_settings_delivery_receipt");
    } else if (
      result.receipt !== undefined ||
      !result.failure ||
      result.failure.retry !== "never" ||
      (result.phase === "outcome_unknown") !==
        (result.failure.code === "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
    )
      invalid("invalid_settings_delivery_failure");
  }
}
