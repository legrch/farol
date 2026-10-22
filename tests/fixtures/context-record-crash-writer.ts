import path from "node:path";
import type { ContextBinding } from "../../src/modules/chat/domain/context-continuity";
import { PrivateContextStore } from "../../src/modules/chat/infra/repo/private-context-store";

const [stateRoot, crashPoint] = process.argv.slice(2);
if (!stateRoot || (crashPoint !== "lease" && crashPoint !== "admission")) {
  throw new Error("CONTEXT_CRASH_FIXTURE_ARGUMENTS_INVALID");
}

const binding: ContextBinding = {
  ownerId: "owner-preview",
  taskId: "task-atlantic",
  hostThreadId: "thread-atlantic",
  sessionId: "session-atlantic",
  providerProfileId: "profile-isolated-farol",
  modelId: "chatgpt-web/high",
  mode: "high",
};

const store = new PrivateContextStore(
  { root: path.resolve(stateRoot) },
  {
    afterExclusivePublish: async (target) => {
      const selected =
        crashPoint === "lease"
          ? path.basename(target) === "admission.lock"
          : path.basename(path.dirname(target)) === "epochs";
      if (!selected) return;
      process.stdout.write(`${JSON.stringify({ target })}\n`);
      await new Promise<never>(() => undefined);
    },
  },
);

await store.acquireCompactionAdmission(binding, 1, {
  operationId: "compact-atlantic-1",
  source: "retained_agent",
  sourceBoundary: "message-42",
});
