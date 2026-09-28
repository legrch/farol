import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import process from "node:process";
import type {
  ClaudeCommandRunner,
  ClaudeProcessHost,
  ClaudeRequest,
} from "../../app/port/claude-handoff";
import type {
  HandoffModelBinding,
  HandoffWorkspace,
} from "../../app/service/persistent-codex-handoff";
export type ClaudePrintHostSelection = Readonly<{
  qualification: "fixture-only";
  executablePath: string;
  executableSha256: string;
  models: readonly Readonly<{ model: string; efforts: readonly string[] }>[];
}>;
function quote(value: string) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
/** No raw spawn or unsandboxed fallback. Actual subscription/native use is unqualified. */
export class SandboxedClaudePrintHost implements ClaudeProcessHost {
  constructor(
    private readonly selection: ClaudePrintHostSelection,
    private readonly runner: ClaudeCommandRunner,
    private readonly expiresAt: number,
    private readonly now: () => number = Date.now,
  ) {}
  private async exactExecutable() {
    const selected = this.selection;
    if (
      selected.qualification !== "fixture-only" ||
      this.now() >= this.expiresAt
    )
      return false;
    const stat = await fs.lstat(selected.executablePath).catch(() => null);
    return (
      !!stat &&
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      (stat.mode & 0o022) === 0 &&
      (stat.mode & 0o111) !== 0 &&
      (stat.uid === process.getuid?.() || stat.uid === 0) &&
      stat.size <= 64 * 1024 * 1024 &&
      (await fs.realpath(selected.executablePath)) ===
        selected.executablePath &&
      createHash("sha256")
        .update(await fs.readFile(selected.executablePath))
        .digest("hex") === selected.executableSha256 &&
      this.now() < this.expiresAt
    );
  }
  async supports(binding: HandoffModelBinding) {
    const selected = binding.selection;
    return (
      selected.harness === "claude-code" &&
      this.selection.models.some(
        (entry) =>
          entry.model === selected.model &&
          (selected.effort === undefined ||
            entry.efforts.includes(selected.effort)),
      ) &&
      (await this.exactExecutable())
    );
  }
  async start(request: ClaudeRequest, _workspace: HandoffWorkspace) {
    if (!(await this.supports(request.modelBinding)))
      throw Error("CLAUDE_HOST_NOT_QUALIFIED");
    const selected = request.modelBinding.selection;
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      request.key,
      "--model",
      selected.model,
      "--permission-mode",
      "default",
      "--permission-prompts",
      "none",
      ...(selected.effort === undefined ? [] : ["--effort", selected.effort]),
    ];
    return this.runner.start({
      key: request.key,
      workspaceId: request.workspaceId,
      command:
        "exec " + [this.selection.executablePath, ...args].map(quote).join(" "),
      stdin: request.message + "\n",
      deadlineAt: this.expiresAt,
    });
  }
  read(handle: string) {
    return this.runner.read(handle);
  }
}
