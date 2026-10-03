import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertBuildIdentity } from "./build-identity-contract.mjs";

export const GO_CORE_ENTRIES = Object.freeze([
  "core-artifact.json",
  "farol-backend",
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = () => {
  throw new Error("GO_CORE_ARTIFACT_INVALID");
};
function keys(value, wanted) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...wanted].sort().join("\0")
  )
    fail();
}

// The caller supplies an independently trusted outer build identity. Reading an
// artifact's own claim never turns it into accepted provenance or authority.
export function assertGoCoreDeclaration(value, identity) {
  assertBuildIdentity(identity);
  keys(value, ["schema", "build", "binary"]);
  keys(value.build, ["buildId", "sourceSHA", "sourceTreeDigest", "platform"]);
  keys(value.build.platform, ["goos", "goarch"]);
  keys(value.binary, ["path", "size", "sha256"]);
  if (
    identity.sourceDirty ||
    value.schema !== "farol-core-artifact/1" ||
    value.build.buildId !== identity.buildId ||
    value.build.sourceSHA !== identity.sourceCommit ||
    value.build.sourceTreeDigest !== identity.sourceTreeDigest ||
    value.build.platform.goos !== "darwin" ||
    !["arm64", "amd64"].includes(value.build.platform.goarch) ||
    value.binary.path !== "farol-backend" ||
    !Number.isSafeInteger(value.binary.size) ||
    value.binary.size < 64 ||
    value.binary.size > 128 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/u.test(value.binary.sha256)
  )
    fail();
  return value;
}

export function declarationFromBuiltCore(built, identity) {
  if (
    !built ||
    built.inputExact !== true ||
    built.entry !== "./cmd/farol" ||
    built.goVersion !== "go1.26.2" ||
    built.cgoEnabled !== false ||
    built.trimpath !== true ||
    built.buildvcs !== false ||
    built.moduleMode !== "readonly"
  )
    fail();
  return assertGoCoreDeclaration(
    {
      schema: "farol-core-artifact/1",
      build: {
        buildId: built.buildId,
        sourceSHA: built.sourceCommit,
        sourceTreeDigest: built.sourceTreeDigest,
        platform: { goos: built.goos, goarch: built.goarch },
      },
      binary: { path: "farol-backend", size: built.size, sha256: built.sha256 },
    },
    identity,
  );
}

async function nativeBytes(file, binary, platform) {
  const fd = await fs.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = await fd.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size !== BigInt(binary.size) ||
      (before.mode & 0o111n) === 0n
    )
      fail();
    const bytes = await fd.readFile();
    const after = await fd.stat({ bigint: true });
    if (
      bytes.length !== binary.size ||
      sha256(bytes) !== binary.sha256 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.nlink !== after.nlink
    )
      fail();
    if (
      bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !==
        (platform.goarch === "arm64" ? 0x0100000c : 0x01000007) ||
      bytes.readUInt32LE(12) !== 2
    )
      fail();
    return bytes;
  } finally {
    await fd.close();
  }
}

// Called only with the direct production builder result, never a prebuilt path
// supplied by the recipe. The existing builder authenticates SDK, modules,
// source, embedded BuildID and native output before returning this result.
export async function embedBuiltCore(directory, built, identity) {
  const declaration = declarationFromBuiltCore(built, identity);
  const bytes = await nativeBytes(
    built.path,
    declaration.binary,
    declaration.build.platform,
  );
  await fs.writeFile(path.join(directory, "farol-backend"), bytes, {
    flag: "wx",
    mode: 0o500,
  });
  await fs.writeFile(
    path.join(directory, "core-artifact.json"),
    JSON.stringify(declaration, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await verifyGoCoreArtifact(directory, declaration, identity);
  return declaration;
}

export async function verifyGoCoreArtifact(directory, expected, identity) {
  assertGoCoreDeclaration(expected, identity);
  const file = path.join(directory, "core-artifact.json");
  const fd = await fs.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let declaration;
  try {
    const before = await fd.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 8192n) fail();
    const bytes = Buffer.alloc(8193);
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
      fail();
    declaration = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await fd.close();
  }
  const actual = assertGoCoreDeclaration(declaration, identity);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail();
  await nativeBytes(
    path.join(directory, "farol-backend"),
    actual.binary,
    actual.build.platform,
  );
  return actual;
}
