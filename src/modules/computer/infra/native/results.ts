import type {
  ReadonlyWorkspaceRequest,
  ReadonlyWorkspaceResult,
} from "../../app/port/readonly-workspace";

export type VerificationOperation = Extract<
  ReadonlyWorkspaceRequest["operation"],
  { kind: "verification.run" }
>;

// Status excludes untracked files and submodules by construction; HEAD reads
// one commit.  The result says so rather than letting a short status read as
// a clean workspace.
function commandCoverage(
  command: VerificationOperation["command"],
): "tracked-files-only" | "head-commit" {
  return command === "git.status" ? "tracked-files-only" : "head-commit";
}

export function commandResult(
  command: VerificationOperation["command"],
  stdout: string,
): ReadonlyWorkspaceResult {
  return {
    ok: true,
    value: {
      kind: "workspace.command",
      command,
      relativePath: ".",
      exitCode: 0,
      stdout,
      stderr: "",
      outputBytes: Buffer.byteLength(stdout),
      network: "none",
      coverage: commandCoverage(command),
      layout: "primary",
    },
  };
}
