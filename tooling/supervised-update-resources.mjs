import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { treeDigest } from "./artifact-digest.mjs";
import { GO_PACKAGE_SCHEMA, PRODUCT_APP_NAME } from "./package-layout.mjs";
import { verifyPackageContent } from "./verify-package-content.mjs";

const MAX_ARTIFACT_BYTES = 64 * 1024;
const channelForVersion = (version) =>
  OWNER_BETA.test(version) ? "github-owner-beta" : "github-stable";
const STABLE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const CLAIMS = Object.freeze([
  "version",
  "buildVersion",
  "buildId",
  "sourceCommit",
  "sourceTreeDigest",
  "artifactSha256",
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const OWNER_BETA =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-owner\.beta\.(0|[1-9][0-9]*)$/u;
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function requireValue(condition, code) {
  if (!condition) throw new Error(`SUPERVISED_RESOURCES_${code}`);
}

function canonicalPath(value) {
  requireValue(
    typeof value === "string" &&
      value.length > 1 &&
      Buffer.byteLength(value) <= 4096 &&
      !value.includes("\0") &&
      path.isAbsolute(value) &&
      path.resolve(value) === value &&
      path.normalize(value) === value &&
      value.split(path.sep).length <= 128,
    "PATH_INVALID",
  );
  return value;
}

function expectedClaims(value) {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === CLAIMS.length &&
      CLAIMS.every(
        (key) => Object.hasOwn(value, key) && typeof value[key] === "string",
      ),
    "EXPECTED_INVALID",
  );
  const expected = Object.fromEntries(CLAIMS.map((key) => [key, value[key]]));
  requireValue(
    expected.version.length <= 128 &&
      (OWNER_BETA.test(expected.version) || STABLE.test(expected.version)) &&
      /^[1-9][0-9]{0,8}$/u.test(expected.buildVersion) &&
      /^[a-f0-9]{40}$/u.test(expected.sourceCommit) &&
      ["buildId", "sourceTreeDigest", "artifactSha256"].every((key) =>
        SHA256.test(expected[key]),
      ),
    "EXPECTED_INVALID",
  );
  return Object.freeze(expected);
}

function owned(info, uid) {
  return info.uid === uid && (info.mode & 0o022n) === 0n;
}

function sameIdentity(a, b) {
  return ["dev", "ino", "mode", "uid", "gid", "nlink"].every(
    (key) => a[key] === b[key],
  );
}

function sameFile(a, b) {
  return (
    sameIdentity(a, b) &&
    ["size", "mtimeNs", "ctimeNs"].every((key) => a[key] === b[key])
  );
}

function parentPaths(files) {
  const immediate = new Set(files.map((file) => path.dirname(file)));
  const parents = new Set();
  for (const file of files) {
    let current = path.dirname(file);
    while (true) {
      parents.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...parents]
    .sort((a, b) => a.length - b.length)
    .map((directory) => ({
      directory,
      immediate: immediate.has(directory),
    }));
}

async function inspectParents(paths, uid, expected) {
  const observed = [];
  for (let i = 0; i < paths.length; i += 1) {
    const { directory, immediate } = paths[i];
    const info = await fs.lstat(directory, { bigint: true });
    // System-owned sticky temporary ancestors are safe only above a separate
    // owner-controlled parent. Ordinary candidate parents may be 0755.
    const stickyAncestor =
      !immediate && info.uid === 0n && (info.mode & 0o1000n) !== 0n;
    requireValue(
      info.isDirectory() &&
        (info.uid === uid || (!immediate && info.uid === 0n)) &&
        ((info.mode & 0o022n) === 0n || stickyAncestor) &&
        (await fs.realpath(directory)) === directory,
      "PARENT_UNSAFE",
    );
    // Sibling activity does not change parent identity. Do not bind directory
    // timestamps or link counts that unrelated sibling files can change.
    requireValue(
      !expected ||
        ["dev", "ino", "mode", "uid", "gid"].every(
          (key) => info[key] === expected[i][key],
        ),
      "PARENT_CHANGED",
    );
    observed.push(info);
  }
  return observed;
}

async function readArtifact(file, uid, expected) {
  const named = await fs.lstat(file, { bigint: true });
  requireValue(
    named.isFile() && named.nlink === 1n && owned(named, uid),
    "ARTIFACT_UNSAFE",
  );
  requireValue((await fs.realpath(file)) === file, "PATH_INVALID");
  requireValue(
    named.size > 0n && named.size <= BigInt(MAX_ARTIFACT_BYTES),
    "ARTIFACT_SIZE",
  );
  requireValue(!expected || sameFile(named, expected.info), "ARTIFACT_CHANGED");
  const handle = await fs.open(file, READ_FLAGS);
  try {
    requireValue(
      sameFile(named, await handle.stat({ bigint: true })),
      "ARTIFACT_CHANGED",
    );
    const buffer = Buffer.alloc(Number(named.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const part = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (part.bytesRead === 0) break;
      offset += part.bytesRead;
    }
    const bytes = buffer.subarray(0, offset);
    requireValue(
      offset === Number(named.size) &&
        sameFile(named, await handle.stat({ bigint: true })) &&
        sameFile(named, await fs.lstat(file, { bigint: true })) &&
        (!expected || bytes.equals(expected.bytes)),
      "ARTIFACT_CHANGED",
    );
    return { info: named, bytes };
  } finally {
    await handle.close();
  }
}

function freezeJson(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current !== null && typeof current === "object") {
      pending.push(...Object.values(current));
      Object.freeze(current);
    }
  }
  return value;
}

function matchesClaims(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    CLAIMS.every((key) => value[key] === expected[key])
  );
}

/**
 * Read-only attestation from trusted tooling, never code loaded from the app.
 * `app` is the selected physical path; the manifest's artifactPath is provenance,
 * not an instruction to inspect or execute another path. No lease is acquired.
 * The caller must retain its own lifecycle fence and reverify before use.
 */
export async function captureSupervisedUpdateResources({
  artifactFile,
  appPath,
  expected,
}) {
  const file = canonicalPath(artifactFile);
  const app = canonicalPath(appPath);
  requireValue(
    path.basename(app) === PRODUCT_APP_NAME && file !== app,
    "PATH_INVALID",
  );
  const claims = expectedClaims(expected);
  const effectiveUser = process.geteuid?.();
  requireValue(
    Number.isSafeInteger(effectiveUser) && effectiveUser >= 0,
    "OWNER_UNKNOWN",
  );
  const uid = BigInt(effectiveUser);
  const paths = parentPaths([file, app]);

  async function inspect(retained) {
    const parents = await inspectParents(paths, uid, retained?.parents);
    const named = await fs.lstat(app, { bigint: true });
    requireValue(named.isDirectory() && owned(named, uid), "APP_UNSAFE");
    requireValue((await fs.realpath(app)) === app, "PATH_INVALID");
    requireValue(!retained || sameFile(named, retained.root), "APP_CHANGED");
    const handle = await fs.open(app, READ_FLAGS | constants.O_DIRECTORY);
    try {
      requireValue(
        sameFile(named, await handle.stat({ bigint: true })),
        "APP_CHANGED",
      );
      const artifactRead = await readArtifact(
        file,
        uid,
        retained?.artifactRead,
      );
      const artifact =
        retained?.artifact ??
        freezeJson(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              artifactRead.bytes,
            ),
          ),
        );
      requireValue(
        matchesClaims(artifact, claims) &&
          artifact.schema === GO_PACKAGE_SCHEMA &&
          artifact.sourceDirty === false &&
          artifact.updateChannel === channelForVersion(claims.version),
        "ARTIFACT_CLAIMS",
      );
      // The Go declaration is the one the verifier checked the binary against,
      // read inside this observation's two tree-digest fences. It is captured
      // once; every later observation must verify exactly the same value.
      let verifiedGoCore = null;
      const identity = await verifyPackageContent({
        artifact,
        appPath: app,
        expectedVersion: claims.version,
        expectedBuildVersion: claims.buildVersion,
        expectedChannel: channelForVersion(claims.version),
        onVerifiedGoCore: (value) => {
          verifiedGoCore = value;
        },
      });
      requireValue(
        matchesClaims(identity, claims) &&
          identity.product === "Farol Next Preview" &&
          identity.bundleId === "local.farol.next.preview" &&
          identity.updateChannel === channelForVersion(claims.version) &&
          identity.signing === "unsigned" &&
          identity.notarized === false,
        "PACKAGE_IDENTITY",
      );
      // The full verifier hashes before inspecting package entries. Reuse its
      // existing digest format for a final content fence after those reads.
      requireValue(
        (await treeDigest(app)) === claims.artifactSha256,
        "APP_CONTENT_CHANGED",
      );
      await readArtifact(file, uid, artifactRead);
      requireValue(
        sameFile(named, await handle.stat({ bigint: true })) &&
          sameFile(named, await fs.lstat(app, { bigint: true })),
        "APP_CHANGED",
      );
      await inspectParents(paths, uid, parents);
      const goCore =
        verifiedGoCore === null
          ? null
          : freezeJson(JSON.parse(JSON.stringify(verifiedGoCore)));
      requireValue(
        !retained || JSON.stringify(goCore) === JSON.stringify(retained.goCore),
        "APP_CONTENT_CHANGED",
      );
      return {
        parents,
        root: named,
        artifactRead,
        artifact,
        goCore: retained ? retained.goCore : goCore,
      };
    } finally {
      await handle.close();
    }
  }

  const retained = await inspect();
  let refused = false;
  let inFlight = null;
  return Object.freeze({
    app,
    artifact: retained.artifact,
    // `{ core, identity }` from the verified package, or null without a core.
    goCore: retained.goCore,
    verify() {
      if (refused) return Promise.resolve(false);
      if (inFlight) return inFlight;
      // Share an in-flight read: concurrent callers cannot overwrite a refusal
      // with a later success from an older physical observation.
      inFlight = (async () => {
        try {
          await inspect(retained);
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
}
