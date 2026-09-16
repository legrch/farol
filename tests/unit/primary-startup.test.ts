import { describe, expect, it } from "vitest";
import {
  PrimaryStartup,
  primaryStartupReady,
  previewStartupDelay,
} from "../../src/apps/desktop/primary-startup";

describe("primary startup coordination", () => {
  it("does not admit a second-instance reopen before initialization completes", async () => {
    const startup = new PrimaryStartup();
    let finish: (() => void) | undefined;
    const initializing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    startup.begin(initializing);

    let admitted = false;
    const waiting = startup.whenReady().then(() => {
      admitted = true;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);

    finish?.();
    await waiting;
    expect(admitted).toBe(true);
  });

  it("fails closed before startup begins or when initialization fails", async () => {
    const startup = new PrimaryStartup();
    await expect(startup.whenReady()).rejects.toThrow(
      "PRIMARY_STARTUP_UNAVAILABLE",
    );
    const failure = Promise.reject(new Error("synthetic startup failure"));
    startup.begin(failure);
    await expect(startup.whenReady()).rejects.toThrow("PRIMARY_STARTUP_FAILED");
  });

  it("requires a ready runtime, window, and every task view", () => {
    expect(
      primaryStartupReady({
        runtimeState: "ready",
        windowReady: true,
        taskViewCount: 0,
        expectedTaskViewCount: 0,
      }),
    ).toBe(true);
    expect(
      primaryStartupReady({
        runtimeState: "ready",
        windowReady: true,
        taskViewCount: 2,
        expectedTaskViewCount: 2,
      }),
    ).toBe(true);
    expect(
      primaryStartupReady({
        runtimeState: "failed",
        windowReady: true,
        taskViewCount: 0,
        expectedTaskViewCount: 2,
      }),
    ).toBe(false);
    expect(
      primaryStartupReady({
        runtimeState: "ready",
        windowReady: true,
        taskViewCount: 1,
        expectedTaskViewCount: 2,
      }),
    ).toBe(false);
  });

  it("admits only a bounded explicit E2E startup delay", () => {
    expect(previewStartupDelay(["--preview-startup-delay-ms=1500"], true)).toBe(
      1500,
    );
    expect(
      previewStartupDelay(["--preview-startup-delay-ms=1500"], false),
    ).toBe(0);
    expect(previewStartupDelay(["--preview-startup-delay-ms=9000"], true)).toBe(
      0,
    );
    expect(
      previewStartupDelay(
        ["--preview-startup-delay-ms=1", "--preview-startup-delay-ms=2"],
        true,
      ),
    ).toBe(0);
  });
});
