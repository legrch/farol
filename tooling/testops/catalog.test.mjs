import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { decodeYaml, taskCatalog } from "./catalog.mjs";
const plain = (v) => JSON.parse(JSON.stringify(v));

test("YAML aliases merge with explicit override and preserve multiline commands", async () => {
  const data = plain(
    await decodeYaml(
      "base: &base\n  cmds: [first]\n  silent: true\ncopy:\n  <<: *base\n  cmds:\n    - |\n      line1\n      line2\n",
    ),
  );
  assert.deepEqual(data.copy, { cmds: ["line1\nline2\n"], silent: true });
});
test("YAML merge-list priority is earliest mapping then explicit values", async () => {
  const data = plain(
    await decodeYaml(
      "a: &a {x: first, a: A}\nb: &b {x: second, b: B}\nc: {<<: [*a, *b], b: own}\n",
    ),
  );
  assert.deepEqual(data.c, { x: "first", a: "A", b: "own" });
});
test("folded scalars and quoted escapes preserve actual command bytes", async () => {
  assert.deepEqual(
    plain(await decodeYaml('a: >-\n  first\n  second\nb: "one\\ntwo"\n')),
    { a: "first second", b: "one\ntwo" },
  );
});
test("ambiguous documents, duplicate keys, tags and prototype keys refuse", async () => {
  for (const yaml of [
    "a: 1\na: 2\n",
    "a: 1\n---\nb: 2\n",
    "a: !custom thing\n",
    "__proto__: {x: y}\n",
  ])
    await assert.rejects(decodeYaml(yaml));
});

async function fixture(files, run) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "testops-task-data-")),
  );
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      {
        cwd: root,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
        },
        stdio: "pipe",
      },
    );
  try {
    for (const [name, value] of Object.entries(files)) {
      const p = path.join(root, name);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, value);
    }
    git("init", "-q");
    git("add", ".");
    git("commit", "--no-gpg-sign", "-qm", "fixture");
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
test("flattened aliases, ordered calls, parallel deps and deferred calls are distinct", async () => {
  await fixture(
    {
      "Taskfile.yml":
        'version: "3"\nincludes:\n  testing: {taskfile: tasks/test.yml, flatten: true}\ntasks:\n  ci:\n    deps: [setup]\n    cmds:\n      - task: old-test\n      - defer: {task: teardown}\n  setup: {cmds: [echo setup]}\n  teardown: {cmds: [echo teardown]}\n',
      "tasks/test.yml":
        'version: "3"\ntasks:\n  test:\n    aliases: [old-test]\n    cmds: [echo test]\n',
      "package.json":
        '{"scripts":{"ci":"npm run test","test":"node test.mjs"}}',
    },
    async (root) => {
      const d = await taskCatalog(root);
      assert.equal(d.tasks.length, 4);
      assert.equal(d.aliases["old-test"], "test");
      assert.deepEqual(
        d.edges.map((e) => [e.kind, e.resolved]),
        [
          ["parallel-dependency", "setup"],
          ["ordered-command", "test"],
          ["deferred-task", "teardown"],
        ],
      );
      assert.equal(d.npmScripts.length, 2);
      assert.equal(d.executionAllowed, false);
      assert.deepEqual(d.gaps, []);
    },
  );
});
test("untracked optional includes and templated targets remain visible gaps", async () => {
  await fixture(
    {
      "Taskfile.yml":
        'version: "3"\nincludes:\n  private: {taskfile: private.yml, optional: true}\ntasks:\n  test:\n    cmds:\n      - task: "{{.NEXT}}"\n',
    },
    async (root) => {
      await fs.writeFile(path.join(root, "private.yml"), "unapproved input");
      const d = await taskCatalog(root);
      assert.deepEqual(
        d.gaps.map((e) => e.kind),
        ["OPTIONAL_UNTRACKED_INCLUDE", "TASK_TARGET_UNRESOLVED"],
      );
      assert.equal(d.sources["private.yml"], undefined);
    },
  );
});
test("a namespace default resolves without inventing a declared task alias", async () => {
  await fixture(
    {
      "Taskfile.yml":
        'version: "3"\nincludes: {utils: utils.yml}\ntasks:\n  all:\n    cmds: [{task: utils}]\n',
      "utils.yml": 'version: "3"\ntasks:\n  default: {cmds: [echo default]}\n',
    },
    async (root) => {
      const d = await taskCatalog(root);
      assert.deepEqual(d.aliases, {});
      assert.deepEqual(d.implicitAliases, { utils: "utils:default" });
      assert.equal(d.edges[0].resolved, "utils:default");
      assert.deepEqual(d.gaps, []);
    },
  );
});
test("include cycles and alias collisions fail closed", async () => {
  for (const files of [
    { "Taskfile.yml": 'version: "3"\nincludes: {again: Taskfile.yml}\n' },
    {
      "Taskfile.yml":
        'version: "3"\ntasks:\n  a: {aliases: [b], cmds: [echo a]}\n  b: {cmds: [echo b]}\n',
    },
  ])
    await fixture(files, async (root) => assert.rejects(taskCatalog(root)));
});
test("source redirects are refused before reading included bytes", async () => {
  await fixture(
    {
      "Taskfile.yml": 'version: "3"\nincludes: {other: other.yml}\n',
      "other.yml": 'version: "3"\ntasks: {}\n',
    },
    async (root) => {
      await fs.unlink(path.join(root, "other.yml"));
      await fs.symlink("/etc/passwd", path.join(root, "other.yml"));
      await assert.rejects(taskCatalog(root), /SOURCE_REDIRECT_REFUSED/);
    },
  );
});
