import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  promotionLeasePath,
  verifyPromotionLease,
} from "../src/apps/desktop/promotion-lease.ts";
import { treeDigest } from "./artifact-digest.mjs";
import { observeUpdateSlot } from "./update-slot-observer.mjs";

// Combined app/profile limits, checked by a metadata-only inventory before any
// content is copied. Reads use one 1 MiB buffer, never an entire profile file.
// Explicit old-beta selectors for this legacy install reader.
const LEGACY_PRODUCT_NAME = "Farol Next Preview";
const LEGACY_STATE_DIRECTORY = "farol-next-state";

const MAX_ENTRIES = 100_000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_DEPTH = 128;
const CHUNK_BYTES = 1024 * 1024;
const RECEIPT_NAME = "preservation.json";
const RECEIPT_SCHEMA = "farol.closed-installed-pair-preservation/1";
const MAX_RECEIPT_BYTES = 4096;
const SHA256 = /^[a-f0-9]{64}$/u;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const IDENTITY = ["dev", "ino", "mode", "uid", "gid"];
const STABLE = [...IDENTITY, "nlink", "size", "mtimeNs", "ctimeNs"];

function requireValue(condition, code) {
  if (!condition) throw new Error(`SUPERVISED_BACKUP_${code}`);
}

function same(a, b, fields = STABLE) {
  return fields.every((field) => a[field] === b[field]);
}

function canonical(value) {
  requireValue(
    typeof value === "string" &&
      value.length > 1 &&
      !value.includes("\0") &&
      Buffer.byteLength(value) <= 4096 &&
      path.isAbsolute(value) &&
      path.resolve(value) === value &&
      path.normalize(value) === value &&
      value.split(path.sep).length <= MAX_DEPTH,
    "PATH_INVALID",
  );
  return value;
}

function sourceClaims(value) {
  const keys = ["digest", "version", "buildId"];
  requireValue(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)) &&
      typeof value.version === "string" &&
      value.version.length <= 128 &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version) &&
      typeof value.digest === "string" &&
      SHA256.test(value.digest) &&
      typeof value.buildId === "string" &&
      SHA256.test(value.buildId),
    "SOURCE_INVALID",
  );
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, value[key]])),
  );
}

function originalLifetime(value) {
  requireValue(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      value.pid !== process.pid &&
      typeof value.processStart === "string" &&
      value.processStart.length > 0 &&
      value.processStart.length <= 256 &&
      value.processStart.trim() === value.processStart &&
      !/[\u0000-\u001f\u007f]/u.test(value.processStart) &&
      typeof value.startedAt === "string" &&
      Number.isFinite(Date.parse(value.startedAt)) &&
      new Date(value.startedAt).toISOString() === value.startedAt,
    "PREDECESSOR_INVALID",
  );
  return Object.freeze({
    pid: value.pid,
    processStart: value.processStart,
    startedAt: value.startedAt,
  });
}

function closedProof(value, original) {
  requireValue(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 5 &&
      Object.keys(original).every((key) => value[key] === original[key]) &&
      typeof value.quitDigest === "string" &&
      SHA256.test(value.quitDigest) &&
      value.stateIdentity &&
      typeof value.stateIdentity === "object" &&
      !Array.isArray(value.stateIdentity) &&
      Object.keys(value.stateIdentity).length === 2 &&
      ["device", "inode"].every(
        (key) =>
          typeof value.stateIdentity[key] === "string" &&
          /^(0|[1-9][0-9]{0,19})$/u.test(value.stateIdentity[key]),
      ) &&
      value.stateIdentity.inode !== "0",
    "CLOSURE_INVALID",
  );
  return Object.freeze({
    ...original,
    quitDigest: value.quitDigest,
    stateIdentity: Object.freeze({ ...value.stateIdentity }),
  });
}

function inside(parent, target) {
  return target === parent || target.startsWith(parent + path.sep);
}

function ancestors(paths) {
  const result = new Set();
  for (let directory of paths) {
    while (true) {
      result.add(directory);
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...result].sort((a, b) => a.length - b.length);
}

async function checkParents(paths, uid, privateParent, retained) {
  const result = new Map();
  for (const directory of paths) {
    const info = await fs.lstat(directory, { bigint: true });
    const privateMode = directory === privateParent;
    const stickyAncestor =
      !privateMode && info.uid === 0n && (info.mode & 0o1000n) !== 0n;
    requireValue(
      info.isDirectory() &&
        (info.uid === uid || (!privateMode && info.uid === 0n)) &&
        ((info.mode & BigInt(privateMode ? 0o077 : 0o022)) === 0n ||
          stickyAncestor) &&
        (await fs.realpath(directory)) === directory,
      "PARENT_UNSAFE",
    );
    requireValue(
      !retained || same(info, retained.get(directory), IDENTITY),
      "PARENT_CHANGED",
    );
    result.set(directory, info);
  }
  return result;
}

async function checkFrames(frames) {
  for (const frame of frames) {
    requireValue(
      same(frame.info, await frame.fd.stat({ bigint: true }), frame.fields) &&
        same(
          frame.info,
          await fs.lstat(frame.file, { bigint: true }),
          frame.fields,
        ) &&
        (await fs.realpath(frame.file)) === frame.file,
      "DIRECTORY_CHANGED",
    );
  }
}

async function withDirectory(file, uid, frames, expected, mutable, operation) {
  await checkFrames(frames);
  const info = await fs.lstat(file, { bigint: true });
  requireValue(info.isDirectory() && info.uid === uid, "DIRECTORY_UNSAFE");
  requireValue(!expected || same(info, expected), "DIRECTORY_CHANGED");
  requireValue((await fs.realpath(file)) === file, "DIRECTORY_UNSAFE");
  const fd = await fs.open(file, READ | constants.O_DIRECTORY);
  const chain = [
    ...frames,
    { file, fd, info, fields: mutable ? IDENTITY : STABLE },
  ];
  try {
    await checkFrames(chain);
    const result = await operation(chain, info);
    await checkFrames(chain);
    return result;
  } finally {
    await fd.close();
  }
}

async function preflightSpace(parent, uid, retainedParent, budget) {
  await withDirectory(parent, uid, [], undefined, true, async (frames) => {
    requireValue(
      same(frames.at(-1).info, retainedParent, IDENTITY),
      "PARENT_CHANGED",
    );
    const space = await fs.statfs(parent, { bigint: true });
    requireValue(
      typeof space.bsize === "bigint" &&
        space.bsize >= 512n &&
        space.bsize <= 1024n * 1024n &&
        typeof space.bavail === "bigint" &&
        space.bavail >= 0n,
      "SPACE_UNCONFIRMED",
    );
    // Rounded payload plus four blocks and the maximum link length per entry:
    // allocation slack, directory/metadata blocks and literal symlink storage.
    // Four extra entries cover the pair roots, wrapper root and receipt; 1 MiB
    // adds fixed headroom. This bounded estimate is not a capacity reservation.
    const block = space.bsize;
    const payload = ((BigInt(budget.bytes) + block - 1n) / block) * block;
    const overhead =
      BigInt(budget.entries + 4) * (4n * block + 4096n) + 1024n * 1024n;
    requireValue(
      space.bavail * block >= payload + overhead,
      "SPACE_INSUFFICIENT",
    );
  });
}

async function writeReceipt(file, bytes, uid, frames) {
  requireValue(
    bytes.length > 0 && bytes.length <= MAX_RECEIPT_BYTES,
    "RECEIPT_SIZE",
  );
  await checkFrames(frames);
  const fd = await fs.open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    const created = await fd.stat({ bigint: true });
    requireValue(
      created.isFile() &&
        created.uid === uid &&
        created.nlink === 1n &&
        created.size === 0n &&
        (created.mode & 0o7777n) === 0o600n,
      "RECEIPT_UNSAFE",
    );
    let offset = 0;
    while (offset < bytes.length) {
      await checkFrames(frames);
      const part = await fd.write(bytes, offset, bytes.length - offset, offset);
      requireValue(
        part.bytesWritten > 0 && part.bytesWritten <= bytes.length - offset,
        "RECEIPT_WRITE_UNCONFIRMED",
      );
      offset += part.bytesWritten;
    }
    await fd.chmod(0o400);
    await fd.sync();
    const info = await fd.stat({ bigint: true });
    requireValue(
      info.isFile() &&
        info.uid === uid &&
        info.nlink === 1n &&
        info.dev === created.dev &&
        info.ino === created.ino &&
        info.size === BigInt(bytes.length) &&
        (info.mode & 0o7777n) === 0o400n &&
        same(info, await fs.lstat(file, { bigint: true })),
      "RECEIPT_CHANGED",
    );
    await checkFrames(frames);
    return { info, bytes };
  } finally {
    await fd.close();
  }
}

async function verifyReceipt(file, retained, frames) {
  await checkFrames(frames);
  requireValue(
    same(retained.info, await fs.lstat(file, { bigint: true })),
    "RECEIPT_CHANGED",
  );
  const fd = await fs.open(file, READ);
  try {
    requireValue(
      same(retained.info, await fd.stat({ bigint: true })),
      "RECEIPT_CHANGED",
    );
    const bytes = Buffer.alloc(retained.bytes.length + 1);
    let offset = 0;
    while (offset < bytes.length) {
      await checkFrames(frames);
      const part = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (part.bytesRead === 0) break;
      offset += part.bytesRead;
    }
    requireValue(
      offset === retained.bytes.length &&
        retained.bytes.equals(bytes.subarray(0, offset)) &&
        same(retained.info, await fd.stat({ bigint: true })) &&
        same(retained.info, await fs.lstat(file, { bigint: true })),
      "RECEIPT_CHANGED",
    );
    await checkFrames(frames);
  } finally {
    await fd.close();
  }
}

async function entryNames(directory, budget) {
  const names = [];
  // opendir bounds the directory enumeration buffer; readdir could allocate an
  // unbounded array before an entry-count refusal was possible.
  const dir = await fs.opendir(directory, { bufferSize: 32 });
  for await (const entry of dir) {
    requireValue(++budget.entries <= MAX_ENTRIES, "ENTRY_LIMIT");
    requireValue(
      entry.name !== "." &&
        entry.name !== ".." &&
        !entry.name.includes("\ufffd") &&
        !entry.name.includes(path.sep),
      "NAME_INVALID",
    );
    names.push(entry.name);
  }
  return names.sort();
}

async function inventory(root, uid, budget) {
  const result = new Map();
  async function walk(directory, relative, frames, depth) {
    requireValue(depth <= MAX_DEPTH, "DEPTH_LIMIT");
    await withDirectory(
      directory,
      uid,
      frames,
      undefined,
      false,
      async (chain, info) => {
        result.set(relative, { kind: "directory", info });
        for (const name of await entryNames(directory, budget)) {
          await checkFrames(chain);
          const file = path.join(directory, name);
          requireValue(Buffer.byteLength(file) <= 4096, "PATH_LIMIT");
          const child = path.join(relative, name);
          const stat = await fs.lstat(file, { bigint: true });
          requireValue(stat.uid === uid, "ENTRY_OWNER");
          if (stat.isDirectory()) {
            await walk(file, child, chain, depth + 1);
          } else if (stat.isSymbolicLink()) {
            const link = await fs.readlink(file, { encoding: "buffer" });
            requireValue(link.length > 0 && link.length <= 4096, "LINK_LIMIT");
            requireValue(
              same(stat, await fs.lstat(file, { bigint: true })),
              "SOURCE_CHANGED",
            );
            result.set(child, { kind: "symlink", info: stat, link });
          } else {
            requireValue(stat.isFile() && stat.nlink === 1n, "ENTRY_UNSAFE");
            requireValue(
              stat.size >= 0n && stat.size <= BigInt(MAX_FILE_BYTES),
              "FILE_LIMIT",
            );
            budget.bytes += Number(stat.size);
            requireValue(budget.bytes <= MAX_TOTAL_BYTES, "TOTAL_LIMIT");
            result.set(child, { kind: "file", info: stat });
          }
        }
      },
    );
  }
  await walk(root, "", [], 0);
  return result;
}

async function fileBytes(file, retained, frames, destination) {
  await checkFrames(frames);
  requireValue(
    same(retained, await fs.lstat(file, { bigint: true })),
    "SOURCE_CHANGED",
  );
  const input = await fs.open(file, READ);
  let output;
  let copiedInfo;
  try {
    requireValue(
      same(retained, await input.stat({ bigint: true })),
      "SOURCE_CHANGED",
    );
    if (destination) {
      output = await fs.open(
        destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let offset = 0;
    while (offset <= Number(retained.size)) {
      await checkFrames(frames);
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.length, Number(retained.size) - offset + 1),
        offset,
      );
      if (bytesRead === 0) break;
      requireValue(
        offset + bytesRead <= Number(retained.size),
        "SOURCE_CHANGED",
      );
      hash.update(buffer.subarray(0, bytesRead));
      if (output) {
        let written = 0;
        while (written < bytesRead) {
          const part = await output.write(
            buffer,
            written,
            bytesRead - written,
            offset + written,
          );
          requireValue(part.bytesWritten > 0, "WRITE_UNCONFIRMED");
          written += part.bytesWritten;
        }
      }
      offset += bytesRead;
    }
    requireValue(
      offset === Number(retained.size) &&
        same(retained, await input.stat({ bigint: true })) &&
        same(retained, await fs.lstat(file, { bigint: true })),
      "SOURCE_CHANGED",
    );
    await checkFrames(frames);
    if (output) {
      await output.chmod(Number(retained.mode & 0o7777n));
      await output.sync();
      const info = await output.stat({ bigint: true });
      requireValue(
        info.isFile() &&
          info.nlink === 1n &&
          same(info, await fs.lstat(destination, { bigint: true })),
        "DESTINATION_CHANGED",
      );
      copiedInfo = info;
    }
    return { digest: hash.digest("hex"), info: copiedInfo };
  } finally {
    try {
      if (output) await output.close();
    } finally {
      await input.close();
    }
  }
}

// The profile fingerprint is private preservation evidence, not a package
// schema. Unlike the package digest, it records arbitrary/dangling link bytes
// without resolving them. Root modes and each sorted, framed JSON record count.
async function readTree(
  root,
  uid,
  entries,
  destination,
  parentFrames = [],
  copied,
) {
  const hash = createHash("sha256").update(
    "farol.closed-profile-preservation/1\0",
  );
  const children = new Map();
  for (const [relative] of entries) {
    if (!relative) continue;
    const parent = path.dirname(relative) === "." ? "" : path.dirname(relative);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(relative);
  }
  function record(relative, entry, data = null) {
    const bytes = Buffer.from(
      JSON.stringify([
        relative,
        entry.kind,
        Number(entry.info.mode & 0o7777n),
        data,
      ]),
    );
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    hash.update(size).update(bytes);
  }
  async function walk(relative, sourceFrames, destinationFrames) {
    const entry = entries.get(relative);
    const file = path.join(root, relative);
    const target = destination && path.join(destination, relative);
    await withDirectory(
      file,
      uid,
      sourceFrames,
      entry.info,
      false,
      async (chain) => {
        async function contents(outputFrames) {
          record(relative, entry);
          for (const child of children.get(relative) ?? []) {
            const item = entries.get(child);
            const source = path.join(root, child);
            const output = destination && path.join(destination, child);
            const frames = [...chain, ...outputFrames];
            await checkFrames(frames);
            requireValue(
              same(item.info, await fs.lstat(source, { bigint: true })),
              "SOURCE_CHANGED",
            );
            if (item.kind === "directory") {
              await walk(child, chain, outputFrames);
            } else if (item.kind === "symlink") {
              const link = await fs.readlink(source, { encoding: "buffer" });
              requireValue(
                item.link.equals(link) &&
                  same(item.info, await fs.lstat(source, { bigint: true })),
                "SOURCE_CHANGED",
              );
              if (output) {
                await fs.symlink(link, output);
                const mode = Number(item.info.mode & 0o7777n);
                if (
                  Number(
                    (await fs.lstat(output, { bigint: true })).mode & 0o7777n,
                  ) !== mode
                )
                  await fs.lchmod(output, mode);
                const made = await fs.lstat(output, { bigint: true });
                requireValue(
                  made.isSymbolicLink() &&
                    made.uid === uid &&
                    (made.mode & 0o7777n) === (item.info.mode & 0o7777n) &&
                    link.equals(
                      await fs.readlink(output, { encoding: "buffer" }),
                    ),
                  "DESTINATION_CHANGED",
                );
                copied.set(child, { kind: "symlink", info: made, link });
              }
              record(child, item, link.toString("base64"));
            } else {
              const content = await fileBytes(
                source,
                item.info,
                frames,
                output,
              );
              record(child, item, content.digest);
              if (output)
                copied.set(child, {
                  kind: "file",
                  info: content.info,
                  digest: content.digest,
                });
            }
            await checkFrames(frames);
          }
        }
        if (!target) return contents([]);
        await checkFrames(destinationFrames);
        await fs.mkdir(target, { mode: 0o700 });
        await withDirectory(
          target,
          uid,
          destinationFrames,
          undefined,
          true,
          async (frames) => {
            await contents(frames);
            const own = frames.at(-1);
            await own.fd.chmod(Number(entry.info.mode & 0o7777n));
            own.info = await own.fd.stat({ bigint: true });
            await own.fd.sync();
            copied.set(relative, { kind: "directory", info: own.info });
          },
        );
      },
    );
  }
  await walk(
    "",
    destination ? [] : parentFrames,
    destination ? parentFrames : [],
  );
  return hash.digest("hex");
}

function sameInventory(observed, retained) {
  return (
    observed.size === retained.size &&
    [...retained].every(([name, entry]) => {
      const current = observed.get(name);
      return (
        current &&
        current.kind === entry.kind &&
        same(current.info, entry.info) &&
        (!entry.link || entry.link.equals(current.link))
      );
    })
  );
}

/**
 * Preserves one closed installed pair. No restore, launch, receipt rewrite or
 * cleanup is performed. Failures retain any partial root and expose only its
 * path, never profile filenames/content or raw filesystem errors. POSIX modes,
 * file bytes and link bytes are preserved; ACLs/xattrs/timestamps are not claimed.
 * The caller retains the exact promotion lease until handoff and re-verifies
 * before use. This capability is evidence, not permission to rewind live state.
 * Initial capture requires unchanged live sources. Later verification permits
 * legitimate updater staging in the live profile and validates the saved pair,
 * original root identities, exact closed proof and held lease instead.
 * preservation.json describes the pair after this capability is gone. Receipt
 * presence alone does not prove a completed capture or authorize restoration.
 */
export async function preserveClosedInstalledPair({
  destinationParent,
  predecessor,
  lease,
  expectedSource,
}) {
  let root;
  try {
    const parent = canonical(destinationParent);
    const home = canonical(os.userInfo().homedir);
    const installed = path.join(home, "Applications/Farol.app");
    const userData = path.join(
      home,
      `Library/Application Support/${LEGACY_PRODUCT_NAME}`,
    );
    const stateRoot = path.join(userData, LEGACY_STATE_DIRECTORY);
    requireValue(
      !inside(installed, parent) && !inside(userData, parent),
      "DESTINATION_OVERLAP",
    );
    const source = sourceClaims(expectedSource);
    const original = originalLifetime(predecessor?.original);
    requireValue(
      typeof predecessor?.observeClosed === "function",
      "PREDECESSOR_INVALID",
    );
    const observeClosed = predecessor.observeClosed.bind(predecessor);
    const effectiveUser = process.geteuid?.();
    requireValue(
      Number.isSafeInteger(effectiveUser) && effectiveUser >= 0,
      "OWNER_UNKNOWN",
    );
    const uid = BigInt(effectiveUser);
    const paths = ancestors([
      parent,
      path.dirname(installed),
      path.dirname(userData),
    ]);
    const parents = await checkParents(paths, uid, parent);
    const sourceRoots = new Map();
    let proof;
    async function guard() {
      requireValue(
        lease?.file === promotionLeasePath(userData) &&
          lease?.record?.role === "promotion" &&
          (await verifyPromotionLease(lease)),
        "LEASE_UNCONFIRMED",
      );
      const current = closedProof(await observeClosed(), original);
      requireValue(
        !proof ||
          (current.quitDigest === proof.quitDigest &&
            current.stateIdentity.device === proof.stateIdentity.device &&
            current.stateIdentity.inode === proof.stateIdentity.inode),
        "CLOSURE_CHANGED",
      );
      const state = await fs.lstat(stateRoot, { bigint: true });
      requireValue(
        state.isDirectory() &&
          state.uid === uid &&
          (state.mode & 0o077n) === 0n &&
          state.dev.toString() === current.stateIdentity.device &&
          state.ino.toString() === current.stateIdentity.inode &&
          (await fs.realpath(stateRoot)) === stateRoot,
        "STATE_CHANGED",
      );
      requireValue(await verifyPromotionLease(lease), "LEASE_UNCONFIRMED");
      proof ??= current;
    }
    async function observeSource() {
      const current = await observeUpdateSlot(installed);
      requireValue(
        Object.keys(source).every((key) => current[key] === source[key]),
        "SOURCE_MISMATCH",
      );
    }
    async function rootsSafe() {
      await checkParents(paths, uid, parent, parents);
      for (const file of [installed, userData]) {
        const info = await fs.lstat(file, { bigint: true });
        requireValue(
          info.isDirectory() &&
            info.uid === uid &&
            (info.mode & BigInt(file === userData ? 0o077 : 0o022)) === 0n &&
            (await fs.realpath(file)) === file,
          "SOURCE_ROOT_UNSAFE",
        );
        requireValue(
          !sourceRoots.has(file) || same(sourceRoots.get(file), info, IDENTITY),
          "SOURCE_ROOT_CHANGED",
        );
        if (!sourceRoots.has(file)) sourceRoots.set(file, info);
      }
    }
    await rootsSafe();
    await guard();
    const budget = { entries: 0, bytes: 0 };
    const appEntries = await inventory(installed, uid, budget);
    const profileEntries = await inventory(userData, uid, budget);
    await preflightSpace(parent, uid, parents.get(parent), budget);
    await observeSource();
    await guard();
    await rootsSafe();
    root = await fs.mkdtemp(path.join(parent, "farol-closed-pair-"));
    const rootInfo = await fs.lstat(root, { bigint: true });
    requireValue(
      rootInfo.isDirectory() &&
        rootInfo.uid === uid &&
        (rootInfo.mode & 0o7777n) === 0o700n &&
        (await fs.realpath(root)) === root,
      "DESTINATION_UNSAFE",
    );
    const app = path.join(root, "Farol.app");
    const profile = path.join(root, "profile");
    const receipt = path.join(root, RECEIPT_NAME);
    let appDigest;
    let profileDigest;
    let retainedRoot;
    let retainedReceipt;
    const savedApp = new Map();
    const savedProfile = new Map();
    await withDirectory(root, uid, [], rootInfo, true, async (frames) => {
      appDigest = await readTree(
        installed,
        uid,
        appEntries,
        app,
        frames,
        savedApp,
      );
      profileDigest = await readTree(
        userData,
        uid,
        profileEntries,
        profile,
        frames,
        savedProfile,
      );
      // No entry names or contents are persisted in this receipt. appDigest is
      // the existing package tree digest, not the private inventory fingerprint.
      retainedReceipt = await writeReceipt(
        receipt,
        Buffer.from(
          JSON.stringify({
            schema: RECEIPT_SCHEMA,
            source,
            predecessor: proof,
            profileDigest,
            appDigest: source.digest,
            app: "Farol.app",
            profile: "profile",
          }) + "\n",
        ),
        uid,
        frames,
      );
      await frames.at(-1).fd.sync();
      retainedRoot = await frames.at(-1).fd.stat({ bigint: true });
    });
    await withDirectory(parent, uid, [], undefined, true, async (frames) => {
      requireValue(
        same(frames.at(-1).info, parents.get(parent), IDENTITY),
        "PARENT_CHANGED",
      );
      await frames.at(-1).fd.sync();
    });
    async function originalUnchanged() {
      requireValue(
        (await readTree(installed, uid, appEntries)) === appDigest,
        "SOURCE_CHANGED",
      );
      requireValue(
        (await readTree(userData, uid, profileEntries)) === profileDigest,
        "SOURCE_CHANGED",
      );
    }
    async function verifyPair(capturing = false) {
      await rootsSafe();
      await guard();
      requireValue(
        same(retainedRoot, await fs.lstat(root, { bigint: true })),
        "DESTINATION_CHANGED",
      );
      await withDirectory(
        root,
        uid,
        [],
        retainedRoot,
        false,
        async (frames) => {
          await verifyReceipt(receipt, retainedReceipt, frames);
          requireValue(
            (await readTree(app, uid, savedApp, undefined, frames)) ===
              appDigest,
            "BACKUP_CHANGED",
          );
          requireValue(
            (await readTree(profile, uid, savedProfile, undefined, frames)) ===
              profileDigest,
            "BACKUP_CHANGED",
          );
          requireValue(
            (await treeDigest(app)) === source.digest,
            "APP_DIGEST_MISMATCH",
          );
        },
      );
      if (capturing) {
        await originalUnchanged();
        await observeSource();
      }
      await rootsSafe();
      await guard();
      // Recheck physical observations after calls to the supplied ports. Only
      // initial capture binds live contents; the saved pair stays immutable.
      if (capturing) {
        const finalBudget = { entries: 0, bytes: 0 };
        for (const [directory, retained] of [
          [installed, appEntries],
          [userData, profileEntries],
        ]) {
          requireValue(
            sameInventory(
              await inventory(directory, uid, finalBudget),
              retained,
            ),
            "SOURCE_CHANGED",
          );
        }
      }
      const savedBudget = { entries: 0, bytes: 0 };
      await withDirectory(
        root,
        uid,
        [],
        retainedRoot,
        false,
        async (frames) => {
          for (const [directory, retained] of [
            [app, savedApp],
            [profile, savedProfile],
          ]) {
            requireValue(
              sameInventory(
                await inventory(directory, uid, savedBudget),
                retained,
              ),
              "BACKUP_CHANGED",
            );
          }
          await verifyReceipt(receipt, retainedReceipt, frames);
        },
      );
      await rootsSafe();
      requireValue(await verifyPromotionLease(lease), "LEASE_UNCONFIRMED");
    }
    await verifyPair(true);
    let refused = false;
    let inFlight = null;
    return Object.freeze({
      root,
      app,
      profile,
      source,
      profileDigest,
      settingsSha256:
        savedProfile.get(`${LEGACY_STATE_DIRECTORY}/config.json`)?.digest ??
        null,
      verify() {
        if (refused) return Promise.resolve(false);
        if (inFlight) return inFlight;
        inFlight = (async () => {
          try {
            await verifyPair();
            return !refused;
          } catch {
            refused = true;
            return false;
          } finally {
            inFlight = null;
          }
        })();
        return inFlight;
      },
    });
  } catch (error) {
    const code =
      error instanceof Error &&
      /^SUPERVISED_BACKUP_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "SUPERVISED_BACKUP_UNCONFIRMED";
    const failure = new Error(code);
    if (root)
      Object.defineProperty(failure, "partialRoot", {
        value: root,
        enumerable: true,
      });
    throw failure;
  }
}
