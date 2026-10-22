import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// @ts-expect-error Mechanical launcher module is exercised at runtime.
import * as control from "../../tooling/dev-process-control.mjs";
const {
  correlateDevCommand,
  devControlTimeout,
  readDevRunMarker,
  retainedDevMarkerMatches,
} = control;

const root = "/synthetic/farol";
const scope = {
  uid: 501,
  writerRoot: root,
  appPath: `${root}/_output/build/app/main.cjs`,
  profilePath: "/synthetic/Library/Application Support/Farol Dev",
};
const executable = `${root}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`;
const marker = {
  pid: 111,
  bootTime: 10000,
  processStart: "Thu Oct  8 10:44:37 2026",
};
const native = {
  status: "present",
  pid: 111,
  uid: 501,
  token: "boot:123:456",
  commandVerified: true,
};
const command = `501 ${marker.processStart} ${executable} _output/build/app/main.cjs`;

describe("exact Dev command correlation", () => {
  it("continues exact-lifetime observation across normal marker removal but refuses replacement or unreadable bytes", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-dev-quit-marker-"),
    );
    const file = path.join(parent, "running.json");
    try {
      await fs.writeFile(file, JSON.stringify(marker), { mode: 0o600 });
      expect(retainedDevMarkerMatches(file, marker)).toBe(true);
      await fs.unlink(file); // Actual normal-Quit ordering, before process exit.
      expect(retainedDevMarkerMatches(file, marker)).toBe(true);
      await fs.symlink(path.join(parent, "absent-target"), file);
      expect(retainedDevMarkerMatches(file, marker)).toBe(false);
      await fs.unlink(file);
      await fs.writeFile(file, JSON.stringify({ ...marker, pid: 112 }), {
        mode: 0o600,
      });
      expect(retainedDevMarkerMatches(file, marker)).toBe(false);
      await fs.writeFile(file, "{");
      expect(retainedDevMarkerMatches(file, marker)).toBe(false);
      await fs.unlink(file);
      await fs.mkdir(file);
      expect(retainedDevMarkerMatches(file, marker)).toBe(false);
      expect(() =>
        correlateDevCommand(
          `501 ${marker.processStart} Farol Dev`,
          marker,
          scope,
          { ...native, token: "changed", pid: 112 },
          10000,
        ),
      ).toThrow("DEV_PROCESS_IDENTITY_REFUSED");
    } finally {
      await fs.rm(parent, { recursive: true });
    }
  });
  it("reads the actual private run-marker owner directory without doubling the filename", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-dev-marker-"));
    try {
      const state = path.join(root, "farol-state");
      await fs.mkdir(state, { mode: 0o700 });
      const value = {
        schema: 1,
        pid: 111,
        startedAt: "2026-10-08T09:44:38.119Z",
        bootTime: 10000,
        processStart: marker.processStart,
      };
      await fs.writeFile(
        path.join(state, "running.json"),
        JSON.stringify(value),
        { mode: 0o600 },
      );
      expect(await readDevRunMarker(root)).toEqual({
        status: "read",
        marker: value,
      });
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });
  it("uses positive integer subprocess budgets and refuses exhaustion before spawning", () => {
    expect(devControlTimeout(2999.75)).toBe(2999);
    expect(devControlTimeout(5000.125)).toBe(3000);
    for (const budget of [0, -1, 0.5, NaN, Infinity]) {
      expect(() => devControlTimeout(budget)).toThrow(
        "DEV_CONTROL_BUDGET_EXHAUSTED",
      );
    }
  });
  it("joins the private marker, precise lifetime and selected writer", () => {
    expect(
      correlateDevCommand(command, marker, scope, native, 10000),
    ).toMatchObject({
      pid: 111,
      startIdentity: native.token,
      appPath: scope.appPath,
      installed: false,
    });
  });
  it("accepts the observed macOS product title only with independent kernel command verification", () => {
    const line = `501 ${marker.processStart} Farol Dev`;
    expect(
      correlateDevCommand(line, marker, scope, native, 10000),
    ).toMatchObject({ pid: marker.pid, executable });
    for (const seen of [
      { ...native, commandVerified: false },
      { ...native, commandVerified: undefined },
    ]) {
      expect(() =>
        correlateDevCommand(line, marker, scope, seen, 10000),
      ).toThrow("DEV_PROCESS_IDENTITY_REFUSED");
    }
    for (const title of [
      "Farol",
      "Electron",
      "Farol Dev --user-data-dir=/foreign",
    ]) {
      expect(() =>
        correlateDevCommand(
          `501 ${marker.processStart} ${title}`,
          marker,
          scope,
          native,
          10000,
        ),
      ).toThrow("DEV_PROCESS_IDENTITY_REFUSED");
    }
  });
  it.each([
    command.replace(executable, "/Applications/Farol.app/Contents/MacOS/Farol"),
    command.replace("_output/build/app/main.cjs", "other.cjs"),
    `${command} --user-data-dir=/foreign`,
    `${command} --acceptance-profile`,
    `${command} --type=renderer`,
    command.replace("501", "502"),
    command.replace("10:44:37", "10:44:38"),
  ])("refuses foreign command or coarse marker disagreement", (line) => {
    expect(() =>
      correlateDevCommand(line, marker, scope, native, 10000),
    ).toThrow("DEV_PROCESS_IDENTITY_REFUSED");
  });
  it("refuses another boot and native UID/PID mismatch", () => {
    for (const [seen, boot] of [
      [native, 20000],
      [{ ...native, uid: 502 }, 10000],
      [{ ...native, pid: 112 }, 10000],
    ] as const) {
      expect(() =>
        correlateDevCommand(command, marker, scope, seen, boot),
      ).toThrow("DEV_PROCESS_IDENTITY_REFUSED");
    }
  });
});
