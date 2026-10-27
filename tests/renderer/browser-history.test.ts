import { expect, it, vi } from "vitest";
import { WindowController } from "../../src/ui/renderer/controller";
import { bootstrap, deferred, fixture } from "./fixture";

it("travels browser history before falling back to Farol sections", async () => {
  const f = fixture();
  const history = vi.fn(async () => ({
    handled: true,
    taskId: "",
    back: true,
    forward: false,
  }));
  Object.assign(f.api, { browserHistory: history });
  const controller = new WindowController(f.api);
  await controller.start();
  controller.navigate({ area: "home" });
  controller.navigate({ area: "chatgpt", taskId: "" });
  controller.travel(-1);
  await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(1));
  expect(history).toHaveBeenCalledWith({ taskId: "", direction: -1 });
  expect(controller.getSnapshot().destination.area).toBe("chatgpt");
  history.mockResolvedValue({
    handled: false,
    taskId: "",
    back: false,
    forward: true,
  });
  controller.travel(-1);
  await vi.waitFor(() =>
    expect(controller.getSnapshot().destination.area).toBe("home"),
  );
  controller.travel(1);
  expect(controller.getSnapshot().destination.area).toBe("chatgpt");
  controller.dispose();
});

it("does not use a late or uncertain browser reply to navigate another section", async () => {
  const f = fixture();
  const pending = deferred<unknown>();
  Object.assign(f.api, { browserHistory: vi.fn(() => pending.promise) });
  const controller = new WindowController(f.api);
  await controller.start();
  controller.navigate({ area: "chatgpt", taskId: "" });
  controller.travel(-1);
  controller.navigate({ area: "activity" });
  pending.resolve({ handled: false, taskId: "", back: false, forward: false });
  await Promise.resolve();
  expect(controller.getSnapshot().destination.area).toBe("activity");
  controller.dispose();
});

it("keeps native history events newer than bootstrap and travel replies", async () => {
  const f = fixture();
  const initial = bootstrap();
  const boot = deferred<unknown>();
  const pending = deferred<unknown>();
  let publish!: (value: unknown) => void;
  Object.assign(f.api, {
    bootstrap: vi.fn(() => boot.promise),
    browserHistory: vi.fn(() => pending.promise),
    onBrowserHistoryState: (listener: typeof publish) => {
      publish = listener;
      return () => {};
    },
  });
  const controller = new WindowController(f.api);
  const started = controller.start();
  publish({ taskId: "", back: true, forward: false });
  boot.resolve({
    ...initial,
    browserHistoryState: { taskId: "", back: false, forward: false },
  });
  await started;
  expect(controller.getSnapshot().browserHistory?.back).toBe(true);
  controller.navigate({ area: "chatgpt", taskId: "" });
  controller.travel(-1);
  publish({ taskId: "", back: false, forward: true });
  publish({ taskId: "background-task", back: true, forward: false });
  pending.resolve({ handled: true, taskId: "", back: true, forward: false });
  await Promise.resolve();
  expect(controller.getSnapshot().browserHistory).toEqual({
    taskId: "",
    back: false,
    forward: true,
  });
  controller.dispose();
});
