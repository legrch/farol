import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { treeDigest } from "../../pkg/artifact-tree-digest/digest";

export interface InstalledExecutionSnapshot {
  readonly app: string;
  readonly directory: string;
  readonly executable: string;
  readonly digest: string;
  recheck(): Promise<void>;
}
const refuse = (): never => {
  throw new Error("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED");
};
function same(a: BigIntStats, b: BigIntStats): boolean {
  // Creating our own child directories legitimately changes a directory's
  // link count. A regular executable still binds its single-link identity.
  const keys = ["dev", "ino", "mode", "uid", "gid"];
  if (!a.isDirectory()) keys.push("nlink");
  return keys.every(
    (key) => a[key as keyof BigIntStats] === b[key as keyof BigIntStats],
  );
}

// This authenticates host executable resources. It owns no update, Computer,
// grant, admission, profile migration or provider policy. Expectations come from
// the accepted baseline, never the directory being measured or a cache receipt.
export async function captureInstalledExecutionSnapshot(
  input: Readonly<{
    sourceApp: string;
    sourceExecutable: string;
    privateParent: string;
    expectedDigest: string;
    copyApp(source: string, destination: string): Promise<void>;
    physicalFiles?: typeof fs;
  }>,
): Promise<InstalledExecutionSnapshot> {
  const files = input.physicalFiles ?? fs;
  const uid = process.geteuid?.();
  if (
    uid === undefined ||
    !/^[a-f0-9]{64}$/u.test(input.expectedDigest) ||
    ![input.sourceApp, input.sourceExecutable, input.privateParent].every(
      (value) => path.isAbsolute(value) && path.resolve(value) === value,
    )
  )
    refuse();
  const relativeExecutable = path.relative(
    input.sourceApp,
    input.sourceExecutable,
  );
  if (
    relativeExecutable === "" ||
    path.isAbsolute(relativeExecutable) ||
    relativeExecutable === ".." ||
    relativeExecutable.startsWith(`..${path.sep}`)
  )
    refuse();
  const directory = async (name: string, privateMode: boolean) => {
    const info = await files.lstat(name, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== BigInt(uid!) ||
      (info.mode & (privateMode ? 0o077n : 0o022n)) !== 0n ||
      (await files.realpath(name)) !== name
    )
      refuse();
    return info;
  };
  // A private leaf is insufficient if another account can replace an ancestor.
  for (let name = input.privateParent; ; name = path.dirname(name)) {
    const info = await files.lstat(name, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      ![0n, BigInt(uid!)].includes(info.uid) ||
      ((info.mode & 0o022n) !== 0n &&
        !(info.uid === 0n && (info.mode & 0o1000n) !== 0n)) ||
      (await files.realpath(name)) !== name
    )
      refuse();
    if (name === path.dirname(name)) break;
  }
  const regularExecutable = async (name: string) => {
    const info = await files.lstat(name, { bigint: true });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== BigInt(uid!) ||
      info.nlink !== 1n ||
      (info.mode & 0o022n) !== 0n ||
      (info.mode & 0o111n) === 0n ||
      (await files.realpath(name)) !== name
    )
      refuse();
    return info;
  };
  const source = await directory(input.sourceApp, false);
  const sourceExecutable = await regularExecutable(input.sourceExecutable);
  const parent = await directory(input.privateParent, true);
  const parentStable = async () => {
    if (!same(parent, await directory(input.privateParent, true))) refuse();
  };
  const sourceStable = async () => {
    await parentStable();
    if (
      !same(source, await directory(input.sourceApp, false)) ||
      !same(sourceExecutable, await regularExecutable(input.sourceExecutable))
    )
      refuse();
  };
  // The expected image is selected independently by the trusted update owner.
  // Reading/copying bytes never invokes anything in the publicly writable slot.
  await sourceStable();
  if ((await treeDigest(input.sourceApp, files)) !== input.expectedDigest)
    refuse();
  await sourceStable();
  const root = path.join(input.privateParent, "installed-execution");
  try {
    await files.mkdir(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const rootIdentity = await directory(root, true);
  const cache = path.join(root, input.expectedDigest);
  const app = path.join(cache, "Farol.app");
  const candidate = async () => {
    const cacheIdentity = await directory(cache, true);
    const appIdentity = await directory(app, true);
    if ((await treeDigest(app, files)) !== input.expectedDigest) refuse();
    if (
      !same(cacheIdentity, await directory(cache, true)) ||
      !same(appIdentity, await directory(app, true)) ||
      !same(rootIdentity, await directory(root, true))
    )
      refuse();
    return { cacheIdentity, appIdentity };
  };
  let existing = false;
  try {
    await files.lstat(cache);
    existing = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!existing) {
    const temporary = path.join(root, `.capture-${randomUUID()}`);
    await files.mkdir(temporary, { mode: 0o700 });
    const temporaryIdentity = await directory(temporary, true);
    // Failed/unknown capture directories stay retained and are never adopted.
    const copied = path.join(temporary, "Farol.app");
    await input.copyApp(input.sourceApp, copied);
    await sourceStable();
    if (!same(temporaryIdentity, await directory(temporary, true))) refuse();
    await files.chmod(copied, 0o700);
    await directory(copied, true);
    if ((await treeDigest(copied, files)) !== input.expectedDigest) refuse();
    await sourceStable();
    if (!same(rootIdentity, await directory(root, true))) refuse();
    // Publication is attempted once. A concurrent nonempty completed cache is
    // only reusable after its full independently expected image is qualified.
    try {
      await files.rename(temporary, cache);
    } catch (error) {
      if (
        !["EEXIST", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
    const handle = await files.open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const pinned = await candidate();
  await sourceStable();
  const executable = path.join(app, relativeExecutable);
  const executableInfo = await regularExecutable(executable);
  return Object.freeze({
    app,
    directory: path.join(app, "Contents/Resources/app"),
    executable,
    digest: input.expectedDigest,
    recheck: async () => {
      // Capture authenticates the public source once. This lifetime belongs
      // to the accepted private image; updater admission checks its own source.
      await parentStable();
      const current = await candidate();
      await parentStable();
      if (
        !same(pinned.cacheIdentity, current.cacheIdentity) ||
        !same(pinned.appIdentity, current.appIdentity) ||
        !same(executableInfo, await regularExecutable(executable))
      )
        refuse();
    },
  });
}
