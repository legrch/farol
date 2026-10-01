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

  for (const environment of ["dev", "preview"] as const) {
    for (const code of [
      "BUILT_IN_DISPLAY_UNAVAILABLE",
      "SECONDARY_DISPLAY_UNAVAILABLE",
      "WINDOW_DISPLAY_UNAVAILABLE",
      "WINDOW_PRIMARY_DISPLAY_MISSING",
      "WINDOW_DISPLAY_GEOMETRY_INVALID",
      "VISIBLE_TEST_VIEWPORT_UNAVAILABLE",
    ]) {
      it(`classifies ${code} in ${environment} without suggesting a rebuild`, () => {
        const write = vi.fn<(message: string) => void>();
        const exit = vi.fn<(code: number) => void>();
        terminateDesktopStartup(new Error(code), environment, { write, exit });
        const report = write.mock.calls[0]?.[0];
        expect(report).toContain("display");
        expect(report).not.toContain("Rebuild");
        expect(report).not.toContain("local build or configuration issue");
        expect(report).toContain(`${DESKTOP_STARTUP_FAILURE_PREFIX}${code}`);
        expect(report).toContain(
          `${DESKTOP_LAUNCH_RESULT_PREFIX}startup-failed`,
        );
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      });
    }
  }

  it("retains the exact-candidate remedy for an unrelated build identity failure", () => {
    const write = vi.fn<(message: string) => void>();
    terminateDesktopStartup(
      new Error("INSTANCE_BUILD_IDENTITY_INVALID"),
      "preview",
      {
        write,
        exit: () => undefined,
      },
    );
    expect(write.mock.calls[0]?.[0]).toContain("Rebuild the exact candidate");
    expect(write.mock.calls[0]?.[0]).not.toContain("visible-test display");
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
