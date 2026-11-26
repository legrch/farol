import { describe, expect, it } from "vitest";
import {
  installedUpdateStartupDecision,
  startupHelperState,
  type StartupHelperState,
} from "./decision";
import { Journal } from "./record";

const d = (c: string) => c.repeat(64);
const source = { digest: d("a"), version: "1.2.3", buildId: d("b") };
const target = { digest: d("c"), version: "1.2.4", buildId: d("d") };
const other = { digest: d("e"), version: "9.9.9", buildId: d("f") };
const operation = { operationId: "1".repeat(32), source, target };
const decide = (
  helper: StartupHelperState,
  installed: typeof source,
  running: { version: string; buildId: string },
  phase: Parameters<typeof installedUpdateStartupDecision>[0]["phase"] = null,
) =>
  installedUpdateStartupDecision({
    phase,
    helper,
    installed,
    running,
    operation,
  });

describe("startup helper state", () => {
  it("maps each observation to its startup state", () => {
    expect(startupHelperState("live")).toBe("running");
    expect(startupHelperState("ended")).toBe("exited");
    expect(startupHelperState("unknown")).toBe("unknown");
  });
});

describe("installed update startup decision", () => {
  it("waits while the helper runs, whatever is installed", () => {
    for (const installed of [source, target, other])
      expect(decide("running", installed, target)).toEqual({
        action: "wait",
        mayStart: false,
      });
  });

  it("refuses when the helper outcome is unknown", () => {
    for (const installed of [source, target, other])
      expect(decide("unknown", installed, installed)).toEqual({
        action: "refuse",
        mayStart: false,
      });
  });

  it("refuses an exited helper when neither build is installed", () => {
    expect(decide("exited", other, other)).toEqual({
      action: "refuse",
      mayStart: false,
    });
  });

  it("completes when the target is installed and may start only the target", () => {
    expect(decide("exited", target, target)).toEqual({
      action: "completed",
      mayStart: true,
    });
    expect(decide("exited", target, source)).toEqual({
      action: "completed",
      mayStart: false,
    });
    expect(decide("exited", target, other)).toEqual({
      action: "completed",
      mayStart: false,
    });
  });

  it("rolls back when the source is installed and may start only the source", () => {
    expect(decide("exited", source, source)).toEqual({
      action: "rolled_back",
      mayStart: true,
    });
    expect(decide("exited", source, target)).toEqual({
      action: "rolled_back",
      mayStart: false,
    });
    expect(decide("exited", source, other)).toEqual({
      action: "rolled_back",
      mayStart: false,
    });
  });

  it("needs both the version and the build id to match the running build", () => {
    expect(
      decide("exited", target, { version: target.version, buildId: d("0") })
        .mayStart,
    ).toBe(false);
    expect(
      decide("exited", target, { version: "0.0.0", buildId: target.buildId })
        .mayStart,
    ).toBe(false);
  });

  it("matches the installed build on digest, version and build id together", () => {
    expect(decide("exited", { ...target, digest: d("0") }, target).action).toBe(
      "refuse",
    );
    expect(
      decide("exited", { ...target, version: "0.0.1" }, target).action,
    ).toBe("refuse");
    expect(
      decide("exited", { ...target, buildId: d("0") }, target).action,
    ).toBe("refuse");
  });

  it("gives every journal phase the same rows", () => {
    const phases = [null, ...Journal.shape.phase.options];
    for (const phase of phases) {
      expect(decide("exited", target, target, phase)).toEqual({
        action: "completed",
        mayStart: true,
      });
      expect(decide("exited", source, source, phase)).toEqual({
        action: "rolled_back",
        mayStart: true,
      });
      expect(decide("running", target, target, phase).action).toBe("wait");
      expect(decide("unknown", target, target, phase).action).toBe("refuse");
    }
  });
});
