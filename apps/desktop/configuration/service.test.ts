import { describe, expect, it, vi } from "vitest";

// The Settings service composition over a recording service constructor: the
// store root, the lease it is given, and how task answers are bound to the Go
// core they started on.

const captured = vi.hoisted(() => ({
  root: "",
  options: null as null | Record<string, (...args: never[]) => unknown>,
}));
vi.mock("../../../src/apps/desktop/product-configuration", () => ({
  ProductSettingsStore: class {
    constructor(options: { root: string }) {
      captured.root = options.root;
    }
  },
  ProductConfigurationService: class {
    constructor(_store: unknown, options: typeof captured.options) {
      captured.options = options;
    }
  },
}));

const { createConfigurationService } = await import("./service");

type Core = {
  resolveTaskModel: ReturnType<typeof vi.fn>;
  compareTaskSettings: ReturnType<typeof vi.fn>;
};
function core(): Core {
  return { resolveTaskModel: vi.fn(), compareTaskSettings: vi.fn() };
}
function build(current: () => Core | null) {
  const promotionLease = { acquireForAdmission: vi.fn() };
  createConfigurationService({
    root: "/state",
    desktopGoCore: current as never,
    promotionLease,
  });
  return { promotionLease, options: captured.options! };
}

describe("configuration service", () => {
  it("stores Settings under the given root and lends the admission lease", () => {
    const { promotionLease, options } = build(() => null);
    expect(captured.root).toBe("/state");
    expect(options.promotionLease).toBe(promotionLease);
  });

  it("answers task questions from the core it started on", async () => {
    const live = core();
    live.resolveTaskModel.mockResolvedValue("model");
    live.compareTaskSettings.mockResolvedValue(true);
    const { options } = build(() => live);
    await expect(
      (options.taskModelPolicy as (...a: unknown[]) => Promise<unknown>)(
        1,
        [],
        null,
      ),
    ).resolves.toBe("model");
    await expect(
      (options.taskSettingsCompare as (...a: unknown[]) => Promise<unknown>)(
        {},
        {},
      ),
    ).resolves.toBe(true);
  });

  it("refuses without a core and when the core changes mid-answer", async () => {
    const policy = (o: typeof captured.options) =>
      o!.taskModelPolicy as (...a: unknown[]) => Promise<unknown>;
    const compare = (o: typeof captured.options) =>
      o!.taskSettingsCompare as (...a: unknown[]) => Promise<unknown>;
    await expect(
      policy(build(() => null).options)(1, [], null),
    ).rejects.toThrow("host_task_model_policy_unavailable");
    await expect(compare(build(() => null).options)({}, {})).rejects.toThrow(
      "host_task_settings_unavailable",
    );
    let current: Core | null = core();
    const next = core();
    current.resolveTaskModel.mockImplementation(async () => {
      current = next;
      return "stale";
    });
    current.compareTaskSettings.mockImplementation(async () => {
      current = next;
      return true;
    });
    const first = current;
    await expect(
      policy(build(() => current).options)(1, [], null),
    ).rejects.toThrow("host_task_model_policy_changed");
    current = first;
    await expect(compare(build(() => current).options)({}, {})).rejects.toThrow(
      "host_task_settings_changed",
    );
  });
});
