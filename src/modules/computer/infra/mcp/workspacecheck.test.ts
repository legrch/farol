import { describe, expect, it } from "vitest";
import {
  workspaceVerificationRefusal,
  workspaceVerificationRequest,
} from "./workspacecheck";

describe("workspace verification", () => {
  it("names a root only for an entry that has an approved one", () => {
    const approvedRoot = { path: "/a", device: "1", inode: "2" };
    const request = workspaceVerificationRequest({ taskId: "t" }, "c", [
      { workspaceId: "w1", root: "/a", approvedRoot },
      { workspaceId: "w2", root: "/a" },
      { workspaceId: "w3" },
    ]);
    expect(request).toEqual({
      taskId: "t",
      callId: "c",
      workspaces: [
        { workspaceId: "w1", root: "/a", approvedRoot },
        { workspaceId: "w2" },
        { workspaceId: "w3" },
      ],
    });
  });

  it("refuses with code and source only", () => {
    const result = workspaceVerificationRefusal({
      ok: false,
      error: { code: "X", source: "contract", retry: "never", extra: 1 },
    } as never);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: "X", source: "contract", retry: "never" },
    });
  });
});
