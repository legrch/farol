import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function treeDigest(directory) {
  const hash = createHash("sha256");
  const root = await fs.realpath(directory);

  async function containedSymlink(target) {
    const link = await fs.readlink(target);
    if (path.isAbsolute(link)) {
      throw new Error("ARTIFACT_SYMLINK_ESCAPES_ROOT");
    }
    const parent = await fs.realpath(path.dirname(target));
    const lexical = path.resolve(parent, link);
    const lexicalRelative = path.relative(root, lexical);
    if (
      path.isAbsolute(lexicalRelative) ||
      lexicalRelative === ".." ||
      lexicalRelative.startsWith(`..${path.sep}`)
    ) {
      throw new Error("ARTIFACT_SYMLINK_ESCAPES_ROOT");
    }
    let resolved;
    try {
      resolved = await fs.realpath(target);
    } catch {
      throw new Error("ARTIFACT_SYMLINK_TARGET_INVALID");
    }
    const relative = path.relative(root, resolved);
    if (
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error("ARTIFACT_SYMLINK_ESCAPES_ROOT");
    }
    return link;
  }

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const relative = path
        .relative(directory, target)
        .split(path.sep)
        .join("/");
      const stat = await fs.lstat(target);
      const kind = entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : null;
      if (kind === null) throw new Error("ARTIFACT_ENTRY_TYPE_UNSUPPORTED");
      hash.update(relative);
      hash.update("\0");
      hash.update(kind);
      hash.update("\0");
      hash.update(String(stat.mode & 0o777));
      hash.update("\0");
      if (entry.isSymbolicLink()) hash.update(await containedSymlink(target));
      else if (entry.isDirectory()) await walk(target);
      else hash.update(await fs.readFile(target));
      hash.update("\0");
    }
  }

  await walk(directory);
  return hash.digest("hex");
}
