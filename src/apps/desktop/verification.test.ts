import { describe, expect, it } from "vitest";
import type { ProductSettings } from "../../pkg/product-settings/contract";
import { defaultSettings } from "./settings/rules";
import type { VerificationWorkspaceAction } from "../../../apps/desktop/configuration/computer";
import { createVerificationWorkspaceAction } from "./verification";

const COMPUTER_ID = "5f7c2b0e-3a1d-4e8b-9c6a-0d4f1e2b3a45";
const ROOT_IDENTITY = { device: "1", inode: "2" };

type Workspace = Parameters<typeof createVerificationWorkspaceAction>[0];
type NativeRequest = Parameters<Workspace["execute"]>[0];
type Request = Parameters<VerificationWorkspaceAction["execute"]>[0];

function fakeWorkspace(): Workspace & { requests: NativeRequest[] } {
  const requests: NativeRequest[] = [];
  return {
    requests,
    async execute(request) {
      requests.push(request);
      return {
        ok: true,
        value: {
          kind: "workspace.command",
          command: "git.head",
          relativePath: ".",
          exitCode: 0,
          stdout: "abc\n",
          stderr: "",
          outputBytes: 4,
          network: "none",
          coverage: "head-commit",
          layout: "primary",
        },
      };
    },
  };
}

function settings(
  commands: ProductSettings["computer"]["commands"],
  options: { bound?: boolean; access?: "read" | "write" } = {},
): ProductSettings {
  const base = defaultSettings(() => COMPUTER_ID);
  return {
    ...base,
    computer: {
      ...base.computer,
      commands,
      workspaces: [
        {
          workspaceId: "workspace-1",
          root: "/Users/example/project",
          label: "Project",
          access: options.access ?? "read",
          excludedPaths: ["/Users/example/project/secret"],
          ...(options.bound === false ? {} : { rootIdentity: ROOT_IDENTITY }),
        },
      ],
    },
  };
}

const request = (): Request => ({
  ownerId: "owner-desktop",
  sessionId: "desktop-command-session",
  taskId: "desktop-command-task",
  taskEpoch: 1,
  participantId: "desktop-command-main",
  turnId: "turn-1",
  generation: 1,
  callId: "call-1",
  workspaceId: "workspace-1",
  operation: {
    kind: "verification.run",
    command: "git.head",
    relativePath: ".",
  },
});

describe("createVerificationWorkspaceAction", () => {
  it("offers no action while commands are off", () => {
    const action = createVerificationWorkspaceAction(fakeWorkspace());
    const current = settings("none");
    expect(
      action(current, current.computer.workspaces[0]!, Date.now() + 60_000),
    ).toBeNull();
  });

  it("runs a verification command through the native workspace", async () => {
    const native = fakeWorkspace();
    const current = settings("verification");
    const action = createVerificationWorkspaceAction(native)(
      current,
      current.computer.workspaces[0]!,
      Date.now() + 60_000,
    );
    expect(action).not.toBeNull();
    const result = await action!.execute(request());
    expect(result.ok).toBe(true);
    expect(native.requests).toHaveLength(1);
    const sent = native.requests[0]!;
    expect(sent.operation).toEqual({
      kind: "verification.run",
      command: "git.head",
      relativePath: ".",
    });
    expect(sent.workspace.workspaceId).toBe("workspace-1");
    expect(sent.workspace.approvedRoot).toEqual({
      path: "/Users/example/project",
      ...ROOT_IDENTITY,
    });
    expect(sent.workspace.deniedPaths).toEqual(["secret"]);
  });

  it("still admits verification when another workspace is writable", () => {
    const current = settings("verification", { access: "write" });
    const action = createVerificationWorkspaceAction(fakeWorkspace())(
      current,
      current.computer.workspaces[0]!,
      Date.now() + 60_000,
    );
    expect(action).not.toBeNull();
  });

  it("refuses an operation outside verification", async () => {
    const native = fakeWorkspace();
    const current = settings("verification");
    const action = createVerificationWorkspaceAction(native)(
      current,
      current.computer.workspaces[0]!,
      Date.now() + 60_000,
    );
    const result = await action!.execute({
      ...request(),
      operation: { kind: "workspace.read", relativePath: "a.txt" },
    } as unknown as Request);
    expect(result.ok).toBe(false);
    expect(native.requests).toHaveLength(0);
  });

  it("offers no action for a workspace without a verified identity", () => {
    const current = settings("verification", { bound: false });
    const action = createVerificationWorkspaceAction(fakeWorkspace())(
      current,
      current.computer.workspaces[0]!,
      Date.now() + 60_000,
    );
    expect(action).toBeNull();
  });

  it("offers no action once the grant has already expired", () => {
    const current = settings("verification");
    const action = createVerificationWorkspaceAction(fakeWorkspace())(
      current,
      current.computer.workspaces[0]!,
      Date.now() - 1_000,
    );
    expect(action).toBeNull();
  });
});
