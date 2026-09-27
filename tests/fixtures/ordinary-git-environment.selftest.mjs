import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createOrdinaryGitEnvironment } from "./ordinary-git-environment.mjs";

/** Node reference self-test only; not a Farol sandbox/MCP acceptance claim. */
async function withFixture(run) {
  const fixture = await createOrdinaryGitEnvironment();
  try {
    await run(fixture);
    assert.equal(
      await fs.readFile(fixture.canary, "utf8"),
      fixture.expected.outside,
    );
  } finally {
    await fixture.dispose();
  }
  await assert.rejects(fs.stat(fixture.root), { code: "ENOENT" });
}

const value = (fixture, key, options) =>
  fixture.mustGit(["config", "--get", key], options).stdout.trim();

test("ordinary Git reads HOME, XDG, relative/conditional include and worktree config", async () => {
  await withFixture(async (f) => {
    assert.equal(value(f, "user.name"), f.expected.user);
    assert.equal(value(f, "farolFixture.xdg"), f.expected.xdg);
    assert.equal(value(f, "farolFixture.included"), f.expected.include);
    assert.equal(value(f, "farolFixture.conditional"), f.expected.conditional);
    assert.equal(value(f, "farolFixture.worktree"), f.expected.worktree);
    assert.equal(value(f, "farolFixture.local"), f.expected.local);
    assert.equal(
      f.runGit(["config", "--get", "farolFixture.conditional"], {
        cwd: f.repository,
      }).code,
      1,
    );
  });
});

test("a managed-location writer is an ordinary registered linked worktree", async () => {
  await withFixture(async (f) => {
    assert.ok(f.writer.includes(path.join(".codex", "worktrees")));
    assert.equal(
      f.mustGit(["rev-parse", "--show-toplevel"]).stdout.trim(),
      f.writer,
    );
    assert.notEqual(f.gitDirectory, f.commonDirectory);
    assert.equal(f.commonDirectory, path.join(f.repository, ".git"));
    assert.equal(
      f.mustGit(["symbolic-ref", "--short", "HEAD"]).stdout.trim(),
      "fixture-worker",
    );
  });
});

test("negative control detects global config suppression used by the current shell", async () => {
  await withFixture(async (f) => {
    const env = {
      ...f.environment,
      HOME: f.scratch,
      XDG_CONFIG_HOME: path.join(f.scratch, ".config"),
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    assert.equal(f.runGit(["config", "--get", "user.name"], { env }).code, 1);
    assert.equal(
      f.runGit(["config", "--get", "farolFixture.included"], { env }).code,
      1,
    );
    // Local Git still works: a simple status/HEAD PASS would miss this mismatch.
    assert.equal(f.runGit(["rev-parse", "HEAD"], { env }).code, 0);
    assert.equal(value(f, "farolFixture.local", { env }), f.expected.local);
  });
});

test("path-scoped commit leaves a foreign staged file untouched and uses the real hook", async () => {
  await withFixture(async (f) => {
    const foreign = path.join(f.writer, "foreign.txt");
    await fs.writeFile(foreign, "foreign staged change\n");
    await fs.writeFile(path.join(f.writer, "owned.txt"), "own change\n");
    f.mustGit(["add", "--", "foreign.txt", "owned.txt"]);
    const committed = f.mustGit([
      "commit",
      "--only",
      "-m",
      "test: own change",
      "--",
      "owned.txt",
    ]);
    assert.match(committed.stderr, /fixture-hook-ran/);
    assert.equal(
      f
        .mustGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
        .stdout.trim(),
      "owned.txt",
    );
    assert.equal(
      f.mustGit(["diff", "--cached", "--name-only"]).stdout.trim(),
      "foreign.txt",
    );
    assert.equal(await fs.readFile(foreign, "utf8"), "foreign staged change\n");
    assert.equal(
      f.mustGit(["log", "-1", "--format=%an <%ae>"]).stdout.trim(),
      `${f.expected.user} <${f.expected.email}>`,
    );
  });
});

test("unstage changes only the index, not file bytes", async () => {
  await withFixture(async (f) => {
    const target = path.join(f.writer, "owned.txt");
    const bytes = Buffer.from("own modified bytes\r\nПривет\n", "utf8");
    await fs.writeFile(target, bytes);
    f.mustGit(["add", "--", "owned.txt"]);
    f.mustGit(["restore", "--staged", "--", "owned.txt"]);
    assert.deepEqual(await fs.readFile(target), bytes);
    assert.equal(f.mustGit(["diff", "--cached", "--name-only"]).stdout, "");
    assert.equal(f.mustGit(["diff", "--name-only"]).stdout.trim(), "owned.txt");
  });
});

test("configured failing hook prevents a commit without claiming success", async () => {
  await withFixture(async (f) => {
    const before = f.mustGit(["rev-parse", "HEAD"]).stdout;
    await fs.writeFile(path.join(f.writer, "owned.txt"), "must not commit\n");
    await fs.writeFile(path.join(f.writer, ".fixture-reject"), "reject\n");
    f.mustGit(["add", "--", "owned.txt"]);
    const refused = f.runGit(["commit", "-m", "test: must fail"]);
    assert.notEqual(refused.code, 0);
    assert.equal(refused.signal, null);
    assert.match(refused.stderr, /fixture-hook-refused/);
    assert.equal(f.mustGit(["rev-parse", "HEAD"]).stdout, before);
    assert.equal(
      f.mustGit(["diff", "--cached", "--name-only"]).stdout.trim(),
      "owned.txt",
    );
  });
});
