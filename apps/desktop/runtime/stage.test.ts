import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStartupStage } from "./stage";

const cleanup: string[] = [];
afterEach(() => {
  for (const entry of cleanup.splice(0))
    rmSync(entry, { recursive: true, force: true });
});

function laneHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "farol-e2e-home-"));
  cleanup.push(home);
  return home;
}

function stage(
  env: Record<string, string | undefined>,
  lines: string[] = [],
  uid: number | undefined = process.getuid?.(),
) {
  return createStartupStage({
    env,
    writeStderr: (line) => lines.push(line),
    pid: 4242,
    uid: () => uid,
    tmpdir: () => os.tmpdir(),
    hrtime: () => 77n,
    uuid: () => "uuid",
  });
}

describe("startup stage marker", () => {
  it("writes nothing outside the E2E lane", () => {
    const home = laneHome();
    const lines: string[] = [];
    stage({ HOME: home }, lines)("lock-primary");
    expect(lines).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it("persists a fixed token in the private lane home", () => {
    const home = laneHome();
    const lines: string[] = [];
    stage({ FAROL_E2E: "1", HOME: home }, lines)("lock-primary");
    expect(lines.join("")).toContain("lock-primary");
    expect(readFileSync(path.join(home, ".farol-startup-stage"), "utf8")).toBe(
      "lock-primary\n",
    );
    expect(readdirSync(home)).toEqual([".farol-startup-stage"]);
  });

  it("routes the secondary-lock, delay and connector stages to their markers", () => {
    const home = laneHome();
    const env = { FAROL_E2E: "1", HOME: home };
    stage(env)("lock-secondary");
    stage(env)("delay-complete");
    stage(env)("connector-resume-failed");
    stage(env)("connector-resumed");
    expect(
      readFileSync(path.join(home, ".farol-secondary-lock-stage"), "utf8"),
    ).toBe("lock-secondary:77\n");
    expect(
      readFileSync(path.join(home, ".farol-delay-complete-stage"), "utf8"),
    ).toBe("delay-complete:77\n");
    expect(
      readFileSync(path.join(home, ".farol-connector-resume-stage"), "utf8"),
    ).toBe("connector-resumed\n");
  });

  it("refuses a home that is not the lane's private directory", () => {
    const env = (home: string | undefined) => ({
      FAROL_E2E: "1",
      HOME: home,
    });
    stage(env(undefined))("lock-primary");
    const misnamed = mkdtempSync(path.join(os.tmpdir(), "farol-other-"));
    cleanup.push(misnamed);
    stage(env(misnamed))("lock-primary");
    expect(readdirSync(misnamed)).toEqual([]);
    const open = laneHome();
    chmodSync(open, 0o755);
    stage(env(open))("lock-primary");
    expect(readdirSync(open)).toEqual([]);
    const foreign = laneHome();
    stage(env(foreign), [], (process.getuid?.() ?? 0) + 1)("lock-primary");
    expect(readdirSync(foreign)).toEqual([]);
    const target = laneHome();
    const link = path.join(os.tmpdir(), `farol-e2e-home-link${process.pid}`);
    symlinkSync(target, link);
    cleanup.push(link);
    stage(env(link))("lock-primary");
    expect(readdirSync(target)).toEqual([]);
    expect(existsSync(path.join(link, ".farol-startup-stage"))).toBe(false);
  });

  it("swallows a persistence failure", () => {
    const home = laneHome();
    const missing = path.join(home, "farol-e2e-home-missing1");
    expect(() =>
      stage({ FAROL_E2E: "1", HOME: missing })("lock-primary"),
    ).not.toThrow();
  });
});
