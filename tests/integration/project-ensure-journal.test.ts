import fs from "node:fs/promises";
import { constants } from "node:fs";
import { build } from "esbuild";
import { promisify } from "node:util";
import { ensureCodexProject } from "../../src/modules/chat/app/service/ensure-codex-project";
import type { ProjectEnsureContext } from "../../src/modules/chat/app/port/codex-project-ensure";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { PrivateProjectEnsureJournal } from "../../src/modules/chat/infra/repo/private-project-ensure-journal";
const roots: string[] = [];
const key = "019b0000-0000-4000-8000-000000000030";
const otherKey = "019b0000-0000-4000-8000-000000000031";
const project = {
  root: "/fixture/canonical",
  device: "1",
  inode: "3",
  gitCommonDirectory: "/fixture/canonical/.git",
};
const pending = { key, name: "Project", project, acknowledgedProjectId: null };
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-project-ensure-journal-")),
  );
  roots.push(root);
  const journalRoot = path.join(root, "journal");
  await fs.mkdir(journalRoot, { mode: 0o700 });
  return {
    root,
    journalRoot,
    journal: new PrivateProjectEnsureJournal(journalRoot),
    other: new PrivateProjectEnsureJournal(journalRoot),
  };
}
async function entry(f: Awaited<ReturnType<typeof fixture>>) {
  const entries = await fs.readdir(f.journalRoot);
  expect(entries).toHaveLength(1);
  return path.join(f.journalRoot, entries[0]!);
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
it("absent project is null; claim survives a new reader and confirms once", async () => {
  const f = await fixture();
  expect(await f.journal.read(project)).toBeNull();
  expect(await f.journal.claim(pending)).toBe(true);
  expect(await f.other.read(project)).toEqual(pending);
  expect(await f.other.claim({ ...pending, key: otherKey })).toBe(false);
  await f.other.confirm(project, key, "saved");
  expect(
    await new PrivateProjectEnsureJournal(f.journalRoot).read(project),
  ).toEqual({ ...pending, acknowledgedProjectId: "saved" });
  await expect(
    f.journal.confirm(project, key, "saved"),
  ).resolves.toBeUndefined();
  await expect(f.journal.confirm(project, key, "other")).rejects.toThrow();
  await expect(f.journal.confirm(project, otherKey, "saved")).rejects.toThrow();
});
it("concurrent different keys share one no-replace physical reservation", async () => {
  const f = await fixture();
  const result = await Promise.all([
    f.journal.claim(pending),
    f.other.claim({ ...pending, key: otherKey }),
  ]);
  expect(result.filter(Boolean)).toHaveLength(1);
  const value = await f.journal.read(project);
  expect([key, otherKey]).toContain((value as typeof pending).key);
});
it("same physical identity under a changed path cannot obtain another bucket", async () => {
  const f = await fixture();
  await f.journal.claim(pending);
  const moved = {
    ...project,
    root: "/fixture/moved",
    gitCommonDirectory: "/fixture/moved/.git",
  };
  await expect(f.other.read(moved)).rejects.toThrow();
  expect(
    await f.other.claim({ ...pending, key: otherKey, project: moved }),
  ).toBe(false);
  expect(await fs.readdir(f.journalRoot)).toHaveLength(1);
});
it("different physical repositories get separate reservations", async () => {
  const f = await fixture();
  await f.journal.claim(pending);
  const next = { ...project, inode: "4" };
  expect(
    await f.journal.claim({ ...pending, key: otherKey, project: next }),
  ).toBe(true);
  expect(await f.other.read(project)).toEqual(pending);
  expect(await f.other.read(next)).toEqual({
    ...pending,
    key: otherKey,
    project: next,
  });
});
it("empty crash reservation never becomes absence or a retry", async () => {
  const f = await fixture();
  await f.journal.claim(pending);
  const dir = await entry(f);
  await fs.unlink(path.join(dir, "intent.json"));
  await expect(f.other.read(project)).rejects.toThrow();
  expect(await f.other.claim({ ...pending, key: otherKey })).toBe(false);
  expect((await fs.stat(dir)).isDirectory()).toBe(true);
});
it.each([
  "partial",
  "null",
  "extra",
  "oversize",
  "utf8",
  "foreign-project",
  "ack-in-intent",
  "symlink",
  "hardlink",
  "fifo",
  "mode",
])("%s intent is refused and preserved", async (kind) => {
  const f = await fixture();
  await f.journal.claim(pending);
  const dir = await entry(f),
    file = path.join(dir, "intent.json");
  if (kind === "mode") await fs.chmod(file, 0o644);
  else if (kind === "partial") await fs.writeFile(file, "{");
  else if (kind === "null") await fs.writeFile(file, "null");
  else if (kind === "extra")
    await fs.writeFile(file, JSON.stringify({ ...pending, extra: true }));
  else if (kind === "oversize") await fs.writeFile(file, "x".repeat(20000));
  else if (kind === "utf8") await fs.writeFile(file, Buffer.from([0xff]));
  else if (kind === "foreign-project")
    await fs.writeFile(
      file,
      JSON.stringify({ ...pending, project: { ...project, root: "/foreign" } }),
    );
  else if (kind === "ack-in-intent")
    await fs.writeFile(
      file,
      JSON.stringify({ ...pending, acknowledgedProjectId: "saved" }),
    );
  else {
    await fs.unlink(file);
    if (kind === "fifo") execFileSync("/usr/bin/mkfifo", ["-m", "600", file]);
    else {
      const outside = path.join(f.root, "outside.json");
      await fs.writeFile(outside, JSON.stringify(pending), { mode: 0o600 });
      if (kind === "symlink") await fs.symlink(outside, file);
      else await fs.link(outside, file);
    }
  }
  await expect(f.other.read(project)).rejects.toThrow();
  expect(await f.other.claim({ ...pending, key: otherKey })).toBe(false);
  expect((await fs.lstat(file)).isSymbolicLink()).toBe(kind === "symlink");
});
it.each(["partial", "foreign-key", "extra", "wide-mode"])(
  "%s confirmation is unknown and never overwritten",
  async (kind) => {
    const f = await fixture();
    await f.journal.claim(pending);
    const file = path.join(await entry(f), "confirmation.json");
    const value = {
      key: kind === "foreign-key" ? otherKey : key,
      projectId: "saved",
      ...(kind === "extra" ? { extra: true } : {}),
    };
    const bytes = kind === "partial" ? "{" : JSON.stringify(value);
    await fs.writeFile(file, bytes, {
      mode: kind === "wide-mode" ? 0o644 : 0o600,
    });
    await expect(f.other.read(project)).rejects.toThrow();
    await expect(f.other.confirm(project, key, "saved")).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(bytes);
  },
);
it("missing or replaced private root is an error, not empty history", async () => {
  const f = await fixture();
  await f.journal.claim(pending);
  await fs.rename(f.journalRoot, path.join(f.root, "original"));
  await expect(f.journal.read(project)).rejects.toThrow();
  await fs.mkdir(f.journalRoot, { mode: 0o700 });
  await expect(f.journal.read(project)).rejects.toThrow();
  await expect(
    f.journal.claim({ ...pending, key: otherKey }),
  ).rejects.toThrow();
});
it.each(["symlink", "permissions"])(
  "%s journal root cannot be used",
  async (kind) => {
    const f = await fixture();
    if (kind === "permissions") await fs.chmod(f.journalRoot, 0o755);
    else {
      const original = path.join(f.root, "original");
      await fs.rename(f.journalRoot, original);
      await fs.symlink(original, f.journalRoot);
    }
    await expect(f.journal.read(project)).rejects.toThrow();
    await expect(f.journal.claim(pending)).rejects.toThrow();
  },
);
it("invalid input cannot publish or confirm a foreign record", async () => {
  const f = await fixture();
  for (const value of [
    { ...pending, key: "../escape" },
    { ...pending, name: " " },
    { ...pending, name: "🧭".repeat(51) },
    { ...pending, acknowledgedProjectId: "saved" },
    { ...pending, project: { ...project, root: "relative" } },
  ])
    await expect(f.journal.claim(value)).rejects.toThrow();
  expect(await fs.readdir(f.journalRoot)).toEqual([]);
  await expect(f.journal.confirm(project, key, "saved")).rejects.toThrow();
  await f.journal.claim(pending);
  await expect(f.journal.confirm(project, key, "bad id")).rejects.toThrow();
  expect(
    ((await f.journal.read(project)) as typeof pending).acknowledgedProjectId,
  ).toBeNull();
});

it("removing a previously measured reservation is not new-create authority", async () => {
  const f = await fixture();
  await f.journal.claim(pending);
  const dir = await entry(f);
  await fs.rm(dir, { recursive: true });
  await expect(f.journal.read(project)).rejects.toThrow();
  await expect(
    f.journal.claim({ ...pending, key: otherKey }),
  ).rejects.toThrow();
  expect(await fs.readdir(f.journalRoot)).toEqual([]);
});

it("four separate native processes reserve only one physical project across keys", async () => {
  const f = await fixture(),
    child = path.join(f.root, "claim.mjs");
  await build({
    stdin: {
      contents: `import { PrivateProjectEnsureJournal } from ${JSON.stringify(path.resolve("src/modules/chat/infra/repo/private-project-ensure-journal.ts"))};
 const [root,record]=process.argv.slice(2);const journal=new PrivateProjectEnsureJournal(root);
 console.log(JSON.stringify(await journal.claim(JSON.parse(record))));`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: child,
  });
  const outcomes = await Promise.allSettled(
    [30, 31, 32, 33].map(async (suffix) => {
      const intent = { ...pending, key: key.slice(0, -2) + String(suffix) };
      const result = await promisify(execFile)(
        process.execPath,
        [child, f.journalRoot, JSON.stringify(intent)],
        {
          timeout: 5000,
          maxBuffer: 8192,
          env: { PATH: "/usr/bin:/bin", HOME: f.root, TMPDIR: f.root },
        },
      );
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout.trim()) as boolean;
    }),
  );
  // Await every child terminal callback even when one fails, before fixture removal.
  expect(outcomes.every((result) => result.status === "fulfilled")).toBe(true);
  const results = outcomes.map((result) =>
    result.status === "fulfilled" ? result.value : false,
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await fs.readdir(f.journalRoot)).toHaveLength(1);
  expect(await f.journal.read(project)).toMatchObject({
    acknowledgedProjectId: null,
  });
}, 15000);
function failSyncOnce(
  f: Awaited<ReturnType<typeof fixture>>,
  stage: "parent" | "intent" | "confirmation",
) {
  const original = fs.open.bind(fs);
  let failed = false;
  vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
    const handle = await original(target, flags, mode);
    const selected =
      stage === "parent"
        ? String(target) === f.journalRoot
        : String(target).endsWith(stage + ".json") &&
          typeof flags === "number" &&
          (flags & constants.O_WRONLY) !== 0;
    if (selected && !failed) {
      failed = true;
      vi.spyOn(handle, "sync").mockRejectedValueOnce(
        Error("FIXTURE_FSYNC_FAILURE"),
      );
    }
    return handle;
  });
  return () => failed;
}
it.each(["parent", "intent"] as const)(
  "%s fsync failure preserves unknown reservation and cannot acknowledge a claim",
  async (stage) => {
    const f = await fixture(),
      failed = failSyncOnce(f, stage);
    await expect(f.journal.claim(pending)).rejects.toThrow(
      "FIXTURE_FSYNC_FAILURE",
    );
    expect(failed()).toBe(true);
    vi.restoreAllMocks();
    expect(await f.other.claim({ ...pending, key: otherKey })).toBe(false);
    if (stage === "parent")
      await expect(f.other.read(project)).rejects.toThrow();
    else expect(await f.other.read(project)).toEqual(pending);
  },
);
function ensureFixture(f: Awaited<ReturnType<typeof fixture>>) {
  let creates = 0,
    unknownAck = false;
  let projects: unknown[] = [];
  const context: ProjectEnsureContext = {
    authority: {
      resolve: async () => ({
        root: "/fixture/writer",
        device: "1",
        inode: "2",
        gitCommonDirectory: project.gitCommonDirectory,
        project,
        execution: { sandbox: "workspace-write", approvalPolicy: "on-request" },
      }),
    },
    journal: f.journal,
    host: {
      catalogue: {
        request: async () => ({ data: projects, nextCursor: null }),
      },
      create: async () => {
        creates++;
        const value = {
          id: "saved",
          name: "Project",
          roots: [{ path: project.root }],
        };
        projects = [value];
        if (unknownAck) throw Error("LOST_CREATE_ACK");
        return { project: value };
      },
    },
    gate: {
      run: async (preflight, effect) => {
        await preflight();
        return effect();
      },
    },
    expiresAt: 100,
    now: () => 1,
    admitted: () => true,
    projectCreateAdmitted: true,
  };
  return {
    context,
    request: {
      key,
      workspaceId: "selected",
      name: "Project",
      mode: "ensure" as const,
    },
    creates: () => creates,
    loseAck: () => {
      unknownAck = true;
    },
  };
}
it("real journal survives lost fake-provider ack without a second create on restart or another key", async () => {
  const f = await fixture(),
    run = ensureFixture(f);
  run.loseAck();
  expect((await ensureCodexProject(run.context, run.request)).status).toBe(
    "outcome_unknown",
  );
  const restart = {
    ...run.context,
    journal: new PrivateProjectEnsureJournal(f.journalRoot),
  };
  expect(
    (await ensureCodexProject(restart, { ...run.request, key: otherKey }))
      .status,
  ).toBe("outcome_unknown");
  expect(
    await ensureCodexProject(restart, {
      ...run.request,
      key: otherKey,
      mode: "inspect",
    }),
  ).toMatchObject({
    status: "outcome_unknown",
    observedProjectId: "saved",
    controlGranted: false,
  });
  expect(run.creates()).toBe(1);
});
it("confirmation fsync failure never becomes creation PASS; recovered acknowledgement is only current observation", async () => {
  const f = await fixture(),
    run = ensureFixture(f),
    failed = failSyncOnce(f, "confirmation");
  expect((await ensureCodexProject(run.context, run.request)).status).toBe(
    "outcome_unknown",
  );
  expect(failed()).toBe(true);
  vi.restoreAllMocks();
  expect(
    await ensureCodexProject(
      {
        ...run.context,
        journal: new PrivateProjectEnsureJournal(f.journalRoot),
      },
      { ...run.request, key: otherKey },
    ),
  ).toMatchObject({
    status: "resolved",
    proof: "current-catalogue",
    controlGranted: false,
  });
  expect(run.creates()).toBe(1);
});
it("real durable confirmation permits observed replay without another fake-provider create", async () => {
  const f = await fixture(),
    run = ensureFixture(f);
  expect(await ensureCodexProject(run.context, run.request)).toMatchObject({
    status: "created",
    proof: "create-ack-and-current-catalogue",
    controlGranted: false,
  });
  expect(
    await ensureCodexProject(
      {
        ...run.context,
        journal: new PrivateProjectEnsureJournal(f.journalRoot),
      },
      { ...run.request, key: otherKey },
    ),
  ).toMatchObject({
    status: "resolved",
    proof: "current-catalogue",
    controlGranted: false,
  });
  expect(run.creates()).toBe(1);
});

it("concurrent conflicting confirmations preserve exactly one immutable acknowledgement", async () => {
  const f = await fixture();
  await f.journal.claim(pending);
  const outcomes = await Promise.allSettled([
    f.journal.confirm(project, key, "saved-a"),
    f.other.confirm(project, key, "saved-b"),
  ]);
  expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(
    1,
  );
  const record = await f.journal.read(project);
  expect(["saved-a", "saved-b"]).toContain(record?.acknowledgedProjectId);
});
