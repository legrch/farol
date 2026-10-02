import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "@babel/parser";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverClosedComputer } from "../../src/apps/desktop/closed-computer-recovery";
import { PrivateMcpLifecycle } from "../../src/modules/computer/infra/mcp/private-mcp-lifecycle";
import { PrivateExecutionFence } from "../../src/modules/computer/infra/mcp/execution-fence";

const roots: string[] = [];
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
async function desktopRoots(userData: string) {
  const source = await fs.readFile(
    path.resolve(import.meta.dirname, "../../src/apps/desktop/main.ts"),
    "utf8",
  );
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  // Run only these pure path builders from the actual boot source, never main.
  // A separately hard-coded fixture root would miss a production root change.
  const builders = [
    "secureMcpConnectorRoot",
    "secureMcpCredentialRoot",
    "secureMcpLaunchRoot",
  ].map((name) => {
    const node = ast.program.body.find(
      (entry) =>
        entry.type === "FunctionDeclaration" && entry.id?.name === name,
    );
    if (node?.type !== "FunctionDeclaration" || node.params.length !== 0)
      throw new Error(`Desktop root builder unavailable: ${name}`);
    return `function ${name}() ${source.slice(node.body.start!, node.body.end!)}`;
  });
  const lifecycle = ast.program.body.find(
    (entry) =>
      entry.type === "FunctionDeclaration" &&
      entry.id?.name === "computerMcpLifecycle",
  );
  if (lifecycle?.type !== "FunctionDeclaration")
    throw new Error("Desktop lifecycle construction unavailable");
  expect(source.slice(lifecycle.start!, lifecycle.end!)).toMatch(
    /new PrivateMcpLifecycle\(\s*secureMcpLaunchRoot\(\)/u,
  );
  return runInNewContext(
    `${builders.join("\n")}\n({root: secureMcpLaunchRoot(), credentials: secureMcpCredentialRoot()})`,
    {
      path,
      app: {
        getPath(name: string) {
          expect(name).toBe("userData");
          return userData;
        },
      },
    },
    { timeout: 1_000 },
  ) as { root: string; credentials: string };
}
async function fixture() {
  const userData = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-closed-recovery-")),
  );
  roots.push(userData);
  const state = path.join(userData, "farol-next-state");
  await fs.mkdir(state, { mode: 0o700 });
  const { root, credentials } = await desktopRoots(userData);
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
  return {
    input,
    probes,
    root,
    credentials,
    state,
    lifecycle,
    instance,
    run,
    quit,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin")(
  "explicit closed Computer reconciliation (disposable state, no provider)",
  () => {
    it.each(["missing-stop", "missing-lifecycle"])(
      "establishes current stop admission for a closed legacy profile with %s",
      async (kind) => {
        const f = await fixture();
        const directory = path.join(f.root, "mcp-lifecycle");
        await fs.unlink(path.join(directory, f.instance));
        if (kind === "missing-lifecycle")
          await fs.rm(directory, { recursive: true });
        else await fs.unlink(path.join(directory, "stopping"));
        const result = await recoverClosedComputer(f.input, f.probes);
        expect(result.phase).toBe("retired_unconfirmed");
        expect(
          await fs.readFile(path.join(directory, "stopping"), "utf8"),
        ).toBe("1\n");
        expect(
          await fs.readFile(
            path.join(result.archive, "last-quit.json"),
            "utf8",
          ),
        ).toBe(f.quit);
        expect(
          await fs.readFile(path.join(result.archive, "running.json"), "utf8"),
        ).toBe(f.run);
        await expect(
          fs.lstat(path.join(f.state, "running.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it("preserves failed evidence when a legacy MCP lifetime is still leased", async () => {
      const f = await fixture();
      const directory = path.join(f.root, "mcp-lifecycle");
      await fs.unlink(path.join(directory, "stopping"));
      const active = await f.lifecycle.join("a".repeat(64));
      try {
        await expect(recoverClosedComputer(f.input, f.probes)).rejects.toThrow(
          "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
        );
        expect(
          await fs.readFile(path.join(f.state, "running.json"), "utf8"),
        ).toBe(f.run);
        expect(
          await fs.readFile(path.join(f.state, "last-quit.json"), "utf8"),
        ).toBe(f.quit);
        expect(
          await fs.readFile(path.join(directory, f.instance), "utf8"),
        ).toBe("1\n");
      } finally {
        await active.release();
      }
    });

    it("does not create legacy stop admission for unresolved desktop work", async () => {
      const f = await fixture();
      const stopping = path.join(f.root, "mcp-lifecycle", "stopping");
      await fs.unlink(stopping);
      f.input.desktopState.mockResolvedValue({
        obligations: ["TASK_OUTCOME_UNKNOWN:1"],
        unreadable: [],
        changed: [],
      });
      await expect(recoverClosedComputer(f.input, f.probes)).rejects.toThrow(
        "CLOSED_COMPUTER_RECOVERY_WORK_PENDING",
      );
      await expect(fs.lstat(stopping)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        await fs.readFile(path.join(f.state, "last-quit.json"), "utf8"),
      ).toBe(f.quit);
    });

    it("retains a connector-only failed Quit after MCP shutdown removed every instance", async () => {
      const f = await fixture();
      await fs.unlink(path.join(f.root, "mcp-lifecycle", f.instance));
      await f.lifecycle.waitForStop();
      await f.lifecycle.confirmStop();
      await expect(
        recoverClosedComputer(f.input, f.probes),
      ).resolves.toMatchObject({ phase: "retired_unconfirmed" });
      const retained = path.join(
        f.state,
        `closed-recovery-${f.input.operationId}`,
      );
      expect(
        await fs.readFile(path.join(retained, "last-quit.json"), "utf8"),
      ).toBe(f.quit);
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(
              f.root,
              "mcp-lifecycle",
              `retired-${f.input.operationId}`,
              "completed.json",
            ),
            "utf8",
          ),
        ),
      ).toMatchObject({ instances: [], phase: "retired_unconfirmed" });
      expect(f.probes.processesAbsent).toHaveBeenCalled();
      await expect(
        fs.lstat(path.join(f.state, "running.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each([
      { name: "prepared.json", phase: "write", partial: '{"schema":' },
      { name: `revoked-${"a".repeat(64)}`, phase: "write", partial: "" },
      { name: `revoked-${"a".repeat(64)}`, phase: "write", partial: "1" },
      { name: `revoked-${"a".repeat(64)}`, phase: "publish", partial: "1\n" },
    ])(
      "resumes recovery after its owned process is killed at $name/$phase/$partial",
      async ({ name, phase, partial }) => {
        const f = await fixture();
        const archive =
          name === "prepared.json"
            ? path.join(f.state, `closed-recovery-${f.input.operationId}`)
            : path.join(
                f.root,
                "mcp-lifecycle",
                `retired-${f.input.operationId}`,
              );
        const entry = path.join(f.input.userData, "recovery-child.ts");
        const output = path.join(f.input.userData, "recovery-child.cjs");
        await fs.writeFile(
          entry,
          `
        import fs from 'node:fs/promises';
        import path from 'node:path';
        import { recoverClosedComputer } from ${JSON.stringify(path.resolve(import.meta.dirname, "../../src/apps/desktop/closed-computer-recovery.ts"))};
        const input = JSON.parse(process.argv[2]);
        const open = fs.open.bind(fs);
        const rename = fs.rename.bind(fs);
        let suspended = false;
        const suspend = async () => {
          process.stdout.write('interrupted\\n');
          setInterval(() => {}, 1000);
          await new Promise(() => {});
        };
        fs.open = async (...args) => {
          const handle = await open(...args);
          if (${JSON.stringify(phase)} === 'write' && !suspended &&
              path.basename(String(args[0])).includes(${JSON.stringify(name)}) &&
              typeof args[1] === 'number' && (args[1] & 1)) {
            suspended = true;
            handle.writeFile = async () => {
              await handle.write(${JSON.stringify(partial)});
              await handle.sync();
              await suspend();
            };
          }
          return handle;
        };
        fs.rename = async (...args) => {
          if (${JSON.stringify(phase)} === 'publish' && !suspended &&
              path.basename(String(args[0])).startsWith(${JSON.stringify(`.${name}.`)})) {
            suspended = true;
            await suspend();
          }
          return rename(...args);
        };
        recoverClosedComputer({...input, desktopState: async () => ({
          obligations: ['QUIT_UNCONFIRMED:connector', 'QUIT_UNCONFIRMED:crash'],
          unreadable: [], changed: []
        })}, {run: {bootTime: 100000, isAlive: () => false, processStart: () => null},
          processesAbsent: () => undefined}).catch(() => process.exit(2));
      `,
          { mode: 0o600 },
        );
        await build({
          entryPoints: [entry],
          outfile: output,
          bundle: true,
          platform: "node",
          format: "cjs",
          target: "node24",
          logLevel: "silent",
        });
        const child = spawn(
          process.execPath,
          [output, JSON.stringify({ ...f.input, desktopState: undefined })],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        const exited = new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve) =>
          child.once("close", (code, signal) => resolve({ code, signal })),
        );
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("RECOVERY_CHILD_NOT_READY")),
              10000,
            );
            child.stdout.once("data", (bytes) => {
              clearTimeout(timer);
              String(bytes).includes("interrupted")
                ? resolve()
                : reject(new Error("RECOVERY_CHILD_OUTPUT_INVALID"));
            });
            child.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once("exit", () => {
              clearTimeout(timer);
              reject(new Error("RECOVERY_CHILD_EXITED_EARLY"));
            });
          });
          child.kill("SIGKILL");
          expect(await exited).toEqual({ code: null, signal: "SIGKILL" });
          expect(
            await fs.readFile(path.join(f.state, "running.json"), "utf8"),
          ).toBe(f.run);
          expect(
            await fs.readFile(path.join(f.state, "last-quit.json"), "utf8"),
          ).toBe(f.quit);
          const remnants = (await fs.readdir(archive)).filter((entry) =>
            entry.startsWith(`.${name}.`),
          );
          expect(remnants).toHaveLength(1);
          const staged = path.join(archive, remnants[0]!);
          const inode = (await fs.lstat(staged)).ino;
          const authoritative =
            name === "prepared.json"
              ? path.join(archive, name)
              : path.join(f.root, "mcp-lifecycle", name);
          await expect(fs.lstat(authoritative)).rejects.toMatchObject({
            code: "ENOENT",
          });
          // Resuming the exact operation must work even after an abrupt process
          // death, without repairing an authoritative marker by guessing.
          await expect(
            recoverClosedComputer(f.input, f.probes),
          ).resolves.toMatchObject({ phase: "retired_unconfirmed" });
          await recoverClosedComputer(f.input, f.probes);
          expect(await fs.readFile(staged, "utf8")).toBe(partial);
          expect((await fs.lstat(staged)).ino).toBe(inode);
          const revocation = path.join(
            f.root,
            "mcp-lifecycle",
            `revoked-${"a".repeat(64)}`,
          );
          expect(await fs.readFile(revocation, "utf8")).toBe("1\n");
          expect(await fs.lstat(revocation)).toMatchObject({ nlink: 1 });
          await f.lifecycle.prepare("b".repeat(64));
          await expect(f.lifecycle.join("a".repeat(64))).rejects.toThrow(
            "COMPUTER_MCP_LIFECYCLE_REVOKED",
          );
        } finally {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
          await exited;
        }
      },
      20000,
    );

    it.each([
      "prepared.json",
      "running.json",
      "last-quit.json",
      "completed.json",
    ])(
      "resumes a partial retained %s publication with original failure evidence unchanged",
      async (name) => {
        const f = await fixture();
        const archive = path.join(
          f.state,
          `closed-recovery-${f.input.operationId}`,
        );
        const open = fs.open.bind(fs);
        let interrupted = false;
        const fault = vi
          .spyOn(fs, "open")
          .mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (
              !interrupted &&
              path.dirname(String(args[0])) === archive &&
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
        await expect(recoverClosedComputer(f.input, f.probes)).rejects.toThrow(
          "JOURNAL_WRITE_INTERRUPTED",
        );
        fault.mockRestore();
        await expect(fs.lstat(path.join(archive, name))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(
          await fs.readFile(path.join(f.state, "running.json"), "utf8"),
        ).toBe(f.run);
        expect(
          await fs.readFile(path.join(f.state, "last-quit.json"), "utf8"),
        ).toBe(f.quit);
        const remnants = (await fs.readdir(archive)).filter((entry) =>
          entry.startsWith(`.${name}.`),
        );
        expect(remnants).toHaveLength(1);
        const staged = path.join(archive, remnants[0]!);
        const inode = (await fs.lstat(staged)).ino;
        await expect(
          recoverClosedComputer(f.input, f.probes),
        ).resolves.toMatchObject({ phase: "retired_unconfirmed" });
        expect(await fs.readFile(staged, "utf8")).toBe('{"schema":');
        expect((await fs.lstat(staged)).ino).toBe(inode);
        expect(
          await fs.readFile(path.join(archive, "running.json"), "utf8"),
        ).toBe(f.run);
        expect(
          await fs.readFile(path.join(archive, "last-quit.json"), "utf8"),
        ).toBe(f.quit);
      },
    );

    it.each(["public", "hardlink", "symlink", "oversize"])(
      "refuses a %s retained remnant before retiring the failed evidence",
      async (kind) => {
        const f = await fixture();
        const archive = path.join(
          f.state,
          `closed-recovery-${f.input.operationId}`,
        );
        await fs.mkdir(archive, { mode: 0o700 });
        const temporary = path.join(
          archive,
          ".prepared.json.88888888-8888-4888-8888-888888888888.tmp",
        );
        const sentinel = path.join(f.state, "sentinel");
        await fs.writeFile(sentinel, "unchanged", { mode: 0o600 });
        if (kind === "symlink") await fs.symlink(sentinel, temporary);
        else if (kind === "hardlink") await fs.link(sentinel, temporary);
        else
          await fs.writeFile(
            temporary,
            kind === "oversize" ? Buffer.alloc(16385) : "partial",
            { mode: kind === "public" ? 0o644 : 0o600 },
          );
        await expect(
          recoverClosedComputer(f.input, f.probes),
        ).rejects.toThrow();
        expect(
          await fs.readFile(path.join(f.state, "running.json"), "utf8"),
        ).toBe(f.run);
        expect(
          await fs.readFile(path.join(f.state, "last-quit.json"), "utf8"),
        ).toBe(f.quit);
        expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged");
      },
    );

    it("uses the desktop authority root and leaves the separate credential tree untouched", async () => {
      const f = await fixture();
      const sibling = path.join(
        f.credentials,
        "computer-authority",
        "mutations",
      );
      await fs.mkdir(sibling, { mode: 0o700, recursive: true });
      const marker = path.join(sibling, "untouched.json");
      await fs.writeFile(marker, "not an authority journal", { mode: 0o600 });
      expect(f.root.startsWith(`${f.credentials}${path.sep}`)).toBe(false);
      await expect(
        recoverClosedComputer(f.input, f.probes),
      ).resolves.toMatchObject({ phase: "retired_unconfirmed" });
      expect(await fs.readFile(marker, "utf8")).toBe(
        "not an authority journal",
      );
    });

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
