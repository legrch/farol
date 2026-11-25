import { describe, expect, it, vi } from "vitest";
import { BridgeError } from "../bridge/client";
import { chatStartupProfile } from "./profile";

const base = {
  environment: "dev",
  e2e: true,
  origin: "http://127.0.0.1:1",
} as const;

describe("Chat startup profile", () => {
  it("captures from the ready task settings with the launch facts", () => {
    const capture = vi.fn(() => "profile");
    expect(
      chatStartupProfile({
        ...base,
        settings: () => ({ tasks: "tasks" }),
        capture,
      }),
    ).toBe("profile");
    expect(capture).toHaveBeenCalledWith({ ...base, tasks: "tasks" });
  });

  it("is absent while configuration is not ready, without capturing", () => {
    const capture = vi.fn(() => "profile");
    expect(
      chatStartupProfile({ ...base, settings: () => null, capture }),
    ).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it("is absent when the capture itself answers absent", () => {
    expect(
      chatStartupProfile({
        ...base,
        settings: () => ({ tasks: 1 }),
        capture: () => null,
      }),
    ).toBeNull();
  });

  it("treats a bridge error from settings or capture as absent", () => {
    const refused = () => {
      throw new BridgeError("refused", "x");
    };
    expect(
      chatStartupProfile({ ...base, settings: refused, capture: () => "p" }),
    ).toBeNull();
    expect(
      chatStartupProfile({
        ...base,
        settings: () => ({ tasks: 1 }),
        capture: refused,
      }),
    ).toBeNull();
  });

  it("propagates any other failure", () => {
    expect(() =>
      chatStartupProfile({
        ...base,
        settings: () => {
          throw new Error("defect");
        },
        capture: () => "p",
      }),
    ).toThrow("defect");
  });
});
