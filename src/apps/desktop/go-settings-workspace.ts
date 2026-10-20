import type {
  ReadonlyWorkspace,
  ReadonlyWorkspaceDescriptor,
  ReadonlyWorkspaceErrorCode,
  ReadonlyWorkspaceRequest,
  ReadonlyWorkspaceResult,
} from "../../modules/computer/app/port/readonly-workspace";

export type GoSettingsList = (
  workspace: ReadonlyWorkspaceDescriptor,
  relativePath: string,
) => Promise<
  | { ok: true; entries: readonly string[]; truncated: boolean }
  | { ok: false; code: string }
>;

function refusal(code: ReadonlyWorkspaceErrorCode): ReadonlyWorkspaceResult {
  return { ok: false, error: { code, retry: "never" } };
}

// A Go build lists one approved workspace directory through the Go settings
// list and supports nothing else here: a read, a search or a verification
// command is refused instead of being handed to the legacy Python helper.
// The Codex agent check asks for exactly one list, and a Go failure is its
// failure: nothing in this adapter has a second executor to fall back to.
export class GoSettingsListWorkspace implements ReadonlyWorkspace {
  constructor(private readonly list: GoSettingsList) {}

  async execute(
    request: ReadonlyWorkspaceRequest,
  ): Promise<ReadonlyWorkspaceResult> {
    const operation = request.operation;
    if (operation.kind === "verification.run") {
      return refusal("WORKSPACE_COMMAND_UNSUPPORTED");
    }
    if (operation.kind !== "workspace.list") {
      return refusal("WORKSPACE_INVALID_REQUEST");
    }
    let listed: Awaited<ReturnType<GoSettingsList>>;
    try {
      listed = await this.list(request.workspace, operation.relativePath);
    } catch {
      return refusal("WORKSPACE_HELPER_FAILED");
    }
    if (!listed.ok) {
      return refusal(
        listed.code === "WORKSPACE_ROOT_CHANGED"
          ? "WORKSPACE_ROOT_CHANGED"
          : "WORKSPACE_HELPER_FAILED",
      );
    }
    return {
      ok: true,
      value: {
        kind: "workspace.entries",
        entries: listed.entries,
        truncated: listed.truncated,
      },
    };
  }
}
