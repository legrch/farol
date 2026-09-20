import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ChatGptReadonlyTaskResult,
  ChatGptTaskObserver,
} from "../../src/apps/desktop/chatgpt-route";
import { createCodexContextController } from "../../src/apps/desktop/codex-context-runtime";
import {
  LiveTaskRegistry,
  PromotionLeaseLost,
  type PromotionLeaseGuard,
} from "../../src/apps/desktop/live-task-registry";
import {
  acquirePromotionLease,
  promotionLeasePath,
  releasePromotionLease,
  verifyPromotionLease,
} from "../../src/apps/desktop/promotion-lease";
import {
  PrivateProviderTurnJournal,
  type ProviderTurnJournal,
} from "../../src/apps/desktop/provider-turn-journal";
import {
  startRouteBRuntime,
  type RouteBRuntime,
} from "../../src/apps/desktop/route-b-runtime";
import {
  createRouteBTaskLifecycle,
  type RouteBTaskLifecycle,
  type TaskContextDeletion,
} from "../../src/apps/desktop/route-b-task-lifecycle";
import { deleteTaskContext } from "../../src/apps/desktop/task-context-cleanup";
import type {
  ProductTask,
  ProductTasksState,
} from "../../src/modules/chat/contract/product-task";
import {
  createContextSession,
  type ContextBinding,
} from "../../src/modules/chat/domain/context-continuity";

const leaseChildScript = fileURLToPath(
  new URL("./fixtures/promotion-lease-child.mjs", import.meta.url),
);

const threadA = "0199c0de-0000-7000-8000-00000000c001";
const threadB = "0199c0de-0000-7000-8000-00000000c002";

// One task's ChatGPT conversation surface, as the product's route exposes it
// to a Route B turn: it answers, and it can be disposed exactly once.
class TaskSurface {
  readonly prompts: string[] = [];
  disposed = 0;

  async runReadonlyTask(
    prompt: string,
    _attachments: readonly [],
    observer: ChatGptTaskObserver,
  ): Promise<ChatGptReadonlyTaskResult> {
    if (this.disposed > 0) throw new Error("SURFACE_DISPOSED");
    this.prompts.push(prompt);
    const text = `Answer ${this.prompts.length}.`;
    await observer.onTextDelta?.({
      sequence: 1,
      delta: text,
      text,
      observedCharacters: text.length,
    });
    return {
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: text.length,
      outputText: text,
    };
  }

  dispose(): void {
    this.disposed += 1;
  }
}

function productTask(threadId: string, label: string): ProductTask {
  return {
    taskId: threadId,
    sessionId: threadId,
    turnId: randomUUID(),
    label,
    provider: "chatgpt",
    requestedModel: "Account default",
    observedModel: null,
    requestedMode: "Account default",
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle: "running",
  };
}

function binding(taskId: string): ContextBinding {
  return {
    ownerId: "owner-desktop",
    taskId,
    hostThreadId: taskId,
    sessionId: taskId,
    providerProfileId: "profile-isolated-next",
    modelId: "farol-next/mind",
    mode: "mind",
  };
}

function initialRequest(threadId: string, turnId: string, text: string) {
  return {
    model: "farol-next/mind",
    stream: true,
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    ],
    tools: [],
    client_metadata: {
      session_id: threadId,
      thread_id: threadId,
      turn_id: turnId,
      root_turn_id: turnId,
    },
  };
}

// A named barrier: the gated operation reports that it was reached and then
// waits until the test releases it.
function gate() {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    open: () => reach(),
    wait: () => opened,
  };
}

describe("Route B task lifecycle composed as the product composes it", () => {
  const roots: string[] = [];
  const leaseHolders: ReturnType<typeof spawn>[] = [];
  let runtime: RouteBRuntime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    await Promise.all(
      leaseHolders.splice(0).map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            child.once("close", () => resolve());
            child.kill("SIGKILL");
          }),
      ),
    );
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function compose(
    hooks: Readonly<{
      // Stops the durable admission of each request of this thread in turn,
      // one gate per request, until the gates run out.
      admission?: Readonly<{
        threadId: string;
        gates: ReturnType<typeof gate>[];
      }>;
      // Stops a close of this task after it has begun.
      removal?: Readonly<{ taskId: string; gate: ReturnType<typeof gate> }>;
      // Forces the outcome of this task's private context deletions, one
      // outcome per deletion, until the outcomes run out.
      contextDeletion?: Readonly<{
        taskId: string;
        outcomes: TaskContextDeletion[];
      }>;
      // Refuses `markRunning` for these tasks, as the product does while a
      // live promotion holds the cross-process lease.
      markRunningRefused?: Set<string>;
      // S35-H1-1: runs `markRunning` through the registry's real
      // `withPromotionLease` under this guard, in the exact shape
      // `main.ts`'s `markLiveTaskRunningDurable` uses — the running mark,
      // then the fence, then the durable persist — so a lease lost between
      // the entry check and that persist is observable end to end.
      markRunningLease?: PromotionLeaseGuard;
    }> = {},
  ) {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-task-lifecycle-")),
    );
    roots.push(root);
    const controller = createCodexContextController({
      ownerId: "owner-desktop",
      providerProfileId: "profile-isolated-next",
      stateRoot: path.join(root, "context-continuity"),
      summaryRoutes: { retained: () => null, createFallback: vi.fn() },
    });
    const registry = new LiveTaskRegistry(5, hooks.markRunningLease);
    const routes = new Map<string, TaskSurface>();
    const persist = vi.fn(async () => undefined);
    const agentInputRemovals: string[] = [];
    const admitTask = vi.fn(async (threadId: string) => {
      const admitted = registry.admit(
        productTask(threadId, `Codex task ${routes.size + 1}`),
      );
      if (admitted.status !== "admitted") {
        return { ok: false as const, code: "TASK_CAPACITY_REACHED" };
      }
      const surface = new TaskSurface();
      routes.set(threadId, surface);
      return { ok: true as const, surface };
    });
    const journal = new PrivateProviderTurnJournal({
      root: path.join(root, "provider-turns"),
    });
    const gatedJournal: ProviderTurnJournal = {
      admit: async (key, intentSha256) => {
        const next =
          hooks.admission && key.includes(hooks.admission.threadId)
            ? hooks.admission.gates.shift()
            : undefined;
        if (next) {
          next.open();
          await next.wait();
        }
        return journal.admit(key, intentSha256);
      },
      release: (key) => journal.release(key),
    };
    let route: RouteBRuntime | null = null;
    const lifecycle: RouteBTaskLifecycle =
      createRouteBTaskLifecycle<ProductTasksState>({
        owns: (taskId) => route?.owns(taskId) ?? false,
        existingSurface: (taskId) => routes.get(taskId) ?? null,
        liveTask: (taskId) => registry.get(taskId) !== null,
        markRunning: async (taskId) => {
          if (hooks.markRunningRefused?.has(taskId)) return false;
          if (!hooks.markRunningLease) {
            registry.setLifecycle(taskId, "running");
            return true;
          }
          const before = registry.snapshot();
          const outcome = await registry.withPromotionLease(async (fence) => {
            if (!registry.setLifecycle(taskId, "running")) return;
            try {
              await fence();
              await persist();
            } catch (error) {
              if (error instanceof PromotionLeaseLost) {
                registry.rollback(before);
                throw error;
              }
            }
          });
          return outcome.ok;
        },
        mutationInFlight: () => false,
        admissionReady: () => true,
        admitTask,
        removeAgentInput: async (taskId) => {
          // The gate pauses a close inside its cleanup; the residue removal
          // an admission performs passes through.
          if (
            hooks.removal &&
            hooks.removal.taskId === taskId &&
            lifecycle.closing(taskId)
          ) {
            hooks.removal.gate.open();
            await hooks.removal.gate.wait();
          }
          agentInputRemovals.push(taskId);
        },
        snapshotTasks: () => registry.snapshot(),
        removeTask: (taskId) => registry.remove(taskId) !== null,
        rollbackTasks: (snapshot) => registry.rollback(snapshot),
        persist,
        deleteContext: async (taskId) => {
          const forced =
            hooks.contextDeletion?.taskId === taskId
              ? hooks.contextDeletion.outcomes.shift()
              : undefined;
          if (forced) return forced;
          return deleteTaskContext(controller.store, binding(taskId));
        },
        disposeRoute: (taskId) => {
          const surface = routes.get(taskId);
          routes.delete(taskId);
          surface?.dispose();
        },
      });
    route = await startRouteBRuntime({
      stateRoot: root,
      surfaces: {
        surfaceFor: (threadId) => lifecycle.surfaceFor(threadId),
        settled: (threadId, state) => {
          registry.setLifecycle(
            threadId,
            state === "outcome_unknown" ? "outcome_unknown" : "idle",
          );
        },
      },
      compaction: controller.continuity,
      journal: gatedJournal,
    });
    runtime = route;
    return {
      controller,
      registry,
      routes,
      admitTask,
      lifecycle,
      route,
      persist,
      agentInputRemovals,
    };
  }

  function post(route: RouteBRuntime, body: unknown) {
    return fetch(`${route.endpoint.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${route.endpoint.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("HR-007 keeps a task owned from its turn's preparation through durable admission, so a close waits and nothing is resurrected", async () => {
    const firstAdmission = gate();
    const admission = gate();
    const { controller, registry, routes, admitTask, lifecycle, route } =
      await compose({
        admission: { threadId: threadA, gates: [firstAdmission, admission] },
      });

    // A first turn admits the task; its gate is released at once.
    const first = post(route, initialRequest(threadA, "turn-a-1", "Start A."));
    await firstAdmission.reached;
    firstAdmission.release();
    expect(await (await first).text()).toContain("response.completed");
    expect(admitTask).toHaveBeenCalledTimes(1);
    const surfaceA = routes.get(threadA)!;
    await controller.store.save(createContextSession(binding(threadA)));

    // The next turn of A is prepared and waits in durable admission.
    const second = post(
      route,
      initialRequest(threadA, "turn-a-2", "Continue A."),
    );
    await admission.reached;
    expect(route.owns(threadA)).toBe(true);

    // Closing A now must wait: its thread is between preparation and its
    // conversation run, not idle.
    await expect(lifecycle.close(threadA)).resolves.toEqual({
      ok: false,
      code: "TASK_OPERATION_IN_PROGRESS",
    });
    expect(registry.get(threadA)).not.toBeNull();
    expect(surfaceA.disposed).toBe(0);

    // A neighbour is not held by A.
    const neighbour = await post(
      route,
      initialRequest(threadB, "turn-b-1", "Work on B."),
    );
    expect(await neighbour.text()).toContain("response.completed");
    expect(admitTask).toHaveBeenCalledTimes(2);

    admission.release();
    expect(await (await second).text()).toContain("response.completed");
    expect(surfaceA.prompts).toHaveLength(2);
    expect(surfaceA.prompts[1]).toContain("Continue A.");
    // The turn ran on the task's own surface; no second admission of A.
    expect(admitTask).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(route.owns(threadA)).toBe(false));

    // Once the turn settled, the close succeeds and removes everything once.
    await expect(lifecycle.close(threadA)).resolves.toEqual({
      ok: true,
      contextDeletion: "deleted",
      agentInput: "removed",
    });
    expect(registry.get(threadA)).toBeNull();
    expect(registry.get(threadB)).not.toBeNull();
    await expect(controller.store.load(binding(threadA))).resolves.toBeNull();
    expect(routes.has(threadA)).toBe(false);
    expect(surfaceA.disposed).toBe(1);
    expect(lifecycle.closing(threadA)).toBe(false);
  });

  it("S35-03 a later turn on an existing task is refused before submission while its running mark cannot be made durable, and runs once it can", async () => {
    const refused = new Set<string>();
    const { registry, routes, admitTask, route } = await compose({
      markRunningRefused: refused,
    });
    const first = await post(
      route,
      initialRequest(threadA, "turn-a-1", "Start A."),
    );
    expect(await first.text()).toContain("response.completed");
    const surfaceA = routes.get(threadA)!;
    await vi.waitFor(() => expect(route.owns(threadA)).toBe(false));
    expect(registry.get(threadA)?.lifecycle).toBe("idle");

    // A live promotion holds the lease: the later turn is refused before
    // anything reaches the conversation, and the task stays idle.
    refused.add(threadA);
    const second = await post(
      route,
      initialRequest(threadA, "turn-a-2", "Continue A."),
    );
    const refusedText = await second.text();
    expect(refusedText).toContain("TASK_ROUTE_UNAVAILABLE");
    expect(refusedText).not.toContain("response.completed");
    expect(surfaceA.prompts).toHaveLength(1);
    expect(registry.get(threadA)?.lifecycle).toBe("idle");
    expect(admitTask).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(route.owns(threadA)).toBe(false));

    // Released: the same thread's next turn runs on its own surface.
    refused.delete(threadA);
    const third = await post(
      route,
      initialRequest(threadA, "turn-a-3", "Continue A again."),
    );
    expect(await third.text()).toContain("response.completed");
    expect(surfaceA.prompts).toHaveLength(2);
    expect(admitTask).toHaveBeenCalledTimes(1);
  });

  it("S35-H1-1 a later turn whose lease is stolen between the entry check and its durable running mark is refused before submission, and the task stays idle", async () => {
    const leaseRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-lifecycle-lease-"),
    );
    roots.push(leaseRoot);
    let steal: (() => Promise<void>) | null = null;
    const { registry, routes, route, persist } = await compose({
      markRunningLease: {
        acquireForAdmission: async () => {
          const handle = await acquirePromotionLease(
            leaseRoot,
            "app-gen",
            "admission",
          );
          if (!handle) return null;
          let verifies = 0;
          return {
            release: () => releasePromotionLease(handle),
            verify: async () => {
              const held = await verifyPromotionLease(handle);
              verifies += 1;
              // Exactly the gap the entry-only check left open: the lease
              // file is removed and a real second process locks its
              // replacement after the entry check passed.
              if (verifies === 1 && steal) await steal();
              return held;
            },
          };
        },
      },
    });

    const first = await post(
      route,
      initialRequest(threadA, "turn-a-1", "Start A."),
    );
    expect(await first.text()).toContain("response.completed");
    const surfaceA = routes.get(threadA)!;
    await vi.waitFor(() => expect(route.owns(threadA)).toBe(false));
    expect(registry.get(threadA)?.lifecycle).toBe("idle");
    const persistsBefore = persist.mock.calls.length;

    steal = async () => {
      await fs.unlink(promotionLeasePath(leaseRoot));
      const holder = spawn(
        process.execPath,
        [leaseChildScript, leaseRoot, "hold", "adversary-generation"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      leaseHolders.push(holder);
      await new Promise<void>((resolve, reject) => {
        let buffer = "";
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          if (buffer.includes("ACQUIRED")) {
            holder.stdout?.off("data", onData);
            resolve();
          }
        };
        holder.stdout?.on("data", onData);
        holder.once("error", reject);
        setTimeout(
          () => reject(new Error("timed out waiting for ACQUIRED")),
          10_000,
        ).unref();
      });
    };

    const second = await post(
      route,
      initialRequest(threadA, "turn-a-2", "Continue A."),
    );
    const refusedText = await second.text();
    expect(refusedText).toContain("TASK_ROUTE_UNAVAILABLE");
    expect(refusedText).not.toContain("response.completed");
    // Nothing reached the conversation, nothing was persisted, and the
    // running mark was rolled back.
    expect(surfaceA.prompts).toHaveLength(1);
    expect(registry.get(threadA)?.lifecycle).toBe("idle");
    expect(persist.mock.calls.length).toBe(persistsBefore);

    // Control: with the adversary gone and nobody stealing it again, the
    // very next turn runs — the refusal above was the fence, not a wedge.
    steal = null;
    await Promise.all(
      leaseHolders.splice(0).map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once("close", () => resolve());
            child.kill("SIGKILL");
          }),
      ),
    );
    const third = await post(
      route,
      initialRequest(threadA, "turn-a-3", "Continue A again."),
    );
    expect(await third.text()).toContain("response.completed");
    expect(surfaceA.prompts).toHaveLength(2);
  });

  it("HR-007 refuses a turn on a task whose close has begun, and disposes that surface only after the refusal", async () => {
    const removal = gate();
    const { registry, routes, admitTask, lifecycle, route } = await compose({
      removal: { taskId: threadA, gate: removal },
    });
    const first = await post(
      route,
      initialRequest(threadA, "turn-a-1", "Start A."),
    );
    expect(await first.text()).toContain("response.completed");
    const surfaceA = routes.get(threadA)!;

    // The close wins ownership and pauses inside its asynchronous cleanup.
    const closing = lifecycle.close(threadA);
    await removal.reached;
    expect(lifecycle.closing(threadA)).toBe(true);

    // A turn arriving now is refused before anything reaches the surface
    // that is about to be disposed; a second close is refused too.
    const during = await post(
      route,
      initialRequest(threadA, "turn-a-2", "Continue A."),
    );
    const stream = await during.text();
    expect(stream).toContain("TASK_CLOSING");
    expect(stream).not.toContain("response.completed");
    expect(surfaceA.prompts).toHaveLength(1);
    expect(admitTask).toHaveBeenCalledTimes(1);
    await expect(lifecycle.close(threadA)).resolves.toEqual({
      ok: false,
      code: "TASK_OPERATION_IN_PROGRESS",
    });

    removal.release();
    await expect(closing).resolves.toEqual({
      ok: true,
      contextDeletion: "deleted",
      agentInput: "removed",
    });
    expect(registry.get(threadA)).toBeNull();
    expect(surfaceA.disposed).toBe(1);
    expect(lifecycle.closing(threadA)).toBe(false);

    // The refused turn was released before submission: repeated after the
    // close, it is a first turn again and admits a new task on a new surface.
    const repeated = await post(
      route,
      initialRequest(threadA, "turn-a-2", "Continue A."),
    );
    expect(await repeated.text()).toContain("response.completed");
    expect(admitTask).toHaveBeenCalledTimes(2);
    expect(surfaceA.prompts).toHaveLength(1);
    expect(routes.get(threadA)!.prompts).toEqual(["Continue A."]);
  });
  it("never re-admits a thread onto the private context a failed close left behind", async () => {
    const threadX = `thread-${randomUUID()}`;
    // Outcomes, in order: the clean start of a new thread, the close whose
    // deletion fails, the residue that still cannot be deleted, and finally a
    // deletion that succeeds.
    const { registry, admitTask, lifecycle } = await compose({
      contextDeletion: {
        taskId: threadX,
        outcomes: ["none", "failed", "failed", "deleted"],
      },
    });
    const first = await lifecycle.surfaceFor(threadX);
    expect(first.ok).toBe(true);
    expect(admitTask).toHaveBeenCalledTimes(1);
    // The close reports the failed deletion instead of an unqualified success.
    await expect(lifecycle.close(threadX)).resolves.toEqual({
      ok: true,
      contextDeletion: "failed",
      agentInput: "removed",
    });
    expect(registry.get(threadX)).toBeNull();
    // The same thread returns while its old context is still on disk: it is
    // refused, never attached to the context the owner closed.
    await expect(lifecycle.surfaceFor(threadX)).resolves.toEqual({
      ok: false,
      code: "TASK_CONTEXT_RESIDUE",
    });
    expect(admitTask).toHaveBeenCalledTimes(1);
    // Once the residue is gone the thread starts again from nothing.
    const again = await lifecycle.surfaceFor(threadX);
    expect(again.ok).toBe(true);
    expect(admitTask).toHaveBeenCalledTimes(2);
  });
  it("keeps a task's Agent input when its close could not be saved", async () => {
    const threadY = `thread-${randomUUID()}`;
    const { registry, admitTask, lifecycle, persist, agentInputRemovals } =
      await compose({});
    expect((await lifecycle.surfaceFor(threadY)).ok).toBe(true);
    expect(admitTask).toHaveBeenCalledTimes(1);
    const removalsBefore = agentInputRemovals.filter(
      (id) => id === threadY,
    ).length;
    // The removal cannot be saved: the task comes back whole, and nothing of
    // its private state was removed ahead of the save.
    persist.mockRejectedValueOnce(new Error("disk full"));
    await expect(lifecycle.close(threadY)).resolves.toEqual({
      ok: false,
      code: "TASK_STATE_UNAVAILABLE",
    });
    expect(registry.get(threadY)).not.toBeNull();
    expect(agentInputRemovals.filter((id) => id === threadY).length).toBe(
      removalsBefore,
    );
    // A save that succeeds removes the private state afterwards.
    await expect(lifecycle.close(threadY)).resolves.toEqual({
      ok: true,
      contextDeletion: "deleted",
      agentInput: "removed",
    });
    expect(agentInputRemovals.filter((id) => id === threadY).length).toBe(
      removalsBefore + 1,
    );
  });
});
