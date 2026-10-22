import { createHash } from "node:crypto";
import type { DeferredGate } from "../../../../pkg/async/deferred-gate";
import type {
  ReadonlyWorkspace,
  ReadonlyWorkspaceRequest,
} from "../../app/port/readonly-workspace";

export const FIXTURE_WORKSPACE_ID = "preview-fixture";
export const FIXTURE_WORKSPACE_ROOT = "/farol/fixture";
// The fixture folder is in memory; this identity only satisfies the approval
// shape and proves nothing about a real folder.
export const FIXTURE_WORKSPACE_IDENTITY = Object.freeze({
  device: "0",
  inode: "0",
});
export const FIXTURE_STATUS_PATH = "status.txt";

const STATUS_TEXT = "Fixture workspace is ready.\n";

export class FixtureReadonlyWorkspace implements ReadonlyWorkspace {
  constructor(private readonly approval: DeferredGate) {}

  async execute(request: ReadonlyWorkspaceRequest) {
    if ((await this.approval.wait()) === "cancelled") {
      return {
        ok: false as const,
        error: {
          code: "WORKSPACE_HELPER_FAILED" as const,
          retry: "never" as const,
        },
      };
    }
    if (
      request.workspace.workspaceId !== FIXTURE_WORKSPACE_ID ||
      request.workspace.root !== FIXTURE_WORKSPACE_ROOT
    ) {
      return {
        ok: false as const,
        error: {
          code: "WORKSPACE_PATH_REFUSED" as const,
          retry: "never" as const,
        },
      };
    }
    // The fixture holds one short file and reads it whole; a window of it
    // would be answered without its position, so it is refused instead.
    if (
      request.operation.kind === "workspace.read" &&
      request.operation.range
    ) {
      return {
        ok: false as const,
        error: {
          code: "WORKSPACE_INVALID_REQUEST" as const,
          retry: "never" as const,
        },
      };
    }
    if (
      request.operation.kind !== "workspace.read" ||
      request.operation.relativePath !== FIXTURE_STATUS_PATH
    ) {
      return {
        ok: false as const,
        error: {
          code: "WORKSPACE_NOT_FOUND" as const,
          retry: "never" as const,
        },
      };
    }
    return {
      ok: true as const,
      value: {
        kind: "workspace.text" as const,
        text: STATUS_TEXT,
        bytes: Buffer.byteLength(STATUS_TEXT),
        sha256: createHash("sha256").update(STATUS_TEXT, "utf8").digest("hex"),
      },
    };
  }
}
