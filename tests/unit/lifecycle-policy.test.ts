import { describe, expect, it } from "vitest";
import {
  containWindowOpenFailure,
  presentationAction,
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
});
