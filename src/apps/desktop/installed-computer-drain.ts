import type { HandoffStatusResult } from "../../modules/chat/app/service/persistent-codex-handoff";
import path from "node:path";
import { PersistentCodexHandoff } from "../../modules/chat/app/service/persistent-codex-handoff";
import { PrivateCodexHandoffJournal } from "../../modules/chat/infra/repo/private-codex-handoff-journal";
import { PhysicalCodexHandoffAuthority } from "../../modules/chat/infra/native/physical-codex-handoff-authority";
import { SharedCodexProxyHost } from "../../modules/chat/infra/native/shared-codex-proxy-host";
import { Sha256HandoffRequestDigester } from "../../modules/chat/infra/native/sha256-handoff-request-digester";
import { PrivateWorkspaceMutationStore } from "../../modules/computer/infra/repo/private-workspace-mutation-store";
import { PrivateExecutionFence } from "../../modules/computer/infra/mcp/execution-fence";
import type { ProductSettings } from "../../pkg/product-settings/contract";
import { selectedCodexTaskRouteLaunch } from "./secure-mcp-launch-contract";

export type ComputerUpdateDrainResult =
  Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>;

export type ComputerUpdateDrainPorts = Readonly<{
  routeConfigured: boolean;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  desktopWorkSettled(): Promise<boolean>;
  mutationsSettled(): Promise<boolean>;
  taskKeys(): Promise<readonly string[]>;
  openTaskReader(): Promise<
    Readonly<{
      status(key: string): Promise<HandoffStatusResult>;
      close(): Promise<boolean>;
    }>
  >;
  stillCurrent(): boolean;
  stopOwnedClients(): Promise<void>;
}>;

/** Called only after Desktop has reserved its configuration and task admission. */
export async function drainInstalledComputerWork(
  ports: ComputerUpdateDrainPorts,
): Promise<ComputerUpdateDrainResult> {
  try {
    return await ports.exclusive(async () => {
      if (!(await ports.desktopWorkSettled()))
        return { ok: false, code: "UPDATE_WORK_PENDING" };
      if (!(await ports.mutationsSettled()))
        return { ok: false, code: "UPDATE_WORK_PENDING" };
      const keys = await ports.taskKeys();
      if (keys.length > 0) {
        if (!ports.routeConfigured)
          return { ok: false, code: "UPDATE_TASK_ROUTE_NEEDS_DRAIN" };
        let idle = true;
        const reader = await ports.openTaskReader();
        try {
          for (const key of keys) {
            const result = await reader.status(key);
            if (
              result.status !== "known" ||
              !["completed", "failed", "interrupted"].includes(
                result.turnStatus,
              ) ||
              result.threadRuntime.state !== "idle"
            ) {
              idle = false;
              break;
            }
          }
        } finally {
          if (!(await reader.close())) idle = false;
        }
        if (!idle) return { ok: false, code: "UPDATE_TASK_ROUTE_NEEDS_DRAIN" };
      }
      if (!ports.stillCurrent())
        return { ok: false, code: "UPDATE_STATE_UNREADABLE" };
      // Stop even when the tunnel looks idle: an owned MCP/proxy can outlive it.
      await ports.stopOwnedClients();
      return { ok: true };
    });
  } catch {
    return { ok: false, code: "UPDATE_WORK_DRAIN_UNCONFIRMED" };
  }
}

export async function drainInstalledComputer(
  input: Readonly<{
    root: string;
    settings: ProductSettings;
    desktopWorkSettled(): Promise<boolean>;
    stillCurrent(): boolean;
    stopOwnedClients(): Promise<void>;
  }>,
): Promise<ComputerUpdateDrainResult> {
  const fence = new PrivateExecutionFence({ root: input.root });
  const journal = new PrivateCodexHandoffJournal(
    path.join(input.root, "codex-task-journal"),
  );
  const mutations = new PrivateWorkspaceMutationStore({ root: input.root });
  return drainInstalledComputerWork({
    routeConfigured: input.settings.nativeHosts.taskRoute !== null,
    exclusive: (work) => fence.withUpdateDrain(work),
    desktopWorkSettled: input.desktopWorkSettled,
    mutationsSettled: () => mutations.settledForUpdate(),
    taskKeys: () => journal.updateTaskKeys(),
    stillCurrent: input.stillCurrent,
    stopOwnedClients: input.stopOwnedClients,
    openTaskReader: async () => {
      const route = selectedCodexTaskRouteLaunch(input.settings, Date.now());
      if (!route) throw new Error("UPDATE_TASK_ROUTE_NEEDS_DRAIN");
      const authority = new PhysicalCodexHandoffAuthority(route.grant);
      const host = await SharedCodexProxyHost.attach({
        ...route.host,
        cwd: input.root,
      });
      const deadlineAt = Math.min(Date.now() + 20_000, route.grant.expiresAt);
      const handoff = new PersistentCodexHandoff(
        authority,
        host,
        journal,
        new Sha256HandoffRequestDigester(),
        route.grant.expiresAt,
        {
          run: async () => {
            throw new Error("UPDATE_TASK_MUTATION_FORBIDDEN");
          },
        },
        Date.now,
        route.grant.observeThreadId,
      );
      return {
        status: (key) => handoff.status(key, { deadlineAt }),
        close: () => host.closeAndWait(),
      };
    },
  });
}
