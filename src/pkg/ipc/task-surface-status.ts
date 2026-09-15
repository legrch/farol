import { z } from "zod";

export const TaskSurfaceStatusSchema = z.strictObject({
  taskId: z.string().min(1),
  state: z.enum(["ready", "failed"]),
  error: z.string().nullable(),
});

export type TaskSurfaceStatus = z.infer<typeof TaskSurfaceStatusSchema>;
