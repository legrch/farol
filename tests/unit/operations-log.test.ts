import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  operationKinds,
  recordableOperationCodes,
} from "../../apps/desktop/renderer/operations-vocabulary";
import { createTotalOperationsRecorder } from "../../apps/desktop/operations/recorder";
import {
  OperationEntrySchema,
  type OperationMetadata,
} from "../../apps/desktop/renderer/operations-contract";
import {
  createSupportExport,
  writeSupportExport,
} from "../../src/apps/desktop/support-export";
import { OperationsStore } from "../../apps/desktop/operations/store";
import {
  operationResult,
  observeOperation,
} from "../../apps/desktop/operations/observe";
import {
  configurationOperation,
  configurationResultTarget,
} from "../../apps/desktop/operations/configuration";
import {
  recordedModelTurn,
  recordedCompaction,
} from "../../apps/desktop/operations/model-turn";
import type { ProductConfigurationCommand } from "../../src/pkg/product-settings/contract";
import { routeBModelTurnHandler } from "../../src/apps/desktop/farol-model-endpoint";
import { recordedUpdaterPorts } from "../../apps/desktop/operations/updater";
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
  ["setup.progress", "Setup"],
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
  ["host.run-route-b-check", "Codex"],
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
      error: { code: "OPERATION_REFUSED" },
    }));
    await observeOperation(store, metadata, action);
    expect(action).toHaveBeenCalledOnce();
    await store.flush(5000);
    expect((await store.snapshot(5000)).entries).toMatchObject([
      { kind, source, outcome: "refused", code: "OPERATION_REFUSED" },
    ]);
  },
);
it("observes refused setup completion without replacing its result or promise", async () => {
  const { store } = setup();
  const result = { ok: false, error: "SETUP_INCOMPLETE" };
  const original = Promise.resolve(result);
  const action = vi.fn(() => original);
  expect(
    observeOperation(
      store,
      configurationOperation(
        { kind: "setup.progress", currentStep: "connect", dismissed: true },
        undefined,
      ),
      action,
    ),
  ).toBe(original);
  expect(await original).toBe(result);
  expect(action).toHaveBeenCalledOnce();
  await store.flush(5000);
  expect((await store.snapshot(5000)).entries).toMatchObject([
    {
      source: "Setup",
      kind: "setup.progress",
      outcome: "refused",
      code: "SETUP_INCOMPLETE",
    },
  ]);
});
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
  stores.push(restarted);
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
      { source: "You", kind: "computer.add-workspace", target: {} },
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
      { source: "You", kind: "computer_shell_start", target: {} },
      async () => {
        throw error;
      },
    ),
  ).rejects.toBe(error);
  store.record(
    { source: "You", kind: "computer_shell_read", target: {} },
    "pending",
    null,
    5,
  );
  store.record(
    { source: "You", kind: "computer_shell_read", target: {} },
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
      kind: "computer_workspace_read",
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
  const target = { handle: "unrecognized", start: "unknown" } as const;
  store.record(
    { source: "ChatGPT", kind: "computer_shell_read", target },
    "refused",
    "OPERATION_REFUSED",
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
  if (!result.ok || !("stream" in result)) throw Error("connection.start");
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
    kind: "computer_workspace_write",
    target: { relativePath: "x" },
  });
  await store.flush(5000);
  const reader = new OperationsStore(directory, () => 1792670400000);
  stores.push(reader);
  const before = await reader.snapshot();
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
    code: "UPDATE_RECOVERY_REQUIRED",
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
      code: "UPDATE_RECOVERY_REQUIRED",
    },
  ]);
});

it("keeps an explicit refusal classification even when its code ends in FAILED", () => {
  expect(
    operationResult({ status: "refused", code: "OPERATION_FAILED" }),
  ).toEqual({ outcome: "refused", code: "OPERATION_FAILED" });
});
it("separates a damaged trailing line before appending the next valid observation", async () => {
  const { store, directory } = setup({
    days: 30,
    bytes: 8192,
    segmentBytes: 4096,
    entries: 100,
  });
  store.record(
    { source: "You", kind: "hub.start", target: {} },
    "done",
    null,
    1,
  );
  await store.flush(5000);
  const file = path.join(
    directory,
    fs.readdirSync(directory).find((f) => f.endsWith(".jsonl"))!,
  );
  fs.appendFileSync(file, "{broken tail");
  store.record(
    { source: "You", kind: "hub.stop", target: {} },
    "done",
    null,
    2,
  );
  await store.flush(5000);
  expect(
    (await store.snapshot(5000)).entries.map((e) => e.kind).sort(),
  ).toEqual(["hub.start", "hub.stop"]);
  expect((await store.snapshot(5000)).corruptLines).toBe(1);
});

it.each([
  "TURN_OUTCOME_UNKNOWN",
  "FAROL_MODEL_ROUTE_UNREACHABLE",
  "server_error",
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
      { code, outcome: code === "server_error" ? "failed" : "unknown" },
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
  kind: "connection.health",
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
it("prunes expired segments on open without recording or flushing", async () => {
  const f = setup(retentionLimits);
  f.store.record(metadata, "done", null, 1);
  f.now(dayMs);
  f.store.record(metadata, "done", null, 1);
  expect(await f.store.shutdown(5000)).toBe(true);
  expect(segmentFiles(f.directory)).toHaveLength(2);
  f.now(31 * dayMs);
  const reopened = new OperationsStore(
    f.directory,
    () => f.now(0),
    retentionLimits,
  );
  stores.push(reopened);
  await expect.poll(() => fs.readdirSync(f.directory)).toEqual([]);
  expect(await reopened.snapshot(5000)).toMatchObject({
    entries: [],
    writeFailures: 0,
  });
});
it("prunes an idle profile daily with an unref'd timer cleared on shutdown", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const interval = vi.spyOn(globalThis, "setInterval");
  const clear = vi.spyOn(globalThis, "clearInterval");
  const f = setup(retentionLimits);
  try {
    expect(interval).toHaveBeenCalledTimes(1);
    expect(interval.mock.calls[0]?.[1]).toBe(dayMs);
    const timer = interval.mock.results[0]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    f.store.record(metadata, "done", null, 1);
    expect(await f.store.flush(5000)).toBe(true);
    expect(segmentFiles(f.directory)).toHaveLength(1);
    f.now(30 * dayMs + 1);
    vi.advanceTimersByTime(dayMs - 1);
    expect(segmentFiles(f.directory)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await expect.poll(() => segmentFiles(f.directory)).toEqual([]);
    expect(await f.store.shutdown(5000)).toBe(true);
    expect(clear).toHaveBeenCalledWith(timer);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await f.store.shutdown(5000);
    interval.mockRestore();
    clear.mockRestore();
    vi.useRealTimers();
  }
});
it("counts an open-time prune failure without throwing or busy retries", async () => {
  const f = setup(retentionLimits);
  f.store.record(metadata, "done", null, 1);
  expect(await f.store.shutdown(5000)).toBe(true);
  f.now(31 * dayMs);
  const unlink = vi.fn(async (file: fs.PathLike) => {
    if (String(file).endsWith(".jsonl")) throw Error("PRIVATE-PRUNE-FAILURE");
    return fs.promises.unlink(file);
  });
  const reopened = new OperationsStore(
    f.directory,
    () => f.now(0),
    retentionLimits,
    { ...fs.promises, unlink },
  );
  stores.push(reopened);
  await expect
    .poll(async () => (await reopened.snapshot(5000)).writeFailures)
    .toBe(1);
  await expect
    .poll(() => {
      const file = fs
        .readdirSync(f.directory)
        .find((name) => name.endsWith(".diagnostics.json"));
      return file
        ? JSON.parse(fs.readFileSync(path.join(f.directory, file), "utf8"))
        : undefined;
    })
    .toEqual({
      writeFailures: 1,
      droppedEntries: 0,
      unrecordedUncertainEntries: 0,
    });
  expect(
    unlink.mock.calls.filter(([file]) => String(file).endsWith(".jsonl")),
  ).toHaveLength(1);
  expect(segmentFiles(f.directory)).toHaveLength(1);
  expect(JSON.stringify(await reopened.snapshot(5000))).not.toContain(
    "PRIVATE-PRUNE-FAILURE",
  );
});
it("coalesces idle ticks behind stalled startup retention without blocking operations", async () => {
  const f = setup(retentionLimits);
  f.store.record(metadata, "done", null, 1);
  expect(await f.store.shutdown(5000)).toBe(true);
  f.now(31 * dayMs);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const entered = deferred(),
    release = deferred();
  const unlink = vi.fn(async (file: fs.PathLike) => {
    if (String(file).endsWith(".jsonl")) {
      entered.resolve();
      await release.promise;
    }
    return fs.promises.unlink(file);
  });
  const open = vi.fn(fs.promises.open);
  const mkdir = vi.fn(fs.promises.mkdir);
  const reopened = new OperationsStore(
    f.directory,
    () => f.now(0),
    retentionLimits,
    { ...fs.promises, unlink, open, mkdir: mkdir as typeof fs.promises.mkdir },
  );
  stores.push(reopened);
  try {
    expect(mkdir).not.toHaveBeenCalled(); // Opening schedules IO; it never waits for it.
    await entered.promise;
    open.mockClear();
    vi.advanceTimersByTime(10 * dayMs);
    const value = { status: "ok" };
    expect(await observeOperation(reopened, metadata, async () => value)).toBe(
      value,
    );
    expect(open).not.toHaveBeenCalled(); // Queued behind the single writer.
    expect(await reopened.shutdown(10)).toBe(false);
    release.resolve();
    expect(await reopened.flush(5000)).toBe(true);
    expect(mkdir).toHaveBeenCalledTimes(2); // Startup plus one coalesced drain.
    expect((await reopened.snapshot(5000)).entries).toMatchObject([
      { outcome: "done" },
    ]);
  } finally {
    release.resolve();
    await reopened.shutdown(5000);
    vi.useRealTimers();
  }
});
it("keeps the last 30 days on a quiet profile writing once a day for 40 days", async () => {
  const f = setup(retentionLimits);
  for (let day = 0; day < 40; day++) {
    f.store.record(
      { ...metadata, kind: operationKinds[day]! },
      "done",
      null,
      1,
    );
    expect(await f.store.flush(5000)).toBe(true);
    if (day < 39) f.now(dayMs);
  }
  f.now(1);
  expect(await f.store.flush(5000)).toBe(true);
  expect(
    (await f.store.snapshot(5000)).entries.map((entry) => entry.kind),
  ).toEqual(Array.from({ length: 30 }, (_, i) => operationKinds[i + 10]!));
  expect(segmentFiles(f.directory)).toHaveLength(30);
  expect(
    fs.readdirSync(f.directory).filter((n) => n.endsWith(".index.json")),
  ).toHaveLength(30);
});
it("rotates at UTC midnight within a batch and reuses the segment during that day", async () => {
  const f = setup(retentionLimits);
  f.now(Date.parse("2026-10-22T23:59:59.999Z") - 1792670400000);
  f.store.record({ ...metadata, kind: "connection.start" }, "done", null, 1);
  f.now(1);
  f.store.record({ ...metadata, kind: "connection.stop" }, "done", null, 1);
  expect(await f.store.flush(5000)).toBe(true);
  f.now(1000);
  f.store.record({ ...metadata, kind: "connection.health" }, "done", null, 1);
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
  ).toEqual([["connection.start"], ["connection.stop", "connection.health"]]);
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
            JSON.stringify({ ...original, at, kind: operationKinds[i]! }) +
            "\n",
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
    ).toEqual([operationKinds[1], operationKinds[2], operationKinds[3]]);
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
    ).toEqual([operationKinds[1], operationKinds[2], operationKinds[3]]);
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
  f.store.record({ ...metadata, kind: "hub.start" }, "done", null, 1);
  expect(await f.store.flush(5000)).toBe(true);
  f.now(-60 * dayMs);
  f.store.record({ ...metadata, kind: "hub.stop" }, "done", null, 1);
  expect(await f.store.flush(5000)).toBe(true);
  expect(segmentFiles(f.directory)).toHaveLength(2);
  expect(
    (await f.store.snapshot(5000)).entries.map((entry) => entry.kind),
  ).toEqual(["hub.stop", "hub.start"]);
  f.now(31 * dayMs);
  expect(await f.store.flush(5000)).toBe(true);
  expect((await f.store.snapshot(5000)).entries).toMatchObject([
    { kind: "hub.start", at: present + 60 * dayMs },
  ]);
  expect(segmentFiles(f.directory)).toHaveLength(1);
});
it("indexes minimum and maximum record times when the clock moves backwards within a day", async () => {
  const f = setup(retentionLimits);
  const last = f.now(1000);
  f.store.record({ ...metadata, kind: "hub.start" }, "done", null, 1);
  const first = f.now(-1000);
  f.store.record({ ...metadata, kind: "hub.stop" }, "done", null, 1);
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
    { kind: "hub.start", at: last },
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
    const complete = store.begin({ ...metadata, kind: "connection.stop" });
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
    [operationKinds[0], "done"],
    [operationKinds[1], "unknown"],
    [operationKinds[2], "pending"],
    [operationKinds[3], "done"],
    [operationKinds[4], "refused"],
  ] as const)
    store.record({ ...metadata, kind }, outcome, null, 1);
  expect(await store.flush(5000)).toBe(true);
  expect((await store.snapshot(5000)).entries.map((e) => e.kind)).toEqual([
    operationKinds[1],
    operationKinds[2],
    operationKinds[3],
    operationKinds[4],
  ]);
  const restarted = new OperationsStore(directory, () => 1792670400000);
  stores.push(restarted);
  expect(await restarted.snapshot(5000)).toMatchObject({
    droppedEntries: 1,
    unrecordedUncertainEntries: 0,
  });
  expect(await restarted.snapshot(5000)).toMatchObject({ droppedEntries: 1 });
});
it("reports protected-queue exhaustion explicitly without evicting queued uncertain outcomes", async () => {
  const { store } = injectedStore(fs.promises, 2);
  store.record({ ...metadata, kind: "connection.start" }, "pending", null, 1);
  store.record({ ...metadata, kind: "connection.stop" }, "unknown", null, 1);
  store.begin({ ...metadata, kind: "connection.start" })(
    "unknown",
    "UNCONFIRMED",
    1,
  );
  expect(await store.flush(5000)).toBe(true);
  expect(await store.snapshot(5000)).toMatchObject({
    entries: [
      { kind: "connection.start", outcome: "pending" },
      { kind: "connection.stop", outcome: "unknown" },
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
        code: "provider_error",
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
  stores.push(reader);
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
    store.record({ ...metadata, kind: operationKinds[i]! }, "done", null, 1);
  expect(await store.shutdown(5000)).toBe(true);
  expect((await store.snapshot(5000)).entries.map((e) => e.kind)).toEqual(
    Array.from({ length: 8 }, (_, i) => operationKinds[i]!),
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
      { source: "You", kind: "connection.start", target: {} },
      () => {
        events.push("action");
        return original.promise;
      },
    );
    expect(result).toBe(original.promise);
    expect(events).toEqual(["begin", "action"]);
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
    { source: "You", kind: "connection.start", target: {} },
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
it("marks unrepresentable labels before serialization without delaying an operation", async () => {
  const { store } = setup(retentionLimits);
  store.setWorkspaceLabels([{ workspaceId: "w", label: 1n as never }]);
  const result = { status: "ok" };
  expect(await observeOperation(store, metadata, async () => result)).toBe(
    result,
  );
  expect(await store.flush(5000)).toBe(true);
  expect((await store.snapshot(5000)).writeFailures).toBe(0);
  expect(
    JSON.parse(
      fs.readFileSync(
        path.join(store.directory, "workspace-labels.json"),
        "utf8",
      ),
    ),
  ).toEqual({ w: "[unrepresentable]" });
});

// Synthetic adversarial inputs exercise the recorder and real support projection,
// not a live provider, filesystem operation, or installed application.
const hostileText = [
  "PRIVATE_PROMPT",
  "/Users/private/PRIVATE_PATH",
  "PRIVATE_LONG_" + "x".repeat(5000),
  "PRIVATE_秘密_\u202e",
  'PRIVATE_INJECTION\n"};$(echo secret)<script>',
];
function supportWith(
  operations: Awaited<ReturnType<OperationsStore["snapshot"]>>,
) {
  return createSupportExport({
    operations,
    generatedAt: "2026-10-22T12:00:00.000Z",
    build: {
      schema: 1,
      product: "Farol",
      version: "0.2.7",
      bundleId: "io.github.legrch.farol",
      updateChannel: "local-preview-only",
      builtAt: "2026-10-22T12:00:00.000Z",
      sourceCommit: "a".repeat(40),
      sourceTreeDigest: "b".repeat(64),
      sourceDirty: false,
      buildId: "c".repeat(64),
    },
    configuration: { status: "error", error: "SETTINGS_READ_FAILED" },
    runtime: { state: "offline", errorCode: null, identity: null },
    capabilities: {
      nativeFilesystem: false,
      nativeAgent: false,
      liveProvider: false,
    },
    embedded: { node: "24.20.0", electron: null, chrome: null },
    tasks: {
      total: 0,
      running: 0,
      waiting: 0,
      failed: 0,
      countsFrom: "current",
    },
  });
}
it.each(hostileText)(
  "closes every external text field and support export for hostile value %#",
  async (text) => {
    const { store, directory } = setup(retentionLimits);
    // Every write route, including a retained begin handle, uses the same code map.
    store.record(metadata, "failed", text, 1);
    store.begin(metadata)("refused", text, 2);
    store.record({ ...metadata, kind: text }, "done", null, 1);
    store.record({ ...metadata, source: text } as never, "done", null, 1);
    store.record(metadata, text as never, null, 1);
    store.record(
      {
        ...metadata,
        target: { command: text, handle: text, start: "unknown" },
      },
      "unknown",
      null,
      3,
    );
    // Unknown keys cannot smuggle request bodies into any schema level.
    store.record({ ...metadata, [text]: text } as never, "done", null, 1);
    store.record(
      { ...metadata, target: { [text]: text } } as never,
      "done",
      null,
      1,
    );
    await store.flush(5000);
    const snapshot = await store.snapshot(5000);
    expect(snapshot.entries).toMatchObject([
      { code: "provider_error", outcome: "failed" },
      { code: "provider_error", outcome: "refused" },
      {
        target: { command: "other", handle: "unrecognized", start: "unknown" },
      },
    ]);
    expect(snapshot.writeFailures).toBe(5);
    expect(JSON.stringify(supportWith(snapshot))).not.toContain("PRIVATE_");
    const disk = fs
      .readdirSync(directory)
      .map((file) => fs.readFileSync(path.join(directory, file), "utf8"))
      .join("\n");
    expect(disk).not.toContain("PRIVATE_");
    // Closed fields reject arbitrary text; legacy command names become "other".
    const valid = snapshot.entries[0]!;
    const file = path.join(directory, segmentFiles(directory)[0]!);
    const variants = [
      { code: text },
      { kind: text },
      { source: text },
      { outcome: text },
      { target: { command: text } },
      { target: { handle: text } },
      { target: { start: text } },
      { id: text },
      { lifecycle: { id: text, phase: "started" } },
      { lifecycle: { id: valid.id, phase: text } },
      { at: text },
      { durationMs: text },
    ];
    fs.appendFileSync(
      file,
      variants
        .map((fields) => JSON.stringify({ ...valid, ...fields }) + "\n")
        .join(""),
    );
    const restarted = new OperationsStore(
      directory,
      () => 1792670400000,
      retentionLimits,
    );
    stores.push(restarted);
    const readback = await restarted.snapshot(5000);
    expect(readback.corruptLines).toBe(variants.length - 1);
    expect(readback.entries).toHaveLength(snapshot.entries.length + 1);
    expect(readback.entries.at(-1)!.target).toEqual({ command: "other" });
    expect(JSON.stringify(supportWith(readback))).not.toContain("PRIVATE_");
  },
);

it.each(recordableOperationCodes)(
  "preserves the exact approved code %s at both recorder methods",
  (code) => {
    const record = vi.fn();
    const finish = vi.fn();
    const recorder = createTotalOperationsRecorder({
      record,
      begin: () => finish,
    });
    recorder.record(metadata, "failed", code, 1);
    recorder.begin(metadata)("failed", code, 2);
    expect(record).toHaveBeenCalledWith(metadata, "failed", code, 1);
    expect(finish).toHaveBeenCalledWith("failed", code, 2);
  },
);

it("enforces the vocabulary for arbitrary sinks and workspace label calls", () => {
  const record = vi.fn();
  const begin = vi.fn(() => vi.fn());
  const labels = vi.fn();
  const recorder = createTotalOperationsRecorder({
    record,
    begin,
    setWorkspaceLabels: labels,
  });
  recorder.begin({ ...metadata, kind: "PRIVATE_PROMPT" })(
    "failed",
    "PRIVATE_PROMPT",
    1,
  );
  recorder.record(
    { ...metadata, kind: "PRIVATE_PROMPT" },
    "failed",
    "PRIVATE_PROMPT",
    1,
  );
  expect(begin).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
  const mutable = { ...metadata, target: { command: "PRIVATE_PROMPT" } };
  recorder.begin(mutable)("failed", "PRIVATE_PROMPT", 1);
  expect(begin).toHaveBeenCalledWith({
    ...metadata,
    target: { command: "other" },
  });
  expect(begin.mock.results[0]!.value).toHaveBeenCalledWith(
    "failed",
    "provider_error",
    1,
  );
  for (const value of [
    "PRIVATE\nPROMPT",
    "PRIVATE\u202ePROMPT",
    "x".repeat(161),
    "<script>",
  ]) {
    recorder.setWorkspaceLabels([{ workspaceId: "w", label: value }]);
    recorder.setWorkspaceLabels([{ workspaceId: value, label: "Docs" }]);
  }
  expect(labels).toHaveBeenCalledTimes(4);
  expect(labels.mock.calls.map(([value]) => value[0].label)).toEqual([
    "PRIVATEPROMPT",
    "PRIVATEPROMPT",
    "x".repeat(159) + "…",
    "<script>",
  ]);
});

const ownerTargets: [Record<string, unknown>, Record<string, string>][] = [
  [{ workspace: "x".repeat(161) }, { workspace: "x".repeat(159) + "…" }],
  [{ workspace: "Private\u202eName" }, { workspace: "PrivateName" }],
  [{ workspace: "Private\nName" }, { workspace: "PrivateName" }],
  [{ workspace: "Project + [dev] #1" }, { workspace: "Project + [dev] #1" }],
  [{ workspace: "<script>" }, { workspace: "<script>" }],
  [{ workspace: 42 }, { workspace: "[unrepresentable]" }],
  [{ workspace: "\n\u202e" }, { workspace: "[unrepresentable]" }],
  [{ command: 42 }, { command: "other" }],
  [{ command: "build+[dev]" }, { command: "other" }],
  ...[
    ["a+b.txt", "a+b.txt"],
    ["资料/Проект/é.txt", "资料/Проект/é.txt"],
    ["Release notes/a b.md", "Release notes/a b.md"],
    ["nested/[x]~#,=+!$&;'().txt", "nested/[x]~#,=+!$&;'().txt"],
    ["a/".repeat(100) + "z", "a/".repeat(100) + "z"],
    ["x".repeat(4096), "x".repeat(4096)],
    ["x".repeat(4097), "x".repeat(4095) + "…"],
    ["a/" + "x".repeat(16382), "a/" + "x".repeat(4093) + "…"],
    ["x".repeat(16385), "[unrepresentable]"],
    ["x".repeat(4094) + "😀😀", "x".repeat(4094) + "…"],
    ["/private/file", "[unrepresentable]"],
    ["../private", "[unrepresentable]"],
    ["private\\file", "[unrepresentable]"],
    ["private\u202efile", "privatefile"],
    ["a\n\u0000b\u007f.txt", "ab.txt"],
    ["\n\u0000\u202e", "[unrepresentable]"],
    ["\ud800", "[unrepresentable]"],
    ["$(private)", "$(private)"],
    [".", "."],
  ].map(
    ([input, expected]): [Record<string, unknown>, Record<string, string>] => [
      { relativePath: input! },
      { relativePath: expected! },
    ],
  ),
  [{ relativePath: null }, { relativePath: "[unrepresentable]" }],
  [
    { relativePath: { nested: "PRIVATE_PROMPT" } },
    { relativePath: "[unrepresentable]" },
  ],
];
it.each(ownerTargets)(
  "normalizes owner target fields without losing a record %#",
  async (target, expected) => {
    const { store, directory } = setup(retentionLimits);
    const validTarget = { ...target, command: "git" };
    const normalized = { ...expected, command: "git" };
    // Test both one-shot records and settlement after a target changes.
    store.record(
      { ...metadata, target } as never,
      "unknown",
      "ACTION_OUTCOME_UNKNOWN",
      1,
    );
    const mutable = { ...metadata, target: {} };
    const finish = store.begin(mutable);
    mutable.target = validTarget;
    finish("failed", "WORKSPACE_READ_FAILED", 2);
    expect(await store.flush(5000)).toBe(true);
    const snapshot = await store.snapshot(5000);
    expect(snapshot).toMatchObject({
      entries: [
        {
          ...metadata,
          target: expected,
          outcome: "unknown",
          code: "ACTION_OUTCOME_UNKNOWN",
          durationMs: 1,
        },
        {
          ...metadata,
          target: normalized,
          outcome: "failed",
          code: "WORKSPACE_READ_FAILED",
          durationMs: 2,
        },
      ],
      writeFailures: 0,
      droppedEntries: 0,
      unrecordedUncertainEntries: 0,
      corruptLines: 0,
    });
    expect(snapshot.entries).toHaveLength(2);
    // Raw legacy fields go through the same normalization on disk and export.
    const raw = { ...snapshot.entries[0]!, target };
    fs.appendFileSync(
      path.join(directory, segmentFiles(directory)[0]!),
      JSON.stringify(raw) + "\n",
    );
    const restarted = new OperationsStore(
      directory,
      () => 1792670400000,
      retentionLimits,
    );
    stores.push(restarted);
    const readback = await restarted.snapshot(5000);
    expect(readback.corruptLines).toBe(0);
    expect(readback.entries).toHaveLength(3);
    expect(
      readback.entries
        .filter((entry) => entry.id === raw.id)
        .map((entry) => entry.target),
    ).toEqual([expected, expected]);
    const rawSnapshot = { ...snapshot, entries: [raw] } as never;
    const report = supportWith(rawSnapshot);
    expect(report.operations!.entries).toHaveLength(1);
    expect(report.operations!.entries[0]!.target).toEqual(expected);
    const exported = path.join(directory, "support.json");
    await writeSupportExport(exported, { operations: rawSnapshot });
    expect(
      JSON.parse(fs.readFileSync(exported, "utf8")).operations.entries[0]
        .target,
    ).toEqual(expected);
  },
);

it("resolves unusual workspace names per field without discarding sibling labels", async () => {
  const { store } = setup(retentionLimits);
  store.setWorkspaceLabels([
    { workspaceId: "a", label: "工程 + [dev] #1" },
    { workspaceId: "b", label: "\n\u202e" },
    { workspaceId: "c", label: "x".repeat(161) },
  ]);
  for (const workspace of ["a", "b", "c"])
    store.record(
      { ...metadata, target: { workspace, relativePath: "a+b.txt" } },
      "done",
      null,
      1,
    );
  await store.flush(5000);
  const snapshot = await store.snapshot(5000);
  expect(snapshot.entries.map((entry) => entry.target.workspace)).toEqual([
    "工程 + [dev] #1",
    "[unrepresentable]",
    "x".repeat(159) + "…",
  ]);
  expect(snapshot.writeFailures).toBe(0);
});
it("preserves bounded international owner names and relative paths, and rejects nonnumeric counters", async () => {
  const { store } = setup(retentionLimits);
  const target = {
    workspace: "Мой проект (dev)",
    relativePath: "Документы/Release notes.md",
  };
  store.setWorkspaceLabels([
    { workspaceId: "workspace-1", label: target.workspace },
  ]);
  store.record({ ...metadata, target }, "done", null, 1);
  await store.flush(5000);
  const snapshot = await store.snapshot(5000);
  expect(snapshot.entries[0]!.target).toEqual(target);
  for (const text of hostileText) {
    for (const field of [
      "corruptLines",
      "writeFailures",
      "droppedEntries",
      "unrecordedUncertainEntries",
    ])
      expect(() =>
        supportWith({ ...snapshot, [field]: text } as never),
      ).toThrow();
    for (const field of ["at", "durationMs"])
      expect(
        OperationEntrySchema.safeParse({
          ...snapshot.entries[0],
          [field]: text,
        }).success,
      ).toBe(false);
  }
});

const wrappedKinds: OperationMetadata[] = [
  { source: "You", kind: "computer.add-workspace", target: {} },
  { source: "Codex", kind: "task.task.rename", target: {} },
  { source: "Setup", kind: "connection.health", target: {} },
  { source: "You", kind: "connection.start", target: {} },
  { source: "Setup", kind: "hub.start", target: {} },
  { source: "You", kind: "hub.stop", target: {} },
  { source: "Codex", kind: "model.responses.compact", target: {} },
  { source: "Updater", kind: "update.check", target: {} },
];
it.each(wrappedKinds)(
  "observes sync throws, async rejection and success for $kind without changing settlement",
  async (metadata) => {
    const { store } = setup(retentionLimits);
    const events: string[] = [];
    const recorder = createTotalOperationsRecorder({
      begin(value) {
        events.push("begin");
        return store.begin(value);
      },
      record: store.record,
    });
    const error = Error("PRIVATE_PROMPT");
    try {
      observeOperation(recorder, metadata, () => {
        events.push("action");
        throw error;
      });
      expect.unreachable("the synchronous throw must escape synchronously");
    } catch (caught) {
      expect(caught).toBe(error);
    }
    expect(events).toEqual(["begin", "action"]);
    const rejected = Promise.reject(error);
    expect(observeOperation(recorder, metadata, () => rejected)).toBe(rejected);
    await expect(rejected).rejects.toBe(error);
    const value = { status: "ok" };
    const fulfilled = Promise.resolve(value);
    expect(observeOperation(recorder, metadata, () => fulfilled)).toBe(
      fulfilled,
    );
    await expect(fulfilled).resolves.toBe(value);
    await store.flush(5000);
    expect((await store.snapshot(5000)).entries).toMatchObject([
      { kind: metadata.kind, outcome: "failed", code: "OPERATION_SYNC_THROW" },
      {
        kind: metadata.kind,
        outcome: "unknown",
        code: "OPERATION_OUTCOME_UNKNOWN",
      },
      { kind: metadata.kind, outcome: "done", code: null },
    ]);
  },
);
it.each(hostileText)(
  "redacts provider failed-frame code and handler reason %# while forwarding original frames",
  async (code) => {
    const { store } = setup(retentionLimits);
    const frame = {
      event: "response.failed",
      data: { response: { error: { code } } },
    };
    const streaming = recordedModelTurn(store, async () => ({
      ok: true,
      stream: (async function* () {
        yield frame;
      })(),
    }));
    const result = await streaming({ body: {}, headers: {} });
    if (!result.ok || !("stream" in result)) throw Error("fixture");
    for await (const forwarded of result.stream) expect(forwarded).toBe(frame);
    const refused = { ok: false, reason: code } as const;
    expect(
      await recordedModelTurn(
        store,
        async () => refused,
      )({ body: {}, headers: {} }),
    ).toBe(refused);
    await store.flush(5000);
    const snapshot = await store.snapshot(5000);
    expect(snapshot.entries).toMatchObject([
      { outcome: "failed", code: "provider_error" },
      { outcome: "refused", code: "provider_error" },
    ]);
    expect(JSON.stringify(supportWith(snapshot))).not.toContain("PRIVATE_");
  },
);

it.each([...hostileText, null, 42, { nested: "PRIVATE_PROMPT" }])(
  "classifies an upstream HTTP refusal without echo %# or retry",
  async (code) => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code } }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const handler = routeBModelTurnHandler(() => ({
        baseUrl: "http://fixture.invalid",
        token: "synthetic",
      }));
      expect(await handler({ body: {}, headers: {} })).toEqual({
        ok: false,
        reason: "provider_error",
      });
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it.each(["sync", "reject", "success"])(
  "observes the real updater wrapper's %s settlement",
  async (settlement) => {
    const { store } = setup(retentionLimits);
    const error = Error("PRIVATE_PROMPT");
    const value = { status: "ok" };
    const original =
      settlement === "reject" ? Promise.reject(error) : Promise.resolve(value);
    const discover = vi.fn(() => {
      if (settlement === "sync") throw error;
      return original;
    });
    const ports = recordedUpdaterPorts(store, {
      discover,
    } as unknown as import("../../src/modules/release/app/installed-updater").InstalledUpdaterPorts);
    if (settlement === "sync") {
      try {
        ports.discover();
        expect.unreachable();
      } catch (caught) {
        expect(caught).toBe(error);
      }
    } else {
      expect(ports.discover()).toBe(original);
      if (settlement === "reject") await expect(original).rejects.toBe(error);
      else await expect(original).resolves.toBe(value);
    }
    expect(discover).toHaveBeenCalledOnce();
    await store.flush(5000);
    expect((await store.snapshot(5000)).entries).toMatchObject([
      {
        kind: "update.check",
        outcome:
          settlement === "sync"
            ? "failed"
            : settlement === "reject"
              ? "unknown"
              : "done",
        code:
          settlement === "sync"
            ? "OPERATION_SYNC_THROW"
            : settlement === "reject"
              ? "OPERATION_OUTCOME_UNKNOWN"
              : null,
      },
    ]);
  },
);

it("validates only names from full owner workspace metadata and enriches a begun target safely", async () => {
  const { store } = setup(retentionLimits);
  store.setWorkspaceLabels([
    { workspaceId: "w", label: "Docs", root: "/private/OWNER_ROOT" } as never,
  ]);
  const mutable: OperationMetadata = {
    ...metadata,
    target: { workspace: "w" },
  };
  const finish = store.begin(mutable);
  Object.assign(mutable.target, { relativePath: "README.md" });
  finish("done", null, 1);
  await store.flush(5000);
  const snapshot = await store.snapshot(5000);
  expect(snapshot.entries[0]!.target).toEqual({
    workspace: "Docs",
    relativePath: "README.md",
  });
  expect(JSON.stringify(supportWith(snapshot))).not.toContain("OWNER_ROOT");
});

it("records an opaque synchronous exception even when inspecting it would throw", async () => {
  const { store } = setup(retentionLimits);
  const error = new Proxy(
    {},
    {
      get() {
        throw Error("PRIVATE_GETTER");
      },
    },
  );
  let caught: unknown;
  try {
    observeOperation(store, metadata, () => {
      throw error;
    });
  } catch (value) {
    caught = value;
  }
  expect(caught === error).toBe(true);
  await store.flush(5000);
  expect((await store.snapshot(5000)).entries).toMatchObject([
    { outcome: "failed", code: "OPERATION_SYNC_THROW" },
  ]);
});

it("preserves compaction's promise and synchronous exception through its actual wrapper", async () => {
  const { store } = setup(retentionLimits);
  const value = { ok: false, reason: "OPERATION_REFUSED" } as const;
  const original = Promise.resolve(value);
  const request = { body: {}, headers: {} };
  expect(recordedCompaction(store, () => original)(request)).toBe(original);
  await original;
  const error = Error("PRIVATE_PROMPT");
  try {
    recordedCompaction(store, () => {
      throw error;
    })(request);
    expect.unreachable();
  } catch (caught) {
    expect(caught).toBe(error);
  }
  await store.flush(5000);
  expect((await store.snapshot(5000)).entries).toMatchObject([
    {
      kind: "model.responses.compact",
      outcome: "refused",
      code: "OPERATION_REFUSED",
    },
    {
      kind: "model.responses.compact",
      outcome: "failed",
      code: "OPERATION_SYNC_THROW",
    },
  ]);
});
