import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  selectRuntimeProcesses,
  readRuntimeProcessSnapshots,
  killRuntimeProcess,
  readOwnedChildProcesses,
} from "../e2e/runtime-process.mjs";

const stamp = "Wed Oct 14 11:12:13 2026";
const row = (pid, parent, command) =>
  `${pid} ${parent} 1024 ${stamp} ${command}\n`;
const primary = row(100, 1, "/fixture/Electron /fixture/main.cjs");

const absent = () =>
  Object.assign(new Error("no matches"), {
    status: 1,
    signal: null,
    stdout: "",
    stderr: "",
  });

describe("E2E owned local runtime identity", () => {
  it("finds a direct Node IPC child outside Electron metrics, including spaced private paths", () => {
    const table =
      primary +
      row(
        101,
        100,
        "/fixture/Electron /private/owned profile/installed-execution/build/runtime.cjs",
      ) +
      row(102, 200, "/foreign/runtime.cjs");
    expect(
      selectRuntimeProcesses(table, 100).map((x) => [x.pid, x.kind, x.rssKiB]),
    ).toEqual([[101, "node-ipc", 1024]]);
  });
  it("does not select helpers, a substring match, an extra argument, or another parent's child", () => {
    expect(
      selectRuntimeProcesses(
        primary +
          row(101, 100, "/fixture/Helper --renderer") +
          row(102, 100, "/fixture/runtime.cjs.extra") +
          row(103, 100, "/fixture/runtime.cjs --other") +
          row(104, 200, "/fixture/runtime.cjs"),
        100,
      ),
    ).toEqual([]);
  });
  it("binds historical utility metrics to the same native parent", () => {
    expect(
      selectRuntimeProcesses(
        primary +
          row(101, 100, "/fixture/Utility --service") +
          row(102, 200, "/foreign/Utility"),
        100,
        [101, 102],
      ).map((x) => [x.pid, x.kind]),
    ).toEqual([[101, "historical-utility"]]);
  });
  it("retains ambiguity rather than choosing the first runtime", () => {
    expect(
      selectRuntimeProcesses(
        primary +
          row(101, 100, "/first/runtime.cjs") +
          row(102, 100, "/second/runtime.cjs"),
        100,
      ),
    ).toHaveLength(2);
  });
  it("refuses unknown primary and malformed native observations", () => {
    expect(() =>
      selectRuntimeProcesses(row(101, 100, "/fixture/runtime.cjs"), 100),
    ).toThrow("PRIMARY_UNCONFIRMED");
    expect(() =>
      selectRuntimeProcesses(primary + "unparseable observation\n", 100),
    ).toThrow("TABLE_INVALID");
    expect(() => selectRuntimeProcesses(primary, 0)).toThrow("INPUT_INVALID");
  });
  it("queries only the owned parent and returned PIDs, retaining token metadata", () => {
    const calls = [];
    const snapshots = readOwnedChildProcesses(100, (file, args) => {
      calls.push([file, args]);
      return calls.length === 1
        ? "101\n102\n"
        : primary +
            row(101, 100, "/fixture/farol-backend serve") +
            row(102, 200, "/foreign/reparented");
    });
    expect(calls).toEqual([
      ["/usr/bin/pgrep", ["-P", "100"]],
      [
        "/bin/ps",
        ["-ww", "-p", "100,101,102", "-o", "pid=,ppid=,rss=,lstart=,command="],
      ],
    ]);
    expect(snapshots).toEqual([
      {
        pid: 101,
        parentPid: 100,
        rssKiB: 1024,
        processStart: stamp,
        command: "/fixture/farol-backend serve",
      },
    ]);
  });
  it("accepts only the tools' explicit no-match result as an empty sample", () => {
    expect(
      readOwnedChildProcesses(100, () => {
        throw absent();
      }),
    ).toEqual([]);
  });
  it.each([
    { status: 3, signal: null, stdout: "", stderr: "permission denied" },
    { status: 1, signal: null, stdout: "", stderr: "permission denied" },
    { status: 1, signal: null, stdout: "101\n", stderr: "" },
    { status: null, signal: "SIGTERM", stdout: "", stderr: "" },
    { code: "EPERM" },
  ])(
    "keeps observation failure unknown without a wider query %#",
    (failure) => {
      let calls = 0;
      expect(() =>
        readOwnedChildProcesses(100, () => {
          calls++;
          throw Object.assign(new Error("native failure"), failure);
        }),
      ).toThrow("OBSERVATION_UNKNOWN");
      expect(calls).toBe(1);
    },
  );
  it.each(["", "0\n", "100\n", "101\n101\n", "101,102\n", "2147483648\n"])(
    "refuses malformed parent-scoped PID output %#",
    (output) => {
      let calls = 0;
      expect(() =>
        readOwnedChildProcesses(100, () => {
          calls++;
          return output;
        }),
      ).toThrow("TABLE_INVALID");
      expect(calls).toBe(1);
    },
  );
  it("refuses unexpected metadata instead of broadening the selected set", () => {
    let calls = 0;
    expect(() =>
      readOwnedChildProcesses(100, () =>
        ++calls === 1 ? "101\n" : primary + row(999, 100, "/unexpected/child"),
      ),
    ).toThrow("TABLE_INVALID");
  });
  it("does not claim children when their selected parent cannot be observed", () => {
    let calls = 0;
    expect(() =>
      readOwnedChildProcesses(100, () =>
        ++calls === 1 ? "101\n" : row(101, 100, "/fixture/child"),
      ),
    ).toThrow("PRIMARY_UNCONFIRMED");
  });
  it("observes a real Node IPC child and refuses a changed identity before fault injection", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-runtime-witness-"),
    );
    const entry = path.join(root, "runtime.cjs");
    await fs.writeFile(
      entry,
      'process.send("ready"); process.on("message",()=>process.exit(0));',
    );
    const child = spawn(process.execPath, [entry], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const closed = once(child, "close");
    let clean = false;
    try {
      await once(child, "message");
      const snapshot = readRuntimeProcessSnapshots(process.pid).find(
        (x) => x.pid === child.pid,
      );
      expect(snapshot?.kind).toBe("node-ipc");
      expect(() =>
        killRuntimeProcess({ ...snapshot, processStart: "changed" }),
      ).toThrow("PROCESS_CHANGED");
      expect(child.connected).toBe(true);
      child.send("shutdown");
      expect(await closed).toEqual([0, null]);
      clean = true;
    } finally {
      if (!clean) child.kill("SIGTERM");
      await closed;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15000);
});
