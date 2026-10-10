import { expect, it, vi } from "vitest";
import { WindowController } from "../../src/ui/renderer/controller";
import { bootstrap, deferred, fixture, task } from "./fixture";

// Late preload receipts are tested without executing a task/provider effect.
it.each([
  { name: "removed task", revision: 2, tasks: [] },
  {
    name: "reused turn",
    revision: 2,
    tasks: [{ ...task(), turnId: "replacement-turn" }],
  },
  {
    name: "reused session",
    revision: 2,
    tasks: [{ ...task(), sessionId: "replacement-session" }],
  },
  {
    name: "conflicting revision",
    revision: 1,
    tasks: [{ ...task(), label: "Conflicting observation" }],
  },
])("does not navigate from a late receipt after $name", async (latest) => {
  const f = fixture();
  const reply = deferred<unknown>();
  vi.mocked(f.api.task).mockReturnValueOnce(reply.promise);
  const controller = new WindowController(f.api);
  await controller.start();
  const pending = controller.task({ kind: "task.create-chatgpt" }, "create");
  await vi.waitFor(() => expect(f.api.task).toHaveBeenCalledOnce());
  f.emit("tasks", { revision: latest.revision, tasks: latest.tasks });
  const destination = controller.getSnapshot().destination;
  reply.resolve({
    ok: true,
    state: { revision: 1, tasks: [task()] },
    selectedTaskId: "task-1",
  });
  expect((await pending).state).toBe("applied");
  expect(controller.getSnapshot().destination).toBe(destination);
  expect(controller.getSnapshot().tasks).toEqual({
    revision: latest.revision,
    tasks: latest.tasks,
  });
  controller.dispose();
});

it("settles an old ACK without replacing reconnect observations", async () => {
  const f = fixture();
  const reply = deferred<unknown>();
  vi.mocked(f.api.task).mockReturnValueOnce(reply.promise);
  const controller = new WindowController(f.api);
  await controller.start();
  const pending = controller.task({ kind: "task.create-chatgpt" }, "create");
  await vi.waitFor(() => expect(f.api.task).toHaveBeenCalledOnce());
  f.emit("runtime", {
    state: "offline",
    error: null,
    identity: null,
    embeddedNode: null,
    embeddedElectron: null,
  });
  const latest = { ...task(), label: "Reconnect observation" };
  vi.mocked(f.api.bootstrap).mockResolvedValueOnce({
    ...bootstrap(),
    taskRevision: 2,
    tasks: [latest],
  });
  await controller.refresh();
  const before = controller.getSnapshot();
  expect(before.status).toBe("current");
  reply.resolve({
    ok: true,
    state: { revision: 3, tasks: [task()] },
    selectedTaskId: "task-1",
  });
  expect((await pending).state).toBe("applied");
  expect(controller.getSnapshot().tasks).toBe(before.tasks);
  expect(controller.getSnapshot().destination).toBe(before.destination);
  expect(f.api.task).toHaveBeenCalledOnce();
  controller.dispose();
});

it("opens the same conversation when newer metadata retains its identity", async () => {
  const f = fixture();
  const reply = deferred<unknown>();
  vi.mocked(f.api.task).mockReturnValueOnce(reply.promise);
  const controller = new WindowController(f.api);
  await controller.start();
  const pending = controller.task({ kind: "task.create-chatgpt" }, "create");
  await vi.waitFor(() => expect(f.api.task).toHaveBeenCalledOnce());
  const latest = { ...task(), label: "Newer metadata" };
  f.emit("tasks", { revision: 2, tasks: [latest] });
  reply.resolve({
    ok: true,
    state: { revision: 1, tasks: [task()] },
    selectedTaskId: "task-1",
  });
  expect((await pending).state).toBe("applied");
  expect(controller.getSnapshot().tasks.tasks).toEqual([latest]);
  expect(controller.getSnapshot().destination).toMatchObject({
    area: "chatgpt",
    taskId: "task-1",
  });
  controller.dispose();
});

it("rechecks runtime identity after synchronous task subscribers run", async () => {
  const f = fixture();
  const reply = deferred<unknown>();
  vi.mocked(f.api.task).mockReturnValueOnce(reply.promise);
  const controller = new WindowController(f.api);
  await controller.start();
  const pending = controller.task({ kind: "task.create-chatgpt" }, "create");
  await vi.waitFor(() => expect(f.api.task).toHaveBeenCalledOnce());
  const destination = controller.getSnapshot().destination;
  let rebound = false;
  const unsubscribe = controller.subscribe(() => {
    if (rebound || controller.getSnapshot().tasks.revision !== 1) return;
    rebound = true;
    f.emit("runtime", {
      state: "ready",
      error: null,
      identity: null,
      embeddedNode: null,
      embeddedElectron: null,
    });
  });
  reply.resolve({
    ok: true,
    state: { revision: 1, tasks: [task()] },
    selectedTaskId: "task-1",
  });
  expect((await pending).state).toBe("applied");
  expect(rebound).toBe(true);
  expect(controller.getSnapshot().destination).toBe(destination);
  unsubscribe();
  controller.dispose();
});

it("does not navigate from a task receipt after runtime disconnect", async () => {
  const f = fixture();
  const reply = deferred<unknown>();
  vi.mocked(f.api.task).mockReturnValueOnce(reply.promise);
  const controller = new WindowController(f.api);
  await controller.start();
  const pending = controller.task({ kind: "task.create-chatgpt" }, "create");
  await vi.waitFor(() => expect(f.api.task).toHaveBeenCalledOnce());
  f.emit("runtime", {
    state: "offline",
    error: null,
    identity: null,
    embeddedNode: null,
    embeddedElectron: null,
  });
  const destination = controller.getSnapshot().destination;
  reply.resolve({
    ok: true,
    state: { revision: 1, tasks: [task()] },
    selectedTaskId: "task-1",
  });
  expect((await pending).state).toBe("applied");
  expect(controller.getSnapshot().status).toBe("stale");
  expect(controller.getSnapshot().destination).toBe(destination);
  controller.dispose();
});
