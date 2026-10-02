import fs from "node:fs/promises";
import path from "node:path";
import {
  assertNativeArchiveBytes,
  compileNativeArchive,
} from "../../tooling/native-archive-build.mjs";

/** Owned, offline native test executable; no installed app or profile access. */
export async function nativeArchiveFixture(root, check = false) {
  const { bytes } = await compileNativeArchive({
    root,
    readSource: (relative) => fs.readFile(path.join(root, relative)),
    check,
  });
  assertNativeArchiveBytes(bytes);
  const directory = await fs.mkdtemp(
    path.join(root, "_output/tmp/native-archive-test-"),
  );
  const executable = path.join(directory, "update-archive.py");
  try {
    await fs.writeFile(executable, bytes, { flag: "wx", mode: 0o700 });
    return {
      executable,
      dispose: () => fs.rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
