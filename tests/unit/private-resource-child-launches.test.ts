import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { EventEmitter } from "node:events";
import { parse } from "@babel/parser";
import { expect, it, vi } from "vitest";
import { observeLocalRuntime } from "../../src/apps/desktop/local-runtime-lifetime";

// Actual source composition with controlled IPC/process producers, not a native host.
const main = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const connector = fs.readFileSync(
  "src/apps/desktop/secure-mcp-connector-runtime.ts",
  "utf8",
);
function select(
  source: string,
  predicate: (node: Record<string, unknown>) => boolean,
) {
  const matches: Record<string, unknown>[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (predicate(node)) matches.push(node);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  }
  visit(parse(source, { sourceType: "module", plugins: ["typescript"] }));
  if (matches.length !== 1) throw Error("CHILD_COMPOSITION_MISSING");
  const match = matches[0];
  if (!match) throw Error("CHILD_COMPOSITION_MISSING");
  return source.slice(match.start as number, match.end as number);
}
function declaration(name: string) {
  return select(
    main,
    (node) =>
      node.type === "FunctionDeclaration" &&
      (node.id as { name?: string })?.name === name,
  );
}
const privateDirectory = "/private/accepted/Farol.app/Contents/Resources/app";
const privateExecutable = "/private/accepted/Electron";
function resources(
  recheck: () => Promise<void> = vi.fn(async () => undefined),
) {
  return {
    quitInProgress: false,
    installedUpdateAdmission: false,
    ownedLocalRuntimes: new Map(),
    localRuntimeGeneration: 0,
    runtimeChild: null,
    observeLocalRuntime,
    beforeConnectorEffect: vi.fn(),
    directory: "/Applications/Farol.app/Contents/Resources/app",
    process: { execPath: "/Applications/replaced/Electron", argv: [], env: {} },
    installedResourcesOrigin: {
      execution: { directory: privateDirectory, executable: privateExecutable },
      recheck,
    },
    path,
  };
}

it("selects private MCP, safe-open and renderer resources from actual callers", () => {
  const getter = stripTypeScriptTypes(declaration("desktopExecutionResources"));
  const context = resources();
  const mcp = select(
    main,
    (node) =>
      node.type === "CallExpression" &&
      (
        node.callee as {
          object?: { name?: string };
          property?: { name?: string };
        }
      )?.object?.name === "secureMcpConnectorRuntime" &&
      (node.callee as { property?: { name?: string } })?.property?.name ===
        "configure",
  );
  const configured = vm.runInNewContext(
    `${getter}; const resources = desktopExecutionResources(); ${stripTypeScriptTypes(mcp)}`,
    {
      ...context,
      connector: {
        tunnelClient: { executablePath: "/selected/tunnel-client" },
        tunnelId: "controlled",
      },
      credentialReference: "private-reference",
      launchFile: "/private/contract.json",
      secureMcpConnectorRuntime: { configure: (value: object) => value },
    },
  );
  expect(configured.mcp).toEqual({
    electronPath: privateExecutable,
    entryPath: path.join(privateDirectory, "computer-mcp.cjs"),
    launchContractPath: "/private/contract.json",
  });
  const helper = select(
    main,
    (node) =>
      node.type === "NewExpression" &&
      (node.callee as { name?: string })?.name === "NativeReadonlyWorkspace",
  );
  const workspace = vm.runInNewContext(
    `${getter}; ${stripTypeScriptTypes(helper)}`,
    {
      ...context,
      NEXT_SAFE_OPEN_HELPER: {},
      NativeReadonlyWorkspace: class {
        constructor(readonly options: object) {}
      },
    },
  );
  expect(workspace.options.helperPath).toBe(
    path.join(privateDirectory, "computer-safe-open.py"),
  );
  const preload = select(
    main,
    (node) =>
      node.type === "ObjectProperty" &&
      (node.key as { name?: string })?.name === "preload",
  );
  expect(
    vm.runInNewContext(
      `${getter}; ({${stripTypeScriptTypes(preload)}}).preload`,
      context,
    ),
  ).toBe(path.join(privateDirectory, "preload.cjs"));
});

it("starts the actual local runtime through private executable and Node IPC after recheck", async () => {
  const order: string[] = [];
  const recheck = vi.fn(async () => {
    order.push("recheck");
  });
  const child = new EventEmitter();
  const ready = { identity: "controlled-runtime", tasks: [] };
  const spawn = vi.fn((..._args: unknown[]) => {
    order.push("spawn");
    queueMicrotask(() => child.emit("message", ready));
    return child;
  });
  const context = {
    ...resources(recheck),
    spawn,
    setTimeout,
    clearTimeout,
    runtimeStopping: false,
    runtimeChild: null,
    runtime: null,
    runtimeState: "starting",
    runtimeError: null,
    taskCountsBeforeRuntimeExit: null,
    activeDesktopIdentity: { runtimeIdentity: ready.identity },
    demoMode: false,
    expectedTasks: [],
    readySchema: {
      safeParse: (message: unknown) => ({ success: true, data: message }),
    },
    handleRuntimeExit: vi.fn(),
  };
  await vm.runInNewContext(
    `${stripTypeScriptTypes(declaration("desktopExecutionResources"))}; ${stripTypeScriptTypes(declaration("startRuntime"))}; startRuntime()`,
    context,
  );
  expect(order).toEqual(["recheck", "spawn"]);
  expect(spawn.mock.calls[0]![0]).toBe(privateExecutable);
  expect(spawn.mock.calls[0]![1]).toEqual([
    path.join(privateDirectory, "runtime.cjs"),
  ]);
  expect(spawn.mock.calls[0]![2]).toMatchObject({
    env: { ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
  expect(context.runtimeState).toBe("ready");
});

it("reports a native runtime spawn refusal without an unhandled process error", async () => {
  const child = new EventEmitter();
  const context = {
    ...resources(),
    spawn: vi.fn((..._args: unknown[]) => {
      queueMicrotask(() => child.emit("error", Error("ENOENT")));
      return Object.assign(child, { kill: vi.fn() });
    }),
    setTimeout,
    clearTimeout,
    runtimeStopping: false,
    runtimeChild: null,
    runtime: null,
    runtimeState: "starting",
    runtimeError: null,
    taskCountsBeforeRuntimeExit: null,
    activeDesktopIdentity: { runtimeIdentity: "controlled-runtime" },
    demoMode: false,
    handleRuntimeExit: vi.fn(),
  };
  await vm.runInNewContext(
    `${stripTypeScriptTypes(declaration("desktopExecutionResources"))}; ${stripTypeScriptTypes(declaration("startRuntime"))}; startRuntime()`,
    context,
  );
  expect(context.runtimeState).toBe("failed");
  expect(context.runtimeError).toBe("RUNTIME_PROCESS_NOT_STARTED");
  expect(context.runtimeChild).toBeNull();
});

it("refuses local-runtime dispatch on failed authenticated resource recheck", async () => {
  const spawn = vi.fn();
  const context = {
    ...resources(
      vi.fn(async () => {
        throw Error("INTEGRITY_CHANGED");
      }),
    ),
    spawn,
    runtimeStopping: false,
  };
  await expect(
    vm.runInNewContext(
      `${stripTypeScriptTypes(declaration("desktopExecutionResources"))}; ${stripTypeScriptTypes(declaration("startRuntime"))}; startRuntime()`,
      context,
    ),
  ).rejects.toThrow("INTEGRITY_CHANGED");
  expect(spawn).not.toHaveBeenCalled();
});

it.each([false, true])(
  "uses private connector anchor or refuses before spawn: %s",
  async (fail) => {
    const code = select(
      connector,
      (node) =>
        node.type === "VariableDeclarator" &&
        (node.id as { name?: string })?.name === "startProcess",
    );
    const child = new EventEmitter();
    const spawn = vi.fn((..._args: unknown[]) => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const recheck = vi.fn(async () => {
      if (fail) throw Error("INTEGRITY_CHANGED");
    });
    class Refusal extends Error {}
    const start = vm.runInNewContext(
      `${stripTypeScriptTypes(select(connector, (node) => node.type === "FunctionDeclaration" && (node.id as { name?: string })?.name === "assertConnectorDispatch"))}; const ${stripTypeScriptTypes(code)}; startProcess`,
      {
        process: {
          platform: "darwin",
          execPath: "/Applications/replaced/Electron",
        },
        fs: { access: vi.fn(async () => undefined), constants: { X_OK: 1 } },
        spawn,
        CONNECTOR_GROUP_ANCHOR: "controlled-anchor",
        ConnectorProcessNotStarted: Refusal,
        observedConnectorChild: (value: object) => value,
      },
    );
    const result = start(
      {
        executablePath: "/selected/tunnel-client",
        arguments: ["run"],
        cwd: "/private/cwd",
        environment: {},
      },
      privateExecutable,
      recheck,
    );
    if (fail) {
      await expect(result).rejects.toThrow(
        "CONNECTOR_EXECUTION_RESOURCES_UNCONFIRMED",
      );
      expect(spawn).not.toHaveBeenCalled();
    } else {
      expect(await result).toBe(child);
      expect(spawn.mock.calls[0]![0]).toBe(privateExecutable);
      expect(spawn.mock.calls[0]![1]).toEqual([
        "-e",
        "controlled-anchor",
        "--",
        "/selected/tunnel-client",
        "run",
      ]);
    }
  },
);

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["runtimeStopping", "quitInProgress", "installedUpdateAdmission"])(
  "does not spawn after %s during original resource recheck",
  async (flag) => {
    const reached = deferredVoid();
    const release = deferredVoid();
    const spawn = vi.fn();
    const context = {
      ...resources(
        vi.fn(async () => {
          reached.resolve();
          await release.promise;
        }),
      ),
      spawn,
      runtimeStopping: false,
      runtimeChild: null,
    };
    const original = vm.runInNewContext(
      `${stripTypeScriptTypes(declaration("desktopExecutionResources"))}; ${stripTypeScriptTypes(declaration("startRuntime"))}; startRuntime()`,
      context,
    );
    await reached.promise;
    Object.assign(context, { [flag]: true });
    release.resolve();
    await original;
    expect(spawn).not.toHaveBeenCalled();
    expect(context.runtimeChild).toBeNull();
  },
);

it.each(["quitInProgress", "installedUpdateAdmission"])(
  "does not reset stop or recheck resources when %s already owns admission",
  async (flag) => {
    const recheck = vi.fn();
    const spawn = vi.fn();
    const context = {
      ...resources(recheck),
      [flag]: true,
      runtimeStopping: true,
      spawn,
    };
    await vm.runInNewContext(
      `${stripTypeScriptTypes(declaration("desktopExecutionResources"))}; ${stripTypeScriptTypes(declaration("startRuntime"))}; startRuntime()`,
      context,
    );
    expect(recheck).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(context.runtimeStopping).toBe(true);
  },
);

it("refuses the actual connector anchor after withdrawal during its inner recheck", async () => {
  const code = select(
    connector,
    (node) =>
      node.type === "VariableDeclarator" &&
      (node.id as { name?: string })?.name === "startProcess",
  );
  const guard = select(
    connector,
    (node) =>
      node.type === "FunctionDeclaration" &&
      (node.id as { name?: string })?.name === "assertConnectorDispatch",
  );
  const reached = deferredVoid();
  const released = deferredVoid();
  let admitted = true;
  const spawn = vi.fn();
  class NotStarted extends Error {}
  const start = vm.runInNewContext(
    `${stripTypeScriptTypes(guard)}; const ${stripTypeScriptTypes(code)}; startProcess`,
    {
      process: { platform: "darwin" },
      fs: { access: vi.fn(async () => undefined), constants: { X_OK: 1 } },
      spawn,
      ConnectorProcessNotStarted: NotStarted,
    },
  );
  const original = start(
    {
      executablePath: "/selected/tunnel-client",
      arguments: ["run"],
      cwd: "/private/cwd",
      environment: {},
    },
    privateExecutable,
    async () => {
      reached.resolve();
      await released.promise;
    },
    () => {
      if (!admitted) throw Error("WITHDRAWN");
    },
  );
  await reached.promise;
  admitted = false;
  released.resolve();
  await expect(original).rejects.toThrow("CONNECTOR_ADMISSION_WITHDRAWN");
  expect(spawn).not.toHaveBeenCalled();
});

it.each(["quit", "update", "recovery"])(
  "uses the caller's actual synchronous guard for %s withdrawal",
  (kind) => {
    const declaration = select(
      main,
      (node) =>
        node.type === "VariableDeclarator" &&
        (node.id as { name?: string })?.name === "beforeConnectorEffect",
    );
    let recovery = true;
    const context = {
      quitInProgress: false,
      installedUpdateAdmission: false,
      recoveryPermitted: () => recovery,
    };
    const guard = vm.runInNewContext(
      `const ${stripTypeScriptTypes(declaration)}; beforeConnectorEffect`,
      context,
    );
    expect(() => guard()).not.toThrow();
    if (kind === "quit") context.quitInProgress = true;
    else if (kind === "update") context.installedUpdateAdmission = true;
    else recovery = false;
    expect(() => guard()).toThrow("CONNECTOR_ADMISSION_WITHDRAWN");
  },
);
