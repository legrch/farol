import fs from "node:fs/promises";
import path from "node:path";
import {
  TUNNEL_CLIENT,
  TUNNEL_CLIENT_NOTICES,
} from "../apps/desktop/tunnel-client-contract.ts";

// Adjust only the package-owned copies before the application tree is sealed.
// Open the final file without following a symlink; the private build inputs and
// the pinned Electron vendor tree are never changed here.
export async function normalizePackagedFileModes(directory, { hasGoCore }) {
  const entries = [
    ...(hasGoCore ? [["farol-backend", 0o700]] : []),
    [TUNNEL_CLIENT.entry, 0o700],
    ...TUNNEL_CLIENT_NOTICES.map((notice) => [notice.entry, 0o600]),
  ];
  for (const [name, mode] of entries) {
    const file = path.join(directory, name);
    const handle = await fs.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1)
        throw new Error("PACKAGE_FILE_MODE_INPUT_INVALID");
      await handle.chmod(mode);
      const after = await handle.stat();
      const named = await fs.lstat(file);
      if (
        !named.isFile() ||
        named.dev !== before.dev ||
        named.ino !== before.ino ||
        named.nlink !== 1 ||
        named.size !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.nlink !== 1 ||
        after.size !== before.size ||
        (after.mode & 0o7777) !== mode ||
        named.mode !== after.mode
      )
        throw new Error("PACKAGE_FILE_MODE_CHANGED");
    } finally {
      await handle.close();
    }
  }
}
