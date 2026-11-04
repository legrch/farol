import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { withStartupPromotionLease } from "../../src/apps/desktop/startup-promotion-lease";
import type { PromotionLeaseHandle } from "../../src/apps/desktop/promotion-lease";

// Execute the actual main.ts orchestration without loading Electron or touching
// an installed profile. The lease itself uses disposable state and fake ports.
const source = readFileSync(path.resolve("src/apps/desktop/main.ts"), "utf8");
const declaration = source.match(
  /async function withInstalledStartupFence<T>\([\s\S]*?\n}\n\n(?=async function main\()/,
);
if (!declaration) throw new Error("STARTUP_FENCE_NOT_FOUND");
const javascript = transformSync(declaration[0], { loader: "ts" }).code;

type Guard = { recheck(): Promise<void> } | null;
type Fence = <T>(
  args: string[],
  userData: string,
  generation: string,
  observe: () => Promise<Guard>,
  start: (
    guard: Guard,
    verify: () => Promise<boolean>,
    lease: PromotionLeaseHandle,
  ) => Promise<T>,
) => Promise<T>;

async function fixture(
  run: (f: {
    fence: Fence;
    root: string;
    events: string[];
    setBusy: () => void;
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "farol-main-lease-"));
  const events: string[] = [];
  let busy = false;
  const lease = {} as PromotionLeaseHandle;
  const ports = {
    acquire: vi.fn(async () => {
      events.push("acquire");
      return busy ? null : lease;
    }),
    verify: vi.fn(async () => {
      events.push("verify");
      return true;
    }),
    release: vi.fn(async () => {
      events.push("release");
    }),
  };
  const wrapper: typeof withStartupPromotionLease = (
    userData,
    generation,
    critical,
  ) => withStartupPromotionLease(userData, generation, critical, ports);
  const fence = new Function(
    "withStartupPromotionLease",
    `${javascript}; return withInstalledStartupFence;`,
  )(wrapper) as Fence;
  try {
    await run({
      fence,
      root,
      events,
      setBusy: () => {
        busy = true;
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("main startup update ordering", () => {
  it("wires main's real observer and startup callback through the fence", () => {
    const main = source.slice(source.indexOf("async function main("));
    expect(main).toMatch(
      /withInstalledStartupFence\(\s*process\.argv,[\s\S]*?observeUpdateRelaunch,\s*async \(updateRelaunch, verify, lease\)/,
    );
    expect(main).toMatch(
      /const observeUpdateRelaunch = \(\) =>\s*waitForInstalledUpdateRelaunch\(/,
    );
    const runtime = readFileSync(
      path.resolve("src/apps/desktop/installed-update-runtime.ts"),
      "utf8",
    );
    expect(runtime).toContain(
      'const RELAUNCH_ARGUMENT = "--farol-installed-update-relaunch"',
    );
  });

  it("observes ordinary startup only after lease and marker check and keeps the lease through startup", async () => {
    await fixture(async ({ fence, root, events }) => {
      const result = await fence(
        [],
        root,
        "build",
        async () => {
          events.push("observe-and-adopt");
          return null;
        },
        async (_guard, verify) => {
          events.push("startup");
          expect(await verify()).toBe(true);
          return 42;
        },
      );
      expect(result).toBe(42);
      expect(events).toEqual([
        "acquire",
        "verify",
        "observe-and-adopt",
        "startup",
        "verify",
        "release",
      ]);
    });
  });

  it.each(["busy", "pending"])(
    "refuses %s before ordinary observation or adoption",
    async (condition) => {
      await fixture(async ({ fence, root, events, setBusy }) => {
        if (condition === "busy") setBusy();
        else {
          await mkdir(path.join(root, "farol-state"));
          await writeFile(
            path.join(root, "farol-state", "installed-replacement.pending"),
            "pending",
          );
        }
        const observe = vi.fn(async () => null);
        const start = vi.fn(async () => true);
        await expect(fence([], root, "build", observe, start)).rejects.toThrow(
          condition === "busy"
            ? "STARTUP_PROMOTION_BUSY"
            : "STARTUP_INSTALLED_REPLACEMENT_PENDING",
        );
        expect(observe).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        expect(events).toEqual(
          condition === "busy" ? ["acquire"] : ["acquire", "verify", "release"],
        );
      });
    },
  );

  it.each([
    "--farol-installed-update-relaunch",
    "--farol-installed-update-relaunch={}",
  ])(
    "observes explicit or malformed hint %s before acquiring the lease",
    async (hint) => {
      await fixture(async ({ fence, root, events }) => {
        let finish!: () => void;
        const helperExit = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const result = fence(
          [hint],
          root,
          "build",
          async () => {
            events.push("wait-helper");
            await helperExit;
            events.push("helper-exited");
            return null;
          },
          async () => {
            events.push("startup");
            return true;
          },
        );
        expect(events).toEqual(["wait-helper"]);
        finish();
        await expect(result).resolves.toBe(true);
        expect(events).toEqual([
          "wait-helper",
          "helper-exited",
          "acquire",
          "verify",
          "startup",
          "release",
        ]);
      });
    },
  );

  it("never acquires the lease after explicit observation fails", async () => {
    await fixture(async ({ fence, root, events }) => {
      await expect(
        fence(
          ["--farol-installed-update-relaunch=bad"],
          root,
          "build",
          async () => {
            throw new Error("UPDATE_RELAUNCH_HINT_INVALID");
          },
          async () => true,
        ),
      ).rejects.toThrow("UPDATE_RELAUNCH_HINT_INVALID");
      expect(events).toEqual([]);
    });
  });

  it("releases the lease and refuses startup when ordinary observation fails", async () => {
    await fixture(async ({ fence, root, events }) => {
      const start = vi.fn(async () => true);
      await expect(
        fence(
          [],
          root,
          "build",
          async () => {
            events.push("observe");
            throw new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
          },
          start,
        ),
      ).rejects.toThrow("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      expect(start).not.toHaveBeenCalled();
      expect(events).toEqual(["acquire", "verify", "observe", "release"]);
    });
  });

  it("still refuses an explicit relaunch when the pending marker remains", async () => {
    await fixture(async ({ fence, root, events }) => {
      await mkdir(path.join(root, "farol-state"));
      await writeFile(
        path.join(root, "farol-state", "installed-replacement.pending"),
        "pending",
      );
      const start = vi.fn(async () => true);
      await expect(
        fence(
          ["--farol-installed-update-relaunch={}"],
          root,
          "build",
          async () => {
            events.push("helper-exited");
            return null;
          },
          start,
        ),
      ).rejects.toThrow("STARTUP_INSTALLED_REPLACEMENT_PENDING");
      expect(start).not.toHaveBeenCalled();
      expect(events).toEqual(["helper-exited", "acquire", "verify", "release"]);
    });
  });
});
