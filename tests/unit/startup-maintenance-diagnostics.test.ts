import { describe, expect, it, vi } from "vitest";
import { BridgeError } from "../../apps/desktop/bridge/client";
import {
  type MaintenanceObserver,
  maintenanceFailureCode,
  observeMaintenance,
} from "../../apps/desktop/recovery/diagnostics";

describe("content-free preserving-maintenance diagnostics", () => {
  it("does not inspect or replace a hostile thrown object", async () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw Error("private exception trap");
        },
      },
    );
    expect(maintenanceFailureCode(hostile)).toBe(
      "UNCLASSIFIED_MAINTENANCE_FAILURE",
    );
    const sink = vi.fn();
    let caught: unknown;
    try {
      await observeMaintenance("discovery", sink, () => {
        throw hostile;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught === hostile).toBe(true);
    expect(sink.mock.calls.at(-1)![0]).toMatchObject({
      result: "unknown",
      code: "UNCLASSIFIED_MAINTENANCE_FAILURE",
    });
  });
  it.each([
    [
      new Error("STARTUP_PRESERVED_SELECTION_INVALID"),
      "STARTUP_PRESERVED_SELECTION_INVALID",
    ],
    [
      Object.assign(new Error("/private/owner/key"), { code: "EACCES" }),
      "FILESYSTEM_EACCES",
    ],
    [
      new BridgeError("unknown", "preserved_recovery_unconfirmed"),
      "preserved_recovery_unconfirmed",
    ],
    [new Error("SECRET_LIKE_CODE_123"), "UNCLASSIFIED_MAINTENANCE_FAILURE"],
    [new Error("/private/owner/token"), "UNCLASSIFIED_MAINTENANCE_FAILURE"],
    [
      new BridgeError("unknown", "private-secret-shaped-code"),
      "UNCLASSIFIED_BRIDGE_FAILURE",
    ],
  ])("reports only selected local codes", (error, expected) => {
    expect(maintenanceFailureCode(error)).toBe(expected);
  });
  it("keeps an unknown attempt unknown, preserves the exact error and never repeats it", async () => {
    const error = new BridgeError("unknown", "preserved_recovery_unconfirmed");
    const attempt = vi.fn(async () => {
      throw error;
    });
    const sink = vi.fn();
    await expect(observeMaintenance("preparation", sink, attempt)).rejects.toBe(
      error,
    );
    expect(attempt).toHaveBeenCalledOnce();
    expect(sink.mock.calls.map(([v]) => v.event)).toEqual(["begin", "end"]);
    expect(sink.mock.calls[1]![0]).toMatchObject({
      stage: "preparation",
      result: "unknown",
      code: "preserved_recovery_unconfirmed",
    });
  });
  it("does not let a throwing sink alter the original return or error", async () => {
    const sink = vi.fn<MaintenanceObserver>(() => {
      throw Error("private logger failure");
    });
    const result = Object.freeze({ returned: true });
    await expect(
      observeMaintenance("selection", sink, () => result),
    ).resolves.toBe(result);
    const failure = Error("/Users/private/file");
    await expect(
      observeMaintenance("selection", sink, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(JSON.stringify(sink.mock.calls)).not.toContain("/Users/private");
    expect(sink.mock.calls.at(-1)![0].result).toBe("unknown");
  });
});
