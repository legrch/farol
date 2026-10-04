import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductSettingsStore } from "../../src/apps/desktop/product-configuration";
import { createSecureMcpLaunchContract } from "../../src/apps/desktop/secure-mcp-launch-contract";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract";
import { materializeReadonlyComputerLaunch } from "../../src/modules/computer/infra/mcp/launch-contract";
import { CurrentOwnerComputerApprovals } from "../../src/modules/computer/infra/repo/current-owner-computer-approvals";
import { RenewableComputerAuthority } from "../../src/modules/computer/infra/mcp/renewable-computer-authority";
import {
  renewingReadonlyComputerContract,
  renewingMutableComputerContract,
} from "../../src/modules/computer/infra/mcp/renewing-computer-contracts";
import { ReadonlyComputerContractHandler } from "../../src/modules/computer/infra/readonly-contract-handler";
import { MutableComputerContractHandler } from "../../src/modules/computer/infra/mutable-contract-handler";
import { RunReadonlyComputerAction } from "../../src/modules/computer/app/service/run-readonly-computer-action";
import { RunMutableComputerAction } from "../../src/modules/computer/app/service/run-mutable-computer-action";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import { InMemoryAuthorityRepository } from "../../src/modules/computer/infra/repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../../src/modules/computer/infra/repo/in-memory-computer-approvals";
import { PrivateWorkspaceMutationStore } from "../../src/modules/computer/infra/repo/private-workspace-mutation-store";
import { Sha256WorkspaceMutationDigester } from "../../src/modules/computer/infra/native/sha256-workspace-mutation-digester";
import type { ReadonlyWorkspace } from "../../src/modules/computer/app/port/readonly-workspace";
import type { MutableWorkspace } from "../../src/modules/computer/app/port/mutable-workspace";

// Real MCP framing and disposable owner configuration/journals. Workspace and
// process effects are ports here, not native or live ChatGPT qualification.
let root = "";
let now = 1_000;
let settings: ProductSettings;
const workspaceId = "00000000-0000-4000-8000-000000000002";
const clock = { now: () => now };
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

beforeEach(async () => {
  now = 1_000;
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-grant-renewal-")),
  );
  await fs.chmod(root, 0o700);
  const step = {
    visited: false,
    skipped: false,
    configured: false,
    reachable: "unknown",
    verified: null,
    needsAction: "Pending.",
    unavailable: null,
    outcomeUnknown: false,
  };
  settings = ProductSettingsSchema.parse({
    schema: 1,
    revision: 9,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: "00000000-0000-4000-8000-000000000001",
      generation: 7,
      name: "Fixture",
      commands: "none",
      workspaces: [
        {
          workspaceId,
          root: "/Users/example/brain",
          label: "Brain",
          access: "write",
          excludedPaths: [],
          rootIdentity: { device: "5", inode: "98" },
        },
      ],
    },
    setup: {
      chatgpt: step,
      computer: step,
      connect: step,
      hosts: step,
      verify: step,
    },
  });
  await save();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function save() {
  await fs.writeFile(path.join(root, "config.json"), JSON.stringify(settings), {
    mode: 0o600,
  });
}
function launch() {
  return createSecureMcpLaunchContract(settings, {
    now,
    runtimeId: "renewal-fixture",
    challengeSha256: "a".repeat(64),
    ownerSettingsRoot: root,
  });
}
function issuer(ceiling = launch(), grantLifetimeMs?: number) {
  if (ceiling.schema !== 2 || !ceiling.approvalSource)
    throw new Error("Fixture source missing");
  return new RenewableComputerAuthority(
    ceiling,
    new CurrentOwnerComputerApprovals(ceiling.approvalSource, clock.now),
    clock.now,
    grantLifetimeMs,
  );
}
const output = {
  ok: true as const,
  value: {
    kind: "workspace.text" as const,
    text: "fixture",
    bytes: 7,
    sha256: digest("fixture"),
  },
};
function readonly(
  authority: RenewableComputerAuthority,
  execute = vi.fn(async () => output),
) {
  return {
    execute,
    contract: renewingReadonlyComputerContract(
      new ReadonlyComputerContractHandler(
        new RunReadonlyComputerAction(
          authority,
          authority.approvals,
          { execute } as ReadonlyWorkspace,
          clock,
        ),
      ),
      authority,
    ),
  };
}
function request(
  binding: ReturnType<typeof materializeReadonlyComputerLaunch>["binding"],
) {
  return {
    ...binding,
    callId: "call-1",
    workspaceId,
    operation: { kind: "workspace.read" as const, relativePath: "README.md" },
  };
}

describe("production Computer TaskGrant reissue", () => {
  function raceOwnerSave(
    phase: "before-stat" | "after-read",
    replacements: number,
    change = () => {},
  ) {
    const open = fs.open.bind(fs);
    const store = new ProductSettingsStore({ root });
    let saves = 0;
    const replace = async () => {
      if (saves >= replacements) return;
      saves++;
      change();
      await store.save(settings);
    };
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (
        args[0] === path.join(root, "config.json") &&
        args[1] === (constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      ) {
        if (phase === "before-stat") await replace();
        else {
          const read = handle.readFile.bind(handle);
          vi.spyOn(handle, "readFile").mockImplementationOnce(
            async (options) => {
              const text = await read(options);
              await replace();
              return text;
            },
          );
        }
      }
      return handle;
    });
    return () => saves;
  }

  it.each(["before-stat", "after-read"] as const)(
    "accepts a stable current approval after an atomic owner save at %s without redispatch",
    async (phase) => {
      const ceiling = launch();
      const binding = materializeReadonlyComputerLaunch(ceiling, now).binding;
      const current = readonly(issuer(ceiling));
      const saves = raceOwnerSave(phase, 1, () => settings.revision++);
      expect((await current.contract.execute(request(binding))).ok).toBe(true);
      expect(saves()).toBe(1);
      expect(current.execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["generation", "revoked", "additional-root"])(
    "uses the latest %s policy when atomic replacement races a snapshot read",
    async (change) => {
      const ceiling = launch();
      const binding = materializeReadonlyComputerLaunch(ceiling, now).binding;
      const current = readonly(issuer(ceiling));
      const saves = raceOwnerSave("after-read", 1, () => {
        if (change === "generation") settings.computer.generation++;
        if (change === "revoked") settings.computer.workspaces = [];
        if (change === "additional-root")
          settings.computer.workspaces.push({
            ...settings.computer.workspaces[0]!,
            workspaceId: "00000000-0000-4000-8000-000000000003",
            root: "/Users/example/code",
          });
      });
      expect(await current.contract.execute(request(binding))).toMatchObject({
        ok: false,
        error: { code: "AUTHORITY_COMPUTER_MISMATCH", retry: "never" },
      });
      expect(saves()).toBe(1);
      expect(current.execute).not.toHaveBeenCalled();
    },
  );

  it("bounds snapshot reads and fails closed on continuous atomic replacement", async () => {
    const ceiling = launch();
    const binding = materializeReadonlyComputerLaunch(ceiling, now).binding;
    const current = readonly(issuer(ceiling));
    const saves = raceOwnerSave("after-read", 10, () => settings.revision++);
    expect(await current.contract.execute(request(binding))).toMatchObject({
      ok: false,
      error: { code: "COMPUTER_APPROVAL_STORE_UNAVAILABLE", retry: "never" },
    });
    expect(saves()).toBe(3);
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("reproduces the startup snapshot expiry and reissues on the same MCP connection and after reconnect", async () => {
    const ceiling = launch();
    const old = materializeReadonlyComputerLaunch(ceiling, now);
    const execute = vi.fn(async () => output);
    const oldContract = new ReadonlyComputerContractHandler(
      new RunReadonlyComputerAction(
        new InMemoryAuthorityRepository(old.participants),
        new InMemoryComputerApprovalRepository([old.approval]),
        { execute },
        clock,
      ),
    );
    expect((await oldContract.execute(request(old.binding))).ok).toBe(true);
    now = old.approval.expiresAt + 1;
    expect(await oldContract.execute(request(old.binding))).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_EXPIRED", retry: "never" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const authority = issuer(ceiling);
    const current = readonly(authority);
    const server = createReadonlyComputerMcpServer(
      current.contract,
      old.binding,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      old.workspaceCatalogueIds,
    );
    const client = new Client({
      name: "grant-renewal-fixture",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      expect(
        (
          await client.callTool({
            name: "computer_workspace_read",
            arguments: { workspaceId, relativePath: "README.md" },
          })
        ).isError,
      ).not.toBe(true);
      now += 13 * 60 * 60 * 1_000;
      expect(
        (
          await client.callTool({
            name: "computer_workspace_read",
            arguments: { workspaceId, relativePath: "README.md" },
          })
        ).isError,
      ).not.toBe(true);
      expect(current.execute).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
      await server.close();
    }
    const restarted = readonly(issuer(ceiling));
    expect((await restarted.contract.execute(request(old.binding))).ok).toBe(
      true,
    );
    expect(restarted.execute).toHaveBeenCalledTimes(1);
  });

  it("preserves the generation refusal correlation through actual MCP framing", async () => {
    const ceiling = launch();
    const initial = materializeReadonlyComputerLaunch(ceiling, now);
    const current = readonly(issuer(ceiling));
    const server = createReadonlyComputerMcpServer(
      current.contract,
      initial.binding,
    );
    const client = new Client({
      name: "revocation-correlation-fixture",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      settings.computer.generation++;
      await save();
      const result = await client.callTool({
        name: "computer_workspace_read",
        arguments: { workspaceId, relativePath: "README.md" },
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          correlation: {
            workspaceId,
            relativePath: "README.md",
            taskId: initial.binding.taskId,
          },
          error: {
            code: "AUTHORITY_COMPUTER_MISMATCH",
            source: "computer-policy",
            retry: "never",
          },
        },
      });
      expect(current.execute).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects malformed calls before reading owner policy and retains typed expiry and missing-policy errors", async () => {
    const ceiling = launch();
    const binding = materializeReadonlyComputerLaunch(ceiling, now).binding;
    const authority = issuer(ceiling);
    const admission = vi.spyOn(authority, "admitExecution");
    const current = readonly(authority);
    expect(await current.contract.execute({})).toMatchObject({
      ok: false,
      correlation: null,
      error: { code: "COMPUTER_INVALID_REQUEST" },
    });
    expect(admission).not.toHaveBeenCalled();
    admission.mockRejectedValueOnce(new Error("AUTHORITY_EXPIRED"));
    expect(await current.contract.execute(request(binding))).toMatchObject({
      ok: false,
      correlation: { callId: "call-1" },
      error: { code: "AUTHORITY_EXPIRED", source: "task-admission" },
    });
    admission.mockRejectedValueOnce(new Error("COMPUTER_APPROVAL_NOT_FOUND"));
    expect(await current.contract.execute(request(binding))).toMatchObject({
      ok: false,
      correlation: { callId: "call-1" },
      error: { code: "COMPUTER_APPROVAL_NOT_FOUND", source: "computer-policy" },
    });
    admission.mockRejectedValueOnce("untrusted failure");
    expect(await current.contract.execute(request(binding))).toMatchObject({
      ok: false,
      correlation: { callId: "call-1" },
      error: {
        code: "COMPUTER_APPROVAL_STORE_UNAVAILABLE",
        source: "authority-store",
      },
    });
  });

  it.each([false, true])(
    "reissues identical Git workspace policy with history approval=%s regardless of object key order",
    async (gitHistoryApproved) => {
      const workspace = settings.computer.workspaces[0]!;
      workspace.gitMetadata = {
        gitDirectory: "/Users/example/brain/.git",
        commonDirectory: "/Users/example/brain/.git",
      };
      workspace.gitHistoryApproved = gitHistoryApproved;
      await save();
      const ceiling = launch();
      const current = readonly(issuer(ceiling));
      now = ceiling.admission.expiresAt + 1;
      expect(
        (
          await current.contract.execute(
            request(materializeReadonlyComputerLaunch(ceiling, 1_000).binding),
          )
        ).ok,
      ).toBe(true);
      expect(current.execute).toHaveBeenCalledTimes(1);
      workspace.gitMetadata.commonDirectory = "/Users/example/foreign/.git";
      await save();
      expect(
        await current.contract.execute(
          request(materializeReadonlyComputerLaunch(ceiling, 1_000).binding),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "AUTHORITY_COMPUTER_MISMATCH", retry: "never" },
      });
      expect(current.execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "generation",
    "connector-generation",
    "root",
    "root-identity",
    "capability",
    "additional-root",
    "exclusion",
  ])(
    "current %s changes defeat cached renewal before native work",
    async (change) => {
      const ceiling = launch();
      const binding = materializeReadonlyComputerLaunch(ceiling, now).binding;
      const current = readonly(issuer(ceiling));
      expect((await current.contract.execute(request(binding))).ok).toBe(true);
      now = ceiling.admission.expiresAt + 1;
      if (change === "generation") settings.computer.generation++;
      if (change === "connector-generation")
        settings.connectors.secureMcp.generation++;
      if (change === "root")
        settings.computer.workspaces[0]!.root = "/Users/example/code";
      if (change === "root-identity")
        settings.computer.workspaces[0]!.rootIdentity!.inode = "99";
      if (change === "capability")
        settings.computer.workspaces[0]!.access = "read";
      if (change === "additional-root")
        settings.computer.workspaces.push({
          ...settings.computer.workspaces[0]!,
          workspaceId: "00000000-0000-4000-8000-000000000003",
          root: "/Users/example/code",
        });
      if (change === "exclusion")
        settings.computer.workspaces[0]!.excludedPaths.push(
          "/Users/example/brain/README.md",
        );
      await save();
      expect(await current.contract.execute(request(binding))).toMatchObject({
        ok: false,
        error: { retry: "never" },
      });
      expect(current.execute).toHaveBeenCalledTimes(1);
      expect(
        await readonly(issuer(ceiling)).contract.execute(request(binding)),
      ).toMatchObject({ ok: false });
    },
  );

  it.each(["git.status", "git.head"] as const)(
    "keeps a multi-step %s verification lease past one native file timeout",
    async (command) => {
      settings.computer.commands = "verification";
      await save();
      const ceiling = launch();
      const binding = materializeReadonlyComputerLaunch(ceiling, now).binding;
      const authority = issuer(ceiling, 100);
      const native: ReadonlyWorkspace = {
        async execute() {
          // Composite verification can outlive a 15 s snapshot step while
          // every native sub-step stays within its own timeout. This is a
          // clock-controlled port fixture, not native Git timing evidence.
          now += 16_000;
          return {
            ok: true,
            value: {
              kind: "workspace.command",
              command,
              relativePath: ".",
              exitCode: 0,
              stdout: "",
              stderr: "",
              outputBytes: 0,
              network: "none",
              coverage:
                command === "git.status" ? "tracked-files-only" : "head-commit",
              layout: "primary",
            },
          };
        },
      };
      const contract = renewingReadonlyComputerContract(
        new ReadonlyComputerContractHandler(
          new RunReadonlyComputerAction(
            authority,
            authority.approvals,
            native,
            clock,
          ),
        ),
        authority,
      );
      expect(
        await contract.execute({
          ...request(binding),
          operation: { kind: "verification.run", command, relativePath: "." },
        }),
      ).toMatchObject({ ok: true });
    },
  );

  it.each(["lease-expired", "revoked"] as const)(
    "still refuses a composite verification result after %s",
    async (change) => {
      settings.computer.commands = "verification";
      await save();
      const ceiling = launch();
      const binding = materializeReadonlyComputerLaunch(ceiling, now).binding;
      const authority = issuer(ceiling);
      const native: ReadonlyWorkspace = {
        async execute() {
          now += change === "lease-expired" ? 120_001 : 16_000;
          if (change === "revoked") {
            settings.computer.generation++;
            await save();
          }
          return {
            ok: true,
            value: {
              kind: "workspace.command",
              command: "git.status",
              relativePath: ".",
              exitCode: 0,
              stdout: "",
              stderr: "",
              outputBytes: 0,
              network: "none",
              coverage: "tracked-files-only",
              layout: "primary",
            },
          };
        },
      };
      const contract = renewingReadonlyComputerContract(
        new ReadonlyComputerContractHandler(
          new RunReadonlyComputerAction(
            authority,
            authority.approvals,
            native,
            clock,
          ),
        ),
        authority,
      );
      expect(
        await contract.execute({
          ...request(binding),
          operation: {
            kind: "verification.run",
            command: "git.status",
            relativePath: ".",
          },
        }),
      ).toMatchObject({ ok: false, error: { retry: "never" } });
    },
  );

  it("keeps already admitted read leases independent of outer TTL and other renewal", async () => {
    const ceiling = launch();
    const authority = issuer(ceiling, 100);
    const execution = await authority.admitExecution(15_000);
    const originalDeadline = execution.deadlineAt;
    const action = new RunReadonlyComputerAction(
      authority,
      authority.approvals,
      {
        async execute() {
          now += 101;
          const next = await authority.admitExecution(15_000);
          expect(next.deadlineAt).toBeGreaterThan(originalDeadline);
          return output;
        },
      },
      clock,
    );
    expect(
      (
        await authority.run(execution, () =>
          action.execute(
            request(materializeReadonlyComputerLaunch(ceiling, 1_000).binding),
          ),
        )
      ).ok,
    ).toBe(true);
    expect(execution.deadlineAt).toBe(originalDeadline);
    expect(execution.participant.grant.expiresAt).toBe(originalDeadline);
    now = originalDeadline + 1;
    expect(await execution.current()).toBe(false);
  });

  it.each(["generation", "revoked", "lease-expired"])(
    "does not disclose an admitted read after %s while its native port yielded",
    async (change) => {
      const ceiling = launch();
      const binding = materializeReadonlyComputerLaunch(ceiling, now).binding;
      const current = readonly(
        issuer(ceiling),
        vi.fn(async () => {
          if (change === "generation") settings.computer.generation++;
          if (change === "revoked") settings.computer.workspaces = [];
          if (change === "lease-expired") now += 15_001;
          await save();
          return output;
        }),
      );
      expect(await current.contract.execute(request(binding))).toMatchObject({
        ok: false,
        error: { retry: "never" },
      });
      expect(current.execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["subtree-exclusion", "git-binding"] as const)(
    "does not disclose a pending result after same-generation %s changes",
    async (change) => {
      const workspace = settings.computer.workspaces[0]!;
      settings.computer.commands = "verification";
      workspace.gitHistoryApproved = true;
      workspace.gitMetadata = {
        gitDirectory: path.join(workspace.root, ".git"),
        commonDirectory: path.join(workspace.root, ".git"),
      };
      await save();
      const ceiling = launch();
      const binding = materializeReadonlyComputerLaunch(ceiling, now).binding;
      const authority = issuer(ceiling);
      const execute = vi.fn<ReadonlyWorkspace["execute"]>(async () => {
        if (change === "subtree-exclusion") {
          workspace.excludedPaths = [path.join(workspace.root, "private")];
          await save();
          return {
            ok: true,
            value: {
              kind: "workspace.matches",
              matches: [
                {
                  path: "private/note.md",
                  line: 1,
                  text: "withheld",
                  truncated: false,
                },
              ],
              resultLimited: false,
              scanLimited: false,
            },
          };
        }
        // Normal Go-composed settings now advance generation on this change.
        // Model an older/external writer retaining the generation so the MCP
        // boundary still has to compare the whole policy before disclosure.
        workspace.gitMetadata = {
          gitDirectory: "/Users/example/other/.git/worktrees/brain",
          commonDirectory: "/Users/example/other/.git",
        };
        workspace.gitHistoryApproved = false;
        await save();
        return {
          ok: true,
          value: {
            kind: "workspace.command",
            command: "git.head",
            relativePath: ".",
            exitCode: 0,
            stdout: "withheld",
            stderr: "",
            outputBytes: 8,
            network: "none",
            coverage: "head-commit",
            layout: "primary",
          },
        };
      });
      const contract = renewingReadonlyComputerContract(
        new ReadonlyComputerContractHandler(
          new RunReadonlyComputerAction(
            authority,
            authority.approvals,
            { execute },
            clock,
          ),
        ),
        authority,
      );
      const operation =
        change === "subtree-exclusion"
          ? {
              kind: "workspace.search" as const,
              relativePath: ".",
              pattern: "withheld",
            }
          : {
              kind: "verification.run" as const,
              command: "git.head" as const,
              relativePath: "." as const,
            };
      const call = { ...request(binding), operation };
      const result = await contract.execute(call);
      expect(result).toMatchObject({
        ok: false,
        correlation: { callId: call.callId, workspaceId, operation },
        error: {
          code: "AUTHORITY_COMPUTER_MISMATCH",
          source: "computer-policy",
          retry: "never",
        },
      });
      expect(JSON.stringify(result)).not.toContain("private/note.md");
      expect(result).not.toHaveProperty("value");
      expect(
        await contract.execute({ ...call, callId: "next-call" }),
      ).toMatchObject({
        ok: false,
        error: { code: "AUTHORITY_COMPUTER_MISMATCH", retry: "never" },
      });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["unavailable", "cancelled"] as const)(
    "withholds output when the final policy read is %s without redispatch",
    async (change) => {
      const ceiling = launch();
      const binding = materializeReadonlyComputerLaunch(ceiling, now).binding;
      const authority = issuer(ceiling);
      const current = readonly(authority);
      const controller = new AbortController();
      const get = authority.approvals.get.bind(authority.approvals);
      let reads = 0;
      vi.spyOn(authority.approvals, "get").mockImplementation(async (id) => {
        reads++;
        if (reads === 4) {
          if (change === "unavailable") throw new Error("source unavailable");
          controller.abort();
        }
        return get(id);
      });
      const result = await current.contract.execute(request(binding), {
        signal: controller.signal,
      });
      expect(result).toMatchObject({
        ok: false,
        correlation: { callId: "call-1", workspaceId },
        error: {
          code:
            change === "unavailable"
              ? "COMPUTER_APPROVAL_STORE_UNAVAILABLE"
              : "WORKSPACE_REQUEST_CANCELLED",
          retry: "never",
        },
      });
      expect(result).not.toHaveProperty("value");
      expect(current.execute).toHaveBeenCalledTimes(1);
      expect(reads).toBe(4);
    },
  );

  it.each(["missing", "symlink", "public", "malformed"])(
    "fails closed on %s owner configuration without using cached approvals",
    async (change) => {
      const authority = issuer();
      const file = path.join(root, "config.json");
      if (change === "missing") await fs.rm(file);
      if (change === "symlink") {
        await fs.rename(file, path.join(root, "target.json"));
        await fs.symlink("target.json", file);
      }
      if (change === "public") await fs.chmod(file, 0o644);
      if (change === "malformed") await fs.writeFile(file, "{}");
      await expect(authority.admitExecution(15_000)).rejects.toThrow();
    },
  );

  it("does not let overlapping renewal contexts replace or extend the first execution", async () => {
    const authority = issuer(launch(), 100);
    const first = await authority.admitExecution(1_000);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = authority.run(first, async () => {
      entered();
      await gate;
      return authority.get(first.participant.participantId);
    });
    await reached;
    now += 1_001;
    const second = await authority.admitExecution(2_000);
    const later = await authority.run(second, () =>
      authority.get(second.participant.participantId),
    );
    release();
    expect((await original)!.grant.expiresAt).toBe(first.deadlineAt);
    expect(later!.grant.expiresAt).toBe(second.deadlineAt);
    expect(await first.current()).toBe(false);
    expect(await second.current()).toBe(true);
    expect(await authority.get("foreign")).toBeNull();
    await expect(authority.admit(first.participant)).rejects.toThrow(
      "COMPUTER_PARTICIPANT_ADMISSION_DENIED",
    );
    expect(
      await authority.run(second, () => authority.admit(second.participant)),
    ).toMatchObject({ status: "existing" });
  });

  it.each([
    "empty",
    "oversize",
    "hard-link",
    "unsafe-directory",
    "foreign-computer",
  ])("refuses %s current approval source", async (change) => {
    const authority = issuer();
    const file = path.join(root, "config.json");
    if (change === "empty") await fs.writeFile(file, "");
    if (change === "oversize")
      await fs.writeFile(file, " ".repeat(256 * 1024 + 1));
    if (change === "hard-link")
      await fs.link(file, path.join(root, "linked.json"));
    if (change === "unsafe-directory") await fs.chmod(root, 0o755);
    if (change === "foreign-computer") {
      settings.computer.computerId = "00000000-0000-4000-8000-000000000009";
      await save();
    }
    await expect(authority.admitExecution(15_000)).rejects.toThrow();
  });

  it("correlates mutation admission refusal without echoing write content or dispatching an effect", async () => {
    const ceiling = launch();
    const binding = materializeReadonlyComputerLaunch(ceiling, now).binding;
    const authority = issuer(ceiling);
    const mutate = vi.fn<MutableWorkspace["mutate"]>(async () => ({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", retry: "never" },
    }));
    const contract = renewingMutableComputerContract(
      new MutableComputerContractHandler(
        new RunMutableComputerAction(
          authority,
          authority.approvals,
          new PrivateWorkspaceMutationStore({
            root: path.join(root, "journal"),
          }),
          new Sha256WorkspaceMutationDigester(),
          { mutate },
          clock,
        ),
      ),
      authority,
    );
    expect(await contract.execute({})).toMatchObject({
      ok: false,
      correlation: null,
      error: { code: "COMPUTER_INVALID_REQUEST" },
    });
    settings.computer.generation++;
    await save();
    const result = await contract.execute({
      ...binding,
      callId: "mutation-refused",
      operationId: "effect-not-admitted",
      workspaceId,
      operation: {
        kind: "workspace.write",
        relativePath: "README.md",
        content: "must not echo this content",
        expectedSha256: digest("before"),
      },
    });
    expect(result).toMatchObject({
      ok: false,
      correlation: {
        callId: "mutation-refused",
        operationId: "effect-not-admitted",
        operation: { kind: "workspace.write", relativePath: "README.md" },
      },
      error: {
        code: "AUTHORITY_COMPUTER_MISMATCH",
        source: "computer-policy",
        retry: "never",
      },
    });
    expect(JSON.stringify(result)).not.toContain("must not echo this content");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("retains a possible mutation effect across expiry, renewal and process restart", async () => {
    const ceiling = launch();
    const binding = materializeReadonlyComputerLaunch(ceiling, now).binding;
    const mutate = vi.fn<MutableWorkspace["mutate"]>(async () => ({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", retry: "never" },
    }));
    const makeContract = () => {
      const authority = issuer(ceiling);
      return renewingMutableComputerContract(
        new MutableComputerContractHandler(
          new RunMutableComputerAction(
            authority,
            authority.approvals,
            new PrivateWorkspaceMutationStore({
              root: path.join(root, "journal"),
            }),
            new Sha256WorkspaceMutationDigester(),
            { mutate },
            clock,
          ),
        ),
        authority,
      );
    };
    const mutation = {
      ...binding,
      callId: "call-1",
      operationId: "same-effect",
      workspaceId,
      operation: {
        kind: "workspace.write",
        relativePath: "README.md",
        content: "after",
        expectedSha256: digest("before"),
      },
    };
    const first = makeContract();
    expect(await first.execute(mutation)).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", retry: "never" },
    });
    now = ceiling.admission.expiresAt + 1;
    expect(
      await makeContract().execute({ ...mutation, callId: "later-call" }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", retry: "never" },
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
