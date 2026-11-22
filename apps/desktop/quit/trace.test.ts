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
    await Promise.resolve();
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
});
