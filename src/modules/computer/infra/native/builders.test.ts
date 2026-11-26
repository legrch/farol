import { describe, expect, it } from "vitest";
import {
  nativeMutationRequest,
  nativeRequest,
  testBarriers,
  validTestOptions,
} from "./builders";
import { DEFAULT_DENIED_PATHS } from "./denied";
import { WorkspaceRefusal } from "./errors";
import type { WorkspaceMutationRequest } from "../../app/port/mutable-workspace";
import type { ReadonlyWorkspaceRequest } from "../../app/port/readonly-workspace";

const approvedRoot = { path: "/work", device: "1", inode: "2" };

const readonly = (
  operation: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): ReadonlyWorkspaceRequest =>
  ({
    workspace: {
      workspaceId: "ws",
      root: "/work",
      deniedPaths: ["secret"],
      approvedRoot,
      ...extra,
    },
    operation,
  }) as unknown as ReadonlyWorkspaceRequest;

const mutable = (
  operation: Record<string, unknown>,
): WorkspaceMutationRequest =>
  ({
    workspace: {
      workspaceId: "ws",
      root: "/work",
      deniedPaths: ["secret"],
      writeDeniedPaths: ["dist"],
      approvedRoot,
    },
    operation,
  }) as unknown as WorkspaceMutationRequest;

describe("nativeRequest", () => {
  it("builds a whole read with the source limit", () => {
    expect(
      nativeRequest(
        readonly({ kind: "workspace.read", relativePath: "a" }),
        {},
      ),
    ).toEqual({
      root: "/work",
      approvedRoot,
      relative: "a",
      denied: [...DEFAULT_DENIED_PATHS, "secret"],
      operation: "read",
      maxBytes: 256 * 1024,
    });
  });
  it("copies the approved root rather than sharing it", () => {
    const request = readonly({ kind: "workspace.list", relativePath: "." });
    const built = nativeRequest(request, {}) as unknown as {
      approvedRoot: unknown;
    };
    expect(built.approvedRoot).toEqual(approvedRoot);
    expect(built.approvedRoot).not.toBe(approvedRoot);
  });
  it("builds a window read, a listing and a search", () => {
    expect(
      nativeRequest(
        readonly({
          kind: "workspace.read",
          relativePath: "a",
          range: { offset: 8, length: 16 },
        }),
        {},
      ),
    ).toMatchObject({ operation: "read-window", offset: 8, length: 16 });
    expect(
      nativeRequest(
        readonly({ kind: "workspace.list", relativePath: "." }),
        {},
      ),
    ).toMatchObject({ operation: "list-directory", relative: "." });
    const search = readonly({
      kind: "workspace.search",
      relativePath: ".",
      pattern: "x",
    });
    expect(nativeRequest(search, {})).toMatchObject({
      operation: "grep",
      pattern: "x",
    });
    expect(nativeRequest(search, {})).not.toHaveProperty("fileOnly");
  });
  it("marks a search in an exact-file workspace as file-only", () => {
    const search = readonly(
      { kind: "workspace.search", relativePath: "a", pattern: "x" },
      { exactFilePaths: ["a"] },
    );
    expect(nativeRequest(search, {})).toMatchObject({ fileOnly: true });
  });
  it("forwards a test hook request only when one is given", () => {
    const request = readonly({ kind: "workspace.list", relativePath: "." });
    const hook = { phase: "open", index: null };
    expect(nativeRequest(request, { testHookRequest: hook })).toMatchObject({
      testHook: hook,
    });
    expect(nativeRequest(request, {})).not.toHaveProperty("testHook");
  });
  it("refuses to build a verification command as a helper request", () => {
    expect(() =>
      nativeRequest(
        readonly({
          kind: "verification.run",
          command: "git.head",
          relativePath: ".",
        }),
        {},
      ),
    ).toThrow(WorkspaceRefusal);
  });
});

describe("nativeMutationRequest", () => {
  it("builds a write with both deny lists", () => {
    expect(
      nativeMutationRequest(
        mutable({
          kind: "workspace.write",
          relativePath: "a",
          content: "x",
          expectedSha256: null,
        }),
        {},
      ),
    ).toEqual({
      root: "/work",
      approvedRoot,
      relative: "a",
      denied: [...DEFAULT_DENIED_PATHS, "secret"],
      writeDenied: [".git", "dist"],
      expectedSha256: null,
      operation: "write",
      content: "x",
    });
  });
  it("builds an edit with copied edits", () => {
    const edits = [{ oldText: "a", newText: "b" }];
    const built = nativeMutationRequest(
      mutable({
        kind: "workspace.edit",
        relativePath: "a",
        expectedSha256: "c".repeat(64),
        edits,
      }),
      {},
    );
    expect(built).toMatchObject({ operation: "edit", edits });
    expect(built.edits?.[0]).not.toBe(edits[0]);
  });
});

describe("test barrier options", () => {
  const hook = async (): Promise<void> => undefined;
  it("accepts options with no test hooks at all", () => {
    expect(validTestOptions({})).toBe(true);
    expect(testBarriers({})).toEqual([]);
  });
  it("normalises one barrier or several", () => {
    const one = { phase: "open", index: null };
    expect(testBarriers({ testHookRequest: one })).toEqual([one]);
    expect(testBarriers({ testHookRequest: [one, one] })).toEqual([one, one]);
  });
  it("needs the request and the callback together", () => {
    const one = { phase: "open", index: null };
    expect(validTestOptions({ testHookRequest: one, testHook: hook })).toBe(
      true,
    );
    expect(validTestOptions({ testHookRequest: one })).toBe(false);
    expect(validTestOptions({ testHook: hook })).toBe(false);
  });
  it("allows at most four distinct, well-formed barriers", () => {
    const barrier = (index: number) => ({ phase: "p", index });
    const four = [0, 1, 2, 3].map(barrier);
    expect(validTestOptions({ testHookRequest: four, testHook: hook })).toBe(
      true,
    );
    expect(
      validTestOptions({
        testHookRequest: [...four, barrier(4)],
        testHook: hook,
      }),
    ).toBe(false);
    expect(validTestOptions({ testHookRequest: [], testHook: hook })).toBe(
      false,
    );
    expect(
      validTestOptions({
        testHookRequest: [barrier(1), barrier(1)],
        testHook: hook,
      }),
    ).toBe(false);
    expect(
      validTestOptions({
        testHookRequest: { phase: "p", index: -1 },
        testHook: hook,
      }),
    ).toBe(false);
    expect(
      validTestOptions({
        testHookRequest: { phase: "", index: null },
        testHook: hook,
      }),
    ).toBe(false);
  });
});
