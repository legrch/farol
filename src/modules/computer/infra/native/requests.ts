import type { WorkspaceMutationRequest } from "../../app/port/mutable-workspace";
import type {
  ReadonlyWorkspaceRequest,
  WorkspaceReadRange,
} from "../../app/port/readonly-workspace";
import {
  MAX_MUTATION_BYTES,
  MAX_SOURCE_BYTES,
  MIN_WINDOW_BYTES,
} from "./limits";
import {
  canonicalAbsolutePath,
  canonicalRelativePath,
  exactKeys,
  hasOwn,
  plainString,
  validApprovedRoot,
  validGitMetadataGrant,
  validRelativePaths,
  validSha256,
  validWorkspaceId,
} from "./paths";

// Whole-request validation. A request is accepted only when every field has
// exactly the reviewed shape; anything else is refused before the helper runs.

function validReadRange(value: unknown): value is WorkspaceReadRange {
  if (!exactKeys(value, ["offset", "length"])) return false;
  const range = value as Readonly<Record<string, unknown>>;
  return (
    Number.isSafeInteger(range.offset) &&
    (range.offset as number) >= 0 &&
    Number.isSafeInteger(range.length) &&
    (range.length as number) >= MIN_WINDOW_BYTES &&
    (range.length as number) <= MAX_SOURCE_BYTES
  );
}

export function validateRequest(
  value: unknown,
): ReadonlyWorkspaceRequest | null {
  if (!exactKeys(value, ["workspace", "operation"])) return null;
  const candidate = value as Readonly<Record<string, unknown>>;
  const hasExactFilePaths = hasOwn(candidate.workspace, "exactFilePaths");
  const hasGitMetadata = hasOwn(candidate.workspace, "gitMetadata");
  // Every request names the identity the owner verified; a request without
  // one would let a folder that later took the same path pass as approved.
  if (
    !exactKeys(candidate.workspace, [
      "workspaceId",
      "root",
      "deniedPaths",
      "approvedRoot",
      ...(hasExactFilePaths ? ["exactFilePaths"] : []),
      ...(hasGitMetadata ? ["gitMetadata"] : []),
    ])
  ) {
    return null;
  }
  const workspace = candidate.workspace as Readonly<Record<string, unknown>>;
  if (
    !validWorkspaceId(workspace.workspaceId) ||
    !canonicalAbsolutePath(workspace.root) ||
    !validApprovedRoot(workspace.approvedRoot, workspace.root) ||
    (hasGitMetadata && !validGitMetadataGrant(workspace.gitMetadata)) ||
    !Array.isArray(workspace.deniedPaths) ||
    workspace.deniedPaths.length > 256 ||
    !workspace.deniedPaths.every((entry) => canonicalRelativePath(entry)) ||
    (hasExactFilePaths &&
      (!Array.isArray(workspace.exactFilePaths) ||
        workspace.exactFilePaths.length < 1 ||
        workspace.exactFilePaths.length > 32 ||
        !workspace.exactFilePaths.every((entry) =>
          canonicalRelativePath(entry, { root: true }),
        ) ||
        workspace.exactFilePaths.length !==
          new Set(workspace.exactFilePaths).size))
  ) {
    return null;
  }
  if (
    workspace.deniedPaths.length !== new Set(workspace.deniedPaths).size ||
    candidate.operation === null ||
    typeof candidate.operation !== "object" ||
    Array.isArray(candidate.operation)
  ) {
    return null;
  }
  const operation = candidate.operation as Readonly<Record<string, unknown>>;
  if (operation.kind === "workspace.read") {
    const hasRange = hasOwn(operation, "range");
    if (
      !exactKeys(operation, [
        "kind",
        "relativePath",
        ...(hasRange ? ["range"] : []),
      ]) ||
      !canonicalRelativePath(operation.relativePath) ||
      (hasRange &&
        operation.range !== undefined &&
        !validReadRange(operation.range))
    ) {
      return null;
    }
  } else if (operation.kind === "workspace.list") {
    if (
      !exactKeys(operation, ["kind", "relativePath"]) ||
      !canonicalRelativePath(operation.relativePath, { root: true })
    ) {
      return null;
    }
  } else if (operation.kind === "workspace.search") {
    if (
      !exactKeys(operation, ["kind", "relativePath", "pattern"]) ||
      !canonicalRelativePath(operation.relativePath, { root: true }) ||
      !plainString(operation.pattern, 4_096)
    ) {
      return null;
    }
  } else if (operation.kind === "verification.run") {
    if (
      !exactKeys(operation, ["kind", "command", "relativePath"]) ||
      (operation.command !== "git.status" &&
        operation.command !== "git.head") ||
      operation.relativePath !== "."
    ) {
      return null;
    }
  } else {
    return null;
  }
  if (
    hasExactFilePaths &&
    (operation.kind === "workspace.list" ||
      operation.kind === "verification.run" ||
      !(workspace.exactFilePaths as readonly string[]).includes(
        operation.relativePath as string,
      ))
  ) {
    return null;
  }
  return value as ReadonlyWorkspaceRequest;
}

function boundedMutationText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= MAX_MUTATION_BYTES
  );
}

export function validateMutationRequest(
  value: unknown,
): WorkspaceMutationRequest | null {
  if (!exactKeys(value, ["workspace", "operation"])) return null;
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    !exactKeys(candidate.workspace, [
      "workspaceId",
      "root",
      "deniedPaths",
      "writeDeniedPaths",
      "approvedRoot",
    ])
  ) {
    return null;
  }
  const workspace = candidate.workspace as Readonly<Record<string, unknown>>;
  if (
    !validWorkspaceId(workspace.workspaceId) ||
    !canonicalAbsolutePath(workspace.root) ||
    !validApprovedRoot(workspace.approvedRoot, workspace.root) ||
    !validRelativePaths(workspace.deniedPaths) ||
    !validRelativePaths(workspace.writeDeniedPaths) ||
    candidate.operation === null ||
    typeof candidate.operation !== "object" ||
    Array.isArray(candidate.operation)
  ) {
    return null;
  }
  const operation = candidate.operation as Readonly<Record<string, unknown>>;
  if (operation.kind === "workspace.write") {
    if (
      !exactKeys(operation, [
        "kind",
        "relativePath",
        "content",
        "expectedSha256",
      ]) ||
      !canonicalRelativePath(operation.relativePath) ||
      !boundedMutationText(operation.content) ||
      !(
        operation.expectedSha256 === null ||
        validSha256(operation.expectedSha256)
      )
    ) {
      return null;
    }
  } else if (operation.kind === "workspace.edit") {
    if (
      !exactKeys(operation, [
        "kind",
        "relativePath",
        "edits",
        "expectedSha256",
      ]) ||
      !canonicalRelativePath(operation.relativePath) ||
      !validSha256(operation.expectedSha256) ||
      !Array.isArray(operation.edits) ||
      operation.edits.length === 0 ||
      operation.edits.length > 256
    ) {
      return null;
    }
    let aggregate = 0;
    for (const edit of operation.edits) {
      if (!exactKeys(edit, ["oldText", "newText"])) return null;
      const record = edit as Readonly<Record<string, unknown>>;
      if (
        !boundedMutationText(record.oldText) ||
        !boundedMutationText(record.newText) ||
        record.oldText.length === 0 ||
        record.oldText === record.newText
      ) {
        return null;
      }
      aggregate +=
        Buffer.byteLength(record.oldText, "utf8") +
        Buffer.byteLength(record.newText, "utf8");
      if (aggregate > MAX_MUTATION_BYTES) return null;
    }
  } else {
    return null;
  }
  return value as WorkspaceMutationRequest;
}
