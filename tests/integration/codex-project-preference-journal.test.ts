import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PrivateCodexHandoffJournal } from "../../src/modules/chat/infra/repo/private-codex-handoff-journal";
const key = "a6c11016-b7b7-4d32-a5ec-8bd1e57ee521";
const record = {
  projectId: "saved",
  project: {
    root: "/fixture/project",
    device: "1",
    inode: "10",
    gitCommonDirectory: "/fixture/project/.git",
  },
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-project-preference-"),
  );
  roots.push(root);
  await fs.chmod(root, 0o700);
  return {
    root,
    journal: new PrivateCodexHandoffJournal(root),
    file: path.join(root, `project-preference-${key}.json`),
  };
}
it("private receipt survives a new journal instance without storing writer/task identity", async () => {
  const f = await fixture();
  expect(await f.journal.rememberProjectPreference(key, record)).toEqual(
    record,
  );
  expect(
    await new PrivateCodexHandoffJournal(f.root).readProjectPreference(key),
  ).toEqual(record);
  const info = await fs.stat(f.file);
  expect(info.mode & 0o777).toBe(0o600);
  expect(info.nlink).toBe(1);
  expect(await fs.readdir(f.root)).toEqual([path.basename(f.file)]);
});
it("concurrent conflicting writers have one immutable winner", async () => {
  const f = await fixture();
  const other = { ...record, projectId: "other" };
  const values = await Promise.all([
    f.journal.rememberProjectPreference(key, record),
    new PrivateCodexHandoffJournal(f.root).rememberProjectPreference(
      key,
      other,
    ),
  ]);
  expect(values[0]).toEqual(values[1]);
  expect([record, other]).toContainEqual(values[0]);
  expect(await f.journal.readProjectPreference(key)).toEqual(values[0]);
});
it("key casing addresses the same receipt and never replaces bytes", async () => {
  const f = await fixture();
  await f.journal.rememberProjectPreference(key, record);
  const before = await fs.readFile(f.file, "utf8");
  expect(
    await f.journal.rememberProjectPreference(key.toUpperCase(), {
      ...record,
      projectId: "other",
    }),
  ).toEqual(record);
  expect(await fs.readFile(f.file, "utf8")).toBe(before);
});
it.each([
  "null",
  "malformed",
  "extra",
  "public",
  "symlink",
  "hardlink",
  "oversize",
])("rejects %s receipt instead of treating it as missing", async (mode) => {
  const f = await fixture();
  if (mode === "symlink") {
    const outside = path.join(f.root, "outside.json");
    await fs.writeFile(outside, JSON.stringify(record), { mode: 0o600 });
    await fs.symlink(outside, f.file);
  } else {
    await fs.writeFile(
      f.file,
      mode === "null"
        ? "null"
        : mode === "malformed"
          ? "{"
          : mode === "extra"
            ? JSON.stringify({ ...record, preview: "private" })
            : mode === "oversize"
              ? " ".repeat(5000)
              : JSON.stringify(record),
      { mode: mode === "public" ? 0o644 : 0o600 },
    );
    if (mode === "hardlink")
      await fs.link(f.file, path.join(f.root, "foreign-link"));
  }
  await expect(f.journal.readProjectPreference(key)).rejects.toThrow();
  await expect(
    f.journal.rememberProjectPreference(key, record),
  ).rejects.toThrow();
});
it("invalid keys never escape the preference namespace", async () => {
  const f = await fixture();
  await expect(f.journal.readProjectPreference("../outside")).rejects.toThrow();
  expect(await fs.readdir(f.root)).toEqual([]);
});
it("oversized multibyte canonical record is rejected before publication", async () => {
  const f = await fixture();
  const huge = {
    ...record,
    project: { ...record.project, root: "/" + "🧭".repeat(1020) },
  };
  await expect(f.journal.rememberProjectPreference(key, huge)).rejects.toThrow(
    "HANDOFF_PROJECT_PREFERENCE_TOO_LARGE",
  );
  expect(await fs.readdir(f.root)).toEqual([]);
});

it("FIFO receipt refuses without waiting for a writer or holding the request", async () => {
  const f = await fixture();
  await promisify(execFile)("/usr/bin/mkfifo", ["-m", "600", f.file]);
  let writer;
  const read = f.journal.readProjectPreference(key).then(
    () => "unexpected-success",
    () => "rejected",
  );
  const settled = await Promise.race([
    read,
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 200)),
  ]);
  try {
    if (settled === "waiting") {
      writer = await fs.open(f.file, constants.O_RDWR | constants.O_NONBLOCK);
      await read;
    }
    expect(settled).toBe("rejected");
  } finally {
    await writer?.close();
  }
});
