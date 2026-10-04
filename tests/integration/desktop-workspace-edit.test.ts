import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeWorkspaceEdit } from "../../src/apps/desktop/workspace-edit";
import { PrivateWorkspaceMutationStore } from "../../src/modules/computer/infra/repo/private-workspace-mutation-store";
import type { StoredWorkspaceMutation } from "../../src/modules/computer/app/port/workspace-mutation-repository";

// Compatibility reads of explicitly seeded historical v1 records only. The
// retired Settings TS executor is not reconstructed by this fixture. Go raw
// BOM/hash/root guards are owned by filesystem edit/mutation tests and the
// normal runtime tests in boot/settingsmutationnative_test.go.
let root = "";
const pending = {
  operationId: "historical-operation",
  computerGeneration: 4,
  workspaceId: "old-workspace",
};
const prepared: StoredWorkspaceMutation = {
  identity: {
    operationId: pending.operationId,
    ownerId: "owner-desktop",
    sessionId: "desktop-computer-session",
    taskId: "desktop-computer-task",
    taskEpoch: pending.computerGeneration,
    participantId: "desktop-main",
  },
  workspaceId: pending.workspaceId,
  requestDigest: "0".repeat(64),
  phase: "prepared",
  outcome: null,
};
const receipt = {
  kind: "workspace.mutation" as const,
  operation: "edit" as const,
  relativePath: "old.md",
  bytes: 4,
  replacements: 1,
  beforeSha256: "a".repeat(64),
  afterSha256: "b".repeat(64),
};
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-legacy-edit-read-")),
  );
  await fs.chmod(root, 0o700);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function stateBytes() {
  const names = (await fs.readdir(path.join(root, "mutations"))).sort();
  return Promise.all(
    names.map(async (name) => [
      name,
      await fs.readFile(path.join(root, "mutations", name), "utf8"),
    ]),
  );
}
const observe = () =>
  observeWorkspaceEdit({ mutationStateRoot: root }, pending);
describe("C05-08 retained legacy guarded-edit observation", () => {
  it("redelivers the original terminal result repeatedly without writing or executing", async () => {
    const store = new PrivateWorkspaceMutationStore({ root });
    await store.admit(prepared);
    await store.save({ ...prepared, phase: "completed", outcome: { receipt } });
    const bytes = await stateBytes();
    const expected = {
      status: "completed",
      operationId: pending.operationId,
      receipt,
      redelivered: true,
    };
    expect(await observe()).toEqual(expected);
    expect(await observe()).toEqual(expected);
    expect(await stateBytes()).toEqual(bytes);
  });
  it("reports the historical never-admitted identity without creating state", async () => {
    expect(await observe()).toEqual({
      status: "not_admitted",
      operationId: pending.operationId,
    });
    expect(await fs.readdir(root)).toEqual([]);
  });
  it("does not create a missing historical root", async () => {
    const missing = path.join(root, "absent");
    expect(
      await observeWorkspaceEdit({ mutationStateRoot: missing }, pending),
    ).toEqual({ status: "not_admitted", operationId: pending.operationId });
    expect(await fs.readdir(root)).toEqual([]);
  });
  it.each(["prepared", "outcome_unknown", "failed"] as const)(
    "preserves recorded %s without executing or changing bytes",
    async (phase) => {
      const store = new PrivateWorkspaceMutationStore({ root });
      await store.admit(prepared);
      if (phase !== "prepared")
        await store.save({
          ...prepared,
          phase,
          outcome: {
            code:
              phase === "failed"
                ? "WORKSPACE_MUTATION_CONFLICT"
                : "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
            source: "native-workspace",
          },
        });
      const bytes = await stateBytes();
      expect(await observe()).toEqual(
        phase === "failed"
          ? {
              status: "failed",
              operationId: pending.operationId,
              code: "WORKSPACE_MUTATION_CONFLICT",
            }
          : { status: "outcome_unknown", operationId: pending.operationId },
      );
      expect(await stateBytes()).toEqual(bytes);
    },
  );
  it("refuses a foreign workspace and malformed retained data without repair", async () => {
    const store = new PrivateWorkspaceMutationStore({ root });
    await store.admit({ ...prepared, workspaceId: "other" });
    const bytes = await stateBytes();
    expect(await observe()).toEqual({
      status: "unavailable",
      operationId: pending.operationId,
    });
    expect(await stateBytes()).toEqual(bytes);
    const [name] = await fs.readdir(path.join(root, "mutations"));
    await fs.writeFile(path.join(root, "mutations", name!), "invalid", {
      mode: 0o600,
    });
    expect(await observe()).toEqual({
      status: "unavailable",
      operationId: pending.operationId,
    });
    expect(await fs.readFile(path.join(root, "mutations", name!), "utf8")).toBe(
      "invalid",
    );
  });
  it("preserves a lost-publication temporary file instead of sweeping it", async () => {
    const store = new PrivateWorkspaceMutationStore({ root });
    await store.admit(prepared);
    const directory = path.join(root, "mutations");
    const [name] = await fs.readdir(directory);
    await fs.writeFile(
      path.join(directory, `.${name}.tmp-uncertain`),
      "preserve",
      { mode: 0o600 },
    );
    const bytes = await stateBytes();
    expect(await observe()).toEqual({
      status: "unavailable",
      operationId: pending.operationId,
    });
    expect(await stateBytes()).toEqual(bytes);
  });
  it("refuses unsafe directory modes without repairing them", async () => {
    await new PrivateWorkspaceMutationStore({ root }).admit(prepared);
    const directory = path.join(root, "mutations");
    await fs.chmod(directory, 0o755);
    expect(await observe()).toEqual({
      status: "unavailable",
      operationId: pending.operationId,
    });
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o755);
  });
  it.each(["symlink", "hardlink", "fifo", "unsafe-mode"] as const)(
    "refuses a %s record without blocking, following or repairing it",
    async (kind) => {
      await new PrivateWorkspaceMutationStore({ root }).admit(prepared);
      const directory = path.join(root, "mutations");
      const [name] = await fs.readdir(directory);
      const target = path.join(directory, name!);
      const original = path.join(root, "preserved-record");
      if (kind === "unsafe-mode") {
        await fs.chmod(target, 0o644);
      } else {
        await fs.rename(target, original);
        if (kind === "symlink") await fs.symlink(original, target);
        if (kind === "hardlink") await fs.link(original, target);
        if (kind === "fifo")
          await promisify(execFile)("/usr/bin/mkfifo", ["-m", "600", target]);
      }
      const before = await fs.lstat(target);
      const bytes = await fs.readFile(
        kind === "unsafe-mode" ? target : original,
        "utf8",
      );
      expect(await observe()).toEqual({
        status: "unavailable",
        operationId: pending.operationId,
      });
      const after = await fs.lstat(target);
      expect([after.ino, after.mode, after.nlink, after.mtimeMs]).toEqual([
        before.ino,
        before.mode,
        before.nlink,
        before.mtimeMs,
      ]);
      expect(
        await fs.readFile(kind === "unsafe-mode" ? target : original, "utf8"),
      ).toBe(bytes);
    },
  );
});
