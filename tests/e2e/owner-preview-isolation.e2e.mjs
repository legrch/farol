import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
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
// pgrep exits 1 when a process has no children; that is its answer. Nothing
// else is allowed to exit non-zero: see `strict`.
async function query(command, args) {
  try {
    return (
      await execFileAsync(command, args, {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    if (error.code === 1 && typeof error.stdout === "string")
      return error.stdout;
    throw error;
  }
}
// An inventory is only evidence when the tool finished cleanly: any non-zero
// exit, signal, timeout or stderr output is an error carrying `code`.
async function strict(command, args, code) {
  let result;
  try {
    result = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `${code}:${error.code ?? error.signal ?? "FAILED"}:${String(
        error.stderr ?? "",
      )
        .trim()
        .slice(0, 200)}`,
      { cause: error },
    );
  }
  if (result.stderr.trim() !== "")
    throw new Error(`${code}:STDERR:${result.stderr.trim().slice(0, 200)}`);
  return result.stdout;
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
// Containment is decided on canonical paths: resolve `..` and trailing slashes,
// realpath the nearest existing ancestor (so a symlinked root cannot hide a
// path and a not-yet-existing leaf still resolves), then compare on a
// separator boundary. A relative path is never inside anything.
function canonical(value) {
  const rest = [];
  let current = path.resolve(value);
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if (
        (error.code !== "ENOENT" && error.code !== "ENOTDIR") ||
        parent === current
      )
        return path.join(current, ...rest.reverse());
      rest.push(path.basename(current));
      current = parent;
    }
  }
}
function inside(child, parent) {
  if (!path.isAbsolute(child) || !path.isAbsolute(parent)) return false;
  const target = canonical(child);
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
function touchesOwner(value) {
  // Check the text as given and, for an absolute path, its canonical form, so
  // `/tmp/x/../../Users/.../.codex` cannot hide an owner location.
  const forms = path.isAbsolute(value) ? [value, canonical(value)] : [value];
  return ownerLocations().some((location) =>
    forms.some((form) => form.includes(location)),
  );
}

async function descendants(parent) {
  const tree = [parent];
  for (let index = 0; index < tree.length; index += 1) {
    const found = await query(PGREP, ["-P", String(tree[index]), "-f", "."]);
    for (const line of found.split("\n"))
      if (/^[0-9]+$/u.test(line)) tree.push(Number(line));
  }
  return tree;
}
// null is the explicit "already exited" outcome; any other failure throws.
async function command(pid) {
  try {
    const text = (
      await strict(
        PS,
        ["-o", "command=", "-p", String(pid)],
        "OWNER_PREVIEW_ISOLATION_PS_INCOMPLETE",
      )
    ).trim();
    if (text === "") throw new Error("OWNER_PREVIEW_ISOLATION_PS_EMPTY");
    return text;
  } catch (error) {
    if (isGone(pid)) return null;
    throw error;
  }
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
  let answer;
  try {
    answer = JSON.parse(
      await strict(
        "/usr/bin/python3",
        ["-I", "-c", PROCARGS_SCRIPT, String(pid)],
        "OWNER_PREVIEW_ISOLATION_ENV_UNREADABLE",
      ),
    );
  } catch (error) {
    if (isGone(pid)) return null;
    throw error;
  }
  if (isGone(pid) && answer.status !== "ok") return null;
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
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
function listeners(files) {
  return files
    .filter(
      (file) =>
        (file.protocol === "TCP" && file.state === "ST=LISTEN") ||
        file.protocol === "UDP",
    )
    .map((file) => {
      const match = /^(.*):(\d+|\*)$/u.exec(file.name ?? "");
      return {
        pid: file.pid,
        protocol: file.protocol,
        host: match?.[1] ?? file.name,
        port: match?.[2] === "*" ? null : Number(match?.[2]),
      };
    });
}
// One lsof per pid, each required to finish cleanly and to name its own pid.
// A pid confirmed gone is the only empty inventory; it is reported as such.
async function openFiles(pid) {
  let output;
  try {
    output = await strict(
      LSOF,
      ["-nP", "-a", "-p", String(pid), "-F", "pftPnT"],
      "OWNER_PREVIEW_ISOLATION_LSOF_INCOMPLETE",
    );
  } catch (error) {
    if (isGone(pid)) return { pid, outcome: "exited", files: [] };
    throw error;
  }
  const files = parseLsof(output);
  if (
    output.split("\n")[0] !== `p${pid}` ||
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
async function probeNativeAppData(executable, temporary) {
  const directory = await fs.mkdtemp(
    path.join(temporary, "farol-next-e2e-probe-"),
  );
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
  const output = (
    await execFileAsync(executable, [directory], {
      encoding: "utf8",
      timeout: 30000,
      env: {
        HOME: home,
        TMPDIR: temporary,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PROBE_USER_DATA: userData,
      },
    })
  ).stdout;
  const line = output.split("\n").find((entry) => entry.startsWith("PROBE:"));
  assert.ok(line, "OWNER_PREVIEW_ISOLATION_PROBE_SILENT");
  return { ...JSON.parse(line.slice("PROBE:".length)), disposableHome: home };
}

async function launch(electron, kind, verified, temporary, fixtureOrigin) {
  const preview = kind === "owner-preview";
  const app = preview ? verified.appPath : verified.baseApp;
  const root = await disposableRoot(temporary);
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
    quitRequested: false,
    terminal: null,
  };
  instance.handle = await electron.launch({
    executablePath: executable,
    args: [
      appRoot,
      "--preview-window-mode=hidden",
      ...(preview ? ["--owner-background-only"] : []),
    ],
    env: environment,
    timeout: 20000,
  });
  instance.owned = instance.handle.process();
  instance.pid = instance.owned.pid;
  assert.ok(Number.isInteger(instance.pid) && instance.pid > 0);
  return instance;
}

async function requestQuit(instance) {
  if (
    instance.quitRequested ||
    instance.owned.exitCode !== null ||
    instance.owned.signalCode !== null
  )
    return;
  instance.quitRequested = true;
  const exit = once(instance.owned, "exit");
  void instance.handle.evaluate(({ app }) => app.quit()).catch(() => {});
  const [code, signal] = await deadline(exit, `${instance.kind}-quit`);
  instance.terminal = { code, signal };
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
    tree = await descendants(instance.pid);
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
    if (listeners(inventory.files).length > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  // One pass over the final tree. Each pid yields a command, a readable
  // non-empty environment and a clean lsof inventory, or the explicit
  // "exited" outcome. The parent, the backend and the runtime child may not
  // exit: for them any gap is an error, never a skipped check.
  tree = await descendants(instance.pid);
  const required = new Map([
    [instance.pid, "parent"],
    [backend.pid, "backend"],
    [runtimeChild.pid, "runtime"],
  ]);
  for (const pid of required.keys())
    assert.ok(tree.includes(pid), `OWNER_PREVIEW_ISOLATION_NOT_IN_TREE:${pid}`);
  const processes = [];
  const files = [];
  for (const pid of tree) {
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
        namesOwnerLocation: Object.values(environment).some(touchesOwner),
      },
      openFileCount: inventory.files.length,
    });
  }
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
    listeners: listeners(files),
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
    assert.equal(touchesOwner(entry.command), false);
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
  // Sockets: loopback only; the backend serves on at least one.
  assert.ok(observed.listeners.length > 0);
  for (const entry of observed.listeners)
    assert.ok(
      LOOPBACK.has(entry.host),
      `NON_LOOPBACK:${entry.protocol}:${entry.host}:${entry.port}`,
    );
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
    observed.paths.some((entry) => inside(entry, identity.userData)),
    "OWN_PROFILE_NOT_OPEN",
  );
  for (const entry of observed.paths) {
    assert.equal(touchesOwner(entry), false, `OWNER_PATH_OPEN:${entry}`);
    assert.equal(inside(entry, other.home), false, `FOREIGN_HOME:${entry}`);
    assert.equal(inside(entry, other.app), false, `FOREIGN_BUNDLE:${entry}`);
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
    assert.equal(inside(`${a}/c/../d`, a), true);
    assert.equal(inside(`${a}/not-created-yet/x`, a), true);
    assert.equal(inside(`${link}/x`, a), true);
    assert.equal(inside(a, link), true);
    assert.equal(inside(b, link), false);
    assert.equal(inside(`${link}/../instance-b`, a), false);
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
  const parsed = listeners(
    parseLsof(
      "p1\nf5\nPTCP\nn*:8080\nTST=LISTEN\nf6\nPUDP\nn*:5353\nf7\nPTCP\nn127.0.0.1:1->127.0.0.1:2\nTST=ESTABLISHED\n",
    ),
  );
  assert.deepEqual(
    parsed.map((entry) => [entry.pid, entry.protocol, entry.host, entry.port]),
    [
      [1, "TCP", "*", 8080],
      [1, "UDP", "*", 5353],
    ],
  );
  assert.equal(LOOPBACK.has("*"), false);
  // The inventories fail closed: a bad exit or any stderr is an error, a live
  // pid yields a real environment and file list, and only a pid the kernel no
  // longer knows is reported as exited.
  await assert.rejects(strict("/usr/bin/false", [], "SELF"), /^Error: SELF:1/u);
  await assert.rejects(
    strict("/bin/sh", ["-c", "echo warning >&2"], "SELF"),
    /^Error: SELF:STDERR:warning/u,
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
}

// Receipt inputs cannot contain observations or a PASS override.
export async function runOwnerPreviewIsolation(repositoryRoot, generation) {
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
  try {
    const temporary = await fs.realpath(os.tmpdir());
    const previewExecutable = path.join(
      verified.appPath,
      "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    );

    // 1. Override-free resolution. Observed without a profile: where the native
    // appData lands for a process whose HOME is disposable.
    const probe = await probeNativeAppData(previewExecutable, temporary);
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
    for (const kind of ["normal", "owner-preview"])
      instances.push(
        await launch(electron, kind, verified, temporary, fixtureOrigin),
      );
    const [normal, owner] = instances;
    receipt.launches = instances.map((entry) => ({
      kind: entry.kind,
      pid: entry.pid,
      home: entry.home,
    }));
    await checkpoint();
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
          kind,
          pid: process_.pid,
          detail:
            "The Node runtime child is spawned with an explicit minimal environment and no HOME; it cannot name the owner's home through its environment. Not a failure of this witness, but HOME is not set for every owned process.",
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

    // Orderly quit of both; every observed pid, including the backend, is gone.
    const everyPid = new Set(
      instances.flatMap((entry) =>
        observed[entry.kind].processes.map((p) => p.pid),
      ),
    );
    await Promise.all(instances.map((instance) => requestQuit(instance)));
    for (const instance of instances) {
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
    for (const pid of everyPid) {
      let gone = false;
      for (let tries = 0; tries < 100 && !gone; tries += 1) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 50));
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
          gone = true;
        }
      }
      assert.equal(gone, true, `OWNER_PREVIEW_ISOLATION_PID_REMAINS:${pid}`);
    }
    receipt.terminals = instances.map((entry) => ({
      kind: entry.kind,
      ...entry.terminal,
    }));
    await verifyOwnerPreview(repositoryRoot, generation);
    receipt.profilesRetained = instances.map((entry) => entry.home);
    receipt.status = "PASS";
    receipt.finishedAt = new Date().toISOString();
    await checkpoint();
    return { receiptFile, receipt };
  } catch (error) {
    // One orderly quit per known owned app; never retry, signal or kill.
    for (const instance of instances) {
      try {
        await requestQuit(instance);
      } catch (cleanupError) {
        receipt.cleanupError =
          cleanupError instanceof Error
            ? cleanupError.message
            : "OWNER_PREVIEW_ISOLATION_QUIT_UNKNOWN";
      }
    }
    receipt.status = "UNKNOWN";
    receipt.error =
      error instanceof Error ? error.message : "OWNER_PREVIEW_ISOLATION_FAILED";
    receipt.profilesRetained = instances.map((entry) => entry.home);
    receipt.finishedAt = new Date().toISOString();
    await checkpoint();
    throw new Error(
      `OWNER_PREVIEW_ISOLATION_UNCONFIRMED: ${receiptFile}: ${receipt.error}`,
      { cause: error },
    );
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
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
