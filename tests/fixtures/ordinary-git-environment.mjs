import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Disposable reference environment for the ordinary-Git Computer acceptance.
 * This is test setup, NOT a Farol execution adapter or an authority grant.
 * It never reads the actual owner's HOME, Git config, auth or repositories.
 */
export async function createOrdinaryGitEnvironment({
  parent = os.tmpdir(),
  managedWriter = true,
} = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(parent, "farol-git-environment-")),
  );
  const identity = await fs.lstat(root);
  const home = path.join(root, "home");
  const repository = path.join(home, "code", "fixture");
  const writer = managedWriter
    ? path.join(home, ".codex", "worktrees", "fixture", "repo")
    : path.join(home, "code", "linked");
  const scratch = path.join(root, "scratch");
  const deniedRoot = path.join(root, "outside-approval");
  const canary = path.join(deniedRoot, "canary.txt");
  const hooks = path.join(home, ".config", "git", "hooks");
  const includes = path.join(home, ".config", "git", "includes");
  const templates = path.join(root, "empty-templates");
  const git = "/usr/bin/git";
  const expected = Object.freeze({
    user: "Farol Fixture Author",
    email: "farol-fixture@example.invalid",
    xdg: "xdg-config-read",
    include: "relative-include-read",
    conditional: "linked-worktree-include-read",
    worktree: "only-this-worktree",
    local: "repository-config-read",
    outside: "outside-approval-unchanged\n",
  });

  // Intentionally fixture-only, not a recommended production environment.
  // The global settings below are real files in our synthetic HOME. Only the
  // machine-wide configuration/templates are suppressed to avoid host coupling.
  const environment = Object.freeze({
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    TMPDIR: scratch,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TEMPLATE_DIR: templates,
    GIT_TERMINAL_PROMPT: "0",
  });

  let executionUnconfirmed = false;
  function runGit(args, { cwd = writer, env = environment } = {}) {
    if (
      !Array.isArray(args) ||
      args.some((value) => typeof value !== "string")
    ) {
      throw new TypeError("Expected a Git argv array");
    }
    const relative = path.relative(root, cwd);
    if (
      relative === ".." ||
      relative.startsWith("../") ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Fixture Git cwd must stay inside its owned root");
    }
    const result = spawnSync(git, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.signal !== null) {
      executionUnconfirmed = true;
      throw (
        result.error ?? new Error("Fixture Git terminal cleanup unconfirmed")
      );
    }
    return {
      code: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  function mustGit(args, options) {
    const result = runGit(args, options);
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(`Fixture Git failed (${result.code}): ${result.stderr}`);
    }
    return result;
  }

  let disposed = false;
  async function dispose() {
    if (disposed) return;
    if (executionUnconfirmed)
      throw new Error(
        "Fixture Git execution unconfirmed; preserve original root",
      );
    const current = await fs.lstat(root);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) {
      throw new Error("Fixture root identity changed; preserve for inspection");
    }
    // All Git metadata, worktree registrations and files belong to this root.
    // No real repository has a registration pointing to this disposable fixture.
    await fs.rm(root, { recursive: true, force: false });
    disposed = true;
  }

  try {
    for (const directory of [
      repository,
      path.dirname(writer),
      scratch,
      deniedRoot,
      hooks,
      includes,
      templates,
    ]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    }
    await fs.writeFile(canary, expected.outside, { mode: 0o600 });
    await fs.writeFile(
      path.join(includes, "common.inc"),
      `[farolFixture]\n  included = ${expected.include}\n`,
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(includes, "worktree.inc"),
      `[farolFixture]\n  conditional = ${expected.conditional}\n`,
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(home, ".config", "git", "config"),
      [
        "[farolFixture]",
        `  xdg = ${expected.xdg}`,
        "[commit]",
        "  gpgSign = false",
        "[core]",
        `  hooksPath = ${JSON.stringify(hooks)}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(home, ".gitconfig"),
      [
        "[user]",
        `  name = ${expected.user}`,
        `  email = ${expected.email}`,
        "[include]",
        "  path = .config/git/includes/common.inc",
        `[includeIf ${JSON.stringify(`gitdir:${repository}/.git/worktrees/`)}]`,
        "  path = .config/git/includes/worktree.inc",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(hooks, "pre-commit"),
      [
        "#!/bin/sh",
        "set -eu",
        "if test -f .fixture-reject; then",
        "  printf 'fixture-hook-refused\\n' >&2",
        "  exit 9",
        "fi",
        "printf 'fixture-hook-ran\\n' >&2",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    mustGit(["init", "-b", "main"], { cwd: repository });
    mustGit(["config", "user.useConfigOnly", "true"], { cwd: repository });
    mustGit(["config", "farolFixture.local", expected.local], {
      cwd: repository,
    });
    mustGit(["config", "extensions.worktreeConfig", "true"], {
      cwd: repository,
    });
    await fs.writeFile(
      path.join(repository, "foreign.txt"),
      "foreign baseline\n",
    );
    await fs.writeFile(path.join(repository, "owned.txt"), "owned baseline\n");
    mustGit(["add", "--", "foreign.txt", "owned.txt"], { cwd: repository });
    mustGit(["commit", "-m", "test: create fixture baseline"], {
      cwd: repository,
    });
    mustGit(["worktree", "add", "-b", "fixture-worker", writer], {
      cwd: repository,
    });
    mustGit([
      "config",
      "--worktree",
      "farolFixture.worktree",
      expected.worktree,
    ]);
    const gitDirectory = mustGit([
      "rev-parse",
      "--absolute-git-dir",
    ]).stdout.trim();
    const commonDirectory = path.resolve(
      writer,
      mustGit(["rev-parse", "--git-common-dir"]).stdout.trim(),
    );

    return Object.freeze({
      root,
      home,
      repository,
      writer,
      scratch,
      canary,
      gitDirectory,
      commonDirectory,
      environment,
      expected,
      runGit,
      mustGit,
      dispose,
    });
  } catch (error) {
    if (!executionUnconfirmed) await dispose();
    throw error;
  }
}
