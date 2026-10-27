import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OWNER_FILE,
  POLICY,
  PROTECTED_EVIDENCE,
  inspectOutput,
  protectedEvidence,
  pruneOutput,
} from "../../tooling/output-retention.mjs";
import { settleDevControl } from "../../tooling/dev-process-control.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-27T12:00:00Z");
const START = "Tue Oct 27 10:00:00 2026";

// Real disposable filesystem; the process table is an injected observation.
describe("_output retention", () => {
  let root, output;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-output-")),
    );
    output = path.join(root, "_output");
    await fs.mkdir(path.join(output, "tmp"), { recursive: true });
    await fs.mkdir(path.join(output, "evidence"), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function entry(relative, { ageDays = 0, bytes = 16, owner } = {}) {
    const directory = path.join(output, relative);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "data"), Buffer.alloc(bytes));
    if (owner)
      await fs.writeFile(
        path.join(directory, OWNER_FILE),
        JSON.stringify({ schema: 1, ...owner }),
      );
    const time = new Date(NOW - ageDays * DAY);
    for (const name of await fs.readdir(directory))
      await fs.utimes(path.join(directory, name), time, time);
    await fs.utimes(directory, time, time);
    return directory;
  }
  const observe = (processes = [], open = []) => ({ processes, open });
  const prune = (observation, policy = POLICY) =>
    pruneOutput(root, {
      observation,
      observe: () => observation,
      now: NOW,
      policy,
      protect: PROTECTED_EVIDENCE,
    });
  const exists = (directory) =>
    fs.lstat(directory).then(
      () => true,
      () => false,
    );

  it("removes owned scratch only once its owner, group and users are gone", async () => {
    const owner = { pid: 4242, pgid: 4240, start: START };
    const gone = await entry("tmp/go-dev-control-AAAAAA", { owner });
    const running = await entry("tmp/go-dev-control-BBBBBB", {
      owner: { ...owner, pid: 4343 },
    });
    // A group leader killed while its child lives on in the same group.
    const child = await entry("tmp/go-dev-control-CCCCCC", {
      owner: { ...owner, pid: 5000, pgid: 5000 },
    });
    const opened = await entry("tmp/go-dev-control-DDDDDD", {
      owner: { ...owner, pgid: 6000 },
    });
    const unowned = await entry("tmp/retirement-boot-123", { ageDays: 30 });
    const result = await prune(
      observe(
        [
          { pid: 4343, pgid: 1, start: START, command: "node" },
          // The creator was killed; its child in the same group lives on.
          { pid: 5001, pgid: 5000, start: START, command: "go test" },
        ],
        [path.join(opened, "data")],
      ),
    );
    expect(await exists(gone)).toBe(false);
    for (const kept of [running, child, opened, unowned])
      expect(await exists(kept)).toBe(true);
    expect(
      result.entries.find(({ path: item }) => item === unowned).state,
    ).toBe("unknown");
  });

  it("treats a reused pid with a different start time as a finished owner", async () => {
    const reused = await entry("tmp/go-artifact-EEEEEE", {
      owner: { pid: 77, pgid: 77, start: START },
    });
    await prune(
      observe([
        { pid: 77, pgid: 9, start: "Tue Oct 27 11:59:00 2026", command: "x" },
      ]),
    );
    expect(await exists(reused)).toBe(false);
  });

  it("never removes declared evidence, however old or large", async () => {
    const declared = await Promise.all(
      PROTECTED_EVIDENCE.map((name) =>
        entry(`evidence/${name}`, { ageDays: 90 }),
      ),
    );
    await prune(observe(), { ...POLICY, evidenceCapBytes: 0 });
    for (const directory of declared)
      expect(await exists(directory)).toBe(true);
  });

  it("expires finished undeclared evidence and enforces the cap oldest first", async () => {
    const expired = await entry("evidence/old-run", { ageDays: 8 });
    const older = await entry("evidence/older-week", {
      ageDays: 3,
      bytes: 64 * 1024,
    });
    const newer = await entry("evidence/newer-week", {
      ageDays: 1,
      bytes: 64 * 1024,
    });
    await prune(observe(), { ...POLICY, evidenceCapBytes: 100 * 1024 });
    expect(await exists(expired)).toBe(false);
    expect(await exists(older)).toBe(false);
    expect(await exists(newer)).toBe(true);
  });

  it("keeps undeclared evidence a live writer still uses, even over the cap", async () => {
    const written = await entry("evidence/writing-now", { ageDays: 0 });
    const held = await entry("evidence/held-open", { ageDays: 9 });
    const named = await entry("evidence/named-in-argv", { ageDays: 9 });
    await prune(
      observe(
        [{ pid: 1, pgid: 1, start: START, command: `node script ${named}` }],
        [path.join(held, "data")],
      ),
      { ...POLICY, evidenceCapBytes: 0 },
    );
    for (const directory of [written, held, named])
      expect(await exists(directory)).toBe(true);
    // Once the writer has finished, the same entry becomes removable.
    await prune(observe(), { ...POLICY, evidenceCapBytes: 0 });
    for (const directory of [held, named])
      expect(await exists(directory)).toBe(false);
  });

  it("keeps everything when the process table cannot be read", async () => {
    const scratch = await entry("tmp/go-dev-control-FFFFFF", {
      owner: { pid: 1, pgid: 1, start: START },
    });
    const old = await entry("evidence/old-run", { ageDays: 30 });
    await pruneOutput(root, {
      observation: null,
      now: NOW,
      protect: PROTECTED_EVIDENCE,
    });
    expect(await exists(scratch)).toBe(true);
    expect(await exists(old)).toBe(true);
  });

  it("reports top-level entries no producer owns without removing them", async () => {
    const legacy = await entry("preserved-package-old", { ageDays: 60 });
    await entry("build/app");
    const report = await inspectOutput(root, {
      observation: observe(),
      now: NOW,
      protect: PROTECTED_EVIDENCE,
    });
    const states = Object.fromEntries(
      report.entries.map(({ path: item, state }) => [
        path.relative(output, item),
        state,
      ]),
    );
    expect(states).toMatchObject({
      "preserved-package-old": "unknown",
      build: "current",
    });
    await prune(observe());
    expect(await exists(legacy)).toBe(true);
  });

  it("re-observes before removal and keeps an entry first used after the scan", async () => {
    const owner = { pid: 4242, pgid: 4240, start: START };
    const scratch = await entry("tmp/go-artifact-GGGGGG", { owner });
    await pruneOutput(root, {
      observation: observe(),
      observe: () => observe([], [path.join(scratch, "data")]),
      now: NOW,
      protect: PROTECTED_EVIDENCE,
    });
    expect(await exists(scratch)).toBe(true);
  });

  it("never walks a redirected scratch root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "farol-outside-"));
    try {
      await fs.mkdir(path.join(outside, "go-artifact-HHHHHH"));
      await fs.writeFile(
        path.join(outside, "go-artifact-HHHHHH", OWNER_FILE),
        JSON.stringify({ schema: 1, pid: 4242, pgid: 4240, start: START }),
      );
      await fs.rm(path.join(output, "tmp"), { recursive: true });
      await fs.symlink(outside, path.join(output, "tmp"));
      const result = await prune(observe());
      expect(await exists(path.join(outside, "go-artifact-HHHHHH"))).toBe(true);
      expect(
        result.entries.find(({ path: item }) => item.endsWith("_output/tmp"))
          .state,
      ).toBe("unknown");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("budgets only what can accumulate, not current or protected output", async () => {
    await entry("package/Farol.app", { bytes: 64 * 1024 });
    await entry(`evidence/${PROTECTED_EVIDENCE[0]}`, { bytes: 64 * 1024 });
    const legacy = await entry("preserved-package-old", { bytes: 8 * 1024 });
    const report = await inspectOutput(root, {
      observation: observe(),
      now: NOW,
      protect: PROTECTED_EVIDENCE,
    });
    const legacyBytes = report.entries.find(
      ({ path: item }) => item === legacy,
    ).bytes;
    expect(report.budgetedBytes).toBe(legacyBytes);
    expect(report.totalBytes).toBeGreaterThan(report.budgetedBytes);
  });

  it("keeps a stop helper retained as evidence and releases any other", async () => {
    const owner = { pid: 4242, pgid: 4240, start: START };
    const retained = await entry("tmp/go-dev-control-IIIIII", { owner });
    const released = await entry("tmp/go-dev-control-JJJJJJ", { owner });
    await settleDevControl({
      root,
      binary: path.join(retained, "dev-control"),
      retain: true,
    });
    await settleDevControl({
      root,
      binary: path.join(released, "dev-control"),
      retain: false,
    });
    expect(await exists(released)).toBe(false);
    const result = await prune(observe());
    expect(await exists(retained)).toBe(true);
    expect(
      result.entries.find(({ path: item }) => item === retained).state,
    ).toBe("unknown");
  });

  it("judges an owner inside a foreign process group by references only", async () => {
    // Created from a long-lived shell: the shell's group stays alive.
    const scratch = await entry("tmp/go-artifact-KKKKKK", {
      owner: { pid: 4242, pgid: 100, start: START },
    });
    await prune(
      observe([{ pid: 100, pgid: 100, start: START, command: "zsh" }]),
    );
    expect(await exists(scratch)).toBe(false);
  });

  it("protects every evidence name the repository reads by path", () => {
    const names = protectedEvidence(path.resolve("."));
    expect(names).toEqual(
      expect.arrayContaining(["predecessors", "setup-journey", "hunt"]),
    );
    expect(protectedEvidence(root)).toBeNull();
    const trailing = protectedEvidence(root, () => ({
      status: 0,
      stdout: "_output/evidence/sealed-run.\n_output/evidence/prefix-\n",
    }));
    expect(trailing).toEqual(expect.arrayContaining(["sealed-run", "prefix-"]));
  });

  it("keeps all evidence when the by-path consumers cannot be read", async () => {
    const old = await entry("evidence/old-run", { ageDays: 30 });
    await pruneOutput(root, {
      observation: observe(),
      observe: () => observe(),
      now: NOW,
      protect: null,
    });
    expect(await exists(old)).toBe(true);
  });

  it("refuses to walk a redirected _output", async () => {
    const real = await fs.mkdtemp(path.join(os.tmpdir(), "farol-real-out-"));
    try {
      await fs.rm(output, { recursive: true });
      await fs.symlink(real, output);
      await expect(
        inspectOutput(root, { observation: observe(), now: NOW }),
      ).rejects.toThrow("OUTPUT_ROOT_NOT_OWNED_DIRECTORY");
    } finally {
      await fs.rm(real, { recursive: true, force: true });
    }
  });
});
