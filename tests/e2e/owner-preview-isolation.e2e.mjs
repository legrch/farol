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
  ownerPreviewIdentity,
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
const emptyFailure = (result) =>
  result.code === 1 && result.stdout === "" && result.stderr === "";
const INVENTORY = {
  pgrep: { label: "pgrep", command: PGREP, noMatch: emptyFailure },
  lsof: {
    label: "lsof",
    command: LSOF,
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
  if (result.code === 0 && result.stderr === "")
    return { outcome: "ok", stdout: result.stdout };
  if (spec.noMatch(result, context)) return { outcome: "no_match" };
  throw fail(result.code, result.stderr);
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
// be running on this machine; none of its files may appear either.
function ownerLocations() {
  const home = os.userInfo().homedir;
  return [
    path.join(home, "Library/Application Support/Farol"),
    path.join(home, "Library/Application Support/Farol Next Preview"),
    path.join(home, "Library/Application Support/Farol Preview"),
    path.join(home, "Library/Application Support/Farol Dev"),
    path.join(home, "Library/Application Support/Farol DEV"),
    path.join(home, ".farol"),
    path.join(home, ".codex"),
    "/Applications/Farol.app",
  ];
}
// `text` marks a command line: it is matched as given, never as a path.
// `reported` marks a path the kernel reported (see canonical).
function touchesOwner(value, { text = false, reported = false } = {}) {
  // Check the text as given and, for an absolute path, its canonical form, so
  // `/tmp/x/../../Users/.../.codex` or a symlink then `..` cannot hide an owner
  // location.
  const forms =
    !text && path.isAbsolute(value)
      ? [value, canonical(value, reported)]
      : [value];
  return ownerLocations().some((location) =>
    forms.some((form) => form.includes(location)),
  );
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
    for (const line of found.stdout.split("\n"))
      if (/^[0-9]+$/u.test(line)) tree.push(Number(line));
  }
  return tree;
}
// Every scan of an instance's tree feeds the set of pids ever seen.
async function scanTree(instance) {
  const tree = await descendants(instance.pid);
  for (const pid of tree) instance.seen.add(pid);
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
// only; those are counted (`envWithheld`), not hidden.
const SCAN_SCRIPT = `
import ctypes, ctypes.util, json, struct, sys
libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
request = json.load(sys.stdin)
roots = request["roots"]
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
    strings = [part.decode("utf8", "replace") for part in parts if part]
    # exec path, argv, then environment entries (K=V)
    environment = [part for part in parts[1:] if part][argc:]
    matched = sorted({root for root in roots for text in strings if root in text})
    out.append({"pid": pid, "status": "match" if matched else "clear", "roots": matched, "envVisible": any(b"=" in part for part in environment)})
print(json.dumps(out))
`;
async function uidPids() {
  const listed = await runInventory("psUid", [
    "-U",
    String(process.getuid()),
    "-o",
    "pid=",
  ]);
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[0-9]+$/u.test(line))
    .map(Number);
}
async function inspectProcesses(pids, roots) {
  const answer = await runInventory("scan", ["-I", "-c", SCAN_SCRIPT], {
    input: JSON.stringify({ pids, roots }),
  });
  const results = JSON.parse(answer.stdout);
  if (
    !Array.isArray(results) ||
    results.length !== pids.length ||
    results.some((entry, index) => entry.pid !== pids[index])
  )
    throw new Error("OWNER_PREVIEW_ISOLATION_SCAN_INCOMPLETE");
  // This macOS answers EINVAL, not ESRCH, for a pid that has just exited: an
  // unreadable pid the kernel no longer knows is gone, anything else stays
  // unreadable.
  return results.map((entry) =>
    entry.status === "unreadable" && isGone(entry.pid)
      ? { ...entry, status: "gone" }
      : entry,
  );
}
async function orphanReport(
  roots,
  preexisting,
  {
    listPids = uidPids,
    inspect = inspectProcesses,
    tries = 100,
    interval = 50,
  } = {},
) {
  if (roots.size === 0)
    return {
      scanned: 0,
      excluded: preexisting.size,
      matches: [],
      unverifiable: [],
      envWithheld: 0,
    };
  let report;
  for (let attempt = 0; ; attempt += 1) {
    const candidates = (await listPids()).filter(
      (pid) => !preexisting.has(pid),
    );
    const results =
      candidates.length === 0 ? [] : await inspect(candidates, [...roots]);
    report = {
      scanned: candidates.length,
      excluded: preexisting.size,
      matches: results
        .filter((entry) => entry.status === "match")
        .map((entry) => ({ pid: entry.pid, roots: entry.roots })),
      unverifiable: results
        .filter((entry) => entry.status === "unreadable")
        .map((entry) => ({ pid: entry.pid, errno: entry.errno })),
      envWithheld: results.filter(
        (entry) => entry.status === "clear" && entry.envVisible === false,
      ).length,
    };
    if (
      (report.matches.length === 0 && report.unverifiable.length === 0) ||
      attempt >= tries
    )
      return report;
    await new Promise((r) => setTimeout(r, interval));
  }
}
// The one teardown, run for every exit path. A launch that failed before it
// returned a handle has no instance; its disposable root is covered by the
// orphan scan like every other root of the run.
async function verifyTeardown(targets, deps = {}) {
  const { roots = new Set(), preexisting = new Set(), ...rest } = deps;
  const reports = [];
  for (const target of targets)
    reports.push(await tearDownReport(target, rest));
  const orphans = await orphanReport(roots, preexisting, rest);
  const survivors = [
    ...reports.flatMap((report) => report.survivors),
    ...orphans.matches.map((entry) => ({
      kind: "orphan",
      pid: entry.pid,
      reason: "ORPHAN_REMAINS",
      roots: entry.roots,
    })),
    ...orphans.unverifiable.map((entry) => ({
      kind: "scan",
      pid: entry.pid,
      reason: "UNVERIFIABLE",
      errno: entry.errno,
    })),
  ];
  return {
    verified:
      reports.every((report) => report.verified) && survivors.length === 0,
    survivors,
    instances: reports,
    orphanScan: orphans,
  };
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
    receipt.status = "PASS";
    return;
  }
  receipt.status = "UNKNOWN";
  receipt.error =
    failure !== null
      ? failure instanceof Error
        ? failure.message
        : "OWNER_PREVIEW_ISOLATION_FAILED"
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
  const text = answer.stdout.trim();
  if (text === "") throw new Error("OWNER_PREVIEW_ISOLATION_PS_EMPTY");
  return text;
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
        if b"=" in p:
            k, v = p.split(b"=", 1)
            env[k.decode("utf8", "replace")] = v.decode("utf8", "replace")
except Exception:
    fail("parse")
print(json.dumps({"status": "ok", "env": env}))
`;
// Fail closed: a readable, non-empty environment, or null for a pid that has
// exited. An unreadable or empty environment of a live pid is an error, never
// a skipped check.
async function environmentOf(pid) {
  const probed = await runInventory("probe", [
    "-I",
    "-c",
    PROCARGS_SCRIPT,
    String(pid),
  ]);
  const answer = JSON.parse(probed.stdout);
  if (answer.status !== "ok" && isGone(pid)) return null;
  if (answer.status !== "ok")
    throw new Error(
      `OWNER_PREVIEW_ISOLATION_ENV_UNREADABLE:${pid}:${answer.reason}`,
    );
  if (Object.keys(answer.env).length === 0)
    throw new Error(`OWNER_PREVIEW_ISOLATION_ENV_EMPTY:${pid}`);
  return answer.env;
}
// lsof -F: records start at `p`; each file starts at `f`.
function parseLsof(output) {
  const files = [];
  let pid = null;
  let current = null;
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      pid = Number(value);
      current = null;
    } else if (field === "f") {
      current = { pid, fd: value };
      files.push(current);
    } else if (current) {
      if (field === "t") current.type = value;
      else if (field === "P") current.protocol = value;
      else if (field === "n") current.name = value;
      else if (field === "T" && value.startsWith("ST=")) current.state = value;
    }
  }
  return files;
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
  const home = await fs.mkdtemp(path.join(temporary, "farol-next-e2e-home-"));
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

// The native appData of a bundled Electron ignores the HOME it is started
// with. A launch without the E2E override would therefore select the owner's
// real profile, which this witness may not touch. Read the value with an
// application that fixes its own userData to a disposable path before ready
// and never opens a window; nothing is read from or written to the result.
async function probeNativeAppData(executable, temporary, run) {
  const directory = await fs.mkdtemp(
    path.join(temporary, "farol-next-e2e-probe-"),
  );
  run.roots.add(directory);
  await fs.chmod(directory, 0o700);
  const userData = path.join(directory, "user-data");
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "farol-isolation-probe", main: "main.js" }),
    { flag: "wx", mode: 0o600 },
  );
  await fs.writeFile(
    path.join(directory, "main.js"),
    `const { app } = require("electron");
app.setPath("userData", process.env.PROBE_USER_DATA);
app.setPath("sessionData", process.env.PROBE_USER_DATA);
app.whenReady().then(() => {
  process.stdout.write("PROBE:" + JSON.stringify({ appData: app.getPath("appData"), home: app.getPath("home"), envHome: process.env.HOME }) + "\\n");
  app.quit();
});
`,
    { flag: "wx", mode: 0o600 },
  );
  const home = path.join(directory, "home");
  await fs.mkdir(home, { mode: 0o700 });
  // The probe is a launched Electron like any other: its pid is recorded the
  // moment it exists and its tree joins the teardown. It is never signalled;
  // one that does not finish is left for the teardown to report.
  const child = spawn(executable, [directory], {
    env: {
      HOME: home,
      TMPDIR: temporary,
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      PROBE_USER_DATA: userData,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const target = {
    kind: "probe",
    pid: child.pid,
    home: directory,
    seen: new Set([child.pid]),
  };
  run.extraTargets.push(target);
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", () => {});
  let finished = null;
  child.once("error", (error) => {
    finished = { error };
  });
  child.once("exit", (code, signal) => {
    finished = { code, signal };
  });
  const limit = Date.now() + 30000;
  while (finished === null && Date.now() < limit) {
    await scanTree(target);
    await new Promise((r) => setTimeout(r, 100));
  }
  await scanTree(target);
  if (finished === null)
    throw new Error("OWNER_PREVIEW_ISOLATION_PROBE_TIMEOUT");
  if (finished.error || finished.code !== 0)
    throw new Error(
      `OWNER_PREVIEW_ISOLATION_PROBE_FAILED:${finished.error?.code ?? finished.code ?? finished.signal}`,
    );
  const line = stdout.split("\n").find((entry) => entry.startsWith("PROBE:"));
  assert.ok(line, "OWNER_PREVIEW_ISOLATION_PROBE_SILENT");
  return { ...JSON.parse(line.slice("PROBE:".length)), disposableHome: home };
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
  const instance = {
    kind,
    app,
    appRoot,
    executable,
    ...root,
    handle: null,
    pid: null,
    terminal: null,
    // Every pid ever seen in this instance's process tree.
    seen: new Set(),
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

// One snapshot of everything the operating system says about an instance.
async function observe(instance, expected) {
  const outbound = [];
  await instance.handle.context().route("**/*", (route) => {
    const url = route.request().url();
    if (
      url.startsWith(`${expected.fixtureOrigin}/`) ||
      url.startsWith("file:") ||
      url.startsWith("devtools:")
    )
      return route.continue();
    outbound.push(new URL(url).origin);
    return route.abort();
  });
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
  const processes = [];
  const files = [];
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
      const environment = text === null ? null : await environmentOf(pid);
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
      processes.push({
        pid,
        outcome: "observed",
        role: required.get(pid) ?? "helper",
        command: text,
        environment: {
          keys: Object.keys(environment).sort(),
          homePresent: "HOME" in environment,
          home: environment.HOME ?? null,
          codexHomePresent: "CODEX_HOME" in environment,
          codexHome: environment.CODEX_HOME ?? null,
          runtimeIdentity: environment.FAROL_NEXT_RUNTIME_IDENTITY ?? null,
          namesOwnerLocation: Object.values(environment).some((value) =>
            touchesOwner(value),
          ),
        },
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
    assert.equal(entry.command.includes(other.app), false);
    assert.equal(touchesOwner(entry.command, { text: true }), false);
    // Every live process has a readable, non-empty environment (see
    // environmentOf). HOME must be set and inside THIS instance's disposable
    // root; the one exception is the Node runtime child, which the shell spawns
    // with an explicit minimal environment that never includes HOME (see
    // startRuntime in main.ts) and is recorded as a finding in the receipt.
    // CODEX_HOME, if present, must lie inside this instance's own profile (the
    // stricter form of "own root"): never ~/.codex, an owner location, or the
    // other instance's root.
    assert.ok(entry.environment.keys.length > 0, `ENV_EMPTY:${entry.pid}`);
    assert.equal(entry.environment.namesOwnerLocation, false);
    if (entry.environment.homePresent) {
      assert.ok(
        inside(entry.environment.home, instance.home),
        `HOME_OUTSIDE_INSTANCE_ROOT:${entry.role}:${entry.pid}`,
      );
      assert.equal(inside(entry.environment.home, other.home), false);
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
    if (entry.environment.codexHomePresent) {
      const codexHome = entry.environment.codexHome;
      assert.ok(
        inside(codexHome, identity.userData) &&
          !touchesOwner(codexHome) &&
          !inside(codexHome, other.home),
        `CODEX_HOME_OUTSIDE_INSTANCE_ROOT:${entry.role}:${entry.pid}`,
      );
    }
  }
  const parent = live.find((entry) => entry.pid === instance.pid);
  assert.equal(parent.environment.home, instance.home);
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
  assert.equal(
    runtimeProcess.environment.runtimeIdentity,
    identity.runtimeIdentity,
  );
  assert.ok(
    observed.listeners.some((entry) => entry.pid === observed.runtimeChild.pid),
    "RUNTIME_NOT_LISTENING",
  );
  // Files: this instance reaches its own roots and no other root.
  assert.ok(
    observed.paths.some((entry) => inside(entry, identity.userData, true)),
    "OWN_PROFILE_NOT_OPEN",
  );
  for (const entry of observed.paths) {
    assert.equal(
      touchesOwner(entry, { reported: true }),
      false,
      `OWNER_PATH_OPEN:${entry}`,
    );
    assert.equal(
      inside(entry, other.home, true),
      false,
      `FOREIGN_HOME:${entry}`,
    );
    assert.equal(
      inside(entry, other.app, true),
      false,
      `FOREIGN_BUNDLE:${entry}`,
    );
  }
}

// The scanners below judge live observations; prove they can fail first.
async function scannerSelfCheck() {
  const home = os.userInfo().homedir;
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
  assert.equal(inside("/a/bc", "/a/b"), false);
  assert.equal(inside("/a/b/c", "/a/b"), true);
  assert.equal(inside("relative/path", "/a/b"), false);
  // Containment is canonical: `..` escapes, sibling prefixes, trailing slashes
  // and a symlinked root.
  const sandbox = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-e2e-selfcheck-")),
  );
  try {
    const a = path.join(sandbox, "instance-a");
    const a2 = path.join(sandbox, "instance-a2");
    const b = path.join(sandbox, "instance-b");
    for (const directory of [a, a2, b]) await fs.mkdir(directory);
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
  await assert.rejects(
    runInventory({ ...INVENTORY.pgrep, command: "/nonexistent/inventory" }, []),
    /INVENTORY_ERROR:pgrep:ENOENT/u,
  );
  const environment = await environmentOf(process.pid);
  assert.ok(environment !== null && Object.keys(environment).length > 0);
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
  // A probe Electron whose helper outlives the probe parent: the probe is a
  // teardown target like an instance, so the surviving helper is reported.
  const probe = {
    kind: "probe",
    pid: 20,
    home: "/probe-root",
    seen: new Set([20, 21]),
  };
  assert.deepEqual(
    await reasons(probe, {
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
  // before the run is never inspected; an unreadable one is unverifiable and
  // keeps the teardown unverified; a vanished one is ignored.
  const roots = new Set(["/root-a", "/root-b"]);
  const inspected = [];
  const scanDeps = {
    ...clean,
    listPids: async () => [10, 11, 12, 13, 14, 15],
    inspect: async (pids, scanned) => {
      inspected.push(...pids);
      assert.deepEqual(scanned, ["/root-a", "/root-b"]);
      return pids.map((pid) => ({
        pid,
        ...{
          11: { status: "match", roots: ["/root-a"] },
          12: { status: "clear", envVisible: true },
          13: { status: "unreadable", errno: 22 },
          14: { status: "gone", errno: 3 },
          15: { status: "clear", envVisible: false },
        }[pid],
      }));
    },
  };
  const orphan = await orphanReport(roots, new Set([10]), scanDeps);
  assert.deepEqual(inspected.slice(0, 5), [11, 12, 13, 14, 15]);
  assert.equal(inspected.includes(10), false);
  assert.deepEqual(orphan.matches, [{ pid: 11, roots: ["/root-a"] }]);
  assert.deepEqual(orphan.unverifiable, [{ pid: 13, errno: 22 }]);
  assert.equal(orphan.envWithheld, 1);
  assert.equal(orphan.excluded, 1);
  const scanned = await verifyTeardown([instance(1)], {
    ...scanDeps,
    roots,
    preexisting: new Set([10]),
  });
  assert.equal(scanned.verified, false);
  assert.deepEqual(
    scanned.survivors.map(
      (entry) => `${entry.kind}:${entry.pid}:${entry.reason}`,
    ),
    ["orphan:11:ORPHAN_REMAINS", "scan:13:UNVERIFIABLE"],
  );
  // A pre-existing match is excluded, so the same scan is clean without it.
  const excluded = await orphanReport(roots, new Set([10, 11, 13]), {
    ...scanDeps,
    inspect: async (pids) =>
      pids.map((pid) => ({ pid, status: "clear", envVisible: true })),
  });
  assert.deepEqual([excluded.matches, excluded.unverifiable], [[], []]);
  // No roots means nothing to find and no scan at all.
  assert.deepEqual(
    await orphanReport(new Set(), new Set(), {
      listPids: async () => assert.fail("scanned without roots"),
    }),
    { scanned: 0, excluded: 0, matches: [], unverifiable: [], envWithheld: 0 },
  );
  // The real scanner on real processes: a child whose root sits only in its
  // environment is found, one without it is clear, a vanished pid is gone, and
  // another process's environment never comes back.
  const rootText = `/farol-selfcheck-root-${randomUUID()}`;
  const spawnIdle = (environment) =>
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], {
      env: environment,
      stdio: "ignore",
    });
  const withRoot = spawnIdle({ HOME: rootText });
  const without = spawnIdle({ HOME: "/somewhere/else" });
  const gone = spawn("/usr/bin/true");
  await once(gone, "exit");
  try {
    const found = await inspectProcesses(
      [withRoot.pid, without.pid, gone.pid],
      [rootText],
    );
    assert.deepEqual(found, [
      {
        pid: withRoot.pid,
        status: "match",
        roots: [rootText],
        envVisible: true,
      },
      { pid: without.pid, status: "clear", roots: [], envVisible: true },
      { pid: gone.pid, status: "gone", errno: found[2].errno },
    ]);
  } finally {
    await Promise.all(
      [withRoot, without].map((child) =>
        child.exitCode === null ? once(child, "exit") : null,
      ),
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
  const checkpoint = () =>
    fs.writeFile(receiptFile, jsonBytes(receipt), { mode: 0o600 });
  await fs.writeFile(receiptFile, jsonBytes(receipt), {
    flag: "wx",
    mode: 0o600,
  });
  const instances = [];
  let server;
  let failure = null;
  let teardown = null;
  // Everything this run creates that a survivor could carry: every disposable
  // root, every launched child outside the instances (the probe), and the uid's
  // pids that already existed when the run began.
  const run = { roots: new Set(), extraTargets: [], preexisting: new Set() };
  try {
    run.preexisting = new Set(await uidPids());
    const temporary = await fs.realpath(os.tmpdir());
    const previewExecutable = path.join(
      verified.appPath,
      "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    );

    // 1. Override-free resolution. Observed without a profile: where the native
    // appData lands for a process whose HOME is disposable.
    const probe = await probeNativeAppData(previewExecutable, temporary, run);
    const realAppData = path.join(
      os.userInfo().homedir,
      "Library/Application Support",
    );
    assert.equal(probe.envHome, probe.disposableHome);
    assert.equal(
      probe.appData,
      realAppData,
      "native appData unexpectedly follows HOME",
    );
    assert.notEqual(
      probe.appData,
      path.join(probe.disposableHome, "Library/Application Support"),
    );
    receipt.blocked.push({
      dimension: "override-free-resolution",
      code: "NATIVE_APPDATA_IGNORES_HOME",
      detail:
        "A bundled Electron started with a disposable HOME still reports the owner's real Application Support as appData, so a launch without FAROL_NEXT_E2E_APP_DATA would select the owner's real profile. Not launched.",
      nativeAppData: probe.appData,
      wouldSelect: ownerPreviewIdentity(probe.appData).userData,
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
      observed[instance.kind] = await observe(instance, { fixtureOrigin });
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
    // that failed half way. Survivors are reported, never signalled.
    teardown = await verifyTeardown(
      [...teardownTargets(instances, receipt.launches), ...run.extraTargets],
      { roots: run.roots, preexisting: run.preexisting },
    );
    for (const instance of instances) writeQuit(instance);
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
  receipt.profilesRetained = [
    ...new Set(receipt.launches.map((record) => record.home).filter(Boolean)),
  ];
  concludeReceipt(receipt, failure, teardown);
  await checkpoint();
  if (receipt.status !== "PASS")
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
        "Usage: node tests/e2e/owner-preview-isolation.e2e.mjs --generation <64hex>",
      );
    const root = await fs.realpath(
      path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
    );
    const result = await runOwnerPreviewIsolation(root, process.argv[3]);
    process.stdout.write(`${result.receiptFile}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
