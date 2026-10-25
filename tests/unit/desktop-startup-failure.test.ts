import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_LAUNCH_RESULT_PREFIX,
  DESKTOP_STARTUP_FAILURE_PREFIX,
  desktopStartupFailureCode,
  desktopStartupFailureNotice,
  runDesktopStartupBoundary,
  startupNoticeAllowed,
  terminateDesktopStartup,
} from "../../src/apps/desktop/desktop-startup-failure";
import { BridgeError } from "../../apps/desktop/bridge/client";

describe("startup notice interactivity", () => {
  it("allows the modal notice only for an interactive launch", () => {
    expect(startupNoticeAllowed({})).toBe(true);
    expect(startupNoticeAllowed({ CI: "false" })).toBe(true);
    expect(startupNoticeAllowed({ FAROL_E2E: "1" })).toBe(false);
    expect(startupNoticeAllowed({ FAROL_NONINTERACTIVE: "1" })).toBe(false);
    expect(startupNoticeAllowed({ CI: "true" })).toBe(false);
    expect(startupNoticeAllowed({ CI: "1" })).toBe(false);
  });
});

describe("desktop startup failure boundary", () => {
  it("preserves an unsafe Preview profile without suggesting a rebuild or retry", () => {
    const write = vi.fn<(message: string) => void>();
    const exit = vi.fn<(code: number) => void>();
    terminateDesktopStartup(
      new Error("OWNER_PREVIEW_PROFILE_DIRECTORY_UNSAFE"),
      "owner-preview",
      { write, exit },
    );
    expect(write.mock.calls[0]?.[0]).toContain(
      "Preserve the existing directories",
    );
    expect(write.mock.calls[0]?.[0]).not.toContain(
      "Rebuild the exact candidate",
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each(["dev", "preview"] as const)(
    "classifies an unconfirmed previous shutdown in %s as profile recovery",
    (environment) => {
      for (const failure of [
        new Error("DESKTOP_PREVIOUS_QUIT_UNCONFIRMED"),
        new BridgeError("refused", "previous_host_drain_unconfirmed"),
      ]) {
        const write = vi.fn<(message: string) => void>();
        const exit = vi.fn<(code: number) => void>();
        terminateDesktopStartup(failure, environment, { write, exit });
        const report = write.mock.calls[0]?.[0];
        expect(report).toContain("previous session did not confirm shutdown");
        expect(report).toContain("Preserve the existing profile");
        expect(report).toContain(
          "rebuilding the app does not settle this state",
        );
        expect(report).not.toContain("Rebuild the exact candidate");
        expect(report).not.toContain("run 'task dev' again");
        expect(report).toContain(
          `${DESKTOP_STARTUP_FAILURE_PREFIX}${desktopStartupFailureCode(failure)}`,
        );
        expect(report).toContain(
          `${DESKTOP_LAUNCH_RESULT_PREFIX}startup-failed`,
        );
        expect(write).toHaveBeenCalledOnce();
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      }
    },
  );

  it("reports a failed Go boundary exactly once without retrying its effect", async () => {
    const effect = vi.fn(async () => {
      throw new BridgeError("refused", "invalid_computer_publication");
    });
    const failure = await runDesktopStartupBoundary("go-core", effect).catch(
      (error: unknown) => error,
    );
    const write = vi.fn<(message: string) => void>();
    const exit = vi.fn<(code: number) => void>();
    terminateDesktopStartup(failure, "dev", { write, exit });
    expect(effect).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toContain(
      "FAROL_STARTUP_FAILURE_STAGE:go-core",
    );
    expect(write.mock.calls[0]?.[0]).toContain(
      `${DESKTOP_STARTUP_FAILURE_PREFIX}GO_CORE_INVALID_COMPUTER_PUBLICATION`,
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each(["unknown", "refused", "unavailable", "unsupported"] as const)(
    "retains %s classification while redacting arbitrary bridge codes",
    async (state) => {
      const privateCode = "private_payload_that_looks_like_a_code";
      const failure = await runDesktopStartupBoundary("go-settings", () => {
        throw new BridgeError(state, privateCode);
      }).catch((error: unknown) => error);
      const write = vi.fn<(message: string) => void>();
      terminateDesktopStartup(failure, "dev", { write, exit: () => undefined });
      expect(write.mock.calls[0]?.[0]).toContain(
        `GO_CORE_${state.toUpperCase()}`,
      );
      expect(write.mock.calls[0]?.[0]).not.toContain(privateCode);
    },
  );

  it("reports the local failure phase without copying native exception text", async () => {
    const failure = await runDesktopStartupBoundary("main-window", () => {
      throw new Error("private /Users/owner/state path");
    }).catch((error: unknown) => error);
    const write = vi.fn<(message: string) => void>();
    terminateDesktopStartup(failure, "dev", { write, exit: () => undefined });
    expect(write.mock.calls[0]?.[0]).toContain(
      "FAROL_STARTUP_FAILURE_STAGE:main-window",
    );
    expect(write.mock.calls[0]?.[0]).toContain("DESKTOP_STARTUP_FAILED");
    expect(write.mock.calls[0]?.[0]).not.toContain("/Users/");
  });

  it.each(["private_payload_that_looks_like_a_code", null, 42])(
    "redacts malformed bridge state without losing the failure phase (%s)",
    async (state) => {
      const failure = await runDesktopStartupBoundary("go-core", () => {
        throw new BridgeError(state as "unknown", "unlisted_private_code");
      }).catch((error: unknown) => error);
      const write = vi.fn<(message: string) => void>();
      terminateDesktopStartup(failure, "dev", { write, exit: () => undefined });
      expect(write.mock.calls[0]?.[0]).toContain("GO_CORE_FAILURE");
      expect(write.mock.calls[0]?.[0]).toContain(
        "FAROL_STARTUP_FAILURE_STAGE:go-core",
      );
      expect(write.mock.calls[0]?.[0]).not.toContain("PRIVATE_PAYLOAD");
      expect(write.mock.calls[0]?.[0]).not.toContain("unlisted_private_code");
    },
  );

  it("returns successful startup values without introducing another call", async () => {
    const value = { ready: true };
    const effect = vi.fn(() => value);
    expect(await runDesktopStartupBoundary("configuration", effect)).toBe(
      value,
    );
    expect(effect).toHaveBeenCalledOnce();
  });

  it("rejects an unknown phase before invoking the startup action", async () => {
    const effect = vi.fn();
    await expect(
      runDesktopStartupBoundary("private-phase" as "go-core", effect),
    ).rejects.toThrow("DESKTOP_STARTUP_PHASE_INVALID");
    expect(effect).not.toHaveBeenCalled();
  });
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

  // A packaged launch on a busy Mac refused with a bare GO_CORE_REFUSED and a
  // rebuild remedy; a spent qualification budget must name itself instead.
  it.each([
    ["core_resources_deadline_expired", true],
    ["shell_runtime_deadline_expired", true],
    ["core_resources_unqualified", false],
    ["shell_runtime_unqualified", false],
  ] as const)(
    "names Go-core qualification refusal %s",
    async (bridgeCode, spentBudget) => {
      const failure = await runDesktopStartupBoundary("go-core", () => {
        throw new BridgeError("refused", bridgeCode);
      }).catch((error: unknown) => error);
      const write = vi.fn<(message: string) => void>();
      const exit = vi.fn<(code: number) => void>();
      terminateDesktopStartup(failure, "preview", { write, exit });
      const report = write.mock.calls[0]?.[0];
      expect(report).toContain(
        `${DESKTOP_STARTUP_FAILURE_PREFIX}GO_CORE_${bridgeCode.toUpperCase()}`,
      );
      expect(report).not.toContain("GO_CORE_REFUSED");
      if (spentBudget) {
        expect(report).toContain("Preserve the profile and startup records");
        expect(report).toContain(
          "previous shutdown state before another launch",
        );
        expect(report).not.toContain("Open the app again");
        expect(report).not.toContain("Rebuild");
      } else {
        expect(report).toContain("Rebuild the exact candidate");
      }
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    },
  );

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

  describe("first-launch adoption failures reach the user", () => {
    const notices = [
      [
        "UPDATE_ADOPTION_NETWORK_FAILURE",
        "Connect to the internet to verify Farol on first launch, then open Farol again.",
      ],
      [
        "UPDATE_ADOPTION_RELEASE_NOT_FOUND",
        "This copy of Farol isn't a published release. Download Farol from its releases page.",
      ],
      [
        "UPDATE_ADOPTION_TREE_MISMATCH",
        "This copy of Farol doesn't match its published release. Download it again.",
      ],
      [
        "UPDATE_ADOPTION_RELEASE_MISMATCH",
        "This copy of Farol doesn't match its published release. Download it again.",
      ],
    ] as const;

    it.each(notices)(
      "maps %s to its notice and remedy and notifies once",
      (code, message) => {
        expect(desktopStartupFailureNotice(code)?.message).toBe(message);
        const write = vi.fn<(message: string) => void>();
        const exit = vi.fn<(code: number) => void>();
        const notify = vi.fn<(title: string, message: string) => void>();
        terminateDesktopStartup(new Error(code), "preview", {
          write,
          exit,
          notify,
        });
        const report = write.mock.calls[0]?.[0];
        expect(report).toContain(message);
        expect(report).not.toContain("Rebuild the exact candidate");
        expect(report).toContain(`${DESKTOP_STARTUP_FAILURE_PREFIX}${code}`);
        expect(notify).toHaveBeenCalledExactlyOnceWith(
          expect.any(String),
          message,
        );
        expect(notify.mock.calls[0]![0].length).toBeGreaterThan(0);
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      },
    );

    it("never notifies for any other code and keeps the generic remedy", () => {
      for (const failure of [
        new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED"),
        new Error("UPDATE_ADOPTION_RECORD_UNWRITTEN"),
        new Error("private /Users/owner/path"),
        new BridgeError("refused", "invalid_computer_publication"),
      ]) {
        const write = vi.fn<(message: string) => void>();
        const exit = vi.fn<(code: number) => void>();
        const notify = vi.fn();
        terminateDesktopStartup(failure, "preview", { write, exit, notify });
        expect(
          desktopStartupFailureNotice(desktopStartupFailureCode(failure)),
        ).toBeNull();
        expect(notify).not.toHaveBeenCalled();
        expect(write.mock.calls[0]?.[0]).toContain(
          "Rebuild the exact candidate",
        );
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      }
    });

    it("exits with code 1 and still reports when the notice throws", () => {
      const write = vi.fn<(message: string) => void>();
      const exit = vi.fn<(code: number) => void>();
      const notify = vi.fn(() => {
        throw new Error("dialog unavailable");
      });
      expect(() =>
        terminateDesktopStartup(
          new Error("UPDATE_ADOPTION_NETWORK_FAILURE"),
          "preview",
          { write, exit, notify },
        ),
      ).not.toThrow();
      expect(write).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    });

    it("works without a notify hook", () => {
      const exit = vi.fn<(code: number) => void>();
      terminateDesktopStartup(
        new Error("UPDATE_ADOPTION_NETWORK_FAILURE"),
        "preview",
        { write: () => undefined, exit },
      );
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    });
  });
});
