import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverClosedComputer } from "../../src/apps/desktop/closed-computer-recovery";
import { PrivateMcpLifecycle } from "../../src/modules/computer/infra/mcp/private-mcp-lifecycle";
import { PrivateExecutionFence } from "../../src/modules/computer/infra/mcp/execution-fence";

const roots: string[] = [];
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const userData = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-closed-recovery-")),
  );
  roots.push(userData);
  const state = path.join(userData, "farol-next-state");
  const root = path.join(state, "secure-mcp-connector/computer-authority");
  await fs.mkdir(root, { mode: 0o700, recursive: true });
  const run = `${JSON.stringify({ schema: 1, pid: 1111111, startedAt: "2026-10-01T00:00:00.000Z", bootTime: 100000, processStart: "old-process" })}\n`;
  const quit = `${JSON.stringify({ schema: 1, at: "2026-10-01T00:01:00.000Z", drained: false, unconfirmed: ["connector"] })}\n`;
  await fs.writeFile(path.join(state, "running.json"), run, { mode: 0o600 });
  await fs.writeFile(path.join(state, "last-quit.json"), quit, { mode: 0o600 });
  const lifecycle = new PrivateMcpLifecycle(root);
  await lifecycle.prepare("a".repeat(64));
  await lifecycle.beginStop();
  const instance = "active-11111111-1111-4111-8111-111111111111";
  await fs.writeFile(path.join(root, "mcp-lifecycle", instance), "1\n", {
    mode: 0o600,
  });
  const desktopState = vi.fn(async () => ({
    obligations: ["QUIT_UNCONFIRMED:connector", "QUIT_UNCONFIRMED:crash"],
    unreadable: [],
    changed: [],
  }));
  const input = {
    userData,
    operationId: "22222222-2222-4222-8222-222222222222",
    expectedRunSha256: sha(run),
    expectedQuitSha256: sha(quit),
    desktopState,
  };
  const processesAbsent = vi.fn(() => undefined);
  const probes = {
    run: { bootTime: 100000, isAlive: () => false, processStart: () => null },
    processesAbsent,
  };
  return { input, probes, root, state, lifecycle, instance, run, quit };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin")(
  "explicit closed Computer reconciliation (disposable state, no provider)",
  () => {
    it("retains exact failed evidence and shell no-replay identities, retires only the inactive markers", async () => {
      const f = await fixture();
      const shell = path.join(f.root, "shell-v2", "b".repeat(64));
      await fs.mkdir(shell, { mode: 0o700, recursive: true });
      const reservation = path.join(shell, `shell-${"c".repeat(64)}.json`);
      const reserved = JSON.stringify({
        handle: "33333333-3333-4333-8333-333333333333",
        fingerprint: "d".repeat(64),
      });
      await fs.writeFile(reservation, reserved, { mode: 0o600 });
      const result = await recoverClosedComputer(f.input, f.probes);
      expect(result.phase).toBe("retired_unconfirmed");
      expect(
        await fs.readFile(path.join(result.archive, "running.json"), "utf8"),
      ).toBe(f.run);
      expect(
        await fs.readFile(path.join(result.archive, "last-quit.json"), "utf8"),
      ).toBe(f.quit);
      expect(await fs.readFile(reservation, "utf8")).toBe(reserved);
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(result.archive, "completed.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        phase: "retired_unconfirmed",
        retainedShellReservations: 1,
      });
      await expect(
        fs.lstat(path.join(f.state, "running.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await f.lifecycle.prepare("e".repeat(64));
      await expect(f.lifecycle.join("a".repeat(64))).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_REVOKED",
      );
    });

    for (const scenario of [
      "live-app",
      "desktop-work",
      "process-unverified",
      "mutation",
      "codex",
      "shell-scratch",
      "shell-fence",
    ] as const) {
      it(`preserves failed markers when ${scenario} prevents reconciliation`, async () => {
        const f = await fixture();
        if (scenario === "live-app") f.probes.run.isAlive = () => true;
        if (scenario === "desktop-work")
          f.input.desktopState.mockResolvedValue({
            obligations: ["TASK_OUTCOME_UNKNOWN:1"],
            unreadable: [],
            changed: [],
          });
        if (scenario === "process-unverified")
          f.probes.processesAbsent.mockImplementation(() => {
            throw new Error("CLOSED_COMPUTER_RECOVERY_PROCESS_UNVERIFIED");
          });
        if (scenario === "mutation" || scenario === "codex") {
          const directory = path.join(
            f.root,
            scenario === "mutation" ? "mutations" : "codex-task-journal",
          );
          await fs.mkdir(directory, { mode: 0o700 });
          await fs.writeFile(path.join(directory, "unresolved.json"), "{}", {
            mode: 0o600,
          });
        }
        if (scenario === "shell-scratch") {
          await fs.mkdir(
            path.join(f.root, "shell-v2", "b".repeat(64), "shell-tmp-leftover"),
            { mode: 0o700, recursive: true },
          );
        }
        if (scenario === "shell-fence") {
          const fence = new PrivateExecutionFence({ root: f.root });
          const admitted = await fence.acquireAdmission();
          if (!admitted.admitted) throw new Error("fixture admission failed");
          try {
            await fence.reserveShell("unknown-shell");
          } finally {
            await admitted.release();
          }
        }
        await expect(
          recoverClosedComputer(f.input, f.probes),
        ).rejects.toThrow();
        expect(
          await fs.readFile(path.join(f.state, "running.json"), "utf8"),
        ).toBe(f.run);
        expect(
          await fs.readFile(path.join(f.state, "last-quit.json"), "utf8"),
        ).toBe(f.quit);
        expect(
          await fs.readFile(
            path.join(f.root, "mcp-lifecycle", f.instance),
            "utf8",
          ),
        ).toBe("1\n");
      });
    }

    it("resumes a partial metadata retirement only from the exact original evidence", async () => {
      const f = await fixture();
      const unlink = fs.unlink.bind(fs);
      const fault = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
        if (file === path.join(f.state, "running.json"))
          throw new Error("FINAL_MARKER_FAULT");
        return unlink(file);
      });
      await expect(recoverClosedComputer(f.input, f.probes)).rejects.toThrow(
        "FINAL_MARKER_FAULT",
      );
      fault.mockRestore();
      expect(
        await fs.readFile(path.join(f.state, "running.json"), "utf8"),
      ).toBe(f.run);
      await expect(
        recoverClosedComputer(
          { ...f.input, expectedRunSha256: "f".repeat(64) },
          f.probes,
        ),
      ).rejects.toThrow("CLOSED_COMPUTER_RECOVERY_STATE_CHANGED");
      await expect(
        recoverClosedComputer(f.input, f.probes),
      ).resolves.toMatchObject({ phase: "retired_unconfirmed" });
    });

    it("refuses a redirected history directory before reading or moving evidence", async () => {
      const f = await fixture();
      await fs.symlink(
        os.tmpdir(),
        path.join(f.state, `closed-recovery-${f.input.operationId}`),
      );
      await expect(recoverClosedComputer(f.input, f.probes)).rejects.toThrow(
        "CLOSED_COMPUTER_RECOVERY_ROOT_UNSAFE",
      );
      expect(f.probes.processesAbsent).not.toHaveBeenCalled();
    });
  },
);
