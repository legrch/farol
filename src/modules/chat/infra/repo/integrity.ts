import type { Stats } from "node:fs";
import type {
  ContextAdmission,
  ContextAdmissionResult,
} from "../../app/port/context-repository";
import {
  sameCompactionRequest,
  sameContextBinding,
  type CompactionRequest,
  type ContextBinding,
} from "../../domain/context-continuity";

// Integrity predicates of the private context store: ownership and mode of
// stored entries, schema-version classification and admission identity. Pure
// over values the store already read; nothing here touches the filesystem.

export function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

export function admissionConflict(
  admission: ContextAdmission,
  binding: ContextBinding,
  sourceEpoch: number,
  request: CompactionRequest,
): ContextAdmissionResult | null {
  if (!sameContextBinding(admission.binding, binding)) {
    return { status: "conflict", reason: "binding" };
  }
  if (admission.sourceEpoch !== sourceEpoch) {
    return { status: "conflict", reason: "epoch" };
  }
  if (!sameCompactionRequest(admission.request, request)) {
    return { status: "conflict", reason: "request" };
  }
  return null;
}

export function schemaError(value: unknown, code: string): Error {
  if (
    value &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    (value as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    return new Error(`${code}_UNSUPPORTED`);
  }
  return new Error(`${code}_CORRUPT`);
}

export function assertPrivateDirectory(info: Stats, code: string): void {
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.geteuid?.() !== undefined && info.uid !== process.geteuid()) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(code);
  }
}

export function assertPrivateFile(
  info: Stats,
  maximumBytes: number,
  code: string,
  maximumLinks = 1,
): void {
  if (
    !info.isFile() ||
    info.nlink < 1 ||
    info.nlink > maximumLinks ||
    info.size < 1 ||
    info.size > maximumBytes ||
    (process.geteuid?.() !== undefined && info.uid !== process.geteuid()) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(code);
  }
}
