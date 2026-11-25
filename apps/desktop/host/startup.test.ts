import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartup, type StartupPorts } from "./startup";

// Startup admission over scripted owners and a disposable state root. Main's
// `let`s are fields the ports read afresh; the lease and the update relaunch
// are recorders. The run-marker writer is the real one, so a marker on disk is
// the evidence that admission completed. These cases cover the fresh, no-core,
// lost-lease and unclean-without-Settings paths.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "farol-startup-"));
  roots.push(root);
  return root;
}

function ports(
  root: string,
  overrides: Partial<StartupPorts> = {},
  log: string[] = [],
): StartupPorts {
  return {
    app: {
      whenReady: async () => {
        log.push("ready");
      },
      hasSingleInstanceLock: () => true,
    },
    stateRoot: root,
    compiledGoCore: {},
    installedUpdates: { resourcesOrigin: undefined },
    desktopAdmission: { quitInProgress: false },
    primaryInstanceLock: () => true,
    runtimeStopping: () => false,
    startupStage: (stage) => log.push(`stage:${stage}`),
    ...overrides,
  };
}

const lease = {} as Parameters<ReturnType<typeof createStartup>["admit"]>[2];
const marker = (root: string) => path.join(root, "running.json");

describe("startup admission", () => {
  it("admits a clean fresh Go start and writes the run marker last", async () => {
    const root = await stateRoot();
    const log: string[] = [];
    const recheck = vi.fn(async () => {});
    const origin = { execution: { directory: "/origin" } };
    const owner = ports(root, {}, log);
    const host = createStartup(owner);
    await expect(
      host.admit(
        { resourcesOrigin: origin, recheck } as never,
        async () => true,
        lease,
      ),
    ).resolves.toBe(true);
    expect(owner.installedUpdates.resourcesOrigin).toBe(origin);
    expect(recheck).toHaveBeenCalled();
    expect(host.freshStartup()).toBe(true);
    expect(log).toEqual([
      "stage:before-ready",
      "ready",
      "stage:ready",
      "stage:run-marker",
    ]);
    await expect(stat(marker(root))).resolves.toBeTruthy();
  });

  it("without a compiled core admits a clean predecessor as an ordinary start", async () => {
    const root = await stateRoot();
    const log: string[] = [];
    const host = createStartup(ports(root, { compiledGoCore: null }, log));
    await expect(
      host.admit(undefined as never, async () => true, lease),
    ).resolves.toBe(true);
    expect(host.freshStartup()).toBe(false);
    expect(log.at(-1)).toBe("stage:run-marker");
  });

  it("refuses a lost lease before writing the run marker", async () => {
    const root = await stateRoot();
    const log: string[] = [];
    const host = createStartup(ports(root, {}, log));
    await expect(
      host.admit(undefined as never, async () => false, lease),
    ).rejects.toThrow("STARTUP_PROMOTION_LEASE_LOST");
    expect(log).not.toContain("stage:run-marker");
    await expect(stat(marker(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a fresh start after an unclean predecessor when saved Settings cannot be loaded", async () => {
    const root = await stateRoot();
    await writeFile(marker(root), "{}");
    const log: string[] = [];
    const host = createStartup(ports(root, {}, log));
    // Saved Settings are mandatory after an unclean predecessor. This root has
    // none, so loading refuses or finds nothing, admission throws, and the old
    // marker is left exactly as it was: no history move, no new marker.
    await expect(
      host.admit(undefined as never, async () => true, lease),
    ).rejects.toThrow();
    expect(log).toEqual(["stage:before-ready", "ready", "stage:ready"]);
    await expect(readFile(marker(root), "utf8")).resolves.toBe("{}");
  });
});
