/**
 * Synthetic HTML in hidden native Electron/Chromium, NOT live ChatGPT selector,
 * provider, host/tool execution, packaged-product, or account acceptance.
 * Parent owns the native lane. No launch unless --run-native is explicit.
 * From any cwd, with Node 24.20.0:
 *   node vnext/tests/e2e/chatgpt-public-source.e2e.mjs --build-only
 *   node vnext/tests/e2e/chatgpt-public-source.e2e.mjs --run-native
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { ELECTRON_RUNTIME } from "../../tooling/runtime-contract.mjs";

// Serialized into a standalone main-process bundle with production imports.
// All dependencies are explicit; nothing here imports or starts the desktop app.
function childMain({
  app,
  BrowserWindow,
  session,
  assert,
  fs,
  path,
  hash,
  taskProbeScript,
  publicMarkdownBlock,
  publicContentVisible,
  ChatGptPublicTurn,
  config,
}) {
  const receipt = {
    pid: process.pid,
    versions: process.versions,
    rows: [],
    events: [],
    snapshots: [],
    probes: [],
    blockedRequests: 0,
    error: null,
    cleanup: { windowsDestroyed: false },
  };
  const save = () => {
    fs.writeFileSync(
      `${config.receipt}.tmp`,
      JSON.stringify(receipt, null, 2),
      { mode: 0o600 },
    );
    fs.renameSync(`${config.receipt}.tmp`, config.receipt);
  };
  const fail = (error) => {
    receipt.error = String(error?.stack ?? error);
    save();
  };
  app.setName("Farol Synthetic Public DOM Qualification");
  for (const [name, directory] of Object.entries(config.paths))
    app.setPath(name, directory);
  app.setAppLogsPath(config.paths.logs);
  app.setActivationPolicy("prohibited");
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("disable-sync");
  app.commandLine.appendSwitch("no-proxy-server");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");
  app.on("browser-window-created", (_event, window) => {
    receipt.events.push({
      kind: "created",
      id: window.id,
      visible: window.isVisible(),
      focused: window.isFocused(),
    });
    for (const kind of ["show", "focus"])
      window.on(kind, () => {
        receipt.events.push({ kind, id: window.id });
        window.hide();
        fail(new Error(`NATIVE_WINDOW_${kind.toUpperCase()}_FORBIDDEN`));
      });
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => {
      receipt.events.push({ kind: "popup-denied" });
      return { action: "deny" };
    });
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  const destroy = () => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    receipt.cleanup.windowsDestroyed =
      BrowserWindow.getAllWindows().length === 0;
    save();
  };
  const watchdog = setTimeout(() => {
    fail(new Error("NATIVE_FIXTURE_WATCHDOG_TIMEOUT"));
    destroy();
    app.exit(1);
  }, 45_000);
  app.on("before-quit", () => {
    clearTimeout(watchdog);
    destroy();
  });
  process.on("uncaughtException", (error) => {
    fail(error);
    destroy();
    app.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    fail(error);
    destroy();
    app.exit(1);
  });
  save();

  globalThis.runPublicDomQualification = async () => {
    await app.whenReady();
    app.dock?.hide();
    app.hide();
    // An ephemeral session, plus disposable default-session paths. No persisted
    // partition or provider profile; even accidental external resources fail.
    const local = session.fromPartition("public-dom-synthetic");
    for (const selected of [session.defaultSession, local]) {
      selected.webRequest.onBeforeRequest((details, callback) => {
        const allowed = details.url.startsWith("data:");
        if (!allowed) receipt.blockedRequests += 1;
        callback({ cancel: !allowed });
      });
      selected.setPermissionCheckHandler(() => false);
      selected.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      selected.on("will-download", (event) => event.preventDefault());
    }
    const window = new BrowserWindow({
      width: 1000,
      height: 800,
      show: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        session: local,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        backgroundThrottling: false,
      },
    });
    const execute = async (script) => {
      // Electron masks rejected renderer exceptions. Carry the exact error
      // code across a fixture-only envelope around the unchanged production
      // script. This tests DOM refusal semantics, not exception transport.
      const outcome = await window.webContents.executeJavaScript(
        `(() => { try { return { ok: true, value: (${script}) }; }
          catch (error) { return { ok: false, code: String(error.message) }; } })()`,
        false,
      );
      if (!outcome.ok) throw new Error(outcome.code);
      return outcome.value;
    };
    const hidden = (label) => {
      const snapshot = {
        label,
        appHidden: app.isHidden(),
        dockVisible: app.dock?.isVisible() ?? false,
        windows: BrowserWindow.getAllWindows().map((item) => ({
          id: item.id,
          visible: item.isVisible(),
          focused: item.isFocused(),
        })),
      };
      receipt.snapshots.push(snapshot);
      assert.equal(snapshot.appHidden, true);
      assert.equal(snapshot.dockVisible, false);
      assert.equal(snapshot.windows.length, 1);
      assert.ok(
        snapshot.windows.every((item) => !item.visible && !item.focused),
      );
      assert.ok(
        receipt.events.every(
          (event) =>
            event.kind === "created" && !event.visible && !event.focused,
        ),
      );
      const preferences = window.webContents.getLastWebPreferences();
      assert.equal(preferences.contextIsolation, true);
      assert.equal(preferences.sandbox, true);
      assert.equal(preferences.nodeIntegration, false);
    };
    const user = (id = "u", text = "synthetic prompt") =>
      `<div data-message-author-role="user" data-message-id="${id}">${text}</div>`;
    const copy = '<button data-testid="copy-turn-action-button">Copy</button>';
    const send = '<button data-testid="send-button">Send</button>';
    const assistant = (
      id,
      html,
      { channel = "final", action = true, attrs = "", article = true } = {},
    ) => {
      const message = `<div data-message-author-role="assistant" data-message-id="${id}" data-message-channel="${channel}" ${attrs}><div class="markdown">${html}</div></div>`;
      return article
        ? `<article>${message}${action ? copy : ""}</article>`
        : message;
    };
    const probe = async (html, options = {}) => {
      const document =
        '<!doctype html><html><head><meta charset="utf-8">' +
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">" +
        "<style>body{font:16px sans-serif}button{min-width:40px;min-height:24px}</style></head><body>" +
        html +
        "</body></html>";
      await window.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(document)}`,
      );
      const script = taskProbeScript(
        "synthetic prompt",
        options.baseline ?? [],
        {
          semantic: true,
          userId: options.userId === undefined ? "u" : options.userId,
          assistantId: options.assistantId ?? null,
        },
      );
      receipt.probes.push({
        htmlSha256: hash(document),
        scriptSha256: hash(script),
      });
      return execute(script);
    };
    const row = async (name, check) => {
      const result = { name, status: "running" };
      receipt.rows.push(result);
      save();
      try {
        await check();
        hidden(name);
        result.status = "passed";
      } catch (error) {
        result.status = "failed";
        result.error = String(error?.stack ?? error);
        throw error;
      } finally {
        save();
      }
    };
    const expectCode = async (operation, code) => {
      // Electron can prefix renderer errors. Require the exact production code.
      await assert.rejects(operation, (error) =>
        String(error.message)
          .split(/[^A-Z_]+/u)
          .includes(code),
      );
    };
    try {
      hidden("before-fixture");
      receipt.serialized = {
        markdownSha256: hash(publicMarkdownBlock.toString()),
        probeFactorySha256: hash(taskProbeScript.toString()),
        visibilitySha256: hash(publicContentVisible.toString()),
      };
      await row("rich-markdown-link-code-table", async () => {
        const html =
          '<p>Hello <strong>world</strong> <a href="https://example.test/a?b=1&amp;c=2">source</a> <code>x &lt; y</code></p>' +
          '<pre><code class="language-js">const x = 1;\n</code></pre>' +
          "<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table>";
        const expected =
          "Hello **world** [source](<https://example.test/a?b=1&c=2>) `x < y`\n\n```js\nconst x = 1;\n```\n\n| Name | Value |\n| --- | --- |\n| A | B |";
        const result = await probe(user() + assistant("a", html) + send);
        assert.equal(result.publicFrame.messages[0].text, expected);
        assert.equal(result.publicFrame.terminal, true);
        // Independently exercise the exact serialized public Markdown reader.
        const direct = await execute(
          `(${publicMarkdownBlock.toString()})(document.querySelector('.markdown'), ${publicContentVisible.toString()})`,
        );
        assert.equal(direct, expected);
        assert.equal(await execute("typeof window.require"), "undefined");
      });
      await row("emphasis-edge-whitespace", async () => {
        const result = await probe(
          user() +
            assistant(
              "a",
              "<p>before<strong><span> </span>bold<span> </span></strong>after<em> italic </em>end</p>",
            ) +
            send,
        );
        assert.equal(
          result.publicFrame.messages[0].text,
          "before **bold** after *italic* end",
        );
      });
      await row("br-and-display-contents-native-layout", async () => {
        const result = await probe(
          user() +
            assistant(
              "a",
              '<p>first<br>second<span style="display:contents"> visible</span></p>',
            ) +
            send,
        );
        assert.equal(
          result.publicFrame.messages[0].text,
          "first  \nsecond visible",
        );
        const geometry = await execute(
          `({brWidth:document.querySelector('br').getBoundingClientRect().width, contentsWidth:document.querySelector('span').getBoundingClientRect().width})`,
        );
        assert.deepEqual(geometry, { brWidth: 0, contentsWidth: 0 });
      });
      await row("hidden-ancestors-never-contribute", async () => {
        const hiddenAttributes = [
          "hidden",
          'aria-hidden="true"',
          'style="display:none"',
          'style="visibility:hidden"',
          'style="opacity:0"',
          'style="content-visibility:hidden"',
        ];
        const excluded = hiddenAttributes
          .map((attr) => `<div ${attr}><span>EXCLUDED</span></div>`)
          .join("");
        const result = await probe(
          user() +
            `<div hidden>${assistant("hidden-a", "EXCLUDED")}</div>` +
            assistant(
              "a",
              `<p>public${excluded}<button>EXCLUDED</button></p>`,
            ) +
            send,
        );
        assert.deepEqual(
          result.publicFrame.messages.map((message) => [
            message.id,
            message.text,
          ]),
          [["a", "public"]],
        );
      });
      await row("unfinished-table-and-pending-citation-hydration", async () => {
        const table = '<table style="width:40px;height:20px"></table>';
        const unfinished = await probe(
          user() + assistant("a", table, { action: false }) + send,
        );
        assert.deepEqual(
          [
            unfinished.publicFrame.messages[0].text,
            unfinished.publicFrame.messages[0].complete,
            unfinished.publicFrame.terminal,
          ],
          [null, false, false],
        );
        const pending = await probe(
          user() + assistant("a", "<p><a>source</a></p>") + send,
        );
        assert.deepEqual(
          [
            pending.publicFrame.messages[0].text,
            pending.publicFrame.messages[0].complete,
            pending.publicFrame.terminal,
          ],
          [null, false, false],
        );
        const hydrated = await probe(
          user() +
            assistant("a", '<p><a href="https://example.test">source</a></p>') +
            send,
        );
        assert.equal(
          hydrated.publicFrame.messages[0].id,
          pending.publicFrame.messages[0].id,
        );
        assert.equal(
          hydrated.publicFrame.messages[0].text,
          "[source](<https://example.test>)",
        );
        assert.equal(hydrated.publicFrame.terminal, true);
        await expectCode(
          () => probe(user() + assistant("a", table) + send),
          "CHATGPT_MARKDOWN_TABLE_UNSUPPORTED",
        );
      });
      await row("public-frame-status-commentary-answer-order", async () => {
        const result = await probe(
          user() +
            assistant("s", "Working", { channel: "status" }) +
            assistant("c", "Checking", { channel: "commentary" }) +
            assistant("a", "Answer") +
            send,
        );
        assert.deepEqual(
          result.publicFrame.messages.map(({ id, channel, text }) => [
            id,
            channel,
            text,
          ]),
          [
            ["s", "status", "Working"],
            ["c", "commentary", "Checking"],
            ["a", "answer", "Answer"],
          ],
        );
        assert.equal(result.publicFrame.terminal, true);
        const observed = new ChatGptPublicTurn("u", "s", 0).observe(
          result.publicFrame,
          0,
        );
        assert.deepEqual(
          observed.items.map((item) => item.channel),
          ["status", "commentary", "answer"],
        );
        assert.equal(observed.answer, "Answer");
      });
      await row("exact-current-user-no-prior-or-future-leakage", async () => {
        const html =
          user("old") +
          assistant("old-a", "PRIOR") +
          user() +
          assistant("a", "CURRENT") +
          user("future") +
          assistant("future-a", "FUTURE") +
          send;
        const result = await probe(html, { baseline: ["old", "old-a"] });
        assert.equal(result.turnUserId, "u");
        assert.equal(result.turnAssistantId, "a");
        assert.deepEqual(
          result.publicFrame.messages.map(({ id, text }) => [id, text]),
          [["a", "CURRENT"]],
        );
        assert.equal(result.assistantText, "");
        const absent = await probe(html, { userId: "missing" });
        assert.equal(absent.turnUserId, null);
        assert.equal(absent.publicFrame, undefined);
        const anchored = await probe(
          user("old") +
            assistant("old-a", "PRIOR") +
            user() +
            assistant("a", "CURRENT") +
            send,
          { userId: null, baseline: ["old", "old-a"] },
        );
        assert.equal(anchored.turnUserId, "u");
        const substring = await probe(
          user("u", "prefix synthetic prompt suffix") +
            assistant("a", "EXCLUDED") +
            send,
          { userId: null },
        );
        assert.equal(substring.publicFrame, undefined);
        await expectCode(
          () => probe(html, { userId: null, baseline: ["old"] }),
          "CHATGPT_PUBLIC_USER_AMBIGUOUS",
        );
        await expectCode(
          () => probe(user() + user() + assistant("a", "ambiguous") + send),
          "CHATGPT_PUBLIC_USER_AMBIGUOUS",
        );
      });
      await row(
        "completion-controls-owned-visible-and-not-streaming",
        async () => {
          for (const style of ["opacity:0", "content-visibility:hidden"]) {
            for (const onAncestor of [false, true]) {
              const action = onAncestor
                ? `<span style="${style}">${copy}</span>`
                : `<button style="${style}" data-testid="copy-turn-action-button">Copy</button>`;
              const pending = await probe(
                user() +
                  `<article>${assistant("a", "partial", { article: false })}${action}</article>` +
                  send,
              );
              assert.equal(pending.publicFrame.messages[0].complete, false);
              assert.equal(pending.publicFrame.terminal, false);
              await execute(
                `document.querySelector('[style]').removeAttribute('style')`,
              );
              const completed = await execute(
                taskProbeScript("synthetic prompt", [], {
                  semantic: true,
                  userId: "u",
                  assistantId: "a",
                }),
              );
              assert.equal(completed.publicFrame.messages[0].complete, true);
              assert.equal(completed.publicFrame.terminal, true);
            }
          }
          const old = user("old") + assistant("old-a", "old") + user();
          for (const current of [
            assistant("a", "partial", { action: false }),
            assistant("a", "partial", { attrs: 'data-is-streaming="true"' }),
            `<article>${assistant("a", "partial", { article: false })}<div hidden>${copy}</div></article>`,
            `<article>${assistant("a", "partial", { article: false })}<span style="display:contents" data-testid="copy-turn-action-button">Copy</span></article>`,
          ]) {
            const result = await probe(old + current + send);
            assert.equal(result.publicFrame.messages[0].complete, false);
            assert.equal(result.publicFrame.terminal, false);
          }
          const shared = await probe(
            user() +
              `<article>${assistant("a", "one", { article: false })}${assistant("b", "two", { article: false })}${copy}</article>` +
              send,
          );
          assert.ok(
            shared.publicFrame.messages.every((message) => !message.complete),
          );
          const stopped = await probe(
            user() +
              assistant("a", "answer") +
              send +
              '<button data-testid="stop-button">Stop</button>',
          );
          assert.equal(stopped.publicFrame.terminal, false);
          const noSend = await probe(user() + assistant("a", "answer"));
          assert.equal(noSend.publicFrame.terminal, false);
          const finished = await probe(
            user() + assistant("a", "answer") + send,
          );
          assert.equal(finished.publicFrame.terminal, true);
        },
      );
      await row("duplicate-and-unsupported-source-fail-closed", async () => {
        // Duplicate IDs are rejected by the production reducer, not the DOM reader.
        const duplicate = await probe(
          user() + assistant("a", "one") + assistant("a", "two") + send,
        );
        assert.throws(
          () =>
            new ChatGptPublicTurn("u", "a", 0).observe(
              duplicate.publicFrame,
              0,
            ),
          { message: "CHATGPT_PUBLIC_SOURCE_ORDER" },
        );
        await expectCode(
          () =>
            probe(
              user() +
                assistant("a", "unsupported", { channel: "analysis" }) +
                send,
            ),
          "CHATGPT_PUBLIC_CHANNEL_UNSUPPORTED",
        );
        await expectCode(
          () => probe(user() + assistant("a", "<canvas></canvas>") + send),
          "CHATGPT_MARKDOWN_RICH_OUTPUT_UNSUPPORTED",
        );
        await expectCode(
          () =>
            probe(
              user() +
                assistant(
                  "a",
                  '<p><a href="javascript:void(0)">unsupported</a></p>',
                ) +
                send,
            ),
          "CHATGPT_MARKDOWN_LINK_UNSUPPORTED",
        );
        await expectCode(
          () =>
            probe(
              user() +
                assistant("a", '<div class="markdown">duplicate root</div>') +
                send,
            ),
          "CHATGPT_PUBLIC_MARKDOWN_UNQUALIFIED",
        );
        await expectCode(
          () =>
            probe(
              user() +
                '<article><div data-message-author-role="assistant"><div class="markdown">unanchored</div></div></article>' +
                send,
            ),
          "CHATGPT_PUBLIC_SOURCE_UNANCHORED",
        );
        const parent = await probe(
          user() +
            assistant("a", "wrong parent", {
              attrs: 'data-parent-message-id="old"',
            }) +
            send,
        );
        assert.throws(
          () =>
            new ChatGptPublicTurn("u", "a", 0).observe(parent.publicFrame, 0),
          { message: "CHATGPT_PUBLIC_SOURCE_PARENT_UNQUALIFIED" },
        );
      });
      hidden("after-fixtures");
      receipt.status = "passed";
    } catch (error) {
      receipt.status = "failed";
      fail(error);
    } finally {
      save();
    }
    return receipt;
  };
}

const require = createRequire(import.meta.url);
const filename = fileURLToPath(import.meta.url);
const vnext = path.resolve(path.dirname(filename), "../..");
const output = path.resolve(vnext, "../_output");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mode = process.argv[2];
assert.ok(
  ["--build-only", "--run-native"].includes(mode) && process.argv.length === 3,
  "Choose --build-only or --run-native explicitly; native execution belongs to the parent lane",
);
assert.equal(process.versions.node, "24.20.0", "Use pinned Node 24.20.0");
await fs.mkdir(path.join(output, "evidence"), { recursive: true });
const temporary = await fs.mkdtemp(path.join(output, "chatgpt-public-source-"));
const receiptPath = path.join(
  output,
  "evidence",
  `${path.basename(temporary)}.json`,
);
const childReceipt = receiptPath.replace(/\.json$/u, ".native.json");
const report = {
  classification: "synthetic-html-hidden-native-electron-dom",
  limits: [
    "NOT live ChatGPT/provider selector evidence",
    "NOT native host/tool execution or product acceptance",
    "No account, credentials, private transcripts, persistent runtime, or live browser profile",
  ],
  mode,
  status: "running",
  startedAt: new Date().toISOString(),
  sourceSha256: null,
  sources: [],
  runtime: { node: process.versions.node },
  rows: [],
  error: null,
  cleanup: { launched: false, exitObserved: false, temporaryRemoved: false },
};
const save = async () => {
  await fs.writeFile(`${receiptPath}.tmp`, JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  await fs.rename(`${receiptPath}.tmp`, receiptPath);
};
const bounded = async (promise, milliseconds, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
let application;
let child;
let childExited;
let cancelled;
const cancellation = new Promise((_, reject) => {
  cancelled = reject;
});
// Install a rejection handler even when cancellation happens during build/close.
cancellation.catch(() => {});
const onSignal = (signal) => {
  report.error ??= `CANCELLED_${signal}`;
  cancelled(new Error(`CANCELLED_${signal}`));
};
const sigint = () => onSignal("SIGINT");
const sigterm = () => onSignal("SIGTERM");
process.on("SIGINT", sigint);
process.on("SIGTERM", sigterm);
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
  const bundle = path.join(temporary, "fixture.cjs");
  const config = { paths, receipt: childReceipt };
  const built = await build({
    absWorkingDir: vnext,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    outfile: bundle,
    metafile: true,
    // keepNames would inject helpers into .toString() serialization.
    keepNames: false,
    minify: false,
    logLevel: "silent",
    stdin: {
      resolveDir: vnext,
      sourcefile: "public-dom-fixture-entry.mjs",
      contents: `
      import { app, BrowserWindow, session } from 'electron';
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { createHash } from 'node:crypto';
      import { taskProbeScript } from './src/apps/desktop/chatgpt-route.ts';
      import { publicMarkdownBlock } from './src/apps/desktop/chatgpt-public-markdown.ts';
      import { publicContentVisible, ChatGptPublicTurn } from './src/apps/desktop/chatgpt-public-turn.ts';
      (${childMain.toString()})({ app, BrowserWindow, session, assert, fs, path,
        hash: bytes => createHash('sha256').update(bytes).digest('hex'),
        taskProbeScript, publicMarkdownBlock, publicContentVisible, ChatGptPublicTurn,
        config: ${JSON.stringify(config)} });`,
    },
    plugins: [
      {
        name: "record-exact-production-source",
        setup(context) {
          context.onLoad(
            { filter: /\/src\/.*\.ts$/ },
            async ({ path: file }) => {
              const bytes = await fs.readFile(file);
              report.sources.push({
                path: path.relative(vnext, file),
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
    path: "tests/e2e/chatgpt-public-source.e2e.mjs",
    sha256: hash(await fs.readFile(filename)),
  });
  report.sources.sort((a, b) => a.path.localeCompare(b.path));
  report.sourceSha256 = hash(JSON.stringify(report.sources));
  report.runtime.bundleSha256 = hash(await fs.readFile(bundle));
  report.runtime.esbuild = require("esbuild/package.json").version;
  report.runtime.playwright = require("playwright-core/package.json").version;
  report.runtime.electron = require("electron/package.json").version;
  const executable = require("electron");
  report.runtime.executableSha256 = hash(await fs.readFile(executable));
  report.runtime.extractedTreeDigest = await treeDigest(
    path.join(path.dirname(require.resolve("electron")), "dist/Electron.app"),
  );
  assert.equal(
    report.runtime.extractedTreeDigest,
    ELECTRON_RUNTIME.extractedTreeDigest,
  );
  report.runtime.digest = hash(JSON.stringify(report.runtime));
  report.bundleInputCount = Object.keys(built.metafile.inputs).length;
  await save();
  if (mode === "--build-only") {
    report.status = "build-only-native-not-run";
  } else {
    assert.equal(
      process.platform,
      "darwin",
      "This hidden app policy is qualified only on macOS",
    );
    if (report.error) throw new Error(report.error);
    const { _electron } = await import("playwright-core");
    report.cleanup.launchAttempted = true;
    await save();
    // Do not race launch against cancellation: retain its exact child handle or
    // let Playwright finish its own bounded launch-failure cleanup first.
    application = await _electron.launch({
      executablePath: executable,
      args: [bundle],
      artifactsDir: path.join(temporary, "playwright-artifacts"),
      chromiumSandbox: true,
      cwd: temporary,
      timeout: 15_000,
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
    child = application.process();
    report.cleanup.launched = true;
    report.cleanup.pid = child.pid;
    childExited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", resolve);
    });
    if (report.error) throw new Error(report.error);
    const native = await bounded(
      Promise.race([
        application.evaluate(() => globalThis.runPublicDomQualification()),
        cancellation,
      ]),
      35_000,
      "NATIVE_FIXTURE_TIMEOUT",
    );
    report.rows = native.rows;
    assert.equal(
      native.status,
      "passed",
      native.error ?? "Native fixture failed",
    );
    report.status = "passed";
  }
} catch (error) {
  report.status = "failed";
  report.error = String(error?.stack ?? error);
} finally {
  if (application) {
    try {
      await bounded(application.close(), 5_000, "ELECTRON_CLOSE_TIMEOUT");
      await bounded(childExited, 3_000, "ELECTRON_EXIT_TIMEOUT");
    } catch (error) {
      report.status = "failed";
      report.cleanup.error = String(error?.stack ?? error);
      // Exact ChildProcess handle only. Never pkill, an app name, or a receipt PID.
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      try {
        await bounded(childExited, 3_000, "ELECTRON_KILL_TIMEOUT");
      } catch (failure) {
        report.cleanup.killError = String(failure);
      }
    }
    report.cleanup.exitObserved =
      child.exitCode !== null || child.signalCode !== null;
    report.cleanup.exitCode = child.exitCode;
    report.cleanup.signal = child.signalCode;
  } else if (report.cleanup.launchAttempted) {
    report.cleanup.error =
      "Launch failed; Playwright owns launch cleanup; process exit not independently observed";
  }
  try {
    const native = JSON.parse(await fs.readFile(childReceipt, "utf8"));
    report.nativeReceipt = childReceipt;
    report.rows = native.rows;
    report.cleanup.windowsDestroyed = native.cleanup.windowsDestroyed;
    if (native.error) {
      report.status = "failed";
      report.error ??= native.error;
    }
    if (report.status === "passed")
      assert.equal(native.cleanup.windowsDestroyed, true);
  } catch (error) {
    if (report.cleanup.launched) {
      report.status = "failed";
      report.error ??= String(error);
    }
  }
  // Never delete state while an owned process could still be using it.
  if (!report.cleanup.launchAttempted || report.cleanup.exitObserved) {
    try {
      await fs.rm(temporary, { recursive: true, force: true });
      report.cleanup.temporaryRemoved = true;
    } catch (error) {
      report.status = "failed";
      report.cleanup.error = String(error);
    }
  } else report.cleanup.retainedTemporary = temporary;
  report.finishedAt = new Date().toISOString();
  await save();
  process.removeListener("SIGINT", sigint);
  process.removeListener("SIGTERM", sigterm);
  process.stdout.write(`${report.status}: ${receiptPath}\n`);
  process.exitCode = report.status === "failed" ? 1 : 0;
}
