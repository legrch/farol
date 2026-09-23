import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_LAUNCH_RESULT_PREFIX,
  DESKTOP_STARTUP_FAILURE_PREFIX,
  desktopStartupFailureCode,
  terminateDesktopStartup,
} from "../../src/apps/desktop/desktop-startup-failure";

describe("desktop startup failure boundary", () => {
  it("reports a bounded DEV failure and terminates nonzero", () => {
    const write = vi.fn<(message: string) => void>();
    const exit = vi.fn<(code: number) => void>();

    terminateDesktopStartup(
      new Error("INSTANCE_BUILD_IDENTITY_INVALID"),
      "dev",
      { write, exit },
    );

    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toContain(
      "Farol Dev main-process startup failed",
    );
    expect(write.mock.calls[0]?.[0]).toContain(
      `${DESKTOP_STARTUP_FAILURE_PREFIX}INSTANCE_BUILD_IDENTITY_INVALID`,
    );
    expect(write.mock.calls[0]?.[0]).toContain(
      `${DESKTOP_LAUNCH_RESULT_PREFIX}startup-failed`,
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("reports distinct Dev profiles without moving or merging them", () => {
    const write = vi.fn<(message: string) => void>();
    const exit = vi.fn<(code: number) => void>();
    terminateDesktopStartup(
      new Error("DEV_PROFILE_DIRECTORY_AMBIGUOUS"),
      "dev",
      {
        write,
        exit,
      },
    );
    expect(write.mock.calls[0]?.[0]).toContain(
      "Two distinct Dev profiles exist",
    );
    expect(write.mock.calls[0]?.[0]).toContain("neither was moved or merged");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("does not copy an arbitrary exception or private path into the report", () => {
    const privateMessage =
      "failed while reading /Users/owner/private/auth-state.json";
    expect(desktopStartupFailureCode(new Error(privateMessage))).toBe(
      "DESKTOP_STARTUP_FAILED",
    );
    const write = vi.fn<(message: string) => void>();
    terminateDesktopStartup(new Error(privateMessage), "preview", {
      write,
      exit: () => undefined,
    });
    expect(write.mock.calls[0]?.[0]).not.toContain(privateMessage);
    expect(write.mock.calls[0]?.[0]).not.toContain("/Users/");
  });
});
