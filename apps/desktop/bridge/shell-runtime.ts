import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import nodeFilesystem from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "./client.ts";
import { parseShellSupportDeclaration } from "./shell-support.ts";

const runtimeRelative = "Contents/Frameworks/Electron Runtime.app";
const maximumEntries = 20_000;
const maximumFile = 512 * 1024 * 1024;
const maximumBytes = 1024 * 1024 * 1024;

const refuse = (): never => {
  throw new BridgeError("refused", "shell_runtime_unqualified");
};
// A spent budget is reported apart from changed or wrong bytes.
class DeadlineExpired extends Error {}
const expire = (): never => {
  throw new DeadlineExpired();
};
function same(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}
function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}
function field(value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([u32(bytes.length), bytes]);
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

// The caller supplies support authenticated independently of observed bytes.
// This checks the nested vendor runtime and its containing directory identities,
// not Farol's other resources, the running host, or release acceptance. The v2
// digest is the package producer's existing format (tooling/artifact-digest.mjs).
// The original monotonic deadline bounds work between filesystem operations;
// it does not claim to interrupt a kernel filesystem operation already pending.
export async function attestShellRuntime(
  appRoot: string,
  independentlyTrustedSupport: unknown,
  deadline: number,
): Promise<Readonly<{ path: string; device: string; inode: string }>> {
  try {
    // Electron virtualizes ASAR archives. Measure physical bytes/metadata like
    // the package producer, using its built-in original-fs module. A failed
    // import refuses; never fall back to the virtualized filesystem.
    const fs: typeof nodeFilesystem = process.versions.electron
      ? (await import("original-fs")).promises
      : nodeFilesystem;
    const support = parseShellSupportDeclaration(independentlyTrustedSupport);
    const now = performance.now();
    if (Number.isFinite(deadline) && deadline <= now) expire();
    if (
      !Number.isFinite(deadline) ||
      deadline > now + 30_000 ||
      typeof appRoot !== "string" ||
      appRoot.length > 4096 ||
      !path.isAbsolute(appRoot) ||
      appRoot === "/" ||
      path.resolve(appRoot) !== appRoot ||
      /[\u0000-\u001f\u007f-\u009f\\:]/u.test(appRoot) ||
      (await fs.realpath(appRoot)) !== appRoot
    )
      refuse();
    const checkTime = (): void => {
      if (performance.now() >= deadline) expire();
    };
    const observed = new Map<string, BigIntStats>();
    const uid = process.getuid?.();
    if (uid === undefined) refuse();
    const runtime = path.join(appRoot, runtimeRelative);
    const observe = async (file: string): Promise<BigIntStats> => {
      checkTime();
      const stat = await fs.lstat(file, { bigint: true });
      if (stat.uid !== 0n && stat.uid !== BigInt(uid!)) refuse();
      if (!stat.isSymbolicLink() && (stat.mode & 0o022n) !== 0n) refuse();
      if (observed.size >= maximumEntries) refuse();
      observed.set(file, stat);
      return stat;
    };
    for (const relative of [
      "",
      "Contents",
      "Contents/Frameworks",
      runtimeRelative,
    ]) {
      if (!(await observe(path.join(appRoot, relative))).isDirectory())
        refuse();
    }
    if ((await fs.realpath(runtime)) !== runtime) refuse();
    const hash = createHash("sha256");
    hash.update(Buffer.from(`${support.runtime.treeDigestVersion}\0`));
    let totalBytes = 0;
    let helperSHA: string | undefined;
    const helper = path.join(appRoot, support.watchdog.relativePath);
    const buffer = Buffer.alloc(64 * 1024);

    async function fileHash(
      file: string,
      before: BigIntStats,
    ): Promise<Buffer> {
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size < 0n ||
        before.size > BigInt(maximumFile) ||
        totalBytes + Number(before.size) > maximumBytes
      )
        refuse();
      totalBytes += Number(before.size);
      const handle = await fs.open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if (!same(before, await handle.stat({ bigint: true }))) refuse();
        const fileDigest = createHash("sha256");
        let offset = 0;
        while (offset <= Number(before.size)) {
          checkTime();
          const size = Math.min(
            buffer.length,
            Number(before.size) + 1 - offset,
          );
          const { bytesRead } = await handle.read(buffer, 0, size, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
          if (offset > Number(before.size)) refuse();
          fileDigest.update(buffer.subarray(0, bytesRead));
        }
        if (
          offset !== Number(before.size) ||
          !same(before, await handle.stat({ bigint: true }))
        )
          refuse();
        return fileDigest.digest();
      } finally {
        await handle.close();
      }
    }
    async function walk(directory: string, depth: number): Promise<void> {
      if (depth > 32) refuse();
      const names: string[] = [];
      const listing = await fs.opendir(directory);
      for await (const entry of listing) {
        checkTime();
        if (names.length + observed.size >= maximumEntries) refuse();
        names.push(entry.name);
      }
      names.sort();
      for (const name of names) {
        const file = path.join(directory, name);
        const stat = await observe(file);
        const kind = stat.isSymbolicLink()
          ? 0x6c
          : stat.isDirectory()
            ? 0x64
            : stat.isFile()
              ? 0x66
              : refuse();
        hash.update(
          field(path.relative(runtime, file).split(path.sep).join("/")),
        );
        hash.update(Buffer.of(kind));
        hash.update(u32(Number(stat.mode & 0o7777n)));
        if (stat.isSymbolicLink()) {
          if (stat.nlink !== 1n) refuse();
          const link = await fs.readlink(file);
          if (
            path.isAbsolute(link) ||
            !inside(runtime, path.resolve(directory, link)) ||
            !inside(runtime, await fs.realpath(file))
          )
            refuse();
          hash.update(field(link));
        } else if (stat.isDirectory()) {
          await walk(file, depth + 1);
        } else {
          const digest = await fileHash(file, stat);
          hash.update(digest);
          if (file === helper) {
            if ((stat.mode & 0o111n) === 0n) refuse();
            helperSHA = digest.toString("hex");
          }
        }
      }
    }
    await walk(runtime, 0);
    if (
      hash.digest("hex") !== support.runtime.treeSHA256 ||
      helperSHA !== support.watchdog.sha256
    )
      refuse();
    // Recheck every earlier observation after the last read, including directory
    // entry-set changes and replacement of a previously hashed file/link.
    for (const [file, before] of observed) {
      checkTime();
      if (!same(before, await fs.lstat(file, { bigint: true }))) refuse();
    }
    checkTime();
    if (
      (await fs.realpath(appRoot)) !== appRoot ||
      (await fs.realpath(runtime)) !== runtime
    )
      refuse();
    checkTime();
    const root = observed.get(appRoot)!;
    return Object.freeze({
      path: appRoot,
      device: String(root.dev),
      inode: String(root.ino),
    });
  } catch (error) {
    if (error instanceof DeadlineExpired)
      throw new BridgeError("refused", "shell_runtime_deadline_expired");
    return refuse();
  }
}
