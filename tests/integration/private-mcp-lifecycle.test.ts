import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PrivateMcpLifecycle } from "../../src/modules/computer/infra/mcp/private-mcp-lifecycle";

const roots: string[] = [];
const oldDigest = "a".repeat(64);
const newDigest = "b".repeat(64);

async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-mcp-lifecycle-")),
  );
  roots.push(root);
  return { root, lifecycle: new PrivateMcpLifecycle(root) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin")(
  "private Computer MCP lifetime",
  () => {
    it("rechecks a clean prior host stop without clearing its protective marker", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      await lifecycle.beginStop();
      await lifecycle.confirmStop();
      const next = new PrivateMcpLifecycle(root);
      expect(await next.hasUnconfirmedStop()).toBe(true);
      await next.confirmCleanHostStop(true);
      expect(await next.hasUnconfirmedStop()).toBe(false);
      expect(await next.isStopping()).toBe(true);
      await expect(next.join(oldDigest)).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_REVOKED",
      );
    });

    it("keeps a clean markerless first startup free of stop side effects", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.confirmCleanHostStop(true);
      expect(await lifecycle.isStopping()).toBe(false);
      expect(await fs.readdir(root)).toEqual([]);
    });

    it("refuses adoption without trusted clean host evidence", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.beginStop();
      const next = new PrivateMcpLifecycle(root);
      await expect(next.confirmCleanHostStop(false)).rejects.toThrow(
        "COMPUTER_MCP_CLEAN_HOST_STOP_UNVERIFIED",
      );
      expect(await next.hasUnconfirmedStop()).toBe(true);
    });

    it("never adopts a stop issued in the current host lifetime", async () => {
      const { lifecycle } = await fixture();
      await lifecycle.beginStop();
      await expect(lifecycle.confirmCleanHostStop(true)).rejects.toThrow(
        "COMPUTER_MCP_CLEAN_HOST_STOP_UNVERIFIED",
      );
      expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
    });

    it("retains unresolved shell obligations despite clean host input", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.beginStop();
      const shellRoot = path.join(root, "execution-fence");
      await fs.mkdir(shellRoot, { mode: 0o700 });
      await fs.writeFile(path.join(shellRoot, "shell-unconfirmed"), "1\n", {
        mode: 0o600,
      });
      const next = new PrivateMcpLifecycle(root);
      await expect(next.confirmCleanHostStop(true)).rejects.toThrow(
        "COMPUTER_MCP_SHELL_CLEANUP_UNVERIFIED",
      );
      expect(await next.hasUnconfirmedStop()).toBe(true);
    });

    it("refuses a newer stop during startup marker observation", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.beginStop();
      await lifecycle.confirmStop();
      const next = new PrivateMcpLifecycle(root);
      vi.spyOn(next, "isStopping").mockImplementationOnce(async () => {
        await next.beginStop();
        return true;
      });
      await expect(next.confirmCleanHostStop(true)).rejects.toThrow(
        "COMPUTER_MCP_CLEAN_HOST_STOP_UNVERIFIED",
      );
      expect(await next.hasUnconfirmedStop()).toBe(true);
    });

    it("refuses a newer stop while releasing the startup lifetime lease", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.beginStop();
      await lifecycle.confirmStop();
      const next = new PrivateMcpLifecycle(root);
      const open = fs.open.bind(fs);
      let injected = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (!injected && String(args[0]).endsWith("/lifetime.lock")) {
          injected = true;
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementationOnce(async () => {
            await next.beginStop();
            await close();
          });
        }
        return handle;
      });
      await expect(next.confirmCleanHostStop(true)).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED",
      );
      expect(injected).toBe(true);
      expect(await next.hasUnconfirmedStop()).toBe(true);
    });

    it("retains the original stop acknowledgement while the protective marker remains", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      await lifecycle.beginStop();
      expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
      await lifecycle.confirmStop();
      expect(await lifecycle.isStopping()).toBe(true);
      expect(await lifecycle.hasUnconfirmedStop()).toBe(false);
      // Another owner lifetime cannot invent the original acknowledgement.
      expect(await new PrivateMcpLifecycle(root).hasUnconfirmedStop()).toBe(
        true,
      );
      expect(await lifecycle.isStopping()).toBe(true);
    });

    it("invalidates an original stop acknowledgement on a newer stop or preparation", async () => {
      const { lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      await lifecycle.beginStop();
      await lifecycle.confirmStop();
      await lifecycle.beginStop();
      expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
      await lifecycle.confirmStop();
      expect(await lifecycle.hasUnconfirmedStop()).toBe(false);
      // Invocation invalidates the old acknowledgement before awaited IO.
      const open = fs.open.bind(fs);
      let arrived!: () => void;
      let resume!: () => void;
      const atLock = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const release = new Promise<void>((resolve) => {
        resume = resolve;
      });
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (String(args[0]).endsWith("/lifetime.lock")) {
          arrived();
          await release;
        }
        return open(...args);
      });
      const preparing = lifecycle.prepare(newDigest);
      await atLock;
      expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
      resume();
      await preparing;
      expect(await lifecycle.isStopping()).toBe(false);
      expect(await lifecycle.hasUnconfirmedStop()).toBe(false);
    });

    it("retains unconfirmed stop after a final confirmation failure", async () => {
      const { lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      const live = await lifecycle.join(oldDigest);
      await lifecycle.beginStop();
      try {
        await expect(lifecycle.confirmStop(0)).rejects.toThrow(
          "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
        );
        expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
      } finally {
        await live.release();
      }
      // Lease absence does not upgrade the original failed confirmation.
      expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
      expect(await lifecycle.isStopping()).toBe(true);
    });

    it("refuses an original confirmation when a newer stop wins before lease release", async () => {
      const { lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      await lifecycle.beginStop();
      const open = fs.open.bind(fs);
      let injected = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (!injected && String(args[0]).endsWith("/lifetime.lock")) {
          injected = true;
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementationOnce(async () => {
            await lifecycle.beginStop();
            await close();
          });
        }
        return handle;
      });
      await expect(lifecycle.confirmStop()).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED",
      );
      expect(injected).toBe(true);
      expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
      expect(await lifecycle.isStopping()).toBe(true);
    });

    it("does not reinstate an old acknowledgement after concurrent launch preparation", async () => {
      const { lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      await lifecycle.beginStop();
      const open = fs.open.bind(fs);
      let preparing: Promise<void> | undefined;
      let injected = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (!injected && String(args[0]).endsWith("/lifetime.lock")) {
          injected = true;
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementationOnce(async () => {
            preparing = lifecycle.prepare(newDigest);
            await close();
          });
        }
        return handle;
      });
      await expect(lifecycle.confirmStop()).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED",
      );
      expect(injected).toBe(true);
      await preparing;
      // Only the distinct new preparation removed admission's old marker.
      expect(await lifecycle.isStopping()).toBe(false);
    });

    it("waits for the exact MCP lease and marker before stopping its tunnel parent", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      const live = await lifecycle.join(oldDigest);
      await lifecycle.beginStop();
      try {
        await expect(lifecycle.waitForStop(0)).rejects.toThrow(
          "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
        );
      } finally {
        await live.release();
      }
      await lifecycle.waitForStop();
      // Graceful drain alone is not final revocation or a clean Quit receipt.
      await expect(
        fs.lstat(path.join(root, "mcp-lifecycle", `revoked-${oldDigest}`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lifecycle.join(oldDigest)).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_REVOKED",
      );
      await lifecycle.confirmStop();
      expect(
        await fs.readFile(
          path.join(root, "mcp-lifecycle", `revoked-${oldDigest}`),
          "utf8",
        ),
      ).toBe("1\n");
    });

    it.each(["file", "directory"])(
      "preserves a newer stop while preparation clears an old %s marker",
      async (kind) => {
        const { root, lifecycle } = await fixture();
        await lifecycle.prepare(oldDigest);
        if (kind === "directory") await lifecycle.beginClosedRecoveryStop();
        else await lifecycle.beginStop();
        await lifecycle.confirmStop();
        const stopping = path.join(root, "mcp-lifecycle", "stopping");
        const unlink = fs.unlink.bind(fs);
        const rmdir = fs.rmdir.bind(fs);
        let arrived!: () => void;
        const atUnlink = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        let resume!: () => void;
        const resumeUnlink = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const beforeRemove = async (
          target: Parameters<typeof fs.unlink>[0],
        ) => {
          if (target === stopping) {
            arrived();
            await resumeUnlink;
          }
        };
        vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
          await beforeRemove(target);
          await unlink(target);
        });
        vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
          await beforeRemove(args[0]);
          await rmdir(...args);
        });
        const preparing = lifecycle.prepare(newDigest);
        // Observe rejection immediately so the real-file interleaving has no unhandled promise.
        const outcome = preparing.then(
          () => null,
          (error: unknown) => error,
        );
        await atUnlink;
        try {
          await lifecycle.beginStop();
        } finally {
          resume();
        }
        expect(await outcome).toMatchObject({
          message: "COMPUTER_MCP_PREPARATION_STOPPED",
        });
        expect(await lifecycle.isStopping()).toBe(true);
        await lifecycle.waitForStop();
        await expect(lifecycle.join(newDigest)).rejects.toThrow(
          "COMPUTER_MCP_LIFECYCLE_REVOKED",
        );
      },
    );

    it("rejects a preparation queued behind a lifetime lease when Stop wins admission", async () => {
      const { lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      const live = await lifecycle.join(oldDigest);
      const preparing = lifecycle.prepare(newDigest);
      const outcome = preparing.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await lifecycle.beginStop();
      } finally {
        await live.release();
      }
      expect(await outcome).toMatchObject({
        message: "COMPUTER_MCP_PREPARATION_STOPPED",
      });
      expect(await lifecycle.isStopping()).toBe(true);
      await lifecycle.confirmStop();
      // A deliberate later start still works after a confirmed stop.
      await lifecycle.prepare("c".repeat(64));
      const next = await lifecycle.join("c".repeat(64));
      await next.release();
    });

    it("requires stop admission even when no MCP lease is held", async () => {
      const { lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      await expect(lifecycle.waitForStop()).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED",
      );
    });

    it("denies a new join after stop and requires the exact live MCP lease to leave", async () => {
      const { lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      const live = await lifecycle.join(oldDigest);
      try {
        await lifecycle.beginStop();
        expect(await lifecycle.isStopping()).toBe(true);
        await expect(lifecycle.join(oldDigest)).rejects.toThrow(
          "COMPUTER_MCP_LIFECYCLE_REVOKED",
        );
        await expect(lifecycle.confirmStop(0)).rejects.toThrow(
          "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
        );
        await expect(lifecycle.confirmStop(50)).rejects.toThrow(
          "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
        );
      } finally {
        await live.release();
        await live.release();
      }
      await lifecycle.confirmStop();
      await lifecycle.prepare(newDigest);
      expect(await lifecycle.isStopping()).toBe(false);
      await expect(lifecycle.join(oldDigest)).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_REVOKED",
      );
      const next = await lifecycle.join(newDigest);
      await next.release();
    });

    it("refuses stop and future start while a shell-group marker is unresolved", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      const markerRoot = path.join(root, "execution-fence");
      await fs.mkdir(markerRoot, { mode: 0o700 });
      const marker = path.join(markerRoot, `shell-${"c".repeat(64)}.json`);
      await fs.writeFile(marker, "{}", { mode: 0o600 });
      await lifecycle.beginStop();
      await expect(lifecycle.waitForStop(0)).rejects.toThrow(
        "COMPUTER_MCP_SHELL_CLEANUP_UNVERIFIED",
      );
      await expect(lifecycle.confirmStop(0)).rejects.toThrow(
        "COMPUTER_MCP_SHELL_CLEANUP_UNVERIFIED",
      );
      await expect(lifecycle.prepare(newDigest)).rejects.toThrow(
        "COMPUTER_MCP_SHELL_CLEANUP_UNVERIFIED",
      );
      await fs.unlink(marker);
      await lifecycle.confirmStop();
    });

    it("refuses an unprepared or replaced launch digest before serving", async () => {
      const { lifecycle } = await fixture();
      await expect(lifecycle.join(oldDigest)).rejects.toThrow();
      await lifecycle.prepare(oldDigest);
      await expect(lifecycle.join(newDigest)).rejects.toThrow();
    });

    it("preserves inactive MCP history without treating it as a live lease", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      await fs.writeFile(
        path.join(
          root,
          "mcp-lifecycle",
          "active-11111111-1111-4111-8111-111111111111",
        ),
        "1\n",
        { mode: 0o600 },
      );
      await lifecycle.beginStop();
      await lifecycle.waitForStop(0);
      await lifecycle.confirmStop(0);
      await lifecycle.prepare(newDigest);
      expect(
        await fs.readFile(
          path.join(
            root,
            "mcp-lifecycle",
            "active-11111111-1111-4111-8111-111111111111",
          ),
          "utf8",
        ),
      ).toBe("1\n");
    });

    it("releases a drained UNKNOWN lifetime while retaining its original history", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      const live = await lifecycle.join(oldDigest);
      await lifecycle.beginStop();
      await expect(lifecycle.waitForStop(0)).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
      );
      await live.release({ effectsUnresolved: true });
      await live.release({ effectsUnresolved: false });
      await lifecycle.waitForStop(0);
      await lifecycle.confirmStop(0);
      expect(
        (await fs.readdir(path.join(root, "mcp-lifecycle"))).filter((name) =>
          name.startsWith("active-"),
        ),
      ).toHaveLength(1);
    });

    it("holds the existing exclusive MCP lock through fresh native admission without acknowledging the old Quit", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      const live = await lifecycle.join(oldDigest);
      await lifecycle.beginStop();
      const start = vi.fn(async () => "current-native-owner");
      await expect(lifecycle.withInactiveForFreshStart(start)).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
      );
      expect(start).not.toHaveBeenCalled();
      await live.release({ effectsUnresolved: true });
      await expect(
        lifecycle.withInactiveForFreshStart(async () => {
          await expect(lifecycle.join(oldDigest)).rejects.toThrow(
            "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
          );
          return start();
        }),
      ).resolves.toBe("current-native-owner");
      expect(await lifecycle.hasUnconfirmedStop()).toBe(false);
      expect(await new PrivateMcpLifecycle(root).hasUnconfirmedStop()).toBe(
        true,
      );
      expect(
        (await fs.readdir(path.join(root, "mcp-lifecycle"))).filter((name) =>
          name.startsWith("active-"),
        ),
      ).toHaveLength(1);
      await expect(lifecycle.join(oldDigest)).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_REVOKED",
      );
      await lifecycle.beginStop();
      expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
    });

    it("retains the original stop when fresh native admission fails", async () => {
      const { lifecycle } = await fixture();
      await lifecycle.beginStop();
      await expect(
        lifecycle.withInactiveForFreshStart(async () => {
          throw Error("native owner busy");
        }),
      ).rejects.toThrow("native owner busy");
      expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
    });

    it("retires an inactive instance only through explicit, fenced reconciliation, without confirming its old stop", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      const instance = "active-11111111-1111-4111-8111-111111111111";
      const directory = path.join(root, "mcp-lifecycle");
      await fs.writeFile(path.join(directory, instance), "1\n", {
        mode: 0o600,
      });
      await lifecycle.beginStop();
      const proveIdle = vi.fn(async () => undefined);
      const operationId = "22222222-2222-4222-8222-222222222222";
      await lifecycle.reconcileInactive({
        operationId,
        failedQuitSha256: "d".repeat(64),
        proveIdle,
      });
      expect(proveIdle).toHaveBeenCalledOnce();
      const archive = path.join(directory, `retired-${operationId}`);
      expect(await fs.readFile(path.join(archive, instance), "utf8")).toBe(
        "1\n",
      );
      const receipt = JSON.parse(
        await fs.readFile(path.join(archive, "completed.json"), "utf8"),
      );
      expect(receipt).toMatchObject({
        phase: "retired_unconfirmed",
        failedQuitSha256: "d".repeat(64),
        instances: [instance],
      });
      expect(receipt).not.toHaveProperty("drained");
      expect(await lifecycle.isStopping()).toBe(true);
      await expect(lifecycle.join(oldDigest)).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_REVOKED",
      );
      await lifecycle.prepare(newDigest);
      const next = await lifecycle.join(newDigest);
      await next.release();
    });

    it("does not reconcile a live lease, outstanding work, or an unsafe instance", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      const live = await lifecycle.join(oldDigest);
      await lifecycle.beginStop();
      const proveIdle = vi.fn(async () => {
        throw new Error("WORK_PENDING");
      });
      const input = {
        operationId: "33333333-3333-4333-8333-333333333333",
        failedQuitSha256: "e".repeat(64),
        proveIdle,
      };
      try {
        await expect(lifecycle.reconcileInactive(input)).rejects.toThrow(
          "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
        );
        expect(proveIdle).not.toHaveBeenCalled();
      } finally {
        await live.release();
      }
      const marker = path.join(
        root,
        "mcp-lifecycle",
        "active-44444444-4444-4444-8444-444444444444",
      );
      await fs.writeFile(marker, "1\n", { mode: 0o600 });
      await expect(lifecycle.reconcileInactive(input)).rejects.toThrow(
        "WORK_PENDING",
      );
      expect(await fs.readFile(marker, "utf8")).toBe("1\n");
      await fs.writeFile(marker, "corrupt");
      await expect(
        lifecycle.reconcileInactive({
          ...input,
          proveIdle: async () => undefined,
        }),
      ).rejects.toThrow("COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE");
    });

    it("keeps normal start fenced after a partial reconciliation and resumes only that exact operation", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      await lifecycle.beginStop();
      const directory = path.join(root, "mcp-lifecycle");
      const instance = "active-55555555-5555-4555-8555-555555555555";
      await fs.writeFile(path.join(directory, instance), "1\n", {
        mode: 0o600,
      });
      const input = {
        operationId: "66666666-6666-4666-8666-666666666666",
        failedQuitSha256: "f".repeat(64),
        proveIdle: async () => undefined,
      };
      const rename = fs.rename.bind(fs);
      const fault = vi
        .spyOn(fs, "rename")
        .mockRejectedValueOnce(new Error("RENAME_FAULT"));
      await expect(lifecycle.reconcileInactive(input)).rejects.toThrow(
        "RENAME_FAULT",
      );
      fault.mockImplementation(rename);
      await expect(lifecycle.prepare(newDigest)).rejects.toThrow(
        "COMPUTER_MCP_RECONCILIATION_PENDING",
      );
      await expect(lifecycle.confirmStop()).rejects.toThrow(
        "COMPUTER_MCP_RECONCILIATION_PENDING",
      );
      await expect(
        lifecycle.reconcileInactive({
          ...input,
          operationId: "77777777-7777-4777-8777-777777777777",
        }),
      ).rejects.toThrow("COMPUTER_MCP_RECONCILIATION_PENDING");
      await lifecycle.reconcileInactive(input);
      await lifecycle.prepare(newDigest);
    });

    it("resumes only the same operation after pending-marker creation is interrupted", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      await lifecycle.beginStop();
      const directory = path.join(root, "mcp-lifecycle");
      const instance = "active-55555555-5555-4555-8555-555555555555";
      await fs.writeFile(path.join(directory, instance), "1\n", {
        mode: 0o600,
      });
      const input = {
        operationId: "66666666-6666-4666-8666-666666666666",
        failedQuitSha256: "f".repeat(64),
        proveIdle: async () => undefined,
      };
      const pending = path.join(directory, `reconciling-${input.operationId}`);
      const open = fs.open.bind(fs);
      const mkdir = fs.mkdir.bind(fs);
      let interrupted = false;
      const openFault = vi
        .spyOn(fs, "open")
        .mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (
            !interrupted &&
            String(args[0]) === pending &&
            typeof args[1] === "number" &&
            args[1] & 1
          ) {
            interrupted = true;
            vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
              throw new Error("PENDING_PUBLICATION_INTERRUPTED");
            });
          }
          return handle;
        });
      const mkdirFault = vi
        .spyOn(fs, "mkdir")
        .mockImplementation(async (...args) => {
          const result = await mkdir(...args);
          if (!interrupted && String(args[0]) === pending) {
            interrupted = true;
            throw new Error("PENDING_PUBLICATION_INTERRUPTED");
          }
          return result;
        });
      await expect(lifecycle.reconcileInactive(input)).rejects.toThrow(
        "PENDING_PUBLICATION_INTERRUPTED",
      );
      openFault.mockRestore();
      mkdirFault.mockRestore();
      const pendingInode = (await fs.lstat(pending)).ino;
      await expect(lifecycle.prepare(newDigest)).rejects.toThrow(
        "COMPUTER_MCP_RECONCILIATION_PENDING",
      );
      await expect(
        lifecycle.reconcileInactive({
          ...input,
          operationId: "77777777-7777-4777-8777-777777777777",
        }),
      ).rejects.toThrow("COMPUTER_MCP_RECONCILIATION_PENDING");
      expect((await fs.lstat(pending)).ino).toBe(pendingInode);
      await lifecycle.reconcileInactive(input);
      expect(
        await fs.readFile(
          path.join(directory, `retired-${input.operationId}`, instance),
          "utf8",
        ),
      ).toBe("1\n");
      await expect(fs.lstat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      await lifecycle.prepare(newDigest);
    });

    it.each(["public", "symlink", "nonempty", "legacy-partial"])(
      "refuses an unsafe %s pending marker without moving an instance",
      async (kind) => {
        const { root, lifecycle } = await fixture();
        await lifecycle.prepare(oldDigest);
        await lifecycle.beginStop();
        const directory = path.join(root, "mcp-lifecycle");
        const instance = path.join(
          directory,
          "active-55555555-5555-4555-8555-555555555555",
        );
        await fs.writeFile(instance, "1\n", { mode: 0o600 });
        const operationId = "66666666-6666-4666-8666-666666666666";
        const pending = path.join(directory, `reconciling-${operationId}`);
        if (kind === "symlink") await fs.symlink(directory, pending);
        else if (kind === "legacy-partial")
          await fs.writeFile(pending, "", { mode: 0o600 });
        else {
          await fs.mkdir(pending, { mode: kind === "public" ? 0o755 : 0o700 });
          if (kind === "nonempty")
            await fs.writeFile(path.join(pending, "foreign"), "retain", {
              mode: 0o600,
            });
        }
        await expect(
          lifecycle.reconcileInactive({
            operationId,
            failedQuitSha256: "f".repeat(64),
            proveIdle: async () => undefined,
          }),
        ).rejects.toThrow();
        expect(await fs.readFile(instance, "utf8")).toBe("1\n");
        expect((await fs.lstat(pending)).ino).toBeGreaterThan(0);
      },
    );

    it.each(["prepared.json", "completed.json"])(
      "resumes an interrupted %s publication without accepting partial journal bytes",
      async (name) => {
        const { root, lifecycle } = await fixture();
        await lifecycle.prepare(oldDigest);
        await lifecycle.beginStop();
        const directory = path.join(root, "mcp-lifecycle");
        const instance = "active-55555555-5555-4555-8555-555555555555";
        await fs.writeFile(path.join(directory, instance), "1\n", {
          mode: 0o600,
        });
        const input = {
          operationId: "66666666-6666-4666-8666-666666666666",
          failedQuitSha256: "f".repeat(64),
          proveIdle: async () => undefined,
        };
        const open = fs.open.bind(fs);
        let interrupted = false;
        const fault = vi
          .spyOn(fs, "open")
          .mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (
              !interrupted &&
              String(args[0]).includes(name) &&
              typeof args[1] === "number" &&
              args[1] & 1
            ) {
              interrupted = true;
              const write = handle.writeFile.bind(handle);
              vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
                await write('{"schema":');
                throw new Error("JOURNAL_WRITE_INTERRUPTED");
              });
            }
            return handle;
          });
        await expect(lifecycle.reconcileInactive(input)).rejects.toThrow(
          "JOURNAL_WRITE_INTERRUPTED",
        );
        fault.mockRestore();
        const archive = path.join(directory, `retired-${input.operationId}`);
        await expect(fs.lstat(path.join(archive, name))).rejects.toMatchObject({
          code: "ENOENT",
        });
        const remnants = (await fs.readdir(archive)).filter((entry) =>
          entry.startsWith(`.${name}.`),
        );
        expect(remnants).toHaveLength(1);
        const staged = path.join(archive, remnants[0]!);
        const inode = (await fs.lstat(staged)).ino;
        await expect(lifecycle.prepare(newDigest)).rejects.toThrow(
          "COMPUTER_MCP_RECONCILIATION_PENDING",
        );
        await lifecycle.reconcileInactive(input);
        expect(await fs.readFile(staged, "utf8")).toBe('{"schema":');
        expect((await fs.lstat(staged)).ino).toBe(inode);
        expect(await fs.readFile(path.join(archive, instance), "utf8")).toBe(
          "1\n",
        );
        await lifecycle.prepare(newDigest);
      },
    );

    it.each(["", "1"])(
      "refuses an already partial final revocation %s without repairing it",
      async (bytes) => {
        const { root, lifecycle } = await fixture();
        await lifecycle.prepare(oldDigest);
        await lifecycle.beginStop();
        const directory = path.join(root, "mcp-lifecycle");
        const instance = path.join(
          directory,
          "active-55555555-5555-4555-8555-555555555555",
        );
        const revoked = path.join(directory, `revoked-${oldDigest}`);
        await fs.writeFile(instance, "1\n", { mode: 0o600 });
        await fs.writeFile(revoked, bytes, { mode: 0o600 });
        const inode = (await fs.lstat(revoked)).ino;
        await expect(
          lifecycle.reconcileInactive({
            operationId: "66666666-6666-4666-8666-666666666666",
            failedQuitSha256: "f".repeat(64),
            proveIdle: async () => undefined,
          }),
        ).rejects.toThrow("COMPUTER_MCP_RECONCILIATION_CHANGED");
        expect(await fs.readFile(revoked, "utf8")).toBe(bytes);
        expect((await fs.lstat(revoked)).ino).toBe(inode);
        expect(await fs.readFile(instance, "utf8")).toBe("1\n");
        await expect(lifecycle.prepare(newDigest)).rejects.toThrow(
          "COMPUTER_MCP_RECONCILIATION_PENDING",
        );
      },
    );

    it.each(
      ["prepared.json", `revoked-${oldDigest}`].flatMap((name) =>
        ["public", "hardlink", "symlink", "oversize"].map((kind) => ({
          name,
          kind,
        })),
      ),
    )(
      "refuses a $kind $name remnant without retiring an instance",
      async ({ kind, name }) => {
        const { root, lifecycle } = await fixture();
        await lifecycle.prepare(oldDigest);
        await lifecycle.beginStop();
        const directory = path.join(root, "mcp-lifecycle");
        const instance = path.join(
          directory,
          "active-55555555-5555-4555-8555-555555555555",
        );
        await fs.writeFile(instance, "1\n", { mode: 0o600 });
        const inode = (await fs.lstat(instance)).ino;
        const operationId = "66666666-6666-4666-8666-666666666666";
        const archive = path.join(directory, `retired-${operationId}`);
        await fs.mkdir(archive, { mode: 0o700 });
        const temporary = path.join(
          archive,
          `.${name}.88888888-8888-4888-8888-888888888888.tmp`,
        );
        const sentinel = path.join(root, "sentinel");
        await fs.writeFile(sentinel, "unchanged", { mode: 0o600 });
        if (kind === "symlink") await fs.symlink(sentinel, temporary);
        else if (kind === "hardlink") await fs.link(sentinel, temporary);
        else
          await fs.writeFile(
            temporary,
            kind === "oversize" ? Buffer.alloc(8193) : "partial",
            { mode: kind === "public" ? 0o644 : 0o600 },
          );
        await expect(
          lifecycle.reconcileInactive({
            operationId,
            failedQuitSha256: "f".repeat(64),
            proveIdle: async () => undefined,
          }),
        ).rejects.toThrow();
        expect((await fs.lstat(instance)).ino).toBe(inode);
        expect(await fs.readFile(instance, "utf8")).toBe("1\n");
        expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged");
      },
    );

    it("keeps handler admission open until every admitted handler settles", async () => {
      const { lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      const live = await lifecycle.join(oldDigest);
      const finishHandler = lifecycle.enterHandler();
      expect(finishHandler).not.toBeNull();
      await lifecycle.beginStop();
      lifecycle.closeHandlers();
      expect(lifecycle.enterHandler()).toBeNull();
      await expect(lifecycle.waitForHandlers(0)).rejects.toThrow(
        "COMPUTER_MCP_HANDLERS_UNVERIFIED",
      );
      finishHandler?.();
      finishHandler?.();
      await lifecycle.waitForHandlers(0);
      await live.release();
      await lifecycle.confirmStop();
    });

    it("refuses malformed launch identities and an unconfirmed stop", async () => {
      expect(() => new PrivateMcpLifecycle("relative-root")).toThrow(
        "COMPUTER_MCP_LIFECYCLE_ROOT_INVALID",
      );
      const { lifecycle } = await fixture();
      await expect(lifecycle.prepare("bad")).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_DIGEST_INVALID",
      );
      await expect(lifecycle.join("bad")).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_DIGEST_INVALID",
      );
      await expect(lifecycle.confirmStop()).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED",
      );
    });

    it("refuses permissive roots and lifetime locks before any MCP join", async () => {
      const { root, lifecycle } = await fixture();
      await fs.chmod(root, 0o755);
      await expect(lifecycle.prepare(oldDigest)).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_ROOT_UNSAFE",
      );
      await fs.chmod(root, 0o700);
      const lock = path.join(root, "mcp-lifecycle", "lifetime.lock");
      await fs.writeFile(lock, "", { mode: 0o600 });
      await fs.chmod(lock, 0o666);
      await expect(lifecycle.prepare(oldDigest)).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
      );
    });

    it("refuses corrupt persisted markers and malformed prepared names", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      const directory = path.join(root, "mcp-lifecycle");
      const prepared = path.join(directory, `prepared-${oldDigest}`);
      await fs.writeFile(prepared, "corrupt\n");
      await expect(lifecycle.prepare(newDigest)).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE",
      );
      await fs.writeFile(prepared, "1\n");
      await fs.writeFile(path.join(directory, "prepared-malformed"), "1\n", {
        mode: 0o600,
      });
      await expect(lifecycle.prepare(newDigest)).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE",
      );
    });

    it("does not reuse a revoked digest after an idempotent stop", async () => {
      const { lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      await lifecycle.beginStop();
      await lifecycle.beginStop();
      await lifecycle.confirmStop();
      await expect(lifecycle.prepare(oldDigest)).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_DIGEST_REUSED",
      );
    });

    it("refuses an unreadable shell-cleanup boundary", async () => {
      const { root, lifecycle } = await fixture();
      await fs.writeFile(path.join(root, "execution-fence"), "not a directory");
      await expect(lifecycle.prepare(oldDigest)).rejects.toThrow();
    });

    it("waits for a held handler to finish before confirming its drain", async () => {
      const { lifecycle } = await fixture();
      const finishHandler = lifecycle.enterHandler();
      const pending = lifecycle.waitForHandlers(200);
      setTimeout(() => finishHandler?.(), 40);
      await pending;
    });

    it("refuses unreadable and unwritable lifecycle marker directories", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      const directory = path.join(root, "mcp-lifecycle");
      try {
        await fs.chmod(directory, 0o000);
        await expect(lifecycle.isStopping()).rejects.toThrow();
        await fs.chmod(directory, 0o500);
        await expect(lifecycle.beginStop()).rejects.toThrow();
      } finally {
        await fs.chmod(directory, 0o700);
      }
    });
  },
);
