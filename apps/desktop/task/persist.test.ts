import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";
import { PrivateLiveTaskStore } from "../../../src/apps/desktop/live-task-store";
import type { ProductTask } from "../../../src/modules/chat/contract/product-task";
import { createTaskPersist, type TaskPersistPorts } from "./persist";

// The live-task persistence over a real registry and a real private store in a
// temporary root. Main's owners are scripted: each `let` is a field the ports
// read afresh and write through the setters, and every effect appends to one
// ordered log. No window, route, provider or installed profile runs.
const home = "https://chatgpt.com/";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-persist-"));
  roots.push(root);
  return root;
}

function task(index: number, lifecycle: ProductTask["lifecycle"] = "idle") {
  return {
    taskId: randomUUID(),
    sessionId: randomUUID(),
    turnId: randomUUID(),
    label: `ChatGPT task ${index}`,
    provider: "chatgpt" as const,
    requestedModel: "Account default",
    observedModel: null,
    requestedMode: "Account default",
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle,
  } satisfies ProductTask;
}

function stored(
  source: ReturnType<typeof task>,
  conversationUrl: string | null = `https://chatgpt.com/c/${source.label}`,
) {
  return { ...source, conversationUrl };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

async function build(
  options: Readonly<{
    env?: Record<string, string | undefined>;
    withStore?: boolean;
  }> = {},
) {
  const root = await temporaryRoot();
  const events: string[] = [];
  const registry = new LiveTaskRegistry(5);
  const routes = new Map<string, { dispose: () => void }>();
  const conversationUrls = new Map<string, string | null>();
  const state = {
    store: options.withStore
      ? new PrivateLiveTaskStore({ root })
      : (null as PrivateLiveTaskStore | null),
    persistence: Promise.resolve(),
    restored: false,
    selected: "initial",
    homeUrl: home,
  };
  const created: { taskId: string; label: string; url?: string | undefined }[] =
    [];
  const disposed: string[] = [];
  const opened: { root: string; hooks: object }[] = [];
  const publishTasksState = vi.fn(() => {
    events.push("publish");
  });
  const surface = vi.fn((taskId: string) => {
    events.push(`surface:${taskId}`);
  });
  const ports: TaskPersistPorts = {
    liveTaskStore: () => state.store,
    setLiveTaskStore: (value) => {
      state.store = value;
    },
    liveTaskPersistence: () => state.persistence,
    setLiveTaskPersistence: (value) => {
      state.persistence = value;
    },
    setLiveTaskRegistryRestored: (value) => {
      state.restored = value;
    },
    setSelectedTaskId: (value) => {
      state.selected = value;
    },
    chatGptHomeUrl: () => state.homeUrl,
    liveTaskRegistry: registry,
    liveTaskRoutes: routes,
    liveTaskConversationUrls: conversationUrls,
    statePaths: () => ({ liveTasks: root }),
    createLiveChatGptRoute: (taskId, label, url) => {
      created.push({ taskId, label, url });
      return { dispose: () => disposed.push(taskId) };
    },
    openStore: (storeRoot, hooks) => {
      opened.push({ root: storeRoot, hooks });
      return new PrivateLiveTaskStore({ root: storeRoot }, hooks);
    },
    publishTasksState,
    surfaceLiveTaskPersistenceFailure: surface,
    env: options.env ?? {},
  };
  return {
    root,
    events,
    registry,
    routes,
    conversationUrls,
    state,
    created,
    disposed,
    opened,
    publishTasksState,
    surface,
    subject: createTaskPersist(ports),
    reload: () => new PrivateLiveTaskStore({ root }).load(),
  };
}

describe("task persist", () => {
  describe("stored", () => {
    it("maps each task to the stored shape with its conversation URL", async () => {
      const h = await build();
      const a = task(1);
      const b = task(2, "running");
      expect(h.registry.admit(a).status).toBe("admitted");
      expect(h.registry.admit(b).status).toBe("admitted");
      h.conversationUrls.set(a.taskId, "https://chatgpt.com/c/a");

      const result = h.subject.stored();

      expect(result.revision).toBe(h.registry.snapshot().revision);
      expect(result.tasks).toEqual([
        {
          ...a,
          provider: "chatgpt",
          conversationUrl: "https://chatgpt.com/c/a",
        },
        { ...b, provider: "chatgpt", conversationUrl: null },
      ]);
    });

    it("never stores the in-flight turn mark, which belongs to this run only", async () => {
      const h = await build({ withStore: true });
      const a = task(1, "outcome_unknown");
      h.registry.admit(a);
      h.registry.setTurnInFlight(a.taskId, true);
      expect(h.registry.get(a.taskId)?.turnInFlight).toBe(true);

      expect(h.subject.stored().tasks[0]).not.toHaveProperty("turnInFlight");
      await h.subject.persist();
      const record = await h.reload();
      expect(record?.tasks).toEqual([stored(a, null)]);
    });

    it("reads the conversation URLs when called, not when built", async () => {
      const h = await build();
      const a = task(1);
      h.registry.admit(a);
      expect(h.subject.stored().tasks[0]?.conversationUrl).toBeNull();
      h.conversationUrls.set(a.taskId, "https://chatgpt.com/c/late");
      expect(h.subject.stored().tasks[0]?.conversationUrl).toBe(
        "https://chatgpt.com/c/late",
      );
    });
  });

  describe("persist", () => {
    it("refuses when no store is open", async () => {
      const h = await build();
      await expect(h.subject.persist()).rejects.toThrow(
        "LIVE_TASK_STATE_UNAVAILABLE",
      );
    });

    it("saves the registry state to the store", async () => {
      const h = await build({ withStore: true });
      const a = task(1);
      h.registry.admit(a);
      h.conversationUrls.set(a.taskId, "https://chatgpt.com/c/a");

      await h.subject.persist();

      const record = await h.reload();
      expect(record?.revision).toBe(h.registry.snapshot().revision);
      expect(record?.tasks).toEqual([stored(a, "https://chatgpt.com/c/a")]);
    });

    it("chains each save behind the previous one, in call order", async () => {
      const h = await build({ withStore: true });
      const store = h.state.store!;
      const order: string[] = [];
      const gates = [deferred(), deferred()];
      const calls: number[] = [];
      vi.spyOn(store, "save").mockImplementation(async (input) => {
        const index = calls.push(input.revision) - 1;
        order.push(`start:${input.revision}`);
        await gates[index]?.promise;
        order.push(`end:${input.revision}`);
      });
      const a = task(1);
      h.registry.admit(a);
      const first = h.subject.persist();
      h.registry.setLifecycle(a.taskId, "running");
      const second = h.subject.persist();

      await new Promise((resolve) => setImmediate(resolve));
      expect(order).toEqual(["start:1"]);

      gates[0]?.resolve();
      await first;
      await new Promise((resolve) => setImmediate(resolve));
      expect(order).toEqual(["start:1", "end:1", "start:2"]);

      gates[1]?.resolve();
      await second;
      expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
    });

    it("snapshots the state when called, not when the write starts", async () => {
      const h = await build({ withStore: true });
      const store = h.state.store!;
      const gate = deferred();
      const saved: string[] = [];
      let first = true;
      vi.spyOn(store, "save").mockImplementation(async (input) => {
        saved.push(input.tasks.map((entry) => entry.lifecycle).join());
        if (first) {
          first = false;
          await gate.promise;
        }
      });
      const a = task(1);
      h.registry.admit(a);
      const one = h.subject.persist();
      h.registry.setLifecycle(a.taskId, "running");
      const two = h.subject.persist();
      gate.resolve();
      await Promise.all([one, two]);
      expect(saved).toEqual(["idle", "running"]);
    });

    it("returns the failure to its caller and still runs the next save", async () => {
      const h = await build({ withStore: true });
      const store = h.state.store!;
      const save = vi
        .spyOn(store, "save")
        .mockRejectedValueOnce(new Error("DISK_FULL"))
        .mockResolvedValue(undefined);
      h.registry.admit(task(1));

      await expect(h.subject.persist()).rejects.toThrow("DISK_FULL");
      await expect(h.subject.persist()).resolves.toBeUndefined();
      expect(save).toHaveBeenCalledTimes(2);
    });

    it("uses the store open at the call, not the one open at build", async () => {
      const h = await build({ withStore: true });
      h.state.store = null;
      await expect(h.subject.persist()).rejects.toThrow(
        "LIVE_TASK_STATE_UNAVAILABLE",
      );
    });
  });

  describe("markRunningDurable", () => {
    it("publishes the running mark and saves it", async () => {
      const h = await build({ withStore: true });
      const a = task(1);
      h.registry.admit(a);

      await expect(h.subject.markRunningDurable(a.taskId)).resolves.toBe(true);

      expect(h.registry.get(a.taskId)?.lifecycle).toBe("running");
      expect(h.publishTasksState).toHaveBeenCalledTimes(1);
      expect(h.surface).not.toHaveBeenCalled();
      expect((await h.reload())?.tasks[0]?.lifecycle).toBe("running");
    });

    it("proceeds without writing when the task already runs", async () => {
      const h = await build({ withStore: true });
      const a = task(1, "running");
      h.registry.admit(a);
      const save = vi.spyOn(h.state.store!, "save");

      await expect(h.subject.markRunningDurable(a.taskId)).resolves.toBe(true);

      expect(save).not.toHaveBeenCalled();
      expect(h.publishTasksState).not.toHaveBeenCalled();
    });

    it("surfaces a persistence failure and still lets the turn proceed", async () => {
      const h = await build();
      const a = task(1);
      h.registry.admit(a);

      await expect(h.subject.markRunningDurable(a.taskId)).resolves.toBe(true);

      expect(h.events).toEqual(["publish", `surface:${a.taskId}`]);
      expect(h.surface).toHaveBeenCalledWith(a.taskId);
    });
  });

  describe("initialize", () => {
    it("opens the store at the profile's live-task root with no hooks", async () => {
      const h = await build();
      await h.subject.initialize();
      expect(h.opened).toEqual([{ root: h.root, hooks: {} }]);
      expect(h.state.store).not.toBeNull();
      expect(h.state.restored).toBe(false);
      expect(h.state.selected).toBe("initial");
      expect(h.registry.snapshot().tasks).toEqual([]);
    });

    it("restores the registry, routes, URLs and the first task as selected", async () => {
      const h = await build();
      const a = task(1);
      const b = task(2);
      await new PrivateLiveTaskStore({ root: h.root }).save({
        revision: 4,
        tasks: [stored(a), stored(b, null)],
      });

      await h.subject.initialize();

      expect(h.registry.snapshot()).toEqual({ revision: 4, tasks: [a, b] });
      expect(h.state.restored).toBe(true);
      expect(h.state.selected).toBe(a.taskId);
      expect(h.created).toEqual([
        { taskId: a.taskId, label: a.label, url: stored(a).conversationUrl },
        { taskId: b.taskId, label: b.label, url: home },
      ]);
      expect([...h.routes.keys()]).toEqual([a.taskId, b.taskId]);
      expect([...h.conversationUrls]).toEqual([
        [a.taskId, stored(a).conversationUrl],
        [b.taskId, null],
      ]);
      expect(h.state.store).not.toBeNull();
    });

    it("falls back to the home URL read at the call", async () => {
      const h = await build();
      const a = task(1);
      await new PrivateLiveTaskStore({ root: h.root }).save({
        revision: 1,
        tasks: [stored(a, null)],
      });
      h.state.homeUrl = "https://chatgpt.com/fixture";
      await h.subject.initialize();
      expect(h.created[0]?.url).toBe("https://chatgpt.com/fixture");
    });

    it("marks an interrupted running task outcome-unknown and saves that", async () => {
      const h = await build();
      const a = task(1, "running");
      const b = task(2);
      await new PrivateLiveTaskStore({ root: h.root }).save({
        revision: 4,
        tasks: [stored(a), stored(b)],
      });

      await h.subject.initialize();

      const snapshot = h.registry.snapshot();
      expect(snapshot.revision).toBe(5);
      expect(snapshot.tasks.map((entry) => entry.lifecycle)).toEqual([
        "outcome_unknown",
        "idle",
      ]);
      const record = await h.reload();
      expect(record?.revision).toBe(5);
      expect(record?.tasks.map((entry) => entry.lifecycle)).toEqual([
        "outcome_unknown",
        "idle",
      ]);
      expect(h.state.store).not.toBeNull();
    });

    it("drops the store when the reconciling save fails", async () => {
      const h = await build({
        env: {
          FAROL_E2E: "1",
          FAROL_E2E_LIVE_TASK_SAVE_SUCCESSES: "0",
        },
      });
      const a = task(1, "running");
      await new PrivateLiveTaskStore({ root: h.root }).save({
        revision: 1,
        tasks: [stored(a)],
      });

      await h.subject.initialize();

      expect(h.state.store).toBeNull();
      expect(h.state.restored).toBe(true);
      expect(h.registry.get(a.taskId)?.lifecycle).toBe("outcome_unknown");
    });

    it("leaves no store when the record cannot be read", async () => {
      const h = await build();
      await fs.writeFile(path.join(h.root, "live-tasks.json"), "{not json", {
        mode: 0o600,
      });
      h.state.store = new PrivateLiveTaskStore({ root: h.root });

      await h.subject.initialize();

      expect(h.state.store).toBeNull();
      expect(h.state.restored).toBe(false);
      expect(h.state.selected).toBe("initial");
      expect(h.created).toEqual([]);
      expect(h.registry.snapshot().tasks).toEqual([]);
    });

    it("disposes staged routes and drops the store when restore refuses", async () => {
      const h = await build();
      const a = task(1);
      const b = task(2);
      await new PrivateLiveTaskStore({ root: h.root }).save({
        revision: 1,
        tasks: [stored(a), stored(b)],
      });
      // A registry that already holds a task refuses to restore over it.
      h.registry.admit(task(3));
      h.conversationUrls.set("kept-then-cleared", null);

      await h.subject.initialize();

      expect(h.state.store).toBeNull();
      expect(h.state.restored).toBe(false);
      expect(h.state.selected).toBe("initial");
      expect(h.disposed).toEqual([a.taskId, b.taskId]);
      expect(h.routes.size).toBe(0);
      expect(h.conversationUrls.size).toBe(0);
    });

    describe("e2e save fault", () => {
      const fault = (successes: string) => ({
        FAROL_E2E: "1",
        FAROL_E2E_LIVE_TASK_SAVE_SUCCESSES: successes,
      });

      it("lets the first N saves through and refuses every later one", async () => {
        const h = await build({ env: fault("2") });
        await h.subject.initialize();
        expect(Object.keys(h.opened[0]?.hooks ?? {})).toEqual(["beforeCommit"]);
        h.registry.admit(task(1));

        await expect(h.subject.persist()).resolves.toBeUndefined();
        await expect(h.subject.persist()).resolves.toBeUndefined();
        await expect(h.subject.persist()).rejects.toThrow(
          "LIVE_TASK_E2E_SAVE_FAULT",
        );
        await expect(h.subject.persist()).rejects.toThrow(
          "LIVE_TASK_E2E_SAVE_FAULT",
        );
      });

      it("refuses every save when the count is not a non-negative integer", async () => {
        for (const value of ["x", "-1", "1.5"]) {
          const h = await build({ env: fault(value) });
          await h.subject.initialize();
          h.registry.admit(task(1));
          await expect(h.subject.persist()).rejects.toThrow(
            "LIVE_TASK_E2E_SAVE_FAULT_INVALID",
          );
        }
      });

      it("ignores the count unless the e2e switch is on", async () => {
        for (const env of [
          { FAROL_E2E_LIVE_TASK_SAVE_SUCCESSES: "0" },
          { FAROL_E2E: "0", FAROL_E2E_LIVE_TASK_SAVE_SUCCESSES: "0" },
        ]) {
          const h = await build({ env });
          await h.subject.initialize();
          expect(h.opened[0]?.hooks).toEqual({});
          h.registry.admit(task(1));
          await expect(h.subject.persist()).resolves.toBeUndefined();
        }
      });
    });
  });
});
