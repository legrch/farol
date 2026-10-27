import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { constants } from "node:fs/promises";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { assertBuildIdentity } from "./build-identity-contract.mjs";
import { sourceSnapshot } from "./source-identity.mjs";
import { OWNER_FILE, writeOwner } from "./owned-scratch.mjs";

const MODULE = "github.com/legrch/farol";
const VERSION = "go1.26.2";
const ENTRY = "./cmd/farol";
const SYMBOL = `${MODULE}/boot.BuildID`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code) => {
  throw new Error(`GO_BACKEND_${code}`);
};

async function regularFile(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail("INPUT_TYPE_INVALID");
    return {
      bytes: await handle.readFile(),
      executable: (stat.mode & 0o111) !== 0,
    };
  } finally {
    await handle.close();
  }
}

// This digest authenticates the complete unpacked SDK, including bin/go,
// pkg/tool, src, includes and configuration. A freshly observed hash is NOT a
// trust declaration. The caller must supply a separately approved digest.
// Only regular files/directories are supported; no redirected SDK inputs.
async function toolchainSnapshot(root, destination) {
  if (!path.isAbsolute(root) || (await fs.realpath(root)) !== root)
    fail("TOOLCHAIN_ROOT_INVALID");
  const records = [];
  async function walk(relative) {
    const directory = path.join(root, relative);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail("TOOLCHAIN_INPUT_TYPE_INVALID");
    if (destination)
      await fs.mkdir(path.join(destination, relative), { recursive: true });
    for (const name of (await fs.readdir(directory)).sort()) {
      const child = path.posix.join(relative, name);
      const file = path.join(root, child);
      const info = await fs.lstat(file);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await walk(child);
      } else if (info.isFile() && !info.isSymbolicLink()) {
        const { bytes, executable } = await regularFile(file);
        records.push({ path: child, executable, sha256: digest(bytes) });
        if (destination)
          await fs.writeFile(path.join(destination, child), bytes, {
            flag: "wx",
            mode: executable ? 0o500 : 0o400,
          });
      } else fail("TOOLCHAIN_INPUT_TYPE_INVALID");
    }
  }
  await walk("");
  records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return digest(`farol-go-sdk-v1\0${JSON.stringify(records)}`);
}

export async function measureGoToolchain(root) {
  return toolchainSnapshot(root);
}

// The development stop helper uses the SAME authenticated SDK/module/source
// machinery, in private output unrelated to a live application's build. This
// fixed entry is not a caller-selected program, package or backend replacement.
export async function buildDevControl(repositoryRoot, inputs) {
  const root = path.resolve(repositoryRoot);
  if (
    (await fs.realpath(root)) !== root ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    process.execArgv.length
  )
    fail("DEV_CONTROL_INPUT_INVALID");
  const initial = sourceSnapshot(root);
  if (initial.dirty) fail("DEV_CONTROL_SOURCE_DIRTY");
  const platform = { goos: "darwin", goarch: process.arch };
  const toolchain = Object.freeze({ ...inputs.toolchain });
  validateDeclaration(toolchain, platform);
  const declared = declareModuleInputs(inputs.moduleInputs);
  const scratch = await fs.mkdtemp(
    path.join(await ownedParent(root, initial), "go-dev-control-"),
  );
  try {
    await writeOwner(scratch);
    return await buildDevControlIn(
      root,
      scratch,
      initial,
      toolchain,
      declared,
      platform,
    );
  } catch (error) {
    // Nothing was signaled with a helper that was never returned, but an
    // outcome-unknown compiler may leave descendants using the scratch.
    await settleFailedScratch(scratch, error);
    throw error;
  }
}

// A known failure removes its scratch. An outcome-unknown command (signal,
// timeout, spawn failure) does not prove its descendants stopped, so the
// scratch is retained as evidence without an owner record: retention then
// reports it as unknown and never reaps it.
async function settleFailedScratch(scratch, error) {
  if (String(error?.message).startsWith("GO_BACKEND_COMMAND_OUTCOME_UNKNOWN"))
    await fs.rm(path.join(scratch, OWNER_FILE), { force: true });
  else await fs.rm(scratch, { recursive: true, force: true });
}

// Remove one returned owned temporary directory (helper or built backend).
// Only an exact `_output/tmp/<prefix>XXXXXX/<file>` path owned by this
// account qualifies; anything else is refused rather than guessed at.
export async function releaseOwnedTemporary(repositoryRoot, file, prefix) {
  const parent = path.join(path.resolve(repositoryRoot), "_output/tmp");
  const directory = path.dirname(path.resolve(file));
  if (
    path.dirname(directory) !== parent ||
    !path.basename(directory).startsWith(prefix) ||
    path.basename(directory).length !== prefix.length + 6
  )
    fail("OWNED_TEMPORARY_PATH_INVALID");
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.uid !== process.getuid())
    fail("OWNED_TEMPORARY_PATH_INVALID");
  await fs.rm(directory, { recursive: true, force: true });
}

async function buildDevControlIn(
  root,
  scratch,
  initial,
  toolchain,
  declared,
  platform,
) {
  const source = path.join(scratch, "source");
  const sdk = path.join(scratch, "sdk");
  if ((await toolchainSnapshot(toolchain.root, sdk)) !== toolchain.treeSha256)
    fail("TOOLCHAIN_DIGEST_MISMATCH");
  await writeSources(initial, source);
  for (const name of ["home", "tmp", "cache", "modules", "gopath"])
    await fs.mkdir(path.join(scratch, name));
  const modules = await authenticateModules(declared, dependencySums(initial));
  const cache = await installModules(modules, path.join(scratch, "modules"));
  const env = cleanEnvironment(scratch, sdk, platform);
  const binary = path.join(scratch, "dev-control");
  go(
    sdk,
    [
      "build",
      "-p=2",
      "-compiler=gc",
      "-buildmode=exe",
      "-trimpath",
      "-buildvcs=false",
      "-mod=readonly",
      "-o",
      binary,
      "./cmd/faroldevcontrol",
    ],
    source,
    env,
  );
  const info = JSON.parse(
    go(sdk, ["version", "-m", "-json", binary], source, env),
  );
  if (
    info.GoVersion !== VERSION ||
    info.Path !== "github.com/legrch/farol/cmd/faroldevcontrol"
  )
    fail("DEV_CONTROL_BINARY_INVALID");
  assertBinaryDependencies(info, modules);
  await assertModuleInputsUnchanged(modules);
  await assertSnapshotUnchanged(
    cache,
    path.join(scratch, "modules"),
    "MODULE_CACHE_MOVED",
  );
  await assertSnapshotUnchanged(initial, source);
  const current = sourceSnapshot(root);
  if (
    current.dirty ||
    current.commit !== initial.commit ||
    current.treeDigest !== initial.treeDigest ||
    (await measureGoToolchain(sdk)) !== toolchain.treeSha256 ||
    (await measureGoToolchain(toolchain.root)) !== toolchain.treeSha256
  )
    fail("DEV_CONTROL_INPUT_CHANGED");
  // The caller releases the helper after a confirmed stop and retains it, as
  // evidence, after a refused or outcome-unknown stop.
  return binary;
}

function validateDeclaration(toolchain, platform) {
  if (
    !toolchain ||
    typeof toolchain.root !== "string" ||
    !path.isAbsolute(toolchain.root) ||
    !/^[a-f0-9]{64}$/u.test(toolchain.treeSha256 ?? "") ||
    toolchain.version !== VERSION ||
    !platform ||
    platform.goos !== "darwin" ||
    !["arm64", "amd64"].includes(platform.goarch) ||
    toolchain.goos !== platform.goos ||
    toolchain.goarch !== platform.goarch
  )
    fail("TOOLCHAIN_DECLARATION_INVALID");
}

function assertSource(snapshot, identity) {
  if (
    snapshot.dirty ||
    identity.sourceDirty ||
    snapshot.commit !== identity.sourceCommit ||
    snapshot.treeDigest !== identity.sourceTreeDigest
  )
    fail("SOURCE_IDENTITY_MISMATCH");
  const text = snapshot.entries.get("go.mod")?.bytes?.toString("utf8") ?? "";
  if (
    !/^module github\.com\/legrch\/farol\s*$/mu.test(text) ||
    !/^go 1\.26\.2\s*$/mu.test(text) ||
    !snapshot.entries.has("cmd/farol/main.go")
  )
    fail("PRODUCTION_SOURCE_INVALID");
  if (/^\s*replace\b/mu.test(text)) fail("MODULE_REPLACEMENT_UNSUPPORTED");
}

// Deliberately bounded to this accepted root graph. Changing these versions,
// root directives, sums or cache formats requires a new caller contract.
const REQUIRED_MODULES = new Map([
  ["golang.org/x/sys", "v0.35.0"],
  ["golang.org/x/text", "v0.28.0"],
]);
const ZIP_LIMIT = 128 * 1024 * 1024;
const CONTENT_LIMIT = 256 * 1024 * 1024;
const FILE_LIMIT = 64 * 1024 * 1024;
const utf8Order = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// Go 1.26.2 cmd/vendor/golang.org/x/mod/sumdb/dirhash.Hash1 and
// cmd/go/internal/modfetch.goModSum: hash sorted UTF-8 names and file hashes,
// including the module@version/ prefix for ZIPs; .mod uses only "go.mod".
function goH1(files) {
  const hash = createHash("sha256");
  for (const [name, bytes] of [...files].sort(([a], [b]) => utf8Order(a, b))) {
    if (name.includes("\n")) fail("MODULE_PATH_INVALID");
    hash.update(`${digest(bytes)}  ${name}\n`);
  }
  return `h1:${hash.digest("base64")}`;
}

function dependencySums(snapshot) {
  const mod = snapshot.entries.get("go.mod").bytes.toString("utf8");
  // Support the current literal root directives only, not a partial Go parser.
  const tokens = mod
    .replace(/\/\/[^\n]*/gu, "")
    .trim()
    .split(/\s+/u);
  const wanted = ["module", MODULE, "go", "1.26.2", "require", "("];
  for (const [modulePath, version] of REQUIRED_MODULES)
    wanted.push(modulePath, version);
  wanted.push(")");
  if (JSON.stringify(tokens) !== JSON.stringify(wanted))
    fail("MODULE_GRAPH_UNSUPPORTED");
  if (snapshot.entries.has("vendor/modules.txt"))
    fail("MODULE_VENDOR_UNSUPPORTED");
  const sums = new Map();
  const sumBytes = snapshot.entries.get("go.sum")?.bytes;
  if (!sumBytes) fail("MODULE_SUM_INVALID");
  for (const line of sumBytes.toString("utf8").trim().split("\n")) {
    const match = /^(\S+) (\S+) (h1:[A-Za-z0-9+/]{43}=)$/u.exec(line);
    if (!match) fail("MODULE_SUM_INVALID");
    const [, modulePath, version, sum] = match;
    const expected = REQUIRED_MODULES.get(modulePath);
    const key = `${modulePath} ${version}`;
    if (
      !expected ||
      ![expected, `${expected}/go.mod`].includes(version) ||
      sums.has(key)
    )
      fail("MODULE_SUM_INVALID");
    if (`h1:${Buffer.from(sum.slice(3), "base64").toString("base64")}` !== sum)
      fail("MODULE_SUM_INVALID");
    sums.set(key, sum);
  }
  if (sums.size !== REQUIRED_MODULES.size * 2) fail("MODULE_SUM_INVALID");
  return sums;
}

function declareModuleInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length !== REQUIRED_MODULES.size)
    fail("MODULE_INPUT_DECLARATION_INVALID");
  const selected = new Map();
  for (const input of inputs) {
    const keys = [
      "modulePath",
      "version",
      "zipPath",
      "modPath",
      "contentRoot",
      "zipHashPath",
    ];
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some((key) => !keys.includes(key))
    )
      fail("MODULE_INPUT_DECLARATION_INVALID");
    const frozen = Object.freeze({ ...input });
    if (
      !REQUIRED_MODULES.has(frozen.modulePath) ||
      REQUIRED_MODULES.get(frozen.modulePath) !== frozen.version ||
      selected.has(frozen.modulePath)
    )
      fail("MODULE_INPUT_DECLARATION_INVALID");
    for (const key of keys.slice(2)) {
      const value = frozen[key];
      if (key === "zipHashPath" && value === undefined) continue;
      if (
        typeof value !== "string" ||
        !path.isAbsolute(value) ||
        path.normalize(value) !== value
      )
        fail("MODULE_INPUT_DECLARATION_INVALID");
    }
    selected.set(frozen.modulePath, frozen);
  }
  return [...REQUIRED_MODULES.keys()].map((key) => selected.get(key));
}

// Restrict names to the ASCII subset of Go CheckFilePath so portable collision
// detection is exact. Unsupported Unicode names/directory entries fail closed.
function moduleFilePath(name) {
  if (name.length > 4096) fail("MODULE_PATH_INVALID");
  for (const part of name.split("/")) {
    if (
      !/^[A-Za-z0-9!#$%&()+,\-.=@[\]^_{}~ ]+$/u.test(part) ||
      /^\.+$/u.test(part) ||
      part.endsWith(".") ||
      part.endsWith(" ") ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) ||
      part.toLowerCase() === ".git"
    )
      fail("MODULE_PATH_INVALID");
  }
  if (
    name.split("/").some((part) => part.toLowerCase() === "go.mod") &&
    name !== "go.mod"
  )
    fail("MODULE_PATH_INVALID");
  return name;
}

function addModulePath(paths, name) {
  const parts = name.split("/");
  for (let n = 1; n <= parts.length; n += 1) {
    const full = parts.slice(0, n).join("/");
    const key = full.toLowerCase();
    const directory = n !== parts.length;
    const prior = paths.get(key);
    if (prior && (prior.name !== full || !prior.directory || !directory))
      fail("MODULE_PATH_COLLISION");
    paths.set(key, { name: full, directory });
  }
}

function zipExtra(bytes) {
  for (let pos = 0; pos < bytes.length;) {
    if (pos + 4 > bytes.length) fail("MODULE_ZIP_INVALID");
    const id = bytes.readUInt16LE(pos);
    const length = bytes.readUInt16LE(pos + 2);
    if ([1, 0x7075].includes(id)) fail("MODULE_ZIP_UNSUPPORTED");
    pos += 4 + length;
    if (pos > bytes.length) fail("MODULE_ZIP_INVALID");
  }
}

// Read actual ZIP content; never trust ziphash or extract through a shell.
// Supported: ordinary single-disk ZIP32, Store/Deflate, optional descriptors,
// ASCII regular files, no directories, ZIP64, encryption, links or name aliases.
function moduleZip(bytes, modulePath, version) {
  if (bytes.length < 22 || bytes.length > ZIP_LIMIT) fail("MODULE_ZIP_INVALID");
  let end = -1;
  for (
    let pos = bytes.length - 22;
    pos >= Math.max(0, bytes.length - 65557);
    pos -= 1
  ) {
    if (
      bytes.readUInt32LE(pos) === 0x06054b50 &&
      pos + 22 + bytes.readUInt16LE(pos + 20) === bytes.length
    ) {
      end = pos;
      break;
    }
  }
  if (end < 0) fail("MODULE_ZIP_INVALID");
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const start = bytes.readUInt32LE(end + 16);
  if (
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== count ||
    !count ||
    count > 30000 ||
    start + size !== end
  )
    fail("MODULE_ZIP_UNSUPPORTED");
  const prefix = `${modulePath}@${version}/`;
  const files = new Map();
  const paths = new Map();
  const regions = [];
  let total = 0;
  let pos = start;
  for (let index = 0; index < count; index += 1) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50)
      fail("MODULE_ZIP_INVALID");
    const flags = bytes.readUInt16LE(pos + 8);
    const method = bytes.readUInt16LE(pos + 10);
    const crc = bytes.readUInt32LE(pos + 16);
    const compressed = bytes.readUInt32LE(pos + 20);
    const length = bytes.readUInt32LE(pos + 24);
    const nameLength = bytes.readUInt16LE(pos + 28);
    const extraLength = bytes.readUInt16LE(pos + 30);
    const commentLength = bytes.readUInt16LE(pos + 32);
    const attrs = bytes.readUInt32LE(pos + 38);
    const local = bytes.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      !nameLength ||
      length > FILE_LIMIT ||
      (total += length) > CONTENT_LIMIT
    )
      fail("MODULE_ZIP_INVALID");
    if (
      flags & ~0x808 ||
      ![0, 8].includes(method) ||
      bytes.readUInt16LE(pos + 34) ||
      [compressed, length, local].includes(0xffffffff) ||
      (((attrs >>> 16) & 0xf000) !== 0 &&
        ((attrs >>> 16) & 0xf000) !== 0x8000) ||
      attrs & 0x10
    )
      fail("MODULE_ZIP_UNSUPPORTED");
    const nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLength);
    if (nameBytes.some((byte) => byte < 32 || byte > 126))
      fail("MODULE_PATH_INVALID");
    const name = nameBytes.toString("ascii");
    if (!name.startsWith(prefix)) fail("MODULE_PATH_INVALID");
    const relative = moduleFilePath(name.slice(prefix.length));
    addModulePath(paths, relative);
    zipExtra(
      bytes.subarray(
        pos + 46 + nameLength,
        pos + 46 + nameLength + extraLength,
      ),
    );
    if (
      local + 30 > start ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt16LE(local + 26) !== nameLength
    )
      fail("MODULE_ZIP_INVALID");
    const localExtra = bytes.readUInt16LE(local + 28);
    const data = local + 30 + nameLength + localExtra;
    let dataEnd = data + compressed;
    if (
      dataEnd > start ||
      !bytes.subarray(local + 30, local + 30 + nameLength).equals(nameBytes)
    )
      fail("MODULE_ZIP_INVALID");
    zipExtra(bytes.subarray(local + 30 + nameLength, data));
    const header = [
      bytes.readUInt32LE(local + 14),
      bytes.readUInt32LE(local + 18),
      bytes.readUInt32LE(local + 22),
    ];
    if (flags & 8) {
      if (
        header.some(
          (value, i) => value !== 0 && value !== [crc, compressed, length][i],
        )
      )
        fail("MODULE_ZIP_INVALID");
      if (dataEnd + 12 > start) fail("MODULE_ZIP_INVALID");
      if (bytes.readUInt32LE(dataEnd) === 0x08074b50) dataEnd += 4;
      if (
        dataEnd + 12 > start ||
        bytes.readUInt32LE(dataEnd) !== crc ||
        bytes.readUInt32LE(dataEnd + 4) !== compressed ||
        bytes.readUInt32LE(dataEnd + 8) !== length
      )
        fail("MODULE_ZIP_INVALID");
      dataEnd += 12;
    } else if (
      JSON.stringify(header) !== JSON.stringify([crc, compressed, length])
    )
      fail("MODULE_ZIP_INVALID");
    let content = bytes.subarray(data, data + compressed);
    if (method === 8) {
      try {
        const result = inflateRawSync(content, {
          maxOutputLength: Math.max(1, length),
          info: true,
        });
        if (result.engine.bytesWritten !== compressed)
          fail("MODULE_ZIP_INVALID");
        content = result.buffer;
      } catch {
        fail("MODULE_ZIP_INVALID");
      }
    }
    if (content.length !== length || crc32(content) !== crc)
      fail("MODULE_ZIP_INVALID");
    files.set(name, content);
    regions.push([local, dataEnd]);
    pos = next;
  }
  if (pos !== end) fail("MODULE_ZIP_INVALID");
  let boundary = 0;
  for (const [startOffset, endOffset] of regions.sort(([a], [b]) => a - b)) {
    if (startOffset !== boundary) fail("MODULE_ZIP_INVALID");
    boundary = endOffset;
  }
  if (boundary !== start) fail("MODULE_ZIP_INVALID");
  return files;
}

async function moduleFile(file, limit) {
  const entry = await fs.lstat(file);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    (await fs.realpath(file)) !== file
  )
    fail("MODULE_INPUT_TYPE_INVALID");
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size > BigInt(limit))
      fail("MODULE_INPUT_TYPE_INVALID");
    const stamp = (info) =>
      [
        info.dev,
        info.ino,
        info.size,
        info.mode,
        info.mtimeNs,
        info.ctimeNs,
      ].join(":");
    const bytes = await handle.readFile();
    const identity = stamp(stat);
    if (
      stamp(await handle.stat({ bigint: true })) !== identity ||
      BigInt(bytes.length) !== stat.size
    )
      fail("MODULE_INPUT_MOVED");
    return { bytes, identity };
  } finally {
    await handle.close();
  }
}

async function moduleContent(root) {
  if ((await fs.realpath(root)) !== root) fail("MODULE_INPUT_TYPE_INVALID");
  const files = new Map();
  let total = 0;
  async function walk(relative) {
    const directory = path.join(root, relative);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail("MODULE_INPUT_TYPE_INVALID");
    const names = await fs.readdir(directory);
    if (relative && names.length === 0) fail("MODULE_EXTRACTION_MISMATCH");
    for (const name of names) {
      const child = moduleFilePath(path.posix.join(relative, name));
      const target = path.join(root, child);
      const info = await fs.lstat(target);
      if (info.isSymbolicLink()) fail("MODULE_INPUT_TYPE_INVALID");
      if (info.isDirectory()) await walk(child);
      else {
        const file = await moduleFile(target, FILE_LIMIT);
        if ((total += file.bytes.length) > CONTENT_LIMIT || files.size >= 30000)
          fail("MODULE_INPUT_TYPE_INVALID");
        files.set(child, file);
      }
    }
  }
  await walk("");
  return files;
}

async function authenticateModules(inputs, sums) {
  const result = [];
  for (const input of inputs) {
    const zip = await moduleFile(input.zipPath, ZIP_LIMIT);
    const mod = await moduleFile(input.modPath, 16 * 1024 * 1024);
    const content = await moduleContent(input.contentRoot);
    const files = moduleZip(zip.bytes, input.modulePath, input.version);
    const zipH1 = goH1(files);
    const modH1 = goH1(new Map([["go.mod", mod.bytes]]));
    if (
      zipH1 !== sums.get(`${input.modulePath} ${input.version}`) ||
      modH1 !== sums.get(`${input.modulePath} ${input.version}/go.mod`)
    )
      fail("MODULE_CHECKSUM_MISMATCH");
    const prefix = `${input.modulePath}@${input.version}/`;
    if (
      !files.get(`${prefix}go.mod`)?.equals(mod.bytes) ||
      files.size !== content.size ||
      [...files].some(
        ([name, bytes]) =>
          !content.get(name.slice(prefix.length))?.bytes.equals(bytes),
      )
    )
      fail("MODULE_EXTRACTION_MISMATCH");
    const text = mod.bytes.toString("utf8").replace(/\/\/[^\n]*/gu, "");
    if (/^\s*replace\b/mu.test(text)) fail("MODULE_REPLACEMENT_UNSUPPORTED");
    if (
      !text.startsWith(`module ${input.modulePath}\n`) ||
      !/^go 1\.23\.0\s*$/mu.test(text)
    )
      fail("MODULE_GRAPH_UNSUPPORTED");
    const zipHash = input.zipHashPath
      ? await moduleFile(input.zipHashPath, 128)
      : undefined;
    if (zipHash && !zipHash.bytes.equals(Buffer.from(zipH1)))
      fail("MODULE_ZIPHASH_MISMATCH");
    const ledger = Object.freeze({
      modulePath: input.modulePath,
      version: input.version,
      zipH1,
      modH1,
      zipSha256: digest(zip.bytes),
      modSha256: digest(mod.bytes),
      fileCount: files.size,
    });
    result.push({ input, zip, mod, content, zipHash, files, ledger });
  }
  return result;
}

async function assertModuleInputsUnchanged(modules) {
  for (const prior of modules) {
    const current = await authenticateModules(
      [prior.input],
      new Map([
        [
          `${prior.input.modulePath} ${prior.input.version}`,
          prior.ledger.zipH1,
        ],
        [
          `${prior.input.modulePath} ${prior.input.version}/go.mod`,
          prior.ledger.modH1,
        ],
      ]),
    );
    const next = current[0];
    if (
      next.zip.identity !== prior.zip.identity ||
      next.mod.identity !== prior.mod.identity ||
      next.zipHash?.identity !== prior.zipHash?.identity ||
      next.content.size !== prior.content.size ||
      [...prior.content].some(
        ([name, file]) => next.content.get(name)?.identity !== file.identity,
      )
    )
      fail("MODULE_INPUT_MOVED");
  }
}

async function installModules(modules, cache) {
  const entries = new Map();
  async function write(relative, bytes) {
    entries.set(relative, { bytes, mode: "100644" });
    const target = path.join(cache, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o400 });
  }
  for (const { input, zip, mod, files, ledger } of modules) {
    const prefix = `${input.modulePath}@${input.version}/`;
    for (const [name, bytes] of files) await write(name, bytes);
    const download = `cache/download/${input.modulePath}/@v/${input.version}`;
    await write(`${download}.zip`, zip.bytes);
    await write(`${download}.mod`, mod.bytes);
    await write(`${download}.ziphash`, Buffer.from(ledger.zipH1));
    // Version is declared and bound by go.mod/go.sum, not proxy .info claims.
    // Go's cached Stat needs .info; it contains no timestamp or caller metadata.
    await write(
      `${download}.info`,
      Buffer.from(JSON.stringify({ Version: input.version })),
    );
    if (!entries.has(`${prefix}go.mod`)) fail("MODULE_GRAPH_UNSUPPORTED");
  }
  return { entries };
}

function assertBinaryDependencies(info, modules) {
  if (info.Deps !== undefined && !Array.isArray(info.Deps))
    fail("BINARY_DEPENDENCIES_INVALID");
  const used = new Set();
  for (const dependency of info.Deps ?? []) {
    if (!dependency || typeof dependency !== "object")
      fail("BINARY_DEPENDENCIES_INVALID");
    const module = modules.find(
      ({ input }) => input.modulePath === dependency.Path,
    );
    if (
      !module ||
      used.has(dependency.Path) ||
      dependency.Version !== module.input.version ||
      dependency.Sum !== module.ledger.zipH1 ||
      dependency.Replace
    )
      fail("BINARY_DEPENDENCIES_INVALID");
    used.add(dependency.Path);
  }
}

async function writeSources(snapshot, destination) {
  await fs.mkdir(destination);
  for (const [relative, entry] of snapshot.entries) {
    if (
      path.posix.isAbsolute(relative) ||
      relative.split("/").some((part) => part === ".." || part === ".git") ||
      !Buffer.isBuffer(entry.bytes) ||
      !["100644", "100755"].includes(entry.mode)
    )
      fail("SOURCE_INPUT_INVALID");
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.bytes, {
      flag: "wx",
      mode: entry.mode === "100755" ? 0o500 : 0o400,
    });
  }
}

async function assertSnapshotUnchanged(
  snapshot,
  directory,
  failure = "SOURCE_SNAPSHOT_MOVED",
) {
  const expected = [...snapshot.entries.keys()].sort();
  const found = [];
  async function walk(relative) {
    for (const name of await fs.readdir(path.join(directory, relative))) {
      const child = path.posix.join(relative, name);
      const stat = await fs.lstat(path.join(directory, child));
      if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(child);
      else {
        found.push(child);
        const { bytes, executable } = await regularFile(
          path.join(directory, child),
        );
        const entry = snapshot.entries.get(child);
        if (
          !entry ||
          !bytes.equals(entry.bytes) ||
          executable !== (entry.mode === "100755")
        )
          fail(failure);
      }
    }
  }
  await walk("");
  if (JSON.stringify(found.sort()) !== JSON.stringify(expected)) fail(failure);
}

// Create only fixed candidate-local directories. Existing symlinks, tracked
// output roots and a root reached through a symlink are refused before writes.
async function ownedParent(root, snapshot) {
  for (const relative of ["_output", "_output/tmp"]) {
    if (
      [...snapshot.entries.keys()].some(
        (name) => name === relative || name.startsWith(`${relative}/`),
      )
    )
      fail("OUTPUT_TRACKED");
    const target = path.join(root, relative);
    try {
      await fs.mkdir(target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail("OUTPUT_TYPE_INVALID");
  }
  return path.join(root, "_output/tmp");
}

function cleanEnvironment(scratch, sdk, platform) {
  return {
    PATH: `${path.join(sdk, "bin")}:/usr/bin:/bin`,
    HOME: path.join(scratch, "home"),
    TMPDIR: path.join(scratch, "tmp"),
    XDG_CONFIG_HOME: path.join(scratch, "home/config"),
    LANG: "C",
    LC_ALL: "C",
    GOROOT: sdk,
    GOPATH: path.join(scratch, "gopath"),
    GOMODCACHE: path.join(scratch, "modules"),
    GOCACHE: path.join(scratch, "cache"),
    GOENV: "off",
    GOWORK: "off",
    GOTOOLCHAIN: "local",
    GO111MODULE: "on",
    GOFLAGS: "",
    GOEXPERIMENT: "",
    GOPROXY: "off",
    GOSUMDB: "off",
    GOVCS: "*:off",
    GOAUTH: "off",
    CGO_ENABLED: "0",
    GOOS: platform.goos,
    GOARCH: platform.goarch,
    GOAMD64: "v1",
    GOARM64: "v8.0",
    GOMAXPROCS: "2",
  };
}

function go(sdk, args, cwd, env) {
  try {
    return execFileSync(path.join(sdk, "bin/go"), args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // Retain bounded compiler diagnostics, without environment/auth state.
    // An exit is a known failure; signals/timeouts/spawn failures are unknown.
    // Neither category is retried or substituted here.
    const exited = Number.isInteger(error.status) && error.status !== 0;
    throw new Error(
      `GO_BACKEND_COMMAND_${exited ? "FAILED" : "OUTCOME_UNKNOWN"}:${args[0]}`,
      {
        cause: Object.freeze({
          exitCode: exited ? error.status : null,
          signal: typeof error.signal === "string" ? error.signal : null,
          diagnostic: String(error.stderr ?? "").slice(0, 8192),
        }),
      },
    );
  }
}

function assertBinaryInfo(info, platform) {
  if (!info || typeof info !== "object" || !Array.isArray(info.Settings))
    fail("BINARY_IDENTITY_INVALID");
  const settings = new Map();
  for (const entry of info.Settings ?? []) {
    if (settings.has(entry.Key)) fail("BINARY_IDENTITY_INVALID");
    settings.set(entry.Key, entry.Value);
  }
  if (
    info.GoVersion !== VERSION ||
    info.Path !== `${MODULE}/cmd/farol` ||
    info.Main?.Path !== MODULE ||
    info.Main?.Version !== "(devel)" ||
    info.Main?.Replace ||
    settings.get("GOOS") !== platform.goos ||
    settings.get("GOARCH") !== platform.goarch ||
    settings.get("CGO_ENABLED") !== "0" ||
    settings.get("-trimpath") !== "true" ||
    settings.get("-compiler") !== "gc" ||
    settings.get("-buildmode") !== "exe" ||
    [...settings.keys()].some((key) => key.startsWith("vcs"))
  )
    fail("BINARY_IDENTITY_INVALID");
}

// Darwin-only contract: read the Go string header at boot.BuildID's measured
// symbol address through Mach-O segment mappings, then compare its exact bytes.
// This inspects the executable; it never launches it. Metadata or an unrelated
// occurrence of the build ID elsewhere in the binary cannot satisfy this check.
function assertEmbeddedBuildId(bytes, symbols, platform, expected) {
  const invalid = () => fail("BINARY_BUILD_ID_INVALID");
  if (
    bytes.length < 32 ||
    bytes.readUInt32LE(0) !== 0xfeedfacf ||
    bytes.readUInt32LE(4) !==
      (platform.goarch === "arm64" ? 0x0100000c : 0x01000007) ||
    bytes.readUInt32LE(12) !== 2
  )
    invalid();
  const count = bytes.readUInt32LE(16);
  const end = 32 + bytes.readUInt32LE(20);
  if (count === 0 || count > 4096 || end > bytes.length) invalid();
  const segments = [];
  let offset = 32;
  for (let index = 0; index < count; index += 1) {
    if (offset + 8 > end) invalid();
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > end) invalid();
    if (command === 0x19) {
      if (size < 72) invalid();
      const address = bytes.readBigUInt64LE(offset + 24);
      const fileOffset = bytes.readBigUInt64LE(offset + 40);
      const fileSize = bytes.readBigUInt64LE(offset + 48);
      if (fileOffset + fileSize > BigInt(bytes.length)) invalid();
      segments.push({ address, fileOffset, fileSize });
    }
    offset += size;
  }
  if (offset !== end) invalid();
  function filePosition(address, size) {
    const matches = segments.filter(
      (segment) =>
        address >= segment.address &&
        address + BigInt(size) <= segment.address + segment.fileSize,
    );
    if (matches.length !== 1) invalid();
    return Number(matches[0].fileOffset + address - matches[0].address);
  }
  const matches = symbols
    .split("\n")
    .map((line) => /^\s*([a-f0-9]+)\s+[dD]\s+(.+)$/iu.exec(line))
    .filter((match) => match?.[2] === SYMBOL);
  if (matches.length !== 1) fail("BUILD_ID_SYMBOL_MISSING");
  const header = filePosition(BigInt(`0x${matches[0][1]}`), 16);
  const address = bytes.readBigUInt64LE(header);
  const size = bytes.readBigUInt64LE(header + 8);
  if (size !== BigInt(expected.length)) invalid();
  const string = filePosition(address, expected.length);
  if (
    !bytes
      .subarray(string, string + expected.length)
      .equals(Buffer.from(expected))
  )
    invalid();
}

/**
 * Callable from the existing authenticated Node build after it creates its
 * clean whole-HEAD buildIdentity. No CLI, manifest, packaging or runtime hook.
 * toolchain = { root: canonical SDK, treeSha256: APPROVED full-SDK digest,
 *   version: 'go1.26.2', goos: 'darwin', goarch: 'arm64' | 'amd64' }.
 * platform must match that declaration. This is a CGO-free production build.
 * moduleInputs must explicitly name BOTH pinned modules (see REQUIRED_MODULES):
 * [{ modulePath, version, zipPath, modPath, contentRoot, zipHashPath? }]. Paths
 * must be canonical absolute regular inputs. contentRoot holds the exact ZIP
 * contents without module@version/. zipHashPath is an optional checked claim.
 * Authentication uses committed go.sum, never cache claims or a network lookup.
 * Only these inputs seed a fresh owned module cache; other needed modules fail.
 * ZIP support is intentionally bounded (see moduleZip), not a general unzipper.
 * Returns measured binary/source/Go/build/platform evidence for Lead's later
 * package attestation; does not grant or claim packaged/installed acceptance.
 */
export async function buildGoBackend({
  repositoryRoot,
  buildIdentity,
  toolchain,
  platform,
  moduleInputs,
}) {
  buildIdentity = Object.freeze({ ...assertBuildIdentity(buildIdentity) });
  toolchain = Object.freeze({ ...toolchain });
  platform = Object.freeze({ ...platform });
  validateDeclaration(toolchain, platform);
  if (
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    process.execArgv.some((arg) =>
      /^(?:--(?:experimental-)?loader|--import|--require|-r)(?:=|$)/u.test(arg),
    )
  )
    fail("NODE_STARTUP_HOOK");
  const root = path.resolve(repositoryRoot);
  if ((await fs.realpath(root)) !== root) fail("REPOSITORY_ROOT_INVALID");
  const initial = sourceSnapshot(root);
  assertSource(initial, buildIdentity);
  const sums = dependencySums(initial);
  const declaredModules = declareModuleInputs(moduleInputs);
  const scratch = await fs.mkdtemp(
    path.join(await ownedParent(root, initial), "go-backend-"),
  );
  let artifact;
  let failure;
  try {
    await writeOwner(scratch);
    const source = path.join(scratch, "source");
    const sdk = path.join(scratch, "sdk");
    if ((await toolchainSnapshot(toolchain.root, sdk)) !== toolchain.treeSha256)
      fail("TOOLCHAIN_DIGEST_MISMATCH");
    await writeSources(initial, source);
    for (const name of ["home", "tmp", "cache", "modules", "gopath"])
      await fs.mkdir(path.join(scratch, name));
    const modules = await authenticateModules(declaredModules, sums);
    const moduleSnapshot = await installModules(
      modules,
      path.join(scratch, "modules"),
    );
    await assertModuleInputsUnchanged(modules);
    await assertSnapshotUnchanged(
      moduleSnapshot,
      path.join(scratch, "modules"),
      "MODULE_CACHE_MOVED",
    );
    const env = cleanEnvironment(scratch, sdk, platform);
    if (
      go(sdk, ["version"], source, env).trim() !==
      `go version ${VERSION} ${platform.goos}/${platform.goarch}`
    )
      fail("TOOLCHAIN_VERSION_MISMATCH");
    const moduleMode = "readonly";
    const binary = path.join(scratch, "farol-backend");
    const ldflags = `-X=${SYMBOL}=${buildIdentity.buildId}`;
    go(
      sdk,
      [
        "build",
        "-p=2",
        "-compiler=gc",
        "-buildmode=exe",
        "-trimpath",
        "-buildvcs=false",
        `-mod=${moduleMode}`,
        `-ldflags=${ldflags}`,
        "-o",
        binary,
        ENTRY,
      ],
      source,
      env,
    );
    const compiled = await regularFile(binary);
    if (!compiled.executable || compiled.bytes.length === 0)
      fail("BINARY_TYPE_INVALID");
    const observedInfo = go(
      sdk,
      ["version", "-m", "-json", binary],
      source,
      env,
    );
    let info;
    try {
      info = JSON.parse(observedInfo);
    } catch {
      fail("BINARY_IDENTITY_INVALID");
    }
    assertBinaryInfo(info, platform);
    assertBinaryDependencies(info, modules);
    assertEmbeddedBuildId(
      compiled.bytes,
      go(sdk, ["tool", "nm", binary], source, env),
      platform,
      buildIdentity.buildId,
    );
    await assertSnapshotUnchanged(initial, source);
    await assertModuleInputsUnchanged(modules);
    await assertSnapshotUnchanged(
      moduleSnapshot,
      path.join(scratch, "modules"),
      "MODULE_CACHE_MOVED",
    );
    if (
      (await measureGoToolchain(sdk)) !== toolchain.treeSha256 ||
      (await measureGoToolchain(toolchain.root)) !== toolchain.treeSha256
    )
      fail("TOOLCHAIN_MOVED");
    assertSource(sourceSnapshot(root), buildIdentity);
    const { bytes, executable } = await regularFile(binary);
    if (!executable || !bytes.equals(compiled.bytes)) fail("BINARY_MOVED");
    // Own a unique output directory; never delete or replace another artifact.
    artifact = await fs.mkdtemp(
      path.join(path.dirname(scratch), "go-artifact-"),
    );
    await writeOwner(artifact);
    const output = path.join(artifact, "farol-backend");
    await fs.writeFile(output, bytes, { flag: "wx", mode: 0o500 });
    const measured = await regularFile(output);
    if (!measured.executable || !measured.bytes.equals(bytes))
      fail("BINARY_MOVED");
    assertSource(sourceSnapshot(root), buildIdentity);
    await assertModuleInputsUnchanged(modules);
    await assertSnapshotUnchanged(
      moduleSnapshot,
      path.join(scratch, "modules"),
      "MODULE_CACHE_MOVED",
    );
    const dependencies = Object.freeze(modules.map(({ ledger }) => ledger));
    const dependencyDigest = digest(
      `farol-go-dependencies-v1\0${JSON.stringify(dependencies)}`,
    );
    return Object.freeze({
      path: output,
      sha256: digest(bytes),
      size: bytes.length,
      buildId: buildIdentity.buildId,
      sourceCommit: initial.commit,
      sourceTreeDigest: initial.treeDigest,
      inputExact: true,
      goVersion: info.GoVersion,
      goToolchainSha256: toolchain.treeSha256,
      entry: ENTRY,
      goos: platform.goos,
      goarch: platform.goarch,
      cgoEnabled: false,
      trimpath: true,
      buildvcs: false,
      moduleMode,
      dependencies,
      dependencyDigest,
      goModSha256: digest(initial.entries.get("go.mod").bytes),
      goSumSha256: digest(initial.entries.get("go.sum").bytes),
    });
  } catch (error) {
    if (artifact) await fs.rm(artifact, { recursive: true, force: true });
    failure = error;
    throw error;
  } finally {
    if (failure) await settleFailedScratch(scratch, failure);
    else await fs.rm(scratch, { recursive: true, force: true });
  }
}
