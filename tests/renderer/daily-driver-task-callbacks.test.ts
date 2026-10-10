import { expect, it } from "vitest";
import { WindowController } from "../../src/ui/renderer/controller";
import { fixture } from "./fixture";

// Portable preload/controller composition only; no browser or provider effect.
it("binds a task command to validated values before the digest await", async () => {
  const f = fixture();
  const controller = new WindowController(f.api);
  await controller.start();
  const command = {
    kind: "task.rename" as const,
    taskId: "original-task",
    label: "Original label",
  };
  const result = controller.task(command, "rename-original");
  command.taskId = "replacement-task";
  command.label = "Replacement label";
  expect((await result).state).toBe("applied");
  expect(f.api.task).toHaveBeenCalledExactlyOnceWith({
    kind: "task.rename",
    taskId: "original-task",
    label: "Original label",
  });
  controller.dispose();
});

it("captures nested agent scope and normalized objective before dispatch", async () => {
  const f = fixture();
  const controller = new WindowController(f.api);
  await controller.start();
  const command = {
    kind: "task.start-agent" as const,
    taskId: "original-task",
    workspaceId: "original-workspace",
    objective: "  Inspect the selected file  ",
    scope: { mode: "exact" as const, relativePaths: ["src/original.ts"] },
  };
  const result = controller.task(command, "agent-original");
  command.workspaceId = "replacement-workspace";
  command.objective = "Change another file";
  command.scope.relativePaths[0] = "src/replacement.ts";
  expect((await result).state).toBe("applied");
  expect(f.api.task).toHaveBeenCalledExactlyOnceWith({
    kind: "task.start-agent",
    taskId: "original-task",
    workspaceId: "original-workspace",
    objective: "Inspect the selected file",
    scope: { mode: "exact", relativePaths: ["src/original.ts"] },
  });
  controller.dispose();
});
