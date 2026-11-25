import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsDeliveryResult } from "../bridge/wire";
import {
  ProductConfigurationResultSchema,
  ProductSettingsSchema,
  type ApprovedProductWorkspace,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import { GoSettingsListWorkspace } from "../../../src/apps/desktop/go-settings-workspace";
import { createWorkspaceCommands, type WorkspaceCommandPorts } from "./files";

// The owner-workspace commands over real temporary directories and a fixture
// standing in for main-process state. Every owner is read through a getter the
// test can change after the factory is built, so a test proves a value is taken
// at the call, not at construction. The Go core and the dialog are fakes; the
// folders the picked file is measured against are real.

const workspaceId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000003";
const roots: string[] = [];

async function scratch(): Promise<string> {
  // Resolved: the system temp path may itself be reached through a link.
  const made = await realpath(await mkdtemp(path.join(os.tmpdir(), "files-")));
  roots.push(made);
  return made;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

function readiness() {
  return {
    visited: false,
    skipped: false,
    configured: false,
    reachable: "unknown" as const,
    verified: null,
    needsAction: "Complete this step.",
    unavailable: null,
    outcomeUnknown: false,
  };
}

function settingsOf(options: {
  root: string;
  generation: number;
  verifiedRevision: number | null;
  identity: boolean;
}): ProductSettings {
  const parsed = ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: "00000000-0000-4000-8000-000000000010",
      generation: options.generation,
      name: "This Mac",
      workspaces: [
        {
          workspaceId,
          root: options.root,
          label: "Primary",
          access: "read",
          excludedPaths: [],
          ...(options.identity
            ? { rootIdentity: { device: "1", inode: "2" } }
            : {}),
        },
      ],
    },
    nativeHosts: { generation: 1, codex: null },
    setup: {
      journey: { currentStep: "verify", dismissed: false },
      chatgpt: readiness(),
      computer: readiness(),
      connect: readiness(),
      hosts: readiness(),
      verify: readiness(),
    },
  });
  if (options.verifiedRevision !== null)
    (
      parsed as { setup: { computer: { verified: unknown } } }
    ).setup.computer.verified = {
      profile: "computer.local.read/1",
      configRevision: options.verifiedRevision,
      workspaceId,
      runtimeGeneration: "runtime:build",
      buildId: "0".repeat(64),
      protocol: "readonly-workspace/1",
      verifiedAt: "2026-01-01T00:00:00.000Z",
    };
  return parsed;
}

type Failure = { ok: false; error: string };

type Fixture = {
  settings: ProductSettings | null;
  core: {
    inspectSettingsWorkspace: ReturnType<typeof vi.fn>;
    listSettingsWorkspace: ReturnType<typeof vi.fn>;
  } | null;
  compiledGoCore: unknown;
  window: object | null;
  dialog: { canceled: boolean; filePaths: string[] };
  env: Record<string, string | undefined>;
};

function build(initial: Partial<Fixture> = {}) {
  const state: Fixture = {
    settings: null,
    core: null,
    compiledGoCore: null,
    window: {},
    dialog: { canceled: false, filePaths: [] },
    env: {},
    ...initial,
  };
  const nativeWorkspace = { execute: vi.fn() };
  const failure = vi.fn((error: string): Failure => ({ ok: false, error }));
  const showOpenDialog = vi.fn(async () => state.dialog);
  const ports = {
    configuration: () =>
      state.settings === null
        ? null
        : {
            snapshot: () => ({
              status: "ready" as const,
              settings: state.settings!,
            }),
          },
    configurationFailure: failure,
    desktopGoCore: () => state.core,
    compiledGoCore: () => state.compiledGoCore,
    nativeWorkspace,
    window: () => state.window,
    showOpenDialog,
    env: state.env,
  } as unknown as WorkspaceCommandPorts;
  return {
    state,
    nativeWorkspace,
    failure,
    showOpenDialog,
    commands: createWorkspaceCommands(ports),
  };
}

function approved(root: string): ApprovedProductWorkspace {
  return settingsOf({
    root,
    generation: 1,
    verifiedRevision: null,
    identity: false,
  }).computer.workspaces[0]!;
}

const labels = { title: "Choose a file", buttonLabel: "Choose" } as const;

describe("failure mappers", () => {
  const read = [
    "WORKSPACE_PATH_REFUSED",
    "WORKSPACE_ROOT_CHANGED",
    "WORKSPACE_NOT_FOUND",
    "WORKSPACE_NOT_A_FILE",
    "WORKSPACE_FILE_TOO_LARGE",
    "WORKSPACE_NOT_TEXT",
    "WORKSPACE_SEARCH_TIMEOUT",
  ];
  it.each(read)("a read keeps %s", (code) => {
    const { commands } = build();
    expect(commands.workspaceReadFailure(code)).toEqual({
      ok: false,
      error: code,
    });
  });
  it.each(["", "WORKSPACE_MUTATION_CONFLICT", "anything"])(
    "a read folds %j into WORKSPACE_READ_FAILED",
    (code) => {
      const { commands } = build();
      expect(commands.workspaceReadFailure(code)).toEqual({
        ok: false,
        error: "WORKSPACE_READ_FAILED",
      });
    },
  );

  const command: [string, string][] = [
    ["AUTHORITY_CAPABILITY_DENIED", "WORKSPACE_COMMAND_APPROVAL_REQUIRED"],
    ["AUTHORITY_COMMAND_DENIED", "WORKSPACE_COMMAND_APPROVAL_REQUIRED"],
    ["AUTHORITY_PATH_DENIED", "WORKSPACE_COMMAND_APPROVAL_REQUIRED"],
    ["WORKSPACE_COMMAND_UNSUPPORTED", "WORKSPACE_COMMAND_UNAVAILABLE"],
    ["WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE", "WORKSPACE_COMMAND_UNAVAILABLE"],
    ["WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED", "WORKSPACE_COMMAND_UNAVAILABLE"],
    ["WORKSPACE_COMMAND_CANCELLED", "WORKSPACE_COMMAND_CANCELLED"],
    ["WORKSPACE_COMMAND_TIMEOUT", "WORKSPACE_COMMAND_TIMEOUT"],
    [
      "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE",
      "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE",
    ],
    ["WORKSPACE_NOT_GIT_REPOSITORY", "WORKSPACE_NOT_GIT_REPOSITORY"],
    ["WORKSPACE_GIT_HEAD_UNBORN", "WORKSPACE_GIT_HEAD_UNBORN"],
    ["WORKSPACE_ROOT_CHANGED", "WORKSPACE_ROOT_CHANGED"],
    [
      "WORKSPACE_GIT_METADATA_NOT_APPROVED",
      "WORKSPACE_GIT_METADATA_NOT_APPROVED",
    ],
    ...[
      "WORKSPACE_GIT_ALTERNATES_UNSUPPORTED",
      "WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT",
      "WORKSPACE_CHANGED_DURING_SNAPSHOT",
      "WORKSPACE_TRACKED_LIST_TOO_LARGE",
      "WORKSPACE_TRACKED_PATH_UNSUPPORTED",
      "WORKSPACE_SNAPSHOT_TOO_LARGE",
      "WORKSPACE_SNAPSHOT_CROSS_VOLUME",
      "WORKSPACE_SNAPSHOT_CLONE_UNSUPPORTED",
      "WORKSPACE_PATH_REFUSED",
      "WORKSPACE_NOT_FOUND",
    ].map((code): [string, string] => [code, code]),
    ["", "WORKSPACE_COMMAND_FAILED"],
    ["SOMETHING_ELSE", "WORKSPACE_COMMAND_FAILED"],
  ];
  it.each(command)("a command maps %j to %s", (code, expected) => {
    const { commands } = build();
    expect(commands.workspaceCommandFailure(code)).toEqual({
      ok: false,
      error: expected,
    });
  });

  const mutation: [string, string][] = [
    ...[
      "WORKSPACE_PATH_REFUSED",
      "WORKSPACE_ROOT_CHANGED",
      "WORKSPACE_NOT_FOUND",
      "WORKSPACE_NOT_A_FILE",
      "WORKSPACE_FILE_TOO_LARGE",
      "WORKSPACE_NOT_TEXT",
      "WORKSPACE_MUTATION_CONFLICT",
      "WORKSPACE_EDIT_NO_MATCH",
      "WORKSPACE_EDIT_NOT_UNIQUE",
      "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
    ].map((code): [string, string] => [code, code]),
    ["COMPUTER_MUTATION_OPERATION_CONFLICT", "WORKSPACE_MUTATION_CONFLICT"],
    ["AUTHORITY_CAPABILITY_DENIED", "WORKSPACE_WRITE_APPROVAL_REQUIRED"],
    [
      "AUTHORITY_MUTATION_OWNERSHIP_DENIED",
      "WORKSPACE_WRITE_APPROVAL_REQUIRED",
    ],
    ["AUTHORITY_PATH_DENIED", "WORKSPACE_WRITE_APPROVAL_REQUIRED"],
    ["", "WORKSPACE_MUTATION_FAILED"],
    ["WORKSPACE_COMMAND_TIMEOUT", "WORKSPACE_MUTATION_FAILED"],
  ];
  it.each(mutation)("a mutation maps %j to %s", (code, expected) => {
    const { commands } = build();
    expect(commands.workspaceMutationFailure(code)).toEqual({
      ok: false,
      error: expected,
    });
  });

  // The stub above only records the code. In main, configurationFailure parses
  // it through the real result schema, which throws on a code outside its
  // closed enum, so every code a mapper can emit must be one it accepts.
  it("emits only codes the real configuration result accepts", () => {
    const failure = ProductConfigurationResultSchema.options.find(
      (option) => option.shape.ok.value === false,
    );
    if (!failure || !("error" in failure.shape)) {
      throw new Error("The configuration result has no failure variant");
    }
    const accepted = new Set<string>(failure.shape.error.options);
    const { commands } = build();
    const emitted = [
      ...read.map((code) => commands.workspaceReadFailure(code)),
      ...["", "WORKSPACE_MUTATION_CONFLICT", "anything"].map((code) =>
        commands.workspaceReadFailure(code),
      ),
      ...command.map(([code]) => commands.workspaceCommandFailure(code)),
      ...mutation.map(([code]) => commands.workspaceMutationFailure(code)),
    ];
    for (const result of emitted) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(accepted).toContain(result.error);
    }
  });
});

describe("selected file", () => {
  it("is invalid with no window and no test file", async () => {
    const root = await scratch();
    const { commands, showOpenDialog } = build({ window: null });
    await expect(
      commands.selectedWorkspaceFile(approved(root), labels),
    ).resolves.toBe("invalid");
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it("is cancelled when the owner cancels or picks other than one file", async () => {
    const root = await scratch();
    for (const dialog of [
      { canceled: true, filePaths: [] },
      { canceled: false, filePaths: [] },
      {
        canceled: false,
        filePaths: [path.join(root, "a"), path.join(root, "b")],
      },
    ]) {
      const { commands } = build({ dialog });
      await expect(
        commands.selectedWorkspaceFile(approved(root), labels),
      ).resolves.toBe("cancelled");
    }
  });

  it("asks from the workspace root with the given labels", async () => {
    const root = await scratch();
    const file = path.join(root, "dir", "a.txt");
    const { commands, showOpenDialog, state } = build({
      dialog: { canceled: false, filePaths: [file] },
    });
    await expect(
      commands.selectedWorkspaceFile(approved(root), labels),
    ).resolves.toBe("dir/a.txt");
    expect(showOpenDialog).toHaveBeenCalledWith(state.window, {
      title: "Choose a file",
      buttonLabel: "Choose",
      defaultPath: root,
      properties: ["openFile"],
      securityScopedBookmarks: false,
    });
  });

  it("refuses the root itself, a path outside it and a relative pick", async () => {
    const root = await scratch();
    const outside = await scratch();
    await writeFile(path.join(outside, "a.txt"), "x");
    for (const picked of [
      root,
      path.dirname(root),
      path.join(outside, "a.txt"),
      path.join(root, "..", "sibling.txt"),
      "relative.txt",
      "",
    ]) {
      const { commands } = build({
        dialog: { canceled: false, filePaths: [picked] },
      });
      await expect(
        commands.selectedWorkspaceFile(approved(root), labels),
      ).resolves.toBe("invalid");
    }
  });

  it("reports a link by its own path inside the root, never by its target", async () => {
    const root = await scratch();
    const outside = await scratch();
    await writeFile(path.join(outside, "target.txt"), "x");
    await mkdir(path.join(root, "dir"));
    await symlink(
      path.join(outside, "target.txt"),
      path.join(root, "dir", "link.txt"),
    );
    const { commands } = build({
      dialog: {
        canceled: false,
        filePaths: [path.join(root, "dir", "link.txt")],
      },
    });
    await expect(
      commands.selectedWorkspaceFile(approved(root), labels),
    ).resolves.toBe("dir/link.txt");
  });

  it("takes the test file only under FAROL_E2E and skips the dialog", async () => {
    const root = await scratch();
    const file = path.join(root, "e2e.txt");
    const on = build({
      window: null,
      env: { FAROL_E2E: "1", FAROL_E2E_WORKSPACE_FILE: file },
    });
    await expect(
      on.commands.selectedWorkspaceFile(approved(root), labels),
    ).resolves.toBe("e2e.txt");
    expect(on.showOpenDialog).not.toHaveBeenCalled();

    const off = build({
      window: null,
      env: { FAROL_E2E_WORKSPACE_FILE: file },
    });
    await expect(
      off.commands.selectedWorkspaceFile(approved(root), labels),
    ).resolves.toBe("invalid");
  });

  it("reads the environment and the window at the call", async () => {
    const root = await scratch();
    const file = path.join(root, "late.txt");
    const fixture = build({ window: null });
    fixture.state.env.FAROL_E2E = "1";
    fixture.state.env.FAROL_E2E_WORKSPACE_FILE = file;
    await expect(
      fixture.commands.selectedWorkspaceFile(approved(root), labels),
    ).resolves.toBe("late.txt");
  });
});

describe("verified workspace", () => {
  it("is not found with no configuration or an unknown id", async () => {
    const { commands } = build();
    expect(commands.verifiedProductWorkspace(workspaceId)).toEqual({
      status: "not_found",
    });
    const root = await scratch();
    const fixture = build({
      settings: settingsOf({
        root,
        generation: 3,
        verifiedRevision: 3,
        identity: true,
      }),
    });
    expect(
      fixture.commands.verifiedProductWorkspace(
        "00000000-0000-4000-8000-0000000000ff",
      ),
    ).toEqual({ status: "not_found" });
  });

  it("is verified only at the generation the verification names", async () => {
    const root = await scratch();
    const current = build({
      settings: settingsOf({
        root,
        generation: 3,
        verifiedRevision: 3,
        identity: true,
      }),
    });
    expect(
      current.commands.verifiedProductWorkspace(workspaceId),
    ).toMatchObject({ status: "verified", workspace: { workspaceId, root } });
    const stale = build({
      settings: settingsOf({
        root,
        generation: 4,
        verifiedRevision: 3,
        identity: true,
      }),
    });
    expect(stale.commands.verifiedProductWorkspace(workspaceId)).toEqual({
      status: "not_verified",
    });
  });

  it("refuses a workspace with no bound identity or no verification", async () => {
    const root = await scratch();
    for (const settings of [
      settingsOf({ root, generation: 3, verifiedRevision: 3, identity: false }),
      settingsOf({
        root,
        generation: 3,
        verifiedRevision: null,
        identity: true,
      }),
    ]) {
      const { commands } = build({ settings });
      expect(commands.verifiedProductWorkspace(workspaceId)).toEqual({
        status: "not_verified",
      });
    }
  });

  it("reads the current snapshot at each call", async () => {
    const root = await scratch();
    const fixture = build({
      settings: settingsOf({
        root,
        generation: 3,
        verifiedRevision: 3,
        identity: true,
      }),
    });
    expect(fixture.commands.verifiedProductWorkspace(workspaceId).status).toBe(
      "verified",
    );
    fixture.state.settings = settingsOf({
      root,
      generation: 4,
      verifiedRevision: 3,
      identity: true,
    });
    expect(fixture.commands.verifiedProductWorkspace(workspaceId).status).toBe(
      "not_verified",
    );
    fixture.state.settings = null;
    expect(fixture.commands.verifiedProductWorkspace(workspaceId).status).toBe(
      "not_found",
    );
  });
});

describe("inspect and list", () => {
  function core(root: string, extra: Record<string, unknown> = {}) {
    const rootRecord = { path: root, device: "1", inode: "2" };
    return {
      inspectSettingsWorkspace: vi.fn(async () => ({ root: rootRecord })),
      listSettingsWorkspace: vi.fn(async () => ({
        root: rootRecord,
        entries: ["a", "b/"],
        truncated: false,
        ...extra,
      })),
    };
  }
  const settingsAt = (root: string, generation = 5) =>
    settingsOf({ root, generation, verifiedRevision: null, identity: true });
  const target = (root: string) => ({ workspaceId, root });

  it("inspects: ok when path, identity and generation hold", async () => {
    const root = await scratch();
    const fake = core(root);
    const { commands } = build({ core: fake, settings: settingsAt(root) });
    await expect(
      commands.inspectOwnerWorkspace(
        5,
        target(root),
        { device: "1", inode: "2" },
        "act",
      ),
    ).resolves.toEqual({ ok: true });
    expect(fake.inspectSettingsWorkspace).toHaveBeenCalledWith(
      5,
      workspaceId,
      ".",
    );
    // A null identity compares the path only.
    await expect(
      commands.inspectOwnerWorkspace(5, target(root), null, "act"),
    ).resolves.toEqual({ ok: true });
  });

  it("inspects: passes writableByOthers through only when true", async () => {
    const root = await scratch();
    const fake = core(root);
    const { commands } = build({ core: fake, settings: settingsAt(root) });
    fake.inspectSettingsWorkspace.mockImplementation(async () => ({
      root: { path: root, device: "1", inode: "2" },
      writableByOthers: true,
    }));
    await expect(
      commands.inspectOwnerWorkspace(5, target(root), null, "act"),
    ).resolves.toEqual({ ok: true, writableByOthers: true });
  });

  it("inspects: no Go core is a read failure", async () => {
    const root = await scratch();
    const { commands } = build({ settings: settingsAt(root) });
    await expect(
      commands.inspectOwnerWorkspace(5, target(root), null, "act"),
    ).resolves.toEqual({ ok: false, code: "WORKSPACE_READ_FAILED" });
  });

  it("inspects: a moved path, a measured identity, a generation or settings that changed refuse", async () => {
    const root = await scratch();
    const other = await scratch();
    const cases: [string, Parameters<typeof build>[0], unknown][] = [
      ["path", { core: core(other), settings: settingsAt(root) }, null],
      [
        "identity device",
        { core: core(root), settings: settingsAt(root) },
        { device: "9", inode: "2" },
      ],
      [
        "identity inode",
        { core: core(root), settings: settingsAt(root) },
        { device: "1", inode: "9" },
      ],
      ["generation", { core: core(root), settings: settingsAt(root, 6) }, null],
      ["settings", { core: core(root), settings: null }, null],
    ];
    for (const [name, initial, identity] of cases) {
      const { commands } = build(initial);
      await expect(
        commands.inspectOwnerWorkspace(
          5,
          target(root),
          identity as { device: string; inode: string } | null,
          "act",
        ),
        name,
      ).resolves.toEqual({ ok: false, code: "WORKSPACE_ROOT_CHANGED" });
    }
  });

  it("inspects: rechecks the settings after the Go call returns", async () => {
    const root = await scratch();
    const fake = core(root);
    const fixture = build({ core: fake, settings: settingsAt(root) });
    fake.inspectSettingsWorkspace.mockImplementation(async () => {
      fixture.state.settings = settingsAt(root, 6);
      return { root: { path: root, device: "1", inode: "2" } };
    });
    await expect(
      fixture.commands.inspectOwnerWorkspace(5, target(root), null, "act"),
    ).resolves.toEqual({ ok: false, code: "WORKSPACE_ROOT_CHANGED" });
  });

  it("inspects: a classified failure keeps its code, any other is a read failure, and both report", async () => {
    const root = await scratch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [error, code] of [
      [
        Object.assign(new Error("x"), { code: "WORKSPACE_NOT_FOUND" }),
        "WORKSPACE_NOT_FOUND",
      ],
      [new Error("boom"), "WORKSPACE_READ_FAILED"],
    ] as const) {
      const fake = core(root);
      fake.inspectSettingsWorkspace.mockRejectedValue(error);
      const { commands } = build({ core: fake, settings: settingsAt(root) });
      await expect(
        commands.inspectOwnerWorkspace(5, target(root), null, "settings.check"),
      ).resolves.toEqual({ ok: false, code });
    }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toBe("farol.computer-check-refused");
    expect(JSON.parse(String(warn.mock.calls[0]![1]))).toMatchObject({
      action: "settings.check",
      stage: "go-settings-inspect",
      cause: "WORKSPACE_NOT_FOUND",
    });
  });

  it("lists: entries and truncation pass through, the saved identity is ignored", async () => {
    const root = await scratch();
    for (const truncated of [false, true]) {
      const fake = core(root, { truncated });
      const { commands } = build({ core: fake, settings: settingsAt(root) });
      await expect(
        commands.listOwnerWorkspace(5, target(root), { device: "x" }, "sub"),
      ).resolves.toEqual({ ok: true, entries: ["a", "b/"], truncated });
      expect(fake.listSettingsWorkspace).toHaveBeenCalledWith(
        5,
        workspaceId,
        "sub",
      );
    }
  });

  it("lists: a missing core refuses and reports only when asked to", async () => {
    const root = await scratch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { commands } = build({ settings: settingsAt(root) });
    await expect(
      commands.listOwnerWorkspace(5, target(root), null, "."),
    ).resolves.toEqual({ ok: false, code: "WORKSPACE_READ_FAILED" });
    expect(warn).not.toHaveBeenCalled();
    await expect(
      commands.listOwnerWorkspace(5, target(root), null, ".", "settings.list"),
    ).resolves.toEqual({ ok: false, code: "WORKSPACE_READ_FAILED" });
    expect(JSON.parse(String(warn.mock.calls[0]![1]))).toMatchObject({
      action: "settings.list",
      stage: "go-unavailable",
    });
  });

  it("lists: a moved root or a changed generation is a root change and reports", async () => {
    const root = await scratch();
    const other = await scratch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const initial of [
      { core: core(other), settings: settingsAt(root) },
      { core: core(root), settings: settingsAt(root, 6) },
      { core: core(root), settings: null },
    ]) {
      const { commands } = build(initial);
      await expect(
        commands.listOwnerWorkspace(
          5,
          target(root),
          null,
          ".",
          "settings.list",
        ),
      ).resolves.toEqual({ ok: false, code: "WORKSPACE_ROOT_CHANGED" });
    }
    expect(warn).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(warn.mock.calls[0]![1]))).toMatchObject({
      stage: "root-recheck",
      cause: "WORKSPACE_ROOT_CHANGED",
    });
  });

  it("lists: a refused Go call never selects the legacy executor", async () => {
    const root = await scratch();
    const fake = core(root);
    fake.listSettingsWorkspace.mockRejectedValue(new Error("boom"));
    const { commands, nativeWorkspace } = build({
      core: fake,
      settings: settingsAt(root),
    });
    await expect(
      commands.listOwnerWorkspace(5, target(root), null, "."),
    ).resolves.toEqual({ ok: false, code: "WORKSPACE_READ_FAILED" });
    expect(nativeWorkspace.execute).not.toHaveBeenCalled();
  });

  it("takes the Go core at the call, not at construction", async () => {
    const root = await scratch();
    const fixture = build({ settings: settingsAt(root) });
    await expect(
      fixture.commands.listOwnerWorkspace(5, target(root), null, "."),
    ).resolves.toMatchObject({ ok: false });
    fixture.state.core = core(root);
    await expect(
      fixture.commands.listOwnerWorkspace(5, target(root), null, "."),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("Codex agent check workspace", () => {
  const settings = settingsOf({
    root: "/workspace/primary",
    generation: 7,
    verifiedRevision: null,
    identity: true,
  });
  const descriptor = {
    workspaceId,
    root: "/workspace/primary",
    deniedPaths: [],
    approvedRoot: { path: "/workspace/primary", device: "1", inode: "2" },
  };
  const listRequest = {
    workspace: descriptor,
    operation: { kind: "workspace.list", relativePath: "." },
  } as never;

  it("keeps the native workspace only for the legacy build", () => {
    const { commands, nativeWorkspace } = build({ compiledGoCore: null });
    expect(commands.codexAgentCheckWorkspace(settings)).toBe(nativeWorkspace);
  });

  it("lists through the Go settings list in a Go build, at the check's generation", async () => {
    const core = {
      inspectSettingsWorkspace: vi.fn(),
      listSettingsWorkspace: vi.fn(async () => ({
        root: { path: "/workspace/primary", device: "1", inode: "2" },
        entries: ["a"],
        truncated: true,
      })),
    };
    const fixture = build({
      compiledGoCore: { go: true },
      core,
      settings,
    });
    const chosen = fixture.commands.codexAgentCheckWorkspace(settings);
    expect(chosen).toBeInstanceOf(GoSettingsListWorkspace);
    expect(chosen).not.toBe(fixture.nativeWorkspace);
    await expect(chosen.execute(listRequest)).resolves.toEqual({
      ok: true,
      value: { kind: "workspace.entries", entries: ["a"], truncated: true },
    });
    expect(core.listSettingsWorkspace).toHaveBeenCalledWith(
      7,
      workspaceId,
      ".",
    );
    expect(fixture.nativeWorkspace.execute).not.toHaveBeenCalled();
  });

  it("fails the list with a closed refusal and never reaches the native workspace", async () => {
    const fixture = build({
      compiledGoCore: { go: true },
      core: null,
      settings,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const chosen = fixture.commands.codexAgentCheckWorkspace(settings);
    await expect(chosen.execute(listRequest)).resolves.toEqual({
      ok: false,
      error: { code: "WORKSPACE_HELPER_FAILED", retry: "never" },
    });
    expect(fixture.nativeWorkspace.execute).not.toHaveBeenCalled();
  });
});

describe("Go workspace edit result", () => {
  const receipt = {
    relativePath: "src/a.ts",
    operation: "edit",
    bytes: "12",
    replacements: 1,
    beforeSHA256: "a".repeat(64),
    afterSHA256: "b".repeat(64),
  };
  const delivery = (
    overrides: Record<string, unknown> = {},
  ): SettingsDeliveryResult =>
    ({
      state: "offered",
      pending: {},
      retention: "durable",
      result: {
        operationId,
        workspaceId,
        computerGeneration: "7",
        phase: "completed",
        publication: "durable",
        receipt,
      },
      ...overrides,
    }) as unknown as SettingsDeliveryResult;
  const ready = () =>
    build({
      settings: settingsOf({
        root: "/workspace/primary",
        generation: 7,
        verifiedRevision: null,
        identity: true,
      }),
    });

  it("is unavailable with no configuration", () => {
    const { commands } = build();
    expect(commands.goWorkspaceEditResult(delivery(), false)).toEqual({
      ok: false,
      error: "SETTINGS_UNAVAILABLE",
    });
  });

  it("reports a pending delivery as in progress", () => {
    const { commands } = ready();
    expect(
      commands.goWorkspaceEditResult(delivery({ state: "pending" }), false),
    ).toEqual({ ok: false, error: "WORKSPACE_MUTATION_IN_PROGRESS" });
  });

  it("maps a failed or unknown outcome through the mutation mapper", () => {
    const { commands } = ready();
    for (const [phase, code, expected] of [
      ["failed", "WORKSPACE_EDIT_NO_MATCH", "WORKSPACE_EDIT_NO_MATCH"],
      ["failed", "AUTHORITY_PATH_DENIED", "WORKSPACE_WRITE_APPROVAL_REQUIRED"],
      ["failed", "UNMAPPED", "WORKSPACE_MUTATION_FAILED"],
      [
        "outcome_unknown",
        "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
        "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
      ],
    ] as const) {
      const result = delivery({
        result: {
          operationId,
          workspaceId,
          computerGeneration: "7",
          phase,
          publication: "durable",
          failure: { code },
        },
      });
      expect(commands.goWorkspaceEditResult(result, false), code).toEqual({
        ok: false,
        error: expected,
      });
    }
  });

  it("projects a completed edit with the snapshot and the retained evidence", () => {
    const { commands } = ready();
    for (const redelivered of [false, true]) {
      const result = commands.goWorkspaceEditResult(delivery(), redelivered);
      expect(result).toMatchObject({
        ok: true,
        snapshot: { status: "ready" },
        evidence: {
          kind: "computer.workspace-mutation",
          operationId,
          workspaceId,
          relativePath: "src/a.ts",
          operation: "edit",
          bytes: 12,
          replacements: 1,
          beforeSha256: "a".repeat(64),
          afterSha256: "b".repeat(64),
          resultRetention: "durable",
          redelivered,
        },
      });
    }
    expect(
      commands.goWorkspaceEditResult(
        delivery({ retention: "memory_only" }),
        false,
      ),
    ).toMatchObject({ evidence: { resultRetention: "memory_only" } });
  });
});
