import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Version 1 appended each entry's path, kind and mode with NUL separators and
// then the raw file bytes, so a file whose bytes spelled another entry could
// serialize exactly like a two-entry tree.  Version 2 makes every record
// self-delimiting: a length-prefixed UTF-8 path, one kind byte, the mode as a
// big-endian u32, then the SHA-256 of a file's bytes or a length-prefixed
// symlink target (a directory record has no payload; its children follow as
// records with their own full paths).  The stream starts with this version
// tag, and promotion-apply.py implements the identical encoding.
export const TREE_DIGEST_VERSION = "farol.tree-digest/v2";

const KIND_CODES = Object.freeze({
  file: 0x66,
  directory: 0x64,
  symlink: 0x6c,
});

function u32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function lengthPrefixed(text: string) {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
}

export async function treeDigest(
  directory: string,
  files: typeof fs = fs,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(Buffer.from(`${TREE_DIGEST_VERSION}\0`, "utf8"));
  const rootStat = await files.lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("ARTIFACT_ROOT_TYPE_INVALID");
  }
  const root = await files.realpath(directory);

  async function containedSymlink(target: string): Promise<string> {
    const link = await files.readlink(target);
    if (path.isAbsolute(link)) {
      throw new Error("ARTIFACT_SYMLINK_ESCAPES_ROOT");
    }
    const parent = await files.realpath(path.dirname(target));
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
      resolved = await files.realpath(target);
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

  async function walk(current: string): Promise<void> {
    const entries = await files.readdir(current, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const relative = path
        .relative(directory, target)
        .split(path.sep)
        .join("/");
      const stat = await files.lstat(target);
      const kind = entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : null;
      if (kind === null) throw new Error("ARTIFACT_ENTRY_TYPE_UNSUPPORTED");
      hash.update(lengthPrefixed(relative));
      hash.update(Buffer.of(KIND_CODES[kind]));
      hash.update(u32(stat.mode & 0o7777));
      if (entry.isSymbolicLink()) {
        hash.update(lengthPrefixed(await containedSymlink(target)));
      } else if (entry.isDirectory()) {
        await walk(target);
      } else {
        hash.update(
          createHash("sha256")
            .update(await files.readFile(target))
            .digest(),
        );
      }
    }
  }

  await walk(directory);
  return hash.digest("hex");
}
