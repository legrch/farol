import type {
  OperationEntry,
  OperationsSnapshot,
} from "../renderer/operations-contract";

// Pure rules for the internal read-diagnostic lookup.

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const bindingPattern = /^[a-f0-9]{64}$/u;

export function validRequestId(requestId: string): boolean {
  return requestIdPattern.test(requestId);
}

/** The Go-owned binding is a 64-hex digest; anything else grants nothing. */
export function bindingOrNull(binding: unknown): string | null {
  return typeof binding === "string" && bindingPattern.test(binding)
    ? binding
    : null;
}

/** No cached, incomplete or corrupt view may prove uniqueness or absence. */
export function lookupIncomplete(
  snapshot: OperationsSnapshot,
  entryLimit: number,
): boolean {
  return !!(
    snapshot.readPending ||
    snapshot.readIncomplete ||
    snapshot.corruptLines ||
    snapshot.writeFailures ||
    snapshot.droppedEntries ||
    snapshot.entries.length >= entryLimit
  );
}

export function diagnosticMatches(
  entries: readonly OperationEntry[],
  requestId: string,
  workspaceIdentity: unknown,
  relativePath: string,
): OperationEntry[] {
  return entries.filter(
    (entry) =>
      entry.requestId === requestId &&
      entry.kind === "computer_workspace_read" &&
      entry.target.workspaceIdentity === workspaceIdentity &&
      entry.target.relativePath === relativePath &&
      entry.readDiagnostic !== undefined,
  );
}
