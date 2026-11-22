import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QUIT_TRACE_FILE_NAME,
  QUIT_TRACE_MAX_ATTEMPTS,
  QUIT_TRACE_MAX_PENDING,
  createQuitTrace,
  retainQuitTrace,
  writeQuitTrace,
} from "./trace";

const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "farol-quit-trace-"));
  roots.push(dir);
  const state = path.join(dir, "state");
  await fs.mkdir(state, { mode: 0o700 });
  return state;
}
afterEach(async () => {
  for (const dir of roots.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

const line = (lifetime: string, attempt: string, stage = "drain-entered") =>
  JSON.stringify({ lifetime, attempt, ms: 0, stage });

describe("Quit trace: diagnostic, bounded, never in the Quit path", () => {
  it("keeps only the newest attempts within the attempt and byte limits", () => {
    const lines = Array.from({ length: 15 }, (_, i) => line("p", `a${i}`));
    const kept = retainQuitTrace(["not json", ...lines]);
    expect(kept).toHaveLength(QUIT_TRACE_MAX_ATTEMPTS);
    expect(kept[0]).toContain('"a5"');
    expect(kept.at(-1)).toContain('"a14"');
    const huge = line("p", "big", "x".repeat(70 * 1024));
    expect(retainQuitTrace([line("p", "small"), huge])).toEqual([]);
    // A large newest attempt keeps its newest stages instead of nothing.
    const many = Array.from({ length: 800 }, (_, i) =>
      line("p", "loud", `signal-${i}-${"y".repeat(80)}`),
    );
    const tail = retainQuitTrace([line("p", "older"), ...many]);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.at(-1)).toBe(many.at(-1));
    expect(
      tail.reduce((sum, l) => sum + Buffer.byteLength(l, "utf8") + 1, 0),
    ).toBeLessThanOrEqual(64 * 1024);
  });

  it("records content-free stages of one attempt and writes a private file", async () => {
    const state = await root();
    let t = 0;
    const trace = createQuitTrace({
      directory: state,
      pid: 42,
      now: () => (t += 5),
    });
    trace.record({ stage: "before-quit", during: "running" });
    trace.record({ stage: "drain-entered" });
    trace.record({ stage: "exit-requested" });
    await trace.flushed();
    const file = path.join(state, QUIT_TRACE_FILE_NAME);
    const info = await fs.lstat(file);
    expect(info.mode & 0o777).toBe(0o600);
    const records = (await fs.readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(records.map((r) => r.stage)).toEqual([
      "before-quit",
      "drain-entered",
      "exit-requested",
    ]);
    expect(new Set(records.map((r) => r.attempt)).size).toBe(1);
    expect(records[0].lifetime).toMatch(/^42-/u);
    expect(records.every((r) => r.ms >= 0)).toBe(true);
  });

  it("never throws or blocks when the writer fails, and bounds the queue", async () => {
    let release!: () => void;
    const write = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          release = () => reject(new Error("disk"));
        }),
    );
    const trace = createQuitTrace({ directory: "/unused", pid: 1, write });
    for (let i = 0; i < QUIT_TRACE_MAX_PENDING + 50; i++)
      expect(() => trace.record({ stage: "second-quit" })).not.toThrow();
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    release();
    await trace.flushed();
    expect(trace.dropped()).toBeGreaterThan(0);
  });

  it("serializes writes in record order across batches", async () => {
    const batches: string[][] = [];
    const trace = createQuitTrace({
      directory: "/unused",
      pid: 1,
      write: async (_dir, records) => {
        batches.push(records.map((r) => JSON.parse(r).stage));
      },
    });
    trace.record({ stage: "drain-entered" });
    await Promise.resolve();
    trace.record({ stage: "record-begin" });
    trace.record({ stage: "exit-requested" });
    await trace.flushed();
    expect(batches.flat()).toEqual([
      "drain-entered",
      "record-begin",
      "exit-requested",
    ]);
  });

  it("refuses a symlinked or shared trace target", async () => {
    const state = await root();
    const other = path.join(path.dirname(state), "elsewhere");
    await fs.writeFile(other, "");
    await fs.symlink(other, path.join(state, QUIT_TRACE_FILE_NAME));
    await expect(writeQuitTrace(state, [line("p", "a")])).rejects.toThrow();
    await fs.rm(path.join(state, QUIT_TRACE_FILE_NAME));
    await fs.writeFile(path.join(state, QUIT_TRACE_FILE_NAME), "", {
      mode: 0o644,
    });
    await expect(writeQuitTrace(state, [line("p", "a")])).rejects.toThrow(
      "QUIT_TRACE_STATE_UNSAFE",
    );
  });

  it("counts the byte cap in UTF-8 bytes", () => {
    const wide = (attempt: string) =>
      JSON.stringify({
        lifetime: "p",
        attempt,
        ms: 0,
        stage: "é".repeat(4_000),
      });
    const kept = retainQuitTrace(
      Array.from({ length: 10 }, (_, i) => wide(`a${i}`)),
    );
    const bytes = kept.reduce(
      (sum, l) => sum + Buffer.byteLength(l, "utf8") + 1,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
    expect(kept.length).toBeLessThan(10);
  });

  it("refuses a non-regular target and opens the existing trace nonblocking", async () => {
    const state = await root();
    const target = path.join(state, QUIT_TRACE_FILE_NAME);
    const { createServer } = await import("node:net");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(target, resolve));
    try {
      await expect(writeQuitTrace(state, [line("p", "a")])).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await fs.rm(target, { force: true });
    await fs.writeFile(target, `${line("p", "old")}\n`, { mode: 0o600 });
    const open = vi.spyOn(fs, "open");
    try {
      await writeQuitTrace(state, [line("p", "new")]);
      const readFlags = open.mock.calls.find(([file]) => file === target)?.[1];
      expect(typeof readFlags).toBe("number");
      expect((readFlags as number) & fsConstants.O_NONBLOCK).toBe(
        fsConstants.O_NONBLOCK,
      );
    } finally {
      open.mockRestore();
    }
  });

  it("never reads an oversized trace, even one made of valid records", async () => {
    const state = await root();
    const target = path.join(state, QUIT_TRACE_FILE_NAME);
    const valid = Array.from({ length: 2_000 }, (_, i) =>
      line("old", `a${i % 5}`, "x".repeat(60)),
    ).join("\n");
    expect(Buffer.byteLength(valid)).toBeGreaterThan(128 * 1024);
    await fs.writeFile(target, `${valid}\n`, { mode: 0o600 });
    const original = fs.open.bind(fs);
    let reads = 0;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await original(...(args as Parameters<typeof fs.open>));
      if (args[0] === target) {
        const read = handle.read.bind(handle);
        const readFile = handle.readFile.bind(handle);
        handle.read = ((...rest: unknown[]) => {
          reads++;
          return (read as (...a: unknown[]) => unknown)(...rest);
        }) as typeof handle.read;
        handle.readFile = ((...rest: unknown[]) => {
          reads++;
          return (readFile as (...a: unknown[]) => unknown)(...rest);
        }) as typeof handle.readFile;
      }
      return handle;
    });
    try {
      await writeQuitTrace(state, [line("p", "fresh")]);
    } finally {
      open.mockRestore();
    }
    expect(reads).toBe(0);
    expect((await fs.readFile(target, "utf8")).trim()).toBe(line("p", "fresh"));
  });
});
