import type { ClaudeCommandRunner } from "../../../chat/contract/claude-task-route";
import type { SandboxedWorkspaceShell } from "../native/sandboxed-workspace-shell";
import type { ExecutionFenceReader } from "../mcp/execution-fence";
/** Use Computer's owned Seatbelt process lifecycle; never add a second runner. */
export class ClaudeTaskProcessPeer implements ClaudeCommandRunner {
  private readonly unverifiedLeases = new Set<object>();
  constructor(
    private readonly shell: SandboxedWorkspaceShell,
    private readonly fence: ExecutionFenceReader,
    private readonly expiresAt: number,
    private readonly admitted: () => Promise<boolean>,
    private readonly now: () => number = Date.now,
  ) {}
  async start(request: Parameters<ClaudeCommandRunner["start"]>[0]) {
    if (
      this.now() >= Math.min(request.deadlineAt, this.expiresAt) ||
      !(await this.admitted())
    )
      throw Error("CLAUDE_PROCESS_ADMISSION_DENIED");
    if (this.now() >= Math.min(request.deadlineAt, this.expiresAt))
      throw Error("CLAUDE_PROCESS_ADMISSION_DENIED");
    const lease = await this.fence.acquireAdmission();
    if (!lease.admitted) throw Error(lease.code);
    const operationId = "claude-" + request.key;
    let reserved = false;
    let handedOff = false;
    try {
      const result = await this.shell.start(
        {
          operationId,
          workspaceId: request.workspaceId,
          relativeCwd: ".",
          command: request.command,
          stdin: request.stdin,
          timeoutMs: Math.max(
            1,
            Math.min(
              600000,
              request.deadlineAt - this.now(),
              this.expiresAt - this.now(),
            ),
          ),
          write: false,
        },
        undefined,
        this.admitted,
        lease.fd,
        async () => {
          await this.fence.reserveShell(operationId);
          reserved = true;
        },
        Math.min(request.deadlineAt, this.expiresAt),
      );
      if (!result.ok) {
        if (reserved) {
          await this.fence.clearShell(operationId);
          reserved = false;
        }
        throw Error(result.error.code);
      }
      handedOff = true;
      const handle = result.value.handle;
      this.shell.trackTerminalCleanup(
        this.shell
          .waitForTerminal(handle)
          .then(async (cleanup) => {
            if (cleanup !== "confirmed") {
              this.fence.quarantineShell(operationId);
              this.unverifiedLeases.add(lease);
              throw Error("CLAUDE_GROUP_CLEANUP_UNVERIFIED");
            }
            await this.fence.clearShell(operationId);
            await lease.release();
          })
          .catch((error: unknown) => {
            this.fence.quarantineShell(operationId);
            this.unverifiedLeases.add(lease);
            throw error;
          }),
      );
      return handle;
    } finally {
      if (!handedOff) {
        if (reserved) {
          this.fence.quarantineShell(operationId);
          this.unverifiedLeases.add(lease);
        } else await lease.release();
      }
    }
  }
  async read(handle: string) {
    const result = this.shell.read({
      handle,
      stdoutOffset: 0,
      stderrOffset: 0,
    });
    if (!result.ok) throw Error(result.error.code);
    const value = result.value;
    return {
      state: value.state,
      stdout: new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(value.stdoutBase64, "base64"),
      ),
      exitCode: value.exitCode,
      exitSignal: value.exitSignal,
      groupCleanup: value.groupCleanup,
      truncated:
        value.outputLimitReached ||
        value.stdoutBytes > 65536 ||
        value.stdoutNextOffset !== value.stdoutBytes,
      interrupted:
        value.cancelRequested ||
        value.timedOut ||
        value.authorityExpired ||
        value.errorCode !== null,
    };
  }
}
