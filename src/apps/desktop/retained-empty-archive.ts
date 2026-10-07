import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_ENTRIES = 2057;
const MAX_BYTES = 4 * 1024 * 1024 + 65536 + 2 * 16384 + 4096;
const additions = new Set([
  "known-completion-attempt.json",
  "maintenance-completed.json",
  "failed-running.json",
  "failed-last-quit.json",
  "maintenance-intent.json",
]);
type Entry = { identity: bigint[]; bytes?: Buffer };
function refused(): never {
  throw Error("EMPTY_CHAT_RECOVERY_ARCHIVE_CHANGED");
}
const identity = (s: BigIntStats, directory: boolean) => [
  s.dev,
  s.ino,
  s.mode,
  s.uid,
  s.gid,
  ...(directory ? [] : [s.nlink, s.size, s.mtimeNs, s.ctimeNs]),
];

// Byte/physical-object preservation only. Go remains the canonical journal
// validator; this pin spans its read-only observation and the host's final move.
// The closed trusted-owner lease is not confinement against a hostile writer.
async function scan(root: string): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>();
  let total = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    const file = path.join(root, relative);
    const named = await fs.lstat(file, { bigint: true });
    const directory = named.isDirectory();
    if (
      named.uid !== BigInt(process.geteuid!()) ||
      (named.mode & 0o7777n) !== (directory ? 0o700n : 0o600n) ||
      (!directory && (!named.isFile() || named.nlink !== 1n)) ||
      (directory && depth > 1) ||
      entries.size >= MAX_ENTRIES
    )
      refused();
    const f = await fs.open(
      file,
      FLAGS | (directory ? constants.O_DIRECTORY : 0),
    );
    try {
      const before = await f.stat({ bigint: true });
      if (!isDeepStrictEqual(identity(before, false), identity(named, false)))
        refused();
      if (directory) {
        entries.set(relative, { identity: identity(before, true) });
        const names = (await fs.readdir(file)).sort();
        if (names.length > MAX_ENTRIES) refused();
        for (const name of names)
          await walk(path.join(relative, name), depth + 1);
        if (!isDeepStrictEqual(names, (await fs.readdir(file)).sort()))
          refused();
      } else {
        if (before.size < 0n || before.size > 1048576n) refused();
        total += Number(before.size);
        if (total > MAX_BYTES) refused();
        const buffer = Buffer.alloc(Number(before.size) + 1);
        const { bytesRead } = await f.read(buffer, 0, buffer.length, 0);
        if (BigInt(bytesRead) !== before.size) refused();
        entries.set(relative, {
          identity: identity(before, false),
          bytes: buffer.subarray(0, bytesRead),
        });
      }
      if (
        !isDeepStrictEqual(
          identity(before, false),
          identity(await f.stat({ bigint: true }), false),
        ) ||
        !isDeepStrictEqual(
          identity(before, false),
          identity(await fs.lstat(file, { bigint: true }), false),
        )
      )
        refused();
    } finally {
      await f.close();
    }
  };
  await walk("", 0);
  return entries;
}

export async function retainEmptyArchive(root: string) {
  const retained = await scan(root);
  return pinnedArchive(root, retained);
}

// Observe the original Chat before Go's exclusive sibling rename. No rename or
// repair is performed here; the same physical tree and all bytes must survive.
export async function retainEmptyChatForArchival(
  root: string,
  archive: string,
) {
  if (
    path.basename(root) !== "chat" ||
    path.dirname(root) !== path.dirname(archive) ||
    !/^chat-retired-[a-f0-9-]{36}$/u.test(path.basename(archive))
  )
    refused();
  const retained = await scan(root);
  return async () => {
    if (!isDeepStrictEqual(await scan(archive), retained)) refused();
    return pinnedArchive(archive, retained);
  };
}

function pinnedArchive(root: string, retained: Map<string, Entry>) {
  const verify = async () => {
    if (!isDeepStrictEqual(await scan(root), retained)) refused();
  };
  return {
    verify,
    async include(
      name: string,
      expected: { bytes: Buffer; device: number; inode: number },
    ) {
      if (!additions.has(name) || retained.has(name)) refused();
      const current = await scan(root);
      const added = current.get(name);
      if (
        !added?.bytes?.equals(expected.bytes) ||
        added.identity[0] !== BigInt(expected.device) ||
        added.identity[1] !== BigInt(expected.inode)
      )
        refused();
      current.delete(name);
      if (!isDeepStrictEqual(current, retained)) refused();
      retained.set(name, added);
    },
  };
}
