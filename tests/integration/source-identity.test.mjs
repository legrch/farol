import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sourceIdentity } from "../../tooling/source-identity.mjs";

const gitEnvironment = await fs.mkdtemp(
  path.join(os.tmpdir(), "farol-fixture-git-env-"),
);
const gitHome = path.join(gitEnvironment, "home");
const gitTemporary = path.join(gitEnvironment, "tmp");
await fs.mkdir(gitHome);
await fs.mkdir(gitTemporary);
afterAll(() => fs.rm(gitEnvironment, { recursive: true, force: true }));

function git(repository, ...arguments_) {
  return execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "init.templateDir=",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-C",
      repository,
      ...arguments_,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: gitHome,
        TMPDIR: gitTemporary,
        LC_ALL: "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  ).trim();
}

async function repositoryWithOneFile(body = "export {};\n") {
  const repository = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-source-identity-"),
  );
  await fs.mkdir(path.join(repository, "nested"), { recursive: true });
  await fs.writeFile(path.join(repository, "main.ts"), body);
  await fs.writeFile(path.join(repository, "nested/deep.ts"), body);
  git(repository, "init", "-q");
  git(repository, "add", ".");
  git(
    repository,
    "-c",
    "user.email=a@b.c",
    "-c",
    "user.name=T",
    "commit",
    "-q",
    "-m",
    "init",
  );
  return repository;
}

describe("source identity distinguishes a difference from a failure", () => {
  it("keeps caller repository, index, configuration and hooks outside fixture setup", async () => {
    const lab = await fs.mkdtemp(path.join(os.tmpdir(), "farol-fixture-env-"));
    const victim = path.join(lab, "victim");
    await fs.mkdir(victim);
    const seed = (...args) =>
      execFileSync(
        "/usr/bin/git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "init.templateDir=",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "user.name=Victim Fixture",
          "-c",
          "user.email=victim@example.invalid",
          "-C",
          victim,
          ...args,
        ],
        {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: lab,
            TMPDIR: lab,
            LC_ALL: "C",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_OPTIONAL_LOCKS: "0",
          },
        },
      );
    const seal = async () => {
      const result = [];
      const walk = async (directory) => {
        for (const entry of await fs.readdir(directory, {
          withFileTypes: true,
        })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await walk(file);
          else
            result.push([
              path.relative(victim, file),
              createHash("sha256")
                .update(await fs.readFile(file))
                .digest("hex"),
            ]);
        }
      };
      await walk(victim);
      return result.sort(([a], [b]) => a.localeCompare(b));
    };
    const previous = new Map(
      Object.entries(process.env).filter(
        ([key]) =>
          key.startsWith("GIT_") || ["PATH", "HOME", "TMPDIR"].includes(key),
      ),
    );
    let fixture;
    try {
      seed("init", "-q");
      await fs.writeFile(path.join(victim, "tracked.txt"), "original\n");
      seed("add", ".");
      seed("commit", "-qm", "fixture baseline");
      await fs.writeFile(
        path.join(victim, "tracked.txt"),
        "preserve unstaged\n",
      );
      await fs.writeFile(path.join(victim, "staged.txt"), "preserve staged\n");
      seed("add", "staged.txt");
      await fs.writeFile(
        path.join(victim, "untracked.txt"),
        "preserve untracked\n",
      );
      const before = await seal();
      const hooks = path.join(lab, "hooks");
      await fs.mkdir(hooks);
      const marker = path.join(hooks, "pre-commit.executed");
      await fs.writeFile(
        path.join(hooks, "pre-commit"),
        '#!/bin/sh\nprintf ran > "$0.executed"\nexit 0\n',
        { mode: 0o700 },
      );
      for (const key of Object.keys(process.env))
        if (key.startsWith("GIT_")) delete process.env[key];
      Object.assign(process.env, {
        PATH: "/usr/bin:/bin",
        HOME: lab,
        TMPDIR: lab,
        GIT_DIR: path.join(victim, ".git"),
        GIT_WORK_TREE: victim,
        GIT_COMMON_DIR: path.join(victim, ".git"),
        GIT_INDEX_FILE: path.join(victim, ".git/index"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: hooks,
      });
      fixture = await repositoryWithOneFile();
      expect(await seal()).toEqual(before);
      expect(git(fixture, "rev-parse", "--show-toplevel")).toBe(
        await fs.realpath(fixture),
      );
      await expect(fs.access(marker)).rejects.toThrow();
    } finally {
      for (const key of Object.keys(process.env))
        if (key.startsWith("GIT_") || ["PATH", "HOME", "TMPDIR"].includes(key))
          delete process.env[key];
      for (const [key, value] of previous) process.env[key] = value;
      if (fixture) await fs.rm(fixture, { recursive: true, force: true });
      await fs.rm(lab, { recursive: true, force: true });
    }
  });
  // The defect: six separate conditions all collapsed into one unnamed
  // `exact = false`, so a clean `git status` with `dirty: true` gave the
  // caller nothing to act on -- and a read that FAILED was folded into the
  // same answer as a file that genuinely differed.
  it("names the file when one genuinely differs, instead of only saying dirty", async () => {
    const repository = await repositoryWithOneFile();
    try {
      await fs.writeFile(path.join(repository, "main.ts"), "export {}; //\n");
      const identity = sourceIdentity(repository);
      expect(identity.dirty).toBe(true);
      expect(identity.reasons).toContainEqual(
        expect.objectContaining({ kind: "content", path: "main.ts" }),
      );
    } finally {
      await fs.rm(repository, { recursive: true, force: true });
    }
  });

  it("refuses with the file named when a tracked file cannot be read, rather than calling it dirty", async () => {
    const repository = await repositoryWithOneFile();
    const unreadable = path.join(repository, "nested");
    try {
      await fs.chmod(unreadable, 0o000);
      let thrown = null;
      try {
        sourceIdentity(repository);
      } catch (error) {
        thrown = error;
      }
      expect(
        thrown,
        "an unreadable tracked file must refuse, not return",
      ).not.toBe(null);
      expect(thrown.message).toContain("SOURCE_IDENTITY_UNREADABLE");
      expect(thrown.message).toContain("nested/deep.ts");
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
      path.join(os.tmpdir(), "farol-source-identity-"),
    );
    try {
      // The fixture itself is the standalone repository root.
      await fs.writeFile(path.join(repository, ".gitignore"), ".DS_Store\n");
      await fs.writeFile(
        path.join(repository, "AGENTS.md"),
        "tracked portable instructions\n",
      );
      await fs.writeFile(path.join(repository, "main.ts"), "export {};\n");
      git(repository, "init", "-q");
      git(repository, "add", ".");
      git(
        repository,
        "-c",
        "user.name=Farol Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "initial",
      );

      const initial = sourceIdentity(repository, ".");
      await fs.writeFile(path.join(repository, ".DS_Store"), "host-a");
      const withIgnoredNoise = sourceIdentity(repository, ".");

      expect(withIgnoredNoise).toEqual(initial);
      expect(initial.dirty).toBe(false);

      await fs.writeFile(
        path.join(repository, "AGENTS.md"),
        "changed portable instructions\n",
      );
      expect(sourceIdentity(repository, ".")).toMatchObject({
        commit: initial.commit,
        treeDigest: initial.treeDigest,
        dirty: true,
      });
      git(repository, "restore", "AGENTS.md");

      await fs.writeFile(
        path.join(repository, "main.ts"),
        "export const changed = true;\n",
      );
      expect(sourceIdentity(repository, ".")).toMatchObject({
        commit: initial.commit,
        treeDigest: initial.treeDigest,
        dirty: true,
      });

      git(repository, "add", "main.ts");
      git(
        repository,
        "-c",
        "user.name=Farol Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "change",
      );
      const changed = sourceIdentity(repository, ".");
      expect(changed.dirty).toBe(false);
      expect(changed.commit).not.toBe(initial.commit);
      expect(changed.treeDigest).not.toBe(initial.treeDigest);

      git(repository, "update-index", "--assume-unchanged", "main.ts");
      await fs.writeFile(
        path.join(repository, "main.ts"),
        "export const hidden = true;\n",
      );
      expect(sourceIdentity(repository, ".").dirty).toBe(true);
      git(repository, "update-index", "--no-assume-unchanged", "main.ts");
      git(repository, "restore", "main.ts");

      git(repository, "update-index", "--skip-worktree", "main.ts");
      await fs.writeFile(
        path.join(repository, "main.ts"),
        "export const skipped = true;\n",
      );
      expect(sourceIdentity(repository, ".").dirty).toBe(true);
      git(repository, "update-index", "--no-skip-worktree", "main.ts");
      git(repository, "restore", "main.ts");

      await fs.symlink("../../outside.ts", path.join(repository, "link.ts"));
      git(repository, "add", "link.ts");
      git(
        repository,
        "-c",
        "user.name=Farol Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "tracked symlink",
      );
      expect(sourceIdentity(repository, ".").dirty).toBe(true);
    } finally {
      await fs.rm(repository, { recursive: true, force: true });
    }
  }, 15_000);

  it("compares tracked files larger than Node's default spawn buffer", async () => {
    const repository = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-source-identity-large-"),
    );
    try {
      // A Retina comparison PNG exceeds the 1 MiB execFileSync default.
      const evidence = Buffer.alloc(1_300_000);
      for (let index = 0; index < evidence.length; index += 1) {
        evidence[index] = (index * 7919) & 0xff;
      }
      await fs.mkdir(path.join(repository, "evidence"), {
        recursive: true,
      });
      const target = path.join(repository, "evidence/overview.bin");
      await fs.writeFile(target, evidence);
      git(repository, "init", "-q");
      git(repository, "add", ".");
      git(
        repository,
        "-c",
        "user.name=Farol Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "large evidence",
      );

      expect(sourceIdentity(repository, ".").dirty).toBe(false);

      evidence[evidence.length - 1] ^= 0xff;
      await fs.writeFile(target, evidence);
      expect(sourceIdentity(repository, ".").dirty).toBe(true);
    } finally {
      await fs.rm(repository, { recursive: true, force: true });
    }
  });
});
