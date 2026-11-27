import type { MutableComputerCallRequest } from "../../contract/mutable-computer-contract";
import type {
  ReadonlyComputerCallRequest,
  ReadonlyComputerCallResponse,
} from "../../contract/readonly-computer-contract";

type ReadonlyOutput = Extract<
  ReadonlyComputerCallResponse,
  { ok: true }
>["value"]["output"];

// A page answers a ranged read and only a ranged read: text without one
// would read as the whole file.
export function readonlyOutputMatches(
  operation: ReadonlyComputerCallRequest["operation"],
  output: ReadonlyOutput,
): boolean {
  return (
    (operation.kind === "workspace.context" &&
      output.kind === "workspace.context") ||
    (operation.kind === "workspace.read" &&
      output.kind === "workspace.text" &&
      (operation.range === undefined) === (output.page === undefined)) ||
    (operation.kind === "workspace.list" &&
      output.kind === "workspace.entries") ||
    (operation.kind === "workspace.search" &&
      output.kind === "workspace.matches") ||
    (operation.kind === "verification.run" &&
      output.kind === "workspace.command" &&
      output.command === operation.command)
  );
}

// A receipt must name the same kind of mutation and the same path as asked.
export function mutationReceiptMatches(
  operation: MutableComputerCallRequest["operation"],
  receipt: Readonly<{ operation: string; relativePath: string }>,
): boolean {
  const expectedOperation =
    operation.kind === "workspace.write" ? "write" : "edit";
  return (
    receipt.operation === expectedOperation &&
    receipt.relativePath === operation.relativePath
  );
}
