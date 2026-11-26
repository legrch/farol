import { describe, expect, it } from "vitest";
import {
  admissionLeaseFile,
  bindingKey,
  boundaryKey,
  checkpointDirectory,
  checkpointKey,
  completionFile,
  digest,
  ownerOperationKey,
  publicationFile,
  sessionFile,
  sourceDirectory,
  summaryAttemptDirectory,
  summaryDirectory,
  taskDirectory,
} from "./layout";

const binding = {
  ownerId: "owner",
  taskId: "task",
  hostThreadId: "thread",
  sessionId: "session",
  providerProfileId: "profile",
  modelId: "model",
  mode: "mode",
};
const root = "/state/context";

describe("context store layout", () => {
  it("digests the JSON form with sha256 hex", () => {
    expect(digest(["a"])).toMatch(/^[a-f0-9]{64}$/u);
    expect(digest(["a", "b"])).not.toBe(digest(["ab"]));
  });

  it("keys a binding only by owner, task, thread and session", () => {
    expect(bindingKey(binding)).toBe(
      digest(["owner", "task", "thread", "session"]),
    );
    expect(bindingKey({ ...binding, modelId: "other", mode: "x" })).toBe(
      bindingKey(binding),
    );
    expect(bindingKey({ ...binding, taskId: "other" })).not.toBe(
      bindingKey(binding),
    );
  });

  it("keys boundaries and checkpoints by their identity arrays", () => {
    const request = {
      operationId: "op",
      source: "retained_agent" as const,
      sourceBoundary: "b",
    };
    expect(boundaryKey(request)).toBe(digest(["retained_agent", "b"]));
    expect(checkpointKey("c1")).toBe(digest(["c1"]));
  });

  it("lays records out under tasks/<binding key>", () => {
    const task = `${root}/tasks/${bindingKey(binding)}`;
    expect(taskDirectory(root, binding)).toBe(task);
    expect(checkpointDirectory(root, binding)).toBe(`${task}/checkpoints`);
    expect(sourceDirectory(root, binding)).toBe(`${task}/sources`);
    expect(summaryDirectory(root, binding)).toBe(`${task}/summaries`);
    expect(summaryAttemptDirectory(root, binding)).toBe(
      `${task}/summary-attempts`,
    );
    expect(sessionFile(root, binding)).toBe(`${task}/session.json`);
    expect(completionFile(root, binding, "op")).toBe(
      `${task}/completion-${checkpointKey("op")}.json`,
    );
    expect(publicationFile(root, binding, "op")).toBe(
      `${task}/checkpoints/publication-${checkpointKey("op")}.json`,
    );
  });

  it("refuses a lease or owner path for a key that is not a sha256", () => {
    const key = bindingKey(binding);
    expect(admissionLeaseFile(root, key)).toBe(
      `${root}/tasks/${key}/admission.lock`,
    );
    expect(ownerOperationKey(root, key)).toBe(
      `${root}/tasks/${key}/.context-owner`,
    );
    expect(() => admissionLeaseFile(root, "../x")).toThrow(
      "CONTEXT_ADMISSION_LEASE_KEY_INVALID",
    );
    expect(() => ownerOperationKey(root, "../x")).toThrow(
      "CONTEXT_ADMISSION_LEASE_INVALID",
    );
  });
});
