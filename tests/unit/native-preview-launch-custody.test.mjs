// Deterministic dual-PID contract. Inert ChildProcess and stream doubles only:
// no native Electron, ps/osascript, process spawn, signal, or disposable profile.
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  packagedNativePaths,
  qualifyNativePreviewPair,
  captureNativePreviewPair,
  requalifyNativePreviewPair,
} from "../e2e/lib/native-preview-launch-custody.mjs";

const launcherPath = "/candidate/Farol.app/Contents/MacOS/Farol";
const paths = packagedNativePaths(launcherPath);
const marker = { pid: 202, processStart: "original-electron-start" };
function sample() {
  const guardianNative = {
    executable: paths.guardian,
    parentPid: 190,
    startSeconds: "100",
    startMicroseconds: "123456",
  };
  const desktopNative = {
    executable: paths.desktop,
    parentPid: 201,
    startSeconds: "101",
    startMicroseconds: "654321",
  };
  return {
    launcherPath,
    launcherPid: 201,
    marker,
    desktop: { pid: 202, ppid: 201, executable: paths.desktop },
    children: [
      {
        pid: 202,
        parentPid: 201,
        processStart: marker.processStart,
      },
    ],
    guardianBefore: guardianNative,
    guardianAfter: { ...guardianNative },
    desktopBefore: desktopNative,
    desktopAfter: { ...desktopNative },
  };
}
function fixture() {
  const child = new ChildProcess();
  child.pid = 201;
  child.stderr = new PassThrough();
  const observed = sample();
  return {
    child,
    actual: { pid: 202 },
    launch: { executablePath: launcherPath },
    observed: {
      ...observed,
      launcherStart: "original-launcher-start",
      desktopStart: marker.processStart,
    },
  };
}
describe("native Preview packaged launcher identity (no real processes)", () => {
  it("selects only the exact packaged launch layout, not a standalone Electron", () => {
    expect(packagedNativePaths(launcherPath)).toEqual({
      guardian: "/candidate/Farol.app/Contents/Resources/app/farol-backend",
      desktop:
        "/candidate/Farol.app/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    });
    for (const path of [
      "/fixture/Electron",
      "/fixture/Electron.app/Contents/MacOS/Electron",
      "/fixture/Farol Dev.app/Contents/MacOS/Farol Dev",
      "/candidate/Farol.app/Contents/MacOS/Electron",
      "/candidate/Farol.app/Contents/Farol",
      "/candidate/Farol.app/Contents/MacOS/Farol-other",
      "Farol.app/Contents/MacOS/Farol",
    ])
      expect(packagedNativePaths(path)).toBeNull();
  });
  it("binds original guardian to exactly one Electron child and microsecond birth", () => {
    expect(qualifyNativePreviewPair(sample())).toEqual({
      guardianPid: 201,
      desktopPid: 202,
      desktopStart: marker.processStart,
    });
  });
  it.each([
    ["same PID", (v) => (v.desktop.pid = v.launcherPid)],
    ["foreign parent", (v) => (v.desktop.ppid = 1)],
    ["wrong Electron image", (v) => (v.desktop.executable = "/other/Electron")],
    ["wrong Go image", (v) => (v.guardianAfter.executable = "/other/go")],
    ["new launcher birth", (v) => (v.guardianAfter.startMicroseconds = "7")],
    ["reused Electron PID", (v) => (v.desktopAfter.startMicroseconds = "7")],
    ["reparented native Electron", (v) => (v.desktopAfter.parentPid = 1)],
    ["marker for launcher", (v) => (v.marker.pid = v.launcherPid)],
    ["marker start mismatch", (v) => (v.marker.processStart = "new")],
    ["no registered Electron", (v) => (v.children = [])],
    ["duplicate child", (v) => v.children.push({ ...v.children[0] })],
    ["foreign child parent", (v) => (v.children[0].parentPid = 1)],
  ])("refuses %s before singleton authority", (_name, corrupt) => {
    const value = structuredClone(sample());
    corrupt(value);
    expect(() => qualifyNativePreviewPair(value)).toThrow(/NATIVE_ISOLATION_/u);
  });
  it("captures both original identities and requires independent terminal receipts", async () => {
    const f = fixture();
    const pair = captureNativePreviewPair(
      f.launch,
      f.actual,
      f.child,
      marker,
      f.observed,
    );
    expect(pair.identity).toMatchObject({ guardianPid: 201, desktopPid: 202 });
    f.child.stderr.end("desktop_launcher_desktop_exit pid=202 code=0\n");
    await once(f.child.stderr, "end");
    f.child.exitCode = 0;
    expect(requalifyNativePreviewPair(pair, f.actual, f.child)).toEqual({
      pid: 202,
      code: 0,
      signal: null,
      source: "guardian-native-wait",
      guardianTerminal: { pid: 201, code: 0, signal: null },
    });
  });
  it.each([
    ["missing Electron receipt", ""],
    [
      "different Electron PID",
      "desktop_launcher_desktop_exit pid=203 code=0\n",
    ],
    ["failed Electron", "desktop_launcher_desktop_exit pid=202 code=1\n"],
    [
      "duplicate Electron receipt",
      "desktop_launcher_desktop_exit pid=202 code=0\ndesktop_launcher_desktop_exit pid=202 code=0\n",
    ],
    [
      "malformed native receipt",
      "desktop_launcher_desktop_exit pid=202 code=UNKNOWN\n",
    ],
  ])("retains UNKNOWN for %s", async (_name, diagnostic) => {
    const f = fixture();
    const pair = captureNativePreviewPair(
      f.launch,
      f.actual,
      f.child,
      marker,
      f.observed,
    );
    f.child.stderr.end(diagnostic);
    await once(f.child.stderr, "end");
    f.child.exitCode = 0;
    expect(() => requalifyNativePreviewPair(pair, f.actual, f.child)).toThrow(
      "NATIVE_ISOLATION_DESKTOP_TERMINAL_UNCONFIRMED",
    );
  });
  it("does not accept an incomplete Electron Wait stream, even with launcher exit 0", () => {
    const f = fixture();
    const pair = captureNativePreviewPair(
      f.launch,
      f.actual,
      f.child,
      marker,
      f.observed,
    );
    f.child.stderr.write("desktop_launcher_desktop_exit pid=202 code=0\n");
    f.child.exitCode = 0;
    expect(() => requalifyNativePreviewPair(pair, f.actual, f.child)).toThrow(
      "NATIVE_ISOLATION_DESKTOP_TERMINAL_UNCONFIRMED",
    );
    f.child.stderr.destroy();
  });
  it.each([
    ["launcher failure", 1, null],
    ["launcher signal death", null, "SIGTERM"],
  ])("keeps %s distinct from Electron completion", (_name, code, signal) => {
    const f = fixture();
    const pair = captureNativePreviewPair(
      f.launch,
      f.actual,
      f.child,
      marker,
      f.observed,
    );
    f.child.exitCode = code;
    f.child.signalCode = signal;
    expect(() => requalifyNativePreviewPair(pair, f.actual, f.child)).toThrow(
      "NATIVE_ISOLATION_GUARDIAN_TERMINAL_UNCONFIRMED",
    );
    f.child.stderr.destroy();
  });
  it("refuses same numeric PID on a different ChildProcess or different Electron", () => {
    const f = fixture();
    const pair = captureNativePreviewPair(
      f.launch,
      f.actual,
      f.child,
      marker,
      f.observed,
    );
    const foreign = new ChildProcess();
    foreign.pid = f.child.pid;
    expect(() => requalifyNativePreviewPair(pair, f.actual, foreign)).toThrow(
      "NATIVE_ISOLATION_PROCESS_PAIR_CHANGED",
    );
    expect(() =>
      requalifyNativePreviewPair(pair, { pid: 203 }, f.child),
    ).toThrow("NATIVE_ISOLATION_PROCESS_PAIR_CHANGED");
    f.child.stderr.destroy();
  });
  it("refuses an original capture without a live retained child or complete source", () => {
    const f = fixture();
    f.observed.desktopStart = "different";
    expect(() =>
      captureNativePreviewPair(f.launch, f.actual, f.child, marker, f.observed),
    ).toThrow("NATIVE_ISOLATION_PROCESS_PAIR_UNQUALIFIED");
  });
});
