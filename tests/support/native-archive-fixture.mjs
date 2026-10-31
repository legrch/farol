import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import {
  assertNativeArchiveBytes,
  compileNativeArchive,
} from "../../tooling/native-archive-build.mjs";

/** Owned, offline native test executable; no installed app or profile access. */
export async function nativeArchiveFixture(root, check = false) {
  // PATH locates a candidate only. compileNativeArchive authenticates the
  // selected absolute compiler and its entire SDK before executing any byte.
  const selected = process.env.FAROL_TEST_GO ?? "go";
  let compilerExecutable = selected;
  if (selected === "go") {
    compilerExecutable = null;
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      const candidate = path.join(directory, "go");
      try {
        await fs.access(candidate, constants.X_OK);
        compilerExecutable = await fs.realpath(candidate);
        break;
      } catch {
        // Continue locating; do not execute or accept an unmeasured candidate.
      }
    }
    if (compilerExecutable === null)
      throw Error("NATIVE_ARCHIVE_COMPILER_UNTRUSTED");
  }
  const { bytes } = await compileNativeArchive({
    root,
    compilerExecutable,
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
