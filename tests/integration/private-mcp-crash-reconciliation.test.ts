import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PrivateMcpLifecycle } from "../../src/modules/computer/infra/mcp/private-mcp-lifecycle";

// Darwin execution exercises the actual filesystem and native lifetime claim.
// Hashes, stale markers and caller proofs are synthetic: they establish no real
// failed-run provenance, promotion/Computer authority, canonical host identity,
// Go acceptance, application shutdown or live-provider evidence.
// Retain EVERY fixture root, including successes and refusals. Do not enroll
// these roots in the legacy lifecycle suite's deletion list or retry a failed
// reconciliation to turn retained, unconfirmed evidence into a passing stop.
const launchDigest = "a".repeat(64);
const failedRunSha256 = "b".repeat(64);
const configSha256 = "c".repeat(64);
const replacementDigest = "d".repeat(64);
const operationId = "22222222-2222-4222-8222-222222222222";
const otherOperationId = "44444444-4444-4444-8444-444444444444";
const firstInstance = "active-11111111-1111-4111-8111-111111111111";
const secondInstance = "active-33333333-3333-4333-8333-333333333333";

type CrashInput = Parameters<
  PrivateMcpLifecycle["reconcileInactiveAfterCrash"]
>[0];

function input(overrides: Partial<CrashInput> = {}): CrashInput {
  return {
    operationId,
    failedRunSha256,
    configSha256,
    proveIdle: async () => undefined,
    ...overrides,
  };
}

function plan(instances: string[]) {
  return {
    schema: 2,
    operationId,
    basis: "failed-run",
    failedRunSha256,
    configSha256,
    instances: [...instances].sort(),
  };
}

async function fixture(label: string) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), `farol-mcp-crash-${label}-`)),
  );
  console.info("Retained MCP crash fixture:", root);
  return {
    root,
    directory: path.join(root, "mcp-lifecycle"),
    lifecycle: new PrivateMcpLifecycle(root),
  };
}

async function stoppedFixture(label: string, instances = [firstInstance]) {
  const result = await fixture(label);
  await result.lifecycle.prepare(launchDigest);
  for (const name of instances)
    await fs.writeFile(path.join(result.directory, name), "1\n", {
      mode: 0o600,
    });
  await result.lifecycle.beginStop();
  return result;
}

async function fileIdentity(file: string) {
  const info = await fs.lstat(file);
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    uid: info.uid,
    nlink: info.nlink,
    symlink: info.isSymbolicLink() ? await fs.readlink(file) : null,
    bytes: await fs.readFile(file, "utf8"),
  };
}

async function absent(file: string) {
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

async function retainedPlan(directory: string, value: unknown) {
  const archive = path.join(directory, `retired-${operationId}`);
  const pending = path.join(directory, `reconciling-${operationId}`);
  const prepared = path.join(archive, "prepared.json");
  await fs.mkdir(archive, { mode: 0o700 });
  await fs.mkdir(pending, { mode: 0o700 });
  await fs.writeFile(prepared, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return { archive, pending, prepared };
}

afterEach(() => {
  // Restore only test instrumentation. All filesystem evidence stays retained.
  vi.restoreAllMocks();
});

describe.skipIf(process.platform !== "darwin")(
  "private Computer MCP crash reconciliation",
  () => {
    it("writes exact schema2 journals and preserves retired marker identity without acknowledging the old stop", async () => {
      const { root, directory, lifecycle } = await stoppedFixture("retired", [
        secondInstance,
        firstInstance,
      ]);
      const before = new Map(
        await Promise.all(
          [firstInstance, secondInstance].map(
            async (name) =>
              [name, await fileIdentity(path.join(directory, name))] as const,
          ),
        ),
      );
      const stopping = path.join(directory, "stopping");
      const prepared = path.join(directory, `prepared-${launchDigest}`);
      const stopBefore = await fileIdentity(stopping);
      const preparedBefore = await fileIdentity(prepared);
      const proveIdle = vi.fn(async () => undefined);
      const confirmStop = vi.spyOn(lifecycle, "confirmStop");
      const beginStop = vi.spyOn(lifecycle, "beginStop");
      const confirmCleanHostStop = vi.spyOn(lifecycle, "confirmCleanHostStop");

      await lifecycle.reconcileInactiveAfterCrash(input({ proveIdle }));

      const archive = path.join(directory, `retired-${operationId}`);
      for (const name of [firstInstance, secondInstance]) {
        expect(await fileIdentity(path.join(archive, name))).toEqual(
          before.get(name),
        );
        await absent(path.join(directory, name));
      }
      const expected = plan([firstInstance, secondInstance]);
      expect(
        JSON.parse(
          await fs.readFile(path.join(archive, "prepared.json"), "utf8"),
        ),
      ).toEqual(expected);
      expect(
        JSON.parse(
          await fs.readFile(path.join(archive, "completed.json"), "utf8"),
        ),
      ).toEqual({ ...expected, phase: "retired_unconfirmed" });
      expect((await fs.stat(archive)).mode & 0o077).toBe(0);
      for (const name of ["prepared.json", "completed.json"])
        expect((await fs.stat(path.join(archive, name))).mode & 0o077).toBe(0);
      expect(await fileIdentity(stopping)).toEqual(stopBefore);
      expect(await fileIdentity(prepared)).toEqual(preparedBefore);
      expect(
        await fs.readFile(
          path.join(directory, `revoked-${launchDigest}`),
          "utf8",
        ),
      ).toBe("1\n");
      expect(proveIdle).toHaveBeenCalledOnce();
      expect(confirmStop).not.toHaveBeenCalled();
      expect(beginStop).not.toHaveBeenCalled();
      expect(confirmCleanHostStop).not.toHaveBeenCalled();
      expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
      expect(await new PrivateMcpLifecycle(root).hasUnconfirmedStop()).toBe(
        true,
      );
      await expect(lifecycle.join(launchDigest)).rejects.toThrow(
        "COMPUTER_MCP_LIFECYCLE_REVOKED",
      );
      // Exact inventories exclude invented Quit, ACK, drained or terminal files;
      // exact journal equality above excludes invented fields as well.
      expect((await fs.readdir(archive)).sort()).toEqual(
        [
          firstInstance,
          secondInstance,
          "prepared.json",
          "completed.json",
        ].sort(),
      );
      expect((await fs.readdir(directory)).sort()).toEqual(
        [
          "lifetime.lock",
          `prepared-${launchDigest}`,
          `revoked-${launchDigest}`,
          `retired-${operationId}`,
          "stopping",
        ].sort(),
      );
      expect(await fs.readdir(root)).toEqual(["mcp-lifecycle"]);
    });

    it("requires an existing stopping marker without manufacturing one", async () => {
      const { directory, lifecycle } = await fixture("missing-stop");
      await lifecycle.prepare(launchDigest);
      const names = await fs.readdir(directory);
      const prepared = path.join(directory, `prepared-${launchDigest}`);
      const before = await fileIdentity(prepared);
      const proveIdle = vi.fn(async () => undefined);

      await expect(
        lifecycle.reconcileInactiveAfterCrash(input({ proveIdle })),
      ).rejects.toThrow("COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED");

      expect(proveIdle).not.toHaveBeenCalled();
      expect(await fs.readdir(directory)).toEqual(names);
      expect(await fileIdentity(prepared)).toEqual(before);
      expect(await lifecycle.isStopping()).toBe(false);
    });

    it("rejects invalid operation, run, config and proof inputs before filesystem IO or artifacts", async () => {
      const invalid: CrashInput[] = [
        input({ operationId: "not-a-uuid" }),
        input({ failedRunSha256: "b".repeat(63) }),
        input({ configSha256: "C".repeat(64) }),
        {
          ...input(),
          // @ts-expect-error Deliberately test a noncallable runtime boundary.
          proveIdle: null,
        },
        {
          ...input(),
          // @ts-expect-error Deliberately test a missing runtime proof.
          proveIdle: undefined,
        },
      ];
      for (const [index, request] of invalid.entries()) {
        const { root, lifecycle } = await fixture(`invalid-${index}`);
        const io = [
          vi.spyOn(fs, "mkdir"),
          vi.spyOn(fs, "open"),
          vi.spyOn(fs, "lstat"),
          vi.spyOn(fs, "readFile"),
          vi.spyOn(fs, "readdir"),
        ];
        try {
          await expect(
            lifecycle.reconcileInactiveAfterCrash(request),
          ).rejects.toThrow("COMPUTER_MCP_RECONCILIATION_INVALID");
          for (const operation of io) expect(operation).not.toHaveBeenCalled();
        } finally {
          vi.restoreAllMocks();
        }
        expect(await fs.readdir(root)).toEqual([]);
      }
    });

    it("refuses an actual live join lease even with a no-op proof and releases only that owned lease", async () => {
      const { directory, lifecycle } = await fixture("live-lease");
      await lifecycle.prepare(launchDigest);
      const live = await lifecycle.join(launchDigest);
      try {
        await lifecycle.beginStop();
        const names = await fs.readdir(directory);
        const instances = names.filter((name) => name.startsWith("active-"));
        expect(instances).toHaveLength(1);
        const marker = path.join(directory, instances[0]!);
        const before = await fileIdentity(marker);
        const proveIdle = vi.fn(async () => undefined);
        const open = vi.spyOn(fs, "open");

        await expect(
          lifecycle.reconcileInactiveAfterCrash(input({ proveIdle })),
        ).rejects.toThrow("COMPUTER_MCP_LIFECYCLE_UNVERIFIED");

        // Zero wait means one native claim attempt, without a polling retry.
        expect(
          open.mock.calls.filter(
            ([file]) => String(file) === path.join(directory, "lifetime.lock"),
          ),
        ).toHaveLength(1);
        open.mockRestore();
        expect(proveIdle).not.toHaveBeenCalled();
        expect(await fs.readdir(directory)).toEqual(names);
        expect(await fileIdentity(marker)).toEqual(before);
        expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
      } finally {
        await live.release();
      }
      // No second reconciliation after lease release: refusal stays refusal.
      expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
    });

    it("holds the real exclusive lifetime claim throughout the caller proof", async () => {
      const { root, lifecycle } = await stoppedFixture("proof-claim");
      const peer = new PrivateMcpLifecycle(root);
      const proveIdle = vi.fn(async () => {
        try {
          const unexpected = await peer.join(launchDigest);
          try {
            throw new Error("SYNTHETIC_JOIN_UNEXPECTEDLY_ADMITTED");
          } finally {
            await unexpected.release();
          }
        } catch (error) {
          // A free lock would reach the stopping marker and report REVOKED.
          // UNVERIFIED proves the native shared claim could not be acquired.
          expect(error).toMatchObject({
            message: "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
          });
        }
      });

      await lifecycle.reconcileInactiveAfterCrash(input({ proveIdle }));

      expect(proveIdle).toHaveBeenCalledOnce();
      expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
    });

    it("retains a shell-group obligation despite a no-op caller proof", async () => {
      const { root, directory, lifecycle } = await stoppedFixture("shell");
      const shellRoot = path.join(root, "execution-fence");
      await fs.mkdir(shellRoot, { mode: 0o700 });
      const shell = path.join(shellRoot, `shell-${replacementDigest}.json`);
      await fs.writeFile(shell, "{}\n", { mode: 0o600 });
      const shellBefore = await fileIdentity(shell);
      const marker = path.join(directory, firstInstance);
      const before = await fileIdentity(marker);
      const names = await fs.readdir(directory);
      const proveIdle = vi.fn(async () => undefined);

      await expect(
        lifecycle.reconcileInactiveAfterCrash(input({ proveIdle })),
      ).rejects.toThrow("COMPUTER_MCP_SHELL_CLEANUP_UNVERIFIED");

      expect(proveIdle).not.toHaveBeenCalled();
      expect(await fileIdentity(shell)).toEqual(shellBefore);
      expect(await fileIdentity(marker)).toEqual(before);
      expect(await fs.readdir(directory)).toEqual(names);
      expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
    });

    it("refuses malformed, corrupt, linked and permissive active markers before caller proof", async () => {
      for (const kind of ["name", "bytes", "symlink", "hardlink", "mode"]) {
        const { root, directory, lifecycle } = await stoppedFixture(
          `unsafe-${kind}`,
          [],
        );
        const marker = path.join(
          directory,
          kind === "name" ? "active-not-a-uuid" : firstInstance,
        );
        const sentinel = path.join(root, "sentinel");
        await fs.writeFile(sentinel, "1\n", { mode: 0o600 });
        if (kind === "symlink") await fs.symlink(sentinel, marker);
        else if (kind === "hardlink") await fs.link(sentinel, marker);
        else {
          await fs.writeFile(marker, kind === "bytes" ? "partial" : "1\n", {
            mode: 0o600,
          });
          if (kind === "mode") await fs.chmod(marker, 0o644);
        }
        const before = await fileIdentity(marker);
        const sentinelBefore = await fileIdentity(sentinel);
        const names = await fs.readdir(directory);
        const proveIdle = vi.fn(async () => undefined);

        await expect(
          lifecycle.reconcileInactiveAfterCrash(input({ proveIdle })),
        ).rejects.toThrow("COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE");

        expect(proveIdle).not.toHaveBeenCalled();
        expect(await fileIdentity(marker)).toEqual(before);
        expect(await fileIdentity(sentinel)).toEqual(sentinelBefore);
        expect(await fs.readdir(directory)).toEqual(names);
      }
    });

    it("retains the original markers and admission fence when caller proof refuses", async () => {
      const { directory, lifecycle } = await stoppedFixture("proof-refused");
      const names = await fs.readdir(directory);
      const marker = path.join(directory, firstInstance);
      const stopping = path.join(directory, "stopping");
      const before = await fileIdentity(marker);
      const stopBefore = await fileIdentity(stopping);
      const refusal = new Error("SYNTHETIC_WORK_PENDING");
      const proveIdle = vi.fn(async () => {
        throw refusal;
      });

      await expect(
        lifecycle.reconcileInactiveAfterCrash(input({ proveIdle })),
      ).rejects.toBe(refusal);

      expect(proveIdle).toHaveBeenCalledOnce();
      expect(await fs.readdir(directory)).toEqual(names);
      expect(await fileIdentity(marker)).toEqual(before);
      expect(await fileIdentity(stopping)).toEqual(stopBefore);
      expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
    });

    it("refuses both schema crossings even when failed-run and failed-Quit digests match", async () => {
      for (const schema of [1, 2]) {
        const { directory, lifecycle } = await stoppedFixture(
          `schema-${schema}`,
        );
        const stored =
          schema === 1
            ? {
                schema: 1,
                operationId,
                failedQuitSha256: failedRunSha256,
                instances: [firstInstance],
              }
            : plan([firstInstance]);
        const { archive, pending, prepared } = await retainedPlan(
          directory,
          stored,
        );
        const before = await fileIdentity(path.join(directory, firstInstance));
        const planBefore = await fileIdentity(prepared);
        const pendingBefore = await fs.lstat(pending);
        const names = await fs.readdir(directory);

        await expect(
          schema === 1
            ? lifecycle.reconcileInactiveAfterCrash(input())
            : lifecycle.reconcileInactive({
                operationId,
                failedQuitSha256: failedRunSha256,
                proveIdle: async () => undefined,
              }),
        ).rejects.toThrow();

        expect(await fileIdentity(path.join(directory, firstInstance))).toEqual(
          before,
        );
        expect(await fileIdentity(prepared)).toEqual(planBefore);
        expect((await fs.lstat(pending)).dev).toBe(pendingBefore.dev);
        expect((await fs.lstat(pending)).ino).toBe(pendingBefore.ino);
        expect(await fs.readdir(directory)).toEqual(names);
        expect(await fs.readdir(archive)).toEqual(["prepared.json"]);
        expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
      }
    });

    it("refuses changed run, config, operation and basis identities without later marker moves", async () => {
      for (const changed of ["run", "config", "operation", "basis"]) {
        const { directory, lifecycle } = await stoppedFixture(
          `changed-${changed}`,
        );
        const stored = {
          ...plan([firstInstance]),
          ...(changed === "operation" ? { operationId: otherOperationId } : {}),
          ...(changed === "basis" ? { basis: "failed-quit" } : {}),
        };
        const { archive, pending, prepared } = await retainedPlan(
          directory,
          stored,
        );
        const request = input({
          ...(changed === "run" ? { failedRunSha256: replacementDigest } : {}),
          ...(changed === "config" ? { configSha256: replacementDigest } : {}),
        });
        const marker = path.join(directory, firstInstance);
        const before = await fileIdentity(marker);
        const planBefore = await fileIdentity(prepared);
        const pendingBefore = await fs.lstat(pending);
        const names = await fs.readdir(directory);

        await expect(
          lifecycle.reconcileInactiveAfterCrash(request),
        ).rejects.toThrow();

        expect(await fileIdentity(marker)).toEqual(before);
        expect(await fileIdentity(prepared)).toEqual(planBefore);
        expect((await fs.lstat(pending)).dev).toBe(pendingBefore.dev);
        expect((await fs.lstat(pending)).ino).toBe(pendingBefore.ino);
        expect(await fs.readdir(directory)).toEqual(names);
        expect(await fs.readdir(archive)).toEqual(["prepared.json"]);
        expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
      }
    });

    it("retains a deterministic partial rename and fences preparation, stop confirmation and another operation", async () => {
      const { directory, lifecycle } = await stoppedFixture("partial-rename", [
        secondInstance,
        firstInstance,
      ]);
      const firstBefore = await fileIdentity(
        path.join(directory, firstInstance),
      );
      const secondBefore = await fileIdentity(
        path.join(directory, secondInstance),
      );
      const stopping = path.join(directory, "stopping");
      const stopBefore = await fileIdentity(stopping);
      const archive = path.join(directory, `retired-${operationId}`);
      const pending = path.join(directory, `reconciling-${operationId}`);
      const rename = fs.rename.bind(fs);
      let interrupted = false;
      const fault = vi
        .spyOn(fs, "rename")
        .mockImplementation(async (...args) => {
          if (
            String(args[0]) === path.join(directory, secondInstance) &&
            String(args[1]) === path.join(archive, secondInstance)
          ) {
            interrupted = true;
            throw new Error("SYNTHETIC_INSTANCE_RENAME_INTERRUPTED");
          }
          return rename(...args);
        });
      try {
        await expect(
          lifecycle.reconcileInactiveAfterCrash(input()),
        ).rejects.toThrow("SYNTHETIC_INSTANCE_RENAME_INTERRUPTED");
      } finally {
        fault.mockRestore();
      }
      expect(interrupted).toBe(true);
      expect(await fileIdentity(path.join(archive, firstInstance))).toEqual(
        firstBefore,
      );
      await absent(path.join(directory, firstInstance));
      expect(await fileIdentity(path.join(directory, secondInstance))).toEqual(
        secondBefore,
      );
      await absent(path.join(archive, secondInstance));
      await absent(path.join(archive, "completed.json"));
      const prepared = path.join(archive, "prepared.json");
      const planBefore = await fileIdentity(prepared);
      expect(JSON.parse(planBefore.bytes)).toEqual(
        plan([firstInstance, secondInstance]),
      );
      const pendingBefore = await fs.lstat(pending);
      expect(pendingBefore.isDirectory()).toBe(true);
      expect(await fs.readdir(pending)).toEqual([]);
      expect(
        await fs.readFile(
          path.join(directory, `revoked-${launchDigest}`),
          "utf8",
        ),
      ).toBe("1\n");

      // Inspect the retained fence; never resume the interrupted operation.
      await expect(lifecycle.prepare(replacementDigest)).rejects.toThrow(
        "COMPUTER_MCP_RECONCILIATION_PENDING",
      );
      await expect(lifecycle.confirmStop(0)).rejects.toThrow(
        "COMPUTER_MCP_RECONCILIATION_PENDING",
      );
      const proveIdle = vi.fn(async () => undefined);
      await expect(
        lifecycle.reconcileInactiveAfterCrash(
          input({ operationId: otherOperationId, proveIdle }),
        ),
      ).rejects.toThrow("COMPUTER_MCP_RECONCILIATION_PENDING");
      expect(proveIdle).not.toHaveBeenCalled();
      expect(await fileIdentity(prepared)).toEqual(planBefore);
      expect((await fs.lstat(pending)).dev).toBe(pendingBefore.dev);
      expect((await fs.lstat(pending)).ino).toBe(pendingBefore.ino);
      expect(await fileIdentity(stopping)).toEqual(stopBefore);
      expect(await fileIdentity(path.join(archive, firstInstance))).toEqual(
        firstBefore,
      );
      expect(await fileIdentity(path.join(directory, secondInstance))).toEqual(
        secondBefore,
      );
      expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
    });

    it("refuses over-limit instances and unsafe or partial retained metadata without retiring markers", async () => {
      for (const kind of [
        "instance-count",
        "journal-size",
        "journal-mode",
        "journal-links",
        "journal-partial",
        "pending-partial",
        "pending-nonempty",
      ]) {
        const instances =
          kind === "instance-count"
            ? Array.from(
                { length: 65 },
                (_, index) =>
                  `active-${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
              )
            : [firstInstance];
        const { root, directory, lifecycle } = await stoppedFixture(
          `bounds-${kind}`,
          instances,
        );
        const archive = path.join(directory, `retired-${operationId}`);
        const pending = path.join(directory, `reconciling-${operationId}`);
        let metadata: string | undefined;
        if (kind.startsWith("journal-")) {
          await fs.mkdir(archive, { mode: 0o700 });
          await fs.mkdir(pending, { mode: 0o700 });
          metadata = path.join(archive, "prepared.json");
          const bytes =
            kind === "journal-size"
              ? "x".repeat(8193)
              : kind === "journal-partial"
                ? '{"schema":'
                : `${JSON.stringify(plan(instances))}\n`;
          if (kind === "journal-links") {
            const sentinel = path.join(root, "journal-sentinel");
            await fs.writeFile(sentinel, bytes, { mode: 0o600 });
            await fs.link(sentinel, metadata);
          } else {
            await fs.writeFile(metadata, bytes, { mode: 0o600 });
            if (kind === "journal-mode") await fs.chmod(metadata, 0o644);
          }
        } else if (kind === "pending-partial") {
          metadata = pending;
          await fs.writeFile(pending, "1", { mode: 0o600 });
        } else if (kind === "pending-nonempty") {
          await fs.mkdir(pending, { mode: 0o700 });
          metadata = path.join(pending, "foreign");
          await fs.writeFile(metadata, "retain\n", { mode: 0o600 });
        }
        const before = await Promise.all(
          instances.map((name) => fileIdentity(path.join(directory, name))),
        );
        const metadataBefore = metadata ? await fileIdentity(metadata) : null;

        await expect(
          lifecycle.reconcileInactiveAfterCrash(input()),
        ).rejects.toThrow();

        expect(
          await Promise.all(
            instances.map((name) => fileIdentity(path.join(directory, name))),
          ),
        ).toEqual(before);
        if (metadata)
          expect(await fileIdentity(metadata)).toEqual(metadataBefore);
        await absent(path.join(archive, "completed.json"));
        await absent(path.join(directory, `revoked-${launchDigest}`));
        expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
      }
    });
    it.each(
      ([1, 2] as const).flatMap((schema) =>
        (["conflict", "partial", "mode", "size"] as const).map((kind) => ({
          schema,
          kind,
        })),
      ),
    )(
      "refuses schema$schema $kind completion before creating a pending fence or changing markers",
      async ({ schema, kind }) => {
        const { directory, lifecycle } = await stoppedFixture(
          `completed-${schema}-${kind}`,
        );
        const selected =
          schema === 1
            ? {
                schema,
                operationId,
                failedQuitSha256: failedRunSha256,
                instances: [firstInstance],
              }
            : plan([firstInstance]);
        const archive = path.join(directory, `retired-${operationId}`);
        await fs.mkdir(archive, { mode: 0o700 });
        const prepared = path.join(archive, "prepared.json");
        const completed = path.join(archive, "completed.json");
        await fs.writeFile(prepared, `${JSON.stringify(selected)}\n`, {
          mode: 0o600,
        });
        const value = {
          ...selected,
          ...(schema === 1
            ? { failedQuitSha256: replacementDigest }
            : { configSha256: replacementDigest }),
          phase: "retired_unconfirmed",
        };
        await fs.writeFile(
          completed,
          kind === "partial"
            ? '{"schema":'
            : kind === "size"
              ? "x".repeat(8193)
              : `${JSON.stringify(value)}\n`,
          { mode: 0o600 },
        );
        if (kind === "mode") await fs.chmod(completed, 0o644);
        const pinned = [
          path.join(directory, firstInstance),
          path.join(directory, "stopping"),
          path.join(directory, `prepared-${launchDigest}`),
          prepared,
          completed,
        ];
        const before = await Promise.all(pinned.map(fileIdentity));
        const perform = () =>
          schema === 1
            ? lifecycle.reconcileInactive({
                operationId,
                failedQuitSha256: failedRunSha256,
                proveIdle: async () => undefined,
              })
            : lifecycle.reconcileInactiveAfterCrash(input());

        await expect(perform()).rejects.toThrow(
          kind === "mode" || kind === "size"
            ? "COMPUTER_MCP_RECONCILIATION_UNSAFE"
            : "COMPUTER_MCP_RECONCILIATION_CHANGED",
        );

        expect(await Promise.all(pinned.map(fileIdentity))).toEqual(before);
        expect((await fs.readdir(archive)).sort()).toEqual([
          "completed.json",
          "prepared.json",
        ]);
        await absent(path.join(directory, `reconciling-${operationId}`));
        await absent(path.join(directory, `revoked-${launchDigest}`));
        expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
      },
    );

    it.each([1, 2] as const)(
      "keeps the schema%s pending fence if completion changes after preflight",
      async (schema) => {
        const { directory, lifecycle } = await stoppedFixture(
          `completed-late-${schema}`,
        );
        const archive = path.join(directory, `retired-${operationId}`);
        const active = path.join(directory, firstInstance);
        const target = path.join(archive, firstInstance);
        const completed = path.join(archive, "completed.json");
        const before = await fileIdentity(active);
        const conflict = `${JSON.stringify({ changed: "synthetic late completion fault" })}\n`;
        const rename = fs.rename.bind(fs);
        // Controlled fault after the original marker relocation, not a second
        // protocol owner or a retry of any retained partial fixture.
        vi.spyOn(fs, "rename").mockImplementation(
          async (source, destination) => {
            await rename(source, destination);
            if (source === active && destination === target)
              await fs.writeFile(completed, conflict, {
                mode: 0o600,
                flag: "wx",
              });
          },
        );
        const perform = () =>
          schema === 1
            ? lifecycle.reconcileInactive({
                operationId,
                failedQuitSha256: failedRunSha256,
                proveIdle: async () => undefined,
              })
            : lifecycle.reconcileInactiveAfterCrash(input());

        await expect(perform()).rejects.toThrow(
          "COMPUTER_MCP_RECONCILIATION_CHANGED",
        );

        await absent(active);
        expect(await fileIdentity(target)).toEqual(before);
        expect(await fs.readFile(completed, "utf8")).toBe(conflict);
        expect(
          (
            await fs.lstat(path.join(directory, `reconciling-${operationId}`))
          ).isDirectory(),
        ).toBe(true);
        expect(
          await fs.readFile(
            path.join(directory, `revoked-${launchDigest}`),
            "utf8",
          ),
        ).toBe("1\n");
        expect(await lifecycle.hasUnconfirmedStop()).toBe(true);
      },
    );
  },
);
