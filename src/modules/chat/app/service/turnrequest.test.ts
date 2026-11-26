import { describe, expect, it } from "vitest";
import type { HandoffWorkspace } from "../port/handoff";
import {
  latestTurnsParams,
  sandboxPolicy,
  sandboxType,
  steerParams,
  threadReadParams,
  threadStartParams,
  turnStartParams,
} from "./turnrequest";

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

describe("sandbox mapping", () => {
  it("maps read-only and writable workspaces", () => {
    expect(sandboxType(workspace("read-only").execution)).toBe("readOnly");
    expect(sandboxType(workspace().execution)).toBe("workspaceWrite");
    expect(sandboxPolicy(workspace("read-only"))).toEqual({
      type: "readOnly",
      networkAccess: false,
    });
    expect(sandboxPolicy(workspace())).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/work/root"],
      networkAccess: false,
    });
  });
});

describe("request parameters", () => {
  it("reads a thread without its turns", () => {
    expect(threadReadParams("t1")).toEqual({
      threadId: "t1",
      includeTurns: false,
    });
  });

  it("lists the newest turns without loading items", () => {
    expect(latestTurnsParams("t1", 2)).toEqual({
      threadId: "t1",
      cursor: null,
      limit: 2,
      sortDirection: "desc",
      itemsView: "notLoaded",
    });
  });

  it("starts a thread with no provider model fallback", () => {
    expect(threadStartParams("p1", workspace(), "model-a")).toEqual({
      projectId: "p1",
      cwd: "/work/root",
      ephemeral: false,
      model: "model-a",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      allowProviderModelFallback: false,
    });
  });

  it("starts a turn and omits an absent effort", () => {
    const base = turnStartParams("t1", "hi", workspace(), "model-a", undefined);
    expect(base).not.toHaveProperty("effort");
    expect(base.input).toEqual([{ type: "text", text: "hi" }]);
    expect(base.sandboxPolicy.type).toBe("workspaceWrite");
    expect(
      turnStartParams("t1", "hi", workspace(), "model-a", "high"),
    ).toMatchObject({ effort: "high" });
  });

  it("keeps the key order the host request used", () => {
    expect(
      Object.keys(turnStartParams("t1", "hi", workspace(), "m", "high")),
    ).toEqual([
      "threadId",
      "input",
      "cwd",
      "model",
      "effort",
      "approvalPolicy",
      "sandboxPolicy",
    ]);
  });

  it("steers the expected turn with the caller message id", () => {
    expect(steerParams("t1", "u1", "more", "m1")).toEqual({
      threadId: "t1",
      expectedTurnId: "u1",
      input: [{ type: "text", text: "more" }],
      clientUserMessageId: "m1",
    });
  });
});
