import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  READONLY_COMPUTER_LAUNCH_BASENAME,
  ReadonlyComputerLaunchContractSchema,
  serializeReadonlyComputerLaunchContract,
  type ReadonlyComputerLaunchContract,
} from "../../modules/computer/infra/mcp/launch-contract";
import type { ProductSettings } from "../../pkg/product-settings/contract";
import type { CodexCallerRelayEndpoint } from "../../pkg/caller-relay/protocol";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const AUTHORITY_LIFETIME_MS = 12 * 60 * 60 * 1_000;

function launchError(code: string): never {
  throw new Error(code);
}

export function createSecureMcpLaunchContract(
  settings: ProductSettings,
  input: Readonly<{
    now: number;
    runtimeId: string;
    challengeSha256: string;
    callerRelay?: CodexCallerRelayEndpoint;
  }>,
): ReadonlyComputerLaunchContract {
  if (
    !Number.isSafeInteger(input.now) ||
    input.now <= 0 ||
    !/^[0-9A-Za-z._:-]{1,64}$/u.test(input.runtimeId) ||
    !/^[a-f0-9]{64}$/u.test(input.challengeSha256)
  ) {
    launchError("SECURE_MCP_LAUNCH_INPUT_INVALID");
  }
  const workspaces = settings.computer.workspaces;
  if (workspaces.length === 0) launchError("SECURE_MCP_WORKSPACE_REQUIRED");
  if (workspaces.length > 32) launchError("SECURE_MCP_WORKSPACE_LIMIT");

  const writeEnabled = workspaces.some(
    (workspace) => workspace.access === "write",
  );
  const capabilities = [
    "workspace.list" as const,
    "workspace.read" as const,
    "workspace.search" as const,
    ...(settings.computer.commands === "verification"
      ? (["verification.run"] as const)
      : []),
    ...(writeEnabled ? (["workspace.write"] as const) : []),
  ];
  const excludedPaths = workspaces.flatMap((workspace) =>
    workspace.excludedPaths.map((excluded) => ({
      workspaceId: workspace.workspaceId,
      path: excluded,
    })),
  );
  const expiresAt = input.now + AUTHORITY_LIFETIME_MS;
  const participantId = `secure-mcp-main-${input.runtimeId}`;
  const scopedWorkspaces = workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId,
    mode: "subtree" as const,
    root: workspace.root,
    access: workspace.access,
  }));

  return ReadonlyComputerLaunchContractSchema.parse({
    schema: 2,
    approval: {
      ownerId: "owner-desktop",
      computerId: settings.computer.computerId,
      generation: settings.computer.generation,
      workspaces: workspaces.map((workspace) => ({
        workspaceId: workspace.workspaceId,
        root: workspace.root,
        access: workspace.access,
        ...(workspace.rootIdentity
          ? { rootIdentity: workspace.rootIdentity }
          : {}),
        ...(workspace.gitMetadata
          ? { gitMetadata: workspace.gitMetadata }
          : {}),
      })),
      excludedPaths,
      capabilities,
      network: "none",
      commands: settings.computer.commands,
      expiresAt,
    },
    admission: {
      authorityId: `secure-mcp-authority-${input.runtimeId}`,
      ownerId: "owner-desktop",
      sessionId: `secure-mcp-session-${input.runtimeId}`,
      taskId: `secure-mcp-task-${input.runtimeId}`,
      taskEpoch: settings.computer.generation,
      computerId: settings.computer.computerId,
      computerGeneration: settings.computer.generation,
      workspaces: scopedWorkspaces,
      excludedPaths,
      capabilities,
      network: "none",
      commands: settings.computer.commands,
      expiresAt,
    },
    delegationChain: [
      {
        participantId,
        role: "main",
        mutationOwnership: writeEnabled ? "task" : "none",
      },
    ],
    binding: {
      participantId,
      turnId: `secure-mcp-turn-${input.runtimeId}`,
      generation: settings.computer.generation,
    },
    connectorVerification: {
      challengeSha256: input.challengeSha256,
    },
    ...(input.callerRelay === undefined
      ? {}
      : { callerRelay: input.callerRelay }),
  });
}

type StoreOptions = Readonly<{ root: string }>;

export class PrivateSecureMcpLaunchStore {
  constructor(private readonly options: StoreOptions) {
    if (!path.isAbsolute(options.root) || options.root.includes("\0")) {
      throw new Error("SECURE_MCP_LAUNCH_ROOT_NOT_ABSOLUTE");
    }
  }

  async write(contract: ReadonlyComputerLaunchContract): Promise<string> {
    await this.ensureRoot();
    const target = path.join(
      this.options.root,
      READONLY_COMPUTER_LAUNCH_BASENAME,
    );
    await this.assertReplaceableTarget(target);
    const serialized = serializeReadonlyComputerLaunchContract(contract);
    const temporary = path.join(
      this.options.root,
      `.${READONLY_COMPUTER_LAUNCH_BASENAME}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await fs.open(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          NO_FOLLOW |
          CLOSE_ON_EXEC,
        0o600,
      );
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
      await this.syncRoot();
      return target;
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.options.root);
    const effectiveUser = process.geteuid?.();
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (effectiveUser !== undefined && info.uid !== effectiveUser)
    ) {
      launchError("SECURE_MCP_LAUNCH_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await fs.chmod(this.options.root, 0o700);
  }

  private assertPrivateFile(info: Stats): void {
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (effectiveUser !== undefined && info.uid !== effectiveUser) ||
      (info.mode & 0o077) !== 0
    ) {
      launchError("SECURE_MCP_LAUNCH_UNSAFE");
    }
  }

  private async assertReplaceableTarget(target: string): Promise<void> {
    try {
      this.assertPrivateFile(await fs.lstat(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async syncRoot(): Promise<void> {
    const directory = await fs.open(
      this.options.root,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
