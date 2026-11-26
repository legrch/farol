import { createHash } from "node:crypto";
import { canonicalJson } from "../../../src/apps/desktop/codex-native-tool-registry";
import { record } from "./shape";

// How the provider names a turn and its tool calls, and reads what the host
// sends back for one: the digest of the host's identity, the call ids issued
// to it, the bounded text of a tool output, and the deferred value the
// provider and its stream hand each other.

const MAX_TOOL_OUTPUT_CHARACTERS = 512 * 1_024;
const CALL_ID_PREFIX = "farol_call_";

type TurnIdentity = Readonly<{
  sessionId: string;
  threadId: string;
  turnId: string;
  rootTurnId: string;
}>;

export type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}>;

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function turnKey(identity: TurnIdentity): string {
  return canonicalJson(identity);
}

export function turnTag(identity: TurnIdentity): string {
  return digest(turnKey(identity)).slice(0, 16);
}

export function currentCallPrefix(tag: string): string {
  return `${CALL_ID_PREFIX}${tag}`;
}

export function currentCallId(value: unknown, tag: string): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(currentCallPrefix(tag)) &&
    /^farol_call_[a-f0-9]{32}$/u.test(value)
  );
}

export function currentCallEntry(value: unknown, tag: string): boolean {
  return (
    record(value) &&
    (value.type === "function_call" || value.type === "function_call_output") &&
    currentCallId(value.call_id, tag)
  );
}

export function outputText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length <= MAX_TOOL_OUTPUT_CHARACTERS ? value : null;
  }
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const part of value) {
    if (
      !record(part) ||
      !["input_text", "output_text", "text"].includes(String(part.type)) ||
      typeof part.text !== "string"
    ) {
      return null;
    }
    parts.push(part.text);
  }
  const joined = parts.join("\n");
  return joined.length <= MAX_TOOL_OUTPUT_CHARACTERS ? joined : null;
}
