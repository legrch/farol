import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceIdentity } from "../../tooling/source-identity.mjs";

function git(repository, ...arguments_) {
  return execFileSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

async function repositoryWithOneFile(body = "export {};\n") {
  const repository = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-source-identity-"),
  );
  await fs.mkdir(path.join(repository, "vnext/nested"), { recursive: true });
  await fs.writeFile(path.join(repository, "vnext/main.ts"), body);
  await fs.writeFile(path.join(repository, "vnext/nested/deep.ts"), body);
  git(repository, "init", "-q");
  git(repository, "add", "vnext");
  git(repository, "-c", "user.email=a@b.c", "-c", "user.name=T", "commit", "-q", "-m", "init");
  return repository;
}

describe("source identity distinguishes a difference from a failure", () => {
  // The defect: six separate conditions all collapsed into one unnamed
  // `exact = false`, so a clean `git status` with `dirty: true` gave the
  // caller nothing to act on -- and a read that FAILED was folded into the
  // same answer as a file that genuinely differed.
  it("names the file when one genuinely differs, instead of only saying dirty", async () => {
    const repository = await repositoryWithOneFile();
    try {
      await fs.writeFile(path.join(repository, "vnext/main.ts"), "export {}; //\n");
      const identity = sourceIdentity(repository);
      expect(identity.dirty).toBe(true);
      expect(identity.reasons).toContainEqual(
        expect.objectContaining({ kind: "content", path: "vnext/main.ts" }),
      );
    } finally {
      await fs.rm(repository, { recursive: true, force: true });
    }
  });

  it("refuses with the file named when a tracked file cannot be read, rather than calling it dirty", async () => {
    const repository = await repositoryWithOneFile();
    const unreadable = path.join(repository, "vnext/nested");
    try {
      await fs.chmod(unreadable, 0o000);
      let thrown = null;
      try {
        sourceIdentity(repository);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, "an unreadable tracked file must refuse, not return").not.toBe(null);
      expect(thrown.message).toContain("SOURCE_IDENTITY_UNREADABLE");
      expect(thrown.message).toContain("vnext/nested/deep.ts");
    } finally {
      await fs.chmod(unreadable, 0o700).catch(() => undefined);
      await fs.rm(repository, { recursive: true, force: true });
    }
  });

  it("reports a clean tree as clean, with no reasons at all", async () => {
    const repository = await repositoryWithOneFile();
    try {
      const identity = sourceIdentity(repository);
      expect(identity.dirty).toBe(false);
      expect(identity.reasons).toEqual([]);
    } finally {
      await fs.rm(repository, { recursive: true, force: true });
    }
  });
});

describe("source identity", () => {
  it("binds the committed tree and ignores task-local filesystem noise", async () => {
    const repository = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-source-identity-"),
    );
    try {
      await fs.mkdir(path.join(repository, "vnext"));
      await fs.writeFile(
        path.join(repository, "vnext/.gitignore"),
        ".DS_Store\n",
      );
      await fs.writeFile(
        path.join(repository, "vnext/AGENTS.md"),
        "tracked portable instructions\n",
      );
      await fs.writeFile(
        path.join(repository, "vnext/main.ts"),
        "export {};\n",
      );
      git(repository, "init", "-q");
      git(repository, "add", "vnext");
      git(
        repository,
        "-c",
        "user.name=Farol Next Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "initial",
      );

      const initial = sourceIdentity(repository, "vnext");
      await fs.writeFile(path.join(repository, "vnext/.DS_Store"), "host-a");
      const withIgnoredNoise = sourceIdentity(repository, "vnext");

      expect(withIgnoredNoise).toEqual(initial);
      expect(initial.dirty).toBe(false);

      await fs.writeFile(
        path.join(repository, "vnext/AGENTS.md"),
        "changed portable instructions\n",
      );
      expect(sourceIdentity(repository, "vnext")).toMatchObject({
        commit: initial.commit,
        treeDigest: initial.treeDigest,
        dirty: true,
      });
      git(repository, "restore", "vnext/AGENTS.md");

      await fs.writeFile(
        path.join(repository, "vnext/main.ts"),
        "export const changed = true;\n",
      );
      expect(sourceIdentity(repository, "vnext")).toMatchObject({
        commit: initial.commit,
        treeDigest: initial.treeDigest,
        dirty: true,
      });

      git(repository, "add", "vnext/main.ts");
      git(
        repository,
        "-c",
        "user.name=Farol Next Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "change",
      );
      const changed = sourceIdentity(repository, "vnext");
      expect(changed.dirty).toBe(false);
      expect(changed.commit).not.toBe(initial.commit);
      expect(changed.treeDigest).not.toBe(initial.treeDigest);

      git(repository, "update-index", "--assume-unchanged", "vnext/main.ts");
      await fs.writeFile(
        path.join(repository, "vnext/main.ts"),
        "export const hidden = true;\n",
      );
      expect(sourceIdentity(repository, "vnext").dirty).toBe(true);
      git(repository, "update-index", "--no-assume-unchanged", "vnext/main.ts");
      git(repository, "restore", "vnext/main.ts");

      git(repository, "update-index", "--skip-worktree", "vnext/main.ts");
      await fs.writeFile(
        path.join(repository, "vnext/main.ts"),
        "export const skipped = true;\n",
      );
      expect(sourceIdentity(repository, "vnext").dirty).toBe(true);
      git(repository, "update-index", "--no-skip-worktree", "vnext/main.ts");
      git(repository, "restore", "vnext/main.ts");

      await fs.symlink(
        "../../outside.ts",
        path.join(repository, "vnext/link.ts"),
      );
      git(repository, "add", "vnext/link.ts");
      git(
        repository,
        "-c",
        "user.name=Farol Next Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "tracked symlink",
      );
      expect(sourceIdentity(repository, "vnext").dirty).toBe(true);
    } finally {
      await fs.rm(repository, { recursive: true, force: true });
    }
  }, 15_000);

  it("compares tracked files larger than Node's default spawn buffer", async () => {
    const repository = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-source-identity-large-"),
    );
    try {
      // A Retina comparison PNG exceeds the 1 MiB execFileSync default.
      const evidence = Buffer.alloc(1_300_000);
      for (let index = 0; index < evidence.length; index += 1) {
        evidence[index] = (index * 7919) & 0xff;
      }
      await fs.mkdir(path.join(repository, "vnext/evidence"), {
        recursive: true,
      });
      const target = path.join(repository, "vnext/evidence/overview.bin");
      await fs.writeFile(target, evidence);
      git(repository, "init", "-q");
      git(repository, "add", "vnext");
      git(
        repository,
        "-c",
        "user.name=Farol Next Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "large evidence",
      );

      expect(sourceIdentity(repository, "vnext").dirty).toBe(false);

      evidence[evidence.length - 1] ^= 0xff;
      await fs.writeFile(target, evidence);
      expect(sourceIdentity(repository, "vnext").dirty).toBe(true);
    } finally {
      await fs.rm(repository, { recursive: true, force: true });
    }
  });
});
