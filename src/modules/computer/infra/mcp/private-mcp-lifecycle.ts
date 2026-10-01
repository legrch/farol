import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SHARED_LOCK = 0x10;
const EXCLUSIVE_LOCK = 0x20;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const DIGEST = /^[a-f0-9]{64}$/u;
const PREPARED = /^prepared-([a-f0-9]{64})$/u;

/** One launch root, shared by Desktop and every Computer MCP it authorizes. */
export class PrivateMcpLifecycle {
  private readonly directory: string;
  private activeHandlers = 0;
  private handlerAdmissionClosed = false;

  constructor(private readonly root: string) {
    if (!path.isAbsolute(root) || root.includes("\0"))
      throw new Error("COMPUTER_MCP_LIFECYCLE_ROOT_INVALID");
    this.directory = path.join(root, "mcp-lifecycle");
  }

  private async ensure(): Promise<void> {
    if (process.platform !== "darwin")
      throw new Error("COMPUTER_MCP_LIFECYCLE_UNSUPPORTED");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of [this.root, this.directory]) {
      const info = await fs.lstat(name);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0 ||
        (process.geteuid?.() !== undefined && info.uid !== process.geteuid()) ||
        (await fs.realpath(name)) !== name
      )
        throw new Error("COMPUTER_MCP_LIFECYCLE_ROOT_UNSAFE");
    }
  }

  private async lock(exclusive: boolean, timeoutMs: number) {
    await this.ensure();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const handle = await fs.open(
          path.join(this.directory, "lifetime.lock"),
          fsConstants.O_RDWR |
            fsConstants.O_CREAT |
            fsConstants.O_NONBLOCK |
            NO_FOLLOW |
            CLOSE_ON_EXEC |
            (exclusive ? EXCLUSIVE_LOCK : SHARED_LOCK),
          0o600,
        );
        try {
          const info = await handle.stat();
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            (info.mode & 0o077) !== 0 ||
            (process.geteuid?.() !== undefined &&
              info.uid !== process.geteuid())
          )
            throw new Error("COMPUTER_MCP_LIFECYCLE_LOCK_UNSAFE");
        } catch (error) {
          await handle.close();
          throw error;
        }
        return handle;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          (code !== "EAGAIN" && code !== "EWOULDBLOCK") ||
          Date.now() >= deadline
        )
          throw new Error("COMPUTER_MCP_LIFECYCLE_UNVERIFIED");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  private async marker(name: string): Promise<boolean> {
    const target = path.join(this.directory, name);
    try {
      const handle = await fs.open(
        target,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          NO_FOLLOW |
          CLOSE_ON_EXEC,
        0o600,
      );
      try {
        await handle.writeFile("1\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.sync();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await this.existingMarker(name)))
        throw new Error("COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE");
      return false;
    }
  }

  private async existingMarker(name: string): Promise<boolean> {
    const target = path.join(this.directory, name);
    let info;
    try {
      info = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (process.geteuid?.() !== undefined && info.uid !== process.geteuid()) ||
      (await fs.readFile(target, "utf8")) !== "1\n"
    )
      throw new Error("COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE");
    return true;
  }

  private async sync(): Promise<void> {
    const directory = await fs.open(
      this.directory,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async shellGroupsGone(): Promise<void> {
    const directory = path.join(this.root, "execution-fence");
    const entries = await fs
      .readdir(directory)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    if (entries.some((entry) => entry.startsWith("shell-")))
      throw new Error("COMPUTER_MCP_SHELL_CLEANUP_UNVERIFIED");
  }

  private async instancesGone(): Promise<void> {
    if (
      (await fs.readdir(this.directory)).some((entry) =>
        entry.startsWith("active-"),
      )
    )
      throw new Error("COMPUTER_MCP_INSTANCE_CLEANUP_UNVERIFIED");
  }

  private async revokePrepared(): Promise<void> {
    for (const entry of await fs.readdir(this.directory)) {
      const match = PREPARED.exec(entry);
      if (match) {
        await this.existingMarker(entry);
        await this.marker(`revoked-${match[1]}`);
      } else if (entry.startsWith("prepared-"))
        throw new Error("COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE");
    }
  }

  /** Called by Desktop after writing the exact new launch contract, before starting its tunnel. */
  async prepare(digest: string): Promise<void> {
    if (!DIGEST.test(digest))
      throw new Error("COMPUTER_MCP_LIFECYCLE_DIGEST_INVALID");
    const lease = await this.lock(true, 5_000);
    try {
      await this.instancesGone();
      await this.shellGroupsGone();
      await this.revokePrepared();
      await this.marker(`prepared-${digest}`);
      if (await this.existingMarker(`revoked-${digest}`))
        throw new Error("COMPUTER_MCP_LIFECYCLE_DIGEST_REUSED");
      await fs
        .unlink(path.join(this.directory, "stopping"))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      await this.sync();
    } finally {
      await lease.close();
    }
  }

  /** Held by the MCP process from before serveStdio until its verified shutdown. */
  async join(digest: string): Promise<Readonly<{ release(): Promise<void> }>> {
    if (!DIGEST.test(digest))
      throw new Error("COMPUTER_MCP_LIFECYCLE_DIGEST_INVALID");
    const lease = await this.lock(false, 0);
    const instance = `active-${randomUUID()}`;
    try {
      if (!(await this.existingMarker(`prepared-${digest}`)))
        throw new Error("COMPUTER_MCP_LIFECYCLE_UNPREPARED");
      for (const name of ["stopping", `revoked-${digest}`]) {
        if (await this.existingMarker(name))
          throw new Error("COMPUTER_MCP_LIFECYCLE_REVOKED");
      }
      await this.marker(instance);
    } catch (error) {
      await lease.close();
      throw error;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        await fs.unlink(path.join(this.directory, instance));
        await this.sync();
        await lease.close();
        released = true;
      },
    };
  }

  /** Install before stopping the tunnel; new MCP joins then refuse. */
  async beginStop(): Promise<void> {
    await this.ensure();
    await this.marker("stopping");
  }

  async isStopping(): Promise<boolean> {
    return this.existingMarker("stopping");
  }

  enterHandler(): (() => void) | null {
    if (this.handlerAdmissionClosed) return null;
    this.activeHandlers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeHandlers -= 1;
    };
  }

  closeHandlers(): void {
    this.handlerAdmissionClosed = true;
  }

  async waitForHandlers(timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.activeHandlers > 0) {
      if (Date.now() >= deadline)
        throw new Error("COMPUTER_MCP_HANDLERS_UNVERIFIED");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** No MCP lifetime lease or unresolved shell group may remain. */
  async waitForStop(timeoutMs = 5_000): Promise<void> {
    const lease = await this.lock(true, timeoutMs);
    try {
      if (!(await this.existingMarker("stopping")))
        throw new Error("COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED");
      await this.instancesGone();
      await this.shellGroupsGone();
    } finally {
      await lease.close();
    }
  }

  /** Final confirmation after the tunnel parent has stopped; revoke its launch. */
  async confirmStop(timeoutMs = 5_000): Promise<void> {
    const lease = await this.lock(true, timeoutMs);
    try {
      if (!(await this.existingMarker("stopping")))
        throw new Error("COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED");
      await this.revokePrepared();
      await this.instancesGone();
      await this.shellGroupsGone();
    } finally {
      await lease.close();
    }
  }
}
