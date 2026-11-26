import { describe, expect, it } from "vitest";
import type { HandoffWorkspace } from "../port/handoff";
import {
  boundTitleName,
  observedModel,
  observedNameInvalid,
  startedThreadId,
  threadBound,
  threadModelBound,
  threadNameInvalid,
} from "./threadbinding";

const thread = { id: "t1", projectId: "p1", cwd: "/work/root", model: "m1" };

const workspace = (
  sandbox: "read-only" | "workspace-write" = "workspace-write",
): HandoffWorkspace => ({
  root: "/work/root",
  device: "1",
  inode: "2",
  gitCommonDirectory: "/work/root/.git",
  project: {
    root: "/work/root/app",
    device: "1",
    inode: "3",
    gitCommonDirectory: "/work/root/.git",
  },
  execution: { sandbox, approvalPolicy: "on-request" },
});

describe("threadBound", () => {
  it("requires id, project and root to all match", () => {
    expect(threadBound(thread, "t1", "p1", "/work/root")).toBe(true);
    expect(threadBound(thread, "t2", "p1", "/work/root")).toBe(false);
    expect(threadBound(thread, "t1", "p2", "/work/root")).toBe(false);
    expect(threadBound(thread, "t1", "p1", "/other")).toBe(false);
    expect(threadBound(null, "t1", "p1", "/work/root")).toBe(false);
  });

  it("checks the model separately", () => {
    expect(threadModelBound(thread, "m1")).toBe(true);
    expect(threadModelBound(thread, "m2")).toBe(false);
    expect(threadModelBound(null, "m1")).toBe(false);
  });
});

describe("thread names", () => {
  it("accepts absent, null and bounded names", () => {
    expect(threadNameInvalid({})).toBe(false);
    expect(threadNameInvalid({ name: null })).toBe(false);
    expect(threadNameInvalid({ name: "ok" })).toBe(false);
    expect(threadNameInvalid({ name: 7 })).toBe(true);
    expect(threadNameInvalid({ name: "a\0b" })).toBe(true);
  });

  it("bounds observed names at 1000 characters", () => {
    expect(observedNameInvalid(undefined)).toBe(false);
    expect(observedNameInvalid("x".repeat(1_000))).toBe(false);
    expect(observedNameInvalid("x".repeat(1_001))).toBe(true);
    expect(observedNameInvalid("a\0")).toBe(true);
    expect(observedNameInvalid(3)).toBe(true);
  });

  it("bounds the observed model at 120 characters", () => {
    expect(observedModel({ model: "m1" })).toBe("m1");
    expect(observedModel({ model: "m".repeat(121) })).toBeNull();
    expect(observedModel({ model: 3 })).toBeNull();
  });
});

describe("boundTitleName", () => {
  const expected = {
    threadId: "t1",
    projectId: "p1",
    root: "/work/root",
    model: "m1",
  };

  it("returns the current name or null for an unnamed thread", () => {
    expect(boundTitleName({ ...thread, name: "Old" }, expected)).toBe("Old");
    expect(boundTitleName({ ...thread, name: null }, expected)).toBeNull();
    expect(boundTitleName(thread, expected)).toBeNull();
  });

  it("is unverified on any binding or name difference", () => {
    expect(boundTitleName(null, expected)).toBeUndefined();
    expect(boundTitleName(thread, { ...expected, model: undefined })).toBe(
      undefined,
    );
    expect(boundTitleName({ ...thread, model: "m2" }, expected)).toBe(
      undefined,
    );
    expect(boundTitleName({ ...thread, cwd: "/x" }, expected)).toBe(undefined);
    expect(boundTitleName({ ...thread, name: 7 }, expected)).toBe(undefined);
  });
});

describe("startedThreadId", () => {
  const started = {
    thread: { id: "t9", projectId: "p1" },
    cwd: "/work/root",
    model: "m1",
    approvalPolicy: "on-request",
    sandbox: { type: "workspaceWrite" },
  };
  const expected = { projectId: "p1", model: "m1", workspace: workspace() };

  it("returns the id only when every binding is echoed", () => {
    expect(startedThreadId(started, expected)).toBe("t9");
    expect(startedThreadId({ ...started, cwd: "/x" }, expected)).toBeNull();
    expect(startedThreadId({ ...started, model: "m2" }, expected)).toBeNull();
    expect(
      startedThreadId({ ...started, approvalPolicy: "untrusted" }, expected),
    ).toBeNull();
    expect(
      startedThreadId({ ...started, sandbox: { type: "readOnly" } }, expected),
    ).toBeNull();
    expect(
      startedThreadId(
        { ...started, thread: { id: "bad id", projectId: "p1" } },
        expected,
      ),
    ).toBeNull();
    expect(startedThreadId(null, expected)).toBeNull();
  });

  it("expects a read-only sandbox for a read-only workspace", () => {
    expect(
      startedThreadId(
        { ...started, sandbox: { type: "readOnly" } },
        { ...expected, workspace: workspace("read-only") },
      ),
    ).toBe("t9");
  });
});
