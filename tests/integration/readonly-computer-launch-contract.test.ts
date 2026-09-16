import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadReadonlyComputerLaunchContract,
  materializeReadonlyComputerLaunch,
  parseReadonlyComputerLaunchContract,
  READONLY_COMPUTER_LAUNCH_BASENAME,
  serializeReadonlyComputerLaunchContract,
  type ReadonlyComputerLaunchContract,
} from "../../src/apps/computer-mcp/launch-contract";
import type { ReadonlyWorkspace } from "../../src/modules/computer/app/port/readonly-workspace";

const workspaceRoot = "/Users/example/workspace";
let temporaryRoot = "";

function launchContract(): ReadonlyComputerLaunchContract {
  return {
    schema: 1,
    approval: {
      ownerId: "owner-a",
      computerId: "computer-a",
      generation: 3,
      workspaces: [
        { workspaceId: "workspace-a", root: workspaceRoot, access: "read" },
      ],
      capabilities: ["workspace.list", "workspace.read", "workspace.search"],
      network: "none",
      commands: "none",
      expiresAt: 20_000,
    },
    admission: {
      authorityId: "authority-a",
      ownerId: "owner-a",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 2,
      computerId: "computer-a",
      computerGeneration: 3,
      workspaces: [
        {
          workspaceId: "workspace-a",
          mode: "subtree",
          root: workspaceRoot,
          access: "read",
        },
      ],
      capabilities: ["workspace.list", "workspace.read", "workspace.search"],
      network: "none",
      commands: "none",
      expiresAt: 10_000,
    },
    delegationChain: [
      {
        participantId: "main-a",
        role: "main",
        mutationOwnership: "none",
      },
      {
        participantId: "agent-a",
        role: "agent",
        mutationOwnership: "none",
      },
      {
        participantId: "critic-a",
        role: "critic",
        mutationOwnership: "none",
      },
    ],
    binding: {
      participantId: "critic-a",
      turnId: "turn-a",
      generation: 4,
    },
  };
}

afterEach(async () => {
  if (temporaryRoot) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = "";
  }
});

describe("read-only Computer launch contract", () => {
  it("preserves the task workspace through main to agent to critic", () => {
    const materialized = materializeReadonlyComputerLaunch(
      launchContract(),
      1_000,
    );

    expect(materialized.participants.map((item) => item.role)).toEqual([
      "main",
      "agent",
      "critic",
    ]);
    expect(materialized.participants[2]?.grant.workspaces).toEqual([
      {
        workspaceId: "workspace-a",
        mode: "subtree",
        root: workspaceRoot,
        access: "read",
        restrictionSource: "task-grant",
      },
    ]);
    expect(materialized.binding).toMatchObject({
      ownerId: "owner-a",
      taskId: "task-a",
      participantId: "critic-a",
    });
  });

  it("applies explicit narrowing without changing the parent's grant", () => {
    const launch = launchContract();
    const critic = launch.delegationChain[2];
    if (critic === undefined) throw new Error("TEST_CHAIN_INVALID");
    launch.delegationChain[2] = {
      ...critic,
      narrowing: {
        workspaces: [
          {
            workspaceId: "workspace-a",
            mode: "exact",
            root: workspaceRoot,
            paths: [`${workspaceRoot}/src/approved.ts`],
            access: "read",
          },
        ],
        capabilities: ["workspace.read"],
        network: "none",
        commands: "none",
      },
    };

    const materialized = materializeReadonlyComputerLaunch(launch, 1_000);
    expect(materialized.participants[1]?.grant.workspaces[0]?.mode).toBe(
      "subtree",
    );
    expect(materialized.participants[2]?.grant.workspaces).toEqual([
      {
        workspaceId: "workspace-a",
        mode: "exact",
        root: workspaceRoot,
        paths: [`${workspaceRoot}/src/approved.ts`],
        access: "read",
        restrictionSource: "owner-restriction",
      },
    ]);
  });

  it("denies delegated authority inflation", () => {
    const launch = launchContract();
    const critic = launch.delegationChain[2];
    if (critic === undefined) throw new Error("TEST_CHAIN_INVALID");
    launch.delegationChain[2] = {
      ...critic,
      narrowing: {
        workspaces: [
          {
            workspaceId: "workspace-a",
            mode: "subtree",
            root: "/Users/example",
            access: "read",
          },
        ],
        capabilities: ["workspace.read"],
        network: "none",
        commands: "none",
      },
    };

    expect(() => materializeReadonlyComputerLaunch(launch, 1_000)).toThrow(
      "COMPUTER_LAUNCH_AUTHORITY_INFLATION_DENIED",
    );
  });

  it("rejects non-canonical JSON and write capability claims", () => {
    const launch = launchContract();
    expect(() =>
      parseReadonlyComputerLaunchContract(JSON.stringify(launch, null, 2)),
    ).toThrow("COMPUTER_LAUNCH_CANONICAL_INVALID");

    const unsafe = JSON.parse(
      serializeReadonlyComputerLaunchContract(launch),
    ) as { admission: { capabilities: string[] } };
    unsafe.admission.capabilities.push("workspace.write");
    expect(() =>
      parseReadonlyComputerLaunchContract(`${JSON.stringify(unsafe)}\n`),
    ).toThrow("COMPUTER_LAUNCH_SCHEMA_INVALID");
  });

  it("requires a private owner file before invoking the native reader", async () => {
    temporaryRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-launch-")),
    );
    await fs.chmod(temporaryRoot, 0o700);
    const file = path.join(temporaryRoot, READONLY_COMPUTER_LAUNCH_BASENAME);
    const serialized =
      serializeReadonlyComputerLaunchContract(launchContract());
    await fs.writeFile(file, serialized, { mode: 0o644 });
    let reads = 0;
    const workspace: ReadonlyWorkspace = {
      async execute() {
        reads += 1;
        return {
          ok: true,
          value: {
            kind: "workspace.text",
            text: serialized,
            bytes: Buffer.byteLength(serialized),
          },
        };
      },
    };

    await expect(
      loadReadonlyComputerLaunchContract(file, workspace),
    ).rejects.toThrow("COMPUTER_LAUNCH_FILE_UNTRUSTED");
    expect(reads).toBe(0);

    await fs.chmod(file, 0o600);
    await expect(
      loadReadonlyComputerLaunchContract(file, workspace),
    ).resolves.toEqual(launchContract());
    expect(reads).toBe(1);
  });
});
