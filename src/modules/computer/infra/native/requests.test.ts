import { describe, expect, it } from "vitest";
import { validateMutationRequest, validateRequest } from "./requests";

const HASH = "a".repeat(64);

const workspace = (extra: Record<string, unknown> = {}) => ({
  workspaceId: "ws-1",
  root: "/work",
  deniedPaths: [],
  approvedRoot: { path: "/work", device: "1", inode: "2" },
  ...extra,
});

const read = (operation: Record<string, unknown>, extra = {}) => ({
  workspace: workspace(extra),
  operation,
});

describe("validateRequest", () => {
  it("accepts read, list, search and verification operations", () => {
    for (const operation of [
      { kind: "workspace.read", relativePath: "a.txt" },
      {
        kind: "workspace.read",
        relativePath: "a.txt",
        range: { offset: 0, length: 4 },
      },
      { kind: "workspace.list", relativePath: "." },
      { kind: "workspace.search", relativePath: ".", pattern: "x" },
      { kind: "verification.run", command: "git.head", relativePath: "." },
      { kind: "verification.run", command: "git.status", relativePath: "." },
    ]) {
      const request = read(operation);
      expect(validateRequest(request)).toBe(request);
    }
  });
  it("refuses unknown kinds, commands and extra keys", () => {
    expect(validateRequest(read({ kind: "workspace.delete" }))).toBeNull();
    expect(
      validateRequest(
        read({
          kind: "verification.run",
          command: "git.log",
          relativePath: ".",
        }),
      ),
    ).toBeNull();
    expect(
      validateRequest(
        read({ kind: "workspace.read", relativePath: "a", extra: 1 }),
      ),
    ).toBeNull();
    expect(validateRequest({ workspace: workspace() })).toBeNull();
    expect(validateRequest(null)).toBeNull();
  });
  it("refuses a request without the approved root or with a foreign one", () => {
    const { approvedRoot: _omit, ...bare } = workspace();
    expect(
      validateRequest({
        workspace: bare,
        operation: { kind: "workspace.list", relativePath: "." },
      }),
    ).toBeNull();
    expect(
      validateRequest(
        read(
          { kind: "workspace.list", relativePath: "." },
          { approvedRoot: { path: "/else", device: "1", inode: "2" } },
        ),
      ),
    ).toBeNull();
  });
  it("bounds read ranges", () => {
    const ranged = (range: unknown) =>
      validateRequest(
        read({ kind: "workspace.read", relativePath: "a", range }),
      );
    expect(ranged({ offset: 0, length: 3 })).toBeNull();
    expect(ranged({ offset: 0, length: 4 })).not.toBeNull();
    expect(ranged({ offset: 0, length: 256 * 1024 })).not.toBeNull();
    expect(ranged({ offset: 0, length: 256 * 1024 + 1 })).toBeNull();
    expect(ranged({ offset: -1, length: 8 })).toBeNull();
    expect(ranged({ offset: 1.5, length: 8 })).toBeNull();
    expect(ranged({ offset: 0 })).toBeNull();
  });
  it("accepts an explicit undefined range like an absent one", () => {
    expect(
      validateRequest(
        read({ kind: "workspace.read", relativePath: "a", range: undefined }),
      ),
    ).not.toBeNull();
  });
  it("refuses unsafe paths and patterns", () => {
    expect(
      validateRequest(read({ kind: "workspace.read", relativePath: "../a" })),
    ).toBeNull();
    expect(
      validateRequest(read({ kind: "workspace.read", relativePath: "." })),
    ).toBeNull();
    expect(
      validateRequest(
        read({ kind: "workspace.search", relativePath: ".", pattern: "" }),
      ),
    ).toBeNull();
  });
  it("bounds denied paths", () => {
    const op = { kind: "workspace.list", relativePath: "." };
    expect(validateRequest(read(op, { deniedPaths: ["a", "a"] }))).toBeNull();
    expect(validateRequest(read(op, { deniedPaths: ["/a"] }))).toBeNull();
    expect(validateRequest(read(op, { deniedPaths: "a" }))).toBeNull();
    expect(
      validateRequest(
        read(op, {
          deniedPaths: Array.from({ length: 257 }, (_, i) => `d${i}`),
        }),
      ),
    ).toBeNull();
  });
  it("narrows exact-file workspaces to the listed files", () => {
    const exact = { exactFilePaths: ["a.txt"] };
    expect(
      validateRequest(
        read({ kind: "workspace.read", relativePath: "a.txt" }, exact),
      ),
    ).not.toBeNull();
    expect(
      validateRequest(
        read({ kind: "workspace.read", relativePath: "b.txt" }, exact),
      ),
    ).toBeNull();
    expect(
      validateRequest(
        read({ kind: "workspace.list", relativePath: "." }, exact),
      ),
    ).toBeNull();
    expect(
      validateRequest(
        read(
          { kind: "verification.run", command: "git.head", relativePath: "." },
          exact,
        ),
      ),
    ).toBeNull();
    expect(
      validateRequest(
        read(
          { kind: "workspace.read", relativePath: "a.txt" },
          { exactFilePaths: [] },
        ),
      ),
    ).toBeNull();
    expect(
      validateRequest(
        read(
          { kind: "workspace.read", relativePath: "a.txt" },
          { exactFilePaths: ["a.txt", "a.txt"] },
        ),
      ),
    ).toBeNull();
  });
  it("checks the optional git metadata grant", () => {
    const op = { kind: "workspace.list", relativePath: "." };
    expect(
      validateRequest(
        read(op, {
          gitMetadata: { gitDirectory: "/work/.git", commonDirectory: "/work" },
        }),
      ),
    ).not.toBeNull();
    expect(
      validateRequest(read(op, { gitMetadata: { gitDirectory: "x" } })),
    ).toBeNull();
  });
});

const mutation = (operation: Record<string, unknown>, extra = {}) => ({
  workspace: {
    ...workspace(),
    writeDeniedPaths: [],
    ...extra,
  },
  operation,
});

describe("validateMutationRequest", () => {
  it("accepts a write and an edit", () => {
    for (const operation of [
      {
        kind: "workspace.write",
        relativePath: "a",
        content: "x",
        expectedSha256: null,
      },
      {
        kind: "workspace.write",
        relativePath: "a",
        content: "x",
        expectedSha256: HASH,
      },
      {
        kind: "workspace.edit",
        relativePath: "a",
        expectedSha256: HASH,
        edits: [{ oldText: "a", newText: "b" }],
      },
    ]) {
      const request = mutation(operation);
      expect(validateMutationRequest(request)).toBe(request);
    }
  });
  it("requires write-denied paths and refuses read-only shapes", () => {
    const { writeDeniedPaths: _omit, ...bare } = mutation({}).workspace;
    expect(
      validateMutationRequest({
        workspace: bare,
        operation: {
          kind: "workspace.write",
          relativePath: "a",
          content: "x",
          expectedSha256: null,
        },
      }),
    ).toBeNull();
    expect(
      validateMutationRequest(
        mutation({ kind: "workspace.read", relativePath: "a" }),
      ),
    ).toBeNull();
  });
  it("refuses NUL, oversize content and bad digests", () => {
    const write = (content: string, expectedSha256: unknown = null) =>
      validateMutationRequest(
        mutation({
          kind: "workspace.write",
          relativePath: "a",
          content,
          expectedSha256,
        }),
      );
    expect(write("a\0b")).toBeNull();
    expect(write("x".repeat(8 * 1024 * 1024))).not.toBeNull();
    expect(write("x".repeat(8 * 1024 * 1024 + 1))).toBeNull();
    expect(write("x", "short")).toBeNull();
  });
  it("bounds and shapes edits", () => {
    const edit = (edits: unknown, expectedSha256: unknown = HASH) =>
      validateMutationRequest(
        mutation({
          kind: "workspace.edit",
          relativePath: "a",
          expectedSha256,
          edits,
        }),
      );
    expect(edit([])).toBeNull();
    expect(edit([{ oldText: "", newText: "b" }])).toBeNull();
    expect(edit([{ oldText: "a", newText: "a" }])).toBeNull();
    expect(edit([{ oldText: "a" }])).toBeNull();
    expect(edit([{ oldText: "a", newText: "b" }], null)).toBeNull();
    expect(
      edit(
        Array.from({ length: 256 }, (_, i) => ({
          oldText: `o${i}`,
          newText: "n",
        })),
      ),
    ).not.toBeNull();
    expect(
      edit(
        Array.from({ length: 257 }, (_, i) => ({
          oldText: `o${i}`,
          newText: "n",
        })),
      ),
    ).toBeNull();
  });
  it("bounds the aggregate edit size in bytes", () => {
    const half = "x".repeat(4 * 1024 * 1024);
    const edit = (oldText: string, newText: string) =>
      validateMutationRequest(
        mutation({
          kind: "workspace.edit",
          relativePath: "a",
          expectedSha256: HASH,
          edits: [{ oldText, newText }],
        }),
      );
    expect(edit(half, "y".repeat(4 * 1024 * 1024))).not.toBeNull();
    expect(edit(half, "y".repeat(4 * 1024 * 1024 + 1))).toBeNull();
  });
});
