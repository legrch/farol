import { describe, expect, it } from "vitest";
import {
  containWindowOpenFailure,
  presentationAction,
  WindowOpenCoordinator,
  windowAllClosedAction,
} from "../../src/apps/desktop/lifecycle-policy";

describe("desktop lifecycle policy", () => {
  it("keeps the macOS application and runtime alive after its last window closes", () => {
    expect(windowAllClosedAction("darwin")).toBe("keep-running");
    expect(windowAllClosedAction("linux")).toBe("quit");
    expect(windowAllClosedAction("win32")).toBe("quit");
  });

  it("keeps automated visibility explicit without changing owner launch behavior", () => {
    expect(presentationAction("default")).toBe("show-and-focus");
    expect(presentationAction("secondary-visible")).toBe("show-inactive");
    expect(presentationAction("hidden")).toBe("remain-hidden");
  });

  it("contains a failed activation reopen without leaking a rejection", async () => {
    let recovered = 0;
    await expect(
      containWindowOpenFailure(
        async () => {
          throw new Error("synthetic reopen failure");
        },
        () => {
          recovered += 1;
        },
      ),
    ).resolves.toBe("failed");
    expect(recovered).toBe(1);
  });

  it("contains a recovery callback failure too", async () => {
    await expect(
      containWindowOpenFailure(
        async () => {
          throw new Error("synthetic reopen failure");
        },
        () => {
          throw new Error("synthetic cleanup failure");
        },
      ),
    ).resolves.toBe("failed");
  });

  it("joins an in-progress reopen after the BrowserWindow already exists", async () => {
    const coordinator = new WindowOpenCoordinator();
    let windowExists = false;
    let opens = 0;
    let reveals = 0;
    let rejectOpen: ((error: Error) => void) | undefined;
    const pendingOpen = new Promise<void>((_resolve, reject) => {
      rejectOpen = reject;
    });
    const options = {
      hasWindow: () => windowExists,
      reveal: () => {
        reveals += 1;
      },
      open: () => {
        opens += 1;
        windowExists = true;
        return pendingOpen;
      },
    };

    const first = coordinator.ensure(options);
    const overlapping = coordinator.ensure(options);
    let overlappingSettled = false;
    void overlapping.then(
      () => {
        overlappingSettled = true;
      },
      () => {
        overlappingSettled = true;
      },
    );
    await Promise.resolve();

    expect(opens).toBe(1);
    expect(reveals).toBe(0);
    expect(overlappingSettled).toBe(false);

    rejectOpen?.(new Error("second task view failed to load"));
    const outcomes = await Promise.allSettled([first, overlapping]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "rejected",
      "rejected",
    ]);
  });
});
