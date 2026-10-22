import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { ChildProcess } from "node:child_process";
import { Server } from "node:http";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MAX_RUN_MARKER_BYTES,
  RunMarkerSchema,
} from "../../src/apps/desktop/run-marker.ts";

// The exception is confined to these hidden Setup fixtures. Production still
// validates the same profile proof before selecting storage or instance locks.
import {
  desktopAppDataPath,
  desktopIdentity,
  desktopUserDataPath,
} from "../../src/apps/desktop/desktop-environment.ts";
import {
  FAROL_MODEL_ENABLED,
  FAROL_BACKED_PRODUCT_AGENT_ENABLED,
} from "../../src/apps/desktop/foundation-feature-gates.ts";
import { parsePreviewWindowMode } from "../../src/apps/desktop/window-placement.ts";

// Test preflight only. Never read, remove or repair the owner's marker. Even a
// stale or malformed marker refuses a competing native test until reconciled.
export async function assertOwnerPreviewIdle(stateRoot, metadata = fs.lstat) {
  try {
    await metadata(path.join(stateRoot, "running.json"));
  } catch (error) {
    if (error.code === "ENOENT") return { stateRoot, marker: "absent" };
    throw new Error("NATIVE_OWNER_PREVIEW_STATE_UNREADABLE", { cause: error });
  }
  throw new Error("NATIVE_OWNER_PREVIEW_NOT_CONFIRMED_IDLE");
}

const admissions = new WeakMap();
const allowedEnvironment = new Set([
  "HOME",
  "TMPDIR",
  "PATH",
  "LANG",
  "FAROL_ENVIRONMENT",
  "FAROL_E2E",
  "FAROL_E2E_APP_DATA",
  "FAROL_E2E_TEST_ROOT",
  "FAROL_E2E_TEST_PROOF",
  "FAROL_E2E_WORKSPACE_ROOT",
  "FAROL_E2E_CHATGPT_URL",
  "FAROL_E2E_TUNNEL_CLIENT",
]);
const invalid = (detail) => new Error(`NATIVE_ISOLATION_${detail}`);
function absolute(value) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  )
    throw invalid("PATH_INVALID");
  return value;
}
function identity(info) {
  return { dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode };
}
function same(info, prior) {
  return Object.keys(prior).every((key) => info[key] === prior[key]);
}
async function directory(value) {
  absolute(value);
  const info = await fs.lstat(value);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700 ||
    (await fs.realpath(value)) !== value
  )
    throw invalid("DIRECTORY_UNSAFE");
  return identity(info);
}
async function proofRoot(root, proof, auxiliary = false) {
  absolute(root);
  const parent = await fs.realpath(path.dirname(root));
  if (
    parent !== path.dirname(root) ||
    (!["/tmp", "/private/tmp"].includes(parent) &&
      !/^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/u.test(parent)) ||
    !(
      auxiliary
        ? /^farol-guided-setup-[A-Za-z0-9]{6,}$/u
        : /^farol-e2e-home-[A-Za-z0-9]{6,}$/u
    ).test(path.basename(root))
  )
    throw invalid("ROOT_INVALID");
  const rootIdentity = await directory(root);
  const file = path.join(root, ".farol-e2e-root");
  const before = await fs.lstat(file);
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o777) !== 0o600 ||
    before.size !== proof.length
  )
    throw invalid("PROOF_UNSAFE");
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    const witness = {
      ...identity(before),
      size: before.size,
      nlink: before.nlink,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
    };
    if (!opened.isFile() || !same(opened, witness))
      throw invalid("PROOF_CHANGED");
    const buffer = Buffer.alloc(proof.length + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (
      bytesRead !== proof.length ||
      buffer.subarray(0, bytesRead).toString("utf8") !== proof ||
      !same(await handle.stat(), witness) ||
      !same(await fs.lstat(file), witness)
    )
      throw invalid("PROOF_CHANGED");
    if (
      !same(await fs.lstat(root), rootIdentity) ||
      (await fs.realpath(root)) !== root
    )
      throw invalid("ROOT_CHANGED");
    return { rootIdentity, file, witness };
  } finally {
    await handle.close();
  }
}
// Metadata only: reject links/special files before any child can follow them.
// Private roots protect descendant bytes; do not read credentials or profiles.
async function tree(root, sockets = false, links = new Map()) {
  let count = 0;
  async function walk(value) {
    if (++count > 20000) throw invalid("TREE_LIMIT");
    const info = await fs.lstat(value);
    const link = links.get(value);
    if (link) {
      if (
        !info.isSymbolicLink() ||
        !same(info, link.witness) ||
        (await fs.readlink(value)) !== link.target
      )
        throw invalid("SINGLETON_CHANGED");
      return;
    }
    if (
      info.uid !== process.getuid?.() ||
      info.isSymbolicLink() ||
      !(info.isDirectory() || info.isFile() || (sockets && info.isSocket())) ||
      (!info.isDirectory() && info.nlink !== 1) ||
      (await fs.realpath(value)) !== value
    )
      throw invalid(`TREE_UNSAFE:${path.relative(root, value)}`);
    if (info.isDirectory()) {
      for (const name of await fs.readdir(value))
        await walk(path.join(value, name));
    }
    if (!same(await fs.lstat(value), identity(info)))
      throw invalid("TREE_CHANGED");
  }
  await walk(root);
}

// Chromium's three ProcessSingleton links are one bound native resource, not
// a pathname exception. Never connect to its socket, inspect another PID or
// invoke Chromium's stale-instance recovery. Targets/cookies stay internal.
const singletonNames = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
async function singletonLink(file) {
  const before = await fs.lstat(file);
  if (
    !before.isSymbolicLink() ||
    before.uid !== process.getuid?.() ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > 1024
  )
    throw invalid("SINGLETON_UNSAFE");
  const witness = {
    ...identity(before),
    nlink: before.nlink,
    size: before.size,
    mtimeMs: before.mtimeMs,
    ctimeMs: before.ctimeMs,
  };
  const target = await fs.readlink(file);
  if (!same(await fs.lstat(file), witness)) throw invalid("SINGLETON_CHANGED");
  return { witness, target };
}
async function singleton(admitted, actual, child) {
  if (
    !(child instanceof ChildProcess) ||
    !Number.isSafeInteger(child.pid) ||
    child.pid < 1 ||
    actual?.pid !== child.pid ||
    (admitted.child && admitted.child !== child)
  )
    throw invalid("SINGLETON_CHILD_UNOWNED");
  const userData = admitted.paths.userData;
  if (child.exitCode !== null || child.signalCode !== null) {
    if (
      !admitted.checked ||
      !admitted.singleton ||
      child.exitCode !== 0 ||
      child.signalCode !== null
    )
      throw invalid("SINGLETON_TERMINAL_UNCONFIRMED");
    for (const name of singletonNames) {
      try {
        await fs.lstat(path.join(userData, name));
        throw invalid("SINGLETON_NOT_RELEASED");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return undefined;
  }
  const links = new Map();
  for (const name of singletonNames) {
    const file = path.join(userData, name);
    links.set(file, await singletonLink(file));
  }
  if (
    links.get(path.join(userData, "SingletonLock")).target !==
    `${os.hostname()}-${child.pid}`
  )
    throw invalid("SINGLETON_CHILD_MISMATCH");
  const cookie = links.get(path.join(userData, "SingletonCookie")).target;
  if (!/^[0-9]{1,20}$/u.test(cookie) || BigInt(cookie) > 0xffffffffffffffffn)
    throw invalid("SINGLETON_COOKIE_INVALID");
  const socketTarget = absolute(
    links.get(path.join(userData, "SingletonSocket")).target,
  );
  const directoryInput = path.dirname(socketTarget);
  const inputMetadata = await fs.lstat(directoryInput);
  const socketRoot = await fs.realpath(directoryInput);
  if (
    !inputMetadata.isDirectory() ||
    inputMetadata.isSymbolicLink() ||
    (await fs.realpath(path.dirname(directoryInput))) !==
      path.dirname(actual.home) ||
    path.basename(socketTarget) !== "SingletonSocket" ||
    path.dirname(socketRoot) !== path.dirname(actual.home) ||
    socketRoot === actual.home
  )
    throw invalid("SINGLETON_SOCKET_OUTSIDE_TEMP");
  const rootIdentity = await directory(socketRoot);
  const remoteCookiePath = path.join(socketRoot, "SingletonCookie");
  const remoteCookie = await singletonLink(remoteCookiePath);
  if (remoteCookie.target !== cookie)
    throw invalid("SINGLETON_COOKIE_MISMATCH");
  const socketPath = path.join(socketRoot, "SingletonSocket");
  const info = await fs.lstat(socketPath);
  if (
    !info.isSocket() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    (await fs.realpath(socketPath)) !== socketPath ||
    (await fs.realpath(socketTarget)) !== socketPath
  )
    throw invalid("SINGLETON_SOCKET_UNSAFE");
  if (
    JSON.stringify((await fs.readdir(socketRoot)).sort()) !==
    JSON.stringify(["SingletonCookie", "SingletonSocket"])
  )
    throw invalid("SINGLETON_DIRECTORY_UNSAFE");
  const socketIdentity = { ...identity(info), nlink: info.nlink };
  const prior = admitted.singleton;
  if (
    prior &&
    (prior.socketRoot !== socketRoot ||
      !same(rootIdentity, prior.rootIdentity) ||
      !same(socketIdentity, prior.socketIdentity) ||
      [...links].some(([file, link]) => {
        const previous = prior.links.get(file);
        return (
          !previous ||
          previous.target !== link.target ||
          !same(link.witness, previous.witness)
        );
      }) ||
      remoteCookie.target !== prior.remoteCookie.target ||
      !same(remoteCookie.witness, prior.remoteCookie.witness))
  )
    throw invalid("SINGLETON_CHANGED");
  return {
    links,
    directoryInput,
    socketTarget,
    socketRoot,
    rootIdentity,
    socketPath,
    socketIdentity,
    remoteCookiePath,
    remoteCookie,
  };
}
async function recheckSingleton(resource, child) {
  if (!resource) return;
  for (const [file, link] of [
    ...resource.links,
    [resource.remoteCookiePath, resource.remoteCookie],
  ]) {
    const current = await singletonLink(file);
    if (current.target !== link.target || !same(current.witness, link.witness))
      throw invalid("SINGLETON_CHANGED");
  }
  if (
    !same(await directory(resource.socketRoot), resource.rootIdentity) ||
    !same(await fs.lstat(resource.directoryInput), resource.rootIdentity) ||
    !same(await fs.lstat(resource.socketPath), resource.socketIdentity) ||
    (await fs.realpath(resource.socketTarget)) !== resource.socketPath ||
    JSON.stringify((await fs.readdir(resource.socketRoot)).sort()) !==
      JSON.stringify(["SingletonCookie", "SingletonSocket"]) ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    throw invalid("SINGLETON_CHANGED");
}
function endpoint(launch, fixture) {
  if (!(fixture instanceof Server) || !fixture.listening)
    throw invalid("ENDPOINT_UNOWNED");
  const address = fixture.address();
  if (
    !address ||
    typeof address === "string" ||
    address.address !== "127.0.0.1" ||
    !Number.isInteger(address.port) ||
    address.port < 1 ||
    address.port > 65535 ||
    launch.env.FAROL_E2E_CHATGPT_URL !== `http://127.0.0.1:${address.port}/`
  )
    throw invalid("ENDPOINT_INVALID");
}

async function recheckBindings(binding) {
  const current = await proofRoot(
    path.dirname(binding.rootProof.file),
    binding.proof,
  );
  if (
    !same(current.witness, binding.rootProof.witness) ||
    !same(current.rootIdentity, binding.rootProof.rootIdentity)
  )
    throw invalid("PROOF_CHANGED");
  for (const [value, before] of Object.entries(binding.directories))
    if (!same(await directory(value), before))
      throw invalid("DIRECTORY_CHANGED");
  if (binding.auxiliary) {
    const auxiliary = await proofRoot(
      binding.auxiliaryRoot,
      binding.proof,
      true,
    );
    if (
      !same(auxiliary.witness, binding.auxiliary.witness) ||
      !same(auxiliary.rootIdentity, binding.auxiliary.rootIdentity)
    )
      throw invalid("AUXILIARY_CHANGED");
  }
}

export async function assertNativePreviewAdmission(ownerStateRoot, isolation) {
  if (isolation === undefined) return assertOwnerPreviewIdle(ownerStateRoot);
  try {
    if (!isolation || typeof isolation !== "object")
      throw invalid("REQUEST_INVALID");
    const {
      profileRoot,
      proof,
      launchOptions,
      fixture,
      auxiliaryRoot,
      previous,
    } = isolation;
    if (
      typeof proof !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(proof)
    )
      throw invalid("PROOF_INVALID");
    if (
      !launchOptions ||
      typeof launchOptions !== "object" ||
      Array.isArray(launchOptions)
    )
      throw invalid("LAUNCH_INVALID");
    const env = launchOptions.env;
    const args = launchOptions?.args;
    if (
      !env ||
      typeof env !== "object" ||
      Array.isArray(env) ||
      Object.keys(env).some((key) => !allowedEnvironment.has(key)) ||
      Object.values(env).some((value) => typeof value !== "string") ||
      env.FAROL_E2E !== "1" ||
      env.HOME !== profileRoot ||
      env.FAROL_E2E_TEST_ROOT !== profileRoot ||
      env.FAROL_E2E_TEST_PROOF !== proof ||
      env.PATH !== "/usr/bin:/bin:/usr/sbin:/sbin" ||
      env.LANG !== "en_US.UTF-8" ||
      ![undefined, "dev"].includes(env.FAROL_ENVIRONMENT)
    )
      throw invalid("ENVIRONMENT_INVALID");
    absolute(launchOptions.executablePath);
    if (
      !Array.isArray(args) ||
      args.some((arg) => typeof arg !== "string") ||
      parsePreviewWindowMode(args) !== "hidden"
    )
      throw invalid("WINDOW_INVALID");
    const switches = args.filter((arg) => arg.startsWith("--user-data-dir="));
    if (
      switches.length > 1 ||
      args.some(
        (arg, i) =>
          arg !== "--preview-window-mode=hidden" &&
          !switches.includes(arg) &&
          !(i === 0 && !arg.startsWith("--") && absolute(arg)),
      )
    )
      throw invalid("ARGUMENTS_INVALID");
    endpoint(launchOptions, fixture);
    const rootProof = await proofRoot(profileRoot, proof);
    const temp = await fs.realpath(absolute(env.TMPDIR));
    if (temp !== path.dirname(profileRoot)) throw invalid("TEMP_INVALID");
    const environment = env.FAROL_ENVIRONMENT ?? "preview";
    const appData = desktopAppDataPath(environment, env.FAROL_E2E_APP_DATA, {
      enabled: true,
      override: env.FAROL_E2E_APP_DATA,
      testRoot: profileRoot,
      testHome: env.HOME,
      testProof: proof,
    });
    absolute(appData);
    const selected = desktopUserDataPath(
      desktopIdentity(environment, appData),
      {
        enabled: true,
        override: switches[0]?.slice("--user-data-dir=".length),
      },
    );
    absolute(selected);
    if (switches.length && switches[0] !== `--user-data-dir=${selected}`)
      throw invalid("USER_DATA_INVALID");
    const paths = {
      home: profileRoot,
      appData,
      userData: selected,
      sessionData: selected,
    };
    const directories = {};
    for (const value of new Set(Object.values(paths)))
      directories[value] = await directory(value);
    await tree(profileRoot);
    try {
      await fs.lstat(path.join(selected, "farol-state/running.json"));
      throw invalid("PRIOR_RUN_UNCONFIRMED");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let auxiliary;
    if (auxiliaryRoot !== undefined) {
      if (auxiliaryRoot === profileRoot) throw invalid("AUXILIARY_INVALID");
      auxiliary = await proofRoot(auxiliaryRoot, proof, true);
      await tree(auxiliaryRoot);
    }
    for (const key of ["FAROL_E2E_WORKSPACE_ROOT", "FAROL_E2E_TUNNEL_CLIENT"]) {
      const value = env[key];
      if (value === undefined) continue;
      absolute(value);
      if (!auxiliary || !value.startsWith(`${auxiliaryRoot}${path.sep}`))
        throw invalid("AUXILIARY_INVALID");
      const info = await fs.lstat(value);
      if (
        key.endsWith("WORKSPACE_ROOT")
          ? !info.isDirectory()
          : !info.isFile() || (info.mode & 0o111) === 0
      )
        throw invalid("AUXILIARY_INVALID");
    }
    // No fixed-port probe. Model/Agent cannot bind their persisted endpoint.
    if (
      FAROL_MODEL_ENABLED !== false ||
      FAROL_BACKED_PRODUCT_AGENT_ENABLED !== false
    )
      throw invalid("MODEL_GATE_CHANGED");
    // The only deterministic shared-temp name is keyed by the proven physical
    // profile. First admission requires absence; reopen requires our exact inode.
    const relayRoot = path.join(
      temp,
      `farol-relay-${createHash("sha256").update(selected).digest("hex").slice(0, 16)}`,
    );
    const prior = previous === undefined ? undefined : admissions.get(previous);
    if (
      previous !== undefined &&
      (!prior ||
        !prior.checked ||
        prior.paths.userData !== selected ||
        prior.rootProof.file !== rootProof.file ||
        !same(rootProof.witness, prior.rootProof.witness))
    )
      throw invalid("RECEIPT_INVALID");
    if (
      prior?.child &&
      (prior.child.exitCode !== 0 || prior.child.signalCode !== null)
    )
      throw invalid("SINGLETON_TERMINAL_UNCONFIRMED");
    let relay;
    try {
      relay = await directory(relayRoot);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (relay && (!prior?.relay || !same(relay, prior.relay)))
      throw invalid("RELAY_OVERLAP");
    if (prior?.relay && !relay) throw invalid("RELAY_CHANGED");
    if (relay) await tree(relayRoot, true);
    if (prior) {
      if (
        auxiliaryRoot !== prior.auxiliaryRoot ||
        (auxiliary &&
          (!same(auxiliary.witness, prior.auxiliary.witness) ||
            !same(auxiliary.rootIdentity, prior.auxiliary.rootIdentity)))
      )
        throw invalid("AUXILIARY_CHANGED");
      for (const [value, info] of Object.entries(prior.directories))
        if (!same(directories[value], info)) throw invalid("DIRECTORY_CHANGED");
    }
    await recheckBindings({
      rootProof,
      proof,
      directories,
      auxiliary,
      auxiliaryRoot,
    });
    endpoint(launchOptions, fixture);
    const receipt = Object.freeze({
      kind: "isolated-native-preview-preflight",
      profileRoot,
      userData: selected,
      relayRoot,
      windowMode: "hidden",
      endpoint: env.FAROL_E2E_CHATGPT_URL,
    });
    if (previous !== undefined) admissions.delete(previous);
    admissions.set(receipt, {
      paths,
      directories,
      rootProof,
      auxiliary,
      auxiliaryRoot,
      proof,
      relayRoot,
      relay,
      fixture,
      launch: structuredClone(launchOptions),
      checked: false,
    });
    return receipt;
  } catch (error) {
    throw new Error("NATIVE_ISOLATION_NOT_ESTABLISHED", { cause: error });
  }
}

export async function recheckNativePreviewIsolation(receipt, actual, child) {
  const admitted = admissions.get(receipt);
  if (!admitted) throw invalid("RECEIPT_INVALID");
  // Consume the exact witness before checking. Failure cannot be retried or
  // turned into a fresh observation by replaying the older preflight receipt.
  admissions.delete(receipt);
  endpoint(admitted.launch, admitted.fixture);
  await recheckBindings(admitted);
  for (const key of ["home", "userData", "sessionData"]) {
    if (
      absolute(actual?.[key]) !== admitted.paths[key] ||
      (await fs.realpath(actual[key])) !== actual[key]
    )
      throw invalid(`NATIVE_PATH_CHANGED_${key}`);
  }
  // Native macOS paths may use /var rather than /private/var and retain a
  // trailing separator. Compare their physical root; launch inputs stay strict.
  const nativeTemp = actual?.temp;
  if (
    typeof nativeTemp !== "string" ||
    nativeTemp.includes("\0") ||
    !path.isAbsolute(nativeTemp)
  )
    throw invalid("PATH_INVALID");
  if ((await fs.realpath(nativeTemp)) !== path.dirname(receipt.profileRoot))
    throw invalid("NATIVE_PATH_CHANGED");
  if (
    !Array.isArray(actual?.windows) ||
    actual.windows.length === 0 ||
    actual.windows.some(
      (window) => window.visible !== false || window.focused !== false,
    )
  )
    throw invalid("NATIVE_WINDOW_CHANGED");
  // Without a child, only the original metadata-only no-link fixtures qualify.
  // Real Electron callers always supply their retained original ChildProcess.
  const resource =
    child === undefined && !admitted.child
      ? undefined
      : await singleton(admitted, actual, child);
  await tree(receipt.profileRoot, false, resource?.links);
  if (admitted.auxiliary) await tree(admitted.auxiliaryRoot);
  await recheckBindings(admitted);
  let relay;
  try {
    relay = await directory(admitted.relayRoot);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (admitted.relay && (!relay || !same(relay, admitted.relay)))
    throw invalid("RELAY_CHANGED");
  if (relay) await tree(admitted.relayRoot, true);
  await recheckSingleton(resource, child);
  // Internal witness only; callers cannot rewrite a receipt to waive a recheck.
  const observed = Object.freeze({
    ...receipt,
    kind: "isolated-native-preview-readback",
    relayObserved: relay !== undefined,
  });
  admissions.set(observed, {
    ...admitted,
    relay,
    child,
    singleton: resource,
    checked: true,
  });
  return observed;
}

// Startup can create the caller relay after the first hidden-window echo.
// Refresh the original live child's witness before Quit; reopening still needs
// the exact witnessed relay inode and a known graceful child terminal.
export async function refreshNativePreviewIsolation(receipt, application) {
  const child = application.process();
  if (child.exitCode !== null || child.signalCode !== null)
    throw invalid("LIVE_CHILD_REQUIRED");
  const actual = await application.evaluate(({ app, BrowserWindow }) => ({
    pid: process.pid,
    home: app.getPath("home"),
    userData: app.getPath("userData"),
    sessionData: app.getPath("sessionData"),
    temp: app.getPath("temp"),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused(),
    })),
  }));
  return recheckNativePreviewIsolation(receipt, actual, child);
}

// Only the already verified disposable root is eligible for startup evidence.
// Bound and type-check the opened descriptor so a substituted special object
// cannot turn diagnostic collection into a blocking stream or an outside read.
export async function readOwnedStartupMarker(stateRoot, profileRoot, pid) {
  const physical = await fs.realpath(stateRoot);
  const profile = await fs.realpath(profileRoot);
  if (!physical.startsWith(`${profile}${path.sep}`))
    throw new Error("NATIVE_STARTUP_STATE_NOT_OWNED");
  const file = path.join(physical, "running.json");
  const before = await fs.lstat(file);
  if (!before.isFile() || before.size > MAX_RUN_MARKER_BYTES)
    throw new Error("NATIVE_STARTUP_MARKER_TYPE_OR_SIZE");
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_RUN_MARKER_BYTES
    )
      throw new Error("NATIVE_STARTUP_MARKER_CHANGED");
    const buffer = Buffer.alloc(MAX_RUN_MARKER_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    const finalPath = await fs.lstat(file);
    if (
      bytesRead > MAX_RUN_MARKER_BYTES ||
      bytesRead !== after.size ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      finalPath.dev !== opened.dev ||
      finalPath.ino !== opened.ino ||
      !finalPath.isFile()
    )
      throw new Error("NATIVE_STARTUP_MARKER_CHANGED");
    const marker = RunMarkerSchema.parse(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
    );
    if (marker.pid !== pid)
      throw new Error("NATIVE_STARTUP_MARKER_WRONG_PROCESS");
    return marker;
  } finally {
    await handle.close();
  }
}
