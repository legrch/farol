import type { ComputerSettingsSnapshotResponse } from "./bridge/wire";
import { BridgeError } from "./bridge/client";

type Binding = Readonly<{
  generation: number;
  workspaceId: string;
  relativePath: string;
  root: Readonly<{ path: string; device: string; inode: string }>;
}>;

// Correlate a content-free Go receipt with the currently displayed folder. Go
// owns authorization and the full raw-byte read. This adapter never hashes text,
// renews authority, performs a filesystem operation or selects a fallback.
export async function readGoWorkspaceSnapshot(
  input: Readonly<{
    binding: Binding;
    current: () => Binding | null;
    read: (binding: Binding) => Promise<ComputerSettingsSnapshotResponse>;
  }>,
): Promise<
  { ok: true; bytes: number; sha256: string } | { ok: false; code: string }
> {
  const binding = structuredClone(input.binding);
  const current = () => {
    const now = input.current();
    return (
      now?.generation === binding.generation &&
      now.workspaceId === binding.workspaceId &&
      now.relativePath === binding.relativePath &&
      now.root.path === binding.root.path &&
      now.root.device === binding.root.device &&
      now.root.inode === binding.root.inode
    );
  };
  if (!current()) return { ok: false, code: "WORKSPACE_ROOT_CHANGED" };
  try {
    const result = await input.read(structuredClone(binding));
    if (
      !current() ||
      result.workspaceId !== binding.workspaceId ||
      result.relativePath !== binding.relativePath ||
      result.root.path !== binding.root.path ||
      result.root.device !== binding.root.device ||
      result.root.inode !== binding.root.inode
    )
      return { ok: false, code: "WORKSPACE_ROOT_CHANGED" };
    return { ok: true, bytes: result.bytes, sha256: result.sha256 };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof BridgeError && error.state === "refused"
          ? error.code
          : "WORKSPACE_READ_FAILED",
    };
  }
}
