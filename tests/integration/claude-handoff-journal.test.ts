import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { PrivateClaudeHandoffJournal } from "../../src/modules/chat/infra/repo/private-claude-handoff-journal";
const roots: string[] = [];
const key = "019b0000-0000-4000-8000-000000000020";
const record = {
  sessionId: key,
  requestDigest: "a".repeat(64),
  workspaceId: "writer",
  projectId: "project",
  workspace: {
    root: "/fixture/writer",
    device: "1",
    inode: "2",
    gitCommonDirectory: "/fixture/project/.git",
    project: {
      root: "/fixture/project",
      device: "1",
      inode: "3",
      gitCommonDirectory: "/fixture/project/.git",
    },
    execution: {
      sandbox: "read-only" as const,
      approvalPolicy: "on-request" as const,
    },
  },
  modelBinding: {
    selection: {
      harness: "claude-code",
      modelAlias: "small",
      model: "fixture-model",
    },
    configSha256: "b".repeat(64),
  },
};
const final = {
  lifecycle: "completed" as const,
  sessionId: key,
  actualModel: "fixture-model",
  exitCode: 0,
  text: "Final fixture",
};
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-claude-journal-")),
  );
  roots.push(root);
  await fs.chmod(root, 0o700);
  return {
    root,
    journal: new PrivateClaudeHandoffJournal(path.join(root, "journal")),
  };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
it("one cross-instance intent, durable terminal and case-folded UUID", async () => {
  const f = await fixture();
  const other = new PrivateClaudeHandoffJournal(path.join(f.root, "journal"));
  expect(
    await Promise.all([
      f.journal.claim(key, record),
      other.claim(key.toUpperCase(), record),
    ]),
  ).toContain(true);
  expect(await other.read(key)).toEqual(record);
  expect(await other.finish(key, final)).toEqual(final);
  expect(await f.journal.terminal(key)).toEqual(final);
  expect(
    await f.journal.finish(key, { ...final, text: "Replacement" }),
  ).toEqual(final);
});
it("missing dispatch is absence; crashed claim without record is not", async () => {
  const f = await fixture();
  expect(await f.journal.read(key)).toBeNull();
  await fs.mkdir(path.join(f.root, "journal", key), { mode: 0o700 });
  await expect(f.journal.read(key)).rejects.toThrow();
  await expect(f.journal.claim(key, record)).resolves.toBe(false);
});
it.each(["null", "unknown", "wide", "symlink", "hardlink", "fifo", "mode"])(
  "%s intent is refused, not absence or retry authority",
  async (mode) => {
    const f = await fixture();
    await f.journal.claim(key, record);
    const file = path.join(f.root, "journal", key, "intent.json");
    if (mode === "mode") await fs.chmod(file, 0o644);
    else if (mode === "null") await fs.writeFile(file, "null");
    else if (mode === "unknown")
      await fs.writeFile(file, JSON.stringify({ ...record, foreign: true }));
    else if (mode === "wide") await fs.writeFile(file, "x".repeat(20000));
    else {
      await fs.unlink(file);
      if (mode === "fifo") execFileSync("/usr/bin/mkfifo", ["-m", "600", file]);
      else {
        const outside = path.join(f.root, "outside");
        await fs.writeFile(outside, JSON.stringify(record), { mode: 0o600 });
        if (mode === "symlink") await fs.symlink(outside, file);
        else {
          await fs.link(outside, file);
        }
      }
    }
    await expect(f.journal.read(key)).rejects.toThrow();
  },
);
it("private root and dispatch modes, terminal correlation and UTF8 bound", async () => {
  const f = await fixture();
  await f.journal.claim(key, record);
  expect((await fs.stat(path.join(f.root, "journal", key))).mode & 0o777).toBe(
    0o700,
  );
  await expect(
    f.journal.finish(key, {
      ...final,
      sessionId: "019b0000-0000-4000-8000-000000000021",
    }),
  ).rejects.toThrow();
  await expect(
    f.journal.finish(key, { ...final, text: "🧭".repeat(8193) }),
  ).rejects.toThrow();
  await f.journal.finish(key, final);
  const file = path.join(f.root, "journal", key, "terminal.json");
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  await fs.writeFile(file, "null");
  await expect(f.journal.terminal(key)).rejects.toThrow();
});
it("unsafe root/entry and invalid key cannot be read or claimed", async () => {
  const f = await fixture();
  await expect(f.journal.read("../foreign")).rejects.toThrow();
  await f.journal.read(key);
  await fs.chmod(path.join(f.root, "journal"), 0o777);
  await expect(f.journal.claim(key, record)).rejects.toThrow();
});
