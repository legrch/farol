import { desktopIdentity } from "../../src/apps/desktop/desktop-environment.ts";
import fs from "node:fs/promises";
import { ChildProcess, execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { once } from "node:events";
import {
  assertOwnerPreviewIdle,
  assertNativePreviewAdmission,
  recheckNativePreviewIsolation,
  refreshNativePreviewIsolation,
  readOwnedStartupMarker,
} from "../e2e/native-preview-admission.mjs";

const roots = [];
const relayChildren = [];
const runNode = promisify(execFile);

it("imports native admission through standalone Node without the test bundler", async () => {
  const module = new URL(
    "../e2e/native-preview-admission.mjs",
    import.meta.url,
  );
  const result = await runNode(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(module.href)}); process.stdout.write('imported');`,
    ],
    { timeout: 5000, maxBuffer: 8192 },
  );
  expect(result.stdout).toBe("imported");
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { child, request, terminal } of relayChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      await request({ kind: "close" });
    await terminal;
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBe(null);
  }
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-native-admission-"),
  );
  roots.push(value);
  return value;
}

describe("native owner Preview admission", () => {
  it("accepts an absent marker without creating state", async () => {
    const base = await root();
    const missing = path.join(base, "missing");
    await expect(assertOwnerPreviewIdle(missing)).resolves.toEqual({
      stateRoot: missing,
      marker: "absent",
    });
    await expect(fs.lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["regular", "symlink", "directory"])(
    "refuses an existing %s marker without changing it",
    async (kind) => {
      const base = await root();
      const marker = path.join(base, "running.json");
      if (kind === "regular")
        await fs.writeFile(marker, "private marker bytes");
      if (kind === "symlink")
        await fs.symlink(path.join(base, "not-readable-target"), marker);
      if (kind === "directory") await fs.mkdir(marker);
      const before = await fs.lstat(marker);
      await expect(assertOwnerPreviewIdle(base)).rejects.toThrow(
        "NATIVE_OWNER_PREVIEW_NOT_CONFIRMED_IDLE",
      );
      const after = await fs.lstat(marker);
      expect([after.dev, after.ino, after.size, after.mtimeMs]).toEqual([
        before.dev,
        before.ino,
        before.size,
        before.mtimeMs,
      ]);
    },
  );
  it("refuses an unavailable metadata observation", async () => {
    await expect(
      assertOwnerPreviewIdle("/fixture", async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }),
    ).rejects.toThrow("NATIVE_OWNER_PREVIEW_STATE_UNREADABLE");
  });
});

describe("owned native startup witness", () => {
  const marker = {
    schema: 1,
    pid: process.pid,
    startedAt: "2026-09-29T00:00:00.000Z",
    bootTime: null,
    processStart: null,
  };
  async function state() {
    const base = await root();
    const owned = path.join(base, "user-data/farol-state");
    await fs.mkdir(owned, { recursive: true });
    await fs.writeFile(
      path.join(owned, "running.json"),
      JSON.stringify(marker),
      { mode: 0o600 },
    );
    return { base, owned, file: path.join(owned, "running.json") };
  }
  it("correlates the actual private marker with the launched process", async () => {
    const { base, owned } = await state();
    await expect(
      readOwnedStartupMarker(owned, base, process.pid),
    ).resolves.toEqual(marker);
  });
  it("rejects an outside state root and a different process", async () => {
    const { base, owned } = await state();
    const other = await root();
    await expect(
      readOwnedStartupMarker(owned, other, process.pid),
    ).rejects.toThrow("NATIVE_STARTUP_STATE_NOT_OWNED");
    await expect(
      readOwnedStartupMarker(owned, base, process.pid + 1),
    ).rejects.toThrow("NATIVE_STARTUP_MARKER_WRONG_PROCESS");
  });
  it.each(["symlink", "directory", "oversized"])(
    "rejects a %s marker without consuming it as a stream",
    async (kind) => {
      const { base, owned, file } = await state();
      await fs.unlink(file);
      if (kind === "symlink")
        await fs.symlink(path.join(base, "missing-target"), file);
      if (kind === "directory") await fs.mkdir(file);
      if (kind === "oversized") await fs.writeFile(file, "x".repeat(4097));
      await expect(
        readOwnedStartupMarker(owned, base, process.pid),
      ).rejects.toThrow("NATIVE_STARTUP_MARKER_TYPE_OR_SIZE");
    },
  );
});

// Endpoint/singleton metadata below is synthetic. Relay provenance cases also
// run the real relay in an owned Node child; neither proves native Electron.
describe("hidden disposable Setup admission", () => {
  async function selection(environment = "preview", normalProfile = false) {
    const profileRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-e2e-home-")),
    );
    roots.push(profileRoot);
    await fs.chmod(profileRoot, 0o700);
    const proof = randomUUID();
    await fs.writeFile(path.join(profileRoot, ".farol-e2e-root"), proof, {
      mode: 0o600,
    });
    const appData = path.join(profileRoot, "app-data");
    const userData =
      environment === "dev"
        ? desktopIdentity("dev", appData).userData
        : normalProfile
          ? desktopIdentity("preview", appData).userData
          : path.join(profileRoot, "user-data");
    await fs.mkdir(appData, { mode: 0o700 });
    await fs.mkdir(userData, { mode: 0o700 });
    const fixture = new Server();
    Object.defineProperty(fixture, "listening", {
      value: true,
      configurable: true,
    });
    fixture.address = () => ({
      address: "127.0.0.1",
      port: 32123,
      family: "IPv4",
    });
    const launchOptions = {
      executablePath: "/fixture/Electron",
      args: [
        ...(normalProfile
          ? []
          : ["/fixture/main.cjs", `--user-data-dir=${userData}`]),
        "--preview-window-mode=hidden",
      ],
      env: {
        HOME: profileRoot,
        TMPDIR: os.tmpdir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "en_US.UTF-8",
        FAROL_E2E: "1",
        FAROL_E2E_APP_DATA: appData,
        FAROL_E2E_TEST_ROOT: profileRoot,
        FAROL_E2E_TEST_PROOF: proof,
        FAROL_E2E_CHATGPT_URL: "http://127.0.0.1:32123/",
        ...(environment === "dev" ? { FAROL_ENVIRONMENT: "dev" } : {}),
      },
      timeout: 15000,
    };
    return {
      profileRoot,
      proof,
      launchOptions,
      fixture,
      actual: {
        home: profileRoot,
        userData,
        sessionData: userData,
        temp: os.tmpdir(),
        windows: [{ visible: false, focused: false }],
      },
    };
  }
  const admit = (value) =>
    assertNativePreviewAdmission("/unavailable-owner-profile", value);
  // Synthetic socket metadata only: no socket/child is started or contacted.
  // The exact real resource is qualified separately by the native Setup run.
  async function singletonFixture(originalChild) {
    const selected = await selection();
    const receipt = await admit(selected);
    const child = originalChild ?? new ChildProcess();
    if (!originalChild) child.pid = 2147483000;
    selected.actual.pid = child.pid;
    const socketRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-singleton-metadata-")),
    );
    roots.push(socketRoot);
    await fs.chmod(socketRoot, 0o700);
    const cookie = "18446744073709551615";
    const links = {
      lock: path.join(selected.actual.userData, "SingletonLock"),
      cookie: path.join(selected.actual.userData, "SingletonCookie"),
      socket: path.join(selected.actual.userData, "SingletonSocket"),
      remote: path.join(socketRoot, "SingletonCookie"),
    };
    const socketPath = path.join(socketRoot, "SingletonSocket");
    await fs.symlink(`${os.hostname()}-${child.pid}`, links.lock);
    await fs.symlink(cookie, links.cookie);
    await fs.symlink(cookie, links.remote);
    await fs.symlink(socketPath, links.socket);
    await fs.writeFile(socketPath, "metadata fixture", { mode: 0o600 });
    const original = fs.lstat.bind(fs);
    const socketMetadata = vi
      .spyOn(fs, "lstat")
      .mockImplementation(async (file, ...args) => {
        const info = await original(file, ...args);
        if (file === socketPath) {
          info.mode = 0o140600;
          info.isSocket = () => true;
          info.isFile = () => false;
        }
        return info;
      });
    return {
      selected,
      receipt,
      child,
      links,
      socketRoot,
      socketPath,
      socketMetadata,
    };
  }
  it("admits only the complete singleton correlated with the original child", async () => {
    const s = await singletonFixture();
    const observed = await recheckNativePreviewIsolation(
      s.receipt,
      s.selected.actual,
      s.child,
    );
    expect(observed.kind).toBe("isolated-native-preview-readback");
    // Targets and runtime cookies never enter the returned diagnostic receipt.
    expect(JSON.stringify(observed)).not.toContain("18446744073709551615");
    expect(JSON.stringify(observed)).not.toContain(s.socketRoot);
    await expect(
      admit({ ...s.selected, previous: observed }),
    ).rejects.toThrow();
  });
  it.each([
    "unowned-child",
    "native-pid",
    "lock-pid",
    "lock-host",
    "missing-link",
    "invalid-cookie",
    "cookie-mismatch",
    "socket-file",
    "socket-hardlink",
    "socket-root-mode",
    "extra-socket-file",
    "unrelated-link",
  ])("refuses an unqualified singleton boundary: %s", async (kind) => {
    const s = await singletonFixture();
    let child = s.child;
    const replace = async (file, target) => {
      await fs.unlink(file);
      await fs.symlink(target, file);
    };
    if (kind === "unowned-child")
      child = { pid: s.child.pid, exitCode: null, signalCode: null };
    if (kind === "native-pid") s.selected.actual.pid++;
    if (kind === "lock-pid")
      await replace(s.links.lock, `${os.hostname()}-${s.child.pid + 1}`);
    if (kind === "lock-host")
      await replace(s.links.lock, `another-host-${s.child.pid}`);
    if (kind === "missing-link") await fs.unlink(s.links.cookie);
    if (kind === "invalid-cookie")
      await replace(s.links.cookie, "18446744073709551616");
    if (kind === "cookie-mismatch") await replace(s.links.remote, "1");
    if (kind === "socket-file") s.socketMetadata.mockRestore();
    if (kind === "socket-hardlink")
      await fs.link(s.socketPath, path.join(await root(), "alias"));
    if (kind === "socket-root-mode") await fs.chmod(s.socketRoot, 0o755);
    if (kind === "extra-socket-file")
      await fs.writeFile(path.join(s.socketRoot, "other"), "synthetic");
    if (kind === "unrelated-link")
      await fs.symlink(
        "/outside",
        path.join(s.selected.actual.userData, "other"),
      );
    await expect(
      recheckNativePreviewIsolation(s.receipt, s.selected.actual, child),
    ).rejects.toThrow();
    await expect(
      recheckNativePreviewIsolation(s.receipt, s.selected.actual, s.child),
    ).rejects.toThrow("RECEIPT_INVALID");
  });
  it("refuses singleton links without any original child witness", async () => {
    const s = await singletonFixture();
    await expect(
      recheckNativePreviewIsolation(s.receipt, s.selected.actual),
    ).rejects.toThrow("TREE_UNSAFE");
  });
  it("refuses an additional directory alias in the native socket target", async () => {
    const s = await singletonFixture();
    const alias = s.socketRoot + "-alias";
    roots.push(alias);
    await fs.symlink(s.socketRoot, alias);
    await fs.unlink(s.links.socket);
    await fs.symlink(path.join(alias, "SingletonSocket"), s.links.socket);
    await expect(
      recheckNativePreviewIsolation(s.receipt, s.selected.actual, s.child),
    ).rejects.toThrow("SINGLETON_SOCKET_OUTSIDE_TEMP");
  });
  it.each(["target-resolution", "directory-entries"])(
    "rechecks the original socket boundary before accepting: %s",
    async (kind) => {
      const s = await singletonFixture();
      let observations = 0;
      if (kind === "target-resolution") {
        const original = fs.realpath.bind(fs);
        vi.spyOn(fs, "realpath").mockImplementation(async (file, ...args) => {
          if (file === s.socketPath && ++observations === 3)
            return "/outside/SingletonSocket";
          return original(file, ...args);
        });
      } else {
        const original = fs.readdir.bind(fs);
        vi.spyOn(fs, "readdir").mockImplementation(async (file, ...args) => {
          if (file === s.socketRoot && ++observations === 2)
            return ["SingletonCookie", "SingletonSocket", "other"];
          return original(file, ...args);
        });
      }
      await expect(
        recheckNativePreviewIsolation(s.receipt, s.selected.actual, s.child),
      ).rejects.toThrow("SINGLETON_CHANGED");
      await expect(
        recheckNativePreviewIsolation(s.receipt, s.selected.actual, s.child),
      ).rejects.toThrow("RECEIPT_INVALID");
    },
  );
  it.each(["link-replaced", "different-child", "early-exit"])(
    "refuses changed retained singleton correlation: %s",
    async (kind) => {
      const s = await singletonFixture();
      const observed = await recheckNativePreviewIsolation(
        s.receipt,
        s.selected.actual,
        s.child,
      );
      let child = s.child;
      if (kind === "link-replaced") {
        const target = await fs.readlink(s.links.cookie);
        await fs.unlink(s.links.cookie);
        await fs.symlink(target, s.links.cookie);
      }
      if (kind === "different-child") {
        child = new ChildProcess();
        child.pid = s.child.pid;
      }
      if (kind === "early-exit") s.child.exitCode = 1;
      await expect(
        recheckNativePreviewIsolation(observed, s.selected.actual, child),
      ).rejects.toThrow();
    },
  );
  // Bundle the actual product relay for a separate Node process. The child
  // executes refresh's serialized readback; app/window objects alone are doubles.
  async function relayFixture() {
    const folder = await root();
    const entry = path.join(folder, "relay-child.cjs");
    await build({
      stdin: {
        contents: `
          import { startCodexCallerRelay } from ${JSON.stringify(path.resolve("src/apps/desktop/codex-caller-relay.ts"))};
          let relay;
          process.on("message", async (message) => {
            try {
              let result;
              if (message.kind === "start") {
                // Darwin's native temp path uses the shorter /var alias. Keep
                // the socket below the unchanged 100-byte limit, same inode.
                const root = process.platform === "darwin"
                  ? message.root.replace("/private/var/", "/var/") : message.root;
                relay = await startCodexCallerRelay({ root });
                result = relay.directoryWitness();
              } else if (message.kind === "evaluate") {
                const app = {
                  getPath: (key) => message.actual[key],
                  get __farolE2ERelayDirectory() { return relay?.directoryWitness() ?? null; },
                };
                result = await (0, eval)("(" + message.callback + ")")({
                  app, BrowserWindow: { getAllWindows: () => [{ isVisible: () => false, isFocused: () => false }] },
                });
              } else if (message.kind === "close") {
                await relay?.close();
              }
              process.send({ result }, () => { if (message.kind === "close") process.disconnect(); });
            } catch (error) { process.send({ error: error.message }); }
          });
        `,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: entry,
    });
    const child = fork(entry, [], {
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const terminal = once(child, "exit");
    const request = async (message) => {
      const answer = once(child, "message", {
        signal: AbortSignal.timeout(5000),
      });
      child.send(message);
      const [response] = await answer;
      if (response.error) throw Error(response.error);
      return response.result;
    };
    relayChildren.push({ child, terminal, request });
    const s = await singletonFixture(child);
    const early = await recheckNativePreviewIsolation(
      s.receipt,
      s.selected.actual,
      child,
    );
    const application = {
      process: () => child,
      evaluate: (callback) =>
        request({
          kind: "evaluate",
          callback: callback.toString(),
          actual: s.selected.actual,
        }),
    };
    roots.push(early.relayRoot);
    return { ...s, early, application, request, terminal, folder };
  }
  it("accepts only a child-created late relay and preserves its identity through Quit", async () => {
    const s = await relayFixture();
    expect(s.early.relayObserved).toBe(false);
    const own = await s.request({ kind: "start", root: s.early.relayRoot });
    expect(own.created).toBe(true);
    expect(own.pid).toBe(s.child.pid);
    expect(own.birthtimeMs).toBeGreaterThanOrEqual(own.processStartedAtMs);
    const ready = await refreshNativePreviewIsolation(s.early, s.application);
    expect(ready.relayObserved).toBe(true);
    await s.request({ kind: "close" });
    await s.terminal;
    for (const file of [s.links.lock, s.links.cookie, s.links.socket])
      await fs.unlink(file);
    const closed = await recheckNativePreviewIsolation(
      ready,
      s.selected.actual,
      s.child,
    );
    await expect(
      refreshNativePreviewIsolation(closed, s.application),
    ).rejects.toThrow("LIVE_CHILD_REQUIRED");
    await expect(
      admit({ ...s.selected, previous: closed }),
    ).resolves.toBeDefined();
  });
  it.each(["harness-created", "replaced", "foreign-owner"])(
    "refuses a live child's unqualified relay: %s",
    async (kind) => {
      const s = await relayFixture();
      if (kind === "harness-created")
        await fs.mkdir(s.early.relayRoot, { mode: 0o700 });
      const own = await s.request({ kind: "start", root: s.early.relayRoot });
      expect(own.created).toBe(kind !== "harness-created");
      if (kind === "replaced") {
        await fs.rename(
          s.early.relayRoot,
          path.join(s.folder, "original-relay"),
        );
        await fs.mkdir(s.early.relayRoot, { mode: 0o700 });
      }
      if (kind === "foreign-owner") {
        const original = s.socketMetadata.getMockImplementation();
        s.socketMetadata.mockImplementation(async (file, ...args) => {
          const info = await original(file, ...args);
          if (file === s.early.relayRoot) info.uid += 1;
          return info;
        });
      }
      await expect(
        refreshNativePreviewIsolation(s.early, s.application),
      ).rejects.toThrow(
        kind === "foreign-owner"
          ? "DIRECTORY_UNSAFE"
          : "RELAY_CHILD_UNCONFIRMED",
      );
      await expect(
        admit({ ...s.selected, previous: s.early }),
      ).rejects.toThrow();
    },
  );
  it.each([
    "missing",
    "wrong-pid",
    "pre-start",
    "future-observation",
    "during-refresh",
  ])("requires a complete, timed child readback: %s", async (kind) => {
    const s = await relayFixture();
    if (kind !== "during-refresh")
      await s.request({ kind: "start", root: s.early.relayRoot });
    const evaluate = s.application.evaluate;
    s.application.evaluate = async (callback) => {
      if (kind === "during-refresh")
        await s.request({ kind: "start", root: s.early.relayRoot });
      const actual = await evaluate(callback);
      if (kind === "missing") actual.relay = null;
      if (kind === "wrong-pid") actual.relay.pid++;
      if (kind === "pre-start")
        actual.relay.processStartedAtMs = actual.relay.birthtimeMs + 1;
      if (kind === "future-observation") actual.relay.observedAtMs += 60000;
      return actual;
    };
    await expect(
      refreshNativePreviewIsolation(s.early, s.application),
    ).rejects.toThrow("RELAY_CHILD_UNCONFIRMED");
  });
  it("refuses another application before dispatch and consumes a failed readback", async () => {
    const s = await singletonFixture();
    const early = await recheckNativePreviewIsolation(
      s.receipt,
      s.selected.actual,
      s.child,
    );
    const evaluate = vi.fn(async () => {
      throw Error("synthetic readback unknown");
    });
    await expect(
      refreshNativePreviewIsolation(early, {
        process: () => new ChildProcess(),
        evaluate,
      }),
    ).rejects.toThrow("SINGLETON_CHILD_UNOWNED");
    expect(evaluate).not.toHaveBeenCalled();
    const application = { process: () => s.child, evaluate };
    await expect(
      refreshNativePreviewIsolation(early, application),
    ).rejects.toThrow("synthetic readback unknown");
    await expect(
      refreshNativePreviewIsolation(early, application),
    ).rejects.toThrow("RECEIPT_INVALID");
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it("refuses directory replacement between refresh and Quit", async () => {
    const s = await relayFixture();
    await s.request({ kind: "start", root: s.early.relayRoot });
    const ready = await refreshNativePreviewIsolation(s.early, s.application);
    await s.request({ kind: "close" });
    await s.terminal;
    for (const file of [s.links.lock, s.links.cookie, s.links.socket])
      await fs.unlink(file);
    await fs.rename(ready.relayRoot, path.join(s.folder, "original-relay"));
    await fs.mkdir(ready.relayRoot, { mode: 0o700 });
    await expect(
      recheckNativePreviewIsolation(ready, s.selected.actual, s.child),
    ).rejects.toThrow("RELAY_CHANGED");
  });
  it("requires known graceful terminal and absent singleton before reopen", async () => {
    const s = await singletonFixture();
    const observed = await recheckNativePreviewIsolation(
      s.receipt,
      s.selected.actual,
      s.child,
    );
    s.child.exitCode = 0;
    await expect(
      admit({ ...s.selected, previous: observed }),
    ).rejects.toThrow();
    for (const file of [s.links.lock, s.links.cookie, s.links.socket])
      await fs.unlink(file);
    const closed = await recheckNativePreviewIsolation(
      observed,
      s.selected.actual,
      s.child,
    );
    await expect(
      admit({ ...s.selected, previous: closed }),
    ).resolves.toBeDefined();
  });
  it("accepts a native temp separator only with the same physical root", async () => {
    const selected = await selection();
    const receipt = await admit(selected);
    selected.actual.temp = `${selected.actual.temp}${path.sep}`;
    await expect(
      recheckNativePreviewIsolation(receipt, selected.actual),
    ).resolves.toMatchObject({ kind: "isolated-native-preview-readback" });
  });
  it.each(["relative", "nul", "missing"])(
    "refuses malformed native temp readback: %s",
    async (kind) => {
      const selected = await selection();
      const receipt = await admit(selected);
      selected.actual.temp =
        kind === "relative" ? "T/" : kind === "nul" ? "/tmp\0/" : undefined;
      await expect(
        recheckNativePreviewIsolation(receipt, selected.actual),
      ).rejects.toThrow("NATIVE_ISOLATION_PATH_INVALID");
    },
  );
  it.each([
    ["preview", false],
    ["dev", false],
    ["preview", true],
  ])(
    "admits %s (normal profile %s) without observing the owner's state",
    async (environment, normal) => {
      const selected = await selection(environment, normal);
      const receipt = await admit(selected);
      expect(receipt.kind).toBe("isolated-native-preview-preflight");
      expect(Object.isFrozen(receipt)).toBe(true);
      const observed = await recheckNativePreviewIsolation(
        receipt,
        selected.actual,
      );
      expect(Object.isFrozen(observed)).toBe(true);
      expect(observed.kind).toBe("isolated-native-preview-readback");
      await expect(
        admit({ ...selected, previous: observed }),
      ).resolves.toMatchObject({ profileRoot: selected.profileRoot });
    },
  );
  it("retains the owner-idle requirement for a non-isolated caller", async () => {
    const base = await root();
    await fs.writeFile(
      path.join(base, "running.json"),
      "unreadable-by-contract",
    );
    await expect(assertNativePreviewAdmission(base)).rejects.toThrow(
      "NATIVE_OWNER_PREVIEW_NOT_CONFIRMED_IDLE",
    );
    await expect(assertNativePreviewAdmission(base, null)).rejects.toThrow(
      "NATIVE_ISOLATION_NOT_ESTABLISHED",
    );
  });
  it.each([
    [
      "disabled E2E",
      (s) => {
        s.launchOptions.env.FAROL_E2E = "0";
      },
    ],
    [
      "borrowed HOME",
      (s) => {
        s.launchOptions.env.HOME = "/owner";
      },
    ],
    [
      "foreign appData",
      (s) => {
        s.launchOptions.env.FAROL_E2E_APP_DATA = "/owner/app-data";
      },
    ],
    [
      "proof mismatch",
      (s) => {
        s.launchOptions.env.FAROL_E2E_TEST_PROOF = randomUUID();
      },
    ],
    [
      "credential environment",
      (s) => {
        s.launchOptions.env.CODEX_HOME = "/owner/.codex";
      },
    ],
    [
      "loader injection",
      (s) => {
        s.launchOptions.env.NODE_OPTIONS = "--require /owner/hook";
      },
    ],
    [
      "unknown environment",
      (s) => {
        s.launchOptions.env.FAROL_ENVIRONMENT = "production";
      },
    ],
    [
      "outside temp",
      (s) => {
        s.launchOptions.env.TMPDIR = s.profileRoot;
      },
    ],
    [
      "visible mode",
      (s) => {
        s.launchOptions.args[s.launchOptions.args.length - 1] =
          "--preview-window-mode=secondary-visible";
      },
    ],
    [
      "duplicate hidden mode",
      (s) => {
        s.launchOptions.args.push("--preview-window-mode=hidden");
      },
    ],
    [
      "unknown launch flag",
      (s) => {
        s.launchOptions.args.push("--remote-debugging-port=1234");
      },
    ],
    [
      "foreign userData",
      (s) => {
        s.launchOptions.args[1] = "--user-data-dir=/owner";
      },
    ],
    [
      "public Browser URL",
      (s) => {
        s.launchOptions.env.FAROL_E2E_CHATGPT_URL = "https://chatgpt.com/";
      },
    ],
    [
      "wrong fixture port",
      (s) => {
        s.launchOptions.env.FAROL_E2E_CHATGPT_URL = "http://127.0.0.1:32124/";
      },
    ],
    [
      "fixture credentials",
      (s) => {
        s.launchOptions.env.FAROL_E2E_CHATGPT_URL =
          "http://user:secret@127.0.0.1:32123/";
      },
    ],
    [
      "unowned fixture",
      (s) => {
        s.fixture = {
          listening: true,
          address: () => ({ address: "127.0.0.1", port: 32123 }),
        };
      },
    ],
    [
      "unbound fixture",
      (s) => {
        Object.defineProperty(s.fixture, "listening", { value: false });
      },
    ],
    [
      "nonloopback bind",
      (s) => {
        s.fixture.address = () => ({ address: "0.0.0.0", port: 32123 });
      },
    ],
    [
      "unowned workspace",
      (s) => {
        s.launchOptions.env.FAROL_E2E_WORKSPACE_ROOT = "/owner/work";
      },
    ],
    [
      "unowned executable",
      (s) => {
        s.launchOptions.env.FAROL_E2E_TUNNEL_CLIENT = "/owner/client";
      },
    ],
  ])("refuses %s before launch", async (_name, change) => {
    const selected = await selection();
    change(selected);
    await expect(admit(selected)).rejects.toThrow(
      "NATIVE_ISOLATION_NOT_ESTABLISHED",
    );
  });
  it.each([
    "root-mode",
    "proof-mode",
    "proof-link",
    "proof-hardlink",
    "home-link",
    "descendant-link",
    "descendant-hardlink",
  ])("refuses unsafe %s metadata", async (kind) => {
    const selected = await selection();
    const file = path.join(selected.profileRoot, ".farol-e2e-root");
    const other = await root();
    if (kind === "root-mode") await fs.chmod(selected.profileRoot, 0o755);
    if (kind === "proof-mode") await fs.chmod(file, 0o644);
    if (kind === "proof-link") {
      await fs.rename(file, path.join(other, "proof"));
      await fs.symlink(path.join(other, "proof"), file);
    }
    if (kind === "proof-hardlink")
      await fs.link(file, path.join(other, "borrowed-proof"));
    if (kind === "home-link") {
      await fs.symlink(selected.profileRoot, path.join(other, "home"));
      selected.profileRoot =
        selected.launchOptions.env.HOME =
        selected.launchOptions.env.FAROL_E2E_TEST_ROOT =
          path.join(other, "home");
    }
    if (kind === "descendant-link")
      await fs.symlink(other, path.join(selected.actual.userData, "foreign"));
    if (kind === "descendant-hardlink") {
      const source = path.join(other, "credential");
      await fs.writeFile(source, "synthetic");
      await fs.link(source, path.join(selected.actual.userData, "borrowed"));
    }
    await expect(admit(selected)).rejects.toThrow(
      "NATIVE_ISOLATION_NOT_ESTABLISHED",
    );
  });
  it("refuses a correctly named proof root outside OS temp", async () => {
    const selected = await selection();
    const outside = path.join(
      await root(),
      path.basename(selected.profileRoot),
    );
    await fs.rename(selected.profileRoot, outside);
    selected.profileRoot =
      selected.launchOptions.env.HOME =
      selected.launchOptions.env.FAROL_E2E_TEST_ROOT =
        outside;
    await expect(admit(selected)).rejects.toThrow(
      "NATIVE_ISOLATION_NOT_ESTABLISHED",
    );
  });
  it("binds auxiliary workspace and tunnel fixture metadata", async () => {
    const selected = await selection();
    const auxiliaryRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-guided-setup-")),
    );
    roots.push(auxiliaryRoot);
    await fs.chmod(auxiliaryRoot, 0o700);
    await fs.writeFile(
      path.join(auxiliaryRoot, ".farol-e2e-root"),
      selected.proof,
      { mode: 0o600 },
    );
    const workspace = path.join(auxiliaryRoot, "approved-folder");
    const tunnel = path.join(auxiliaryRoot, "tunnel-client.cjs");
    await fs.mkdir(workspace, { mode: 0o700 });
    await fs.writeFile(tunnel, "synthetic executable", { mode: 0o700 });
    selected.auxiliaryRoot = auxiliaryRoot;
    selected.launchOptions.env.FAROL_E2E_WORKSPACE_ROOT = workspace;
    selected.launchOptions.env.FAROL_E2E_TUNNEL_CLIENT = tunnel;
    const receipt = await admit(selected);
    const observed = await recheckNativePreviewIsolation(
      receipt,
      selected.actual,
    );
    await fs.unlink(tunnel);
    await fs.symlink("/outside", tunnel);
    await expect(
      recheckNativePreviewIsolation(observed, selected.actual),
    ).rejects.toThrow("NATIVE_ISOLATION_TREE_UNSAFE");
  });
  it.each([
    "home",
    "userData",
    "sessionData",
    "temp",
    "visible",
    "focused",
    "no-windows",
    "proof",
    "directory",
    "endpoint",
  ])("rejects changed %s readback", async (kind) => {
    const selected = await selection();
    const receipt = await admit(selected);
    if (["home", "userData", "sessionData", "temp"].includes(kind))
      selected.actual[kind] = await root();
    if (kind === "visible") selected.actual.windows[0].visible = true;
    if (kind === "focused") selected.actual.windows[0].focused = true;
    if (kind === "no-windows") selected.actual.windows = [];
    if (kind === "proof")
      await fs.writeFile(
        path.join(selected.profileRoot, ".farol-e2e-root"),
        selected.proof,
      );
    if (kind === "directory") {
      await fs.rename(
        selected.actual.userData,
        selected.actual.userData + "-previous",
      );
      await fs.mkdir(selected.actual.userData, { mode: 0o700 });
    }
    if (kind === "endpoint")
      Object.defineProperty(selected.fixture, "listening", { value: false });
    await expect(
      recheckNativePreviewIsolation(receipt, selected.actual),
    ).rejects.toThrow();
  });
  it("requires a verified immutable predecessor receipt for reopen", async () => {
    const selected = await selection();
    const receipt = await admit(selected);
    await expect(admit({ ...selected, previous: receipt })).rejects.toThrow(
      "NATIVE_ISOLATION_NOT_ESTABLISHED",
    );
    await expect(
      recheckNativePreviewIsolation({ ...receipt }, selected.actual),
    ).rejects.toThrow("NATIVE_ISOLATION_RECEIPT_INVALID");
    const observed = await recheckNativePreviewIsolation(
      receipt,
      selected.actual,
    );
    await expect(
      admit({ ...selected, previous: { ...observed } }),
    ).rejects.toThrow("NATIVE_ISOLATION_NOT_ESTABLISHED");
    await expect(
      admit({ ...(await selection()), previous: observed }),
    ).rejects.toThrow("NATIVE_ISOLATION_NOT_ESTABLISHED");
  });
  it("consumes readback witnesses even when validation fails", async () => {
    const selected = await selection();
    const receipt = await admit(selected);
    selected.actual.windows[0].visible = true;
    await expect(
      recheckNativePreviewIsolation(receipt, selected.actual),
    ).rejects.toThrow("NATIVE_ISOLATION_NATIVE_WINDOW_CHANGED");
    selected.actual.windows[0].visible = false;
    await expect(
      recheckNativePreviewIsolation(receipt, selected.actual),
    ).rejects.toThrow("NATIVE_ISOLATION_RECEIPT_INVALID");
    const fresh = await admit(selected);
    const observed = await recheckNativePreviewIsolation(
      fresh,
      selected.actual,
    );
    await expect(
      recheckNativePreviewIsolation(fresh, selected.actual),
    ).rejects.toThrow("NATIVE_ISOLATION_RECEIPT_INVALID");
    await expect(
      admit({ ...selected, previous: observed }),
    ).resolves.toBeDefined();
    await expect(admit({ ...selected, previous: observed })).rejects.toThrow(
      "NATIVE_ISOLATION_NOT_ESTABLISHED",
    );
  });
  it("refuses a marker in its disposable profile without reading it", async () => {
    const selected = await selection();
    const stateRoot = path.join(selected.actual.userData, "farol-state");
    await fs.mkdir(stateRoot, { mode: 0o700 });
    const file = path.join(stateRoot, "running.json");
    await fs.writeFile(file, "synthetic unknown prior run", { mode: 0o600 });
    const before = await fs.lstat(file);
    await expect(admit(selected)).rejects.toMatchObject({
      cause: { message: "NATIVE_ISOLATION_PRIOR_RUN_UNCONFIRMED" },
    });
    expect((await fs.lstat(file)).ino).toBe(before.ino);
  });
  it.each(["foreign-owner", "unreadable"])(
    "refuses %s metadata",
    async (kind) => {
      const selected = await selection();
      const original = fs.lstat.bind(fs);
      const observation = vi
        .spyOn(fs, "lstat")
        .mockImplementation(async (file, ...args) => {
          if (file !== selected.profileRoot) return original(file, ...args);
          if (kind === "unreadable")
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          const info = await original(file, ...args);
          info.uid += 1;
          return info;
        });
      try {
        await expect(admit(selected)).rejects.toThrow(
          "NATIVE_ISOLATION_NOT_ESTABLISHED",
        );
      } finally {
        observation.mockRestore();
      }
    },
  );
  it.each(["FAROL_MODEL_ENABLED", "FAROL_BACKED_PRODUCT_AGENT_ENABLED"])(
    "refuses an enabled %s source gate",
    async (gate) => {
      const selected = await selection();
      vi.resetModules();
      vi.doMock("../../src/apps/desktop/foundation-feature-gates.ts", () => ({
        FAROL_MODEL_ENABLED: gate === "FAROL_MODEL_ENABLED",
        FAROL_BACKED_PRODUCT_AGENT_ENABLED:
          gate === "FAROL_BACKED_PRODUCT_AGENT_ENABLED",
      }));
      try {
        const guarded = await import("../e2e/native-preview-admission.mjs");
        await expect(
          guarded.assertNativePreviewAdmission(
            "/unavailable-owner-profile",
            selected,
          ),
        ).rejects.toMatchObject({
          cause: { message: "NATIVE_ISOLATION_MODEL_GATE_CHANGED" },
        });
      } finally {
        vi.doUnmock("../../src/apps/desktop/foundation-feature-gates.ts");
        vi.resetModules();
      }
    },
  );
  it("refuses a pre-existing relay namespace without reading its contents", async () => {
    const selected = await selection();
    const receipt = await admit(selected);
    await fs.mkdir(receipt.relayRoot, { mode: 0o700 });
    roots.push(receipt.relayRoot);
    await expect(admit(selected)).rejects.toMatchObject({
      cause: { message: "NATIVE_ISOLATION_RELAY_OVERLAP" },
    });
    await expect(
      recheckNativePreviewIsolation(receipt, selected.actual),
    ).rejects.toThrow("RELAY_CHILD_UNCONFIRMED");
  });
});
