import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCheckpointEnvelope,
  type CheckpointEnvelope,
} from "../../src/modules/chat/domain/checkpoint";
import {
  beginCompaction,
  createContextSession,
  recordValidatedCheckpoint,
  requestCheckpoint,
  type ContextBinding,
  type ContextSession,
} from "../../src/modules/chat/domain/context-continuity";
import {
  PrivateContextStore,
  type StoredContextSource,
} from "../../src/modules/chat/infra/repo/private-context-store";

// Real disposable filesystem bytes and existing owner records. These fixtures
// do not exercise a native host, provider, account grant, or Go source mapping.
const binding: ContextBinding = {
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
function compactionRequest() {
  return {
    operationId: source.operationId,
    source: source.source,
    sourceBoundary: source.sourceBoundary,
  };
}
function requested(): ContextSession {
  return value(
    requestCheckpoint(
      value(
        beginCompaction(createContextSession(binding), compactionRequest()),
      ),
    ),
  );
}
function checkpoint(): CheckpointEnvelope {
  return createCheckpointEnvelope(
    requested(),
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
}
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function root(): Promise<string> {
  const r = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-checkpoint-publication-"),
  );
  roots.push(r);
  return r;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const key = (s: string) =>
  createHash("sha256")
    .update(JSON.stringify([s]))
    .digest("hex");
function taskDirectory(r: string): string {
  return path.join(
    r,
    "tasks",
    createHash("sha256")
      .update(
        JSON.stringify([
          binding.ownerId,
          binding.taskId,
          binding.hostThreadId,
          binding.sessionId,
        ]),
      )
      .digest("hex"),
  );
}

describe("immutable original context publication", () => {
  it.each(["source", "checkpoint"] as const)(
    "cannot replace an original %s while the first publication is paused",
    async (kind) => {
      const r = await root();
      const entered = deferred();
      const resume = deferred();
      const directory = kind === "source" ? "sources" : "checkpoints";
      let first = true;
      const writer = new PrivateContextStore(
        { root: r },
        {
          beforeCommit: async (target) => {
            if (path.basename(path.dirname(target)) === directory && first) {
              first = false;
              entered.resolve();
              await resume.promise;
            }
          },
        },
      );
      const original =
        kind === "source" ? writer.putSource(source) : writer.put(checkpoint());
      await entered.promise;
      const other = new PrivateContextStore({ root: r });
      const changed =
        kind === "source"
          ? other.putSource({ ...source, history: [{ changed: true }] })
          : other.put({
              ...checkpoint(),
              content: { ...checkpoint().content, goal: "Changed original" },
            });
      // The second writer reaches publication before the first rename resumes.
      await changed;
      resume.resolve();
      await expect(original).rejects.toThrow(
        kind === "source"
          ? "CONTEXT_SOURCE_ID_CONFLICT"
          : "CHECKPOINT_ID_CONFLICT",
      );
      expect(
        kind === "source"
          ? await other.getSource(binding, source.operationId)
          : await other.get(binding, checkpoint().checkpointId),
      ).toEqual(
        kind === "source"
          ? { ...source, history: [{ changed: true }] }
          : {
              ...checkpoint(),
              content: { ...checkpoint().content, goal: "Changed original" },
            },
      );
    },
  );

  it("rejects unrelated hardlinks rather than treating them as owner publication", async () => {
    const r = await root();
    const store = new PrivateContextStore({ root: r });
    await store.putSource(source);
    const file = path.join(
      taskDirectory(r),
      "sources",
      `${key(source.operationId)}.json`,
    );
    await fs.link(file, path.join(r, "unrelated-link"));
    await expect(store.getSource(binding, source.operationId)).rejects.toThrow(
      /UNSAFE|PUBLICATION_INCOMPLETE/u,
    );
  });
});

async function admitted(store: PrivateContextStore) {
  await store.putSource(source);
  const owner = await store.acquireCompactionAdmission(
    binding,
    1,
    compactionRequest(),
  );
  if (owner.status !== "acquired") throw new Error("FIXTURE_ADMISSION_FAILED");
  await store.save(
    value(recordValidatedCheckpoint(requested(), checkpoint())),
    owner.lease,
  );
  return owner.lease;
}
function publication(store: PrivateContextStore) {
  return {
    checkpoint: checkpoint(),
    expected: {
      source,
      sourceEpoch: 1,
      sourceSHA256: createHash("sha256")
        .update(JSON.stringify(source))
        .digest("hex"),
      policy: store.checkpointPublicationPolicy(),
    },
  };
}

describe("original context owner durable publication", () => {
  it("publishes exact original source, policy and UNKNOWN evidence and only observes on restart", async () => {
    const r = await root();
    const store = new PrivateContextStore({ root: r });
    const lease = await admitted(store);
    const request = publication(store);
    const receipt = await store.publishCheckpoint(request, lease);
    expect(receipt.status).toBe("published");
    expect(receipt.request).toEqual(request);
    expect(receipt.request.checkpoint.content.unknownOutcomes).toEqual(
      checkpoint().content.unknownOutcomes,
    );
    await store.releaseCompactionAdmission(lease);
    const restarted = new PrivateContextStore({ root: r });
    expect(
      await restarted.observeCheckpoint(binding, source.operationId),
    ).toEqual(receipt);
    // The original completed operation can be read without a reacquired grant.
    expect(await restarted.publishCheckpoint(request, lease)).toEqual(receipt);
    receipt.request.expected.source.history.push({ changed: true });
    expect(
      await restarted.observeCheckpoint(binding, source.operationId),
    ).not.toEqual(receipt);
  });

  it.each(["source", "policy", "binding", "epoch", "operation"] as const)(
    "refuses changed complete %s identity before any publication",
    async (field) => {
      const r = await root();
      const store = new PrivateContextStore({ root: r });
      const lease = await admitted(store);
      let request = structuredClone(publication(store));
      if (field === "source") {
        request.expected.source.history.push({ changed: true });
        request.expected.sourceSHA256 = createHash("sha256")
          .update(JSON.stringify(request.expected.source))
          .digest("hex");
      }
      if (field === "policy")
        request = {
          ...request,
          expected: {
            ...request.expected,
            policy: {
              ...request.expected.policy,
              maxCheckpointsPerTask:
                request.expected.policy.maxCheckpointsPerTask + 1,
            },
          },
        };
      if (field === "binding")
        request = {
          ...request,
          checkpoint: {
            ...request.checkpoint,
            binding: {
              ...request.checkpoint.binding,
              modelId: request.checkpoint.binding.modelId + "-changed",
            },
          },
        };
      if (field === "epoch") request.expected.sourceEpoch += 1;
      if (field === "operation")
        request = {
          ...request,
          checkpoint: {
            ...request.checkpoint,
            operationId: request.checkpoint.operationId + "-changed",
          },
        };
      await expect(store.publishCheckpoint(request, lease)).rejects.toThrow(
        /CHANGED|MISMATCH/u,
      );
      expect(
        (
          await fs
            .readdir(path.join(taskDirectory(r), "checkpoints"))
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return [];
              throw error;
            })
        ).filter((n) => n.startsWith("publication-")),
      ).toEqual([]);
      expect(await store.get(binding, checkpoint().checkpointId)).toBeNull();
      await store.releaseCompactionAdmission(lease);
    },
  );

  it("positive identifiers without the actual original admission lease and session cannot publish", async () => {
    const r = await root();
    const store = new PrivateContextStore({ root: r });
    await store.putSource(source);
    await expect(
      store.publishCheckpoint(publication(store), {
        sessionKey: path.basename(taskDirectory(r)),
        token: "0".repeat(32),
      }),
    ).rejects.toThrow(/LEASE|OWNER/u);
    const lease = await admitted(store);
    await store.save(requested(), lease);
    await expect(
      store.publishCheckpoint(publication(store), lease),
    ).rejects.toThrow("CONTEXT_PUBLICATION_SESSION_CHANGED");
    await store.releaseCompactionAdmission(lease);
  });

  it.each(["intent", "checkpoint"] as const)(
    "observes original %s publication after lost ACK and never writes it again",
    async (point) => {
      const r = await root();
      let publications = 0;
      const store = new PrivateContextStore(
        { root: r },
        {
          afterExclusivePublish: async (target) => {
            if (path.basename(path.dirname(target)) !== "checkpoints") return;
            publications += 1;
            if (
              (point === "intent") ===
              path.basename(target).startsWith("publication-")
            )
              throw new Error("FIXTURE_LOST_ACK");
          },
        },
      );
      const lease = await admitted(store);
      const request = publication(store);
      await expect(store.publishCheckpoint(request, lease)).rejects.toThrow(
        "CONTEXT_PUBLICATION_OUTCOME_UNKNOWN",
      );
      const restarted = new PrivateContextStore({ root: r });
      const observed = await restarted.observeCheckpoint(
        binding,
        source.operationId,
      );
      expect(observed.status).toBe(
        point === "intent" ? "outcome_unknown" : "published",
      );
      expect(observed.status !== "absent" && observed.request).toEqual(request);
      const before = publications;
      if (point === "intent") {
        await expect(store.publishCheckpoint(request, lease)).rejects.toThrow(
          "CONTEXT_PUBLICATION_OUTCOME_UNKNOWN",
        );
        await expect(
          store.deleteSource(binding, source.operationId),
        ).rejects.toThrow("CONTEXT_PUBLICATION_SOURCE_RETAINED");
        await expect(store.deleteTask(binding)).rejects.toThrow(
          "CONTEXT_PUBLICATION_TASK_RETAINED",
        );
      } else {
        expect((await store.publishCheckpoint(request, lease)).status).toBe(
          "published",
        );
      }
      expect(publications).toBe(before);
      await store.releaseCompactionAdmission(lease);
    },
  );

  it("distinguishes proven absence from preexisting original admission or legacy checkpoint", async () => {
    const r = await root();
    const store = new PrivateContextStore({ root: r });
    expect(await store.observeCheckpoint(binding, source.operationId)).toEqual({
      status: "absent",
    });
    const lease = await admitted(store);
    expect(
      (await store.observeCheckpoint(binding, source.operationId)).status,
    ).toBe("outcome_unknown");
    await store.releaseCompactionAdmission(lease);
    const otherRoot = await root();
    const legacy = new PrivateContextStore({ root: otherRoot });
    await legacy.put(checkpoint());
    expect(
      (await legacy.observeCheckpoint(binding, source.operationId)).status,
    ).toBe("outcome_unknown");
  });

  it("serializes original lease release, source deletion and session replacement while publishing", async () => {
    const r = await root();
    const entered = deferred();
    const resume = deferred();
    const store = new PrivateContextStore(
      { root: r },
      {
        beforeCommit: async (target) => {
          if (path.basename(target).startsWith("publication-")) {
            entered.resolve();
            await resume.promise;
          }
        },
      },
    );
    const lease = await admitted(store);
    const publishing = store.publishCheckpoint(publication(store), lease);
    await entered.promise;
    const peer = new PrivateContextStore({ root: r });
    let released = false;
    let saved = false;
    let deleted = false;
    const saving = peer
      .save(value(recordValidatedCheckpoint(requested(), checkpoint())), lease)
      .then(() => {
        saved = true;
      });
    const deleting = peer.deleteSource(binding, source.operationId).then(
      () => {
        deleted = true;
        return "deleted";
      },
      (error: Error) => error.message,
    );
    const releasing = peer.releaseCompactionAdmission(lease).then(() => {
      released = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect({ released, saved, deleted }).toEqual({
      released: false,
      saved: false,
      deleted: false,
    });
    resume.resolve();
    expect((await publishing).status).toBe("published");
    expect(await deleting).toBe("CONTEXT_PUBLICATION_SOURCE_RETAINED");
    await Promise.all([saving, releasing]);
    expect(
      (await peer.observeCheckpoint(binding, source.operationId)).status,
    ).toBe("published");
  });

  it("retains exact publication evidence when legacy retention would prune it", async () => {
    const r = await root();
    const store = new PrivateContextStore({
      root: r,
      maxCheckpointsPerTask: 1,
    });
    const lease = await admitted(store);
    const original = await store.publishCheckpoint(publication(store), lease);
    await store.releaseCompactionAdmission(lease);
    await store.put({
      ...checkpoint(),
      checkpointId: "fixture-later",
      operationId: "fixture-later-operation",
      createdAt: 2000,
    });
    expect(await store.observeCheckpoint(binding, source.operationId)).toEqual(
      original,
    );
  });
});

describe("original sealed record process-death fixtures", () => {
  it.each(["source", "intent", "checkpoint"] as const)(
    "observes exact %s bytes after the original writer exits",
    async (point) => {
      const r = await root();
      const fixture = await root();
      const bundle = path.join(fixture, "writer.mjs");
      await build({
        entryPoints: [
          path.resolve("tests/fixtures/context-publication-crash-writer.ts"),
        ],
        outfile: bundle,
        bundle: true,
        platform: "node",
        format: "esm",
        logLevel: "silent",
      });
      const child = spawn(process.execPath, [bundle, r, point], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      const exit = once(child, "exit").then(([code, signal]) => {
        settled = true;
        return {
          code: code as number | null,
          signal: signal as NodeJS.Signals | null,
        };
      });
      try {
        const target = await new Promise<string>((resolve, reject) => {
          let text = "";
          child.stdout!.on("data", (chunk) => {
            text += chunk.toString();
            if (text.includes("\n")) {
              try {
                resolve(
                  (JSON.parse(text.split("\n")[0]!) as { target: string })
                    .target,
                );
              } catch (error) {
                reject(error);
              }
            }
          });
          child.on("error", reject);
          child.on("exit", () => {
            if (!text.includes("\n"))
              reject(new Error("FIXTURE_WRITER_EXITED_EARLY"));
          });
        });
        expect((await fs.lstat(target)).nlink).toBe(2);
        expect(child.kill("SIGKILL")).toBe(true);
        expect(await exit).toEqual({ code: null, signal: "SIGKILL" });
        const restarted = new PrivateContextStore({ root: r });
        const observed = await restarted.observeCheckpoint(
          binding,
          source.operationId,
        );
        expect(observed.status).toBe(
          point === "source"
            ? "absent"
            : point === "checkpoint"
              ? "published"
              : "outcome_unknown",
        );
        if (point !== "source")
          expect(observed.status !== "absent" && observed.request).toEqual(
            publication(restarted),
          );
        expect(await restarted.getSource(binding, source.operationId)).toEqual(
          source,
        );
        expect((await fs.lstat(target)).nlink).toBe(1);
      } finally {
        if (!settled) {
          child.kill("SIGKILL");
          await exit;
        }
      }
    },
  );
});

describe("durable publication complete refusal and observation", () => {
  it.each(["summary", "retirement"] as const)(
    "never reports an existing %s operation as absent",
    async (record) => {
      const r = await root();
      const store = new PrivateContextStore({ root: r });
      if (record === "summary")
        await store.putSummary({
          schemaVersion: 1,
          operationId: source.operationId,
          binding,
          providerOperationId: "fixture-summary",
          sourceCursor: "fixture-cursor",
          content: checkpoint().content,
        });
      else
        await store.putRetirement({
          schemaVersion: 1,
          operationId: source.operationId,
          binding,
          epoch: 1,
          sourceCursor: "fixture-cursor",
        });
      expect(
        (await store.observeCheckpoint(binding, source.operationId)).status,
      ).toBe("outcome_unknown");
    },
  );
  it("rejects foreign binding and changed admitted operation instead of interpreting them as a new publication", async () => {
    const r = await root();
    const store = new PrivateContextStore({ root: r });
    const lease = await admitted(store);
    await store.publishCheckpoint(publication(store), lease);
    await expect(
      store.observeCheckpoint(
        { ...binding, providerProfileId: "fixture-foreign-profile" },
        source.operationId,
      ),
    ).rejects.toThrow("CONTEXT_PUBLICATION_BINDING_MISMATCH");
    const changed = publication(store);
    await expect(
      store.publishCheckpoint(
        {
          ...changed,
          checkpoint: {
            ...changed.checkpoint,
            content: {
              ...changed.checkpoint.content,
              goal: "Changed original checkpoint",
            },
          },
        },
        lease,
      ),
    ).rejects.toThrow("CONTEXT_PUBLICATION_OPERATION_CONFLICT");
    await store.releaseCompactionAdmission(lease);
  });
  it("preserves corrupt intent as inconclusive and retains its source/task", async () => {
    const r = await root();
    const store = new PrivateContextStore({ root: r });
    const lease = await admitted(store);
    await store.publishCheckpoint(publication(store), lease);
    await store.releaseCompactionAdmission(lease);
    const file = path.join(
      taskDirectory(r),
      "checkpoints",
      `publication-${key(source.operationId)}.json`,
    );
    await fs.writeFile(file, "{incomplete", { mode: 0o600 });
    await expect(
      store.observeCheckpoint(binding, source.operationId),
    ).rejects.toThrow("CONTEXT_PUBLICATION_CORRUPT");
    await expect(
      store.deleteSource(binding, source.operationId),
    ).rejects.toThrow("CONTEXT_PUBLICATION_CORRUPT");
    await expect(store.deleteTask(binding)).rejects.toThrow(
      "CONTEXT_PUBLICATION_CORRUPT",
    );
    expect(await store.getSource(binding, source.operationId)).toEqual(source);
  });
  it("requires the original process owner, not a copied token accepted by a different process instance", async () => {
    const r = await root();
    const store = new PrivateContextStore({ root: r });
    const lease = await admitted(store);
    const foreign = new PrivateContextStore(
      { root: r },
      { processInstanceId: "0".repeat(32) },
    );
    await expect(
      foreign.publishCheckpoint(publication(store), lease),
    ).rejects.toThrow("CONTEXT_PUBLICATION_OWNER_CHANGED");
    expect(await store.get(binding, checkpoint().checkpointId)).toBeNull();
    await store.releaseCompactionAdmission(lease);
  });
  it("never accepts a hardlinked publication intent as an alternate qualifier", async () => {
    const r = await root();
    const store = new PrivateContextStore({ root: r });
    const lease = await admitted(store);
    await store.publishCheckpoint(publication(store), lease);
    await store.releaseCompactionAdmission(lease);
    const file = path.join(
      taskDirectory(r),
      "checkpoints",
      `publication-${key(source.operationId)}.json`,
    );
    await fs.link(file, path.join(r, "alternate-intent-link"));
    await expect(
      store.observeCheckpoint(binding, source.operationId),
    ).rejects.toThrow("CONTEXT_PUBLICATION_PUBLICATION_INCOMPLETE");
  });
});

describe("pre-admission input and original admitted effects", () => {
  it("permits source-only input cleanup and keeps proven checkpoint absence consistent", async () => {
    const r = await root();
    const store = new PrivateContextStore({ root: r });
    await store.putSource(source);
    expect(await store.observeCheckpoint(binding, source.operationId)).toEqual({
      status: "absent",
    });
    await store.deleteSource(binding, source.operationId);
    expect(await store.observeCheckpoint(binding, source.operationId)).toEqual({
      status: "absent",
    });
    await store.putSource(source);
    await store.deleteTask(binding);
    expect(await store.observeCheckpoint(binding, source.operationId)).toEqual({
      status: "absent",
    });
  });
  it("retains original durable admission even without the new publication intent", async () => {
    const r = await root();
    const store = new PrivateContextStore({ root: r });
    const lease = await admitted(store);
    await store.releaseCompactionAdmission(lease);
    expect(
      (await store.observeCheckpoint(binding, source.operationId)).status,
    ).toBe("outcome_unknown");
    await expect(
      store.deleteSource(binding, source.operationId),
    ).rejects.toThrow("CONTEXT_PUBLICATION_SOURCE_RETAINED");
    await expect(store.deleteTask(binding)).rejects.toThrow(
      "CONTEXT_PUBLICATION_TASK_RETAINED",
    );
    expect(await store.getSource(binding, source.operationId)).toEqual(source);
    expect(
      (await store.observeCheckpoint(binding, source.operationId)).status,
    ).toBe("outcome_unknown");
  });
  it("retains an original pending compaction session rather than deleting UNKNOWN bookkeeping", async () => {
    const r = await root();
    const store = new PrivateContextStore({ root: r });
    await store.save(requested());
    expect(
      (await store.observeCheckpoint(binding, source.operationId)).status,
    ).toBe("outcome_unknown");
    await expect(store.deleteTask(binding)).rejects.toThrow(
      "CONTEXT_PUBLICATION_TASK_RETAINED",
    );
    expect(await store.load(binding)).toEqual(requested());
  });
  it.each(["summary", "retirement"] as const)(
    "retains original unconfirmed %s during task cleanup",
    async (record) => {
      const r = await root();
      const store = new PrivateContextStore({ root: r });
      if (record === "summary")
        await store.putSummary({
          schemaVersion: 1,
          operationId: source.operationId,
          binding,
          providerOperationId: "fixture-summary",
          sourceCursor: "fixture-cursor",
          content: checkpoint().content,
        });
      else
        await store.putRetirement({
          schemaVersion: 1,
          operationId: source.operationId,
          binding,
          epoch: 1,
          sourceCursor: "fixture-cursor",
        });
      await expect(store.deleteTask(binding)).rejects.toThrow(
        "CONTEXT_PUBLICATION_TASK_RETAINED",
      );
      expect(
        (await store.observeCheckpoint(binding, source.operationId)).status,
      ).toBe("outcome_unknown");
    },
  );
});
