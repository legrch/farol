import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyWorkspaceEdit,
  desktopMutableWorkspaceAction,
  observeWorkspaceEdit,
  prepareWorkspaceEdit,
} from "../../src/apps/desktop/workspace-edit";
import type { MutableWorkspace } from "../../src/modules/computer/app/port/mutable-workspace";
import { PrivateWorkspaceMutationStore } from "../../src/modules/computer/infra/repo/private-workspace-mutation-store";
import {
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";
import type {
  ApprovedProductWorkspace,
  ProductSettings,
} from "../../src/pkg/product-settings/contract";

// The desktop Computer page prepares a guarded edit from one real helper read
// and applies it later through the same mutable action composition as
// main.ts.  Nothing in these tests supplies the expected digest: it comes from
// the preparation, exactly as it does in the product.

const nextRoot = path.resolve(import.meta.dirname, "../..");
const sourceHelper = path.join(nextRoot, "resources/native/safe_open.py");
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const NOW = 1_800_000_000_000;
let root = "";
let stateRoot = "";
let rootIdentity: Readonly<{ device: string; inode: string }> = {
  device: "0",
  inode: "0",
};
let displaced = "";

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function visible(value: Buffer): string {
  return JSON.stringify(value.toString("latin1"));
}

function native(): NativeReadonlyWorkspace {
  return new NativeReadonlyWorkspace({
    helperPath: sourceHelper,
    helper: NEXT_SAFE_OPEN_HELPER,
    attestInterpreter: async () => "/usr/bin/python3",
  });
}

function approvedWorkspace(): ApprovedProductWorkspace {
  return {
    workspaceId: "workspace-edit",
    root,
    label: "Edit fixture",
    access: "write",
    excludedPaths: [],
    rootIdentity,
  };
}

function computer(): ProductSettings["computer"] {
  return {
    computerId: "computer-desktop",
    generation: 4,
    name: "This Mac",
    commands: "none",
    workspaces: [approvedWorkspace()],
    pendingEdit: null,
  };
}

async function prepare(workspace: NativeReadonlyWorkspace, file: string) {
  return prepareWorkspaceEdit(workspace, {
    operationId: `operation-${file}`,
    workspace: {
      workspaceId: "workspace-edit",
      root,
      deniedPaths: [],
      approvedRoot: { path: root, ...rootIdentity },
    },
    computerGeneration: computer().generation,
    relativePath: file,
    expiresAt: NOW + 10 * 60_000,
  });
}

async function applyPrepared(
  workspace: NativeReadonlyWorkspace,
  pending: Parameters<typeof applyWorkspaceEdit>[1],
  edit: Readonly<{ oldText: string; newText: string }>,
) {
  const action = desktopMutableWorkspaceAction(
    computer(),
    approvedWorkspace(),
    pending.expiresAt,
    { mutationStateRoot: stateRoot, workspace, now: () => NOW },
  );
  if (!action) throw new Error("desktop action composition refused");
  return applyWorkspaceEdit(action, pending, edit);
}

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-desktop-edit-")),
  );
  await fs.chmod(root, 0o700);
  const measured = await fs.lstat(root, { bigint: true });
  rootIdentity = { device: String(measured.dev), inode: String(measured.ino) };
  stateRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-desktop-state-")),
  );
  await fs.chmod(stateRoot, 0o700);
});

afterEach(async () => {
  for (const directory of [root, stateRoot, displaced]) {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("desktop guarded edit: prepare then apply", () => {
  it("C05-01 binds the raw bytes of the prepared read, BOM included", async () => {
    const before = Buffer.concat([BOM, Buffer.from("title\nbody\n", "utf8")]);
    await fs.writeFile(path.join(root, "bom.md"), before, { mode: 0o600 });

    const prepared = await prepare(native(), "bom.md");

    expect(prepared).toMatchObject({
      ok: true,
      pending: { bytes: before.length, beforeSha256: digest(before) },
    });
  });

  it("C05-01 applies a reviewed edit to a BOM file", async () => {
    const before = Buffer.concat([BOM, Buffer.from("title\nbody\n", "utf8")]);
    const expected = Buffer.concat([BOM, Buffer.from("title\nBODY\n", "utf8")]);
    await fs.writeFile(path.join(root, "bom.md"), before, { mode: 0o600 });
    const workspace = native();

    const prepared = await prepare(workspace, "bom.md");
    if (!prepared.ok) throw new Error(prepared.code);
    const result = await applyPrepared(workspace, prepared.pending, {
      oldText: "body",
      newText: "BODY",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        operationId: "operation-bom.md",
        receipt: {
          operation: "edit",
          replacements: 1,
          beforeSha256: digest(before),
          afterSha256: digest(expected),
        },
      },
    });
    expect(visible(await fs.readFile(path.join(root, "bom.md")))).toBe(
      visible(expected),
    );
  });

  it("applies a reviewed edit to a file without a BOM", async () => {
    const before = Buffer.from("plain\r\ntext\n", "utf8");
    const expected = Buffer.from("plain\r\nTEXT\n", "utf8");
    await fs.writeFile(path.join(root, "plain.md"), before, { mode: 0o600 });
    const workspace = native();

    const prepared = await prepare(workspace, "plain.md");
    if (!prepared.ok) throw new Error(prepared.code);
    expect(prepared.pending.beforeSha256).toBe(digest(before));
    const result = await applyPrepared(workspace, prepared.pending, {
      oldText: "text",
      newText: "TEXT",
    });

    expect(result).toMatchObject({
      ok: true,
      value: { receipt: { afterSha256: digest(expected) } },
    });
    expect(visible(await fs.readFile(path.join(root, "plain.md")))).toBe(
      visible(expected),
    );
  });

  it("refuses to apply over bytes that changed after preparation", async () => {
    const before = Buffer.concat([BOM, Buffer.from("title\nbody\n", "utf8")]);
    const competing = Buffer.concat([
      BOM,
      Buffer.from("title\nbody\nnewer line\n", "utf8"),
    ]);
    await fs.writeFile(path.join(root, "moved.md"), before, { mode: 0o600 });
    const workspace = native();

    const prepared = await prepare(workspace, "moved.md");
    if (!prepared.ok) throw new Error(prepared.code);
    await fs.writeFile(path.join(root, "moved.md"), competing);
    const result = await applyPrepared(workspace, prepared.pending, {
      oldText: "body",
      newText: "BODY",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_CONFLICT", retry: "never" },
    });
    expect(visible(await fs.readFile(path.join(root, "moved.md")))).toBe(
      visible(competing),
    );
  });
});

describe("AUTH-10 a guarded edit never follows a replaced workspace folder", () => {
  it("refuses to apply once another folder has taken the approved path", async () => {
    await fs.writeFile(path.join(root, "target.md"), "body\n", {
      mode: 0o600,
    });
    const workspace = native();
    const prepared = await prepare(workspace, "target.md");
    if (!prepared.ok) throw new Error(prepared.code);

    displaced = `${root}-displaced`;
    await fs.rename(root, displaced);
    await fs.mkdir(root, { mode: 0o700 });
    await fs.writeFile(path.join(root, "target.md"), "body\n", {
      mode: 0o600,
    });
    const result = await applyPrepared(workspace, prepared.pending, {
      oldText: "body",
      newText: "BODY",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_ROOT_CHANGED", retry: "never" },
    });
    await expect(
      fs.readFile(path.join(root, "target.md"), "utf8"),
    ).resolves.toBe("body\n");
    await expect(
      fs.readFile(path.join(displaced, "target.md"), "utf8"),
    ).resolves.toBe("body\n");
  });
});

describe("C05-08 observing a guarded edit after a lost response", () => {
  function counting(workspace: NativeReadonlyWorkspace) {
    const counter = { mutations: 0 };
    const counted: MutableWorkspace = {
      mutate: (request) => {
        counter.mutations += 1;
        return workspace.mutate(request);
      },
    };
    return { counter, counted };
  }

  it("recovers the same operation's result without a second mutation", async () => {
    const before = Buffer.from("title\nbody\n", "utf8");
    const expected = Buffer.from("title\nBODY\n", "utf8");
    await fs.writeFile(path.join(root, "lost.md"), before, { mode: 0o600 });
    const workspace = native();
    const { counter, counted } = counting(workspace);

    const prepared = await prepare(workspace, "lost.md");
    if (!prepared.ok) throw new Error(prepared.code);
    const action = desktopMutableWorkspaceAction(
      computer(),
      approvedWorkspace(),
      prepared.pending.expiresAt,
      { mutationStateRoot: stateRoot, workspace: counted, now: () => NOW },
    );
    if (!action) throw new Error("desktop action composition refused");
    // The response of this apply is lost: nothing reads its result.
    await applyWorkspaceEdit(action, prepared.pending, {
      oldText: "body",
      newText: "BODY",
    });

    // A restarted process observes the recorded operation by its identity.
    await expect(
      observeWorkspaceEdit({ mutationStateRoot: stateRoot }, prepared.pending),
    ).resolves.toEqual({
      status: "completed",
      operationId: prepared.pending.operationId,
      receipt: {
        kind: "workspace.mutation",
        operation: "edit",
        relativePath: "lost.md",
        bytes: expected.length,
        replacements: 1,
        beforeSha256: digest(before),
        afterSha256: digest(expected),
      },
      redelivered: true,
    });
    expect(counter.mutations).toBe(1);
    expect(visible(await fs.readFile(path.join(root, "lost.md")))).toBe(
      visible(expected),
    );

    // A repeated apply of the same prepared edit after the restart replays
    // the recorded result instead of editing again.
    const restarted = desktopMutableWorkspaceAction(
      computer(),
      approvedWorkspace(),
      prepared.pending.expiresAt,
      { mutationStateRoot: stateRoot, workspace: counted, now: () => NOW },
    );
    if (!restarted) throw new Error("desktop action composition refused");
    await expect(
      applyWorkspaceEdit(restarted, prepared.pending, {
        oldText: "body",
        newText: "BODY",
      }),
    ).resolves.toMatchObject({ ok: true, value: { redelivered: true } });
    expect(counter.mutations).toBe(1);
  });

  it("reports an operation that was never admitted as not applied", async () => {
    await fs.writeFile(path.join(root, "never.md"), "never\n", {
      mode: 0o600,
    });
    const prepared = await prepare(native(), "never.md");
    if (!prepared.ok) throw new Error(prepared.code);

    await expect(
      observeWorkspaceEdit({ mutationStateRoot: stateRoot }, prepared.pending),
    ).resolves.toEqual({
      status: "not_admitted",
      operationId: prepared.pending.operationId,
    });
  });

  it("reports an admitted operation whose executor vanished as unknown, never re-executing", async () => {
    await fs.writeFile(path.join(root, "crash.md"), "crash\n", {
      mode: 0o600,
    });
    const prepared = await prepare(native(), "crash.md");
    if (!prepared.ok) throw new Error(prepared.code);
    // Admission was recorded, then the executing process died before the
    // helper answered.
    await new PrivateWorkspaceMutationStore({ root: stateRoot }).admit({
      identity: {
        operationId: prepared.pending.operationId,
        ownerId: "owner-desktop",
        sessionId: "desktop-computer-session",
        taskId: "desktop-computer-task",
        taskEpoch: prepared.pending.computerGeneration,
        participantId: "desktop-main",
      },
      workspaceId: prepared.pending.workspaceId,
      requestDigest: "0".repeat(64),
      phase: "prepared",
      outcome: null,
    });

    await expect(
      observeWorkspaceEdit({ mutationStateRoot: stateRoot }, prepared.pending),
    ).resolves.toEqual({
      status: "outcome_unknown",
      operationId: prepared.pending.operationId,
    });
    expect(await fs.readFile(path.join(root, "crash.md"), "utf8")).toBe(
      "crash\n",
    );
  });
});
