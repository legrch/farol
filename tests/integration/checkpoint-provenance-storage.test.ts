import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachCheckpointSummarizer,
  createCheckpointEnvelope,
  type CheckpointEnvelope,
  type CheckpointEnvelopeV1,
  type CheckpointSummarizer,
} from "../../src/modules/chat/domain/checkpoint";
import {
  beginCompaction,
  createContextSession,
  requestCheckpoint,
} from "../../src/modules/chat/domain/context-continuity";
import {
  authoritativeHistoryFacts,
  buildHostCompactionHandoff,
  HOST_CHECKPOINT_PREFIX,
  parseHostCompactionRequest,
  replayHostCheckpoint,
  type HostCompactionEndpoint,
  type HostCompactionHandoff,
  type ParsedHostCompaction,
} from "../../src/modules/chat/infra/client/host-compaction-codec";
import { PrivateContextStore } from "../../src/modules/chat/infra/repo/private-context-store";

// Synthetic store/codec evidence only. Restart means a new store instance,
// never a new process, native host, browser, provider, or live model observation.
const maximumContentBytes = 16_384;
const budget = {
  maximumCheckpointContentBytes: maximumContentBytes,
  retainedTailMaximumBytes: 16_384,
  maximumHandoffBytes: 64 * 1_024,
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function storeRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "checkpoint-provenance-"),
  );
  roots.push(root);
  return root;
}

function value<T>(result: {
  ok: boolean;
  value?: T;
  error?: { code: string };
}): T {
  if (!result.ok || result.value === undefined) {
    throw new Error(result.error?.code ?? "EXPECTED_SUCCESS");
  }
  return result.value;
}

function requestFor(endpoint: HostCompactionEndpoint): ParsedHostCompaction {
  const input = [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Observe write-fixture; do not retry." },
      ],
    },
    {
      type: "function_call",
      call_id: "write-fixture",
      name: "synthetic_write",
      arguments: "{}",
    },
  ];
  return value(
    parseHostCompactionRequest(
      endpoint,
      endpoint === "responses_compact"
        ? { model: "fixture-continuation-model", input }
        : {
            model: "fixture-continuation-model",
            stream: true,
            input: [...input, { type: "compaction_trigger" }],
          },
      JSON.stringify({ thread_id: "fixture-thread", turn_id: "fixture-turn" }),
    ),
  );
}

// Deliberately independent of today's writer and validator: this is the old
// envelope shape as stored inside the unchanged schemaVersion: 1 disk record.
function legacyEnvelope(request: ParsedHostCompaction): CheckpointEnvelopeV1 {
  return {
    schemaVersion: 1,
    checkpointId: "fixture-checkpoint",
    operationId: "fixture-compaction",
    providerOperationId: "fixture-summary-operation",
    binding: {
      ownerId: "fixture-owner",
      taskId: "fixture-task",
      hostThreadId: "fixture-thread",
      sessionId: "fixture-session",
      providerProfileId: "fixture-continuation-profile",
      modelId: "fixture-continuation-model",
      mode: "fixture-continuation-mode",
    },
    epoch: 1,
    source: "canonical_history",
    sourceBoundary: request.sourceBoundary,
    sourceCursor: "fixture-turn:tail",
    parentCheckpointId: "fixture-parent-checkpoint",
    provider: {
      profileId: "fixture-continuation-profile",
      modelId: "fixture-continuation-model",
      mode: "fixture-continuation-mode",
    },
    createdAt: 1_000,
    validation: "validated",
    content: {
      goal: "Continue the synthetic task without repeating uncertain effects.",
      activeConstraints: ["Never retry an outcome-unknown write."],
      latestCorrections: ["Observe write-fixture first."],
      keyDecisions: [
        "Keep source evidence separate from continuation identity.",
      ],
      completedWork: [
        {
          description: "Fixture read completed.",
          evidenceRefs: ["fixture-receipt"],
        },
      ],
      unfinishedWork: ["Read the outstanding operation status."],
      unresolvedQuestions: ["Did write-fixture complete?"],
      unknownOutcomes: [
        { operationRef: "write-fixture", description: "Result not received." },
      ],
      artifactRefs: [
        { reference: "fixture-artifact", availability: "available" },
      ],
      attachmentRefs: [
        { reference: "fixture-attachment", availability: "unavailable" },
      ],
      nextSafeStep: "Observe the existing operation before any further write.",
    },
  };
}

function provenanceFor(
  checkpoint: CheckpointEnvelopeV1,
  engine: CheckpointSummarizer["engine"],
): CheckpointSummarizer {
  const source = {
    providerOperationId: checkpoint.providerOperationId,
    sourceBoundary: checkpoint.sourceBoundary,
    sourceCursor: checkpoint.sourceCursor,
  };
  return engine === "current_chatgpt"
    ? {
        ...source,
        engine,
        provider: "chatgpt-web",
        observedModel: null,
        observedEffort: null,
      }
    : {
        ...source,
        engine,
        provider: "codex",
        // Independently stated fixture observations, not a real model claim
        // or a copy of the continuation model/mode.
        observedModel: "fixture-summary-model",
        observedEffort: "fixture-summary-effort",
      };
}

function createV1(request: ParsedHostCompaction): CheckpointEnvelopeV1 {
  const expected = legacyEnvelope(request);
  const session = value(
    requestCheckpoint(
      value(
        beginCompaction(createContextSession(expected.binding), {
          operationId: expected.operationId,
          source: expected.source,
          sourceBoundary: expected.sourceBoundary,
        }),
      ),
    ),
  );
  const checkpoint = createCheckpointEnvelope(session, expected.content, {
    checkpointId: expected.checkpointId,
    providerOperationId: expected.providerOperationId,
    parentCheckpointId: expected.parentCheckpointId,
    sourceCursor: expected.sourceCursor,
    createdAt: expected.createdAt,
  });
  expect(checkpoint).toEqual(expected);
  return checkpoint;
}

// The persisted path and wrapper are part of the existing v1 storage fixture.
function recordFile(root: string, checkpoint: CheckpointEnvelope): string {
  const digest = (parts: string[]) =>
    createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  const binding = checkpoint.binding;
  return path.join(
    root,
    "tasks",
    digest([
      binding.ownerId,
      binding.taskId,
      binding.hostThreadId,
      binding.sessionId,
    ]),
    "checkpoints",
    `${digest([checkpoint.checkpointId])}.json`,
  );
}

function recordBytes(checkpoint: CheckpointEnvelope): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "context_checkpoint",
    checkpoint,
  });
}

function replayInput(handoff: HostCompactionHandoff): readonly unknown[] {
  return handoff.variant === "unary_replacement_history"
    ? handoff.response.output
    : [handoff.item];
}

function marker(checkpoint: CheckpointEnvelope): string {
  return (
    HOST_CHECKPOINT_PREFIX +
    Buffer.from(JSON.stringify(checkpoint)).toString("base64url")
  );
}

const corruptions = [
  {
    field: "providerOperationId",
    target: "summarizer",
    code: "CHECKPOINT_SUMMARIZER_BINDING_MISMATCH",
  },
  {
    field: "sourceCursor",
    target: "summarizer",
    code: "CHECKPOINT_SUMMARIZER_BINDING_MISMATCH",
  },
  {
    field: "sourceBoundary",
    target: "summarizer",
    code: "CHECKPOINT_SUMMARIZER_BINDING_MISMATCH",
  },
  {
    field: "modelId",
    target: "provider",
    code: "CHECKPOINT_PROVIDER_BINDING_MISMATCH",
  },
  {
    field: "profileId",
    target: "provider",
    code: "CHECKPOINT_PROVIDER_BINDING_MISMATCH",
  },
  {
    field: "mode",
    target: "provider",
    code: "CHECKPOINT_PROVIDER_BINDING_MISMATCH",
  },
] as const;

describe.each(["responses_compact", "responses"] as const)(
  "checkpoint provenance storage: %s",
  (endpoint) => {
    it("reads pre-existing v1 bytes unchanged and replays without inventing provenance", async () => {
      const request = requestFor(endpoint);
      const legacy = legacyEnvelope(request);
      const root = await storeRoot();
      const file = recordFile(root, legacy);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      // Keep distinct whitespace to detect even an equivalent read-time rewrite.
      const bytes =
        JSON.stringify(JSON.parse(recordBytes(legacy)), null, 2) + "\n";
      await fs.writeFile(file, bytes, { mode: 0o600 });
      for (let instance = 0; instance < 2; instance += 1) {
        const store = new PrivateContextStore({ root });
        const loaded = await store.get(legacy.binding, legacy.checkpointId);
        expect(loaded).toEqual(legacy);
        expect(loaded).not.toHaveProperty("summarizer");
        const handoff = value(
          buildHostCompactionHandoff(request, loaded, budget),
        );
        expect(
          value(
            replayHostCheckpoint(replayInput(handoff), maximumContentBytes),
          ),
        ).toEqual({
          origin: request.variant,
          checkpoint: legacy,
        });
        expect(await fs.readFile(file, "utf8")).toBe(bytes);
      }
    });

    describe.each(["codex_luna", "current_chatgpt"] as const)(
      "%s",
      (engine) => {
        it("persists explicit v2 provenance and unknown effects through fresh-store handoff/replay", async () => {
          const request = requestFor(endpoint);
          const original = createV1(request);
          const before = structuredClone(original);
          const provenance = provenanceFor(original, engine);
          const checkpoint = value(
            attachCheckpointSummarizer(
              original,
              provenance,
              maximumContentBytes,
            ),
          );
          expect(checkpoint).toEqual({
            ...before,
            schemaVersion: 2,
            summarizer: provenance,
          });
          expect(original).toEqual(before);
          expect(original).not.toHaveProperty("summarizer");
          const root = await storeRoot();
          const store = new PrivateContextStore({ root });
          await store.put(checkpoint);
          await expect(
            store.get(original.binding, original.checkpointId),
          ).resolves.toEqual(checkpoint);
          const bytes = await fs.readFile(recordFile(root, checkpoint), "utf8");
          expect(JSON.parse(bytes)).toEqual({
            schemaVersion: 1,
            kind: "context_checkpoint",
            checkpoint,
          });

          const restarted = new PrivateContextStore({ root });
          const loaded = await restarted.get(
            original.binding,
            original.checkpointId,
          );
          expect(loaded).toEqual(checkpoint);
          const handoff = value(
            buildHostCompactionHandoff(request, loaded, budget),
          );
          expect(handoff.variant).toBe(request.variant);
          const history = replayInput(handoff);
          const replayed = value(
            replayHostCheckpoint(history, maximumContentBytes),
          );
          expect(replayed).toEqual({ origin: request.variant, checkpoint });
          expect(
            authoritativeHistoryFacts(history, maximumContentBytes).unresolved,
          ).toEqual(original.content.unknownOutcomes);
          // Replayed data remains acceptable as exactly the same durable record.
          await restarted.put(replayed.checkpoint);
          expect(await fs.readFile(recordFile(root, checkpoint), "utf8")).toBe(
            bytes,
          );
          for (const selected of [
            { ...original.binding, modelId: "other-continuation-model" },
            {
              ...original.binding,
              providerProfileId: "other-continuation-provider",
            },
          ]) {
            await expect(
              restarted.get(selected, original.checkpointId),
            ).rejects.toThrow("CHECKPOINT_BINDING_MISMATCH");
          }
        });

        it.each(corruptions)(
          "rejects detached $target.$field at write, disk read, handoff and replay",
          async ({ field, target, code }) => {
            const request = requestFor(endpoint);
            const original = createV1(request);
            const provenance = provenanceFor(original, engine);
            const checkpoint = value(
              attachCheckpointSummarizer(
                original,
                provenance,
                maximumContentBytes,
              ),
            );
            if (checkpoint.schemaVersion !== 2) throw new Error("EXPECTED_V2");
            const invalid = {
              ...checkpoint,
              [target]: {
                ...checkpoint[target],
                [field]: "detached-fixture-value",
              },
            };
            expect(
              attachCheckpointSummarizer(
                target === "provider"
                  ? { ...original, provider: invalid.provider }
                  : original,
                invalid.summarizer,
                maximumContentBytes,
              ),
            ).toMatchObject({ ok: false, error: { code } });
            const root = await storeRoot();
            const store = new PrivateContextStore({ root });
            await expect(store.put(invalid)).rejects.toThrow(code);
            await expect(
              store.get(original.binding, original.checkpointId),
            ).resolves.toBeNull();
            expect(
              buildHostCompactionHandoff(request, invalid, budget),
            ).toMatchObject({
              ok: false,
              error: { code: "HOST_CHECKPOINT_INVALID" },
            });

            const handoff = value(
              buildHostCompactionHandoff(request, checkpoint, budget),
            );
            const wire = JSON.stringify(replayInput(handoff));
            expect(wire).toContain(marker(checkpoint));
            const tamperedHistory: unknown[] = JSON.parse(
              wire.replace(marker(checkpoint), marker(invalid)),
            );
            expect(
              replayHostCheckpoint(tamperedHistory, maximumContentBytes),
            ).toMatchObject({
              ok: false,
              error: { code: "HOST_CHECKPOINT_INVALID" },
            });

            await store.put(checkpoint);
            const file = recordFile(root, checkpoint);
            await fs.writeFile(file, recordBytes(invalid), { mode: 0o600 });
            const restarted = new PrivateContextStore({ root });
            await expect(
              restarted.get(original.binding, original.checkpointId),
            ).rejects.toThrow(code);
            expect(await fs.readFile(file, "utf8")).toBe(recordBytes(invalid));
          },
        );
      },
    );
  },
);
