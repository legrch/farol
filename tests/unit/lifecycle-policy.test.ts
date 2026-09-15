import { describe, expect, it } from "vitest";
import {
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
});
