import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin")(
  "private Computer MCP lifetime",
  () => {
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

    it("retains an unacknowledged MCP instance after its lease disappears", async () => {
      const { root, lifecycle } = await fixture();
      await lifecycle.prepare(oldDigest);
      await fs.writeFile(
        path.join(root, "mcp-lifecycle", "active-crash-canary"),
        "1\n",
        { mode: 0o600 },
      );
      await lifecycle.beginStop();
      await expect(lifecycle.waitForStop(0)).rejects.toThrow(
        "COMPUTER_MCP_INSTANCE_CLEANUP_UNVERIFIED",
      );
      await expect(lifecycle.confirmStop(0)).rejects.toThrow(
        "COMPUTER_MCP_INSTANCE_CLEANUP_UNVERIFIED",
      );
      await expect(lifecycle.prepare(newDigest)).rejects.toThrow(
        "COMPUTER_MCP_INSTANCE_CLEANUP_UNVERIFIED",
      );
    });

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
