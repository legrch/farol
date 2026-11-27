import { createHash } from "node:crypto";
import path from "node:path";

export type ShellStart = Readonly<{
  operationId: string;
  workspaceId: string;
  relativeCwd: string;
  command: string;
  stdin?: string | undefined;
  timeoutMs: number;
  write: boolean;
}>;

export type ShellRead = Readonly<{
  handle: string;
  stdoutOffset: number;
  stderrOffset: number;
}>;

export function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function exactRelative(value: string): boolean {
  return (
    value === "." ||
    (value.length > 0 &&
      value.length <= 4_096 &&
      !path.isAbsolute(value) &&
      !value.includes("\\") &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."))
  );
}

/** True when the start request is structurally admissible. */
export function validStartInput(
  input: ShellStart,
  absoluteDeadlineAt: number | undefined,
): boolean {
  return !(
    !/^[A-Za-z0-9._:-]{1,160}$/u.test(input.operationId) ||
    !exactRelative(input.relativeCwd) ||
    input.command.length === 0 ||
    input.command.includes("\0") ||
    Buffer.byteLength(input.command) > 16 * 1024 ||
    Buffer.byteLength(input.stdin ?? "") > 1024 * 1024 ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 600_000 ||
    (absoluteDeadlineAt !== undefined &&
      (!Number.isSafeInteger(absoluteDeadlineAt) || absoluteDeadlineAt <= 0))
  );
}

export function startFingerprint(
  input: ShellStart,
  absoluteDeadlineAt: number | undefined,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        absoluteDeadlineAt === undefined
          ? input
          : { input, absoluteDeadlineAt },
      ),
    )
    .digest("hex");
}

export function validReadOffsets(
  input: ShellRead,
  stdoutBytes: number,
  stderrBytes: number,
): boolean {
  return !(
    !Number.isSafeInteger(input.stdoutOffset) ||
    !Number.isSafeInteger(input.stderrOffset) ||
    input.stdoutOffset < 0 ||
    input.stderrOffset < 0 ||
    input.stdoutOffset > stdoutBytes ||
    input.stderrOffset > stderrBytes
  );
}
