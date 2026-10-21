import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { lstatSync, readlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  desktopAppDataPath,
  desktopIdentity,
} from "../../src/apps/desktop/desktop-environment.ts";
import { parseQuitReceipt } from "../../src/apps/desktop/quit-receipt.ts";
import { requireOwnerPreviewRuntimeIntegration } from "../../tooling/owner-preview-contract.mjs";
import {
  verifyOwnerPreview,
  physicalDirectory,
  regularBytes,
  jsonBytes,
} from "../../tooling/verify-owner-preview.mjs";

// R07: Preview and the normal package are isolated. The smoke harness proves
// the Preview alone, under the E2E override. This witness runs a disposable
// NORMAL instance and the Preview at the same time, hidden, each in its own
// disposable root, and compares what the operating system reports about them:
// open files, listening sockets, child processes and their arguments. Names
// alone are never the evidence. It reads exact owned pids only (ppid queries
// from the launched parent, lsof/ps with -p) and never signals a process.
const execFileAsync = promisify(execFile);
const PS = "/bin/ps";
const LSOF = "/usr/sbin/lsof";
const PGREP = "/usr/bin/pgrep";

async function deadline(promise, label, milliseconds = 20000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`OWNER_PREVIEW_ISOLATION_UNKNOWN:${label}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function privateDirectory(directory) {
  await physicalDirectory(path.dirname(directory));
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await physicalDirectory(directory, { privateMode: true });
}
// Every external inventory command (pgrep, lsof, ps and the KERN_PROCARGS2
// probe) runs through `runInventory`; nothing else spawns one. Success is exit 0
// with empty stderr. The only accepted non-zero outcome is the command's own
// documented, verified "no match", and it carries no output:
//   pgrep  exit 1, empty stdout and stderr: the parent has no children.
//   lsof   exit 1, empty stdout and stderr, only for a pid confirmed gone.
//   ps     exit 1, empty stdout and stderr, only for a pid confirmed gone.
//   probe  none: it answers in JSON and always exits 0.
// Anything else (another exit code, a signal, a timeout, stderr output, or
// partial stdout beside a failure) is an inventory error naming the command,
// the exit code and the stderr. A failed command's stdout is never returned.
//
// lsof alone has one tolerated stderr: its verbatim warning that it could not
// stat() an NFS mount (OrbStack's volume on this Mac stalls intermittently),
// after which it still lists the pid but may describe files on that mount less
// fully. The warning is removed from stderr before the rules above apply, only
// when every stderr line belongs to it and every named mount is clear of the
// owner's home, the owner locations and this run's disposable roots, in both
// directions, judged without stat()ing the mount itself. Each accepted mount is
// recorded in the receipt (`lsofPartialMounts`). Another type, other text, or a
// mount that is not clear is still an inventory error.
const emptyFailure = (result) =>
  result.code === 1 && result.stdout === "" && result.stderr === "";
const LSOF_MOUNT_WARNING =
  /^lsof: WARNING: can.t stat\(\) nfs file system (\/[^\n]+)\n {6}Output information may be incomplete\.\n(?: {6}assuming "dev=[0-9a-f]+" from mount table\n)?/u;
function lsofMountWarnings(stderr) {
  const mounts = [];
  let rest = stderr;
  while (rest !== "") {
    const match = LSOF_MOUNT_WARNING.exec(rest);
    if (match === null) return null;
    mounts.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  return mounts;
}
// Mounts lsof could not stat() during this run, in display form.
const partialInventory = { lsofMounts: new Set() };
function partialMountConflict(mount) {
  if (
    /[\u0000-\u001f\u007f]/u.test(mount) ||
    mount !== path.normalize(mount) ||
    mount.endsWith("/")
  )
    return "MOUNT_PATH_INVALID";
  let real;
  try {
    real = path.join(canonical(path.dirname(mount)), path.basename(mount));
  } catch {
    return "MOUNT_PATH_UNRESOLVABLE";
  }
  const built = ownerBuilt();
  const disposable = [...ownerState.exempt].flatMap(formsOf);
  const overlaps = (a, b) => contains(a, b) || contains(b, a);
  for (const candidate of new Set([mount, real])) {
    if (built.home.some((home) => contains(home, candidate)))
      return "CONTAINS_OWNER_HOME";
    if (
      built.roots.some((root) => overlaps(candidate, root)) ||
      built.farolPrefixes.some(
        (prefix) => candidate.startsWith(prefix) || contains(prefix, candidate),
      )
    )
      return "OWNER_LOCATION";
    if (disposable.some((root) => overlaps(candidate, root)))
      return "DISPOSABLE_ROOT";
  }
  return null;
}
function displayMount(mount) {
  const home = os.userInfo().homedir;
  return contains(mount, home) ? `~${mount.slice(home.length)}` : mount;
}
const INVENTORY = {
  pgrep: { label: "pgrep", command: PGREP, noMatch: emptyFailure },
  lsof: {
    label: "lsof",
    command: LSOF,
    warnings: lsofMountWarnings,
    noMatch: (result, context) =>
      emptyFailure(result) && context.gone?.() === true,
  },
  ps: {
    label: "ps",
    command: PS,
    noMatch: (result, context) =>
      emptyFailure(result) && context.gone?.() === true,
  },
  probe: {
    label: "probe",
    command: "/usr/bin/python3",
    noMatch: () => false,
  },
  // The owner guard's own declaration of what it protects: read-only, no no-match.
  guard: { label: "guard", command: "/usr/bin/python3", noMatch: () => false },
  // Same-uid pid list and the process scan: no documented no-match at all.
  psUid: { label: "ps-uid", command: PS, noMatch: () => false },
  scan: { label: "scan", command: "/usr/bin/python3", noMatch: () => false },
};
async function runInventory(tool, args, context = {}) {
  const spec = typeof tool === "string" ? INVENTORY[tool] : tool;
  const fail = (code, stderr) =>
    new Error(
      `OWNER_PREVIEW_ISOLATION_INVENTORY_ERROR:${spec.label}:${code}:${String(stderr).trim().slice(0, 200)}`,
    );
  let result;
  try {
    const pending = execFileAsync(spec.command, args, {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    });
    // Input travels on stdin, never in argv or the environment, so the scanner
    // cannot find its own request.
    if (context.input !== undefined) pending.child.stdin.end(context.input);
    const { stdout, stderr } = await pending;
    result = { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== "number")
      throw fail(error.code ?? error.signal ?? "FAILED", error.stderr ?? "");
    result = {
      code: error.code,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
  const mounts =
    spec.warnings !== undefined && result.stderr !== ""
      ? spec.warnings(result.stderr)
      : null;
  if (mounts !== null) {
    for (const mount of mounts) {
      const conflict = partialMountConflict(mount);
      if (conflict !== null)
        throw new Error(
          `OWNER_PREVIEW_ISOLATION_INVENTORY_PARTIAL_MOUNT_UNSAFE:${spec.label}:${conflict}`,
        );
    }
    for (const mount of mounts)
      partialInventory.lsofMounts.add(displayMount(mount));
    result = { ...result, stderr: "" };
  }
  if (result.code === 0 && result.stderr === "")
    return { outcome: "ok", stdout: result.stdout };
  if (spec.noMatch(result, context)) return { outcome: "no_match" };
  throw fail(result.code, result.stderr);
}
// The witness runs only as the direct child of the owner-untouched guard, the
// way `task test:e2e:owner-preview-isolation` starts it: the parent's command
// line must be the guard script followed by `--` and exactly this witness
// invocation. A direct `node` run, or one through npm or a shell, has another
// parent and is refused before anything is read or launched. This stops an
// unguarded run by mistake; it is not a defence against a deliberate imitation.
const GUARD_SCRIPT = "scripts/assert-owner-untouched.py";
function guardedInvocation(parentCommand, generation) {
  const tokens = parentCommand.trim().split(/\s+/u);
  const marker = tokens.indexOf("--");
  if (marker < 2) return false;
  const script = tokens[marker - 1];
  const rest = tokens.slice(marker + 1);
  return (
    (script === `./${GUARD_SCRIPT}` || script.endsWith(`/${GUARD_SCRIPT}`)) &&
    rest.length === 4 &&
    path.basename(rest[0]) === "node" &&
    rest[1] === "tests/e2e/owner-preview-isolation.e2e.mjs" &&
    rest[2] === "--generation" &&
    rest[3] === generation
  );
}
async function requireOwnerGuardParent(generation) {
  const parent = process.ppid;
  const answer = await runInventory(
    "ps",
    ["-o", "command=", "-p", String(parent)],
    { gone: () => isGone(parent) },
  );
  if (
    answer.outcome !== "ok" ||
    !guardedInvocation(parsePsCommand(answer.stdout), generation)
  )
    throw new Error("OWNER_PREVIEW_ISOLATION_UNGUARDED");
}
// Only a pid the kernel no longer knows may have an empty inventory.
function isGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}
// Containment is decided on canonical paths, resolved the way the kernel does:
// component by component, with every existing prefix realpathed (symlinks
// followed) BEFORE the next component is applied, so `alias/..` means the
// parent of alias's target, never the parent of alias. `..` is never collapsed
// lexically. Once a component does not exist the rest is appended literally,
// and a rest that still contains `..` cannot be resolved: that fails closed.
// A relative path is never inside anything.
//
// `reported` marks a path the kernel itself reported (an lsof name), which is
// already real: where a directory cannot be traversed (EACCES or EPERM, e.g. a
// system path), its remainder is taken literally, provided it contains no `..`.
function canonical(value, reported = false) {
  const unresolvable = (detail) =>
    new Error(`OWNER_PREVIEW_ISOLATION_PATH_UNRESOLVABLE:${detail}`);
  const split = (text) =>
    text.split("/").filter((part) => part !== "" && part !== ".");
  const pending = split(value).reverse();
  let resolved = "/";
  let links = 0;
  while (pending.length > 0) {
    const component = pending.pop();
    if (component === "..") {
      resolved = path.dirname(resolved);
      continue;
    }
    const next = path.join(resolved, component);
    let info;
    try {
      info = lstatSync(next);
    } catch (error) {
      const missing = error.code === "ENOENT" || error.code === "ENOTDIR";
      const untraversable = error.code === "EACCES" || error.code === "EPERM";
      if (!missing && !(reported && untraversable))
        throw unresolvable(`${error.code}:${value.slice(0, 120)}`);
      const rest = [component, ...pending.reverse()];
      if (rest.includes(".."))
        throw unresolvable(`DOTDOT_AFTER_MISSING:${value.slice(0, 120)}`);
      return path.join(resolved, ...rest);
    }
    if (info.isSymbolicLink()) {
      links += 1;
      if (links > 40) throw unresolvable(`SYMLINK_LOOP:${value.slice(0, 120)}`);
      const target = readlinkSync(next);
      if (target.startsWith("/")) resolved = "/";
      pending.push(...split(target).reverse());
      continue;
    }
    resolved = next;
  }
  return resolved;
}
function inside(child, parent, reported = false) {
  if (!path.isAbsolute(child) || !path.isAbsolute(parent)) return false;
  const target = canonical(child, reported);
  const root = canonical(parent);
  return (
    target === root ||
    target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
  );
}

// Owner locations a disposable run must never name. The installed Farol.app may
// be running on this machine; none of its files may appear either. One source of
// truth: the roots the owner guard itself fingerprints are read from the guard
// (`--print-protected-roots`) at the start of the run and the witness fails
// closed if they cannot be read, so the two lists cannot diverge. The witness
// adds only what the guard does not enumerate: the whole of ~/.farol and
// ~/.codex, the installed app, and any profile whose directory under
// ~/Library/Application Support starts with `Farol`, including profiles added
// later. A path inside one of this run's own disposable roots is never an owner
// location.
const ownerState = { guardRoots: null, built: null, exempt: new Set() };
async function loadProtectedRoots(
  repositoryRoot,
  script = path.join(repositoryRoot, "scripts/assert-owner-untouched.py"),
) {
  const answer = await runInventory("guard", [
    "-I",
    script,
    "--print-protected-roots",
  ]);
  let printed;
  try {
    printed = JSON.parse(answer.stdout);
  } catch {
    throw new Error("OWNER_PREVIEW_ISOLATION_GUARD_ROOTS_INVALID:JSON");
  }
  const roots = [
    ...new Set([...(printed.watched ?? []), ...(printed.presence ?? [])]),
  ];
  if (
    printed.schema !== 1 ||
    !Array.isArray(printed.watched) ||
    !Array.isArray(printed.presence) ||
    roots.length === 0 ||
    !roots.every((root) => typeof root === "string" && path.isAbsolute(root))
  )
    throw new Error("OWNER_PREVIEW_ISOLATION_GUARD_ROOTS_INVALID:SHAPE");
  return roots;
}
// Containment is boundary-aware: equal, or the root followed by the separator.
const contains = (candidate, root) =>
  candidate === root ||
  candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
// An owner location is held in both its literal and its canonical form, built
// once when the guard roots are set, so a protected location that is itself a
// symlink is matched by a path under its target as well as under its name.
const formsOf = (literal) => [...new Set([literal, canonical(literal, true)])];
function setGuardRoots(guardRoots) {
  const home = os.userInfo().homedir;
  const literals = [
    ...guardRoots,
    path.join(home, ".farol"),
    path.join(home, ".codex"),
    "/Applications/Farol.app",
  ];
  ownerState.guardRoots = guardRoots;
  ownerState.built = {
    home: formsOf(home),
    roots: [...new Set(literals.flatMap(formsOf))],
    // Last component starts with `Farol`: every present and future profile.
    farolPrefixes: formsOf(
      path.join(home, "Library/Application Support/Farol"),
    ),
  };
}
function ownerBuilt() {
  if (ownerState.built === null)
    throw new Error("OWNER_PREVIEW_ISOLATION_GUARD_ROOTS_UNLOADED");
  return ownerState.built;
}
// A root named inside free text (a command line), ended by a non-name character
// so `.codex-backup` is not `.codex`. A `Farol*` prefix needs no end.
function namesRoot(text, built) {
  const named = (root) => {
    for (
      let at = text.indexOf(root);
      at !== -1;
      at = text.indexOf(root, at + 1)
    ) {
      const next = text[at + root.length];
      if (next === undefined || !/[A-Za-z0-9._-]/u.test(next)) return true;
    }
    return false;
  };
  return (
    built.roots.some(named) ||
    built.farolPrefixes.some((prefix) => text.includes(prefix))
  );
}
// `text` marks a command line: it is matched as text, never as a path.
// `reported` marks a path the kernel reported (see canonical).
function touchesOwner(value, { text = false, reported = false } = {}) {
  const built = ownerBuilt();
  if (text || !path.isAbsolute(value)) return namesRoot(value, built);
  // An absolute value (a path, or a PATH-like list of paths) is judged as text
  // and by where each path really leads, so `/tmp/x/../../Users/.../.codex` or a
  // symlink then `..` cannot hide an owner location.
  const real = canonical(value, reported);
  // Inside this run's own disposable roots (after following symlinks) is never
  // an owner location; a symlink out of them is judged by where it leads.
  const exemptRoot = [...ownerState.exempt].find((root) =>
    inside(real, root, true),
  );
  if (exemptRoot !== undefined) {
    // Exempting a root that is itself an owner location would hide a write
    // there: that is a hard failure, never an exemption.
    const conflict = ownerConflict(exemptRoot);
    if (conflict !== null)
      throw new Error(
        `OWNER_PREVIEW_ISOLATION_DISPOSABLE_ROOT_UNSAFE:${conflict}:${exemptRoot}`,
      );
    return false;
  }
  const leads = [
    real,
    ...value
      .split(":")
      .filter((part) => part !== value && path.isAbsolute(part))
      .map((part) => canonical(part, true)),
  ];
  return (
    namesRoot(value, built) ||
    leads.some(
      (lead) =>
        built.roots.some((root) => contains(lead, root)) ||
        built.farolPrefixes.some((prefix) => lead.startsWith(prefix)),
    )
  );
}

// A disposable root, or the parent it is created in, may never be an owner
// location: not equal to the owner's home, not inside a guard root, ~/.farol,
// ~/.codex, the installed app or any `Farol*` Application Support profile, and
// not an ancestor of one (a parent that contains an owner location would put the
// run's files beside it). Both sides are compared in literal and canonical form.
// Returns a code, or null when the path is clear.
function ownerConflict(target) {
  const built = ownerBuilt();
  const candidates = [...new Set([target, canonical(target)])];
  for (const candidate of candidates) {
    if (built.home.includes(candidate)) return "OWNER_HOME";
    if (built.farolPrefixes.some((prefix) => candidate.startsWith(prefix)))
      return "INSIDE_FAROL_PROFILE";
    for (const root of built.roots) {
      if (contains(candidate, root)) return "INSIDE_OWNER_LOCATION";
      if (contains(root, candidate)) return "CONTAINS_OWNER_LOCATION";
    }
    for (const prefix of built.farolPrefixes)
      if (contains(prefix, candidate)) return "CONTAINS_OWNER_LOCATION";
  }
  return null;
}
function assertSafeTemporaryParent(parent) {
  const conflict = ownerConflict(parent);
  if (conflict !== null)
    throw new Error(
      `OWNER_PREVIEW_ISOLATION_TEMP_PARENT_UNSAFE:${conflict}:${parent}`,
    );
}
// The only way a disposable root is created: the parent is checked first, and
// nothing is created if it conflicts with an owner location.
async function mkdtempIn(parent, prefix, mkdtemp = fs.mkdtemp) {
  assertSafeTemporaryParent(parent);
  return mkdtemp(path.join(parent, prefix));
}

// One classifier for every string observed for an owned process: each argv
// element (and the executable path), each environment value (all of them), each
// open-file path and each unix socket path. Argv and environment values are text,
// so path-like substrings are extracted first; files and sockets already are
// paths. The rule for extraction, applied in this order to the whole value, to
// each whitespace-separated token and to each quoted piece: strip surrounding
// quotes; for `--flag=/path`, `-f=/path` or `NAME=/path` take what follows the
// first `=`; split on `:` (PATH-like lists); strip a `file://` prefix; keep what
// is an absolute path. Each path is compared in its literal and canonical form,
// with the boundary-aware containment of `contains`, and the string takes the
// strongest class of its paths:
//   other_instance  inside the other instance's roots or bundle
//   owner           an owner location (guard list plus the Farol* prefix rule)
//   own             inside this instance's roots or bundle
//   neutral         anything else
// other_instance and owner are violations with a named code that names the field
// kind and, for an environment value, its key but never its value.
function extractPaths(text) {
  const found = new Set();
  const take = (candidate) => {
    const cleaned = candidate
      .replace(/^["']+|["']+$/gu, "")
      .replace(/^file:\/\//u, "");
    if (path.isAbsolute(cleaned)) found.add(cleaned);
  };
  const visit = (token) => {
    let value = token.replace(/^["']+|["']+$/gu, "");
    const assigned =
      /^(?:-{1,2}[A-Za-z0-9][\w-]*|[A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(value);
    if (assigned !== null) value = assigned[1];
    take(value);
    for (const part of value.split(":")) take(part);
  };
  visit(text);
  for (const token of text.split(/\s+/u)) if (token !== "") visit(token);
  for (const quoted of text.matchAll(/(["'])(.*?)\1/gu)) visit(quoted[2]);
  return [...found];
}
const CLASS_RANK = { neutral: 0, own: 1, owner: 2, other_instance: 3 };
function classificationContext(instance, other) {
  return {
    own: [...formsOf(instance.home), ...formsOf(instance.app)],
    other: [...formsOf(other.home), ...formsOf(other.app)],
  };
}
function classifyPath(candidate, context) {
  let real;
  try {
    real = canonical(candidate, true);
  } catch {
    real = path.resolve(candidate);
  }
  const forms = [...new Set([candidate, real])];
  if (forms.some((form) => context.other.some((root) => contains(form, root))))
    return "other_instance";
  let owner;
  try {
    owner = touchesOwner(candidate, { reported: true });
  } catch (error) {
    if (/DISPOSABLE_ROOT_UNSAFE/u.test(error.message)) throw error;
    owner = touchesOwner(path.resolve(candidate), { text: true });
  }
  if (owner) return "owner";
  if (forms.some((form) => context.own.some((root) => contains(form, root))))
    return "own";
  return "neutral";
}
function classifyStrings(items, context) {
  const counts = {};
  const violations = [];
  for (const item of items) {
    const paths =
      item.kind === "file" || item.kind === "socket"
        ? [item.text]
        : extractPaths(item.text);
    let strongest = "neutral";
    for (const candidate of paths) {
      const found = classifyPath(candidate, context);
      if (CLASS_RANK[found] > CLASS_RANK[strongest]) strongest = found;
    }
    counts[item.kind] ??= { own: 0, other_instance: 0, owner: 0, neutral: 0 };
    counts[item.kind][strongest] += 1;
    if (strongest === "other_instance" || strongest === "owner")
      violations.push({
        code: `OWNER_PREVIEW_ISOLATION_STRING_${strongest.toUpperCase()}`,
        kind: item.kind,
        role: item.role,
        pid: item.pid,
        key: item.key ?? null,
        // An environment value is never named: it may hold a secret.
        value: item.kind === "env" ? undefined : item.text,
      });
  }
  return { counts, violations };
}
const violationMessage = (violation) =>
  `${violation.code}:${violation.kind}:${violation.role}:${violation.pid}` +
  `${violation.key ? `:${violation.key}` : ""}` +
  `${violation.value === undefined ? "" : `:${violation.value}`}`;
// The strings of one live process, for the classifier. They live only in memory:
// the receipt gets counts and violations, never environment values.
function processStrings(pid, role, process_, files) {
  return [
    { kind: "argv", text: process_.exe },
    ...process_.argv.map((text) => ({ kind: "argv", text })),
    ...Object.entries(process_.env).map(([key, text]) => ({
      kind: "env",
      key,
      text,
    })),
    ...files
      .filter((file) => file.name?.startsWith("/"))
      .map((file) => ({
        kind: file.type === "unix" ? "socket" : "file",
        text: file.name,
      })),
  ].map((item) => ({ pid, role, ...item }));
}

// Every inventory parser declares its exact row grammar. Blank lines and a
// documented header (row 0 only) are the only lines it may skip; any other row
// that does not match is an inventory error naming the command and the row index
// but never the row (it could hold environment data). A listing that is empty
// where it cannot legitimately be, or that lacks an entry that must be there, is
// an error, not an empty answer.
function parseRows(
  output,
  { command: tool, header = null, row, map, allowEmpty = false },
) {
  const rows = [];
  output.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    if (header !== null && index === 0 && header.test(line)) return;
    const match = row.exec(line);
    if (match === null)
      throw new Error(
        `OWNER_PREVIEW_ISOLATION_INVENTORY_ROW_INVALID:${tool}:${index}`,
      );
    rows.push(map(match));
  });
  if (rows.length === 0 && !allowEmpty)
    throw new Error(`OWNER_PREVIEW_ISOLATION_INVENTORY_EMPTY:${tool}`);
  return rows;
}
// ps -U <uid> -o pid=,ppid=   rows: `<pid> <ppid>`; no header. Must list this
// test's own pid.
function parseUidListing(output, self = process.pid) {
  const rows = parseRows(output, {
    command: "ps-uid",
    row: /^\s*([0-9]+)\s+([0-9]+)\s*$/u,
    map: (match) => ({ pid: Number(match[1]), ppid: Number(match[2]) }),
  });
  if (!rows.some((entry) => entry.pid === self))
    throw new Error(
      "OWNER_PREVIEW_ISOLATION_INVENTORY_INCOMPLETE:ps-uid:SELF_MISSING",
    );
  return rows;
}
// pgrep -P <ppid> -f .   rows: `<pid>`; no header. A listing that exited 0 has
// at least one row; "no children" is the documented exit-1 no-match instead.
const parsePgrepPids = (output) =>
  parseRows(output, {
    command: "pgrep",
    row: /^([0-9]+)$/u,
    map: (match) => Number(match[1]),
  });
// ps -o command= -p <pid>   exactly one non-blank row; no header.
function parsePsCommand(output) {
  const rows = parseRows(output, {
    command: "ps",
    row: /^(.+)$/u,
    map: (match) => match[1],
  });
  if (rows.length !== 1)
    throw new Error("OWNER_PREVIEW_ISOLATION_INVENTORY_ROW_COUNT:ps");
  return rows[0].trim();
}
// lsof -F pftPnT   one `<letter><value>` per line. `p` opens a process, `f` a
// file of the current process; `t`, `P`, `n` and `T` (a `NAME=value` subfield)
// belong to the current file. No other letter, and no field before its opener.
// Every file declares its type (lsof always emits `t`), and an IPv4/IPv6 file
// its protocol, so no socket can reach the listener checks unclassified.
function parseLsof(output) {
  const bad = (index) =>
    new Error(`OWNER_PREVIEW_ISOLATION_INVENTORY_ROW_INVALID:lsof:${index}`);
  const files = [];
  let pid = null;
  let current = null;
  output.split("\n").forEach((line, index) => {
    if (line === "") return;
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      if (!/^[0-9]+$/u.test(value)) throw bad(index);
      pid = Number(value);
      current = null;
    } else if (field === "f") {
      if (pid === null || value === "") throw bad(index);
      current = { pid, fd: value };
      files.push(current);
    } else if (
      current !== null &&
      (field === "t" || field === "P" || field === "n")
    ) {
      if (field === "t") current.type = value;
      else if (field === "P") current.protocol = value;
      else current.name = value;
    } else if (current !== null && field === "T" && /^[A-Z]+=/u.test(value)) {
      if (value.startsWith("ST=")) current.state = value;
    } else throw bad(index);
  });
  if (files.length === 0)
    throw new Error("OWNER_PREVIEW_ISOLATION_INVENTORY_EMPTY:lsof");
  for (const file of files) {
    if (typeof file.type !== "string" || file.type === "")
      throw new Error(
        "OWNER_PREVIEW_ISOLATION_INVENTORY_ROW_INVALID:lsof:MISSING_TYPE",
      );
    if (
      (file.type === "IPv4" || file.type === "IPv6") &&
      (typeof file.protocol !== "string" || file.protocol === "")
    )
      throw new Error(
        "OWNER_PREVIEW_ISOLATION_INVENTORY_ROW_INVALID:lsof:MISSING_PROTOCOL",
      );
  }
  return files;
}
// The scanner's JSON answer: one object per requested pid, in order.
const SCAN_STATUSES = new Set(["match", "clear", "gone", "unreadable"]);
function validateScan(results, pids) {
  const bad = (index) =>
    new Error(`OWNER_PREVIEW_ISOLATION_INVENTORY_ROW_INVALID:scan:${index}`);
  if (!Array.isArray(results) || results.length !== pids.length)
    throw new Error("OWNER_PREVIEW_ISOLATION_SCAN_INCOMPLETE");
  results.forEach((entry, index) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      entry.pid !== pids[index] ||
      !SCAN_STATUSES.has(entry.status)
    )
      throw bad(index);
    if (entry.status === "match" || entry.status === "clear") {
      if (
        !Array.isArray(entry.roots) ||
        !entry.roots.every((root) => typeof root === "string") ||
        typeof entry.envVisible !== "boolean" ||
        typeof entry.envRead !== "boolean" ||
        typeof entry.systemOwned !== "boolean"
      )
        throw bad(index);
    } else if (!Number.isInteger(entry.errno)) throw bad(index);
  });
  return results;
}
// The KERN_PROCARGS2 reader's JSON answer for one pid.
function validateProcessAnswer(answer) {
  const bad = () =>
    new Error("OWNER_PREVIEW_ISOLATION_INVENTORY_ROW_INVALID:procargs:0");
  if (answer === null || typeof answer !== "object") throw bad();
  if (answer.status !== "ok") {
    if (answer.status !== "error" || typeof answer.reason !== "string")
      throw bad();
    return answer;
  }
  const strings = (value) =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (
    answer.env === null ||
    typeof answer.env !== "object" ||
    Array.isArray(answer.env) ||
    !Object.values(answer.env).every((value) => typeof value === "string") ||
    !strings(answer.argv) ||
    typeof answer.exe !== "string"
  )
    throw bad();
  return answer;
}

async function descendants(parent) {
  const tree = [parent];
  for (let index = 0; index < tree.length; index += 1) {
    const found = await runInventory("pgrep", [
      "-P",
      String(tree[index]),
      "-f",
      ".",
    ]);
    if (found.outcome === "no_match") continue;
    tree.push(...parsePgrepPids(found.stdout));
  }
  return tree;
}
// Every scan of an instance's tree feeds the set of pids ever seen.
async function scanTree(
  instance,
  { scan = descendants, alive = (pid) => !isGone(pid) } = {},
) {
  const tree = await scan(instance.pid);
  for (const pid of tree) instance.seen.add(pid);
  // A listing that omits a known, live member of the tree is incomplete, not a
  // smaller tree.
  for (const pid of instance.known ?? [])
    if (!tree.includes(pid) && alive(pid))
      throw new Error(
        `OWNER_PREVIEW_ISOLATION_TREE_INCOMPLETE:${instance.kind}:${pid}`,
      );
  return tree;
}
// A process tree is only a snapshot. Rescan until two consecutive snapshots,
// an interval apart, agree on the pid set; fail with a named code if that does
// not happen within the bound. Pids that appeared in any snapshot stay in the
// caller's `seen` set (the scan function records them), so a helper that exits
// again is still checked and still verified gone at teardown.
async function stableTree(
  scan,
  { interval = 150, maxScans = 40, label = "tree" } = {},
) {
  let previous = null;
  for (let attempt = 0; attempt < maxScans; attempt += 1) {
    const current = await scan();
    const key = [...current].sort((x, y) => x - y).join(",");
    if (key === previous) return current;
    previous = key;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`OWNER_PREVIEW_ISOLATION_TREE_UNSTABLE:${label}`);
}
// Teardown proof for one process tree, reported and never thrown (except the
// result's own `error` for an inventory failure): every pid ever seen has
// exited and a rescan from the original parent finds no descendant. A survivor
// is reported with its reason and is never signalled. The dependencies are
// injectable for the self-check.
async function tearDownReport(
  instance,
  {
    alive = (pid) => !isGone(pid),
    rescan = descendants,
    tries = 100,
    interval = 50,
  } = {},
) {
  const survivors = [];
  const survivor = (pid, reason) => {
    if (
      !survivors.some((entry) => entry.pid === pid && entry.reason === reason)
    )
      survivors.push({ kind: instance.kind, pid, reason });
  };
  let error = null;
  try {
    for (const pid of instance.seen) {
      for (let attempt = 0; attempt < tries && alive(pid); attempt += 1)
        await new Promise((r) => setTimeout(r, interval));
      if (alive(pid)) survivor(pid, "PID_REMAINS");
    }
    if (instance.pid !== null)
      for (const pid of await rescan(instance.pid))
        if (pid !== instance.pid) survivor(pid, "NEW_DESCENDANT");
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "TEARDOWN_FAILED";
  }
  return {
    kind: instance.kind,
    pid: instance.pid,
    verified: error === null && survivors.length === 0,
    survivors,
    error,
  };
}

// Orphan rule. A reparented helper is no longer a descendant, and a disposable
// root normally reaches a process through HOME (its environment), not argv. So
// the decision looks at argv AND environment together: every process of the
// current uid that did not exist when the run started is inspected, and any
// whose argv or environment contains a disposable root of this run is a
// survivor. A process whose arguments cannot be read is `unverifiable` and keeps
// the teardown unverified; one that has exited is ignored. Matching happens
// inside the scanner: only the matching pid and the run's own root strings come
// back, never another process's arguments or environment. A process whose
// environment the OS withholds (a hardened or system binary) reads as argv
// only; those are counted (`envWithheld`), not hidden. The environment is read
// at all only for a process executing a binary of this run: one under the
// checkout (both bundles are built there) or a disposable root. Any other new
// process (an app the owner opened from the Dock meanwhile) is judged by its
// executable path and argv alone and only counted (`excluded.foreignExecutable`).
const SCAN_SCRIPT = `
import ctypes, ctypes.util, json, struct, sys
libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
request = json.load(sys.stdin)
roots = request["roots"]
scopes = [scope.rstrip("/") + "/" for scope in request["scopes"]]
SYSTEM_PREFIXES = ("/System/", "/usr/", "/bin/", "/sbin/", "/Library/", "/Applications/", "/opt/", "/private/var/db/", "/private/var/protected/")
out = []
for pid in request["pids"]:
    mib = (ctypes.c_int * 3)(1, 49, pid)
    size = ctypes.c_size_t(0)
    ok = libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) == 0
    if ok:
        buf = ctypes.create_string_buffer(size.value)
        ok = libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) == 0
    if not ok:
        errno = ctypes.get_errno()
        out.append({"pid": pid, "status": "gone" if errno == 3 else "unreadable", "errno": errno})
        continue
    raw = buf.raw[:size.value]
    argc = struct.unpack("i", raw[:4])[0]
    parts = raw[4:].split(b"\\0")
    exe = parts[0].decode("utf8", "replace")
    # exec path, argv, then environment entries (K=V); the environment only for
    # an executable inside the run's scopes
    present = [part for part in parts[1:] if part]
    read = any(exe.startswith(scope) for scope in scopes)
    searched = [parts[0]] + present[:argc] + (present[argc:] if read else [])
    strings = [part.decode("utf8", "replace") for part in searched]
    matched = sorted({root for root in roots for text in strings if root in text})
    visible = read and any(b"=" in part for part in present[argc:])
    system = exe.startswith(SYSTEM_PREFIXES)
    entry = {"pid": pid, "status": "match" if matched else "clear", "roots": matched, "envVisible": visible, "envRead": read, "systemOwned": system}
    # The executable path leaves the scanner only for a process whose environment
    # is withheld and that no system or application prefix claims.
    if read and not matched and not visible and not system:
        entry["exe"] = exe
    out.append(entry)
print(json.dumps(out))
`;
async function uidPids() {
  const listed = await runInventory("psUid", [
    "-U",
    String(process.getuid()),
    "-o",
    "pid=,ppid=",
  ]);
  return parseUidListing(listed.stdout);
}
async function inspectProcesses(pids, roots, scopes = roots) {
  const answer = await runInventory("scan", ["-I", "-c", SCAN_SCRIPT], {
    input: JSON.stringify({ pids, roots, scopes }),
  });
  let results;
  try {
    results = JSON.parse(answer.stdout);
  } catch {
    throw new Error("OWNER_PREVIEW_ISOLATION_SCAN_INCOMPLETE");
  }
  validateScan(results, pids);
  // This macOS answers EINVAL, not ESRCH, for a pid that has just exited: an
  // unreadable pid the kernel no longer knows is gone, anything else stays
  // unreadable.
  return results.map((entry) =>
    entry.status === "unreadable" && isGone(entry.pid)
      ? { ...entry, status: "gone" }
      : entry,
  );
}
// Order of operations: ancestry first, from the pid/ppid inventory alone; only
// the remaining candidates (this test's own tree, and new processes whose chain
// ends at launchd or at a vanished parent) have their arguments and environment
// read. Classes of new (not in the start snapshot) processes:
//   survivor      argv or environment contains a root of this run
//   unverifiable  its arguments cannot be read, OR its environment is withheld
//                 and both hold: argv names no system or application owner (the
//                 executable is outside /System, /usr, /bin, /sbin, /Library,
//                 /Applications, /opt, /private/var/db), and its parent chain
//                 reaches no pre-existing process other than launchd (pid 1) and
//                 this test process, so a reparented orphan (ppid 1) qualifies
//   excluded      environment withheld but owned by a system/application
//                 binary, or descended from a pre-existing process that is not
//                 this test: counted, never detailed
//   clear / gone  everything else
async function orphanReport(
  roots,
  preexisting,
  {
    listPids = uidPids,
    inspect = inspectProcesses,
    scopes = [],
    ours = new Set([process.pid]),
    tries = 100,
    interval = 50,
  } = {},
) {
  const empty = (extra = {}) => ({
    startSnapshot: preexisting.size,
    scanned: 0,
    inspected: 0,
    matches: [],
    unverifiable: [],
    excluded: { systemOwned: 0, otherParent: 0, foreignExecutable: 0 },
    clear: 0,
    gone: 0,
    ...extra,
  });
  if (roots.size === 0) return empty();
  let report;
  for (let attempt = 0; ; attempt += 1) {
    const listed = await listPids();
    const parent = new Map(listed.map((entry) => [entry.pid, entry.ppid]));
    const fresh = listed.filter((entry) => !preexisting.has(entry.pid));
    // Ancestry first, from the pid/ppid inventory alone. A chain that reaches a
    // pre-existing process other than this test belongs to someone else: it is
    // counted and its arguments and environment are never read. One that ends
    // at launchd or at a vanished parent, or reaches this test, is a candidate.
    const belongsToSomeoneElse = (pid) => {
      const visited = new Set();
      for (
        let current = parent.get(pid);
        current !== undefined && current > 1 && !visited.has(current);
        current = parent.get(current)
      ) {
        if (ours.has(current)) return false;
        if (preexisting.has(current)) return true;
        visited.add(current);
      }
      return false;
    };
    const candidates = fresh.filter(
      (entry) => !belongsToSomeoneElse(entry.pid),
    );
    const results =
      candidates.length === 0
        ? []
        : await inspect(
            candidates.map((entry) => entry.pid),
            [...roots],
            [...roots, ...scopes],
          );
    report = empty({
      scanned: fresh.length,
      inspected: candidates.length,
      excluded: {
        systemOwned: 0,
        otherParent: fresh.length - candidates.length,
        foreignExecutable: 0,
      },
    });
    for (const entry of results) {
      if (entry.status === "match")
        report.matches.push({ pid: entry.pid, roots: entry.roots });
      else if (entry.status === "unreadable")
        report.unverifiable.push({
          pid: entry.pid,
          reason: "UNREADABLE",
          errno: entry.errno,
        });
      else if (entry.status === "gone") report.gone += 1;
      else if (entry.envRead === false) report.excluded.foreignExecutable += 1;
      else if (entry.envVisible !== false) report.clear += 1;
      else if (entry.systemOwned === true) report.excluded.systemOwned += 1;
      else
        report.unverifiable.push({
          pid: entry.pid,
          reason: "ENV_WITHHELD",
          exe: entry.exe ?? null,
        });
    }
    if (
      (report.matches.length === 0 && report.unverifiable.length === 0) ||
      attempt >= tries
    )
      return report;
    await new Promise((r) => setTimeout(r, interval));
  }
}
// The one teardown, run for every exit path, and it never throws: any failure
// becomes an unverified result carrying a named error. A launch that failed
// before it returned a handle has no instance; its disposable root is covered
// by the orphan scan like every other root of the run.
async function verifyTeardown(targets, deps = {}) {
  const { roots = new Set(), preexisting = new Set(), ...rest } = deps;
  const reports = [];
  for (const target of targets)
    reports.push(await tearDownReport(target, rest));
  let orphans = null;
  let error = null;
  try {
    orphans = await orphanReport(roots, preexisting, rest);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "ORPHAN_SCAN_FAILED";
  }
  const survivors = [
    ...reports.flatMap((report) => report.survivors),
    ...(orphans?.matches ?? []).map((entry) => ({
      kind: "orphan",
      pid: entry.pid,
      reason: "ORPHAN_REMAINS",
      roots: entry.roots,
    })),
    ...(orphans?.unverifiable ?? []).map((entry) => ({
      kind: "scan",
      pid: entry.pid,
      reason: entry.reason,
      errno: entry.errno,
      exe: entry.exe,
    })),
  ];
  return {
    verified:
      error === null &&
      reports.every((report) => report.verified) &&
      survivors.length === 0,
    survivors,
    instances: reports,
    orphanScan: orphans,
    error,
  };
}
// Closes a run on every path. The teardown verification, the server close and
// the receipt are independent: none can prevent the others. A verification that
// throws becomes an unverified teardown with its error, a server that will not
// close is recorded, and the original failure stays the reported error.
async function settleRun({
  receipt,
  failure,
  verify,
  closeServer,
  checkpoint,
}) {
  let teardown;
  try {
    teardown = await verify();
  } catch (error) {
    teardown = {
      verified: false,
      survivors: [],
      instances: [],
      orphanScan: null,
      error: error instanceof Error ? error.message : "TEARDOWN_FAILED",
    };
  }
  try {
    await closeServer();
  } catch (error) {
    teardown = {
      ...teardown,
      verified: false,
      serverError:
        error instanceof Error ? error.message : "SERVER_CLOSE_FAILED",
    };
  }
  concludeReceipt(receipt, failure, teardown);
  await checkpoint();
}
function teardownTargets(instances, launches) {
  const started = new Set(instances.map((entry) => entry.home));
  return [
    ...instances,
    ...launches
      .filter((record) => record.home && !started.has(record.home))
      .map((record) => ({
        kind: record.kind,
        pid: null,
        home: record.home,
        seen: new Set(),
      })),
  ];
}
// PASS needs no failure and a verified teardown. Otherwise the status stays
// UNKNOWN: the original failure stays the reported error, and an unverified
// teardown with no other failure is reported as such.
function concludeReceipt(receipt, failure, teardown) {
  receipt.teardown = teardown;
  receipt.finishedAt = new Date().toISOString();
  if (failure === null && teardown.verified) {
    // Plain PASS is reserved for a run with no blocked dimension. When a
    // dimension could not be observed, only the exercised subset passed and the
    // status says so, naming what was not observed.
    const blocked = (receipt.blocked ?? []).map(
      (entry) => entry.code ?? entry.dimension,
    );
    if (blocked.length === 0) receipt.status = "PASS";
    else {
      receipt.status = "PASS_WITH_BLOCKED";
      receipt.blockedDimensions = blocked;
      receipt.statusNote = `Only the exercised subset passed; not observed: ${blocked.join(", ")}`;
    }
    return;
  }
  receipt.status = "UNKNOWN";
  receipt.error =
    failure !== null
      ? failure instanceof Error
        ? failure.message
        : "OWNER_PREVIEW_ISOLATION_FAILED"
      : (teardown.error ?? teardown.serverError)
        ? `OWNER_PREVIEW_ISOLATION_TEARDOWN_ERROR:${teardown.error ?? teardown.serverError}`
        : `OWNER_PREVIEW_ISOLATION_TEARDOWN_UNVERIFIED:${teardown.survivors
            .map((entry) => `${entry.kind}:${entry.pid}:${entry.reason}`)
            .join(",")}`;
}

// null is the explicit "already exited" outcome: the documented ps no-match for
// a pid the kernel no longer knows. Every other failure is an inventory error.
async function command(pid) {
  const answer = await runInventory(
    "ps",
    ["-o", "command=", "-p", String(pid)],
    {
      gone: () => isGone(pid),
    },
  );
  if (answer.outcome === "no_match") return null;
  return parsePsCommand(answer.stdout);
}
// ps cannot show an environment on this macOS; KERN_PROCARGS2 can, for a
// process of the same user. The values stay in memory: only key names and the
// verdicts below reach the receipt.
const PROCARGS_SCRIPT = `
import ctypes, ctypes.util, json, struct, sys
libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
pid = int(sys.argv[1])
def fail(reason):
    print(json.dumps({"status": "error", "reason": reason}))
    sys.exit(0)
mib = (ctypes.c_int * 3)(1, 49, pid)
size = ctypes.c_size_t(0)
if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
    fail("errno-" + str(ctypes.get_errno()))
buf = ctypes.create_string_buffer(size.value)
if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
    fail("errno-" + str(ctypes.get_errno()))
try:
    raw = buf.raw[:size.value]
    argc = struct.unpack("i", raw[:4])[0]
    parts = raw[4:].split(b"\\0")
    i = 1
    while i < len(parts) and parts[i] == b"": i += 1
    env = {}
    for p in parts[i + argc:]:
        if p == b"": continue
        if b"=" not in p: fail("env-entry")
        k, v = p.split(b"=", 1)
        k = k.decode("utf8", "replace")
        if k in env: fail("env-duplicate")
        env[k] = v.decode("utf8", "replace")
    argv = [p.decode("utf8", "replace") for p in parts[i:i + argc]]
    exe = parts[0].decode("utf8", "replace")
except Exception:
    fail("parse")
print(json.dumps({"status": "ok", "env": env, "argv": argv, "exe": exe}))
`;
// Fail closed: a readable process with a non-empty environment, or null for a
// pid that has exited. An unreadable or empty environment of a live pid is an
// error, never a skipped check. The environment is read without loss: a
// duplicate key or an entry without `=` (exec accepts both) is unreadable
// rather than silently dropped before classification. Returns { env, argv, exe }.
async function readProcess(pid) {
  const probed = await runInventory("probe", [
    "-I",
    "-c",
    PROCARGS_SCRIPT,
    String(pid),
  ]);
  let answer;
  try {
    answer = validateProcessAnswer(JSON.parse(probed.stdout));
  } catch (error) {
    if (/ROW_INVALID/u.test(error.message)) throw error;
    throw new Error(
      "OWNER_PREVIEW_ISOLATION_INVENTORY_ROW_INVALID:procargs:json",
    );
  }
  if (answer.status !== "ok" && isGone(pid)) return null;
  if (answer.status !== "ok")
    throw new Error(
      `OWNER_PREVIEW_ISOLATION_ENV_UNREADABLE:${pid}:${answer.reason}`,
    );
  if (Object.keys(answer.env).length === 0)
    throw new Error(`OWNER_PREVIEW_ISOLATION_ENV_EMPTY:${pid}`);
  return { env: answer.env, argv: answer.argv, exe: answer.exe };
}
async function environmentOf(pid) {
  return (await readProcess(pid))?.env ?? null;
}
// Every network socket on an owned pid is classified; nothing is ignored.
// UDP is a violation. Every TCP record must carry a recognised state: a
// missing or unrecognised state is a violation (MISSING_TCP_STATE,
// UNKNOWN_TCP_STATE), checked before the address so a wildcard address without
// a state cannot slip through. LISTEN qualifies only on 127.0.0.1 over IPv4;
// IPv6 (including ::1), the wildcard, a hostname, another address or an
// unparsable name is a violation with its own code. A recognised non-listening
// state (ESTABLISHED, CLOSE_WAIT, TIME_WAIT, ...) is a connection, not a
// listener, and its peer must be 127.0.0.1 too. Unix sockets are not network
// sockets and are compared separately.
const TCP_STATES = new Set([
  "CLOSED",
  "IDLE",
  "BOUND",
  "SYN_SENT",
  "SYN_RCDV",
  "SYN_RECEIVED",
  "ESTABLISHED",
  "CLOSE_WAIT",
  "FIN_WAIT_1",
  "CLOSING",
  "LAST_ACK",
  "FIN_WAIT_2",
  "TIME_WAIT",
]);
const TCP_STATES_WITHOUT_PEER = new Set(["CLOSED", "IDLE", "BOUND"]);
function classifySocket(file) {
  const network =
    file.type === "IPv4" ||
    file.type === "IPv6" ||
    file.protocol === "TCP" ||
    file.protocol === "UDP";
  if (!network) return null;
  const violation = (code) => ({
    pid: file.pid,
    code,
    protocol: file.protocol ?? null,
    state: file.state ?? null,
    name: file.name ?? null,
  });
  if (file.protocol === "UDP") return violation("UDP_SOCKET");
  if (file.protocol !== "TCP") return violation("UNPARSABLE_LISTENER");
  if (file.state === undefined) return violation("MISSING_TCP_STATE");
  const state = file.state.slice("ST=".length);
  if (state !== "LISTEN" && !TCP_STATES.has(state))
    return violation("UNKNOWN_TCP_STATE");
  if (state !== "LISTEN") {
    const peer = /^(.+):(\d{1,5})->(.+):(\d{1,5})$/u.exec(file.name ?? "");
    if (peer === null) {
      if (
        TCP_STATES_WITHOUT_PEER.has(state) &&
        /^(.*):(\d{1,5})$/u.test(file.name ?? "")
      )
        return { pid: file.pid, kind: "connection", state, remotePort: null };
      return violation("UNPARSABLE_SOCKET");
    }
    if (file.type !== "IPv4" || peer[3] !== "127.0.0.1")
      return violation("NON_LOOPBACK_PEER");
    return {
      pid: file.pid,
      kind: "connection",
      state,
      remotePort: Number(peer[4]),
    };
  }
  if (file.type === "IPv6") return violation("IPV6_LISTENER");
  const match = /^(.*):(\d{1,5})$/u.exec(file.name ?? "");
  if (file.type !== "IPv4" || match === null)
    return violation("UNPARSABLE_LISTENER");
  const host = match[1];
  if (host === "127.0.0.1")
    return {
      pid: file.pid,
      kind: "listener",
      protocol: "TCP",
      host,
      port: Number(match[2]),
    };
  if (host === "*") return violation("WILDCARD_LISTENER");
  if (/^\[.*\]$/u.test(host) || host.includes(":"))
    return violation("IPV6_LISTENER");
  if (/^\d{1,3}(\.\d{1,3}){3}$/u.test(host))
    return violation("NON_LOOPBACK_ADDRESS");
  return violation("HOSTNAME_LISTENER");
}
function listenerReport(files) {
  const accepted = [];
  const connections = [];
  const violations = [];
  for (const file of files) {
    const entry = classifySocket(file);
    if (entry === null) continue;
    if (entry.code !== undefined) violations.push(entry);
    else if (entry.kind === "listener") {
      const { kind, ...listener } = entry;
      accepted.push(listener);
    } else {
      const { kind, ...connection } = entry;
      connections.push(connection);
    }
  }
  return { accepted, connections, violations };
}
// One lsof per pid, each required to finish cleanly and to name its own pid.
// A pid confirmed gone is the only empty inventory; it is reported as such.
async function openFiles(pid) {
  const answer = await runInventory(
    "lsof",
    ["-nP", "-a", "-p", String(pid), "-F", "pftPnT"],
    { gone: () => isGone(pid) },
  );
  if (answer.outcome === "no_match")
    return { pid, outcome: "exited", files: [] };
  const files = parseLsof(answer.stdout);
  if (
    answer.stdout.split("\n")[0] !== `p${pid}` ||
    files.length === 0 ||
    files.some((file) => file.pid !== pid)
  )
    throw new Error(`OWNER_PREVIEW_ISOLATION_LSOF_INCOMPLETE:${pid}:SHAPE`);
  return { pid, outcome: "listed", files };
}

async function disposableRoot(temporary) {
  const home = await mkdtempIn(temporary, "farol-next-e2e-home-");
  await fs.chmod(home, 0o700);
  const appData = path.join(home, "farol-e2e-app-data");
  await fs.mkdir(appData, { mode: 0o700 });
  const proof = randomUUID();
  await fs.writeFile(path.join(home, ".farol-next-e2e-root"), proof, {
    flag: "wx",
    mode: 0o600,
  });
  // The same production proof the smoke harness uses; no profile override.
  desktopAppDataPath("owner-preview", appData, {
    enabled: true,
    override: appData,
    testRoot: home,
    testHome: home,
    testProof: proof,
  });
  return { home, appData, proof };
}

async function launch(
  electron,
  kind,
  verified,
  temporary,
  fixtureOrigin,
  record,
  options,
) {
  const preview = kind === "owner-preview";
  const app = preview ? verified.appPath : verified.baseApp;
  const root = await disposableRoot(temporary);
  const conflict = ownerConflict(root.home);
  if (conflict !== null)
    throw new Error(
      `OWNER_PREVIEW_ISOLATION_DISPOSABLE_ROOT_UNSAFE:${conflict}:${root.home}`,
    );
  options.run.roots.add(root.home);
  // Known before any process exists, so a failed launch still names its profile.
  record.home = root.home;
  const executable = path.join(
    app,
    "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
  );
  const appRoot = path.join(app, "Contents/Resources/app");
  const environment = {
    HOME: root.home,
    TMPDIR: temporary,
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    ELECTRON_FORCE_IS_PACKAGED: "true",
    FAROL_NEXT_E2E: "1",
    FAROL_NEXT_E2E_APP_DATA: root.appData,
    FAROL_NEXT_E2E_TEST_ROOT: root.home,
    FAROL_NEXT_E2E_TEST_PROOF: root.proof,
    FAROL_NEXT_E2E_CHATGPT_URL: fixtureOrigin,
    ...(preview ? { FAROL_NEXT_ENVIRONMENT: "owner-preview" } : {}),
  };
  for (const [key, value] of Object.entries(environment))
    if (key !== "FAROL_NEXT_E2E_TEST_PROOF") options?.run?.declared?.add(value);
  const instance = {
    kind,
    app,
    appRoot,
    executable,
    ...root,
    handle: null,
    pid: null,
    terminal: null,
    // Every pid ever seen in this instance's process tree, and the members that
    // must appear in every listing of it while they are alive.
    seen: new Set(),
    known: new Set(),
    quit: { requested: false, expired: false, promise: null },
  };
  instance.handle = await electron.launch({
    // Test seam: an unlaunchable executable for one kind, to show the
    // partial-launch receipt. Never set by the command-line entrypoint.
    executablePath:
      options.failLaunchOf === kind
        ? "/nonexistent/farol-isolation-launch-failure"
        : executable,
    args: [
      appRoot,
      "--preview-window-mode=hidden",
      ...(preview ? ["--owner-background-only"] : []),
    ],
    env: environment,
    timeout: 20000,
  });
  instance.owned = instance.handle.process();
  watchExit(instance);
  instance.pid = instance.owned.pid;
  assert.ok(Number.isInteger(instance.pid) && instance.pid > 0);
  instance.seen.add(instance.pid);
  instance.known.add(instance.pid);
  // The outbound route is installed the moment the handle exists, before the
  // other instance is launched and before any observation, so the whole
  // remaining startup of this browser context is covered. A route that cannot
  // be installed is kept as a failure of this instance, never a silent gap.
  instance.outbound = [];
  instance.routeFailure = null;
  try {
    await instance.handle.context().route("**/*", (route) => {
      const url = route.request().url();
      if (
        url.startsWith(`${fixtureOrigin}/`) ||
        url.startsWith("file:") ||
        url.startsWith("devtools:")
      )
        return route.continue();
      instance.outbound.push(new URL(url).origin);
      return route.abort();
    });
  } catch {
    instance.routeFailure = "ROUTE_UNAVAILABLE";
  }
  return instance;
}

// Quit outcome, one derivation. The terminal state is whatever the process
// object actually reported (exit code or signal), recorded by a listener that
// is attached at launch and never written from anywhere else. The outcome is a
// pure function of that state and of whether a quit was requested and its wait
// expired: "observed" only with a recorded exit code or signal, "timed_out"
// when the wait expired without one, "not_requested", and "unknown" otherwise.
function watchExit(instance) {
  const note = (code, signal) => {
    instance.terminal ??= { code, signal };
  };
  const { exitCode, signalCode } = instance.owned;
  if (exitCode !== null || signalCode !== null) note(exitCode, signalCode);
  else instance.owned.once("exit", note);
}
function quitOutcome(instance) {
  if (instance.terminal !== null) return "observed";
  if (!instance.quit.requested) return "not_requested";
  if (instance.quit.expired) return "timed_out";
  return "unknown";
}
// The only writer of a launch record's quit fields.
function writeQuit(instance) {
  instance.record.quit = quitOutcome(instance);
  instance.record.terminal = instance.terminal;
  instance.record.quitWaitExpired = instance.quit.expired;
  instance.record.seenPids = [...instance.seen].sort((x, y) => x - y);
  return instance.record.quit;
}
// One orderly quit per instance; never retried, signalled or killed. Every
// call returns the first call's outcome (the same promise): a second request
// cannot report success on its own, and a timeout does not throw.
function requestQuit(instance, milliseconds = 20000) {
  instance.quit.promise ??= (async () => {
    if (instance.terminal === null) {
      instance.quit.requested = true;
      const exited = new Promise((resolve) =>
        instance.owned.once("exit", resolve),
      );
      void instance.handle.evaluate(({ app }) => app.quit()).catch(() => {});
      try {
        await deadline(exited, `${instance.kind}-quit`, milliseconds);
      } catch {
        instance.quit.expired = true;
      }
    }
    return quitOutcome(instance);
  })();
  return instance.quit.promise;
}

// A process record keeps verdicts about HOME, CODEX_HOME and the runtime
// identity, never their values: whether each is present, the class the one
// classifier gave it, and whether it lies where it must. Raw values exist only
// inside the call.
function environmentRecord(
  environment,
  { instance, other, identity, context },
) {
  const has = (name) => name in environment;
  const within = (name, root) =>
    has(name) && inside(environment[name], root, true);
  return {
    keys: Object.keys(environment).sort(),
    homePresent: has("HOME"),
    homeClass: has("HOME") ? classifyPath(environment.HOME, context) : null,
    homeIsInstanceRoot: environment.HOME === instance.home,
    homeInsideOwnRoot: within("HOME", instance.home),
    homeInsideOtherRoot: within("HOME", other.home),
    codexHomePresent: has("CODEX_HOME"),
    codexHomeClass: has("CODEX_HOME")
      ? classifyPath(environment.CODEX_HOME, context)
      : null,
    codexHomeInsideProfile: within("CODEX_HOME", identity.userData),
    runtimeIdentityPresent: has("FAROL_NEXT_RUNTIME_IDENTITY"),
    runtimeIdentityMatches:
      environment.FAROL_NEXT_RUNTIME_IDENTITY === identity.runtimeIdentity,
  };
}
// The extra HOME / CODEX_HOME requirements, on top of the classifier. HOME must
// be set and inside THIS instance's disposable root; the one exception is the
// Node runtime child, which the shell spawns with an explicit minimal
// environment that never includes HOME (startRuntime in main.ts) and is
// recorded as a finding. CODEX_HOME, if present, must lie inside this
// instance's own profile.
function assertProcessEnvironment(entry) {
  assert.ok(entry.environment.keys.length > 0, `ENV_EMPTY:${entry.pid}`);
  if (entry.environment.homePresent) {
    assert.ok(
      entry.environment.homeInsideOwnRoot,
      `HOME_OUTSIDE_INSTANCE_ROOT:${entry.role}:${entry.pid}`,
    );
    assert.equal(entry.environment.homeInsideOtherRoot, false);
  } else {
    assert.equal(
      entry.role,
      "runtime",
      `OWNED_PROCESS_HOME_MISSING:${entry.role}:${entry.pid}`,
    );
    assert.ok(
      entry.environment.keys.includes("ELECTRON_RUN_AS_NODE"),
      `RUNTIME_CHILD_NOT_NODE_MODE:${entry.pid}`,
    );
  }
  if (entry.environment.codexHomePresent)
    assert.ok(
      entry.environment.codexHomeInsideProfile &&
        entry.environment.codexHomeClass === "own",
      `CODEX_HOME_OUTSIDE_INSTANCE_ROOT:${entry.role}:${entry.pid}`,
    );
}
// The receipt guard. No receipt ever carries a raw environment value: before a
// receipt is written, every string in it is checked against (1) the environment
// values observed in this run, when they are path-like or at least 12 characters
// (short enumerations such as `normal` are not secrets), and (2) the owner: any
// path in it that is an owner location, or that lies under the owner's home
// without being inside this run's disposable roots or the checkout. Paths inside
// the disposable roots and the checkout are allowed because they are recorded by
// design. A finding is redacted (a whole value, or just the offending path inside
// a failure message) and reported by JSON pointer and code only; the caller
// writes the scrubbed receipt and then fails closed.
function guardReceipt(
  receipt,
  { envValues, declared = new Set(), roots, repositoryRoot },
) {
  const homeForms = formsOf(os.userInfo().homedir);
  // A value this run wrote into a launch environment itself (an instance kind,
  // a locale, the fixture origin) is public by construction, not a secret; the
  // test proof is never declared, so it stays guarded.
  const guarded = new Set(
    [...envValues].filter(
      (value) =>
        !declared.has(value) && (value.length >= 12 || path.isAbsolute(value)),
    ),
  );
  const recorded = (candidate) => {
    try {
      return (
        [...roots].some((root) => inside(candidate, root, true)) ||
        inside(candidate, repositoryRoot, true)
      );
    } catch {
      return false;
    }
  };
  const violations = [];
  const verdict = (text) => {
    if (guarded.has(text) && !(path.isAbsolute(text) && recorded(text)))
      return { code: "ENV_VALUE", whole: true };
    let code = null;
    const offenders = [];
    for (const candidate of extractPaths(text)) {
      if (recorded(candidate)) continue;
      let owner;
      try {
        owner = touchesOwner(candidate, { reported: true });
      } catch {
        owner = true;
      }
      let real = candidate;
      try {
        real = canonical(candidate, true);
      } catch {
        // judged literally
      }
      const underHome = homeForms.some(
        (home) => contains(candidate, home) || contains(real, home),
      );
      if (owner || underHome) {
        code ??= owner ? "OWNER_LOCATION" : "OWNER_HOME_PATH";
        offenders.push(candidate);
      }
    }
    return code === null ? null : { code, offenders };
  };
  // A failure message may name an owner path (that is the finding): only the
  // path is redacted, so the code in front of it survives.
  const scrub = (node, pointer) => {
    if (typeof node === "string") {
      const found = verdict(node);
      if (found === null) return node;
      violations.push({ code: found.code, pointer });
      if (found.whole) return "[REDACTED]";
      return [...found.offenders]
        .sort((x, y) => y.length - x.length)
        .reduce(
          (text, offender) => text.split(offender).join("[REDACTED_PATH]"),
          node,
        );
    }
    if (Array.isArray(node))
      return node.map((item, index) => scrub(item, `${pointer}/${index}`));
    if (node !== null && typeof node === "object")
      return Object.fromEntries(
        Object.entries(node).map(([key, value]) => [
          key,
          scrub(value, `${pointer}/${key}`),
        ]),
      );
    return node;
  };
  return { receipt: scrub(receipt, ""), violations };
}

// One snapshot of everything the operating system says about an instance.
async function observe(instance, expected) {
  if (instance.routeFailure !== null)
    throw new Error(
      `OWNER_PREVIEW_ISOLATION_${instance.routeFailure}:${instance.kind}`,
    );
  const outbound = instance.outbound;
  const page = await instance.handle.firstWindow({ timeout: 20000 });
  await page.locator(".desktop").waitFor({ state: "attached", timeout: 20000 });
  const bootstrap = await deadline(
    page.evaluate(() => window.farolNext.bootstrap()),
    `${instance.kind}-bootstrap`,
  );
  const runtime = await deadline(
    instance.handle.evaluate(
      ({ app, BrowserWindow, session, webContents }) => ({
        name: app.getName(),
        userData: app.getPath("userData"),
        sessionData: app.getPath("sessionData"),
        home: app.getPath("home"),
        executable: process.execPath,
        windows: BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
        })),
        webContents: webContents.getAllWebContents().map((contents) => ({
          url: contents.getURL(),
          storagePath: contents.session.storagePath ?? null,
        })),
        defaultStorage: session.defaultSession.storagePath ?? null,
      }),
    ),
    `${instance.kind}-runtime`,
  );
  const partitions = await deadline(
    instance.handle.evaluate(
      ({ session }, names) =>
        Object.fromEntries(
          names.map((name) => [name, session.fromPartition(name).storagePath]),
        ),
      [bootstrap.partition, bootstrap.chatgptPartition],
    ),
    `${instance.kind}-partitions`,
  );
  // The Go backend and the Node runtime are children of the shell and start a
  // little after it. The runtime child is the one that serves a loopback port.
  const runtimeScript = path.join(instance.appRoot, "runtime.cjs");
  let tree = [];
  let backend = null;
  let runtimeChild = null;
  for (
    let attempt = 0;
    attempt < 100 && (backend === null || runtimeChild === null);
    attempt += 1
  ) {
    tree = await scanTree(instance);
    for (const pid of tree.slice(1)) {
      const text = await command(pid);
      if (text === null) continue;
      if (/farol-backend serve /u.test(text)) backend = { pid, command: text };
      else if (text.endsWith(` ${runtimeScript}`))
        runtimeChild = { pid, command: text };
    }
    if (backend === null || runtimeChild === null)
      await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(backend, `OWNER_PREVIEW_ISOLATION_NO_BACKEND:${instance.kind}`);
  assert.ok(
    runtimeChild,
    `OWNER_PREVIEW_ISOLATION_NO_RUNTIME:${instance.kind}`,
  );
  instance.known.add(backend.pid);
  instance.known.add(runtimeChild.pid);
  // Wait for the runtime child's listener, one strict lsof per attempt.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const inventory = await openFiles(runtimeChild.pid);
    if (inventory.outcome === "exited") break;
    if (listenerReport(inventory.files).accepted.length > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Per-pid checks run on the union of every pid ever seen, in rounds, each
  // after the tree has been stable across two snapshots, until a round finds
  // nothing new. Each pid yields a command, a readable non-empty environment
  // and a clean lsof inventory, or the explicit "exited" outcome. The parent,
  // the backend and the runtime child may not exit: for them any gap is an
  // error, never a skipped check.
  const required = new Map([
    [instance.pid, "parent"],
    [backend.pid, "backend"],
    [runtimeChild.pid, "runtime"],
  ]);
  const context = classificationContext(instance, expected.other);
  const processes = [];
  const files = [];
  const strings = [];
  const handled = new Set();
  for (let round = 0; ; round += 1) {
    await stableTree(() => scanTree(instance), {
      label: `${instance.kind}:${instance.pid}`,
    });
    const todo = [...instance.seen].filter((pid) => !handled.has(pid));
    if (todo.length === 0) break;
    if (round >= 5)
      throw new Error(
        `OWNER_PREVIEW_ISOLATION_TREE_UNSTABLE:${instance.kind}:${todo.join(",")}`,
      );
    for (const pid of todo) {
      handled.add(pid);
      const text = await command(pid);
      const read = text === null ? null : await readProcess(pid);
      const environment = read === null ? null : read.env;
      const inventory = environment === null ? null : await openFiles(pid);
      if (
        text === null ||
        environment === null ||
        inventory.outcome === "exited"
      ) {
        assert.equal(
          required.has(pid),
          false,
          `OWNER_PREVIEW_ISOLATION_OWNED_PROCESS_EXITED:${required.get(pid)}:${pid}`,
        );
        processes.push({ pid, outcome: "exited" });
        continue;
      }
      files.push(...inventory.files);
      for (const value of Object.values(environment))
        expected.envValues.add(value);
      strings.push(
        ...processStrings(
          pid,
          required.get(pid) ?? "helper",
          read,
          inventory.files,
        ),
      );
      processes.push({
        pid,
        outcome: "observed",
        role: required.get(pid) ?? "helper",
        command: text,
        // Verdicts only: no environment value is ever stored here. The raw
        // values live in this loop for the checks and, for the receipt guard,
        // in the run's in-memory set.
        environment: environmentRecord(environment, {
          instance,
          other: expected.other,
          identity: expected.identity,
          context,
        }),
        openFileCount: inventory.files.length,
      });
    }
  }
  for (const pid of required.keys())
    assert.ok(
      instance.seen.has(pid),
      `OWNER_PREVIEW_ISOLATION_NOT_IN_TREE:${pid}`,
    );
  return {
    kind: instance.kind,
    pid: instance.pid,
    bootstrap,
    runtime,
    partitions,
    outbound,
    backend,
    runtimeChild,
    processes,
    files,
    listeners: listenerReport(files).accepted,
    connections: listenerReport(files).connections,
    listenerViolations: listenerReport(files).violations,
    classification: classifyStrings(strings, context),
    unixPaths: files
      .filter((file) => file.type === "unix" && file.name?.startsWith("/"))
      .map((file) => file.name),
    paths: files
      .filter((file) => file.name?.startsWith("/"))
      .map((file) => file.name),
  };
}

async function assertInstance(observed, instance, identity, other) {
  const { runtime, bootstrap, partitions } = observed;
  assert.equal(bootstrap.partition, identity.runtimePartition);
  assert.equal(bootstrap.chatgptPartition, identity.chatGptPartition);
  assert.equal(bootstrap.applicationId, identity.applicationId);
  assert.equal(runtime.name, identity.applicationName);
  assert.equal(runtime.userData, identity.userData);
  assert.equal(runtime.sessionData, identity.userData);
  assert.equal(runtime.home, instance.home);
  // Each Chromium storage path the OS-level session reports, including the
  // sessions of the live web contents, sits under THIS instance's profile.
  for (const storage of [
    ...Object.values(partitions),
    ...runtime.webContents.map((entry) => entry.storagePath),
    runtime.defaultStorage,
  ])
    if (storage !== null)
      assert.ok(inside(storage, identity.userData), `STORAGE:${storage}`);
  for (const name of [bootstrap.partition, bootstrap.chatgptPartition])
    assert.ok(
      partitions[name]?.endsWith(`${path.sep}${name.slice("persist:".length)}`),
    );
  assert.ok(
    runtime.windows.length > 0 &&
      runtime.windows.every((window) => !window.visible && !window.focused),
    "WINDOW_NOT_HIDDEN",
  );
  assert.deepEqual(observed.outbound, []);
  // Every process descends from the launched parent and runs bytes from this
  // instance's own bundle, never the other instance's or the installed app.
  const live = observed.processes.filter(
    (entry) => entry.outcome === "observed",
  );
  for (const required of [
    instance.pid,
    observed.backend.pid,
    observed.runtimeChild.pid,
  ])
    assert.ok(
      live.some((entry) => entry.pid === required),
      `OWNER_PREVIEW_ISOLATION_OWNED_PROCESS_NOT_OBSERVED:${required}`,
    );
  for (const entry of live) {
    assert.ok(
      entry.command.includes(instance.app) || entry.pid === instance.pid,
      `FOREIGN_PROCESS:${entry.command.slice(0, 120)}`,
    );
    assertProcessEnvironment(entry);
  }
  const parent = live.find((entry) => entry.pid === instance.pid);
  assert.equal(parent.environment.homeIsInstanceRoot, true);
  assert.equal(
    await fs.realpath(runtime.executable),
    await fs.realpath(instance.executable),
  );
  // The backend helper carries this instance's home and profile root.
  const flag = (name) =>
    new RegExp(`--${name} (.+?)(?= --[a-z]|$)`, "u").exec(
      observed.backend.command,
    )?.[1];
  assert.equal(flag("home"), instance.home);
  assert.equal(
    flag("profile-root"),
    path.join(identity.userData, "farol-next-state/go-core"),
  );
  assert.ok(
    observed.backend.command.startsWith(
      path.join(instance.appRoot, "farol-backend"),
    ),
  );
  assert.equal(
    live.some((entry) => /(^|\/)codex(\s|$)/u.test(entry.command)),
    false,
    "A Codex child needs a live provider and cannot be witnessed here",
  );
  // Sockets: TCP LISTEN on 127.0.0.1 only, at least one; any other network
  // listener on an owned pid fails with its code (see classifySocket).
  assert.deepEqual(
    observed.listenerViolations,
    [],
    `NON_LOOPBACK_LISTENER:${JSON.stringify(observed.listenerViolations[0] ?? null)}`,
  );
  assert.ok(observed.listeners.length > 0);
  // The Node runtime child serves its loopback port under this instance's
  // runtime identity; it is not the other channel's and not the owner's.
  const runtimeProcess = live.find(
    (entry) => entry.pid === observed.runtimeChild.pid,
  );
  assert.equal(runtimeProcess.environment.runtimeIdentityMatches, true);
  assert.ok(
    observed.listeners.some((entry) => entry.pid === observed.runtimeChild.pid),
    "RUNTIME_NOT_LISTENING",
  );
  // Files: this instance reaches its own roots and no other root.
  assert.ok(
    observed.paths.some((entry) => inside(entry, identity.userData, true)),
    "OWN_PROFILE_NOT_OPEN",
  );
  // Every string observed for an owned process went through the one classifier
  // (see classifyStrings): any other_instance or owner string fails here.
  const [first] = observed.classification.violations;
  if (first !== undefined) throw new Error(violationMessage(first));
}

// Parser grammars, table-driven: every inventory parser accepts a valid sample,
// rejects a malformed row in the middle and an unexpectedly empty listing, and
// never repeats the row it rejected.
function parserSelfCheck() {
  const generation = "a".repeat(64);
  const invocation = `node tests/e2e/owner-preview-isolation.e2e.mjs --generation ${generation}`;
  const guard = `/usr/bin/python3 -I ./${GUARD_SCRIPT} --`;
  for (const [parent, expected] of [
    [`${guard} ${invocation}`, true],
    [
      `/Library/Developer/CommandLineTools/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python -I ./${GUARD_SCRIPT} -- /opt/node/bin/${invocation}`,
      true,
    ],
    [`/usr/bin/python3 -I /x/farol/${GUARD_SCRIPT} -- ${invocation}`, true],
    [
      `npm run test:e2e:owner-preview-isolation -- --generation ${generation}`,
      false,
    ],
    [`/bin/zsh -c ${invocation}`, false],
    ["-zsh", false],
    [`${guard} npm run x -- --generation ${generation}`, false],
    [`${guard} ${invocation.replace(generation, "b".repeat(64))}`, false],
    [`${guard} ${invocation} --extra`, false],
    [
      `/usr/bin/python3 -I ./scripts/not-assert-owner-untouched.py -- ${invocation}`,
      false,
    ],
  ])
    assert.equal(guardedInvocation(parent, generation), expected, parent);
  const secret = "SECRETROW=do-not-echo";
  const scan = (pids) => (text) => validateScan(JSON.parse(text), pids);
  const procargs = (text) => validateProcessAnswer(JSON.parse(text));
  const table = {
    "ps-uid": {
      parse: (text) => parseUidListing(text, 77),
      valid: "   77     1\n  100    77\n",
      malformed: `77 1\n${secret}\n100 77\n`,
      empty: "\n  \n",
      rejected: ["100 77\n"], // lacks this test's own pid
    },
    pgrep: {
      parse: parsePgrepPids,
      valid: "11\n12\n",
      malformed: `11\n${secret}\n12\n`,
      empty: "",
    },
    ps: {
      parse: parsePsCommand,
      valid: "/bin/tool --flag value\n",
      malformed: "/bin/tool one\n/bin/tool two\n", // exactly one row
      empty: "\n",
    },
    lsof: {
      parse: parseLsof,
      valid: "p5\nf3\ntIPv4\nPTCP\nn127.0.0.1:1\nTST=LISTEN\nTQR=0\n",
      malformed: `p5\nf3\nPTCP\nz${secret}\nn/x\n`,
      empty: "",
      rejected: [
        "n/orphan-field-before-any-file\n",
        "f3\nn/file-before-any-process\n",
        "p5\nf3\nTnot-a-subfield\n",
        "pabc\nf3\n",
        "p5\nf5\nn*:8080\n", // no type: could hide a listener
        "p5\nf5\ntIPv4\nn*:8080\n", // a network file without a protocol
        "p5\nf5\ntREG\nn/x\nf6\nn*:8080\n", // the second file has no type
      ],
    },
    scan: {
      parse: scan([1, 2]),
      valid: JSON.stringify([
        {
          pid: 1,
          status: "clear",
          roots: [],
          envVisible: true,
          envRead: true,
          systemOwned: false,
        },
        { pid: 2, status: "gone", errno: 3 },
      ]),
      malformed: JSON.stringify([
        {
          pid: 1,
          status: "clear",
          roots: [],
          envVisible: true,
          envRead: true,
          systemOwned: false,
        },
        { pid: 2, status: secret },
      ]),
      empty: "[]",
      rejected: [
        JSON.stringify([
          {
            pid: 1,
            status: "clear",
            roots: "x",
            envVisible: true,
            envRead: true,
            systemOwned: false,
          },
          { pid: 2, status: "gone", errno: 3 },
        ]),
        JSON.stringify([
          { pid: 2, status: "gone", errno: 3 },
          { pid: 1, status: "gone", errno: 3 },
        ]),
        JSON.stringify([
          {
            pid: 1,
            status: "clear",
            roots: [],
            envVisible: true,
            systemOwned: false,
          },
          { pid: 2, status: "gone", errno: 3 },
        ]),
      ],
    },
    procargs: {
      parse: procargs,
      valid: JSON.stringify({
        status: "ok",
        env: { A: "b" },
        argv: ["x"],
        exe: "/x",
      }),
      malformed: JSON.stringify({
        status: "ok",
        env: { A: 1 },
        argv: [secret],
        exe: "/x",
      }),
      empty: "null",
      rejected: [
        JSON.stringify({ status: "ok", env: {}, argv: "x", exe: "/x" }),
      ],
    },
  };
  for (const [name, entry] of Object.entries(table)) {
    assert.doesNotThrow(() => entry.parse(entry.valid), `${name}: valid`);
    for (const [label, sample] of [
      ["malformed", entry.malformed],
      ["empty", entry.empty],
      ...(entry.rejected ?? []).map((text) => ["rejected", text]),
    ]) {
      let failure = null;
      try {
        entry.parse(sample);
      } catch (error) {
        failure = error;
      }
      assert.ok(failure, `${name}: ${label} must be an inventory error`);
      assert.match(
        failure.message,
        /^OWNER_PREVIEW_ISOLATION_/u,
        `${name}: ${label}`,
      );
      assert.equal(
        failure.message.includes("SECRETROW"),
        false,
        `${name}: row echoed`,
      );
    }
  }
  // A malformed row names its command and index.
  assert.throws(
    () => parsePgrepPids(`11\n${secret}\n12\n`),
    /^Error: OWNER_PREVIEW_ISOLATION_INVENTORY_ROW_INVALID:pgrep:1$/u,
  );
  // A documented header (row 0 only) and blank lines are the only skips, and a
  // header-only listing is fine where an empty listing is legitimate.
  const spec = {
    command: "generic",
    header: /^PID$/u,
    row: /^(\d+)$/u,
    map: (match) => Number(match[1]),
  };
  assert.deepEqual(parseRows("PID\n\n5\n6\n", spec), [5, 6]);
  assert.deepEqual(parseRows("PID\n", { ...spec, allowEmpty: true }), []);
  assert.throws(() => parseRows("PID\n", spec), /INVENTORY_EMPTY:generic/u);
  assert.throws(() => parseRows("5\nPID\n6\n", spec), /ROW_INVALID:generic:1/u);
}

// The scanners below judge live observations; prove they can fail first.
async function scannerSelfCheck() {
  const home = os.userInfo().homedir;
  parserSelfCheck();
  assert.equal(touchesOwner(path.join(home, ".codex/config.toml")), true);
  assert.equal(
    touchesOwner(
      path.join(home, "Library/Application Support/Farol Preview/x"),
    ),
    true,
  );
  assert.equal(
    touchesOwner("/Applications/Farol.app/Contents/MacOS/Farol"),
    true,
  );
  assert.equal(
    touchesOwner("/private/var/folders/x/T/farol-next-e2e-home-a/f"),
    false,
  );
  // Every root the owner guard prints is an owner location, the nested
  // acceptance profiles included, and so is any later `Farol*` profile.
  const support = path.join(home, "Library/Application Support");
  assert.ok(
    ownerState.guardRoots.includes(path.join(support, "Farol Dev Acceptance")),
    "the guard no longer declares the Dev Acceptance profile",
  );
  for (const root of ownerState.guardRoots) {
    assert.equal(touchesOwner(root), true, root);
    assert.equal(touchesOwner(path.join(root, "x/y")), true, root);
  }
  for (const profile of [
    "Farol Dev Acceptance/Farol Dev/farol-next-state/running.json",
    "Farol Dev Acceptance/Farol DEV",
    "Farol Preview/Cookies",
    "Farol Future Channel/anything",
  ])
    assert.equal(touchesOwner(path.join(support, profile)), true, profile);
  assert.equal(touchesOwner(path.join(support, "Code/User")), false);
  // A failed read of the guard's declaration is an error, never a smaller list.
  await assert.rejects(
    loadProtectedRoots("/x", "/nonexistent/assert-owner-untouched.py"),
    /INVENTORY_ERROR:guard/u,
  );
  assert.equal(inside("/a/bc", "/a/b"), false);
  assert.equal(inside("/a/b/c", "/a/b"), true);
  assert.equal(inside("relative/path", "/a/b"), false);
  // Containment is canonical: `..` escapes, sibling prefixes, trailing slashes
  // and a symlinked root.
  const sandbox = await fs.realpath(
    await mkdtempIn(os.tmpdir(), "farol-next-e2e-selfcheck-"),
  );
  try {
    const a = path.join(sandbox, "instance-a");
    const a2 = path.join(sandbox, "instance-a2");
    const b = path.join(sandbox, "instance-b");
    for (const directory of [a, a2, b]) await fs.mkdir(directory);
    // This run's own disposable roots are never owner locations; a symlink out
    // of them is judged by where it leads; and an exempted root that is itself
    // an owner location is a hard failure. (Stand-in guard roots, so nothing of
    // the owner's is touched.)
    const savedRoots = ownerState.guardRoots;
    const savedExempt = ownerState.exempt;
    setGuardRoots([path.join(a2, "guarded")]);
    try {
      assert.equal(touchesOwner(`${a2}/guarded/x`), true);
      assert.equal(touchesOwner(`${b}/guarded/x`), false);
      ownerState.exempt = new Set([b]);
      assert.equal(touchesOwner(`${b}/x`), false);
      await fs.mkdir(path.join(a2, "guarded"));
      await fs.symlink(path.join(a2, "guarded"), path.join(b, "escape"));
      assert.equal(touchesOwner(`${b}/escape/x`), true);
      for (const root of [
        a2,
        path.join(a2, "guarded"),
        path.join(a2, "guarded/in"),
      ]) {
        ownerState.exempt = new Set([root]);
        assert.throws(
          () => touchesOwner(`${root}/x`),
          /DISPOSABLE_ROOT_UNSAFE/u,
          root,
        );
      }
      // A temporary parent under a guard root, equal to the owner's home, or
      // containing an owner location is refused before anything is created.
      let created = 0;
      const spy = async (stem) => {
        created += 1;
        return `${stem}fake`;
      };
      for (const unsafe of [
        path.join(a2, "guarded"),
        path.join(a2, "guarded/tmp"),
        home,
        path.dirname(home),
        "/",
        path.join(home, ".codex/tmp"),
        path.join(support, "Farol Dev Acceptance/tmp"),
        path.join(support, "Farol Future Channel"),
        support,
      ])
        await assert.rejects(
          mkdtempIn(unsafe, "x-", spy),
          /TEMP_PARENT_UNSAFE/u,
          unsafe,
        );
      assert.equal(created, 0);
    } finally {
      setGuardRoots(savedRoots);
      ownerState.exempt = savedExempt;
    }
    // Both sides are canonical: a protected location that is itself a symlink is
    // matched by a path under its target as well as under its name, a candidate
    // that is a symlink into an owner root is caught, and a sibling that merely
    // shares a prefix is not. (Stand-in roots inside the throwaway directory.)
    {
      const ownerReal = path.join(sandbox, "owner-real");
      const ownerLink = path.join(sandbox, "owner-link");
      await fs.mkdir(path.join(ownerReal, "inner"), { recursive: true });
      await fs.symlink(ownerReal, ownerLink);
      const candidateLink = path.join(sandbox, "candidate-link");
      await fs.symlink(path.join(ownerReal, "inner"), candidateLink);
      const before = ownerState.guardRoots;
      setGuardRoots([ownerLink]);
      try {
        assert.equal(touchesOwner(`${ownerReal}/x`), true, "under the target");
        assert.equal(touchesOwner(`${ownerLink}/x`), true, "under the name");
        assert.equal(
          touchesOwner(`${candidateLink}/f`),
          true,
          "symlinked candidate",
        );
        assert.equal(touchesOwner(`${ownerReal}-sibling/x`), false);
        assert.equal(touchesOwner(`${sandbox}/owner-realX`), false);
        assert.equal(touchesOwner(`${sandbox}/owner-linked/x`), false);
        // A PATH-like list is judged member by member.
        assert.equal(touchesOwner(`/usr/bin:${ownerReal}/bin`), true);
        assert.equal(touchesOwner(`/usr/bin:${ownerReal}-sibling/bin`), false);
        // Command text: the root counts only when a non-name character ends it.
        assert.equal(touchesOwner(`--home ${ownerReal}`, { text: true }), true);
        assert.equal(
          touchesOwner(`--home ${ownerLink} --x`, { text: true }),
          true,
        );
        assert.equal(
          touchesOwner(`--home ${ownerReal}-sibling`, { text: true }),
          false,
        );
        // The temporary-parent refusal compares both sides the same way.
        assert.equal(
          ownerConflict(`${ownerReal}/tmp`),
          "INSIDE_OWNER_LOCATION",
        );
        assert.equal(
          ownerConflict(`${ownerLink}/tmp`),
          "INSIDE_OWNER_LOCATION",
        );
        assert.equal(ownerConflict(candidateLink), "INSIDE_OWNER_LOCATION");
        assert.equal(ownerConflict(sandbox), "CONTAINS_OWNER_LOCATION");
        assert.equal(ownerConflict(`${ownerReal}-sibling`), null);
        // The exemption of a disposable root: a root that is the target of an
        // owner symlink is an owner location and cannot be exempted.
        const savedExempt = ownerState.exempt;
        ownerState.exempt = new Set([ownerReal]);
        try {
          assert.throws(
            () => touchesOwner(`${ownerReal}/x`),
            /DISPOSABLE_ROOT_UNSAFE:INSIDE_OWNER_LOCATION/u,
          );
        } finally {
          ownerState.exempt = savedExempt;
        }
      } finally {
        setGuardRoots(before);
      }
      // A real sibling that shares a prefix with a real owner location.
      assert.equal(touchesOwner(path.join(home, ".codex-backup/x")), false);
      assert.equal(touchesOwner(path.join(home, ".codex/x")), true);
    }
    // The one classifier, on stand-in instance roots inside the throwaway
    // directory and the real owner locations. Own, other-instance, owner and
    // neutral strings; environment values are never named in a failure.
    {
      const ownRoot = path.join(sandbox, "classify-own");
      const otherRoot = path.join(sandbox, "classify-other");
      await fs.mkdir(ownRoot);
      await fs.mkdir(otherRoot);
      const context = classificationContext(
        { home: ownRoot, app: path.join(ownRoot, "App.app") },
        { home: otherRoot, app: path.join(otherRoot, "App.app") },
      );
      const one = (item) =>
        classifyStrings([{ pid: 1, role: "helper", ...item }], context);
      const classOf = (item) => {
        const { counts, violations } = one(item);
        return (
          violations[0]?.code ??
          Object.keys(counts[item.kind]).find(
            (name) => counts[item.kind][name] === 1,
          )
        );
      };
      // extraction: flags, assignments, lists, quotes, file URLs.
      for (const expected of ["/x/y", "/z", "/q r/s", "/f/g", "/h"])
        assert.ok(
          extractPaths('--a=/x/y:/z "/q r/s" file:///f/g NAME=/h --b').includes(
            expected,
          ),
          expected,
        );
      assert.deepEqual(extractPaths("en_US.UTF-8"), []);
      // a non-HOME env var pointing into the other instance's root fails
      assert.equal(
        classOf({ kind: "env", key: "SOME_SETTING", text: `${otherRoot}/x` }),
        "OWNER_PREVIEW_ISOLATION_STRING_OTHER_INSTANCE",
      );
      // an argv --user-data-dir=<other root> fails, so does a quoted path
      assert.equal(
        classOf({ kind: "argv", text: `--user-data-dir=${otherRoot}/profile` }),
        "OWNER_PREVIEW_ISOLATION_STRING_OTHER_INSTANCE",
      );
      assert.equal(
        classOf({ kind: "argv", text: `--config="${otherRoot}/with space/c"` }),
        "OWNER_PREVIEW_ISOLATION_STRING_OTHER_INSTANCE",
      );
      // title-rewritten argv carrying NAME=<path>
      assert.equal(
        classOf({ kind: "argv", text: `Farol HOME=${otherRoot}` }),
        "OWNER_PREVIEW_ISOLATION_STRING_OTHER_INSTANCE",
      );
      // a PATH entry inside the owner home's .codex fails
      assert.equal(
        classOf({
          kind: "env",
          key: "PATH",
          text: `/usr/bin:${home}/.codex/bin`,
        }),
        "OWNER_PREVIEW_ISOLATION_STRING_OWNER",
      );
      // files and sockets are paths
      assert.equal(
        classOf({ kind: "file", text: `${otherRoot}/data` }),
        "OWNER_PREVIEW_ISOLATION_STRING_OTHER_INSTANCE",
      );
      assert.equal(
        classOf({ kind: "socket", text: `${home}/.farol/hub.sock` }),
        "OWNER_PREVIEW_ISOLATION_STRING_OWNER",
      );
      // own and neutral pass
      assert.equal(classOf({ kind: "env", key: "HOME", text: ownRoot }), "own");
      assert.equal(
        classOf({ kind: "argv", text: `--user-data-dir=${ownRoot}/p` }),
        "own",
      );
      for (const text of ["/usr/bin/true", "en_US.UTF-8", "/usr/bin:/bin"])
        assert.equal(classOf({ kind: "env", key: "PATH", text }), "neutral");
      assert.equal(
        classOf({ kind: "file", text: "/private/var/db/analyticsd/x" }),
        "neutral",
      );
      // a sibling that merely shares a prefix with the other root is neutral
      assert.equal(
        classOf({ kind: "env", key: "X", text: `${otherRoot}-sibling/x` }),
        "neutral",
      );
      // counts per kind and class, and the failure text never holds a value
      const mixed = classifyStrings(
        [
          {
            pid: 7,
            role: "backend",
            kind: "env",
            key: "SECRETISH",
            text: `${otherRoot}/token-123`,
          },
          { pid: 7, role: "backend", kind: "env", key: "HOME", text: ownRoot },
          { pid: 7, role: "backend", kind: "argv", text: "/usr/bin/true" },
          { pid: 7, role: "backend", kind: "file", text: `${otherRoot}/f` },
        ],
        context,
      );
      assert.deepEqual(mixed.counts, {
        env: { own: 1, other_instance: 1, owner: 0, neutral: 0 },
        argv: { own: 0, other_instance: 0, owner: 0, neutral: 1 },
        file: { own: 0, other_instance: 1, owner: 0, neutral: 0 },
      });
      const [envViolation, fileViolation] = mixed.violations;
      assert.equal(
        violationMessage(envViolation),
        "OWNER_PREVIEW_ISOLATION_STRING_OTHER_INSTANCE:env:backend:7:SECRETISH",
      );
      assert.equal(violationMessage(envViolation).includes("token-123"), false);
      assert.equal(
        violationMessage(fileViolation),
        `OWNER_PREVIEW_ISOLATION_STRING_OTHER_INSTANCE:file:backend:7:${otherRoot}/f`,
      );
    }
    // Receipts hold verdicts, never environment values. A fake process whose
    // HOME is under an owner location fails the isolation check, and neither the
    // record nor a receipt that carries it holds that path or the owner home.
    {
      const ownRoot = path.join(sandbox, "receipt-own");
      const otherRoot = path.join(sandbox, "receipt-other");
      await fs.mkdir(ownRoot);
      await fs.mkdir(otherRoot);
      const instance = { home: ownRoot, app: path.join(ownRoot, "App.app") };
      const other = { home: otherRoot, app: path.join(otherRoot, "App.app") };
      const identity = {
        userData: path.join(ownRoot, "profile"),
        runtimeIdentity: "farol-selfcheck-runtime",
      };
      const context = classificationContext(instance, other);
      const ownerHome = path.join(home, ".codex", "fake-home-4242");
      const proof = "0b1c2d3e-aaaa-bbbb-cccc-1234567890ab";
      const environment = {
        HOME: ownerHome,
        FAROL_NEXT_E2E_TEST_PROOF: proof,
        LANG: "en_US.UTF-8",
        FAROL_NEXT_PREVIEW_SCENARIO: "normal",
      };
      const record = environmentRecord(environment, {
        instance,
        other,
        identity,
        context,
      });
      assert.equal(record.homeClass, "owner");
      assert.equal(record.homeInsideOwnRoot, false);
      const text = JSON.stringify(record);
      for (const forbidden of [ownerHome, home, proof, "en_US.UTF-8"])
        assert.equal(text.includes(forbidden), false, forbidden);
      assert.throws(
        () =>
          assertProcessEnvironment({
            pid: 4242,
            role: "helper",
            environment: record,
          }),
        /HOME_OUTSIDE_INSTANCE_ROOT:helper:4242/u,
      );
      const classified = classifyStrings(
        Object.entries(environment).map(([key, value]) => ({
          pid: 4242,
          role: "helper",
          kind: "env",
          key,
          text: value,
        })),
        context,
      );
      assert.equal(classified.violations.length, 1);
      assert.equal(JSON.stringify(classified).includes(ownerHome), false);
      const carrying = {
        status: "UNKNOWN",
        observations: {
          normal: {
            processes: [{ pid: 4242, role: "helper", environment: record }],
            classification: classified,
          },
        },
        launches: [{ kind: "normal", home: ownRoot }],
      };
      const guard = {
        envValues: new Set(Object.values(environment)),
        roots: new Set([ownRoot]),
        repositoryRoot: "/nonexistent-checkout",
      };
      // The receipt as the run builds it passes the guard unchanged: no raw
      // value, the disposable root allowed, a short enumeration like `normal`
      // not mistaken for a secret.
      const clean = guardReceipt(carrying, guard);
      assert.deepEqual(clean.violations, []);
      assert.deepEqual(clean.receipt, carrying);
      // A value the run declared in a launch environment (the Preview kind is
      // 13 characters) is public: the same receipt passes with it declared and
      // is a finding without; a proof is never declared and always a finding.
      const kinded = { launches: [{ kind: "owner-preview" }], proof };
      const observed = new Set([...guard.envValues, "owner-preview"]);
      assert.deepEqual(
        guardReceipt(kinded, {
          ...guard,
          envValues: observed,
          declared: new Set(["owner-preview"]),
        }).violations.map((entry) => `${entry.code}@${entry.pointer}`),
        ["ENV_VALUE@/proof"],
      );
      assert.deepEqual(
        guardReceipt(kinded, { ...guard, envValues: observed }).violations.map(
          (entry) => `${entry.code}@${entry.pointer}`,
        ),
        ["ENV_VALUE@/launches/0/kind", "ENV_VALUE@/proof"],
      );
      // A receipt that did carry a value, a proof, an owner path or the home is
      // scrubbed, reported by pointer and code, and the text holds none of them.
      const leaky = {
        leak: ownerHome,
        proof,
        nested: { message: `FAIL:${home}/.farol/state/x and ${ownRoot}/ok` },
        under: `${home}/Documents/x`,
        fine: `${ownRoot}/data`,
      };
      const scrubbed = guardReceipt(leaky, guard);
      assert.deepEqual(
        scrubbed.violations.map((entry) => `${entry.code}@${entry.pointer}`),
        [
          "ENV_VALUE@/leak",
          "ENV_VALUE@/proof",
          "OWNER_LOCATION@/nested/message",
          "OWNER_HOME_PATH@/under",
        ],
      );
      const written = JSON.stringify(scrubbed.receipt);
      for (const forbidden of [ownerHome, proof, `${home}/`])
        assert.equal(written.includes(forbidden), false, forbidden);
      assert.equal(
        scrubbed.receipt.nested.message.startsWith("FAIL:[REDACTED_PATH]"),
        true,
      );
      assert.equal(scrubbed.receipt.fine, `${ownRoot}/data`);
    }
    // With the real guard roots back, a normal temporary parent still works and
    // creates exactly one root.
    let normalCreated = 0;
    const normalSpy = async (stem) => {
      normalCreated += 1;
      return `${stem}fake`;
    };
    assert.equal(
      await mkdtempIn(sandbox, "x-", normalSpy),
      path.join(sandbox, "x-fake"),
    );
    assert.equal(normalCreated, 1);
    assert.equal(ownerConflict(os.tmpdir()), null);
    assert.equal(ownerConflict(sandbox), null);
    const link = path.join(sandbox, "link-to-a");
    await fs.symlink(a, link);
    assert.equal(inside(`${a}/../instance-b`, a), false);
    assert.equal(inside(`${a}/../instance-b`, b), true);
    assert.equal(inside(`${a}/../../elsewhere`, a), false);
    assert.equal(inside(a2, a), false);
    assert.equal(inside(`${a2}/x`, a), false);
    assert.equal(inside(`${a}/`, a), true);
    assert.equal(inside(a, `${a}/`), true);
    await fs.mkdir(path.join(a, "c"));
    assert.equal(inside(`${a}/c/../d`, a), true);
    assert.equal(inside(`${a}/not-created-yet/x`, a), true);
    assert.equal(inside(`${link}/x`, a), true);
    assert.equal(inside(a, link), true);
    assert.equal(inside(b, link), false);
    assert.equal(inside(`${link}/../instance-b`, a), false);
    // `..` follows a symlink's target, never the link's own parent: with
    // alias -> <owner home>/Library, `alias/../.codex` is the owner's ~/.codex,
    // not a sibling of alias.
    const ownerAlias = path.join(sandbox, "alias-to-owner-library");
    await fs.symlink(path.join(home, "Library"), ownerAlias);
    assert.equal(touchesOwner(`${ownerAlias}/../.codex/config.toml`), true);
    assert.equal(touchesOwner(`${ownerAlias}/../.farol`), true);
    assert.equal(
      touchesOwner(`${sandbox}/instance-a/../.codex/config.toml`),
      false,
    );
    // symlink then `..` into the other instance's root.
    const deep = path.join(b, "deep");
    await fs.mkdir(deep);
    const otherAlias = path.join(a, "alias-into-b");
    await fs.symlink(deep, otherAlias);
    assert.equal(inside(`${otherAlias}/../x`, b), true);
    assert.equal(inside(`${otherAlias}/../x`, a), false);
    assert.equal(inside(`${otherAlias}/../../instance-a/y`, a), true);
    assert.equal(inside(`${otherAlias}/..`, b), true);
    // A relative symlink is followed from the directory that holds it.
    const relative = path.join(a, "relative-to-b");
    await fs.symlink("../instance-b", relative);
    assert.equal(inside(`${relative}/deep/z`, b), true);
    assert.equal(inside(`${relative}/deep/z`, a), false);
    // Past a missing component the rest is literal, and a `..` there fails closed.
    assert.throws(
      () => inside(`${a}/missing/../x`, a),
      /OWNER_PREVIEW_ISOLATION_PATH_UNRESOLVABLE:DOTDOT_AFTER_MISSING/u,
    );
    assert.throws(
      () => touchesOwner(`${ownerAlias}/missing/../.codex`),
      /PATH_UNRESOLVABLE/u,
    );
    // A kernel-reported path under a directory that cannot be traversed is
    // taken literally; an unreported one, or one with `..`, fails closed.
    const sealed = path.join(a, "sealed");
    await fs.mkdir(sealed, { mode: 0o000 });
    try {
      assert.equal(inside(`${sealed}/file`, a, true), true);
      assert.equal(inside(`${sealed}/file`, b, true), false);
      assert.throws(() => inside(`${sealed}/file`, a), /EACCES/u);
      assert.throws(
        () => inside(`${sealed}/file/../x`, a, true),
        /DOTDOT_AFTER_MISSING/u,
      );
    } finally {
      await fs.chmod(sealed, 0o700);
    }
    const loop = path.join(a, "loop");
    await fs.symlink(loop, loop);
    assert.throws(() => inside(`${loop}/x`, a), /SYMLINK_LOOP/u);
    assert.equal(
      touchesOwner(
        `${a}/${"../".repeat(40)}${home.slice(1)}/.codex/config.toml`,
      ),
      true,
    );
    assert.equal(touchesOwner(`${a}/../instance-b/file`), false);
  } finally {
    await fs.rm(sandbox, { recursive: true });
  }
  // Listener rule: only TCP LISTEN on 127.0.0.1 qualifies.
  const socket = (fields) =>
    ["p1", "f5", ...fields.map((field) => field)].join("\n") + "\n";
  const report = (fields) => listenerReport(parseLsof(socket(fields)));
  const good = report(["tIPv4", "PTCP", "n127.0.0.1:8080", "TST=LISTEN"]);
  assert.deepEqual(good.violations, []);
  assert.deepEqual(good.connections, []);
  assert.deepEqual(good.accepted, [
    { pid: 1, protocol: "TCP", host: "127.0.0.1", port: 8080 },
  ]);
  const rejected = {
    UDP_SOCKET: ["tIPv4", "PUDP", "n127.0.0.1:5353"],
    IPV6_LISTENER: ["tIPv6", "PTCP", "n[::1]:80", "TST=LISTEN"],
    WILDCARD_LISTENER: ["tIPv4", "PTCP", "n*:8080", "TST=LISTEN"],
    HOSTNAME_LISTENER: ["tIPv4", "PTCP", "nlocalhost:80", "TST=LISTEN"],
    NON_LOOPBACK_ADDRESS: ["tIPv4", "PTCP", "n0.0.0.0:80", "TST=LISTEN"],
    UNPARSABLE_LISTENER: ["tIPv4", "PTCP", "ngarbage", "TST=LISTEN"],
    // Every TCP record needs a recognised state, whatever its address.
    MISSING_TCP_STATE: ["tIPv4", "PTCP", "n127.0.0.1:8080"],
    UNKNOWN_TCP_STATE: ["tIPv4", "PTCP", "n127.0.0.1:8080", "TST=WEIRD"],
    NON_LOOPBACK_PEER: [
      "tIPv4",
      "PTCP",
      "n127.0.0.1:1->93.184.216.34:443",
      "TST=ESTABLISHED",
    ],
    UNPARSABLE_SOCKET: ["tIPv4", "PTCP", "ngarbage", "TST=ESTABLISHED"],
  };
  for (const [code, fields] of Object.entries(rejected)) {
    const answer = report(fields);
    assert.deepEqual(answer.accepted, [], code);
    assert.deepEqual(
      answer.violations.map((entry) => entry.code),
      [code],
    );
  }
  // A wildcard address with no state is a missing state, not an accepted line.
  assert.deepEqual(
    report(["tIPv4", "PTCP", "n*:8080"]).violations.map((entry) => entry.code),
    ["MISSING_TCP_STATE"],
  );
  assert.deepEqual(
    report(["tIPv4", "PTCP", "n*:8080", "TST=WEIRD"]).violations.map(
      (entry) => entry.code,
    ),
    ["UNKNOWN_TCP_STATE"],
  );
  // Recognised non-listening states are connections with a loopback peer, not
  // listeners and not violations; a state without a peer needs no arrow.
  for (const state of [
    "ESTABLISHED",
    "CLOSE_WAIT",
    "TIME_WAIT",
    "SYN_SENT",
    "FIN_WAIT_1",
    "FIN_WAIT_2",
    "CLOSING",
    "LAST_ACK",
    "SYN_RCDV",
  ]) {
    const answer = report([
      "tIPv4",
      "PTCP",
      "n127.0.0.1:1->127.0.0.1:2",
      `TST=${state}`,
    ]);
    assert.deepEqual(answer.violations, [], state);
    assert.deepEqual(answer.accepted, [], state);
    assert.deepEqual(answer.connections, [{ pid: 1, state, remotePort: 2 }]);
  }
  assert.deepEqual(
    report(["tIPv4", "PTCP", "n*:80", "TST=BOUND"]).connections,
    [{ pid: 1, state: "BOUND", remotePort: null }],
  );
  assert.deepEqual(report(["tunix", "n/tmp/x"]), {
    accepted: [],
    connections: [],
    violations: [],
  });
  // Every inventory runs through runInventory: success is exit 0 with empty
  // stderr; the only accepted failure is the command's documented no-match.
  const shell = (tool, script) => ({
    ...INVENTORY[tool],
    command: "/bin/sh",
    args: ["-c", script],
  });
  const run = (tool, script, context) =>
    runInventory(shell(tool, script), ["-c", script], context);
  const refused = (tool, script, context) =>
    assert.rejects(
      run(tool, script, context),
      new RegExp(
        `^Error: OWNER_PREVIEW_ISOLATION_INVENTORY_ERROR:${tool}:`,
        "u",
      ),
      `${tool}: ${script}`,
    );
  const gone = { gone: () => true };
  const live = { gone: () => false };
  for (const tool of ["pgrep", "lsof", "ps", "probe"]) {
    assert.deepEqual(await run(tool, "echo 123", live), {
      outcome: "ok",
      stdout: "123\n",
    });
    await refused(tool, "echo w >&2", live);
    await refused(tool, "exit 2", gone);
    await refused(tool, "echo 123; exit 1", gone);
    await refused(tool, "echo w >&2; exit 1", gone);
    await refused(tool, "echo 123; echo w >&2; exit 1", gone);
    await refused(tool, "echo 123; echo w >&2", gone);
  }
  assert.deepEqual(await run("pgrep", "exit 1"), { outcome: "no_match" });
  for (const tool of ["lsof", "ps"]) {
    assert.deepEqual(await run(tool, "exit 1", gone), { outcome: "no_match" });
    await refused(tool, "exit 1", live);
    await refused(tool, "exit 1", {});
  }
  await refused("probe", "exit 1", gone);
  // lsof's verbatim NFS stat() warning is the one tolerated stderr, for a
  // mount clear of the owner and of the disposable roots; it is recorded.
  const warn = (mount, { type = "nfs", assuming = false, tail = "" } = {}) =>
    `printf 'lsof: WARNING: can\\047t stat() ${type} file system %s\\n      Output information may be incomplete.\\n${
      assuming ? '      assuming "dev=31000002" from mount table\\n' : ""
    }${tail}' '${mount}' >&2`;
  const savedExempt = ownerState.exempt;
  const disposable = path.join(os.tmpdir(), "farol-selfcheck-disposable");
  ownerState.exempt = new Set([disposable]);
  partialInventory.lsofMounts.clear();
  try {
    assert.deepEqual(
      await run("lsof", `echo 123; ${warn("/Volumes/selfcheck-nfs")}`, live),
      { outcome: "ok", stdout: "123\n" },
    );
    assert.deepEqual(
      await run(
        "lsof",
        `echo 1; ${warn(`${home}/selfcheck-orb`, { assuming: true })}; ${warn("/Volumes/selfcheck-two")}`,
        live,
      ),
      { outcome: "ok", stdout: "1\n" },
    );
    assert.deepEqual(
      await run("lsof", `${warn("/Volumes/selfcheck-nfs")}; exit 1`, gone),
      { outcome: "no_match" },
    );
    await refused("lsof", `${warn("/Volumes/selfcheck-nfs")}; exit 1`, live);
    assert.deepEqual([...partialInventory.lsofMounts].sort(), [
      "/Volumes/selfcheck-nfs",
      "/Volumes/selfcheck-two",
      "~/selfcheck-orb",
    ]);
    partialInventory.lsofMounts.clear();
    for (const script of [
      warn("/Volumes/selfcheck-smb", { type: "smbfs" }),
      warn("/Volumes/selfcheck-nfs", { tail: "extra\\n" }),
      `${warn("/Volumes/selfcheck-nfs")}; echo other >&2`,
      `echo lsof: WARNING: something else >&2`,
    ])
      await refused("lsof", `echo 1; ${script}`, live);
    for (const tool of ["pgrep", "ps", "probe"])
      await refused(tool, `echo 1; ${warn("/Volumes/selfcheck-nfs")}`, live);
    const unsafe = (mount, code) =>
      assert.rejects(
        run("lsof", `echo 1; ${warn(mount)}`, live),
        new RegExp(`PARTIAL_MOUNT_UNSAFE:lsof:${code}$`, "u"),
        mount,
      );
    await unsafe(home, "CONTAINS_OWNER_HOME");
    await unsafe("/Users", "CONTAINS_OWNER_HOME");
    await unsafe(path.join(home, ".codex/mnt"), "OWNER_LOCATION");
    await unsafe(
      path.join(home, "Library/Application Support/FarolMount"),
      "OWNER_LOCATION",
    );
    await unsafe(path.join(home, "Library"), "OWNER_LOCATION");
    await unsafe(path.join(disposable, "mnt"), "DISPOSABLE_ROOT");
    await unsafe(os.tmpdir(), "DISPOSABLE_ROOT");
    await unsafe("/Volumes/selfcheck-nfs/", "MOUNT_PATH_INVALID");
    await unsafe("/Volumes//selfcheck-nfs", "MOUNT_PATH_INVALID");
    await unsafe("/Volumes/x/../selfcheck-nfs", "MOUNT_PATH_INVALID");
    // An unsafe mount records nothing, not even the safe one beside it.
    await assert.rejects(
      run(
        "lsof",
        `echo 1; ${warn("/Volumes/selfcheck-nfs")}; ${warn(home)}`,
        live,
      ),
      /PARTIAL_MOUNT_UNSAFE/u,
    );
    assert.equal(partialInventory.lsofMounts.size, 0);
  } finally {
    ownerState.exempt = savedExempt;
    partialInventory.lsofMounts.clear();
  }
  await assert.rejects(
    runInventory({ ...INVENTORY.pgrep, command: "/nonexistent/inventory" }, []),
    /INVENTORY_ERROR:pgrep:ENOENT/u,
  );
  const environment = await environmentOf(process.pid);
  assert.ok(environment !== null && Object.keys(environment).length > 0);
  // A raw exec environment the reader cannot map one-to-one is refused. The
  // exec target is this Node, not a platform binary, whose environment macOS
  // would withhold from the reader.
  const node = JSON.stringify(process.execPath);
  for (const [entries, reason] of [
    [["HOME=/tmp/own", "HOME=/tmp/other"], "env-duplicate"],
    [["HOME=/tmp/own", "LOOSE"], "env-entry"],
  ]) {
    const code = [
      "import ctypes",
      "libc = ctypes.CDLL(None)",
      `argv = (ctypes.c_char_p * 4)(b${node}, b"-e", b"setTimeout(() => {}, 2000)", None)`,
      `entries = [${entries.map((entry) => `b"${entry}"`).join(", ")}, None]`,
      "envp = (ctypes.c_char_p * len(entries))(*entries)",
      `libc.execve(b${node}, argv, envp)`,
    ].join("\n");
    const child = execFile("/usr/bin/python3", ["-I", "-c", code]);
    let refused = null;
    let accepted = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const read = await readProcess(child.pid);
        if (read?.exe === process.execPath) accepted = true;
      } catch (error) {
        refused = error;
      }
      if (refused !== null || accepted) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(accepted, false, `raw environment accepted: ${reason}`);
    assert.match(
      refused?.message ?? "",
      new RegExp(
        `^OWNER_PREVIEW_ISOLATION_ENV_UNREADABLE:${child.pid}:${reason}$`,
        "u",
      ),
    );
    if (child.exitCode === null && child.signalCode === null)
      await once(child, "exit");
  }
  const inventory = await openFiles(process.pid);
  assert.equal(inventory.outcome, "listed");
  assert.ok(inventory.files.length > 0);
  const finished = execFile("/usr/bin/true");
  await once(finished, "exit");
  assert.equal(isGone(finished.pid), true);
  assert.equal(await command(finished.pid), null);
  assert.equal(await environmentOf(finished.pid), null);
  assert.deepEqual(await openFiles(finished.pid), {
    pid: finished.pid,
    outcome: "exited",
    files: [],
  });
  // The real tools' documented no-match answers.
  assert.deepEqual(
    await runInventory("pgrep", ["-P", String(finished.pid), "-f", "."]),
    { outcome: "no_match" },
  );
  assert.deepEqual(
    await runInventory("ps", ["-o", "command=", "-p", String(finished.pid)], {
      gone: () => isGone(finished.pid),
    }),
    { outcome: "no_match" },
  );
  assert.deepEqual(
    await runInventory(
      "lsof",
      ["-nP", "-a", "-p", String(finished.pid), "-F", "pftPnT"],
      { gone: () => isGone(finished.pid) },
    ),
    { outcome: "no_match" },
  );
  await treeSelfCheck();
  await quitSelfCheck();
}

// A process tree is a moving snapshot: stability, the union of pids ever seen
// and teardown verification are checked on a fake tree.
async function treeSelfCheck() {
  // A listing that omits a known member that is still alive is incomplete.
  const grown = {
    kind: "selfcheck",
    pid: 1,
    seen: new Set(),
    known: new Set([1, 2]),
  };
  assert.deepEqual(
    await scanTree(grown, { scan: async () => [1, 2], alive: () => true }),
    [1, 2],
  );
  await assert.rejects(
    scanTree(grown, { scan: async () => [1], alive: () => true }),
    /TREE_INCOMPLETE:selfcheck:2/u,
  );
  assert.deepEqual(
    await scanTree(grown, { scan: async () => [1], alive: (pid) => pid === 1 }),
    [1],
  );
  const sequence = (...snapshots) => {
    const seen = new Set();
    let index = 0;
    const scan = async () => {
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      for (const pid of snapshot) seen.add(pid);
      return snapshot;
    };
    return { scan, seen, scans: () => index };
  };
  // A helper that appears after the first snapshot: the tree is only accepted
  // once two consecutive snapshots agree, and the late pid is in `seen`.
  const late = sequence([1, 2], [1, 2, 3], [1, 2, 3]);
  assert.deepEqual(await stableTree(late.scan, { interval: 1 }), [1, 2, 3]);
  assert.equal(late.scans(), 3);
  // A helper that appears and goes again stays in the union.
  const flicker = sequence([1, 2], [1, 2, 3], [1, 2], [1, 2]);
  assert.deepEqual(await stableTree(flicker.scan, { interval: 1 }), [1, 2]);
  assert.deepEqual([...flicker.seen].sort(), [1, 2, 3]);
  // A tree that never settles fails with a named code within the bound.
  let counter = 0;
  await assert.rejects(
    stableTree(async () => [1, (counter += 1)], {
      interval: 1,
      maxScans: 5,
      label: "x",
    }),
    /OWNER_PREVIEW_ISOLATION_TREE_UNSTABLE:x/u,
  );
  assert.equal(counter, 5);
  // Teardown: every pid ever seen gone, nothing new below the parent.
  const instance = (...pids) => ({
    kind: "selfcheck",
    pid: 1,
    home: "/h",
    seen: new Set(pids),
  });
  const fast = { tries: 2, interval: 1 };
  const clean = {
    alive: () => false,
    rescan: async () => [1],
    listPids: async () => [],
    inspect: async () => [],
    ...fast,
  };
  const reasons = async (target, deps) =>
    (await tearDownReport(target, deps)).survivors.map(
      (entry) => `${entry.pid}:${entry.reason}`,
    );
  assert.equal((await tearDownReport(instance(1, 2, 3), clean)).verified, true);
  assert.deepEqual(
    await reasons(instance(1, 2, 3), { ...clean, alive: (pid) => pid === 3 }),
    ["3:PID_REMAINS"],
  );
  assert.deepEqual(
    await reasons(instance(1, 2), { ...clean, rescan: async () => [1, 9] }),
    ["9:NEW_DESCENDANT"],
  );
  // A launched tree whose helper outlives its parent is reported: every tree
  // the test starts is a teardown target like an instance.
  const extra = {
    kind: "extra",
    pid: 20,
    home: "/extra-root",
    seen: new Set([20, 21]),
  };
  assert.deepEqual(
    await reasons(extra, {
      ...clean,
      alive: (pid) => pid === 21,
      rescan: async () => [20],
    }),
    ["21:PID_REMAINS"],
  );
  // An inventory failure is an unverified teardown, not a pass.
  const broken = await tearDownReport(instance(1), {
    ...clean,
    rescan: async () => {
      throw new Error("OWNER_PREVIEW_ISOLATION_INVENTORY_ERROR:pgrep:2:x");
    },
  });
  assert.equal(broken.verified, false);
  assert.match(broken.error, /INVENTORY_ERROR:pgrep/u);
  // Orphan rule, decided on argv and environment together. A reparented helper
  // whose root is only in its environment is found; a process that existed
  // before the run is never inspected; an unreadable one is unverifiable; a
  // vanished one is ignored. A new process whose environment is withheld is
  // unverifiable only if no system or application binary owns it and its parent
  // chain reaches no pre-existing process other than launchd and this test.
  const roots = new Set(["/root-a", "/root-b"]);
  const inspected = [];
  const table = {
    // pid: [ppid, scanner answer]
    11: [1, { status: "match", roots: ["/root-a"], envVisible: true }],
    12: [1, { status: "clear", envVisible: true, systemOwned: false }],
    13: [1, { status: "unreadable", errno: 22 }],
    14: [1, { status: "gone", errno: 3 }],
    // withheld environment, reparented orphan (ppid 1): unverifiable
    15: [
      1,
      {
        status: "clear",
        envVisible: false,
        systemOwned: false,
        exe: "/x/orphan",
      },
    ],
    // withheld environment under a pre-existing, non-launchd parent: excluded
    16: [
      9,
      {
        status: "clear",
        envVisible: false,
        systemOwned: false,
        exe: "/x/other",
      },
    ],
    // ... through a chain of new processes that ends at that parent: excluded
    17: [
      16,
      {
        status: "clear",
        envVisible: false,
        systemOwned: false,
        exe: "/x/other2",
      },
    ],
    // withheld environment owned by a system binary: excluded
    18: [1, { status: "clear", envVisible: false, systemOwned: true }],
    // withheld environment under this test process: still unverifiable
    19: [
      77,
      {
        status: "clear",
        envVisible: false,
        systemOwned: false,
        exe: "/x/ours",
      },
    ],
    // withheld environment whose parent has vanished: unverifiable
    20: [
      4242,
      {
        status: "clear",
        envVisible: false,
        systemOwned: false,
        exe: "/x/lost",
      },
    ],
    // a binary outside the checkout and the roots (an app opened from the
    // Dock meanwhile): argv only, its environment never read, only counted
    21: [
      1,
      {
        status: "clear",
        envVisible: false,
        envRead: false,
        systemOwned: false,
      },
    ],
    // pre-existing, never inspected
    10: [1, { status: "match", roots: ["/root-a"], envVisible: true }],
    9: [1, { status: "clear", envVisible: true, systemOwned: false }],
    77: [9, { status: "clear", envVisible: true, systemOwned: false }],
  };
  const scanDeps = {
    ...clean,
    ours: new Set([77]),
    listPids: async () =>
      Object.entries(table).map(([pid, [ppid]]) => ({
        pid: Number(pid),
        ppid,
      })),
    scopes: ["/checkout"],
    inspect: async (pids, scanned, scopes) => {
      inspected.push(...pids);
      assert.deepEqual(scanned, ["/root-a", "/root-b"]);
      assert.deepEqual(scopes, ["/root-a", "/root-b", "/checkout"]);
      return pids.map((pid) => ({ pid, ...table[pid][1] }));
    },
  };
  const preexisting = new Set([9, 10, 77]);
  const orphan = await orphanReport(roots, preexisting, scanDeps);
  // Ancestry first: pre-existing processes and new ones under a pre-existing
  // parent (16 directly, 17 through 16) are never passed to the argv/env reader.
  for (const never of [9, 10, 77, 16, 17])
    assert.equal(inspected.includes(never), false, `inspected ${never}`);
  assert.deepEqual(
    [...new Set(inspected)].sort((x, y) => x - y),
    [11, 12, 13, 14, 15, 18, 19, 20, 21],
  );
  assert.equal(orphan.inspected, 9);
  assert.deepEqual(orphan.matches, [{ pid: 11, roots: ["/root-a"] }]);
  assert.deepEqual(
    orphan.unverifiable.map((entry) => `${entry.pid}:${entry.reason}`),
    ["13:UNREADABLE", "15:ENV_WITHHELD", "19:ENV_WITHHELD", "20:ENV_WITHHELD"],
  );
  assert.deepEqual(orphan.excluded, {
    systemOwned: 1,
    otherParent: 2,
    foreignExecutable: 1,
  });
  assert.equal(orphan.clear, 1);
  assert.equal(orphan.gone, 1);
  assert.equal(orphan.scanned, 11);
  assert.equal(orphan.startSnapshot, 3);
  // Excluded processes are only counted: no pid or path of theirs is recorded.
  assert.equal(JSON.stringify(orphan).includes("/x/other"), false);
  const scanned = await verifyTeardown([instance(1)], {
    ...scanDeps,
    roots,
    preexisting,
  });
  assert.equal(scanned.verified, false);
  assert.deepEqual(
    scanned.survivors.map(
      (entry) => `${entry.kind}:${entry.pid}:${entry.reason}`,
    ),
    [
      "orphan:11:ORPHAN_REMAINS",
      "scan:13:UNREADABLE",
      "scan:15:ENV_WITHHELD",
      "scan:19:ENV_WITHHELD",
      "scan:20:ENV_WITHHELD",
    ],
  );
  // Without the survivor, the unreadable and the orphan, the same machine is
  // clean: everything left is excluded, clear or gone.
  const quiet = await orphanReport(roots, preexisting, {
    ...scanDeps,
    listPids: async () =>
      [9, 10, 12, 14, 16, 17, 18, 21, 77].map((pid) => ({
        pid,
        ppid: table[pid][0],
      })),
  });
  assert.deepEqual([quiet.matches, quiet.unverifiable], [[], []]);
  assert.deepEqual(quiet.excluded, {
    systemOwned: 1,
    otherParent: 2,
    foreignExecutable: 1,
  });
  // No roots means nothing to find and no scan at all.
  assert.deepEqual(
    await orphanReport(new Set(), new Set(), {
      listPids: async () => assert.fail("scanned without roots"),
    }),
    {
      startSnapshot: 0,
      scanned: 0,
      inspected: 0,
      matches: [],
      unverifiable: [],
      excluded: { systemOwned: 0, otherParent: 0, foreignExecutable: 0 },
      clear: 0,
      gone: 0,
    },
  );
  // An orphan-inventory failure is an unverified teardown with an error, not a
  // throw; settleRun then still closes the server and writes the receipt as
  // UNKNOWN, with the original failure as the reported error.
  const exploding = await verifyTeardown([instance(1)], {
    ...clean,
    roots,
    preexisting,
    listPids: async () => {
      throw new Error("OWNER_PREVIEW_ISOLATION_INVENTORY_ERROR:ps-uid:1:boom");
    },
  });
  assert.equal(exploding.verified, false);
  assert.match(exploding.error, /INVENTORY_ERROR:ps-uid/u);
  for (const original of [new Error("ORIGINAL"), null]) {
    const calls = [];
    const written = { status: "UNKNOWN" };
    await settleRun({
      receipt: written,
      failure: original,
      verify: async () => {
        throw new Error("OWNER_PREVIEW_ISOLATION_INVENTORY_ERROR:pgrep:2:x");
      },
      closeServer: async () => calls.push("server-closed"),
      checkpoint: async () => calls.push("checkpoint"),
    });
    assert.deepEqual(calls, ["server-closed", "checkpoint"]);
    assert.equal(written.status, "UNKNOWN");
    assert.equal(written.teardown.verified, false);
    assert.match(written.teardown.error, /INVENTORY_ERROR:pgrep/u);
    assert.equal(
      written.error,
      original === null
        ? "OWNER_PREVIEW_ISOLATION_TEARDOWN_ERROR:OWNER_PREVIEW_ISOLATION_INVENTORY_ERROR:pgrep:2:x"
        : "ORIGINAL",
    );
  }
  // A server that will not close is recorded and does not stop the receipt.
  const stuckServer = { status: "UNKNOWN" };
  let checkpointed = false;
  await settleRun({
    receipt: stuckServer,
    failure: null,
    verify: async () => ({ verified: true, survivors: [], instances: [] }),
    closeServer: async () => {
      throw new Error("close failed");
    },
    checkpoint: async () => {
      checkpointed = true;
    },
  });
  assert.equal(checkpointed, true);
  assert.equal(stuckServer.status, "UNKNOWN");
  assert.match(stuckServer.error, /TEARDOWN_ERROR:close failed/u);
  // The real scanner on real processes: a child whose root sits only in its
  // environment is found, one without it is clear, a vanished pid is gone, and
  // another process's environment never comes back.
  const rootText = `/farol-selfcheck-root-${randomUUID()}`;
  // Each idle child lives until this test closes its stdin, not for a fixed
  // time: a loaded machine cannot let it exit before the last inspection, and
  // ending it needs no signal.
  const spawnIdle = (environment) =>
    spawn(
      process.execPath,
      [
        "-e",
        'process.stdin.on("end", () => process.exit(0)); process.stdin.resume()',
      ],
      { env: environment, stdio: ["pipe", "ignore", "ignore"] },
    );
  const withRoot = spawnIdle({ HOME: rootText });
  const without = spawnIdle({ HOME: "/somewhere/else" });
  const gone = spawn("/usr/bin/true");
  await once(gone, "exit");
  try {
    const found = await inspectProcesses(
      [withRoot.pid, without.pid, gone.pid],
      [rootText],
      [path.dirname(process.execPath)],
    );
    const foreign = await inspectProcesses(
      [withRoot.pid],
      [rootText],
      ["/farol-selfcheck-no-such-scope"],
    );
    assert.deepEqual(
      foreign.map(({ status, roots, envVisible, envRead }) => ({
        status,
        roots,
        envVisible,
        envRead,
      })),
      [{ status: "clear", roots: [], envVisible: false, envRead: false }],
    );
    const pick = ({ pid, status, roots, envVisible, systemOwned }) => ({
      pid,
      status,
      roots,
      envVisible,
      owned: typeof systemOwned,
    });
    assert.deepEqual(found.slice(0, 2).map(pick), [
      {
        pid: withRoot.pid,
        status: "match",
        roots: [rootText],
        envVisible: true,
        owned: "boolean",
      },
      {
        pid: without.pid,
        status: "clear",
        roots: [],
        envVisible: true,
        owned: "boolean",
      },
    ]);
    assert.deepEqual(found[2], {
      pid: gone.pid,
      status: "gone",
      errno: found[2].errno,
    });
  } finally {
    await Promise.all(
      [withRoot, without].map((child) => {
        if (child.exitCode !== null || child.signalCode !== null) return null;
        const exited = once(child, "exit");
        child.stdin.end();
        return exited;
      }),
    );
  }
  // A failing run that leaves one survivor: the receipt lists it, the status
  // stays UNKNOWN, and the original failure stays the reported error.
  const failing = {
    status: "UNKNOWN",
    launches: [{ kind: "normal", home: "/h" }],
  };
  const failed = await verifyTeardown([instance(1, 2, 3)], {
    ...clean,
    alive: (pid) => pid === 3,
  });
  concludeReceipt(failing, new Error("BOOM"), failed);
  assert.equal(failing.status, "UNKNOWN");
  assert.equal(failing.error, "BOOM");
  assert.equal(failing.teardown.verified, false);
  assert.deepEqual(failing.teardown.survivors, [
    { kind: "selfcheck", pid: 3, reason: "PID_REMAINS" },
  ]);
  // A successful run with a survivor is not a pass either.
  const leaked = { status: "UNKNOWN" };
  concludeReceipt(leaked, null, failed);
  assert.equal(leaked.status, "UNKNOWN");
  assert.match(leaked.error, /TEARDOWN_UNVERIFIED:selfcheck:3:PID_REMAINS/u);
  // Only a clean run with a verified teardown passes.
  const passing = { status: "UNKNOWN" };
  concludeReceipt(passing, null, await verifyTeardown([instance(1, 2)], clean));
  assert.equal(passing.status, "PASS");
  assert.equal(passing.teardown.verified, true);
  // Passed with a blocked dimension is not a plain PASS: PASS_WITH_BLOCKED names
  // what was not observed. With nothing blocked it is PASS; a failure or an
  // unverified teardown stays UNKNOWN whatever is blocked.
  const blockedRow = {
    dimension: "override-free-resolution",
    status: "not_observed",
    code: "NATIVE_APPDATA_IGNORES_HOME",
  };
  const verifiedTeardown = await verifyTeardown([instance(1, 2)], clean);
  const withBlocked = { status: "UNKNOWN", blocked: [blockedRow] };
  concludeReceipt(withBlocked, null, verifiedTeardown);
  assert.equal(withBlocked.status, "PASS_WITH_BLOCKED");
  assert.deepEqual(withBlocked.blockedDimensions, [
    "NATIVE_APPDATA_IGNORES_HOME",
  ]);
  assert.match(withBlocked.statusNote, /Only the exercised subset passed/u);
  const nothingBlocked = { status: "UNKNOWN", blocked: [] };
  concludeReceipt(nothingBlocked, null, verifiedTeardown);
  assert.equal(nothingBlocked.status, "PASS");
  assert.equal(nothingBlocked.blockedDimensions, undefined);
  const failedBlocked = { status: "UNKNOWN", blocked: [blockedRow] };
  concludeReceipt(failedBlocked, new Error("BOOM"), verifiedTeardown);
  assert.equal(failedBlocked.status, "UNKNOWN");
  assert.equal(failedBlocked.error, "BOOM");
  const leakedBlocked = { status: "UNKNOWN", blocked: [blockedRow] };
  concludeReceipt(leakedBlocked, null, failed);
  assert.equal(leakedBlocked.status, "UNKNOWN");
  // Launch records without an instance still get a target.
  const targets = teardownTargets(
    [{ home: "/a", kind: "normal", pid: 1, seen: new Set([1]) }],
    [
      { kind: "normal", home: "/a" },
      { kind: "owner-preview", home: "/b" },
      { kind: "owner-preview", home: null },
    ],
  );
  assert.deepEqual(
    targets.map((target) => [target.kind, target.home, target.pid]),
    [
      ["normal", "/a", 1],
      ["owner-preview", "/b", null],
    ],
  );
}

// The recorded quit outcome follows the actual terminal state and nothing else.
async function quitSelfCheck() {
  const fake = (exit) => {
    const owned = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
    });
    const instance = {
      kind: "selfcheck",
      owned,
      handle: { evaluate: async () => exit?.(owned) },
      terminal: null,
      seen: new Set(),
      record: {},
      quit: { requested: false, expired: false, promise: null },
    };
    watchExit(instance);
    return instance;
  };
  // Never asked: not_requested, no terminal.
  const idle = fake();
  assert.equal(quitOutcome(idle), "not_requested");
  assert.equal(writeQuit(idle), "not_requested");
  assert.equal(idle.record.terminal, null);
  // A quit that never completes times out; cleanup asking again returns the
  // same outcome and the record says timed_out, not observed.
  const stuck = fake();
  assert.equal(await requestQuit(stuck, 30), "timed_out");
  assert.equal(await requestQuit(stuck, 30), "timed_out");
  assert.equal(stuck.quit.promise, requestQuit(stuck));
  assert.equal(writeQuit(stuck), "timed_out");
  assert.deepEqual(
    [stuck.record.terminal, stuck.record.quitWaitExpired],
    [null, true],
  );
  // A confirmed exit is observed with its code; a double request is the same.
  const clean = fake((owned) => {
    owned.exitCode = 0;
    owned.emit("exit", 0, null);
  });
  const first = requestQuit(clean, 1000);
  const second = requestQuit(clean, 1000);
  assert.equal(first, second);
  assert.equal(await first, "observed");
  assert.equal(writeQuit(clean), "observed");
  assert.deepEqual(clean.record.terminal, { code: 0, signal: null });
  // A signal counts as an observed terminal state, too.
  const killed = fake((owned) => owned.emit("exit", null, "SIGTERM"));
  assert.equal(await requestQuit(killed, 1000), "observed");
  assert.deepEqual(killed.terminal, { code: null, signal: "SIGTERM" });
  // Already exited before any request: observed, and nothing is asked.
  let asked = false;
  const gone = fake();
  gone.owned.exitCode = 1;
  gone.owned.emit("exit", 1, null);
  gone.handle.evaluate = async () => {
    asked = true;
  };
  assert.equal(await requestQuit(gone, 30), "observed");
  assert.equal(asked, false);
  // Requested, not expired, no terminal: unknown. Nothing else is observed.
  const odd = fake();
  odd.quit.requested = true;
  assert.equal(quitOutcome(odd), "unknown");
  // A late exit after a timeout is a fact about the process: the derived
  // record becomes observed while the original request still reports timed_out.
  const late = fake();
  assert.equal(await requestQuit(late, 30), "timed_out");
  late.owned.emit("exit", 0, null);
  assert.equal(writeQuit(late), "observed");
  assert.equal(await requestQuit(late), "timed_out");
}

// Receipt inputs cannot contain observations or a PASS override.
export async function runOwnerPreviewIsolation(
  repositoryRoot,
  generation,
  options = {},
) {
  requireOwnerPreviewRuntimeIntegration();
  setGuardRoots(await loadProtectedRoots(repositoryRoot));
  ownerState.exempt = new Set();
  // The temporary parent is checked before anything at all is created in it.
  const temporary = await fs.realpath(os.tmpdir());
  assertSafeTemporaryParent(temporary);
  await scannerSelfCheck();
  const verified = await verifyOwnerPreview(repositoryRoot, generation);
  const namespace = path.join(repositoryRoot, "_output/preview/isolation");
  await privateDirectory(namespace);
  const evidence = path.join(namespace, generation);
  await privateDirectory(evidence);
  const attempt = randomUUID();
  const receiptFile = path.join(evidence, `${attempt}.json`);
  const receipt = {
    schema: "farol-owner-preview-isolation/1",
    attempt,
    status: "UNKNOWN",
    sourceCommit: verified.manifest.sourceCommit,
    sourceTreeDigest: verified.manifest.sourceTreeDigest,
    generation,
    startedAt: new Date().toISOString(),
    blocked: [],
    launches: [],
    observations: {},
    limits: [
      "disposable roots; no authentication/provider/tunnel",
      "concurrent hidden instances, one normal and one Preview",
      "no installed-state qualification",
    ],
  };
  // Everything this run creates that a survivor could carry: every disposable
  // root, the uid's pids that already existed when the run began, and, for the
  // receipt guard only, every environment value observed (in memory, never
  // written).
  const run = {
    roots: new Set(),
    preexisting: new Set(),
    envValues: new Set(),
    declared: new Set(),
  };
  ownerState.exempt = run.roots;
  partialInventory.lsofMounts.clear();
  // Every write of the receipt goes through the guard. A receipt that holds an
  // observed environment value or an owner path is scrubbed, written with the
  // finding, and the run fails closed.
  const writeReceipt = async (flag) => {
    if (partialInventory.lsofMounts.size > 0)
      receipt.lsofPartialMounts = [...partialInventory.lsofMounts].sort();
    const guarded = guardReceipt(receipt, {
      envValues: run.envValues,
      declared: run.declared,
      roots: run.roots,
      repositoryRoot,
    });
    await fs.writeFile(receiptFile, jsonBytes(guarded.receipt), {
      mode: 0o600,
      ...(flag ? { flag } : {}),
    });
    if (guarded.violations.length > 0)
      throw new Error(
        `OWNER_PREVIEW_ISOLATION_RECEIPT_UNSAFE:${guarded.violations
          .map((entry) => `${entry.code}@${entry.pointer}`)
          .join(",")}`,
      );
  };
  const checkpoint = () => writeReceipt();
  await writeReceipt("wx");
  const instances = [];
  let server;
  let failure = null;
  try {
    run.preexisting = new Set((await uidPids()).map((entry) => entry.pid));
    // 1. Override-free resolution is not witnessed. A bundled Electron resolves
    // its native appData to the account's real Application Support whatever HOME
    // it is started with (measured 2026-10-21, see docs/development/owner-
    // preview.md), so a launch without the E2E override would select the owner's
    // real profile. Nothing here launches that way or measures it again; the row
    // stays in the receipt so it is not silently dropped.
    receipt.blocked.push({
      dimension: "override-free-resolution",
      status: "not_observed",
      code: "NATIVE_APPDATA_IGNORES_HOME",
      reference: "NATIVE_APPDATA_IGNORES_HOME (documented)",
    });
    await checkpoint();

    // 2-4. Two instances at once.
    const fixture = (await import("node:http")).createServer((_, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><title>isolation</title><p>fixture</p>");
    });
    server = fixture;
    server.listen(0, "127.0.0.1");
    await deadline(once(server, "listening"), "fixture-listen");
    const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
    const { _electron: electron } = await import("playwright-core");
    // Each launch is recorded and checkpointed as soon as it exists, before the
    // next instance starts, so a later failure still names every process that
    // was launched. A failed launch keeps its profile and error; its pid is
    // unknown because Playwright returned no handle.
    for (const kind of ["normal", "owner-preview"]) {
      const record = { kind, status: "starting", pid: null, home: null };
      receipt.launches.push(record);
      await checkpoint();
      let instance;
      try {
        instance = await launch(
          electron,
          kind,
          verified,
          temporary,
          fixtureOrigin,
          record,
          { ...options, run },
        );
      } catch (error) {
        record.status = "failed";
        record.error =
          error instanceof Error ? error.message.split("\n")[0] : "FAILED";
        await checkpoint();
        throw error;
      }
      record.status = "running";
      record.pid = instance.pid;
      instance.record = record;
      instances.push(instance);
      await checkpoint();
    }
    const [normal, owner] = instances;
    assert.notEqual(normal.home, owner.home);
    assert.notEqual(normal.pid, owner.pid);

    const identities = {
      normal: desktopIdentity("preview", normal.appData),
      "owner-preview": desktopIdentity("owner-preview", owner.appData),
    };
    const observed = {};
    for (const instance of instances)
      observed[instance.kind] = await observe(instance, {
        fixtureOrigin,
        other: instance === normal ? owner : normal,
        identity: identities[instance.kind],
        envValues: run.envValues,
      });
    receipt.observations = Object.fromEntries(
      Object.entries(observed).map(([kind, entry]) => [
        kind,
        {
          pid: entry.pid,
          bootstrap: {
            environment: entry.bootstrap.environment,
            displayName: entry.bootstrap.displayName,
            applicationId: entry.bootstrap.applicationId,
            partition: entry.bootstrap.partition,
            chatgptPartition: entry.bootstrap.chatgptPartition,
          },
          runtime: entry.runtime,
          partitions: entry.partitions,
          processes: entry.processes,
          backendPid: entry.backend.pid,
          runtimePid: entry.runtimeChild.pid,
          listeners: entry.listeners,
          connections: entry.connections,
          listenerViolations: entry.listenerViolations,
          classification: entry.classification,
          unixPaths: entry.unixPaths,
          openPathCount: entry.paths.length,
        },
      ]),
    );
    receipt.findings = Object.entries(observed).flatMap(([kind, entry]) =>
      entry.processes
        .filter(
          (process_) =>
            process_.outcome === "observed" &&
            process_.role === "runtime" &&
            !process_.environment.homePresent,
        )
        .map((process_) => ({
          code: "RUNTIME_CHILD_HOME_UNSET",
          severity: "info",
          kind,
          pid: process_.pid,
          detail:
            "Informational observation, not an open defect. The Node runtime child is spawned with an explicit minimal environment and no HOME. Its host scope is limited to node:crypto, node:events and node:http, enforced at build by assertPreviewRuntimeHostScope, so it has no fs, os or child_process access to reach a home directory.",
          reference: "tooling/preview-runtime-scope.mjs",
        })),
    );
    await checkpoint();
    for (const instance of instances)
      await assertInstance(
        observed[instance.kind],
        instance,
        identities[instance.kind],
        instance === normal ? owner : normal,
      );

    // Nothing is shared between the two live instances.
    const sets = (kind, key) => new Set(observed[kind][key]);
    const ports = (kind) =>
      new Set(observed[kind].listeners.map((entry) => entry.port));
    for (const port of ports("normal"))
      assert.equal(ports("owner-preview").has(port), false, `PORT:${port}`);
    // A connected socket never has the other instance's listener as its peer.
    for (const [kind, otherKind] of [
      ["normal", "owner-preview"],
      ["owner-preview", "normal"],
    ])
      for (const connection of observed[kind].connections)
        assert.equal(
          ports(otherKind).has(connection.remotePort),
          false,
          `PEER_IS_OTHER_INSTANCE:${kind}:${connection.remotePort}`,
        );
    for (const socket of sets("normal", "unixPaths"))
      assert.equal(sets("owner-preview", "unixPaths").has(socket), false);
    const pids = (kind) => new Set(observed[kind].processes.map((p) => p.pid));
    for (const pid of pids("normal"))
      assert.equal(pids("owner-preview").has(pid), false);
    for (const key of ["partition", "chatgptPartition"])
      assert.notEqual(
        observed.normal.bootstrap[key],
        observed["owner-preview"].bootstrap[key],
      );
    assert.notEqual(
      identities.normal.userData,
      identities["owner-preview"].userData,
    );
    assert.deepEqual(await fs.readdir(normal.appData), ["Farol Next Preview"]);
    assert.deepEqual(await fs.readdir(owner.appData), ["Farol Preview"]);

    // Orderly quit of both, then the single teardown in `finally` verifies the process trees.
    const outcomes = await Promise.all(
      instances.map((instance) => requestQuit(instance)),
    );
    for (const [index, instance] of instances.entries()) {
      assert.equal(writeQuit(instance), outcomes[index]);
      assert.equal(
        outcomes[index],
        "observed",
        `OWNER_PREVIEW_ISOLATION_QUIT_${outcomes[index].toUpperCase()}:${instance.kind}`,
      );
      assert.equal(instance.terminal.code, 0);
      assert.equal(instance.terminal.signal, null);
      const state = path.join(
        identities[instance.kind].userData,
        "farol-next-state",
      );
      const quit = parseQuitReceipt(
        (
          await regularBytes(path.join(state, "last-quit.json"), 8192)
        ).toString(),
      );
      assert.equal(quit.ok, true);
      assert.equal(quit.receipt.drained, true);
      assert.deepEqual(quit.receipt.unconfirmed, []);
    }
    for (const instance of instances) writeQuit(instance);
    receipt.terminals = instances.map((entry) => ({
      kind: entry.kind,
      ...entry.terminal,
    }));
    await verifyOwnerPreview(repositoryRoot, generation);
  } catch (error) {
    failure = error;
    // One orderly quit per known owned app; never retry, signal or kill. The
    // record is derived from the actual terminal state, never assumed.
    for (const instance of instances) {
      try {
        await requestQuit(instance);
      } catch (cleanupError) {
        receipt.cleanupError =
          cleanupError instanceof Error
            ? cleanupError.message
            : "OWNER_PREVIEW_ISOLATION_QUIT_UNKNOWN";
      }
      writeQuit(instance);
    }
  } finally {
    // The single teardown, for every exit path: success, failure, or a launch
    // that failed half way. It cannot throw out of here (see settleRun); the
    // server is closed and the receipt written in every case. Survivors are
    // reported, never signalled.
    for (const instance of instances) writeQuit(instance);
    receipt.profilesRetained = [
      ...new Set(receipt.launches.map((record) => record.home).filter(Boolean)),
    ];
    await settleRun({
      receipt,
      failure,
      verify: () =>
        verifyTeardown(teardownTargets(instances, receipt.launches), {
          roots: run.roots,
          preexisting: run.preexisting,
          scopes: [repositoryRoot],
        }),
      closeServer: async () => {
        if (!server) return;
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      },
      checkpoint,
    });
  }
  if (!["PASS", "PASS_WITH_BLOCKED"].includes(receipt.status))
    throw new Error(
      `OWNER_PREVIEW_ISOLATION_UNCONFIRMED: ${receiptFile}: ${receipt.error}`,
      { cause: failure ?? undefined },
    );
  return { receiptFile, receipt };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (
      process.argv.length !== 4 ||
      process.argv[2] !== "--generation" ||
      !/^[a-f0-9]{64}$/u.test(process.argv[3])
    )
      throw new Error(
        "Usage: task test:e2e:owner-preview-isolation -- --generation <64hex>",
      );
    await requireOwnerGuardParent(process.argv[3]);
    const root = await fs.realpath(
      path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
    );
    const result = await runOwnerPreviewIsolation(root, process.argv[3]);
    process.stdout.write(`${result.receiptFile}\n`);
  } catch (error) {
    // A diagnostic leaves through the receipt guard too: an owner path in a
    // failure (for example an unsafe TMPDIR refused before any receipt
    // exists) is redacted, the code in front of it is kept.
    let message = String(error.message);
    try {
      message = guardReceipt(
        { message },
        {
          envValues: new Set(),
          roots: new Set(),
          repositoryRoot: path.dirname(
            path.dirname(path.dirname(fileURLToPath(import.meta.url))),
          ),
        },
      ).receipt.message;
    } catch {
      message = message.replace(/\/\S*/gu, "[REDACTED_PATH]");
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
