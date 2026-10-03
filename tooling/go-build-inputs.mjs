import fs from "node:fs/promises";
import path from "node:path";

// Explicit operator-selected offline build inputs. This contains paths and the
// independently approved SDK declaration, never executable hooks, a prebuilt
// backend, source identity, credentials or an install/network instruction.
export async function readGoBuildInputs(args) {
  if (args.length === 0) return null;
  if (args.length !== 1 || !args[0].startsWith("--go-inputs="))
    throw new Error("BUILD_ARGUMENT_INVALID");
  const file = args[0].slice("--go-inputs=".length);
  if (!path.isAbsolute(file) || path.resolve(file) !== file)
    throw new Error("GO_INPUTS_PATH_INVALID");
  const fd = await fs.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let value;
  try {
    const before = await fd.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 16384n)
      throw new Error("GO_INPUTS_FILE_INVALID");
    const bytes = Buffer.alloc(16385);
    const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    const after = await fd.stat({ bigint: true });
    if (
      BigInt(bytesRead) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.nlink !== after.nlink
    )
      throw new Error("GO_INPUTS_FILE_INVALID");
    value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await fd.close();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "moduleInputs,schema,toolchain" ||
    value.schema !== "farol-go-build-inputs/1" ||
    !value.toolchain ||
    !Array.isArray(value.moduleInputs)
  )
    throw new Error("GO_INPUTS_INVALID");
  // Deep validation and authentication occur in the existing production builder.
  // No digest is freshly measured here and promoted into a trust declaration.
  return value;
}
