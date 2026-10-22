import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperationsStore } from "../../apps/desktop/operations/store";
import {
  operationResult,
  observeOperation,
} from "../../apps/desktop/operations/observe";
import {
  configurationOperation,
  configurationResultTarget,
} from "../../apps/desktop/operations/configuration";
import { recordedModelTurn } from "../../apps/desktop/operations/model-turn";
import type { ProductConfigurationCommand } from "../../src/pkg/product-settings/contract";
import type { FarolModelSseEvent } from "../../src/apps/desktop/farol-model-endpoint";
const roots: string[] = [];
const stores: OperationsStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.shutdown(5000)));
  roots
    .splice(0)
    .forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});
function setup(
  limits = { days: 30, bytes: 8192, segmentBytes: 512, entries: 100 },
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "farol-operations-"));
  roots.push(directory);
  let now = 1792670400000;
  const store = new OperationsStore(directory, () => now, limits);
  stores.push(store);
  return {
    directory,
    now: (n: number) => (now += n),
    store,
  };
}
const table = [
  ["chatgpt.open-sign-in", "Setup"],
  ["chatgpt.observe-sign-in", "Setup"],
  ["chatgpt.verify", "Setup"],
  ["computer.verify-workspace", "Setup"],
  ["computer.check-folder", "Setup"],
  ["connector.save-and-connect", "Setup"],
  ["connector.check-health", "Setup"],
  ["connector.verify-app", "Setup"],
  ["connector.start", "Setup"],
  ["connector.stop", "Setup"],
  ["connector.repair", "Setup"],
  ["connector.discover-client", "Setup"],
  ["connector.select-discovered-client", "Setup"],
  ["computer.add-workspace", "You"],
  ["computer.remove-workspace", "You"],
  ["computer.update-access", "You"],
  ["computer.list-workspace", "You"],
  ["computer.search-workspace", "You"],
  ["computer.apply-workspace-edit", "You"],
  ["computer.run-git-status", "You"],
  ["support.export", "You"],
  ["host.test-route-b", "Codex"],
  ["model.apply", "Codex"],
  ["chatgpt.submit-readonly-task", "You"],
] as const;
it.each(table)(
  "records %s once with the correct source and immutable outcome",
  async (kind, source) => {
    const { store } = setup();
    // Use-case boundary fixture, not native execution or provider evidence.
    const metadata = configurationOperation(
      { kind } as ProductConfigurationCommand,
      undefined,
    );
    const action = vi.fn(async () => ({
      ok: false,
      error: { code: "FIXTURE_REFUSED" },
    }));
    await observeOperation(store, metadata, action);
    expect(action).toHaveBeenCalledOnce();
    await store.flush(5000);
    expect((await store.snapshot(5000)).entries).toMatchObject([
      { kind, source, outcome: "refused", code: "FIXTURE_REFUSED" },
    ]);
  },
);
it.each([
  [{ status: "ok" }, "done"],
  [{ ok: false, error: { code: "WORKSPACE_READ_FAILED" } }, "failed"],
  [{ status: "refused", code: "NO_ACCESS" }, "refused"],
  [{ status: "unknown" }, "unknown"],
  [{ status: "ok", data: { phase: "running" } }, "pending"],
  [{ status: "submitted" }, "pending"],
  [{ ok: false, error: { code: "ACTION_OUTCOME_UNKNOWN" } }, "unknown"],
] as const)("preserves classified outcome %#", (value, outcome) =>
  expect(operationResult(value).outcome).toBe(outcome),
);
it("survives restart and skips/counts corrupt and content-bearing lines", async () => {
  const { store, directory } = setup();
  store.record(
    {
      source: "ChatGPT",
      kind: "computer_workspace_read",
      target: { workspace: "Test", relativePath: "README.md" },
    },
    "unknown",
    "UNCONFIRMED",
    12,
  );
  await store.flush(5000);
  const file = path.join(
    directory,
    fs.readdirSync(directory).find((f) => f.endsWith(".jsonl"))!,
  );
  fs.appendFileSync(
    file,
    "corrupt\n" +
      JSON.stringify({
        ...(await store.snapshot(5000)).entries[0],
        prompt: "PRIVATE-CANARY",
      }) +
      "\n",
  );
  const restarted = new OperationsStore(directory, () => 1792670400000);
  expect(await restarted.snapshot(5000)).toMatchObject({
    entries: [{ outcome: "unknown", durationMs: 12 }],
    corruptLines: 2,
  });
  expect(JSON.stringify(await restarted.snapshot(5000))).not.toContain(
    "PRIVATE-CANARY",
  );
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
});
it("bounds disk bytes, age and entry count across independent writer lifetimes", async () => {
  const f = setup({ days: 30, bytes: 1500, segmentBytes: 300, entries: 4 });
  for (let i = 0; i < 20; i++) {
    f.now(1);
    f.store.record(
      { source: "You", kind: "workspace.add", target: {} },
      "done",
      null,
      1,
    );
  }
  await f.store.flush(5000);
  expect((await f.store.snapshot(5000)).entries.length).toBeGreaterThan(0);
  expect((await f.store.snapshot(5000)).entries.length).toBeLessThanOrEqual(4);
  expect(
    fs
      .readdirSync(f.directory)
      .reduce(
        (n, file) => n + fs.statSync(path.join(f.directory, file)).size,
        0,
      ),
  ).toBeLessThanOrEqual(1500);
  f.now(31 * 86400000);
  await f.store.flush(5000);
  expect((await f.store.snapshot(5000)).entries).toEqual([]);
});
it("never overwrites unknown/pending observations and preserves the original exception", async () => {
  const { store } = setup();
  const error = Error("PRIVATE-CANARY");
  await expect(
    observeOperation(
      store,
      { source: "You", kind: "command.run", target: {} },
      async () => {
        throw error;
      },
    ),
  ).rejects.toBe(error);
  store.record(
    { source: "You", kind: "command.observe", target: {} },
    "pending",
    null,
    5,
  );
  store.record(
    { source: "You", kind: "command.observe", target: {} },
    "done",
    null,
    8,
  );
  await store.flush(5000);
  expect(
    (await store.snapshot(5000)).entries.map((e) => e.outcome).sort(),
  ).toEqual(["done", "pending", "unknown"]);
  await store.flush(5000);
  expect(JSON.stringify(await store.snapshot(5000))).not.toContain(
    "PRIVATE-CANARY",
  );
});
it("refuses unsafe files and extraneous metadata without following symlinks", async () => {
  const { store, directory } = setup();
  store.record(
    {
      source: "You",
      kind: "workspace.read",
      target: {},
      prompt: "PRIVATE-CANARY",
    } as never,
    "done",
    null,
    1,
  );
  expect((await store.snapshot(5000)).entries).toEqual([]);
  expect((await store.snapshot(5000)).writeFailures).toBe(1);
  const target = path.join(directory, "outside");
  fs.writeFileSync(target, "secret");
  fs.symlinkSync(
    target,
    path.join(
      directory,
      "1792670400000-00000000-0000-4000-8000-000000000000.jsonl",
    ),
  );
  expect((await store.snapshot(5000)).corruptLines).toBe(1);
  expect(fs.readFileSync(target, "utf8")).toBe("secret");
});
it("uses names-only workspace labels and excludes paths, arguments and payloads", async () => {
  const { store } = setup();
  store.setWorkspaceLabels([{ workspaceId: "w", label: "Docs" }]);
  store.record(
    {
      source: "ChatGPT",
      kind: "computer_workspace_read",
      target: { workspace: "w", relativePath: "README.md" },
    },
    "done",
    null,
    1,
  );
  await store.flush(5000);
  expect((await store.snapshot(5000)).entries[0]?.target).toEqual({
    workspace: "Docs",
    relativePath: "README.md",
  });
  expect(Object.keys((await store.snapshot(5000)).entries[0]!).sort()).toEqual([
    "at",
    "code",
    "durationMs",
    "id",
    "kind",
    "outcome",
    "source",
    "target",
  ]);
});
it("retains an unknown start's handle across restart without accepting content", async () => {
  const { store, directory } = setup();
  const target = { handle: "original-handle", start: "unknown" } as const;
  store.record(
    { source: "ChatGPT", kind: "computer_shell_read", target },
    "refused",
    "FIXTURE_REFUSED",
    1,
  );
  store.record(
    {
      source: "ChatGPT",
      kind: "computer_shell_read",
      target: { ...target, content: "PRIVATE-CANARY" },
    } as Parameters<OperationsStore["record"]>[0],
    "done",
    null,
    1,
  );
  await store.flush(5000);
  const restarted = new OperationsStore(directory, () => 1792670400000);
  stores.push(restarted);
  const snapshot = await restarted.snapshot(5000);
  expect(snapshot.entries).toHaveLength(1);
  expect(snapshot.entries[0]?.target).toEqual(target);
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE-CANARY");
});
it.each([
  "response.completed",
  "response.failed",
  "response.incomplete",
  "no-terminal",
])("records Responses %s once after stream consumption", async (event) => {
  const { store } = setup();
  const frames: FarolModelSseEvent[] = [
    { event, data: { text: "PRIVATE-CANARY" } },
  ];
  const handler = recordedModelTurn(store, async () => ({
    ok: true,
    stream: (async function* () {
      yield* frames;
    })(),
  }));
  const result = await handler({ body: "PRIVATE-PROMPT", headers: {} });
  if (!result.ok || !("stream" in result)) throw Error("fixture");
  for await (const _frame of result.stream) {
    /* Consume the original stream once. */
  }
  await store.flush(5000);
  expect((await store.snapshot(5000)).entries).toMatchObject([
    {
      source: "Codex",
      kind: "model.responses.turn",
      outcome:
        event === "response.completed"
          ? "done"
          : event === "response.failed"
            ? "failed"
            : "unknown",
    },
  ]);
  await store.flush(5000);
  expect(JSON.stringify(await store.snapshot(5000))).not.toMatch(/PRIVATE/);
});

it("retains an unmatched start across process replacement and appends its observation without editing it", async () => {
  const { store, directory } = setup();
  const finish = store.begin({
    source: "You",
    kind: "workspace.write",
    target: { relativePath: "x" },
  });
  await store.flush(5000);
  const before = await new OperationsStore(
    directory,
    () => 1792670400000,
  ).snapshot();
  expect(before.entries).toMatchObject([
    { outcome: "pending", lifecycle: { phase: "started" } },
  ]);
  await store.flush(5000);
  const file = path.join(
    directory,
    fs.readdirSync(directory).find((f) => f.endsWith(".jsonl"))!,
  );
  const original = fs.readFileSync(file, "utf8");
  finish("unknown", "WRITE_UNCONFIRMED", 20);
  expect(fs.readFileSync(file, "utf8").startsWith(original)).toBe(true);
  await store.flush(5000);
  expect((await store.snapshot(5000)).entries).toMatchObject([
    { outcome: "unknown", lifecycle: { phase: "observed" } },
  ]);
  finish("done", null, 30);
  expect((await store.snapshot(5000)).entries[0]?.outcome).toBe("unknown");
});

it.each([
  "check",
  "download",
  "apply",
  "apply-on-quit",
  "recover",
  "rollback",
  "recovery-check",
])("records updater %s at its actual port once", async (kind) => {
  const { recordedUpdaterPorts } =
    await import("../../apps/desktop/operations/updater");
  const { store } = setup();
  const effect = vi.fn(async () => ({
    ok: false,
    code: "UPDATE_FIXTURE_REFUSED",
  }));
  const ports = recordedUpdaterPorts(store, {
    discover: effect,
    download: effect,
    restart: effect,
    applyOnQuit: effect,
    restore: effect,
    recover: effect,
  } as unknown as import("../../src/modules/release/app/installed-updater").InstalledUpdaterPorts);
  const update = {} as Parameters<typeof ports.restart>[0];
  if (kind === "check") await ports.discover();
  else if (kind === "download") await ports.download();
  else if (kind === "apply") await ports.restart(update);
  else if (kind === "apply-on-quit")
    await ports.applyOnQuit!(
      update,
      {} as Parameters<NonNullable<typeof ports.applyOnQuit>>[1],
    );
  else if (kind === "recovery-check") await ports.recover();
  else await ports.restore(kind as "recover" | "rollback");
  expect(effect).toHaveBeenCalledOnce();
  await store.flush(5000);
  expect((await store.snapshot(5000)).entries).toMatchObject([
    {
      source: "Updater",
      kind: `update.${kind}`,
      outcome: "refused",
      code: "UPDATE_FIXTURE_REFUSED",
    },
  ]);
});

it("keeps an explicit refusal classification even when its code ends in FAILED", () => {
  expect(
    operationResult({ status: "refused", code: "FIXTURE_FAILED" }),
  ).toEqual({ outcome: "refused", code: "FIXTURE_FAILED" });
});
it("separates a damaged trailing line before appending the next valid observation", async () => {
  const { store, directory } = setup({
    days: 30,
    bytes: 8192,
    segmentBytes: 4096,
    entries: 100,
  });
  store.record({ source: "You", kind: "first", target: {} }, "done", null, 1);
  await store.flush(5000);
  const file = path.join(
    directory,
    fs.readdirSync(directory).find((f) => f.endsWith(".jsonl"))!,
  );
  fs.appendFileSync(file, "{broken tail");
  store.record({ source: "You", kind: "next", target: {} }, "done", null, 2);
  await store.flush(5000);
  expect(
    (await store.snapshot(5000)).entries.map((e) => e.kind).sort(),
  ).toEqual(["first", "next"]);
  expect((await store.snapshot(5000)).corruptLines).toBe(1);
});

it.each([
  "TURN_OUTCOME_UNKNOWN",
  "FAROL_MODEL_ROUTE_UNREACHABLE",
  "PROVIDER_FAILED",
])(
  "retains the terminal metadata code %s without mistaking unknown for failed",
  async (code) => {
    const { store } = setup();
    const handler = recordedModelTurn(store, async () => ({
      ok: true,
      events: [
        {
          event: "response.failed",
          data: { response: { error: { code, message: "PRIVATE-CANARY" } } },
        },
      ],
    }));
    await handler({ body: "PRIVATE-PROMPT", headers: {} });
    await store.flush(5000);
    expect((await store.snapshot(5000)).entries).toMatchObject([
      { code, outcome: code === "PROVIDER_FAILED" ? "failed" : "unknown" },
    ]);
    await store.flush(5000);
    expect(JSON.stringify(await store.snapshot(5000))).not.toMatch(/PRIVATE/);
  },
);

it("extracts target-only metadata from a sealed workspace receipt", () => {
  const result = {
    ok: true,
    snapshot: {
      status: "ready",
      settings: {
        computer: { workspaces: [{ workspaceId: "w", label: "Docs" }] },
      },
    },
    evidence: {
      kind: "computer.workspace-mutation",
      workspaceId: "w",
      relativePath: "README.md",
      text: "PRIVATE-CANARY",
      stdout: "PRIVATE-CANARY",
    },
  } as unknown as import("../../src/pkg/product-settings/contract").ProductConfigurationResult;
  expect(configurationResultTarget(result)).toEqual({
    workspace: "Docs",
    relativePath: "README.md",
  });
  expect(
    configurationOperation(
      { kind: "computer.run-git-head", workspaceId: "w" },
      undefined,
    ).target,
  ).toEqual({ command: "git", relativePath: "." });
});

const metadata = {
  source: "You",
  kind: "fixture.operation",
  target: {},
} as const;
const dayMs = 86400000;
const retentionLimits = {
  days: 30,
  bytes: 1024 * 1024,
  segmentBytes: 65536,
  entries: 1000,
};
function segmentFiles(directory: string) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}
it("keeps the last 30 days on a quiet profile writing once a day for 40 days", async () => {
  const f = setup(retentionLimits);
  for (let day = 0; day < 40; day++) {
    f.store.record({ ...metadata, kind: `day.${day}` }, "done", null, 1);
    expect(await f.store.flush(5000)).toBe(true);
    if (day < 39) f.now(dayMs);
  }
  f.now(1);
  expect(await f.store.flush(5000)).toBe(true);
  expect(
    (await f.store.snapshot(5000)).entries.map((entry) => entry.kind),
  ).toEqual(Array.from({ length: 30 }, (_, i) => `day.${i + 10}`));
  expect(segmentFiles(f.directory)).toHaveLength(30);
  expect(
    fs.readdirSync(f.directory).filter((n) => n.endsWith(".index.json")),
  ).toHaveLength(30);
});
it("rotates at UTC midnight within a batch and reuses the segment during that day", async () => {
  const f = setup(retentionLimits);
  f.now(Date.parse("2026-10-22T23:59:59.999Z") - 1792670400000);
  f.store.record({ ...metadata, kind: "before.midnight" }, "done", null, 1);
  f.now(1);
  f.store.record({ ...metadata, kind: "after.midnight" }, "done", null, 1);
  expect(await f.store.flush(5000)).toBe(true);
  f.now(1000);
  f.store.record({ ...metadata, kind: "same.day" }, "done", null, 1);
  expect(await f.store.flush(5000)).toBe(true);
  const files = segmentFiles(f.directory);
  expect(files).toHaveLength(2);
  expect(
    files.map((name) =>
      fs
        .readFileSync(path.join(f.directory, name), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).kind),
    ),
  ).toEqual([["before.midnight"], ["after.midnight", "same.day"]]);
});
it.each(["missing", "corrupt", "stale"])(
  "rebuilds a %s index and retains recent records in a legacy long-open segment",
  async (damage) => {
    const f = setup(retentionLimits);
    f.store.record(metadata, "done", null, 1);
    expect(await f.store.flush(5000)).toBe(true);
    const original = (await f.store.snapshot(5000)).entries[0]!;
    const file = path.join(f.directory, segmentFiles(f.directory)[0]!);
    // Simulate a pre-day-rotation segment, including an exact-cutoff record.
    const last = f.now(40 * dayMs);
    fs.appendFileSync(
      file,
      [last - 30 * dayMs - 1, last - 30 * dayMs, last - 1, last]
        .map(
          (at, i) =>
            JSON.stringify({ ...original, at, kind: `legacy.${i}` }) + "\n",
        )
        .join(""),
    );
    const indexFile = `${file}.index.json`;
    if (damage === "missing") fs.unlinkSync(indexFile);
    else
      fs.writeFileSync(
        indexFile,
        damage === "corrupt"
          ? "{broken"
          : JSON.stringify({ first: original.at, last: original.at, count: 1 }),
      );
    const reader = new OperationsStore(
      f.directory,
      () => last,
      retentionLimits,
    );
    stores.push(reader);
    // Readers neither trust creation time nor need a valid index or writer flush.
    expect(
      (await reader.snapshot(5000)).entries.map((entry) => entry.kind),
    ).toEqual(["legacy.1", "legacy.2", "legacy.3"]);
    expect(await f.store.flush(5000)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(indexFile, "utf8"))).toEqual({
      first: original.at,
      last,
      count: 5,
    });
    expect(fs.statSync(indexFile).mode & 0o777).toBe(0o600);
    expect(
      (await f.store.snapshot(5000)).entries.map((entry) => entry.kind),
    ).toEqual(["legacy.1", "legacy.2", "legacy.3"]);
    f.now(30 * dayMs + 1);
    expect(await f.store.flush(5000)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(indexFile)).toBe(false);
  },
);
it("keeps future observations when the clock moves backwards across days", async () => {
  const f = setup(retentionLimits);
  const present = f.now(0);
  f.now(60 * dayMs);
  f.store.record({ ...metadata, kind: "future" }, "done", null, 1);
  expect(await f.store.flush(5000)).toBe(true);
  f.now(-60 * dayMs);
  f.store.record({ ...metadata, kind: "present" }, "done", null, 1);
  expect(await f.store.flush(5000)).toBe(true);
  expect(segmentFiles(f.directory)).toHaveLength(2);
  expect(
    (await f.store.snapshot(5000)).entries.map((entry) => entry.kind),
  ).toEqual(["present", "future"]);
  f.now(31 * dayMs);
  expect(await f.store.flush(5000)).toBe(true);
  expect((await f.store.snapshot(5000)).entries).toMatchObject([
    { kind: "future", at: present + 60 * dayMs },
  ]);
  expect(segmentFiles(f.directory)).toHaveLength(1);
});
it("indexes minimum and maximum record times when the clock moves backwards within a day", async () => {
  const f = setup(retentionLimits);
  const last = f.now(1000);
  f.store.record({ ...metadata, kind: "later" }, "done", null, 1);
  const first = f.now(-1000);
  f.store.record({ ...metadata, kind: "earlier" }, "done", null, 1);
  expect(await f.store.flush(5000)).toBe(true);
  const files = segmentFiles(f.directory);
  expect(files).toHaveLength(1);
  expect(
    JSON.parse(
      fs.readFileSync(path.join(f.directory, `${files[0]}.index.json`), "utf8"),
    ),
  ).toEqual({ first, last, count: 2 });
  f.now(30 * dayMs + 1);
  expect(await f.store.flush(5000)).toBe(true);
  expect((await f.store.snapshot(5000)).entries).toMatchObject([
    { kind: "later", at: last },
  ]);
  expect(segmentFiles(f.directory)).toEqual(files);
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function injectedStore(io: typeof fs.promises, queueLimit = 4) {
  const { directory } = setup();
  const store = new OperationsStore(
    directory,
    () => 1792670400000,
    { days: 30, bytes: 8192, segmentBytes: 4096, entries: 100 },
    io,
    queueLimit,
  );
  stores.push(store);
  return { store, directory };
}
it("returns begin/completion immediately while async durability is stalled and bounds shutdown", async () => {
  const entered = deferred(),
    release = deferred();
  let syncs = 0;
  const io = {
    ...fs.promises,
    open: async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await fs.promises.open(...args);
      if (String(args[0]).endsWith(".jsonl")) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          syncs++;
          entered.resolve();
          await release.promise;
          await sync();
        };
      }
      return handle;
    },
  };
  const { store, directory } = injectedStore(io);
  const finish = store.begin(metadata);
  finish("done", null, 1);
  await entered.promise;
  try {
    const start = performance.now();
    const complete = store.begin({ ...metadata, kind: "fixture.second" });
    complete("unknown", "UNCONFIRMED", 2);
    expect(performance.now() - start).toBeLessThan(100);
    const shutdownAt = performance.now();
    expect(await store.shutdown(20)).toBe(false);
    expect(performance.now() - shutdownAt).toBeLessThan(500);
  } finally {
    release.resolve();
  }
  expect(await store.flush(5000)).toBe(true);
  expect(syncs).toBe(2); // One sync per batch, not per begin/completion.
  const rows = fs
    .readdirSync(directory)
    .filter((n) => n.endsWith(".jsonl"))
    .flatMap((n) =>
      fs
        .readFileSync(path.join(directory, n), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  expect(rows.map((e) => e.lifecycle.phase)).toEqual([
    "started",
    "observed",
    "started",
    "observed",
  ]);
  expect(rows[0].lifecycle.id).toBe(rows[1].lifecycle.id);
  expect(rows[2].lifecycle.id).toBe(rows[3].lifecycle.id);
});
it("does no filesystem work on begin/completion, including workspace-label updates", async () => {
  const release = deferred();
  const mkdir = vi.fn(async (...args: Parameters<typeof fs.promises.mkdir>) => {
    await release.promise;
    return fs.promises.mkdir(...args);
  }) as typeof fs.promises.mkdir;
  const { store } = injectedStore({ ...fs.promises, mkdir });
  try {
    const start = performance.now();
    store.setWorkspaceLabels([{ workspaceId: "w", label: "Docs" }]);
    const complete = store.begin(metadata);
    complete("done", null, 1);
    expect(performance.now() - start).toBeLessThan(100);
    expect(mkdir).not.toHaveBeenCalled();
    expect(await store.flush(10)).toBe(false);
  } finally {
    release.resolve();
  }
  expect(await store.flush(5000)).toBe(true);
});
it("evicts the oldest settled rows, preserves unknown/pending and reports overflow once across restart", async () => {
  const { store, directory } = injectedStore(fs.promises);
  for (const [kind, outcome] of [
    ["old", "done"],
    ["unknown", "unknown"],
    ["pending", "pending"],
    ["new", "done"],
    ["newest", "refused"],
  ] as const)
    store.record({ ...metadata, kind }, outcome, null, 1);
  expect(await store.flush(5000)).toBe(true);
  expect((await store.snapshot(5000)).entries.map((e) => e.kind)).toEqual([
    "unknown",
    "pending",
    "new",
    "newest",
  ]);
  const restarted = new OperationsStore(directory, () => 1792670400000);
  expect(await restarted.snapshot(5000)).toMatchObject({
    droppedEntries: 1,
    unrecordedUncertainEntries: 0,
  });
  expect(await restarted.snapshot(5000)).toMatchObject({ droppedEntries: 1 });
});
it("reports protected-queue exhaustion explicitly without evicting queued uncertain outcomes", async () => {
  const { store } = injectedStore(fs.promises, 2);
  store.record({ ...metadata, kind: "pending" }, "pending", null, 1);
  store.record({ ...metadata, kind: "unknown" }, "unknown", null, 1);
  store.begin({ ...metadata, kind: "overflow" })("unknown", "UNCONFIRMED", 1);
  expect(await store.flush(5000)).toBe(true);
  expect(await store.snapshot(5000)).toMatchObject({
    entries: [
      { kind: "pending", outcome: "pending" },
      { kind: "unknown", outcome: "unknown" },
    ],
    droppedEntries: 2,
    unrecordedUncertainEntries: 2,
  });
});
it("records a completion with full known metadata when its settled begin was evicted", async () => {
  const { store, directory } = injectedStore(fs.promises, 1);
  const finish = store.begin({ ...metadata, target: { relativePath: "x" } });
  finish("done", "SAVED", 17);
  finish("failed", "LATE", 18);
  expect(await store.flush(5000)).toBe(true);
  expect(await store.snapshot(5000)).toMatchObject({
    entries: [
      {
        target: { relativePath: "x" },
        outcome: "done",
        code: "SAVED",
        durationMs: 17,
        lifecycle: { phase: "observed" },
      },
    ],
    droppedEntries: 1,
  });
  const raw = fs.readdirSync(directory).filter((n) => n.endsWith(".jsonl"));
  expect(
    fs.readFileSync(path.join(directory, raw[0]!), "utf8").trim().split("\n"),
  ).toHaveLength(1);
});
it("isolates write failure from operation values/exceptions and publishes cross-writer diagnostics without replay", async () => {
  let attempts = 0;
  const io = {
    ...fs.promises,
    open: async (...args: Parameters<typeof fs.promises.open>) => {
      if (String(args[0]).endsWith(".jsonl")) {
        attempts++;
        throw Error("PRIVATE-CANARY");
      }
      return fs.promises.open(...args);
    },
  };
  const { store, directory } = injectedStore(io);
  const value = { status: "ok" };
  expect(await observeOperation(store, metadata, async () => value)).toBe(
    value,
  );
  const error = Error("original");
  await expect(
    observeOperation(store, metadata, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(await store.flush(5000)).toBe(false);
  expect(attempts).toBe(1);
  const reader = new OperationsStore(directory, () => 1792670400000);
  expect(await reader.snapshot(5000)).toMatchObject({
    entries: [],
    writeFailures: 1,
    droppedEntries: 4,
    unrecordedUncertainEntries: 2,
  });
  expect(JSON.stringify(await reader.snapshot(5000))).not.toContain(
    "PRIVATE-CANARY",
  );
  expect(attempts).toBe(1);
});
it("preserves order through segment rotation with identical observation timestamps", async () => {
  const { directory } = setup();
  const store = new OperationsStore(directory, () => 1792670400000, {
    days: 30,
    bytes: 8192,
    segmentBytes: 100,
    entries: 100,
  });
  stores.push(store);
  for (let i = 0; i < 8; i++)
    store.record({ ...metadata, kind: `order.${i}` }, "done", null, 1);
  expect(await store.shutdown(5000)).toBe(true);
  expect((await store.snapshot(5000)).entries.map((e) => e.kind)).toEqual(
    Array.from({ length: 8 }, (_, i) => `order.${i}`),
  );
});
it("bounds stalled snapshot reads without delaying operation recording", async () => {
  const release = deferred();
  const io = {
    ...fs.promises,
    readdir: vi.fn(async () => {
      await release.promise;
      return [];
    }) as unknown as typeof fs.promises.readdir,
  };
  const { store } = injectedStore(io);
  try {
    const started = performance.now();
    expect((await store.snapshot(10)).corruptLines).toBe(1);
    const finish = store.begin(metadata);
    finish("done", null, 1);
    expect(performance.now() - started).toBeLessThan(500);
  } finally {
    release.resolve();
  }
  await store.shutdown(5000);
});

it.each(["write", "sync"])(
  "isolates asynchronous %s errors without replaying a batch",
  async (failure) => {
    let attempts = 0;
    const io = {
      ...fs.promises,
      open: async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await fs.promises.open(...args);
        if (String(args[0]).endsWith(".jsonl")) {
          if (failure === "write")
            handle.writeFile = async () => {
              attempts++;
              throw Error("PRIVATE-WRITE");
            };
          else
            handle.sync = async () => {
              attempts++;
              throw Error("PRIVATE-SYNC");
            };
        }
        return handle;
      },
    };
    const { store } = injectedStore(io);
    const value = { status: "ok" };
    expect(await observeOperation(store, metadata, async () => value)).toBe(
      value,
    );
    expect(await store.flush(5000)).toBe(false);
    expect(attempts).toBe(1);
    const snapshot = await store.snapshot(5000);
    expect(snapshot).toMatchObject({ writeFailures: 1, droppedEntries: 2 });
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE/);
    expect(attempts).toBe(1);
  },
);

function controlledPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
it.each(["begin", "finish"] as const)(
  "preserves original promise identity, order and rejection when %s recording throws",
  async (failure) => {
    const events: string[] = [];
    const original = controlledPromise<never>();
    const recorder = {
      begin() {
        events.push("begin");
        if (failure === "begin") throw Error("RECORDER_UNAVAILABLE");
        return () => {
          throw Error("RECORDER_UNAVAILABLE");
        };
      },
      record() {
        throw Error("UNEXPECTED_FALLBACK");
      },
    };
    const result = observeOperation(
      recorder,
      { source: "You", kind: "fixture", target: {} },
      () => {
        events.push("action");
        return original.promise;
      },
    );
    expect(result).toBe(original.promise);
    expect(events).toEqual(["action", "begin"]);
    const error = Error("ORIGINAL_UNKNOWN");
    original.reject(error);
    await expect(result).rejects.toBe(error);
  },
);
it("observes completion without adding a settlement turn or waiting for recording IO", async () => {
  const original = controlledPromise<{ status: string }>();
  const disk = controlledPromise<void>();
  const record = vi.fn(() => {
    void disk.promise;
  });
  const result = observeOperation(
    { record },
    { source: "You", kind: "fixture", target: {} },
    () => original.promise,
  );
  expect(result).toBe(original.promise);
  original.resolve({ status: "unknown" });
  await expect(result).resolves.toEqual({ status: "unknown" });
  expect(record).toHaveBeenCalledWith(
    expect.anything(),
    "unknown",
    null,
    expect.any(Number),
  );
  disk.resolve();
});

it.each(["begin", "finish", "record", "labels"] as const)(
  "counts invalid %s input at the store boundary without throwing",
  async (method) => {
    const { store, directory } = setup(retentionLimits);
    const invalid = { ...metadata, kind: "invalid kind" };
    if (method === "begin") {
      const finish = store.begin(invalid);
      finish("done", null, 1); // Failed starts are inert, with no second failure.
      finish("unknown", null, 2);
    } else if (method === "finish") store.begin(metadata)("done", null, NaN);
    else if (method === "record") store.record(invalid, "unknown", null, 1);
    else store.setWorkspaceLabels(undefined as never);
    expect((await store.snapshot(5000)).writeFailures).toBe(1);
    expect(await store.flush(5000)).toBe(true);
    const snapshot = await store.snapshot(5000);
    expect(snapshot).toMatchObject({
      writeFailures: 1,
      droppedEntries: method === "labels" ? 0 : 1,
      unrecordedUncertainEntries:
        method === "begin" || method === "record" ? 1 : 0,
    });
    const restarted = new OperationsStore(directory, () => 1792670400000);
    stores.push(restarted);
    expect((await restarted.snapshot(5000)).writeFailures).toBe(1);
  },
);
it.each(["begin", "finish", "record", "labels"] as const)(
  "absorbs queue scheduling failures in %s and keeps diagnostics available",
  async (method) => {
    const { store } = setup(retentionLimits);
    const finish = method === "finish" ? store.begin(metadata) : undefined;
    // Complete the valid start first so each failing method must schedule.
    await store.flush(5000);
    const schedule = vi
      .spyOn(globalThis, "setImmediate")
      .mockImplementation(() => {
        throw Error("QUEUE_UNAVAILABLE");
      });
    try {
      if (method === "begin") store.begin(metadata)("done", null, 1);
      else if (method === "finish") finish!("unknown", null, 1);
      else if (method === "record") store.record(metadata, "done", null, 1);
      else store.setWorkspaceLabels([{ workspaceId: "w", label: "Docs" }]);
    } finally {
      schedule.mockRestore();
    }
    expect((await store.snapshot(5000)).writeFailures).toBe(1);
    expect(await store.flush(5000)).toBe(true);
    expect((await store.snapshot(5000)).writeFailures).toBe(1);
  },
);
it("counts asynchronous label serialization failure without delaying an operation", async () => {
  const { store } = setup(retentionLimits);
  store.setWorkspaceLabels([{ workspaceId: "w", label: 1n as never }]);
  const result = { status: "ok" };
  expect(await observeOperation(store, metadata, async () => result)).toBe(
    result,
  );
  expect(await store.flush(5000)).toBe(false);
  expect((await store.snapshot(5000)).writeFailures).toBe(1);
});
