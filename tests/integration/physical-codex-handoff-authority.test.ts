import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  PhysicalCodexHandoffAuthority,
  type PhysicalHandoffGrant,
} from "../../src/modules/chat/infra/native/physical-codex-handoff-authority";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(...arguments_: string[]): Promise<void> {
  await execFileAsync("/usr/bin/git", arguments_, {
    env: {
      HOME: "/private/tmp",
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
}

async function identity(
  root: string,
): Promise<{ device: string; inode: string }> {
  const stat = await fs.lstat(root, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino) };
}

async function fixture(): Promise<PhysicalHandoffGrant> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-handoff-roots-")),
  );
  roots.push(root);
  const projectRoot = path.join(root, "project");
  const writerRoot = path.join(root, "writer");
  await git("init", projectRoot);
  await git("-C", projectRoot, "commit", "--allow-empty", "-m", "fixture");
  await git(
    "-C",
    projectRoot,
    "worktree",
    "add",
    "--detach",
    writerRoot,
    "HEAD",
  );
  return {
    workspaceId: "approved-writer",
    writerRoot,
    writerIdentity: await identity(writerRoot),
    projectRoot,
    projectIdentity: await identity(projectRoot),
    gitCommonDirectory: path.join(projectRoot, ".git"),
    execution: { sandbox: "read-only", approvalPolicy: "on-request" },
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("physical Codex handoff authority", () => {
  it("resolves only the approved writer and canonical project in one Git repository", async () => {
    const grant = await fixture();
    const authority = new PhysicalCodexHandoffAuthority(grant);
    expect(await authority.resolve("unapproved")).toBeNull();
    expect(await authority.resolve(grant.workspaceId)).toEqual({
      root: grant.writerRoot,
      ...grant.writerIdentity,
      gitCommonDirectory: grant.gitCommonDirectory,
      project: {
        root: grant.projectRoot,
        ...grant.projectIdentity,
        gitCommonDirectory: grant.gitCommonDirectory,
      },
      execution: grant.execution,
    });
  });

  it("refuses a different repository even if its path is an approved folder", async () => {
    const grant = await fixture();
    const other = path.join(path.dirname(grant.projectRoot), "other");
    await git("init", other);
    const authority = new PhysicalCodexHandoffAuthority({
      ...grant,
      writerRoot: other,
      writerIdentity: await identity(other),
    });
    expect(await authority.resolve(grant.workspaceId)).toBeNull();
  });

  it("refuses a replaced root at the same pathname", async () => {
    const grant = await fixture();
    const authority = new PhysicalCodexHandoffAuthority(grant);
    await fs.rename(grant.writerRoot, `${grant.writerRoot}-moved`);
    await fs.mkdir(grant.writerRoot);
    expect(await authority.resolve(grant.workspaceId)).toBeNull();
  });

  it("refuses symlinked and noncanonical root aliases", async () => {
    const grant = await fixture();
    const alias = path.join(path.dirname(grant.projectRoot), "alias");
    await fs.symlink(grant.writerRoot, alias);
    expect(
      await new PhysicalCodexHandoffAuthority({
        ...grant,
        writerRoot: alias,
      }).resolve(grant.workspaceId),
    ).toBeNull();
    expect(
      await new PhysicalCodexHandoffAuthority({
        ...grant,
        writerRoot: `${grant.writerRoot}/../writer`,
      }).resolve(grant.workspaceId),
    ).toBeNull();
  });
});
