import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
import type { ProductTask } from "../../src/modules/chat/contract/product-task";

// S35-H1-1. One entry check is not a fence: `withPromotionLease` used to
// verify the hold once and then run the whole critical phase, so a lease
// deleted and re-created after that check (a second acquirer then locks the
// NEW inode, and two holders exist) was written straight through. Every
// durable write now takes its own fence.
//
// The adversary here is real on both sides: a real lease file on a real
// private state directory, and a real second process — the same
// `fixtures/promotion-lease-child.mjs` in `hold` mode that
// `promotion-lease.test.ts` uses — holding the replacement inode. The only
// fixture is the instant at which it strikes: `racingLeaseGuard` fires it
// once, after the entry check has already passed and before the durable
// write's own fence, which is exactly the gap the old code left open.

const childScript = fileURLToPath(
  new URL("./fixtures/promotion-lease-child.mjs", import.meta.url),
);

const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => killAndWait(child)));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function userData(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-lease-fence-"),
  );
  roots.push(root);
  return root;
}

function waitForLine(
  child: ReturnType<typeof spawn>,
  needle: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(needle)) {
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    setTimeout(
      () => reject(new Error(`timed out waiting for ${needle}`)),
      10_000,
    ).unref();
  });
}

function killAndWait(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", () => resolve());
    child.kill("SIGKILL");
  });
}

/**
 * The adversary: removes the lease file this hold locks and lets a real
 * second process take its replacement. After this returns, the hold's own
 * inode is unreachable by name and another live holder exists.
 */
async function stealLease(root: string): Promise<void> {
  await fs.unlink(promotionLeasePath(root));
  const holder = spawn(
    process.execPath,
    [childScript, root, "hold", "adversary-generation"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(holder);
  await waitForLine(holder, "ACQUIRED");
}

/**
 * A real `admission` lease, plus a one-shot sabotage fired in the gap
 * between the entry check and the next fence. `verify` itself is the real
 * `verifyPromotionLease`; nothing about the check is faked.
 */
function racingLeaseGuard(
  root: string,
  sabotage: (() => Promise<void>) | null,
): PromotionLeaseGuard & { verifies: () => number } {
  let verifies = 0;
  return {
    verifies: () => verifies,
    acquireForAdmission: async () => {
      const handle = await acquirePromotionLease(root, "app-gen", "admission");
      if (!handle) return null;
      return {
        release: () => releasePromotionLease(handle),
        verify: async () => {
          const held = await verifyPromotionLease(handle);
          verifies += 1;
          if (verifies === 1 && sabotage) await sabotage();
          return held;
        },
      };
    },
  };
}

function fixtureTask(overrides: Partial<ProductTask> = {}): ProductTask {
  return {
    taskId: "task-a",
    sessionId: "task-a",
    turnId: "turn-a",
    label: "Task",
    provider: "chatgpt",
    requestedModel: null,
    observedModel: null,
    requestedMode: null,
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle: "idle",
    ...overrides,
  } as ProductTask;
}

describe("promotion lease: every durable write is fenced, not only the entry", () => {
  it("S35-H1-1 admitDurable refuses with promotion_pending and persists nothing when the lease is stolen between the entry check and the durable write", async () => {
    const root = await userData();
    const persisted: string[] = [];
    const guard = racingLeaseGuard(root, () => stealLease(root));
    const registry = new LiveTaskRegistry(5, guard);

    await expect(
      registry.admitDurable(fixtureTask(), async () => {
        persisted.push("task-a");
      }),
    ).resolves.toEqual({ status: "promotion_pending" });

    // The write never happened, and the in-memory admission was rolled back
    // with it: nothing anywhere claims this task was admitted.
    expect(persisted).toEqual([]);
    expect(registry.get("task-a")).toBeNull();
    expect(registry.snapshot().tasks).toEqual([]);
    // Two checks: the entry one (which passed) and the fence immediately
    // before the durable write (which refused).
    expect(guard.verifies()).toBe(2);
  });

  it("S35-H1-1 control: the same admission persists and is admitted when nobody steals the lease", async () => {
    const root = await userData();
    const persisted: string[] = [];
    const guard = racingLeaseGuard(root, null);
    const registry = new LiveTaskRegistry(5, guard);

    await expect(
      registry.admitDurable(fixtureTask(), async () => {
        persisted.push("task-a");
      }),
    ).resolves.toMatchObject({ status: "admitted" });

    expect(persisted).toEqual(["task-a"]);
    expect(registry.get("task-a")?.taskId).toBe("task-a");
    expect(guard.verifies()).toBe(2);
  });

  // The native Agent start in `main.ts` (`case "task.agent-start"`): the
  // same `withPromotionLease` call, whose durable write is
  // `persistLiveTaskState()` after `setAgent`. Composed here with the real
  // registry and the real lease; only the persist is the test's own.
  it("S35-H1-1 a native Agent start under a stolen lease refuses, rolls the agent mark back and never persists", async () => {
    const root = await userData();
    const persisted: number[] = [];
    const guard = racingLeaseGuard(root, () => stealLease(root));
    const registry = new LiveTaskRegistry(5, guard);
    expect(registry.admit(fixtureTask()).status).toBe("admitted");
    const before = registry.snapshot();

    const outcome = await registry.withPromotionLease(async (fence) => {
      registry.setAgent("task-a", {
        assignmentBindingSha256: "a".repeat(64),
        phase: "running",
        workspaceId: "workspace-a",
        parentDelivery: "not_applicable",
        workspaceEnforcement: "not_applicable",
        resultAvailable: false,
      });
      try {
        await fence();
        persisted.push(registry.snapshot().revision);
      } catch (error) {
        registry.rollback(before);
        if (error instanceof PromotionLeaseLost) throw error;
        return { ok: false as const, code: "TASK_STATE_UNAVAILABLE" };
      }
      return { ok: true as const };
    });

    // `main.ts` maps this `{ok:false}` to `TASK_ROUTE_UNAVAILABLE`.
    expect(outcome.ok).toBe(false);
    expect(persisted).toEqual([]);
    expect(registry.get("task-a")?.agent ?? null).toBeNull();
  });

  // The ChatGPT one-shot journal (`journalUnderPromotionLease` in
  // `main.ts`): `work` IS the durable journal write, so the fence sits
  // immediately before it and a stolen lease refuses before `prepare` runs.
  it("S35-H1-1 a journal write under a stolen lease refuses with CHATGPT_TASK_PROMOTION_PENDING and never calls prepare", async () => {
    const root = await userData();
    const prepared: string[] = [];
    const journal = {
      prepare: async (operationId: string) => {
        prepared.push(operationId);
      },
    };
    const guard = racingLeaseGuard(root, () => stealLease(root));
    const registry = new LiveTaskRegistry(5, guard);

    // `journalUnderPromotionLease`, verbatim: fence, then the journal write,
    // and `!ok` raised as the refusal `main.ts` renders as
    // `CHATGPT_TASK_PROMOTION_PENDING`.
    const journalUnderPromotionLease = async (
      work: () => Promise<void>,
    ): Promise<void> => {
      const outcome = await registry.withPromotionLease(async (fence) => {
        await fence();
        return work();
      });
      if (!outcome.ok) throw new Error("CHATGPT_TASK_PROMOTION_PENDING");
      return outcome.value;
    };

    await expect(
      journalUnderPromotionLease(() => journal.prepare("operation-a")),
    ).rejects.toThrow("CHATGPT_TASK_PROMOTION_PENDING");
    expect(prepared).toEqual([]);
  });

  it("S35-H1-1 control: the same journal write lands when nobody steals the lease", async () => {
    const root = await userData();
    const prepared: string[] = [];
    const guard = racingLeaseGuard(root, null);
    const registry = new LiveTaskRegistry(5, guard);

    const outcome = await registry.withPromotionLease(async (fence) => {
      await fence();
      prepared.push("operation-a");
    });

    expect(outcome.ok).toBe(true);
    expect(prepared).toEqual(["operation-a"]);
  });

  it("S35-H1-1 a registry built without a lease guard hands work an unfenced no-op, exactly as before", async () => {
    const registry = new LiveTaskRegistry(5);
    const persisted: string[] = [];
    await expect(
      registry.admitDurable(fixtureTask(), async () => {
        persisted.push("task-a");
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(persisted).toEqual(["task-a"]);
  });
});
