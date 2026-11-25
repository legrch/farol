import { z } from "zod";

// The control message the shell IPC accepts for a runtime task: a task id and
// one of the closed actions. Strict, so an unknown field is a refusal.

export const controlSchema = z.strictObject({
  taskId: z.string(),
  action: z.enum([
    "release-tool",
    "finish-demo",
    "compact-context-fixture",
    "confirm-context-fixture",
  ]),
});
