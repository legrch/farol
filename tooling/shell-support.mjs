import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import platform from "./shell-platform.json" with { type: "json" };
import { assertGoCoreDeclaration } from "./go-core-artifact.mjs";
import { ELECTRON_RUNTIME } from "./runtime-contract.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Checked-in expectations, never populated from the machine running a build.
// This class describes selected bytes, not a package/native acceptance receipt.
// Changes require new qualification and source review before release delivery.
export const SHELL_PLATFORM = freeze(platform);
const processDirectory = "modules/computer/infra/process";

async function readPinned(
  root,
  relative,
  expected,
  minimum = 1n,
  maximum = 256n * 1024n,
) {
  const file = path.join(root, relative);
  if ((await fs.realpath(file)) !== file)
    throw new Error("SHELL_SUPPORT_INPUT_REDIRECTED");
  const handle = await fs.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < minimum ||
      before.size > maximum
    )
      throw new Error("SHELL_SUPPORT_INPUT_INVALID");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      size !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      hash(bytes.subarray(0, size)) !== expected
    )
      throw new Error("SHELL_SUPPORT_INPUT_CHANGED");
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}

// Extract only the pinned, non-executed resource literal. The one numeric
// substitution is declared in the same pinned file; no eval/import executes it.
function watchdogLiteral(bytes) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const code =
    /^export const SHELL_WATCHDOG_SIGNAL_REFUSED_EXIT_CODE = ([0-9]{1,3});$/mu.exec(
      source,
    )?.[1];
  const body =
    /export const SHELL_WATCHDOG_SOURCE = String.raw`([^`]*)`;\n$/u.exec(
      source,
    )?.[1];
  const marker = "${SHELL_WATCHDOG_SIGNAL_REFUSED_EXIT_CODE}";
  if (
    !code ||
    Number(code) < 1 ||
    Number(code) > 255 ||
    !body ||
    body.split(marker).length !== 2
  )
    throw new Error("SHELL_WATCHDOG_RESOURCE_INVALID");
  const result = Buffer.from(body.replace(marker, code));
  if (
    result.length > 64 * 1024 ||
    result.includes("${") ||
    hash(result) !== SHELL_PLATFORM.watchdogSource.sourceSHA256
  )
    throw new Error("SHELL_WATCHDOG_RESOURCE_INVALID");
  return result;
}

// The checked-in resource closure is verified, never learned from current bytes.
// Go repeats ownership, identities, listings, hashes and filesystem checks.
export async function verifyHostShellResources() {
  const resources = SHELL_PLATFORM.gitRuntimeResources;
  if (!resources) return;
  const files = [...resources.files, ...(resources.python?.files ?? [])];
  const directories = [
    ...resources.directories,
    ...(resources.python?.directories ?? []),
  ];
  if (resources.python) {
    const base =
      "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9";
    const alias = base + "/bin/python3";
    const info = await fs.lstat(alias);
    if (
      !info.isSymbolicLink() ||
      info.uid !== 0 ||
      info.nlink !== 1 ||
      (await fs.readlink(alias)) !== "python3.9" ||
      (await fs.realpath(alias)) !== base + "/bin/python3.9"
    )
      throw new Error("SHELL_SUPPORT_PYTHON_ALIAS_INVALID");
  }
  const parents = new Set();
  for (const item of [...files, ...directories]) {
    for (
      let dir = path.dirname(item.path);
      dir !== "/";
      dir = path.dirname(dir)
    )
      parents.add(dir);
  }
  for (const dir of [...parents, ...directories.map((d) => d.path)]) {
    const info = await fs.lstat(dir);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      (info.mode & 0o022) !== 0 ||
      (await fs.realpath(dir)) !== dir
    )
      throw new Error("SHELL_SUPPORT_RESOURCE_PARENT_INVALID");
  }
  for (const file of files) {
    const info = await fs.lstat(file.path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      (info.mode & 0o022) !== 0
    )
      throw new Error("SHELL_SUPPORT_RESOURCE_INVALID");
    await readPinned(
      "/",
      file.path,
      file.sha256,
      0n,
      file.path.endsWith("/Versions/3.9/Python3")
        ? 32n * 1024n * 1024n
        : 256n * 1024n,
    );
  }
  for (const dir of directories) {
    const before = await fs.lstat(dir.path, { bigint: true });
    const entries = (await fs.readdir(dir.path)).sort();
    const after = await fs.lstat(dir.path, { bigint: true });
    if (
      JSON.stringify(entries) !== JSON.stringify(dir.entries) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("SHELL_SUPPORT_RESOURCE_DIRECTORY_CHANGED");
  }
}

// The exact production builder calls this only AFTER authenticating its Go
// output. The backend digest is an output binding, not embedded into itself.
// Runtime/native owners subsequently compare platform measurements to these
// independent expectations and retain all current workspace/lease checks.
export async function declareShellSupport(repositoryRoot, core, identity) {
  assertGoCoreDeclaration(core, identity);
  if (core.build.platform.goarch !== "arm64")
    throw new Error("SHELL_SUPPORT_PLATFORM_UNSUPPORTED");
  const runtime = SHELL_PLATFORM.runtime;
  if (
    runtime.version !== ELECTRON_RUNTIME.version ||
    runtime.treeDigestVersion !== ELECTRON_RUNTIME.treeDigestVersion ||
    runtime.treeSHA256 !== ELECTRON_RUNTIME.extractedTreeDigest ||
    runtime.distributionSHA256 !== ELECTRON_RUNTIME.distribution.sha256
  )
    throw new Error("SHELL_SUPPORT_RUNTIME_CHANGED");
  const root = await fs.realpath(repositoryRoot);
  const files = (await fs.readdir(path.join(root, processDirectory)))
    .filter((name) => name.endsWith(".go") && !name.endsWith("_test.go"))
    .map((name) => `${processDirectory}/${name}`)
    .sort();
  if (
    JSON.stringify(files) !==
    JSON.stringify(SHELL_PLATFORM.compilerInputs.map((input) => input.path))
  )
    throw new Error("SHELL_SUPPORT_COMPILER_CHANGED");
  for (const input of SHELL_PLATFORM.compilerInputs)
    await readPinned(root, input.path, input.sha256);
  const source = watchdogLiteral(
    await readPinned(
      root,
      SHELL_PLATFORM.watchdogSource.path,
      SHELL_PLATFORM.watchdogSource.fileSHA256,
    ),
  );
  const support = {
    schema: "farol-shell-support/1",
    core: structuredClone(core),
    qualification: {
      releaseId: SHELL_PLATFORM.id,
      sha256: hash(JSON.stringify(SHELL_PLATFORM)),
      osBuild: SHELL_PLATFORM.osBuild,
      compilerSHA256: hash(JSON.stringify(SHELL_PLATFORM.compilerInputs)),
      compiler: SHELL_PLATFORM.compiler,
      filesystemClass: SHELL_PLATFORM.filesystemClass,
      hostTrust: SHELL_PLATFORM.hostTrust,
      network: SHELL_PLATFORM.network,
    },
    mechanism: SHELL_PLATFORM.mechanism,
    imports: SHELL_PLATFORM.imports,
    executables: SHELL_PLATFORM.executables,
    ...(SHELL_PLATFORM.hostRuntimePolicy
      ? { hostRuntimePolicy: SHELL_PLATFORM.hostRuntimePolicy }
      : {}),
    ...(SHELL_PLATFORM.gitRuntimeResources
      ? { gitRuntimeResources: SHELL_PLATFORM.gitRuntimeResources }
      : {}),
    watchdog: {
      relativePath:
        "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
      sha256: SHELL_PLATFORM.watchdogSHA256,
      sourceSHA256: SHELL_PLATFORM.watchdogSource.sourceSHA256,
    },
    runtime,
  };
  return freeze({ support, watchdogSourceBase64: source.toString("base64") });
}
