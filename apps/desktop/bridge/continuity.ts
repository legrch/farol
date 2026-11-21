import { randomUUID } from "node:crypto";
import { RequestNotSentError, type Client } from "./client.ts";
import {
  validate,
  type ComputerContinuityBeginRequest,
  type ComputerContinuityBeginResponse,
  type ComputerContinuityConfirmRequest,
  type ComputerContinuityConfirmResponse,
  type ComputerContinuityFinishRequest,
  type ComputerContinuityPhaseResponse,
  type ComputerContinuityPlanRequest,
  type ComputerContinuityQualifyResponse,
  type ComputerContinuityReceipt,
  type ComputerContinuityRecordRequest,
  type Json,
} from "./wire.ts";

type Failure = Readonly<{ state: "refused" | "unknown" | "unavailable" }>;
export type ContinuityReply<T> =
  Readonly<{ state: "acknowledged"; value: T }> | Failure;

type Method =
  | "begin"
  | "confirm"
  | "plan"
  | "record"
  | "withdraw"
  | "stage"
  | "finish"
  | "qualify";

const unknown: Failure = { state: "unknown" };
const refused: Failure = { state: "refused" };
// Go bounds the combined Settings read and held native qualification at 27 s.
export const CONTINUITY_QUALIFICATION_TIMEOUT_MS = 30_000;

function boundedDecimal(value: string, limit: bigint): boolean {
  return BigInt(value) <= limit; // generated shape already validates syntax
}

function validConfirmation(value: ComputerContinuityConfirmResponse): boolean {
  const identity = value.rootIdentity;
  const evidence = value.continuity;
  const uint64 = 18_446_744_073_709_551_615n;
  const maxCounter = BigInt(Number.MAX_SAFE_INTEGER) - 1n;
  const parts = value.root.slice(1).split("/");
  return (
    value.root.startsWith("/") &&
    !/[\\\x00-\x1f\x7f]/u.test(value.root) &&
    parts.length <= 256 &&
    parts.every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        Buffer.byteLength(part, "utf8") <= 255,
    ) &&
    boundedDecimal(value.expectedRevision, maxCounter) &&
    boundedDecimal(value.expectedGeneration, maxCounter) &&
    boundedDecimal(identity.device, uint64) &&
    identity.inode === evidence.fileId &&
    boundedDecimal(evidence.fileId, uint64) &&
    evidence.volumeUuid !== "00000000-0000-0000-0000-000000000000" &&
    boundedDecimal(evidence.birthSeconds, 9_223_372_036_854_775_807n) &&
    boundedDecimal(evidence.birthNanoseconds, 999_999_999n)
  );
}

/** Owner-only calls on the inherited Go pipe. Each logical effect gets its own
 * envelope ID and is sent once. Plan is a read of the retained operation. */
export class ContinuityBridge {
  constructor(
    private readonly client: Pick<Client, "request" | "verifiedContext">,
  ) {}

  private async call<T>(
    method: Method,
    body: { readonly operationId: string },
    requestShape: string,
    responseShape: string,
    matches: (value: T) => boolean,
  ): Promise<ContinuityReply<T>> {
    if (!validate(requestShape, body)) return refused;
    const id = randomUUID();
    const operationId =
      method === "plan"
        ? undefined
        : method === "begin"
          ? body.operationId
          : randomUUID();
    try {
      const context = this.client.verifiedContext;
      const result = await this.client.request(
        `computer.continuity.${method}`,
        body as unknown as Json,
        {
          id,
          ...(operationId === undefined ? {} : { operationId }),
          timeoutMs:
            method === "qualify" ? CONTINUITY_QUALIFICATION_TIMEOUT_MS : 8_000,
        },
      );
      if (
        !validate("Outcome", result) ||
        result.requestId !== id ||
        result.operationId !== operationId ||
        result.context.profileId !== context.profileId ||
        result.context.backendGeneration !== context.backendGeneration ||
        result.nativeRefusalReason !== undefined
      )
        return unknown;
      if (result.status !== "ok") {
        if (result.data !== undefined || !result.code) return unknown;
        if (result.status === "refused") return refused;
        if (result.status === "unavailable" || result.status === "unsupported")
          return { state: "unavailable" };
        return unknown;
      }
      if (result.code !== undefined || !validate(responseShape, result.data))
        return unknown;
      const value = result.data as T;
      return matches(value) ? { state: "acknowledged", value } : unknown;
    } catch (error) {
      return error instanceof RequestNotSentError ? refused : unknown;
    }
  }

  begin(input: ComputerContinuityBeginRequest) {
    return this.call<ComputerContinuityBeginResponse>(
      "begin",
      input,
      "ComputerContinuityBeginRequest",
      "ComputerContinuityBeginResponse",
      (value) =>
        value.operationId === input.operationId && value.admitted === true,
    );
  }

  confirm(input: ComputerContinuityConfirmRequest) {
    return this.call<ComputerContinuityConfirmResponse>(
      "confirm",
      input,
      "ComputerContinuityConfirmRequest",
      "ComputerContinuityConfirmResponse",
      (value) =>
        value.operationId === input.operationId && validConfirmation(value),
    );
  }

  plan(input: ComputerContinuityPlanRequest) {
    return this.call<ComputerContinuityReceipt>(
      "plan",
      input,
      "ComputerContinuityPlanRequest",
      "ComputerContinuityReceipt",
      (value) => value.effectId === `${input.operationId}_${input.phase}`,
    );
  }

  record(input: ComputerContinuityRecordRequest) {
    return this.call<ComputerContinuityPhaseResponse>(
      "record",
      input,
      "ComputerContinuityRecordRequest",
      "ComputerContinuityPhaseResponse",
      (value) =>
        value.operationId === input.operationId && value.phase === input.phase,
    );
  }

  withdraw(operationId: string) {
    return this.call<ComputerContinuityReceipt>(
      "withdraw",
      { operationId },
      "ComputerContinuityOperationRequest",
      "ComputerContinuityReceipt",
      (value) => value.effectId === `${operationId}_withdraw_intent`,
    );
  }

  stage(operationId: string) {
    return this.call<ComputerContinuityReceipt>(
      "stage",
      { operationId },
      "ComputerContinuityOperationRequest",
      "ComputerContinuityReceipt",
      (value) => value.effectId === `${operationId}_publish_intent`,
    );
  }

  finish(input: ComputerContinuityFinishRequest) {
    return this.call<ComputerContinuityPhaseResponse>(
      "finish",
      input,
      "ComputerContinuityFinishRequest",
      "ComputerContinuityPhaseResponse",
      (value) =>
        value.operationId === input.operationId && value.phase === input.kind,
    );
  }

  qualify(operationId: string) {
    return this.call<ComputerContinuityQualifyResponse>(
      "qualify",
      { operationId },
      "ComputerContinuityOperationRequest",
      "ComputerContinuityQualifyResponse",
      (value) => value.operationId === operationId && value.qualified === true,
    );
  }
}
