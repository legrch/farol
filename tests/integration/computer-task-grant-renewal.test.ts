import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
