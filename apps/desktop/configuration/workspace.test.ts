import {
  lstat,
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
import type { DiscoveryCandidate } from "../../../src/apps/desktop/executable-discovery";
import { createCell } from "../host/cell";
import { createWorkspaceHost, type WorkspaceHostPorts } from "./workspace";

// The workspace host over real temporary directories and a fixture standing in
// for main-process state. Every owner is read through a getter the test can
// change after the factory is built, so a test proves a value is taken at the
// call, not at construction. No window, dialog, settings file or reservation is
// real; the folder measurements are.

type Workspace = Readonly<{
  workspaceId: string;
  root: string;
  rootIdentity?: Readonly<{ device: string; inode: string }>;
}>;

type Result = { ok: true } | { ok: false; error: string };

const roots: string[] = [];

async function scratch(): Promise<string> {
  // Resolved: the system temp path may itself be reached through a link.
  const made = await realpath(await mkdtemp(path.join(os.tmpdir(), "ws-")));
  roots.push(made);
  return made;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

async function identityOf(root: string) {
  const measured = await lstat(root, { bigint: true });
  return { device: String(measured.dev), inode: String(measured.ino) };
}

function fixture(log: string[] = []) {
  const state = {
    workspaces: [] as Workspace[],
    snapshotStatus: "ready" as "ready" | "error",
    resumeHeld: false,
    closed: false,
    occupiedConnector: false,
    agentActive: false,
    connectorRunning: false,
    admitted: true,
    withdraw: (async () => ({ ok: true })) as (
      found: readonly unknown[],
    ) => Promise<Result>,
    present: true,
    env: {} as Record<string, string | undefined>,
    window: { isDestroyed: () => false } as {
      isDestroyed: () => boolean;
    } | null,
    discovered: [] as DiscoveryCandidate[],
    dialogResponse: 1,
    dialogPaths: [] as string[],
    dialogCanceled: false,
  };
  const withdrawCalls: unknown[][] = [];
  const configuration = {
    startupResumeHeld: () => state.resumeHeld,
    snapshot: () => {
      log.push("snapshot");
      return state.snapshotStatus === "ready"
        ? {
            status: "ready" as const,
            settings: { computer: { workspaces: state.workspaces } },
          }
        : { status: "error" as const };
    },
    withdrawDriftedWorkspaceChecks: vi.fn(
      async (found: readonly unknown[], open: () => boolean) => {
        log.push(`withdraw:open=${String(open())}`);
        withdrawCalls.push([...found]);
        return state.withdraw(found);
      },
    ),
  };
  const withReservation = vi.fn(
    async (kind: string, work: () => Promise<unknown>) => {
      log.push(`reserve:${kind}`);
      if (!state.admitted) return { admitted: false, heldBy: "connect" };
      const value = await work();
      log.push("release");
      return { admitted: true, value };
    },
  );
  const showOpenDialog = vi.fn(async (_owner: unknown, _options: unknown) => ({
    canceled: state.dialogCanceled,
    filePaths: state.dialogPaths,
  }));
  const showMessageBox = vi.fn(async (_owner: unknown, _options: unknown) => ({
    response: state.dialogResponse,
  }));
  const evidence = vi.fn((_settings: unknown, workspaceId: string) => {
    log.push(`evidence:${workspaceId}`);
    return `evidence-of-${workspaceId}`;
  });
  const discoverExecutables = vi.fn(async (_kind: string) => ({
    candidates: state.discovered,
    searched: [],
  }));
  const ports = {
    configuration: () => (state.present ? configuration : null),
    authorityTransitions: { withReservation },
    desktopAdmission: {
      closed: () => state.closed,
      occupied: (kind: string) =>
        kind === "connector-task" && state.occupiedConnector,
    },
    codexAgentOperationActive: () => state.agentActive,
    secureMcpConnectorRuntime: () => ({
      isRunning: () => state.connectorRunning,
    }),
    workspaceCheckEvidence: evidence,
    window: () => state.window,
    showOpenDialog,
    showMessageBox,
    discoverExecutables,
    env: state.env,
  };
  return {
    state,
    log,
    configuration,
    withdrawCalls,
    withReservation,
    showOpenDialog,
    showMessageBox,
    evidence,
    discoverExecutables,
    ports: ports as unknown as WorkspaceHostPorts,
    subject: createWorkspaceHost(ports as unknown as WorkspaceHostPorts),
  };
}

function warnings() {
  return vi.spyOn(console, "warn").mockImplementation(() => undefined);
}

describe("measuredRootIdentity", () => {
  it("measures the device and inode of a directory, as decimal strings", async () => {
    const root = await scratch();
    const { subject } = fixture();
    const measured = await subject.measuredRootIdentity(root);
    expect(measured).toEqual(await identityOf(root));
    expect(measured).toEqual({
      device: expect.stringMatching(/^\d+$/),
      inode: expect.stringMatching(/^\d+$/),
    });
  });

  it("measures nothing for a regular file, a missing path or a link to a directory", async () => {
    const root = await scratch();
    const file = path.join(root, "file");
    await writeFile(file, "x");
    await mkdir(path.join(root, "real"));
    await symlink(path.join(root, "real"), path.join(root, "link"));
    const { subject } = fixture();
    expect(await subject.measuredRootIdentity(file)).toBeNull();
    expect(
      await subject.measuredRootIdentity(path.join(root, "gone")),
    ).toBeNull();
    // lstat does not follow: a link is not a directory it can approve.
    expect(
      await subject.measuredRootIdentity(path.join(root, "link")),
    ).toBeNull();
  });
});

describe("withdrawDriftedWorkspaceChecksAtLaunch", () => {
  async function bound(
    s: ReturnType<typeof fixture>,
    id: string,
    root: string,
    identity?: { device: string; inode: string },
  ) {
    s.state.workspaces.push({
      workspaceId: id,
      root,
      rootIdentity: identity ?? (await identityOf(root)),
    });
  }

  it("has nothing to scan without a settings service, and takes no reservation", async () => {
    const s = fixture();
    s.state.present = false;
    expect(await s.subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(true);
    expect(s.withReservation).not.toHaveBeenCalled();
  });

  it("refuses to settle while the settings owner holds this launch's resume", async () => {
    const root = await scratch();
    const s = fixture();
    await bound(s, "w1", root);
    s.state.resumeHeld = true;
    expect(await s.subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(
      false,
    );
  });

  it("keeps a folder at the same path with the same identity, and writes nothing", async () => {
    const root = await scratch();
    const warn = warnings();
    const s = fixture();
    await bound(s, "w1", root);
    expect(await s.subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(true);
    expect(
      s.configuration.withdrawDriftedWorkspaceChecks,
    ).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a check whose folder was replaced at the same path, and only observes it", async () => {
    const root = await scratch();
    const warn = warnings();
    const s = fixture();
    const now = await identityOf(root);
    await bound(s, "w1", root, { device: now.device, inode: "1" });
    expect(await s.subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(true);
    expect(
      s.configuration.withdrawDriftedWorkspaceChecks,
    ).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `FAROL_WORKSPACE_ROOT_OBSERVED:${JSON.stringify({ drift: "different-object" })}`,
    );
  });

  it("keeps a check whose device was renumbered, and only observes it", async () => {
    const root = await scratch();
    const warn = warnings();
    const s = fixture();
    const now = await identityOf(root);
    await bound(s, "w1", root, { device: `${now.device}0`, inode: now.inode });
    expect(await s.subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(true);
    expect(
      s.configuration.withdrawDriftedWorkspaceChecks,
    ).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      `FAROL_WORKSPACE_ROOT_OBSERVED:${JSON.stringify({ drift: "device-renumbered" })}`,
    );
  });

  it("withdraws a folder that is gone, with the evidence read before it was measured", async () => {
    const parent = await scratch();
    const missing = path.join(parent, "gone");
    const warn = warnings();
    const log: string[] = [];
    const s = fixture(log);
    await bound(s, "w1", missing, { device: "5", inode: "9" });
    expect(await s.subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(true);
    expect(s.withdrawCalls).toEqual([
      [
        {
          workspaceId: "w1",
          root: missing,
          rootIdentity: { device: "5", inode: "9" },
          observed: "evidence-of-w1",
        },
      ],
    ]);
    expect(log).toEqual([
      "reserve:authority-change",
      "snapshot",
      "evidence:w1",
      "withdraw:open=true",
      "release",
    ]);
    expect(warn).toHaveBeenCalledWith(
      `FAROL_WORKSPACE_ROOT_OBSERVED:${JSON.stringify({ drift: "unmeasured" })}`,
    );
    expect(warn).toHaveBeenCalledWith(
      "FAROL_WORKSPACE_ROOT_DRIFT:" +
        JSON.stringify({ workspaces: 1, withdrawn: true }),
    );
  });

  it("withdraws a folder now reached through a linked ancestor", async () => {
    const parent = await scratch();
    await mkdir(path.join(parent, "real", "project"), { recursive: true });
    await symlink(path.join(parent, "real"), path.join(parent, "linked"));
    const through = path.join(parent, "linked", "project");
    warnings();
    const s = fixture();
    await bound(s, "w1", through);
    expect(await s.subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(true);
    expect(s.withdrawCalls).toHaveLength(1);
    expect(s.withdrawCalls[0]).toMatchObject([
      { workspaceId: "w1", root: through },
    ]);
  });

  it("skips a folder with no recorded identity, and gathers every vanished one in one write", async () => {
    const parent = await scratch();
    const kept = path.join(parent, "kept");
    await mkdir(kept);
    warnings();
    const s = fixture();
    s.state.workspaces.push({
      workspaceId: "unbound",
      root: path.join(parent, "x"),
    });
    await bound(s, "keep", kept);
    await bound(s, "a", path.join(parent, "a"), { device: "1", inode: "1" });
    await bound(s, "b", path.join(parent, "b"), { device: "1", inode: "2" });
    expect(await s.subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(true);
    expect(
      s.configuration.withdrawDriftedWorkspaceChecks,
    ).toHaveBeenCalledTimes(1);
    expect(
      s.withdrawCalls[0]?.map((entry) => (entry as Workspace).workspaceId),
    ).toEqual(["a", "b"]);
    expect(s.evidence).not.toHaveBeenCalledWith(expect.anything(), "unbound");
  });

  it("refuses to resume when settings are not ready, writing nothing", async () => {
    const s = fixture();
    s.state.snapshotStatus = "error";
    expect(await s.subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(
      false,
    );
    expect(
      s.configuration.withdrawDriftedWorkspaceChecks,
    ).not.toHaveBeenCalled();
  });

  it("leaves settings alone and refuses to resume when Quit closed admission during the scan", async () => {
    const parent = await scratch();
    const warn = warnings();
    const s = fixture();
    await bound(s, "w1", path.join(parent, "gone"), {
      device: "1",
      inode: "1",
    });
    s.state.closed = true;
    expect(await s.subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(
      false,
    );
    expect(
      s.configuration.withdrawDriftedWorkspaceChecks,
    ).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "FAROL_WORKSPACE_ROOT_DRIFT:" +
        JSON.stringify({
          workspaces: 1,
          withdrawn: false,
          code: "AUTHORITY_CHANGE_IN_PROGRESS",
        }),
    );
  });

  it.each([
    [
      "an active Agent",
      (s: ReturnType<typeof fixture>) => (s.state.agentActive = true),
    ],
    [
      "a connector task",
      (s: ReturnType<typeof fixture>) => (s.state.occupiedConnector = true),
    ],
    [
      "a running connector",
      (s: ReturnType<typeof fixture>) => (s.state.connectorRunning = true),
    ],
  ])(
    "leaves settings alone while %s still carries the grant",
    async (_name, arm) => {
      const parent = await scratch();
      const warn = warnings();
      const s = fixture();
      await bound(s, "w1", path.join(parent, "gone"), {
        device: "1",
        inode: "1",
      });
      arm(s);
      expect(await s.subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(
        false,
      );
      expect(
        s.configuration.withdrawDriftedWorkspaceChecks,
      ).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "FAROL_WORKSPACE_ROOT_DRIFT:" +
          JSON.stringify({
            workspaces: 1,
            withdrawn: false,
            code: "CONNECTOR_STOP_REQUIRED",
          }),
      );
    },
  );

  it("checks admission before the connector and Agent, so a closed Quit wins", async () => {
    const parent = await scratch();
    warnings();
    const s = fixture();
    await bound(s, "w1", path.join(parent, "gone"), {
      device: "1",
      inode: "1",
    });
    s.state.closed = true;
    s.state.agentActive = true;
    await s.subject.withdrawDriftedWorkspaceChecksAtLaunch();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('"code":"AUTHORITY_CHANGE_IN_PROGRESS"'),
    );
  });

  it("refuses to resume when a competing authority change holds the reservation", async () => {
    const warn = warnings();
    const s = fixture();
    s.state.admitted = false;
    expect(await s.subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(
      false,
    );
    // Nothing was measured: the scan never started.
    expect(s.log).toEqual(["reserve:authority-change"]);
    expect(
      s.configuration.withdrawDriftedWorkspaceChecks,
    ).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "FAROL_WORKSPACE_ROOT_DRIFT:" +
        JSON.stringify({
          workspaces: 0,
          withdrawn: false,
          code: "AUTHORITY_CHANGE_IN_PROGRESS",
        }),
    );
  });

  it("reports the settings error and refuses to resume when the withdrawal fails", async () => {
    const parent = await scratch();
    const warn = warnings();
    const s = fixture();
    await bound(s, "w1", path.join(parent, "gone"), {
      device: "1",
      inode: "1",
    });
    s.state.withdraw = async () => ({ ok: false, error: "SETTINGS_BUSY" });
    expect(await s.subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(
      false,
    );
    expect(warn).toHaveBeenCalledWith(
      "FAROL_WORKSPACE_ROOT_DRIFT:" +
        JSON.stringify({
          workspaces: 1,
          withdrawn: false,
          code: "SETTINGS_BUSY",
        }),
    );
  });

  it("classifies a thrown write as a failed write, never a withdrawal", async () => {
    const parent = await scratch();
    const warn = warnings();
    const s = fixture();
    await bound(s, "w1", path.join(parent, "gone"), {
      device: "1",
      inode: "1",
    });
    s.state.withdraw = async () => {
      throw new Error("disk");
    };
    expect(await s.subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(
      false,
    );
    expect(warn).toHaveBeenCalledWith(
      "FAROL_WORKSPACE_ROOT_DRIFT:" +
        JSON.stringify({
          workspaces: 1,
          withdrawn: false,
          code: "SETTINGS_WRITE_FAILED",
        }),
    );
  });

  it("treats a settings service gone since the scan as a failed write", async () => {
    const parent = await scratch();
    const warn = warnings();
    const s = fixture();
    await bound(s, "w1", path.join(parent, "gone"), {
      device: "1",
      inode: "1",
    });
    // The scan's first read sees the service; the write's read does not.
    let reads = 0;
    const ports = {
      ...s.ports,
      configuration: () => (reads++ === 0 ? s.configuration : null),
    } as unknown as WorkspaceHostPorts;
    const subject = createWorkspaceHost(ports);
    expect(await subject.withdrawDriftedWorkspaceChecksAtLaunch()).toBe(false);
    expect(
      s.configuration.withdrawDriftedWorkspaceChecks,
    ).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "FAROL_WORKSPACE_ROOT_DRIFT:" +
        JSON.stringify({
          workspaces: 1,
          withdrawn: false,
          code: "SETTINGS_WRITE_FAILED",
        }),
    );
  });

  it("passes the Quit fence to the write, so it is checked again at the write", async () => {
    const parent = await scratch();
    warnings();
    const s = fixture();
    await bound(s, "w1", path.join(parent, "gone"), {
      device: "1",
      inode: "1",
    });
    await s.subject.withdrawDriftedWorkspaceChecksAtLaunch();
    const fence =
      s.configuration.withdrawDriftedWorkspaceChecks.mock.calls[0]?.[1];
    expect(fence?.()).toBe(true);
    s.state.closed = true;
    expect(fence?.()).toBe(false);
  });
});

describe("selectedWorkspace", () => {
  it("is cancelled by the e2e cancel seam before any dialog or path is read", async () => {
    const s = fixture();
    Object.assign(s.state.env, {
      FAROL_E2E: "1",
      FAROL_E2E_CANCEL_WORKSPACE_PICKER: "1",
      FAROL_E2E_WORKSPACE_ROOT: "/ignored",
    });
    expect(await s.subject.selectedWorkspace()).toBe("cancelled");
    expect(s.showOpenDialog).not.toHaveBeenCalled();
  });

  it("ignores the e2e seams unless the e2e switch is on", async () => {
    const s = fixture();
    Object.assign(s.state.env, {
      FAROL_E2E_CANCEL_WORKSPACE_PICKER: "1",
      FAROL_E2E_WORKSPACE_ROOT: "/ignored",
    });
    s.state.window = null;
    expect(await s.subject.selectedWorkspace()).toBe("invalid");
    expect(s.showOpenDialog).not.toHaveBeenCalled();
  });

  it("takes the e2e root without a dialog, with its resolved path, label and identity", async () => {
    const root = await scratch();
    const s = fixture();
    Object.assign(s.state.env, {
      FAROL_E2E: "1",
      FAROL_E2E_WORKSPACE_ROOT: root,
    });
    expect(await s.subject.selectedWorkspace()).toEqual({
      root,
      label: path.basename(root),
      rootIdentity: await identityOf(root),
    });
    expect(s.showOpenDialog).not.toHaveBeenCalled();
  });

  it("is invalid without a window when no e2e root is given", async () => {
    const s = fixture();
    s.state.window = null;
    expect(await s.subject.selectedWorkspace()).toBe("invalid");
    expect(s.showOpenDialog).not.toHaveBeenCalled();
  });

  it("reads the window at the call, not when the host was built", async () => {
    const root = await scratch();
    const s = fixture();
    s.state.window = null;
    s.state.dialogPaths = [root];
    expect(await s.subject.selectedWorkspace()).toBe("invalid");
    s.state.window = { isDestroyed: () => false };
    expect(await s.subject.selectedWorkspace()).toMatchObject({ root });
  });

  it("is cancelled when the owner cancels, chooses none or chooses several", async () => {
    const one = await scratch();
    const two = await scratch();
    const s = fixture();
    s.state.dialogCanceled = true;
    s.state.dialogPaths = [one];
    expect(await s.subject.selectedWorkspace()).toBe("cancelled");
    s.state.dialogCanceled = false;
    s.state.dialogPaths = [];
    expect(await s.subject.selectedWorkspace()).toBe("cancelled");
    s.state.dialogPaths = [one, two];
    expect(await s.subject.selectedWorkspace()).toBe("cancelled");
  });

  it("asks the owner for exactly one folder, through the main window", async () => {
    const root = await scratch();
    const s = fixture();
    s.state.dialogPaths = [root];
    await s.subject.selectedWorkspace();
    expect(s.showOpenDialog).toHaveBeenCalledWith(s.state.window, {
      title: "Choose a workspace",
      buttonLabel: "Add Workspace",
      properties: ["openDirectory"],
      securityScopedBookmarks: false,
    });
  });

  it("returns the one chosen folder, resolved, with its label and measured identity", async () => {
    const root = await scratch();
    const s = fixture();
    s.state.dialogPaths = [root];
    expect(await s.subject.selectedWorkspace()).toEqual({
      root,
      label: path.basename(root),
      rootIdentity: await identityOf(root),
    });
  });

  it("refuses a relative path, a file, a link, and a stale path that has since vanished", async () => {
    const root = await scratch();
    const file = path.join(root, "file");
    await writeFile(file, "x");
    await mkdir(path.join(root, "real"));
    await symlink(path.join(root, "real"), path.join(root, "link"));
    const s = fixture();
    for (const refused of [
      "relative/path",
      file,
      path.join(root, "link"),
      path.join(root, "vanished"),
    ]) {
      s.state.dialogPaths = [refused];
      expect(await s.subject.selectedWorkspace()).toBe("invalid");
    }
  });

  it("uses the filesystem root's own name as the label when it has no base name", async () => {
    const s = fixture();
    s.state.dialogPaths = ["/"];
    expect(await s.subject.selectedWorkspace()).toMatchObject({
      root: "/",
      label: "/",
    });
  });
});

describe("reverifyDiscoveredCandidate", () => {
  const candidate = (
    path: string,
    verdict: DiscoveryCandidate["verdict"],
  ): DiscoveryCandidate => ({
    requestedPath: path,
    path,
    source: "homebrew",
    origin: "unknown",
    verdict,
  });

  it("accepts a path discovery still offers, after discovering again itself", async () => {
    const s = fixture();
    const offered = candidate("/bin/codex", "offer");
    s.state.discovered = [offered];
    expect(
      await s.subject.reverifyDiscoveredCandidate("codex", "/bin/codex"),
    ).toBe(offered);
    expect(s.discoverExecutables).toHaveBeenCalledWith("codex");
    expect(s.showMessageBox).not.toHaveBeenCalled();
  });

  it("calls a path discovery no longer lists, or now refuses, stale", async () => {
    const s = fixture();
    s.state.discovered = [
      candidate("/bin/other", "offer"),
      candidate("/bin/old", "refused"),
    ];
    expect(
      await s.subject.reverifyDiscoveredCandidate("codex", "/bin/codex"),
    ).toBe("stale");
    expect(
      await s.subject.reverifyDiscoveredCandidate("codex", "/bin/old"),
    ).toBe("stale");
  });

  it("uses an untrusted candidate only after the owner confirms the main-process dialog", async () => {
    const s = fixture();
    const untrusted = candidate("/opt/codex", "needs-owner-choice");
    s.state.discovered = [untrusted];
    s.state.dialogResponse = 1;
    expect(
      await s.subject.reverifyDiscoveredCandidate("codex", "/opt/codex"),
    ).toBe(untrusted);
    expect(s.showMessageBox).toHaveBeenCalledWith(s.state.window, {
      type: "warning",
      buttons: ["Cancel", "Use this file"],
      defaultId: 0,
      cancelId: 0,
      message: "Use a Codex that is not confirmed as signed by OpenAI?",
      detail:
        "/opt/codex\n\nFarol could not confirm where this file came from. Continue only if you placed it there yourself.",
    });
  });

  it("names the tunnel-client in its own question", async () => {
    const s = fixture();
    s.state.discovered = [candidate("/opt/tunnel", "needs-owner-choice")];
    await s.subject.reverifyDiscoveredCandidate("tunnel-client", "/opt/tunnel");
    expect(s.showMessageBox).toHaveBeenCalledWith(
      s.state.window,
      expect.objectContaining({
        message: "Use a tunnel-client that does not match the reviewed build?",
      }),
    );
  });

  it("declines an untrusted candidate when the owner cancels or dismisses the dialog", async () => {
    const s = fixture();
    s.state.discovered = [candidate("/opt/codex", "needs-owner-choice")];
    for (const response of [0, 7, -1]) {
      s.state.dialogResponse = response;
      expect(
        await s.subject.reverifyDiscoveredCandidate("codex", "/opt/codex"),
      ).toBe("declined");
    }
  });

  it("declines when there is no window, or it was destroyed while discovery ran", async () => {
    const s = fixture();
    s.state.discovered = [candidate("/opt/codex", "needs-owner-choice")];
    s.state.window = null;
    expect(
      await s.subject.reverifyDiscoveredCandidate("codex", "/opt/codex"),
    ).toBe("declined");
    // The window is read after discovery, so one that goes away meanwhile
    // can never confirm.
    const living = createCell(true);
    s.state.window = { isDestroyed: () => !living.get() };
    s.discoverExecutables.mockImplementationOnce(async () => {
      living.set(false);
      return { candidates: s.state.discovered, searched: [] };
    });
    expect(
      await s.subject.reverifyDiscoveredCandidate("codex", "/opt/codex"),
    ).toBe("declined");
    expect(s.showMessageBox).not.toHaveBeenCalled();
  });

  it("declines when the dialog itself cannot be shown", async () => {
    const s = fixture();
    s.state.discovered = [candidate("/opt/codex", "needs-owner-choice")];
    s.showMessageBox.mockRejectedValueOnce(new Error("window gone"));
    expect(
      await s.subject.reverifyDiscoveredCandidate("codex", "/opt/codex"),
    ).toBe("declined");
  });
});

describe("construction", () => {
  it("reads no owner when it is built", () => {
    const reads: string[] = [];
    const base = fixture().ports;
    const spy = (name: string, value: unknown) => () => {
      reads.push(name);
      return value;
    };
    createWorkspaceHost({
      ...base,
      configuration: spy("configuration", null),
      window: spy("window", null),
      secureMcpConnectorRuntime: spy("connector", null),
      codexAgentOperationActive: spy("agent", false) as () => boolean,
    } as unknown as WorkspaceHostPorts);
    expect(reads).toEqual([]);
  });
});
