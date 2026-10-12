import {
  parseCoreArtifactDeclaration,
  type CoreArtifactDeclaration,
} from "./attested-core.ts";
import { BridgeError } from "./client.ts";

export interface ShellSupportPin {
  readonly path: string;
  readonly sha256: string;
}
export interface ShellSupportDeclaration {
  readonly schema: "farol-shell-support/1";
  readonly core: CoreArtifactDeclaration;
  readonly qualification: Readonly<{
    releaseId: string;
    sha256: string;
    osBuild: string;
    compilerSHA256: string;
    compiler: "approved-roots-seatbelt-v1";
    filesystemClass:
      | "local-apfs-no-nested-mounts-v1"
      | "system-apfs-kernel-mount-boundaries-v1";
    hostTrust: "protected-host-pathnames-v1";
    network: "none";
  }>;
  readonly mechanism: Readonly<{
    path: "/usr/bin/sandbox-exec";
    sha256: string;
  }>;
  readonly imports: readonly ShellSupportPin[];
  readonly executables: readonly ShellSupportPin[];
  readonly gitRuntimeResources?: ShellGitRuntimeResources;
  readonly watchdog: Readonly<{
    relativePath: "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron";
    sha256: string;
    sourceSHA256: string;
  }>;
  readonly runtime: Readonly<{
    version: string;
    treeDigestVersion: "farol.next.tree-digest/v2";
    treeSHA256: string;
    distributionSHA256: string;
  }>;
}

const invalid = "invalid_shell_support_declaration";
const idPattern = /^[A-Za-z0-9._:/-]{1,128}$/u;
// Go's release support uses process.bindingID, unlike the core build ID.
const releaseIdPattern = /^[A-Za-z0-9._:-]{1,160}$/u;
// Keep identical to process/platformqualification.go's platformBuildPattern.
const osBuildPattern = /^[0-9]{1,3}[A-Z][0-9]{1,6}[a-z]?$/u;
const watchdogPath =
  "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron";
const numeric = "(?:0|[1-9][0-9]*)";
const prerelease = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const semverPattern = new RegExp(
  `^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  "u",
);

function refuse(code = invalid): never {
  throw new BridgeError("refused", code);
}
// Read only own data descriptors. No spreading/coercing unknown input or getter
// invocation. Fixed schema depth bounds cyclic input; arrays are bounded first.
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return refuse();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return refuse();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return refuse();
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      return refuse();
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function text(value: unknown, pattern: RegExp, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    pattern.exec(value)?.[0] !== value
  )
    return refuse();
  return value;
}
function digest(value: unknown): string {
  const result = text(value, /^[a-f0-9]{64}$/u, 64);
  if (result === "0".repeat(64)) return refuse();
  return result;
}
function coreDeclaration(value: unknown): CoreArtifactDeclaration {
  const core = parseCoreArtifactDeclaration(value);
  if (
    core.build.platform.goos !== "darwin" ||
    core.build.platform.goarch !== "arm64" ||
    core.binary.path !== "farol-backend" ||
    core.binary.size < 64 ||
    core.binary.size > 128 * 1024 * 1024 ||
    core.build.sourceSHA === "0".repeat(40)
  )
    return refuse();
  digest(core.build.sourceTreeDigest);
  digest(core.binary.sha256);
  text(core.build.buildId, idPattern, 128);
  text(core.build.sourceSHA, /^[a-f0-9]{40}$/u, 40);
  return core;
}
function absolutePath(value: unknown): string {
  const path = text(value, /^\/[^\u0000-\u001f\u007f-\u009f\\:]+$/u, 4096);
  if (
    path
      .slice(1)
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  )
    return refuse();
  return path;
}
function pins(
  value: unknown,
  imports: boolean,
  maximum = 16,
): readonly ShellSupportPin[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return refuse();
  const length = Object.getOwnPropertyDescriptor(value, "length")
    ?.value as unknown;
  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 1 ||
    length > maximum
  )
    return refuse();
  const own = Reflect.ownKeys(value);
  const keys = Array.from({ length }, (_, index) => String(index));
  if (
    own.length !== length + 1 ||
    own.some(
      (key) =>
        typeof key !== "string" || (key !== "length" && !keys.includes(key)),
    )
  )
    return refuse();
  const seen = new Set<string>();
  let dyld = 0;
  const result = keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      return refuse();
    const pin = record(descriptor.value as unknown, ["path", "sha256"]);
    const path = absolutePath(pin.path);
    if (seen.has(path) || path === "/usr/bin/sandbox-exec") return refuse();
    seen.add(path);
    if (imports) {
      const slash = path.lastIndexOf("/");
      const parent = path.slice(0, slash);
      const name = path.slice(slash + 1);
      if (
        (parent !== "/usr/share/sandbox" &&
          parent !== "/System/Library/Sandbox/Profiles") ||
        !name.endsWith(".sb")
      )
        return refuse();
      if (name === "dyld-support.sb") dyld++;
    }
    return Object.freeze({ path, sha256: digest(pin.sha256) });
  });
  if (imports && dyld !== 1) return refuse();
  return Object.freeze(result);
}

export interface ShellGitRuntimeResources {
  readonly git: ShellSupportPin;
  readonly files: readonly ShellSupportPin[];
  readonly directories: readonly Readonly<{
    path: string;
    entries: readonly string[];
  }>[];
}
const gitImage = "/Library/Developer/CommandLineTools/usr/bin/git";
const gitData = "/Library/Developer/CommandLineTools/usr/share/git-core";
const gitTemplates = gitData + "/templates";

function finiteValues(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return refuse();
  const length = Object.getOwnPropertyDescriptor(value, "length")
    ?.value as unknown;
  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > maximum
  )
    return refuse();
  const keys = Array.from({ length }, (_, i) => String(i));
  const own = Reflect.ownKeys(value);
  if (
    own.length !== length + 1 ||
    own.some(
      (k) => typeof k !== "string" || (k !== "length" && !keys.includes(k)),
    )
  )
    return refuse();
  return Object.freeze(
    keys.map((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !d.enumerable || !("value" in d)) return refuse();
      return d.value as unknown;
    }),
  );
}
function gitRuntimeResources(
  value: unknown,
  executables: readonly ShellSupportPin[],
): ShellGitRuntimeResources {
  const r = record(value, ["git", "files", "directories"]);
  const rawGit = record(r.git, ["path", "sha256"]);
  const git = Object.freeze({
    path: absolutePath(rawGit.path),
    sha256: digest(rawGit.sha256),
  });
  if (
    git.path !== gitImage ||
    !executables.some((p) => p.path === git.path && p.sha256 === git.sha256)
  )
    return refuse();
  const files = pins(r.files, false, 32);
  if (files.length < 2) return refuse();
  let last = "";
  const paths = new Set<string>();
  for (const f of files) {
    if (
      f.path <= last ||
      (f.path !== gitData + "/gitconfig" &&
        !f.path.startsWith(gitTemplates + "/"))
    )
      return refuse();
    last = f.path;
    paths.add(f.path);
  }
  if (!paths.has(gitData + "/gitconfig")) return refuse();
  last = "";
  const directories = finiteValues(r.directories, 8).map((raw) => {
    const d = record(raw, ["path", "entries"]);
    const path = absolutePath(d.path);
    if (
      path <= last ||
      paths.has(path) ||
      (path !== gitTemplates && !path.startsWith(gitTemplates + "/"))
    )
      return refuse();
    last = path;
    paths.add(path);
    let previous = "";
    const entries = finiteValues(d.entries, 32).map((entry) => {
      const name = text(entry, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u, 128);
      if (name <= previous) return refuse();
      previous = name;
      return name;
    });
    return Object.freeze({ path, entries: Object.freeze(entries) });
  });
  if (!paths.has(gitTemplates)) return refuse();
  for (const d of directories)
    for (const name of d.entries)
      if (!paths.has(d.path + "/" + name)) return refuse();
  for (const path of paths) {
    if (path === gitData + "/gitconfig" || path === gitTemplates) continue;
    const slash = path.lastIndexOf("/");
    if (
      !directories.some(
        (d) =>
          d.path === path.slice(0, slash) &&
          d.entries.includes(path.slice(slash + 1)),
      )
    )
      return refuse();
  }
  return Object.freeze({ git, files, directories: Object.freeze(directories) });
}

// A consumed value projection, not a qualification issuer or launch capability.
// All inputs are unknown; this API reads no host facts, environment or bytes.
export function parseShellSupportDeclaration(
  value: unknown,
): ShellSupportDeclaration {
  try {
    const resourceKey =
      value !== null &&
      typeof value === "object" &&
      Object.hasOwn(value, "gitRuntimeResources")
        ? ["gitRuntimeResources"]
        : [];
    const support = record(value, [
      "schema",
      "core",
      "qualification",
      "mechanism",
      "imports",
      "executables",
      "watchdog",
      "runtime",
      ...resourceKey,
    ]);
    const core = coreDeclaration(support.core);
    const qualification = record(support.qualification, [
      "releaseId",
      "sha256",
      "osBuild",
      "compilerSHA256",
      "compiler",
      "filesystemClass",
      "hostTrust",
      "network",
    ]);
    const mechanism = record(support.mechanism, ["path", "sha256"]);
    const watchdog = record(support.watchdog, [
      "relativePath",
      "sha256",
      "sourceSHA256",
    ]);
    const runtime = record(support.runtime, [
      "version",
      "treeDigestVersion",
      "treeSHA256",
      "distributionSHA256",
    ]);
    if (
      support.schema !== "farol-shell-support/1" ||
      qualification.compiler !== "approved-roots-seatbelt-v1" ||
      (qualification.filesystemClass !== "local-apfs-no-nested-mounts-v1" &&
        qualification.filesystemClass !==
          "system-apfs-kernel-mount-boundaries-v1") ||
      qualification.hostTrust !== "protected-host-pathnames-v1" ||
      qualification.network !== "none" ||
      mechanism.path !== "/usr/bin/sandbox-exec" ||
      watchdog.relativePath !== watchdogPath ||
      runtime.treeDigestVersion !== "farol.next.tree-digest/v2"
    )
      return refuse();
    const imported = pins(support.imports, true);
    const executables = pins(support.executables, false);
    const resources = resourceKey.length
      ? gitRuntimeResources(support.gitRuntimeResources, executables)
      : undefined;
    if (
      resources &&
      qualification.filesystemClass !== "system-apfs-kernel-mount-boundaries-v1"
    )
      return refuse();
    // A pathname appearing in both closures must identify the same bytes.
    const hashes = new Map<string, string>();
    for (const pin of [...imported, ...executables]) {
      const previous = hashes.get(pin.path);
      if (previous !== undefined && previous !== pin.sha256) return refuse();
      hashes.set(pin.path, pin.sha256);
    }
    return Object.freeze({
      schema: support.schema,
      core,
      qualification: Object.freeze({
        releaseId: text(qualification.releaseId, releaseIdPattern, 160),
        sha256: digest(qualification.sha256),
        osBuild: text(qualification.osBuild, osBuildPattern, 11),
        compilerSHA256: digest(qualification.compilerSHA256),
        compiler: qualification.compiler,
        filesystemClass: qualification.filesystemClass,
        hostTrust: qualification.hostTrust,
        network: qualification.network,
      }),
      mechanism: Object.freeze({
        path: mechanism.path,
        sha256: digest(mechanism.sha256),
      }),
      imports: imported,
      executables,
      ...(resources ? { gitRuntimeResources: resources } : {}),
      watchdog: Object.freeze({
        relativePath: watchdog.relativePath,
        sha256: digest(watchdog.sha256),
        sourceSHA256: digest(watchdog.sourceSHA256),
      }),
      runtime: Object.freeze({
        version: text(runtime.version, semverPattern, 128),
        treeDigestVersion: runtime.treeDigestVersion,
        treeSHA256: digest(runtime.treeSHA256),
        distributionSHA256: digest(runtime.distributionSHA256),
      }),
    });
  } catch {
    // Reflection failures and core-parser errors have a fixed, bounded refusal.
    return refuse();
  }
}

// Expected support/core MUST come from independently accepted host/build input.
// Equality cannot prove origin: passing untrusted actual as its own expected
// value creates no authority. This binder performs no qualification or launch.
export function bindShellSupportDeclaration(
  actual: unknown,
  independentlyTrustedExpected: unknown,
  expectedCore: unknown,
): ShellSupportDeclaration {
  const declaration = parseShellSupportDeclaration(actual);
  const expected = parseShellSupportDeclaration(independentlyTrustedExpected);
  let core: CoreArtifactDeclaration;
  try {
    core = coreDeclaration(expectedCore);
  } catch {
    return refuse("invalid_shell_support_core_expectation");
  }
  // Compare only parsed copies. Do not invoke caller/inherited toJSON hooks.
  if (
    !sameParsedValue(declaration, expected) ||
    !sameParsedValue(declaration.core, core)
  )
    return refuse("shell_support_binding_mismatch");
  return declaration;
}

// Private comparison of the fixed-depth acyclic output, never unknown input.
// Array indices and length pin ordering/membership; record key order is canonical.
function sameParsedValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  const keys = Object.keys(left);
  const other = Object.keys(right);
  return (
    keys.length === other.length &&
    keys.every(
      (key, index) =>
        key === other[index] &&
        sameParsedValue(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}
