import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperationsStore } from "../../apps/desktop/operations/store";
import {
  operationResult,
  observeOperation,
} from "../../apps/desktop/operations/observe";
import { configurationOperation } from "../../apps/desktop/operations/configuration";
import { recordedModelTurn } from "../../apps/desktop/operations/model-turn";
import type { ProductConfigurationCommand } from "../../src/pkg/product-settings/contract";
import type { FarolModelSseEvent } from "../../src/apps/desktop/farol-model-endpoint";
const roots: string[] = [];
afterEach(() => {
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
  return {
    directory,
    now: (n: number) => (now += n),
    store: new OperationsStore(directory, () => now, limits),
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
    expect(store.snapshot().entries).toMatchObject([
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
it("survives restart and skips/counts corrupt and content-bearing lines", () => {
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
  const file = path.join(
    directory,
    fs.readdirSync(directory).find((f) => f.endsWith(".jsonl"))!,
  );
  fs.appendFileSync(
    file,
    "corrupt\n" +
      JSON.stringify({
        ...store.snapshot().entries[0],
        prompt: "PRIVATE-CANARY",
      }) +
      "\n",
  );
  const restarted = new OperationsStore(directory, () => 1792670400000);
  expect(restarted.snapshot()).toMatchObject({
    entries: [{ outcome: "unknown", durationMs: 12 }],
    corruptLines: 2,
  });
  expect(JSON.stringify(restarted.snapshot())).not.toContain("PRIVATE-CANARY");
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
});
it("bounds disk bytes, age and entry count across independent writer lifetimes", () => {
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
  expect(f.store.snapshot().entries.length).toBeGreaterThan(0);
  expect(f.store.snapshot().entries.length).toBeLessThanOrEqual(4);
  expect(
    fs
      .readdirSync(f.directory)
      .reduce(
        (n, file) => n + fs.statSync(path.join(f.directory, file)).size,
        0,
      ),
  ).toBeLessThanOrEqual(1500);
  f.now(31 * 86400000);
  expect(f.store.snapshot().entries).toEqual([]);
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
  expect(
    store
      .snapshot()
      .entries.map((e) => e.outcome)
      .sort(),
  ).toEqual(["done", "pending", "unknown"]);
  expect(JSON.stringify(store.snapshot())).not.toContain("PRIVATE-CANARY");
});
it("refuses unsafe files and extraneous metadata without following symlinks", () => {
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
  expect(store.snapshot().entries).toEqual([]);
  expect(store.snapshot().writeFailures).toBe(1);
  const target = path.join(directory, "outside");
  fs.writeFileSync(target, "secret");
  fs.symlinkSync(
    target,
    path.join(
      directory,
      "1792670400000-00000000-0000-4000-8000-000000000000.jsonl",
    ),
  );
  expect(store.snapshot().corruptLines).toBe(1);
  expect(fs.readFileSync(target, "utf8")).toBe("secret");
});
it("uses names-only workspace labels and excludes paths, arguments and payloads", () => {
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
  expect(store.snapshot().entries[0]?.target).toEqual({
    workspace: "Docs",
    relativePath: "README.md",
  });
  expect(Object.keys(store.snapshot().entries[0]!).sort()).toEqual([
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
  expect(store.snapshot().entries).toMatchObject([
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
  expect(JSON.stringify(store.snapshot())).not.toMatch(/PRIVATE/);
});

it("retains an unmatched start across process replacement and appends its observation without editing it", async () => {
  const { store, directory } = setup();
  const finish = store.begin({
    source: "You",
    kind: "workspace.write",
    target: { relativePath: "x" },
  });
  const before = new OperationsStore(directory, () => 1792670400000).snapshot();
  expect(before.entries).toMatchObject([
    { outcome: "pending", lifecycle: { phase: "started" } },
  ]);
  const file = path.join(
    directory,
    fs.readdirSync(directory).find((f) => f.endsWith(".jsonl"))!,
  );
  const original = fs.readFileSync(file, "utf8");
  finish("unknown", "WRITE_UNCONFIRMED", 20);
  expect(fs.readFileSync(file, "utf8").startsWith(original)).toBe(true);
  expect(store.snapshot().entries).toMatchObject([
    { outcome: "unknown", lifecycle: { phase: "observed" } },
  ]);
  finish("done", null, 30);
  expect(store.snapshot().entries[0]?.outcome).toBe("unknown");
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
  expect(store.snapshot().entries).toMatchObject([
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
it("separates a damaged trailing line before appending the next valid observation", () => {
  const { store, directory } = setup({
    days: 30,
    bytes: 8192,
    segmentBytes: 4096,
    entries: 100,
  });
  store.record({ source: "You", kind: "first", target: {} }, "done", null, 1);
  const file = path.join(
    directory,
    fs.readdirSync(directory).find((f) => f.endsWith(".jsonl"))!,
  );
  fs.appendFileSync(file, "{broken tail");
  store.record({ source: "You", kind: "next", target: {} }, "done", null, 2);
  expect(
    store
      .snapshot()
      .entries.map((e) => e.kind)
      .sort(),
  ).toEqual(["first", "next"]);
  expect(store.snapshot().corruptLines).toBe(1);
});
