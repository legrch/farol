import type {
  WorkspaceApprovedRoot,
  ReadonlyWorkspaceRequest,
} from "../../app/port/readonly-workspace";
import type { WorkspaceMutationRequest } from "../../app/port/mutable-workspace";
import { deniedPaths, writeDeniedPaths } from "./denied";
import { WorkspaceRefusal } from "./errors";
import { MAX_SOURCE_BYTES } from "./limits";
import { exactKeys, plainString } from "./paths";

// Builders for the one JSON request the helper reads, and the checks on the
// test-only barrier options. Pure data in, pure data out.

export type TestHooks = Readonly<{
  testHookRequest?: TestHookRequest | readonly TestHookRequest[];
  testHook?: (barrier: number) => Promise<void | "helper-fault">;
}>;

export type NativeRequest = Readonly<{
  operation:
    "edit" | "grep" | "list-directory" | "read" | "read-window" | "write";
  root: string;
  relative: string;
  denied: readonly string[];
  writeDenied?: readonly string[];
  maxBytes?: number;
  offset?: number;
  length?: number;
  pattern?: string;
  content?: string;
  edits?: readonly Readonly<{ oldText: string; newText: string }>[];
  expectedSha256?: string | null;
  fileOnly?: boolean;
  testHook?: TestHookRequest | readonly TestHookRequest[];
}>;

export type TestHookRequest = Readonly<{ phase: string; index: number | null }>;

// A test may pause the helper at up to four named points in one run; the
// callback learns which barrier (its position in the request) was reached.
// Answering "helper-fault" makes the helper fail with an internal error at
// that exact point, with its cleanup still running, instead of continuing.
const MAX_TEST_BARRIERS = 4;

function approvedRootRequest(
  workspace: Readonly<{ approvedRoot: WorkspaceApprovedRoot }>,
): Readonly<{ approvedRoot: WorkspaceApprovedRoot }> {
  return { approvedRoot: { ...workspace.approvedRoot } };
}

export function nativeMutationRequest(
  request: WorkspaceMutationRequest,
  options: TestHooks,
): NativeRequest {
  const common = {
    root: request.workspace.root,
    ...approvedRootRequest(request.workspace),
    relative: request.operation.relativePath,
    denied: deniedPaths(request),
    writeDenied: writeDeniedPaths(request),
    expectedSha256: request.operation.expectedSha256,
    ...(options.testHookRequest ? { testHook: options.testHookRequest } : {}),
  };
  return request.operation.kind === "workspace.write"
    ? {
        ...common,
        operation: "write",
        content: request.operation.content,
      }
    : {
        ...common,
        operation: "edit",
        edits: request.operation.edits.map((edit) => ({ ...edit })),
      };
}

export function nativeRequest(
  request: ReadonlyWorkspaceRequest,
  options: TestHooks,
): NativeRequest {
  const common = {
    root: request.workspace.root,
    ...approvedRootRequest(request.workspace),
    relative: request.operation.relativePath,
    denied: deniedPaths(request),
    ...(options.testHookRequest ? { testHook: options.testHookRequest } : {}),
  };
  switch (request.operation.kind) {
    case "workspace.read":
      return request.operation.range
        ? {
            ...common,
            operation: "read-window",
            offset: request.operation.range.offset,
            length: request.operation.range.length,
          }
        : { ...common, operation: "read", maxBytes: MAX_SOURCE_BYTES };
    case "workspace.list":
      return { ...common, operation: "list-directory" };
    case "workspace.search":
      return {
        ...common,
        operation: "grep",
        pattern: request.operation.pattern,
        ...(request.workspace.exactFilePaths ? { fileOnly: true } : {}),
      };
    case "verification.run":
      throw new WorkspaceRefusal("WORKSPACE_INVALID_REQUEST");
  }
}

export function testBarriers(options: TestHooks): readonly TestHookRequest[] {
  const requested = options.testHookRequest;
  if (requested === undefined) return [];
  return Array.isArray(requested)
    ? (requested as readonly TestHookRequest[])
    : [requested as TestHookRequest];
}

export function validTestOptions(options: TestHooks): boolean {
  if (options.testHookRequest === undefined && options.testHook === undefined) {
    return true;
  }
  const barriers = testBarriers(options);
  return (
    options.testHookRequest !== undefined &&
    options.testHook !== undefined &&
    barriers.length >= 1 &&
    barriers.length <= MAX_TEST_BARRIERS &&
    barriers.every(
      (barrier) =>
        exactKeys(barrier, ["phase", "index"]) &&
        plainString(barrier.phase, 80) &&
        (barrier.index === null ||
          (Number.isSafeInteger(barrier.index) && barrier.index >= 0)),
    ) &&
    new Set(barriers.map((barrier) => `${barrier.phase}:${barrier.index}`))
      .size === barriers.length
  );
}
