import { productName } from "../../tooling/harness-identity.ts";
/**
 * Synthetic Copy buttons in hidden native Electron, using the built production
 * ChatGptRoute permission handlers. NOT live ChatGPT, packaged or installed proof.
 *
 * node tests/e2e/chatgpt-clipboard.e2e.mjs --build-only
 * node tests/e2e/chatgpt-clipboard.e2e.mjs --run-native
 *
 * Uses Electron offscreen rendering for trusted input without window presentation.
 * An unfocused query is native policy evidence, not an unfocused Copy proof. If
 * renderer focus cannot be lost after input, the background Copy row is BLOCKED.
 * Exit 2 means a native acceptance gate is blocked; it is never a passing run.
 * Native writes require an initially empty OS clipboard. A nonempty clipboard
 * blocks all clipboard operations (including negative write tests), without
 * reading its payload or replacing it. Cleanup clears only unchanged test-owned
 * text. Do not clear the owner's clipboard to make this test pass. The Lead must
 * qualify that gate on an authorized disposable desktop if it is blocked here.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { ELECTRON_RUNTIME } from "../../tooling/runtime-contract.mjs";
import { DECLARED_NODE_VERSIONS } from "../../tooling/dev.mjs";

// Serialized into the fixture bundle. Dependencies are explicit, and normal
// product main, persistent partitions and live provider code are never started.
function childMain({
  app,
  BrowserWindow,
  WebContentsView,
  session,
  clipboard,
  ChatGptRoute,
  assert,
  fs,
  config,
}) {
  const receipt = {
    versions: process.versions,
    rows: [],
    permissions: [],
    windows: [],
    error: null,
    clipboard: { initialEmpty: null, restored: false, writes: 0 },
    cleanup: { windowsDestroyed: false, contentsDestroyed: false },
  };
  const save = () =>
    fs.writeFileSync(config.receipt, JSON.stringify(receipt, null, 2), {
      mode: 0o600,
    });
  app.setName("Clipboard Qualification");
  for (const [name, directory] of Object.entries(config.paths))
    app.setPath(name, directory);
  app.setAppLogsPath(config.paths.logs);
  app.setActivationPolicy("prohibited");
  for (const name of [
    "disable-background-networking",
    "disable-component-update",
    "disable-sync",
    "no-proxy-server",
  ])
    app.commandLine.appendSwitch(name);
  app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");
  app.on("browser-window-created", (_event, window) => {
    for (const kind of ["show", "focus"])
      window.on(kind, () => {
        window.hide();
        receipt.error = `NATIVE_${kind.toUpperCase()}_FORBIDDEN`;
        save();
      });
  });
  const ownedContents = [];
  let route;
  let lastText = null;
  let lastTypes = null;
  let finished = false;
  const types = (items) => items.map((item) => [...item.types].sort());
  const unchanged = async () => {
    const items = await clipboard.read();
    if (lastText === null) return items.length === 0;
    return (
      JSON.stringify(types(items)) === JSON.stringify(lastTypes) &&
      (await clipboard.readText()) === lastText
    );
  };
  const cleanup = async () => {
    for (const contents of ownedContents)
      if (!contents.isDestroyed() && contents.debugger.isAttached())
        contents.debugger.detach();
    route?.dispose();
    for (const contents of ownedContents)
      if (!contents.isDestroyed()) contents.close();
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    receipt.cleanup.windowsDestroyed =
      BrowserWindow.getAllWindows().length === 0;
    // WebContents.close() completes asynchronously; retain the exact objects
    // until their native destruction is observed, before deleting profile state.
    const deadline = Date.now() + 2_000;
    while (
      ownedContents.some((contents) => !contents.isDestroyed()) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    receipt.cleanup.contentsDestroyed = ownedContents.every((contents) =>
      contents.isDestroyed(),
    );
    if (lastText !== null) {
      if (await unchanged()) {
        clipboard.clear();
        receipt.clipboard.restored = (await clipboard.read()).length === 0;
      } else {
        receipt.clipboard.cleanup = "changed-clipboard-preserved";
        receipt.error ??= "CLIPBOARD_CHANGED_DURING_TEST";
      }
    } else if (receipt.clipboard.initialEmpty === true) {
      receipt.clipboard.restored = (await clipboard.read()).length === 0;
    }
    save();
  };
  const watchdog = setTimeout(async () => {
    if (finished) return;
    receipt.error = "NATIVE_CLIPBOARD_TIMEOUT";
    await cleanup();
    app.exit(1);
  }, 40_000);
  app.on("before-quit", () => clearTimeout(watchdog));
  // Keep the harness alive until native cleanup and the final receipt finish.
  app.on("window-all-closed", () => {});
  globalThis.runClipboardQualification = async () => {
    await app.whenReady();
    app.dock?.hide();
    app.hide();
    const local = session.fromPartition(`clipboard-${config.token}`, {
      cache: false,
    });
    for (const selected of [session.defaultSession, local]) {
      selected.setPermissionCheckHandler(() => false);
      selected.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      selected.webRequest.onBeforeRequest((details, callback) =>
        callback({
          cancel:
            selected !== local ||
            ![
              "https://chatgpt.com/",
              "https://auth.openai.com/",
              "https://foreign.example/",
            ].some((prefix) => details.url.startsWith(prefix)),
        }),
      );
      selected.on("will-download", (event) => event.preventDefault());
    }
    // Every HTTPS byte is supplied locally by this session's protocol handler.
    // No net.fetch, local provider profile, cookies, credential or network service.
    const fixture = (url) => {
      const frame = new URL(url).pathname === "/frame";
      return `<!doctype html><meta charset="utf-8">
        <style>body{margin:0}button{position:absolute;top:8px;left:8px;width:160px;height:40px}iframe{position:absolute;top:80px;left:0;width:300px;height:160px;border:0}</style>
        <button id="copy" data-testid="copy-turn-action-button">Copy response</button>
        ${frame ? "" : '<iframe id="same" src="https://chatgpt.com/frame" allow="clipboard-write; clipboard-read"></iframe><iframe id="foreign" style="top:260px" src="https://foreign.example/frame" allow="clipboard-write; clipboard-read"></iframe>'}
        <script>
          globalThis.copyResult = null;
          globalThis.copyMode = 'write';
          globalThis.copyText = '';
          document.querySelector('#copy').addEventListener('click', async event => {
            const result = { trusted: event.isTrusted, active: navigator.userActivation.isActive,
              focused: document.hasFocus(), visibility: document.visibilityState, mainFrame: window === top };
            try {
              if (copyMode.startsWith('permission')) {
                if (copyMode === 'permission-delayed') await new Promise(resolve => setTimeout(resolve, 50));
                result.focusedAtPermission = document.hasFocus();
                result.permission = (await navigator.permissions.query({ name: 'clipboard-write' })).state;
              }
              else if (copyMode === 'read') await navigator.clipboard.readText();
              else {
                if (copyMode === 'delayed') await new Promise(resolve => setTimeout(resolve, 50));
                result.focusedAtWrite = document.hasFocus();
                await navigator.clipboard.writeText(globalThis.copyText);
              }
              result.ok = true;
            } catch (error) { result.ok = false; result.error = error.name; result.message = error.message; }
            globalThis.copyResult = result;
          });
        </script>`;
    };
    local.protocol.handle(
      "https",
      (request) =>
        new Response(fixture(request.url), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src https://chatgpt.com https://foreign.example",
          },
        }),
    );
    let checkHandler;
    let requestHandler;
    const setCheck = local.setPermissionCheckHandler.bind(local);
    const setRequest = local.setPermissionRequestHandler.bind(local);
    // Capture the handlers installed by the production constructor. Wrappers
    // record Electron's real arguments and return the unmodified policy result.
    local.setPermissionCheckHandler = (handler) => {
      checkHandler = handler;
      setCheck((contents, permission, origin, details) => {
        const allowed = handler(contents, permission, origin, details);
        receipt.permissions.push({
          kind: "check",
          permission,
          origin,
          details,
          allowed,
        });
        return allowed;
      });
    };
    local.setPermissionRequestHandler = (handler) => {
      requestHandler = handler;
      setRequest((contents, permission, callback, details) =>
        handler(
          contents,
          permission,
          (allowed) => {
            receipt.permissions.push({
              kind: "request",
              permission,
              details,
              allowed,
            });
            callback(allowed);
          },
          details,
        ),
      );
    };
    const host = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 640,
      height: 640,
      webPreferences: {
        session: local,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const view = new WebContentsView({
      webPreferences: {
        session: local,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        offscreen: true,
      },
    });
    ownedContents.push(view.webContents);
    host.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 600, height: 600 });
    route = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
    });
    // Bind only the clipboard ownership seam. Do not open the production route
    // (which would create its persistent partition or unrelated readiness gates).
    const surface = {
      webContents: view.webContents,
      isDestroyed: () => view.webContents.isDestroyed(),
      destroy: () => view.webContents.close(),
      hide() {},
      reveal() {},
    };
    Reflect.set(route, "routeWindow", surface);
    Reflect.get(route, "hardenSession").call(route, local);
    Reflect.get(route, "hardenContents").call(route, view.webContents, true);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const hidden = () => {
      const windows = BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        visible: window.isVisible(),
        focused: window.isFocused(),
      }));
      receipt.windows.push(windows);
      assert.ok(windows.every((window) => !window.visible && !window.focused));
      assert.equal(app.isHidden(), true);
      assert.equal(app.dock.isVisible(), false);
      assert.equal(receipt.error, null);
    };
    const row = async (name, operation) => {
      const result = { name, status: "running" };
      receipt.rows.push(result);
      save();
      try {
        result.observation = await operation();
        hidden();
        result.status =
          result.observation?.blocked === true ? "blocked" : "passed";
      } catch (error) {
        result.status = "failed";
        throw error;
      } finally {
        save();
      }
    };
    const query = (frame, name) =>
      frame.executeJavaScript(
        `navigator.permissions.query({name:${JSON.stringify(name)}}).then(value => value.state)`,
        false,
      );
    let copySequence = 0;
    const click = async (frame, y, mode = "write") => {
      const text = `${config.text} ${++copySequence}`;
      if (!mode.startsWith("permission"))
        assert.ok(await unchanged(), "CLIPBOARD_CHANGED_BEFORE_OPERATION");
      await frame.executeJavaScript(
        `globalThis.copyResult = null; globalThis.copyMode = ${JSON.stringify(mode)}; globalThis.copyText = ${JSON.stringify(text)};`,
        false,
      );
      receipt.inputDiagnostics ??= [];
      receipt.inputDiagnostics.push(
        await frame.executeJavaScript(
          `({
        focus: document.hasFocus(), visibility: document.visibilityState,
        viewport: [innerWidth, innerHeight],
        target: document.elementFromPoint(80,28)?.id,
        bounds: document.querySelector('#copy').getBoundingClientRect().toJSON()
      })`,
          false,
        ),
      );
      // Chromium delivers trusted input to a hidden view; unlike a driver,
      // this inspector session never enables document focus emulation.
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await view.webContents.debugger.sendCommand(
          "Input.dispatchMouseEvent",
          {
            type,
            x: 80,
            y,
            button: "left",
            clickCount: 1,
          },
        );
      if (mode === "delayed" || mode === "permission-delayed")
        host.webContents.focus();
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const result = await frame.executeJavaScript(
          "globalThis.copyResult",
          false,
        );
        if (result) {
          assert.equal(result.trusted, true, "BUTTON_INPUT_NOT_TRUSTED");
          assert.equal(
            result.active,
            true,
            "BUTTON_INPUT_WITHOUT_USER_ACTIVATION",
          );
          return { ...result, expectedText: text };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("COPY_BUTTON_RESULT_TIMEOUT");
    };
    const copied = async (frame, mode = "write") => {
      const observation = await click(frame, 28, mode);
      // Retain cleanup ownership even when a subsequent assertion fails.
      const items = await clipboard.read();
      if (
        items.length > 0 &&
        (await clipboard.readText()) === observation.expectedText
      ) {
        lastText = observation.expectedText;
        lastTypes = types(items);
        receipt.clipboard.writes += 1;
      }
      assert.equal(observation.ok, true, JSON.stringify(observation));
      assert.equal(
        lastText,
        observation.expectedText,
        "OS_CLIPBOARD_WRITE_NOT_OBSERVED",
      );
      assert.equal(await unchanged(), true);
      return observation;
    };
    const denied = async (frame, y, mode = "write") => {
      const observation = await click(frame, y, mode);
      assert.equal(
        observation.ok,
        false,
        "FORBIDDEN_CLIPBOARD_OPERATION_SUCCEEDED",
      );
      assert.equal(observation.error, "NotAllowedError");
      assert.equal(
        await unchanged(),
        true,
        "DENIED_OPERATION_CHANGED_OS_CLIPBOARD",
      );
      return observation;
    };
    try {
      await host.loadURL("https://chatgpt.com/blank");
      await view.webContents.loadURL("https://chatgpt.com/");
      view.webContents.debugger.attach("1.3");
      const main = view.webContents.mainFrame;
      const same = main.frames.find(
        (frame) => frame.url === "https://chatgpt.com/frame",
      );
      const foreign = main.frames.find(
        (frame) => frame.url === "https://foreign.example/frame",
      );
      assert.ok(same && foreign, "SUBFRAME_FIXTURES_NOT_LOADED");
      await row("native-permission-main-write", async () => {
        assert.equal(await query(main, "clipboard-write"), "granted");
        assert.ok(
          receipt.permissions.some(
            (event) =>
              event.permission === "clipboard-sanitized-write" &&
              event.details.isMainFrame === true &&
              event.allowed,
          ),
        );
      });
      await row("native-unfocused-main-write-policy", async () => {
        const focused = await main.executeJavaScript(
          "document.hasFocus()",
          false,
        );
        assert.equal(focused, false, "INITIAL_HIDDEN_DOCUMENT_ALREADY_FOCUSED");
        assert.equal(await query(main, "clipboard-write"), "granted");
        return { focused };
      });
      await row("native-permission-read-denied", async () =>
        assert.equal(await query(main, "clipboard-read"), "denied"),
      );
      await row("native-permission-same-origin-subframe-denied", async () =>
        assert.equal(await query(same, "clipboard-write"), "denied"),
      );
      await row("native-permission-foreign-subframe-denied", async () =>
        assert.equal(await query(foreign, "clipboard-write"), "denied"),
      );
      await row("production-request-handler-boundaries", async () => {
        const contents = view.webContents;
        for (const [permission, url, isMainFrame, expected] of [
          ["clipboard-sanitized-write", "https://chatgpt.com/", true, true],
          ["clipboard-read", "https://chatgpt.com/", true, false],
          [
            "clipboard-sanitized-write",
            "https://foreign.example/",
            true,
            false,
          ],
          ["clipboard-sanitized-write", "https://chatgpt.com/", false, false],
          ["clipboard-sanitized-write", "", true, false],
        ]) {
          let outcome;
          requestHandler(
            contents,
            permission,
            (allowed) => {
              outcome = allowed;
            },
            { requestingUrl: url, isMainFrame },
          );
          assert.equal(outcome, expected);
          assert.equal(
            checkHandler(contents, permission, url, { isMainFrame }),
            expected,
          );
        }
        assert.equal(
          checkHandler(
            null,
            "clipboard-sanitized-write",
            "https://chatgpt.com",
            { isMainFrame: true },
          ),
          false,
        );
      });
      // Prove the trusted native input mechanism independently of OS writes.
      // This row is not navigator.clipboard.writeText qualification.
      await row("trusted-hidden-button-permission-query", async () => {
        const observation = await click(main, 28, "permission");
        assert.equal(observation.ok, true);
        assert.equal(observation.permission, "granted");
        return observation;
      });
      await row("trusted-background-button-permission-query", async () => {
        const observation = await click(main, 28, "permission-delayed");
        assert.equal(observation.ok, true);
        assert.equal(observation.permission, "granted");
        if (observation.focusedAtPermission !== false)
          return {
            blocked: true,
            reason: "NATIVE_BACKGROUND_FOCUS_NOT_LOST",
            observation,
          };
        return observation;
      });
      await row("trusted-detached-button-permission-query", async () => {
        host.contentView.removeChildView(view);
        try {
          const observation = await click(main, 28, "permission");
          assert.equal(observation.ok, true);
          assert.equal(observation.permission, "granted");
          return observation;
        } finally {
          host.contentView.addChildView(view);
        }
      });
      // Do not fetch any blobs or text from a preexisting owner clipboard.
      receipt.clipboard.initialEmpty = (await clipboard.read()).length === 0;
      if (receipt.clipboard.initialEmpty) {
        await row("trusted-copy-hidden-attached-os-write", () => copied(main));
        if (
          receipt.rows.some(
            (item) =>
              item.name === "trusted-background-button-permission-query" &&
              item.status === "blocked",
          )
        )
          receipt.rows.push({
            name: "trusted-copy-background-delayed-os-write",
            status: "blocked",
            reason: "NATIVE_BACKGROUND_FOCUS_NOT_LOST",
          });
        else
          await row("trusted-copy-background-delayed-os-write", async () => {
            const observation = await copied(main, "delayed");
            assert.equal(observation.focusedAtWrite, false);
            return observation;
          });
        await row("trusted-copy-detached-os-write", async () => {
          host.contentView.removeChildView(view);
          try {
            return await copied(main);
          } finally {
            host.contentView.addChildView(view);
          }
        });
        await row("trusted-clipboard-read-denied", () =>
          denied(main, 28, "read"),
        );
        await row("trusted-same-origin-subframe-copy-denied", () =>
          denied(same, 108),
        );
        await row("trusted-foreign-subframe-copy-denied", () =>
          denied(foreign, 288),
        );
      } else {
        receipt.rows.push({
          name: "trusted-buttons-and-os-clipboard",
          status: "blocked",
          reason: "OWNER_CLIPBOARD_NONEMPTY",
        });
      }
      await row("native-stale-route-denied", async () => {
        Reflect.set(route, "routeWindow", null);
        try {
          assert.equal(await query(main, "clipboard-write"), "denied");
          if (receipt.clipboard.initialEmpty) return await denied(main, 28);
        } finally {
          Reflect.set(route, "routeWindow", surface);
        }
      });
      await row("native-foreign-main-origin-denied", async () => {
        await view.webContents.loadURL("https://auth.openai.com/");
        assert.equal(
          await query(view.webContents.mainFrame, "clipboard-write"),
          "denied",
        );
        if (receipt.clipboard.initialEmpty)
          return await denied(view.webContents.mainFrame, 28);
      });
      await row("native-route-replacement-restores-write-policy", async () => {
        await view.webContents.loadURL("https://chatgpt.com/");
        assert.equal(
          await query(view.webContents.mainFrame, "clipboard-write"),
          "granted",
        );
      });
      receipt.status = receipt.rows.some((item) => item.status === "blocked")
        ? "native-gate-blocked"
        : "passed";
    } catch (error) {
      receipt.status = "failed";
      receipt.error = String(error?.stack ?? error);
    } finally {
      finished = true;
      clearTimeout(watchdog);
      await cleanup();
      if (receipt.error) receipt.status = "failed";
      save();
    }
    return receipt;
  };
  const stop = async (error) => {
    finished = true;
    clearTimeout(watchdog);
    receipt.error ??= String(error?.stack ?? error);
    receipt.status = "failed";
    await cleanup();
    app.exit(1);
  };
  process.on("SIGTERM", () => {
    void stop(new Error("CLIPBOARD_QUALIFICATION_CANCELLED"));
  });
  process.on("uncaughtException", (error) => {
    void stop(error);
  });
  process.on("unhandledRejection", (error) => {
    void stop(error);
  });
  void globalThis.runClipboardQualification().then((result) => {
    app.exit(
      result.status === "failed"
        ? 1
        : result.status === "native-gate-blocked"
          ? 2
          : 0,
    );
  }, stop);
}

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), "../..");
const require = createRequire(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mode = process.argv[2];
assert.ok(
  ["--build-only", "--run-native"].includes(mode) && process.argv.length === 3,
  "Select exactly --build-only or --run-native",
);
assert.ok(
  DECLARED_NODE_VERSIONS.includes(process.versions.node),
  "Use the declared Node toolchain",
);
const evidence = path.join(root, "_output/evidence");
await fs.mkdir(evidence, { recursive: true });
await fs.mkdir(path.join(root, "_output/tmp"), { recursive: true });
const temporary = await fs.mkdtemp(
  path.join(root, "_output/tmp/chatgpt-clipboard-"),
);
const receiptPath = path.join(evidence, `${path.basename(temporary)}.json`);
const nativeReceipt = receiptPath.replace(/\.json$/u, ".native.json");
const report = {
  classification: "synthetic-hidden-native-electron-clipboard",
  limits: [
    "Not live ChatGPT Copy response, selectors, product composition, package or installed acceptance",
    "Permission request boundary calls are explicit policy witnesses; queries/buttons are real Chromium calls",
    "Offscreen native WebContentsView with trusted inspector input; not physical window/compositor or live UI proof",
    "No focus emulation; inability to lose document focus blocks the background copy row",
    "OS writes blocked when clipboard is nonempty; no owner payload exported",
  ],
  mode,
  status: "running",
  sources: [],
  runtime: { node: process.versions.node },
  cleanup: { launched: false, exitObserved: false, temporaryRemoved: false },
};
const save = () =>
  fs.writeFile(receiptPath, JSON.stringify(report, null, 2), { mode: 0o600 });
const bounded = async (operation, ms, label) => {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
let child;
let exited;
let cancelled;
const cancellation = new Promise((_, reject) => {
  cancelled = reject;
});
cancellation.catch(() => {});
const signal = () => cancelled(new Error("CLIPBOARD_QUALIFICATION_CANCELLED"));
process.on("SIGINT", signal);
process.on("SIGTERM", signal);
try {
  const paths = Object.fromEntries(
    [
      "home",
      "appData",
      "userData",
      "sessionData",
      "temp",
      "logs",
      "crashDumps",
    ].map((name) => [name, path.join(temporary, name)]),
  );
  await Promise.all(
    Object.values(paths).map((directory) =>
      fs.mkdir(directory, { mode: 0o700 }),
    ),
  );
  const token = randomUUID();
  const config = {
    paths,
    token,
    text: `${productName} synthetic clipboard qualification ${token}`,
    receipt: nativeReceipt,
  };
  const bundle = path.join(temporary, "clipboard.cjs");
  await build({
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    outfile: bundle,
    logLevel: "silent",
    stdin: {
      resolveDir: root,
      sourcefile: "clipboard-fixture-entry.mjs",
      contents: `
      import { app, BrowserWindow, WebContentsView, session, clipboard } from 'electron';
      import { ChatGptRoute } from './src/apps/desktop/chatgpt-route.ts';
      import assert from 'node:assert/strict'; import fs from 'node:fs';
      (${childMain.toString()})({ app, BrowserWindow, WebContentsView, session, clipboard, ChatGptRoute, assert, fs, config: ${JSON.stringify(config)} });`,
    },
    plugins: [
      {
        name: "exact-production-inputs",
        setup(context) {
          context.onLoad(
            { filter: /\/src\/.*\.ts$|\/apps\/.*\.ts$/ },
            async ({ path: file }) => {
              const bytes = await fs.readFile(file);
              report.sources.push({
                path: path.relative(root, file),
                sha256: hash(bytes),
              });
              return {
                contents: bytes,
                loader: "ts",
                resolveDir: path.dirname(file),
              };
            },
          );
        },
      },
    ],
  });
  report.sources.push({
    path: "tests/e2e/chatgpt-clipboard.e2e.mjs",
    sha256: hash(await fs.readFile(filename)),
  });
  report.sources.sort((a, b) => a.path.localeCompare(b.path));
  report.sourceSha256 = hash(JSON.stringify(report.sources));
  const executable = require("electron");
  report.runtime.bundleSha256 = hash(await fs.readFile(bundle));
  report.runtime.electron = require("electron/package.json").version;
  report.runtime.esbuild = require("esbuild/package.json").version;
  report.runtime.extractedTreeDigest = await treeDigest(
    path.join(path.dirname(require.resolve("electron")), "dist/Electron.app"),
  );
  assert.equal(report.runtime.electron, ELECTRON_RUNTIME.version);
  assert.equal(
    report.runtime.extractedTreeDigest,
    ELECTRON_RUNTIME.extractedTreeDigest,
  );
  await save();
  if (mode === "--build-only") report.status = "build-only-native-not-run";
  else {
    assert.equal(process.platform, "darwin");
    report.cleanup.launchAttempted = true;
    // No browser automation driver: its default focus emulation would invalidate
    // detached/background observations. The child owns a narrow input inspector.
    child = spawn(executable, [bundle], {
      cwd: temporary,
      stdio: "ignore",
      env: {
        HOME: paths.home,
        TMPDIR: paths.temp,
        TMP: paths.temp,
        TEMP: paths.temp,
        XDG_CONFIG_HOME: paths.appData,
        XDG_CACHE_HOME: paths.sessionData,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
      },
    });
    report.cleanup.launched = true;
    report.cleanup.pid = child.pid;
    exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    await bounded(
      Promise.race([exited, cancellation]),
      45_000,
      "NATIVE_CLIPBOARD_TIMEOUT",
    );
    report.native = JSON.parse(await fs.readFile(nativeReceipt, "utf8"));
    report.status = report.native.status;
    assert.equal(
      child.exitCode,
      report.status === "failed"
        ? 1
        : report.status === "native-gate-blocked"
          ? 2
          : 0,
    );
  }
} catch (error) {
  report.status = "failed";
  report.error = String(error?.stack ?? error);
} finally {
  if (child) {
    if (child.exitCode === null && child.signalCode === null) {
      // Signal only the exact owned ChildProcess; give native cleanup a bound.
      child.kill("SIGTERM");
      try {
        await bounded(exited, 5_000, "ELECTRON_EXIT_TIMEOUT");
      } catch (error) {
        report.status = "failed";
        report.cleanup.error = String(error);
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await bounded(exited, 3_000, "ELECTRON_KILL_TIMEOUT").catch(
          (failure) => {
            report.cleanup.error = String(failure);
          },
        );
      }
    }
    report.cleanup.exitObserved =
      child.exitCode !== null || child.signalCode !== null;
    report.cleanup.exitCode = child.exitCode;
    report.cleanup.signal = child.signalCode;
    try {
      report.native = JSON.parse(await fs.readFile(nativeReceipt, "utf8"));
      assert.equal(report.native.cleanup.windowsDestroyed, true);
      assert.equal(report.native.cleanup.contentsDestroyed, true);
      if (report.native.error) throw new Error(report.native.error);
    } catch (error) {
      report.status = "failed";
      report.error ??= String(error);
    }
  }
  if (!report.cleanup.launchAttempted || report.cleanup.exitObserved) {
    await fs.rm(temporary, { recursive: true, force: true });
    report.cleanup.temporaryRemoved = true;
  } else report.cleanup.retainedTemporary = temporary;
  await save();
  process.removeListener("SIGINT", signal);
  process.removeListener("SIGTERM", signal);
  process.stdout.write(`${report.status}: ${receiptPath}\n`);
  process.exitCode =
    report.status === "failed"
      ? 1
      : report.status === "native-gate-blocked"
        ? 2
        : 0;
}
