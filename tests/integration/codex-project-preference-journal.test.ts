import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PrivateCodexHandoffJournal } from "../../src/modules/chat/infra/repo/private-codex-handoff-journal";
const key = "019b0000-0000-4000-8000-000000000017";
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
  vi.restoreAllMocks();
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
  const entries = await fs.readdir(f.root);
  expect(entries).toHaveLength(2);
  expect(entries).toContain(path.basename(f.file));
  expect(
    entries.some((name) => name.startsWith("project-preference-selections-")),
  ).toBe(true);
});
it("concurrent conflicting writers have one immutable winner", async () => {
  const f = await fixture();
  const other = { ...record, projectId: "other" };
  const outcomes = await Promise.allSettled([
    f.journal.rememberProjectPreference(key, record),
    new PrivateCodexHandoffJournal(f.root).rememberProjectPreference(
      key,
      other,
    ),
  ]);
  const values = outcomes.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  expect(values.length).toBeGreaterThan(0);
  const winner = await f.journal.readProjectPreference(key);
  expect([record, other]).toContainEqual(winner);
  for (const value of values) expect(value).toEqual(winner);
  expect(await f.journal.readLatestProjectPreference(record.project)).toEqual({
    key,
    record: winner,
  });
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

const nextKey = "019b0000-0000-4000-8000-000000000018";
it("latest lookup is root-bound, durable, and does not promote a replayed old handle", async () => {
  const f = await fixture();
  expect(
    await f.journal.readLatestProjectPreference(record.project),
  ).toBeNull();
  await f.journal.rememberProjectPreference(key, record);
  await f.journal.rememberProjectPreference(nextKey, {
    ...record,
    projectId: "next",
  });
  await f.journal.rememberProjectPreference(key, record);
  const restarted = new PrivateCodexHandoffJournal(f.root);
  expect(await restarted.readLatestProjectPreference(record.project)).toEqual({
    key: nextKey,
    record: { ...record, projectId: "next" },
  });
  expect(
    await restarted.readLatestProjectPreference({
      ...record.project,
      inode: "99",
    }),
  ).toBeNull();
  expect(await restarted.readProjectPreference(key)).toEqual(record);
});
it("legacy handles remain readable without inventing a latest selection", async () => {
  const f = await fixture();
  await fs.writeFile(f.file, JSON.stringify(record), { mode: 0o600 });
  await f.journal.rememberProjectPreference(key, record);
  expect(
    await f.journal.readLatestProjectPreference(record.project),
  ).toBeNull();
  expect(await f.journal.readProjectPreference(key)).toEqual(record);
});
it.each(["missing-receipt", "foreign-root", "gap", "symlink", "invalid-slot"])(
  "latest %s refuses instead of falling back to an older record",
  async (fault) => {
    const f = await fixture();
    await f.journal.rememberProjectPreference(key, record);
    await f.journal.rememberProjectPreference(nextKey, record);
    const [directory] = (await fs.readdir(f.root)).filter((name) =>
      name.startsWith("project-preference-selections-"),
    );
    const selected = path.join(f.root, directory!);
    const slot = path.join(selected, "000002.json");
    const nextFile = path.join(f.root, `project-preference-${nextKey}.json`);
    if (fault === "missing-receipt") await fs.unlink(nextFile);
    if (fault === "foreign-root")
      await fs.writeFile(
        nextFile,
        JSON.stringify({
          ...record,
          project: { ...record.project, inode: "99" },
        }),
      );
    if (fault === "gap")
      await fs.rename(slot, path.join(selected, "000003.json"));
    if (fault === "symlink") {
      await fs.unlink(slot);
      await fs.symlink(f.file, slot);
    }
    if (fault === "invalid-slot") await fs.writeFile(slot, "null");
    await expect(
      f.journal.readLatestProjectPreference(record.project),
    ).rejects.toThrow();
    expect(await f.journal.readProjectPreference(key)).toEqual(record);
  },
);

it("dangling selection blocks a new key instead of repairing or bypassing an unknown outcome", async () => {
  const f = await fixture();
  await f.journal.rememberProjectPreference(key, record);
  const [name] = (await fs.readdir(f.root)).filter((value) =>
    value.startsWith("project-preference-selections-"),
  );
  await fs.writeFile(
    path.join(f.root, name!, "000002.json"),
    JSON.stringify({ key: nextKey }),
    { mode: 0o600 },
  );
  await expect(
    f.journal.readLatestProjectPreference(record.project),
  ).rejects.toThrow();
  await expect(
    f.journal.rememberProjectPreference(
      "019b0000-0000-4000-8000-000000000019",
      record,
    ),
  ).rejects.toThrow();
  expect(await f.journal.readProjectPreference(nextKey)).toBeNull();
  expect(await f.journal.readProjectPreference(key)).toEqual(record);
});

it("failure after selection intent never returns an older preference or auto-repairs on a new key", async () => {
  const f = await fixture();
  await f.journal.rememberProjectPreference(key, record);
  const original = fs.link.bind(fs);
  vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
    if (String(destination).endsWith(`project-preference-${nextKey}.json`))
      throw Object.assign(new Error("injected receipt publication failure"), {
        code: "EIO",
      });
    await original(source, destination);
  });
  await expect(
    f.journal.rememberProjectPreference(nextKey, record),
  ).rejects.toThrow("injected receipt publication failure");
  vi.restoreAllMocks();
  await expect(
    new PrivateCodexHandoffJournal(f.root).readLatestProjectPreference(
      record.project,
    ),
  ).rejects.toThrow();
  expect(await f.journal.readProjectPreference(nextKey)).toBeNull();
  await expect(
    f.journal.rememberProjectPreference(nextKey, record),
  ).rejects.toThrow();
  expect(await f.journal.readProjectPreference(key)).toEqual(record);
});
it.each([
  "public-directory",
  "directory-symlink",
  "duplicate-key",
  "unexpected-file",
  "too-many-slots",
])("%s selection namespace is unavailable", async (fault) => {
  const f = await fixture();
  await f.journal.rememberProjectPreference(key, record);
  const [name] = (await fs.readdir(f.root)).filter((value) =>
    value.startsWith("project-preference-selections-"),
  );
  const directory = path.join(f.root, name!);
  if (fault === "public-directory") await fs.chmod(directory, 0o755);
  if (fault === "directory-symlink") {
    const moved = directory + "-moved";
    await fs.rename(directory, moved);
    await fs.symlink(moved, directory);
  }
  if (fault === "duplicate-key")
    await fs.writeFile(
      path.join(directory, "000002.json"),
      JSON.stringify({ key }),
      { mode: 0o600 },
    );
  if (fault === "unexpected-file")
    await fs.writeFile(path.join(directory, "foreign"), "bad", { mode: 0o600 });
  if (fault === "too-many-slots")
    for (let n = 2; n <= 257; n++)
      await fs.writeFile(
        path.join(directory, `${String(n).padStart(6, "0")}.json`),
        JSON.stringify({ key }),
        { mode: 0o600 },
      );
  await expect(
    f.journal.readLatestProjectPreference(record.project),
  ).rejects.toThrow();
});
it("bounded publication log refuses the 257th selection without a receipt or silent truncation", async () => {
  const f = await fixture();
  await f.journal.rememberProjectPreference(key, record);
  const [name] = (await fs.readdir(f.root)).filter((value) =>
    value.startsWith("project-preference-selections-"),
  );
  const directory = path.join(f.root, name!);
  for (let n = 2; n <= 256; n++) {
    const id = `019b0000-0000-4000-8000-${String(1000 + n).padStart(12, "0")}`;
    await fs.writeFile(
      path.join(f.root, `project-preference-${id}.json`),
      JSON.stringify(record),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(directory, `${String(n).padStart(6, "0")}.json`),
      JSON.stringify({ key: id }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(directory, `witness-${String(n).padStart(6, "0")}.json`),
      JSON.stringify({ key: id }),
      { mode: 0o600 },
    );
  }
  await expect(
    f.journal.rememberProjectPreference(nextKey, record),
  ).rejects.toThrow("HANDOFF_PROJECT_PREFERENCE_SELECTION_LIMIT");
  expect(await f.journal.readProjectPreference(nextKey)).toBeNull();
  expect(await fs.readdir(directory)).toHaveLength(512);
});

it("a read-only latest lookup cannot create an absent journal root", async () => {
  const f = await fixture();
  const absent = path.join(f.root, "absent");
  expect(
    await new PrivateCodexHandoffJournal(absent).readLatestProjectPreference(
      record.project,
    ),
  ).toBeNull();
  await expect(fs.lstat(absent)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readdir(f.root)).toEqual([]);
});

it("review P2: lost terminal slot cannot report the preserved older receipt as latest", async () => {
  const f = await fixture();
  await f.journal.rememberProjectPreference(key, record);
  await f.journal.rememberProjectPreference(nextKey, record);
  const [name] = (await fs.readdir(f.root)).filter((value) =>
    value.startsWith("project-preference-selections-"),
  );
  await fs.unlink(path.join(f.root, name!, "000002.json"));
  expect(await f.journal.readProjectPreference(key)).toEqual(record);
  expect(await f.journal.readProjectPreference(nextKey)).toEqual(record);
  await expect(
    new PrivateCodexHandoffJournal(f.root).readLatestProjectPreference(
      record.project,
    ),
  ).rejects.toThrow();
});

it.each(["lost", "wrong-key", "symlink", "null"])(
  "selection witness %s refuses instead of dropping the tail",
  async (fault) => {
    const f = await fixture();
    await f.journal.rememberProjectPreference(key, record);
    await f.journal.rememberProjectPreference(nextKey, record);
    const [name] = (await fs.readdir(f.root)).filter((value) =>
      value.startsWith("project-preference-selections-"),
    );
    const witness = path.join(f.root, name!, "witness-000002.json");
    if (fault === "lost") await fs.unlink(witness);
    if (fault === "wrong-key")
      await fs.writeFile(witness, JSON.stringify({ key }));
    if (fault === "symlink") {
      await fs.unlink(witness);
      await fs.symlink(f.file, witness);
    }
    if (fault === "null") await fs.writeFile(witness, "null");
    await expect(
      f.journal.readLatestProjectPreference(record.project),
    ).rejects.toThrow();
  },
);
