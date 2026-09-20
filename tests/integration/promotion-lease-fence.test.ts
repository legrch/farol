import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import {
  journalUnderPromotionLease,
  PromotionPendingRefusal,
} from "../../src/apps/desktop/chatgpt-journal-lease";
import { PrivateChatGptTaskJournal } from "../../src/apps/desktop/chatgpt-task-journal";
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

/**
 * The real journal `main.ts` builds, on a real private directory under the
 * same user-data root the lease lives in — the same layout
 * `chatGptTaskJournalRoot()` uses.
 */
function journalFor(root: string): PrivateChatGptTaskJournal {
  return new PrivateChatGptTaskJournal({
    root: path.join(root, "farol-next-state", "chatgpt-task-journal"),
  });
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

  // The ChatGPT one-shot journal. `journalUnderPromotionLease` (in
  // `chatgpt-journal-lease.ts`) is the function `main.ts` calls at all four
  // journal call sites, and `work` IS the durable journal write, so the
  // fence sits immediately before it and a stolen lease refuses before the
  // write runs.
  //
  // S35-H1R2: these used to drive a test-local replica of that wrapper over
  // a mocked journal, which proved the replica fenced and said nothing
  // about the production call path. The real function, the real
  // `PrivateChatGptTaskJournal` on a real private directory, the real
  // registry and the real second process are all here now; the journal file
  // on disk is the evidence that no obligation was recorded.
  it("S35-H1R2 a journal prepare under a stolen lease refuses with CHATGPT_TASK_PROMOTION_PENDING and writes no record", async () => {
    const root = await userData();
    const journal = journalFor(root);
    const operationId = randomUUID();
    const guard = racingLeaseGuard(root, () => stealLease(root));
    const registry = new LiveTaskRegistry(5, guard);

    const refusal = await journalUnderPromotionLease(registry, () =>
      journal.prepare({ operationId, kind: "readonly" }),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    // The exact refusal `main.ts` maps to `CHATGPT_TASK_PROMOTION_PENDING`
    // — by class, because that is what the call sites branch on.
    expect(refusal).toBeInstanceOf(PromotionPendingRefusal);
    expect((refusal as Error).message).toBe("CHATGPT_TASK_PROMOTION_PENDING");
    // Nothing was prepared: a promotion's drain check finds no
    // `CHATGPT_DISPATCH_PREPARED` obligation left behind by this attempt.
    expect(await journal.load()).toBeNull();
    // Two checks: the entry one (which passed) and the fence immediately
    // before the durable write (which refused).
    expect(guard.verifies()).toBe(2);
  });

  it("S35-H1R2 control: the same journal prepare lands when nobody steals the lease", async () => {
    const root = await userData();
    const journal = journalFor(root);
    const operationId = randomUUID();
    const guard = racingLeaseGuard(root, null);
    const registry = new LiveTaskRegistry(5, guard);

    await expect(
      journalUnderPromotionLease(registry, () =>
        journal.prepare({ operationId, kind: "readonly" }),
      ),
    ).resolves.toBeUndefined();

    expect(await journal.load()).toMatchObject({
      operationId,
      kind: "readonly",
      phase: "prepared",
    });
    expect(guard.verifies()).toBe(2);
  });

  // S35-H1R: the journal has TWO durable writes under the same wrapper —
  // `prepare` (`CHATGPT_DISPATCH_PREPARED`) and `markDispatchIntent`
  // (`CHATGPT_DELIVERY_PENDING`). Both are obligations a promotion's drain
  // check refuses on, so both must be fenced; only the first one was
  // covered here. The second write happens later in the same task, with
  // the window between its entry check and its write just as open.
  it("S35-H1R a dispatch-intent write under a stolen lease refuses and leaves the record prepared", async () => {
    const root = await userData();
    const journal = journalFor(root);
    const operationId = randomUUID();
    // The task's first durable write already landed; this is the second
    // one, which `main.ts` makes immediately before submission.
    await journal.prepare({ operationId, kind: "readonly" });
    const guard = racingLeaseGuard(root, () => stealLease(root));
    const registry = new LiveTaskRegistry(5, guard);

    const refusal = await journalUnderPromotionLease(registry, () =>
      journal.markDispatchIntent(operationId),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(PromotionPendingRefusal);
    expect((refusal as Error).message).toBe("CHATGPT_TASK_PROMOTION_PENDING");
    // Still merely prepared: no `CHATGPT_DELIVERY_PENDING` obligation was
    // recorded for a turn this process is not going to submit.
    expect(await journal.load()).toMatchObject({
      operationId,
      phase: "prepared",
    });
    expect(guard.verifies()).toBe(2);
  });

  it("S35-H1R control: the same dispatch-intent write lands when nobody steals the lease", async () => {
    const root = await userData();
    const journal = journalFor(root);
    const operationId = randomUUID();
    await journal.prepare({ operationId, kind: "readonly" });
    const guard = racingLeaseGuard(root, null);
    const registry = new LiveTaskRegistry(5, guard);

    await expect(
      journalUnderPromotionLease(registry, () =>
        journal.markDispatchIntent(operationId),
      ),
    ).resolves.toBeUndefined();

    expect(await journal.load()).toMatchObject({
      operationId,
      phase: "dispatch_intent",
    });
    expect(guard.verifies()).toBe(2);
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
