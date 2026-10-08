import { describe, expect, it } from "vitest";
// @ts-expect-error Mechanical launcher module is exercised at runtime.
import * as control from "../../tooling/dev-process-control.mjs";
const { correlateDevCommand, devControlTimeout } = control;

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
const native = { status: "present", pid: 111, uid: 501, token: "boot:123:456" };
const command = `501 ${marker.processStart} ${executable} _output/build/app/main.cjs`;

describe("exact Dev command correlation", () => {
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
