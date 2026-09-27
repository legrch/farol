import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  HandoffAuthority,
  HandoffWorkspace,
} from "../../app/service/persistent-codex-handoff";

const execFileAsync = promisify(execFile);
const GIT = "/usr/bin/git";

export type PhysicalHandoffGrant = Readonly<{
  workspaceId: string;
  writerRoot: string;
  writerIdentity: Readonly<{ device: string; inode: string }>;
  projectRoot: string;
  projectIdentity: Readonly<{ device: string; inode: string }>;
  gitCommonDirectory: string;
  execution: HandoffWorkspace["execution"];
}>;

function canonicalPath(value: string): boolean {
  return (
    path.isAbsolute(value) &&
    value !== "/" &&
    !value.includes("\0") &&
    path.normalize(value) === value
  );
}

async function exactRoot(
  root: string,
  identity: Readonly<{ device: string; inode: string }>,
): Promise<boolean> {
  if (!canonicalPath(root)) return false;
  const stat = await fs.lstat(root, { bigint: true }).catch(() => null);
  return (
    stat?.isDirectory() === true &&
    !stat.isSymbolicLink() &&
    String(stat.dev) === identity.device &&
    String(stat.ino) === identity.inode &&
    (await fs.realpath(root).catch(() => null)) === root
  );
}

async function commonDirectory(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      GIT,
      ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        env: {
          HOME: "/private/tmp",
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        timeout: 3_000,
        maxBuffer: 4_096,
      },
    );
    const result = stdout.trimEnd();
    return canonicalPath(result) ? result : null;
  } catch {
    return null;
  }
}

/** Re-measure both roots and their shared Git identity on every admission. */
export class PhysicalCodexHandoffAuthority implements HandoffAuthority {
  constructor(private readonly grant: PhysicalHandoffGrant) {}

  async resolve(workspaceId: string): Promise<HandoffWorkspace | null> {
    const selected = this.grant;
    if (
      workspaceId !== selected.workspaceId ||
      !canonicalPath(selected.gitCommonDirectory) ||
      !(await exactRoot(selected.writerRoot, selected.writerIdentity)) ||
      !(await exactRoot(selected.projectRoot, selected.projectIdentity))
    ) {
      return null;
    }
    const [writerCommon, projectCommon] = await Promise.all([
      commonDirectory(selected.writerRoot),
      commonDirectory(selected.projectRoot),
    ]);
    if (
      writerCommon !== selected.gitCommonDirectory ||
      projectCommon !== selected.gitCommonDirectory ||
      !(
        await fs.lstat(selected.gitCommonDirectory).catch(() => null)
      )?.isDirectory() ||
      (await fs.realpath(selected.gitCommonDirectory).catch(() => null)) !==
        selected.gitCommonDirectory
    ) {
      return null;
    }
    return {
      root: selected.writerRoot,
      device: selected.writerIdentity.device,
      inode: selected.writerIdentity.inode,
      gitCommonDirectory: selected.gitCommonDirectory,
      project: {
        root: selected.projectRoot,
        device: selected.projectIdentity.device,
        inode: selected.projectIdentity.inode,
        gitCommonDirectory: selected.gitCommonDirectory,
      },
      execution: selected.execution,
    };
  }
}
