import { describe, expect, it, vi } from "vitest";
import { readGoWorkspaceSnapshot } from "../../apps/desktop/go-workspace-snapshot";
import { BridgeError } from "../../apps/desktop/bridge/client";

// Host correlation only. The Go policy and actual raw-byte read have separate
// owning tests; these ports perform no filesystem access or mutation.
function fixture() {
  const binding = {
    generation: 3,
    workspaceId: "work",
    relativePath: "note.md",
    root: { path: "/work", device: "1", inode: "2" },
  };
  const response = {
    publication: {
      fence: "1",
      storeRevision: "1",
      settingsRevision: "1",
      generation: "3",
      approvalDigest: "a".repeat(64),
      publishOperationId: "pub",
    },
    workspaceId: "work",
    relativePath: "note.md",
    root: { ...binding.root },
    bytes: 7,
    sha256: "b".repeat(64),
  };
  const current = vi.fn((): typeof binding | null => structuredClone(binding));
  const read = vi.fn(async (_binding: typeof binding) =>
    structuredClone(response),
  );
  return { binding, response, current, read };
}

describe("Go workspace snapshot host correlation", () => {
  it("keeps the native raw-byte hash and returns no file body", async () => {
    const f = fixture();
    expect(await readGoWorkspaceSnapshot(f)).toEqual({
      ok: true,
      bytes: 7,
      sha256: "b".repeat(64),
    });
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.read).toHaveBeenCalledWith(f.binding);
  });
  it("refuses stale selection before a read", async () => {
    const f = fixture();
    f.current.mockReturnValue(null);
    expect(await readGoWorkspaceSnapshot(f)).toEqual({
      ok: false,
      code: "WORKSPACE_ROOT_CHANGED",
    });
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each([
    "withdraw",
    "generation",
    "workspace",
    "path",
    "root",
    "device",
    "inode",
  ])("discards a completed read after %s changes", async (change) => {
    const f = fixture();
    f.read.mockImplementation(async () => {
      const now = structuredClone(f.binding);
      if (change === "generation") now.generation++;
      if (change === "workspace") now.workspaceId = "other";
      if (change === "path") now.relativePath = "other";
      if (change === "root") now.root.path = "/other";
      if (change === "device") now.root.device = "2";
      if (change === "inode") now.root.inode = "3";
      f.current.mockReturnValue(change === "withdraw" ? null : now);
      return f.response;
    });
    expect(await readGoWorkspaceSnapshot(f)).toEqual({
      ok: false,
      code: "WORKSPACE_ROOT_CHANGED",
    });
    expect(f.read).toHaveBeenCalledOnce();
  });
  it.each(["workspace", "path", "root", "inode"])(
    "rejects a crossed native receipt %s",
    async (change) => {
      const f = fixture();
      if (change === "workspace") f.response.workspaceId = "other";
      if (change === "path") f.response.relativePath = "other";
      if (change === "root") f.response.root.path = "/other";
      if (change === "inode") f.response.root.inode = "3";
      expect(await readGoWorkspaceSnapshot(f)).toEqual({
        ok: false,
        code: "WORKSPACE_ROOT_CHANGED",
      });
    },
  );
  it.each(["refused", "unknown", "unavailable"] as const)(
    "does not retry a %s read or select another executor",
    async (state) => {
      const f = fixture();
      f.read.mockRejectedValue(new BridgeError(state, "WORKSPACE_NOT_TEXT"));
      expect(await readGoWorkspaceSnapshot(f)).toEqual({
        ok: false,
        code:
          state === "refused" ? "WORKSPACE_NOT_TEXT" : "WORKSPACE_READ_FAILED",
      });
      expect(f.read).toHaveBeenCalledOnce();
    },
  );
});
