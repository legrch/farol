import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createE2EWindowObserver,
  E2E_WINDOW_LIFETIME_PREFIX,
  E2E_WINDOW_LIFETIME_SCHEMA,
  type E2EWindowLifetimeFrame,
  type E2EWindowObserverPorts,
  type FrozenSnapshot,
  type WindowPort,
} from "../../apps/desktop/bridge/e2e-window-observer.ts";
import type { E2EWindowBootstrapPorts } from "../../apps/desktop/bridge/e2e-window-bootstrap.ts";

// Consumer-owned port fixtures only; no Electron runtime or native window proof.
const electron = vi.hoisted(() => ({
  app: { on: vi.fn(), once: vi.fn(), getPath: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  writeSync: vi.fn((_fd: number, line: string) => line.length),
}));
vi.mock("electron", () => electron);
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  writeSync: electron.writeSync,
}));

function windowFixture(id = 1) {
  const listeners = new Map<string, () => void>();
  const window = {
    id,
    isVisible: vi.fn(() => false),
    isFocused: vi.fn(() => false),
    on: vi.fn((event: string, listen: () => void) => {
      listeners.set(event, listen);
    }),
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
  };
  return { window, fire: (event: string) => listeners.get(event)?.() };
}

function observerFixture(overrides: Partial<E2EWindowObserverPorts> = {}) {
  const frames: E2EWindowLifetimeFrame[] = [];
  let created: (window: WindowPort) => void = () => {
    throw new Error("not subscribed");
  };
  const observer = createE2EWindowObserver({
    pid: 1234,
    existingWindows: () => [],
    subscribeCreated: (listen) => {
      created = listen;
    },
    publish: (frame) => {
      frames.push(frame);
    },
    ...overrides,
  });
  return { observer, frames, created: (window: WindowPort) => created(window) };
}

const snapshotKeys = [
  "schema",
  "pid",
  "sequence",
  "priorWindows",
  "createdWindows",
  "openWindows",
  "violations",
  "overflow",
  "observerFault",
].sort();

describe("early window lifetime observer", () => {
  it("publishes exact frozen content-free envelopes with bounded counters", () => {
    const f = observerFixture();
    expect(f.observer.snapshot()).toEqual({
      schema: E2E_WINDOW_LIFETIME_SCHEMA,
      pid: 1234,
      sequence: 1,
      priorWindows: 0,
      createdWindows: 0,
      openWindows: 0,
      violations: 0,
      overflow: false,
      observerFault: false,
    });
    expect(Object.keys(f.observer.snapshot()).sort()).toEqual(snapshotKeys);
    expect(Object.keys(f.frames[0]!).sort()).toEqual(
      [...snapshotKeys, "event", "exitCode"].sort(),
    );
    expect(f.frames[0]).toMatchObject({ event: "armed", exitCode: null });
    expect(Object.isFrozen(f.frames[0])).toBe(true);
    expect(Object.isFrozen(f.observer)).toBe(true);
  });

  it("retains a brief show then hide and focus before driver attach", () => {
    const f = observerFixture();
    const w = windowFixture();
    f.created(w.window);
    w.fire("show");
    w.window.isVisible.mockReturnValue(false); // Product hides before attach.
    w.fire("focus");
    const snapshot = f.observer.snapshot();
    expect(snapshot).toMatchObject({
      createdWindows: 1,
      openWindows: 1,
      violations: 2,
    });
    expect(f.frames.map((frame) => frame.event)).toEqual([
      "armed",
      "created",
      "show",
      "focus",
    ]);
    expect(f.frames.map((frame) => frame.sequence)).toEqual([1, 2, 3, 4]);
    expect(w.window.hide).not.toHaveBeenCalled();
    expect(w.window.show).not.toHaveBeenCalled();
    expect(w.window.focus).not.toHaveBeenCalled();
    expect(w.window.close).not.toHaveBeenCalled();
    expect(w.window.destroy).not.toHaveBeenCalled();
  });

  it("counts an extra early window even after it closes", () => {
    const f = observerFixture();
    const shell = windowFixture();
    const extra = windowFixture(2);
    f.created(shell.window);
    f.created(extra.window);
    extra.fire("show");
    extra.fire("closed");
    expect(f.observer.snapshot()).toMatchObject({
      createdWindows: 2,
      openWindows: 1,
      violations: 1,
    });
    shell.fire("closed");
    expect(f.observer.snapshot().openWindows).toBe(0);
    extra.fire("closed");
    expect(f.observer.snapshot()).toMatchObject({
      openWindows: 0,
      observerFault: true,
    });
  });

  it("subscribes before enumeration and marks prior windows as late arming", () => {
    const order: string[] = [];
    const w = windowFixture();
    w.window.isVisible.mockReturnValue(true);
    w.window.isFocused.mockReturnValue(true);
    const f = observerFixture({
      subscribeCreated: () => {
        order.push("subscribe");
      },
      existingWindows: () => {
        order.push("enumerate");
        return [w.window];
      },
    });
    expect(order).toEqual(["subscribe", "enumerate"]);
    expect(f.observer.snapshot()).toMatchObject({
      priorWindows: 1,
      createdWindows: 0,
      openWindows: 1,
      violations: 2,
    });
    expect(w.window.on.mock.calls.map(([event]) => event)).toEqual([
      "show",
      "focus",
      "closed",
    ]);
    expect(w.window.on.mock.invocationCallOrder.at(-1)).toBeLessThan(
      w.window.isVisible.mock.invocationCallOrder[0]!,
    );
    w.fire("focus");
    expect(f.observer.snapshot().violations).toBe(3);
  });

  it("captures creation during enumeration and cannot silently arm late", () => {
    const w = windowFixture();
    let created: (window: WindowPort) => void = () => {};
    const f = observerFixture({
      subscribeCreated: (listen) => {
        created = listen;
      },
      existingWindows: () => {
        created(w.window);
        return [w.window];
      },
    });
    expect(f.observer.snapshot()).toMatchObject({
      priorWindows: 1,
      createdWindows: 1,
      observerFault: true,
    });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    undefined,
  ])("fails closed on malformed native ID %s", (id) => {
    const f = observerFixture();
    f.created({ ...windowFixture().window, id } as WindowPort);
    expect(f.observer.snapshot()).toMatchObject({
      observerFault: true,
      openWindows: 0,
    });
    f.created(windowFixture(2).window);
    expect(f.observer.snapshot().observerFault).toBe(true);
  });

  it("rejects duplicate IDs, including closed IDs, without double bookkeeping", () => {
    const f = observerFixture();
    const first = windowFixture();
    f.created(first.window);
    first.fire("closed");
    const duplicate = windowFixture();
    f.created(duplicate.window);
    expect(f.observer.snapshot()).toMatchObject({
      observerFault: true,
      createdWindows: 2,
      openWindows: 0,
    });
    expect(duplicate.window.on).not.toHaveBeenCalled();
  });

  it("bounds distinct lifetime windows at 64 even after close and retains overflow", () => {
    const f = observerFixture();
    for (let id = 1; id <= 64; id++) {
      const w = windowFixture(id);
      f.created(w.window);
      w.fire("closed");
    }
    expect(f.observer.snapshot()).toMatchObject({
      createdWindows: 64,
      openWindows: 0,
      overflow: false,
    });
    const extra = windowFixture(65);
    f.created(extra.window);
    expect(extra.window.on).not.toHaveBeenCalled();
    f.observer.terminal("node-exit", 0);
    expect(f.observer.snapshot()).toMatchObject({
      createdWindows: 65,
      overflow: true,
    });
  });

  it.each(["subscribeCreated", "existingWindows", "publish"] as const)(
    "retains %s exceptions without leaking them through product callbacks",
    (port) => {
      const f = observerFixture({
        [port]: () => {
          throw new Error("private exception content");
        },
      });
      expect(f.observer.snapshot().observerFault).toBe(true);
      if (port !== "subscribeCreated") {
        expect(() => f.created(windowFixture().window)).not.toThrow();
      }
      expect(() => f.observer.terminal("app-quit", 0)).not.toThrow();
      expect(f.observer.snapshot().observerFault).toBe(true);
      expect(JSON.stringify(f.observer.snapshot())).not.toContain("private");
    },
  );

  it("keeps publish failures sticky when later publishing succeeds", () => {
    const frames: E2EWindowLifetimeFrame[] = [];
    let fail = true;
    const f = observerFixture({
      publish: (frame) => {
        if (fail) throw new Error("write");
        frames.push(frame);
      },
    });
    fail = false;
    f.created(windowFixture().window);
    expect(frames[0]).toMatchObject({
      event: "created",
      sequence: 2,
      observerFault: true,
    });
  });

  it.each(["id", "on", "isVisible", "isFocused"] as const)(
    "contains window %s errors and keeps observing available events",
    (member) => {
      const f = observerFixture();
      const w = windowFixture();
      if (member === "id")
        Object.defineProperty(w.window, "id", {
          get: () => {
            throw new Error("id");
          },
        });
      else
        w.window[member].mockImplementation(() => {
          throw new Error(member);
        });
      expect(() => f.created(w.window)).not.toThrow();
      expect(f.observer.snapshot().observerFault).toBe(true);
      if (member !== "id") {
        expect(w.window.on).toHaveBeenCalledTimes(3);
        expect(w.window.isVisible).toHaveBeenCalled();
        expect(w.window.isFocused).toHaveBeenCalled();
      }
      expect(() => w.fire("focus")).not.toThrow();
      expect(f.observer.snapshot().observerFault).toBe(true);
    },
  );

  it("marks malformed visibility samples and post-close events as faults", () => {
    const f = observerFixture();
    const w = windowFixture();
    f.created({ ...w.window, isVisible: () => "false" as unknown as boolean });
    w.fire("closed");
    w.fire("show");
    expect(f.observer.snapshot()).toMatchObject({
      observerFault: true,
      openWindows: 0,
      violations: 1,
    });
  });

  it("cannot mutate or reset earlier snapshots or terminal evidence", () => {
    const f = observerFixture();
    const w = windowFixture();
    f.created(w.window);
    const prior = f.observer.snapshot();
    expect(Object.isFrozen(prior)).toBe(true);
    expect(Reflect.set(prior, "violations", 0)).toBe(false);
    f.observer.terminal("node-exit", 7);
    w.fire("show"); // Observation continues after either terminal kind.
    f.observer.terminal("app-quit", 9);
    w.fire("focus");
    expect(prior).toMatchObject({ sequence: 2, violations: 0 });
    expect(f.frames.slice(2)).toMatchObject([
      {
        event: "node-exit",
        exitCode: 7,
        pid: 1234,
        createdWindows: 1,
        violations: 0,
      },
      { event: "show", exitCode: null, violations: 1 },
      {
        event: "app-quit",
        exitCode: 9,
        pid: 1234,
        createdWindows: 1,
        violations: 1,
      },
      { event: "focus", exitCode: null, violations: 2 },
    ]);
    expect(Object.keys(f.observer).sort()).toEqual(["snapshot", "terminal"]);
  });

  it("fails closed on malformed PID and terminal code without unbounded numbers", () => {
    const f = observerFixture({ pid: Number.NaN });
    f.observer.terminal("node-exit", Number.POSITIVE_INFINITY);
    expect(f.frames.at(-1)).toMatchObject({
      pid: 0,
      exitCode: 0,
      observerFault: true,
    });
  });
});

const temporaryRoots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function proofFixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "farol-e2e-home-")),
  );
  temporaryRoots.push(root);
  fs.chmodSync(root, 0o700);
  const home = path.join(root, "home");
  const library = path.join(home, "Library");
  const appData = path.join(library, "Application Support");
  for (const directory of [home, library, appData])
    fs.mkdirSync(directory, { mode: 0o700 });
  const proof: string = randomUUID();
  fs.writeFileSync(path.join(root, ".farol-e2e-root"), proof, { mode: 0o600 });
  return {
    FAROL_E2E: "1",
    HOME: home,
    FAROL_E2E_APP_DATA: appData,
    FAROL_E2E_TEST_ROOT: root,
    FAROL_E2E_TEST_PROOF: proof,
  };
}

async function bootstrapFixture(
  env: E2EWindowBootstrapPorts["env"],
  argv = ["--preview-window-mode=hidden"],
) {
  vi.stubEnv("FAROL_E2E", undefined); // Default import remains inert in port tests.
  const { installE2EWindowObserver } =
    await import("../../apps/desktop/bridge/e2e-window-bootstrap.ts");
  const app = {};
  const ports: E2EWindowBootstrapPorts = {
    env,
    argv,
    pid: 1234,
    app,
    existingWindows: vi.fn(() => []),
    subscribeCreated: vi.fn(),
    onNodeExit: vi.fn(),
    onAppQuit: vi.fn(),
    write: vi.fn(),
  };
  return { ports, install: () => installE2EWindowObserver(ports) };
}

describe("first-import E2E window bootstrap", () => {
  it("is the first main import and depends only on minimal validation and observer modules", () => {
    const main = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
    expect(
      main.startsWith(
        'import "../../../apps/desktop/bridge/e2e-window-bootstrap.ts";\n',
      ),
    ).toBe(true);
    const source = fs.readFileSync(
      "apps/desktop/bridge/e2e-window-bootstrap.ts",
      "utf8",
    );
    const dependencies = [...source.matchAll(/from "([^" ]+)"/gu)].map(
      (match) => match[1],
    );
    expect(dependencies).toEqual([
      "electron",
      "node:fs",
      "../../../src/apps/desktop/desktop-environment.ts",
      "../../../src/apps/desktop/window-placement.ts",
      "./e2e-window-observer.ts",
    ]);
    const pure = fs.readFileSync(
      "apps/desktop/bridge/e2e-window-observer.ts",
      "utf8",
    );
    expect(pure).not.toMatch(/\bimport\b|\bprocess\b|node:|electron/u);
  });

  it.each([
    "ordinary",
    "visible",
    "invalid-mode",
    "invalid-proof",
    "missing-proof",
    "invalid-home",
  ])(
    "installs no hooks or readback on %s launch and never reads native paths",
    async (kind) => {
      const env = proofFixture();
      if (kind === "ordinary") env.FAROL_E2E = "0";
      if (kind === "invalid-proof") env.FAROL_E2E_TEST_PROOF = randomUUID();
      if (kind === "missing-proof") env.FAROL_E2E_TEST_PROOF = "";
      if (kind === "invalid-home") env.HOME = "/invalid-e2e-home";
      const argv =
        kind === "visible"
          ? ["--preview-window-mode=secondary-visible"]
          : kind === "invalid-mode"
            ? ["--preview-window-mode=hidden", "--preview-window-mode=hidden"]
            : ["--preview-window-mode=hidden"];
      const f = await bootstrapFixture(env, argv);
      const lstat = vi.spyOn(fs, "lstatSync");
      const realpath = vi.spyOn(fs.realpathSync, "native");
      f.install();
      expect(Object.getOwnPropertyNames(f.ports.app)).toEqual([]);
      for (const call of [
        f.ports.existingWindows,
        f.ports.subscribeCreated,
        f.ports.onNodeExit,
        f.ports.onAppQuit,
        f.ports.write,
      ])
        expect(call).not.toHaveBeenCalled();
      if (kind !== "invalid-proof") {
        expect(lstat).not.toHaveBeenCalled();
        expect(realpath).not.toHaveBeenCalled();
      }
      for (const [candidate] of lstat.mock.calls)
        expect(
          String(candidate).startsWith(env.FAROL_E2E_TEST_ROOT + "/") ||
            candidate === env.FAROL_E2E_TEST_ROOT,
        ).toBe(true);
      expect(electron.app.getPath).not.toHaveBeenCalled();
    },
  );

  it("reuses physical proof, exposes only a frozen snapshot function and synchronous frames", async () => {
    const f = await bootstrapFixture(proofFixture());
    const lstat = vi.spyOn(fs, "lstatSync");
    f.install();
    expect(lstat).toHaveBeenCalled();
    const descriptor = Object.getOwnPropertyDescriptor(
      f.ports.app,
      "__farolE2EWindowLifetime",
    )!;
    expect(descriptor).toMatchObject({ writable: false, configurable: false });
    expect(descriptor.set).toBeUndefined();
    const snapshot = descriptor.value as () => FrozenSnapshot;
    expect(snapshot()).toMatchObject({ pid: 1234, observerFault: false });
    const created = vi.mocked(f.ports.subscribeCreated).mock.calls[0]![0];
    const w = windowFixture();
    created(w.window);
    w.fire("show");
    vi.mocked(f.ports.onNodeExit).mock.calls[0]![0](0);
    vi.mocked(f.ports.onAppQuit).mock.calls[0]![0](0);
    w.fire("focus");
    const frames = vi.mocked(f.ports.write).mock.calls.map(([line]) => {
      expect(line.startsWith(E2E_WINDOW_LIFETIME_PREFIX)).toBe(true);
      expect(line.endsWith("\n")).toBe(true);
      return JSON.parse(
        line.slice(E2E_WINDOW_LIFETIME_PREFIX.length),
      ) as E2EWindowLifetimeFrame;
    });
    expect(frames.map((frame) => frame.event)).toEqual([
      "armed",
      "created",
      "show",
      "node-exit",
      "app-quit",
      "focus",
    ]);
    expect(frames.at(-1)).toMatchObject({
      violations: 2,
      createdWindows: 1,
      pid: 1234,
    });
    expect(electron.app.getPath).not.toHaveBeenCalled();
  });

  it("executes the first-import installation with exact native ports after valid proof", async () => {
    vi.resetModules();
    const env = proofFixture();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv("FAROL_ENVIRONMENT", undefined);
    vi.stubEnv("FAROL_ACCEPTANCE_PROFILE", undefined);
    const argv = process.argv;
    const exits: ((code: number) => void)[] = [];
    const once = process.once.bind(process);
    vi.spyOn(process, "once").mockImplementation((event, listener) => {
      if (event === "exit") {
        exits.push(listener as (code: number) => void);
        return process;
      }
      return once(event, listener);
    });
    electron.app.on.mockClear();
    electron.app.once.mockClear();
    electron.BrowserWindow.getAllWindows.mockClear();
    electron.writeSync.mockClear();
    try {
      process.argv = ["electron", "main.cjs", "--preview-window-mode=hidden"];
      await import("../../apps/desktop/bridge/e2e-window-bootstrap.ts");
    } finally {
      process.argv = argv;
    }
    expect(electron.app.on).toHaveBeenCalledWith(
      "browser-window-created",
      expect.any(Function),
    );
    expect(electron.app.on.mock.invocationCallOrder[0]).toBeLessThan(
      electron.BrowserWindow.getAllWindows.mock.invocationCallOrder[0]!,
    );
    expect(electron.app.once).toHaveBeenCalledWith(
      "quit",
      expect.any(Function),
    );
    expect(exits).toHaveLength(1);
    exits[0]!(0);
    const quit = electron.app.once.mock.calls[0]![1] as (
      _event: unknown,
      code: number,
    ) => void;
    quit({}, 0);
    const lines = electron.writeSync.mock.calls.map(([fd, line]) => {
      expect(fd).toBe(2);
      return JSON.parse(
        line.slice(E2E_WINDOW_LIFETIME_PREFIX.length),
      ) as E2EWindowLifetimeFrame;
    });
    expect(lines.map((frame) => frame.event)).toEqual([
      "armed",
      "node-exit",
      "app-quit",
    ]);
    expect(lines.every((frame) => frame.pid === process.pid)).toBe(true);
    expect(electron.app.getPath).not.toHaveBeenCalled();
  });
});
