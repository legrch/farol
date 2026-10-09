import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { describe, expect, it, vi } from "vitest";
import {
  ProductConfigurationCommandSchema,
  ProductConfigurationResultSchema,
  ProductSettingsSchema,
} from "../../src/pkg/product-settings/contract.ts";
import {
  codexTaskRouteFailureCode,
  codexTaskRouteFailureRecord,
  codexTaskRouteRefusalRecord,
} from "../../src/apps/desktop/codex-task-route-error.ts";

// Execute the production host branch with injected IO ports. No real filesystem,
// App Server, child, task, grant, profile, credential or build is involved. Saving
// a selected turn is not a provider membership or current-authority proof.
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
let branch;
function visit(node) {
  if (
    node.type === "SwitchCase" &&
    node.test?.value === "host.configure-codex-tasks"
  )
    branch = source.slice(node.start, node.end);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) visit(child);
    } else if (value?.type) visit(value);
  }
}
visit(tree);
if (!branch) throw new Error("CODEX_READ_SELECTION_HOST_CODE_MISSING");
const threadId = "0e4b2463-5506-47d5-a1a0-b4b84e941301";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
function harness(
  reference = { observeThreadId: threadId, observeTurnId: "turn-exact_1" },
) {
  const readiness = {
    visited: true,
    skipped: false,
    configured: true,
    reachable: "reachable",
    verified: null,
    needsAction: null,
    unavailable: null,
    outcomeUnknown: false,
  };
  const verifiedAt = "2026-10-04T10:00:00.000Z";
  const settings = ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "home",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: "00000000-0000-4000-8000-000000000001",
      generation: 11,
      name: "Fixture",
      commands: "none",
      workspaces: [
        {
          workspaceId,
          root: "/fixture/writer",
          label: "Writer",
          access: "read",
          excludedPaths: [],
          rootIdentity: { device: "5", inode: "11" },
          gitMetadata: {
            gitDirectory: "/fixture/project/.git/worktrees/writer",
            commonDirectory: "/fixture/project/.git",
          },
        },
      ],
    },
    nativeHosts: {
      generation: 7,
      codex: {
        executablePath: "/fixture/codex",
        executableSha256: "a".repeat(64),
        version: "1.0.0",
        protocol: "codex-app-server/v2",
        schemaSha256: "b".repeat(64),
        verifiedAt,
        localVerification: {
          executableSha256: "a".repeat(64),
          schemaSha256: "b".repeat(64),
          buildId: "c".repeat(64),
          verifiedAt,
        },
      },
    },
    setup: {
      chatgpt: readiness,
      connect: readiness,
      hosts: readiness,
      verify: readiness,
      computer: {
        ...readiness,
        verified: {
          profile: "fixture",
          configRevision: 11,
          workspaceId,
          runtimeGeneration: "fixture",
          buildId: "d".repeat(64),
          protocol: "fixture",
          verifiedAt,
        },
      },
    },
  });
  const snapshot = { status: "ready", settings };
  const command = ProductConfigurationCommandSchema.parse({
    kind: "host.configure-codex-tasks",
    socketPath: "/fixture/codex.sock",
    expectedCodexHome: "/fixture/codex-home",
    workspaceId,
    projectId,
    projectRoot: "/fixture/project",
    sandbox: "read-only",
    approvalPolicy: "on-request",
    ...reference,
  });
  const proxy = {
    request: vi.fn(async () => ({
      thread: { id: threadId, projectId, cwd: "/fixture/writer" },
    })),
    close: vi.fn(),
  };
  const resolve = vi.fn(async () => true);
  const context = {
    command,
    configuration: {
      snapshot: vi.fn(() => snapshot),
      recordCodexTaskRoute: vi.fn(async () => ({ ok: true, snapshot })),
    },
    configurationFailure: vi.fn((error) => ({ ok: false, error, snapshot })),
    codexHostTaskAdmission: false,
    codexAgentOperationActive: vi.fn(() => false),
    resolveOwnerTaskModel: vi.fn(() => ({ status: "ready" })),
    lstat: vi.fn(async () => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      dev: 5n,
      ino: 10n,
    })),
    realpath: vi.fn(async (value) => value),
    mkdtemp: vi.fn(async () => "/fixture/private-scratch"),
    chmod: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    PhysicalCodexHandoffAuthority: class {
      resolve = resolve;
    },
    SharedCodexProxyHost: { attach: vi.fn(async () => proxy) },
    exactProject: vi.fn(async () => true),
    ProductConfigurationResultSchema,
    codexTaskRouteRefusalRecord,
    codexTaskRouteFailureCode,
    codexTaskRouteFailureRecord,
    process: { stderr: { write: vi.fn() } },
    path,
    os,
  };
  const handle = vm.runInNewContext(
    stripTypeScriptTypes(
      `async function handle() { switch(command.kind) { ${branch} } } handle`,
    ),
    context,
  );
  return { context, snapshot, proxy, resolve, handle };
}

describe("host exact Codex read selection", () => {
  it("retains the exact turn through the actual host save without inferring provider history", async () => {
    const h = harness();
    expect(await h.handle()).toMatchObject({ ok: true });
    expect(
      h.context.configuration.recordCodexTaskRoute,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        observeThreadId: threadId,
        observeTurnId: "turn-exact_1",
        computerGeneration: 11,
        hostGeneration: 7,
        projectIdentity: { device: "5", inode: "10" },
        projectRoot: "/fixture/project",
        gitCommonDirectory: "/fixture/project/.git",
      }),
    );
    expect(h.proxy.request).toHaveBeenCalledExactlyOnceWith("thread/read", {
      threadId,
      includeTurns: false,
    });
    expect(h.resolve).toHaveBeenCalledTimes(2);
    expect(h.proxy.close).toHaveBeenCalledOnce();
    expect(h.context.rm).toHaveBeenCalledExactlyOnceWith(
      "/fixture/private-scratch",
      { recursive: true, force: true },
    );
    expect(h.context.codexHostTaskAdmission).toBe(false);
  });

  it.each([{}, { observeThreadId: threadId }])(
    "preserves old optional selection %j without inventing a turn",
    async (reference) => {
      const h = harness(reference);
      expect((await h.handle()).ok).toBe(true);
      const saved =
        h.context.configuration.recordCodexTaskRoute.mock.calls[0][0];
      expect(saved).not.toHaveProperty("observeTurnId");
      if (reference.observeThreadId)
        expect(saved.observeThreadId).toBe(threadId);
      else {
        expect(saved).not.toHaveProperty("observeThreadId");
        expect(h.proxy.request).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["thread", "project", "cwd", "root-recheck"])(
    "does not save a selection after mismatched %s evidence",
    async (loss) => {
      const h = harness();
      const thread = { id: threadId, projectId, cwd: "/fixture/writer" };
      if (loss === "thread") thread.id = "a foreign thread";
      if (loss === "project") thread.projectId = "a foreign project";
      if (loss === "cwd") thread.cwd = "/fixture/foreign-writer";
      if (loss === "root-recheck")
        h.resolve.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      h.proxy.request.mockResolvedValue({ thread });
      expect(await h.handle()).toMatchObject({
        ok: false,
        error: "CODEX_TASK_OBSERVATION_REFUSED",
      });
      expect(
        h.context.configuration.recordCodexTaskRoute,
      ).not.toHaveBeenCalled();
      expect(h.proxy.close).toHaveBeenCalledOnce();
      expect(h.context.codexHostTaskAdmission).toBe(false);
    },
  );

  it("keeps the original admission while attachment is pending and refuses a duplicate command", async () => {
    const h = harness();
    let entered;
    let release;
    const entering = new Promise((resolve) => {
      entered = resolve;
    });
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    h.context.SharedCodexProxyHost.attach.mockImplementation(async () => {
      entered();
      await pending;
      return h.proxy;
    });
    const first = h.handle();
    await entering;
    expect(await h.handle()).toMatchObject({
      ok: false,
      error: "CODEX_HOST_TASK_IN_PROGRESS",
    });
    expect(h.context.codexHostTaskAdmission).toBe(true);
    expect(h.context.SharedCodexProxyHost.attach).toHaveBeenCalledOnce();
    release();
    expect((await first).ok).toBe(true);
    expect(h.context.configuration.recordCodexTaskRoute).toHaveBeenCalledOnce();
    expect(h.proxy.close).toHaveBeenCalledOnce();
    expect(h.context.codexHostTaskAdmission).toBe(false);
  });
});
