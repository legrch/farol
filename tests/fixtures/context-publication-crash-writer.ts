import { createHash } from "node:crypto";
import path from "node:path";
import { createCheckpointEnvelope } from "../../src/modules/chat/domain/checkpoint";
import {
  beginCompaction,
  createContextSession,
  recordValidatedCheckpoint,
  requestCheckpoint,
} from "../../src/modules/chat/domain/context-continuity";
import {
  PrivateContextStore,
  type StoredContextSource,
} from "../../src/modules/chat/infra/repo/private-context-store";

const [stateRoot, crashPoint] = process.argv.slice(2);
if (
  !stateRoot ||
  !["source", "intent", "checkpoint"].includes(crashPoint ?? "")
)
  throw new Error("CONTEXT_PUBLICATION_FIXTURE_INVALID");
const binding = {
  ownerId: "fixture-owner",
  taskId: "fixture-task",
  hostThreadId: "fixture-thread",
  sessionId: "fixture-session",
  providerProfileId: "fixture-profile",
  modelId: "fixture-model",
  mode: "fixture-mode",
};
const source: StoredContextSource = {
  schemaVersion: 1,
  operationId: "fixture-operation",
  binding,
  source: "canonical_history",
  sourceBoundary: "fixture-boundary",
  variant: "unary_replacement_history",
  history: [
    { type: "message", role: "user", content: "Keep the original source." },
  ],
};
function value<T>(r: { ok: boolean; value?: T }): T {
  if (!r.ok || r.value === undefined) throw new Error("FIXTURE_RESULT_INVALID");
  return r.value;
}
const request = {
  operationId: source.operationId,
  source: source.source,
  sourceBoundary: source.sourceBoundary,
};
const session = value(
  requestCheckpoint(
    value(beginCompaction(createContextSession(binding), request)),
  ),
);
const checkpoint = createCheckpointEnvelope(
  session,
  {
    goal: "Keep the original source.",
    activeConstraints: ["Do not replay unknown work."],
    latestCorrections: [],
    keyDecisions: [],
    completedWork: [],
    unfinishedWork: [],
    unresolvedQuestions: [],
    unknownOutcomes: [
      {
        operationRef: "fixture-unknown",
        description: "Original acknowledgement was lost.",
      },
    ],
    artifactRefs: [],
    attachmentRefs: [],
    nextSafeStep: "Observe the original operation.",
  },
  {
    checkpointId: "fixture-checkpoint",
    providerOperationId: "fixture-summary",
    parentCheckpointId: null,
    sourceCursor: "fixture-cursor",
    createdAt: 1000,
  },
);
const store = new PrivateContextStore(
  { root: path.resolve(stateRoot) },
  {
    afterExclusivePublish: async (target) => {
      const directory = path.basename(path.dirname(target));
      const selected =
        crashPoint === "source"
          ? directory === "sources"
          : directory === "checkpoints" &&
            (crashPoint === "intent") ===
              path.basename(target).startsWith("publication-");
      if (!selected) return;
      process.stdout.write(`${JSON.stringify({ target })}\n`);
      // A referenced, bounded fixture lifetime keeps Node alive until the parent
      // deliberately terminates this exact original writer. Unsettled top-level
      // await alone exits naturally with code 13 and cannot prove injected death.
      await new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("CONTEXT_CRASH_FIXTURE_TIMEOUT")),
          20_000,
        );
      });
    },
  },
);
await store.putSource(source);
const owner = await store.acquireCompactionAdmission(binding, 1, request);
if (owner.status !== "acquired") throw new Error("FIXTURE_ADMISSION_FAILED");
await store.save(
  value(recordValidatedCheckpoint(session, checkpoint)),
  owner.lease,
);
await store.publishCheckpoint(
  {
    checkpoint,
    expected: {
      source,
      sourceEpoch: 1,
      sourceSHA256: createHash("sha256")
        .update(JSON.stringify(source))
        .digest("hex"),
      policy: store.checkpointPublicationPolicy(),
    },
  },
  owner.lease,
);
