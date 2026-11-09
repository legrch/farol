// Inert process/stream doubles only; no Electron, native probe or filesystem effects.
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import {
  collectDesktopExit,
  requireDesktopExit,
  qualifyDesktopMain,
  qualifyGuardianAfterExec,
} from "../e2e/lib/desktop-main-identity.mjs";
import {
  predecessorIdentity,
  createUpdateRequest,
  publishAndStage,
} from "../e2e/lib/owner-beta-update-pair.mjs";

const identity = { guardianPid: 100, desktopPid: 101 };
const terminal = { pid: 100, code: 0, signal: null };
async function observation(text) {
  const stream = new PassThrough();
  const collector = collectDesktopExit(stream);
  stream.end(text);
  await once(stream, "end");
  return collector.snapshot();
}
function original(guardianPid = 100, desktopPid = 101) {
  const guardianNative = {
    parentPid: 90,
    startSeconds: "1",
    startMicroseconds: "2",
    executable: "/app/farol-backend",
  };
  const desktopNative = {
    parentPid: guardianPid,
    startSeconds: "3",
    startMicroseconds: "4",
    executable: "/app/Electron",
  };
  const owner = {
    child: { pid: guardianPid, exitCode: null, signalCode: null },
    guardianStart: "guardian-birth",
    guardianNative,
    desktopNative,
    desktopIdentity: { guardianPid, desktopPid },
    marker: { pid: desktopPid, processStart: "desktop-birth" },
  };
  return {
    owner,
    start: (pid) =>
      pid === guardianPid
        ? "guardian-birth"
        : pid === desktopPid
          ? "desktop-birth"
          : null,
    native: (pid) =>
      pid === guardianPid
        ? { ...guardianNative }
        : pid === desktopPid
          ? { ...desktopNative }
          : null,
  };
}

describe("guardian executable establishment", () => {
  const before = {
    parentPid: 90,
    startSeconds: "1",
    startMicroseconds: "2",
    executable: "/bin/sh",
  };
  const backend = { ...before, executable: "/candidate/farol-backend" };
  const qualify = (after, early = before) =>
    qualifyGuardianAfterExec({
      before: early,
      after,
      expectedExecutable: backend.executable,
    });
  it("allows shell-to-Go exec under the original kernel lifetime", () => {
    const stable = qualify(backend);
    expect(stable).toEqual(backend);
    expect(stable).not.toBe(backend);
    expect(qualify(backend, backend)).toEqual(backend);
  });
  it.each([
    { ...backend, parentPid: 91 },
    { ...backend, startSeconds: "3" },
    { ...backend, startMicroseconds: "4" },
    before,
    { ...backend, executable: "/foreign/farol-backend" },
    { ...backend, startSeconds: undefined },
    { ...backend, startMicroseconds: "" },
    { ...backend, parentPid: null },
  ])("refuses a different lifetime or an unestablished executable", (after) => {
    expect(() => qualify(after)).toThrow();
  });
  it("refuses an incomplete original kernel identity", () => {
    expect(() => qualify(backend, { executable: "/bin/sh" })).toThrow();
  });
});

describe("packaged desktop lifetime admission", () => {
  it("retains actual guardian Wait separately from its original Electron Wait diagnostic", async () => {
    const value = requireDesktopExit(
      await observation(
        "diagnostic\ndesktop_launcher_desktop_exit pid=101 code=0\n",
      ),
      identity,
      terminal,
    );
    expect(value).toEqual({
      pid: 101,
      code: 0,
      signal: null,
      source: "guardian-native-wait",
      guardianTerminal: terminal,
    });
    expect(value.guardianTerminal.pid).toBe(100);
  });
  it.each([
    "",
    "desktop_launcher_desktop_exit pid=102 code=0\n",
    "desktop_launcher_desktop_exit pid=101 code=1\n",
    "desktop_launcher_desktop_exit pid=101 code=0\ndesktop_launcher_desktop_exit pid=101 code=0\n",
    "desktop_launcher_desktop_exit pid=101 code=unknown\n",
    "x".repeat(4097),
    "x".repeat(4097) + "\n",
  ])(
    "rejects missing, foreign, failed, duplicate, malformed or overflowing original Wait",
    async (text) => {
      const value = await observation(text);
      expect(() => requireDesktopExit(value, identity, terminal)).toThrow();
    },
  );
  it.each([
    { ...terminal, pid: 102 },
    { ...terminal, code: 1 },
    { ...terminal, signal: "SIGTERM" },
  ])(
    "does not substitute a guardian failure for a clean desktop terminal",
    async (exit) => {
      const value = await observation(
        "desktop_launcher_desktop_exit pid=101 code=0\n",
      );
      expect(() => requireDesktopExit(value, identity, exit)).toThrow();
    },
  );
  it("requires the original complete output stream", () => {
    const stream = new PassThrough();
    const collector = collectDesktopExit(stream);
    stream.write("desktop_launcher_desktop_exit pid=101 code=0\n");
    expect(() =>
      requireDesktopExit(collector.snapshot(), identity, terminal),
    ).toThrow();
    stream.destroy();
  });
  it("rejects a sibling, missing child, foreign executable or changed native birth", () => {
    const sample = {
      packaged: true,
      guardianPid: 100,
      marker: { pid: 101, processStart: "birth" },
      desktop: { pid: 101, ppid: 100, executable: "/candidate/Electron" },
      children: [{ pid: 101, parentPid: 100, processStart: "birth" }],
      expectedExecutable: "/candidate/Electron",
      nativeExecutable: {
        parentPid: 100,
        executable: "/candidate/Electron",
        startSeconds: "1",
        startMicroseconds: "2",
      },
    };
    sample.nativeExecutableBefore = { ...sample.nativeExecutable };
    expect(qualifyDesktopMain(sample).desktopPid).toBe(101);
    for (const changed of [
      { desktop: { ...sample.desktop, ppid: 99 } },
      { marker: { ...sample.marker, pid: 102 } },
      { children: [] },
      {
        nativeExecutable: {
          ...sample.nativeExecutable,
          executable: "/foreign/Electron",
        },
      },
      {
        nativeExecutable: {
          ...sample.nativeExecutable,
          startMicroseconds: "3",
        },
      },
    ])
      expect(() => qualifyDesktopMain({ ...sample, ...changed })).toThrow();
  });
});

describe("one original desktop binding for every update predecessor", () => {
  it.each(["apply", "rollback"])(
    "carries the desktop PID and its birth through %s publication and staging",
    async (action) => {
      const { owner, start, native } = original(
        action === "apply" ? 100 : 200,
        action === "apply" ? 101 : 201,
      );
      const candidate = (buildId, digest) => ({
        buildId,
        artifactSha256: digest,
        build: { version: "0.5.22" },
        appPath: "/fixture/target.app",
      });
      const pair = {
        source: candidate("source", "old"),
        target: candidate("target", "new"),
      };
      const request = createUpdateRequest(
        {
          pair,
          home: { home: "/fixture/home" },
          operationId: "operation",
          action,
          predecessor: owner,
        },
        start,
        native,
      );
      expect(request.pid).toBe(owner.desktopIdentity.desktopPid);
      expect(request.pid).not.toBe(owner.child.pid);
      expect(request.processStart).toBe("desktop-birth");
      const seen = [];
      await publishAndStage(
        pair.target,
        "/fixture/operation",
        request,
        {},
        [],
        {
          publish: async (_target, _operation, input) => {
            seen.push(input.pid);
            expect(input).toMatchObject(
              predecessorIdentity(owner, start, native),
            );
          },
          copy: async () => seen.push("copy"),
        },
      );
      expect(seen).toEqual([owner.desktopIdentity.desktopPid, "copy"]);
    },
  );
  it.each([
    (owner) => ({
      ...owner,
      desktopIdentity: {
        ...owner.desktopIdentity,
        desktopPid: owner.child.pid,
      },
    }),
    (owner) => ({ ...owner, marker: { ...owner.marker, pid: 999 } }),
    (owner) => ({ ...owner, child: { ...owner.child, exitCode: 0 } }),
    (owner) => ({ ...owner, child: { ...owner.child, signalCode: "SIGTERM" } }),
    (owner) => ({ ...owner, guardianStart: "stale" }),
    (owner) => ({
      ...owner,
      marker: { ...owner.marker, processStart: "stale" },
    }),
    (owner) => ({
      ...owner,
      guardianNative: { ...owner.guardianNative, startMicroseconds: "reused" },
    }),
    (owner) => ({
      ...owner,
      desktopNative: { ...owner.desktopNative, startMicroseconds: "reused" },
    }),
  ])("fails before publication for a changed original identity", (change) => {
    const { owner, start, native } = original();
    expect(() => predecessorIdentity(change(owner), start, native)).toThrow(
      "OWNER_BETA_PREDECESSOR_CHANGED",
    );
    expect(() =>
      createUpdateRequest(
        {
          pair: {},
          home: {},
          operationId: "x",
          action: "apply",
          predecessor: change(owner),
        },
        start,
        native,
      ),
    ).toThrow("OWNER_BETA_PREDECESSOR_CHANGED");
  });
});
