// Vitest runs a pure Node fixture in this same file with the exact VM flag.
// All child/Playwright host effects inside the fixture remain in-memory.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import {
  retainOriginalChild,
  closeOriginalChild,
} from "./setup-config-error-child.mjs";

if (!process.argv.includes("--pure-node-fixture")) {
  const { test } = await import("vitest");
  test("original-child and fault-report guards (pure Node fixture)", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--experimental-vm-modules",
        "--test-reporter=tap",
        fileURLToPath(import.meta.url),
        "--pure-node-fixture",
      ],
      { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.match(output, /# tests 12\b/u);
    assert.match(output, /# pass 12\b/u);
    assert.match(output, /# fail 0\b/u);
  });
} else {
  const { test } = await import("node:test");
  const { createContext, runInContext, SourceTextModule, SyntheticModule } = vm;
  function fakeApplication(exit = null, signal = null) {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      exitCode: exit,
      signalCode: signal,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    let processCalls = 0;
    let closeCalls = 0;
    return {
      child,
      application: {
        process() {
          assert.equal(
            ++processCalls,
            1,
            "dispatcher must never be read again",
          );
          return child;
        },
        async close() {
          closeCalls += 1;
          finish(0, null);
        },
      },
      finish,
      closeCalls: () => closeCalls,
    };
    function finish(code, signalCode) {
      child.exitCode = code;
      child.signalCode = signalCode;
      child.emit("exit", code, signalCode);
    }
  }

  const wait = (promise) => promise;

  for (const [exit, signal] of [
    [1, null],
    [null, "SIGTERM"],
    [0, null],
  ]) {
    test(`already terminal child: ${exit}/${signal}; no close`, async () => {
      const fake = fakeApplication(exit, signal);
      const observations = [];
      const owned = retainOriginalChild(fake.application, observations, {});
      const result = await closeOriginalChild(fake.application, owned, wait);
      assert.equal(result.terminal, true);
      assert.equal(result.exit, exit);
      assert.equal(result.signal, signal);
      assert.equal(fake.closeCalls(), 0);
      assert.equal(observations.length, 1);
    });
  }

  test("exit listener and diagnostics survive dispatcher loss before UI", async () => {
    const fake = fakeApplication();
    const observations = [];
    const owned = retainOriginalChild(fake.application, observations, {});
    assert.equal(fake.child.listenerCount("exit"), 1);
    fake.child.stderr.emit("data", Buffer.from("SETTINGS_UNAVAILABLE"));
    fake.finish(1, null);
    fake.application.process = () => {
      throw new TypeError("dispatcher vanished");
    };
    const result = await closeOriginalChild(fake.application, owned, wait);
    assert.equal(result.exit, 1);
    assert.equal(result.stderr, "SETTINGS_UNAVAILABLE");
    assert.equal(observations[0].stderr, "SETTINGS_UNAVAILABLE");
    assert.equal(fake.closeCalls(), 0);
  });

  test("clean active child closes once using the retained exit listener", async () => {
    const fake = fakeApplication();
    const owned = retainOriginalChild(fake.application, [], {});
    const result = await closeOriginalChild(fake.application, owned, wait);
    assert.equal(result.terminal, true);
    assert.equal(result.exit, 0);
    assert.equal(result.closeAttempted, true);
    assert.equal(fake.closeCalls(), 1);
  });

  test("close error stays separate from exact subsequent child exit", async () => {
    const fake = fakeApplication();
    const closeError = new Error("close refused");
    fake.application.close = async () => {
      queueMicrotask(() => fake.finish(7, null));
      throw closeError;
    };
    const owned = retainOriginalChild(fake.application, [], {});
    const result = await closeOriginalChild(fake.application, owned, wait);
    assert.equal(result.closeError, closeError);
    assert.equal(result.exitError, undefined);
    assert.equal(result.terminal, true);
    assert.equal(result.exit, 7);
  });

  test("unknown exit remains held without repeating close", async () => {
    const fake = fakeApplication();
    let calls = 0;
    fake.application.close = () => {
      calls += 1;
      return new Promise(() => {});
    };
    const owned = retainOriginalChild(fake.application, [], {});
    const timeout = (_promise, label) => Promise.reject(new Error(label));
    const result = await closeOriginalChild(fake.application, owned, timeout);
    assert.equal(result.terminal, false);
    assert.equal(result.exit, null);
    assert.equal(result.signal, null);
    assert.equal(result.closeError.message, "SETUP_CONFIG_FAULT_CLOSE_UNKNOWN");
    assert.equal(result.exitError.message, "SETUP_CONFIG_FAULT_EXIT_UNKNOWN");
    await closeOriginalChild(fake.application, owned, timeout);
    assert.equal(calls, 1);
    fake.finish(0, null);
    await owned.terminal;
  });

  // Execute the actual harness with all host effects replaced at its import
  // boundary. This checks reporting/control flow, not native startup or admission.
  async function earlyFailureHarness({
    launchRejects = false,
    closeFails = false,
    childUnavailable = false,
    fixtureCloseFails = false,
  }) {
    const fake = fakeApplication();
    const primary = new Error("original startup failure");
    const cleanup = new Error("original cleanup failure");
    const fixtureCleanup = new Error("fixture cleanup failure");
    let removed = false;
    let launchCalls = 0;
    let fixtureClosed = false;
    const output = [];
    const context = createContext({
      process: {
        cwd: () => "/in-memory/repo",
        stdout: { write: (value) => output.push(value) },
      },
      setTimeout,
      clearTimeout,
    });
    // The CLI assertion compares arrays from the harness's own VM realm.
    runInContext('process.argv = ["node", "harness", "--dev-only"]', context);
    const module = new SourceTextModule(
      await readFile(
        new URL("./setup-config-error.e2e.mjs", import.meta.url),
        "utf8",
      ),
      { context },
    );
    const fixture = {
      listening: false,
      once() {},
      listen(_port, _host, resolve) {
        this.listening = true;
        resolve();
      },
      address: () => ({ port: 1234 }),
      close(resolve) {
        this.listening = false;
        fixtureClosed = true;
        resolve(fixtureCloseFails ? fixtureCleanup : undefined);
      },
    };
    fake.application.firstWindow = async () => {
      assert.equal(fake.child.listenerCount("exit"), 1);
      if (!closeFails) fake.finish(1, null);
      throw primary;
    };
    if (closeFails)
      fake.application.close = async () => {
        fake.finish(0, null);
        throw cleanup;
      };
    if (childUnavailable) fake.application.process = () => undefined;
    const mocks = {
      "node:http": { createServer: () => fixture },
      "node:fs/promises": {
        default: {
          realpath: async (value) => value,
          mkdtemp: async () => "/in-memory/config-fault-profile",
          chmod: async () => {},
          writeFile: async () => {},
          mkdir: async () => {},
          rm: async () => {
            removed = true;
          },
        },
      },
      "playwright-core": {
        _electron: {
          launch: async () => {
            launchCalls += 1;
            if (launchRejects) throw primary;
            return fake.application;
          },
        },
      },
      "./setup-config-error-child.mjs": {
        retainOriginalChild,
        closeOriginalChild,
      },
      "./native-preview-admission.mjs": {
        assertNativePreviewAdmission: async () => ({}),
        recheckNativePreviewIsolation: () =>
          assert.fail("unexpected isolation read"),
        readOwnedStartupMarker: () => assert.fail("unexpected profile read"),
      },
      "./current-react-setup.mjs": Object.fromEntries(
        [
          "waitForReactShell",
          "openSetup",
          "setupStep",
          "assertSetupFinish",
        ].map((name) => [name, () => assert.fail("unexpected UI action")]),
      ),
    };
    await module.link(async (specifier) => {
      const exports = mocks[specifier] ?? (await import(specifier));
      return new SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [name, value] of Object.entries(exports))
            this.setExport(name, value);
        },
        { context },
      );
    });
    let failure;
    try {
      await module.evaluate();
    } catch (error) {
      failure = error;
    }
    assert.equal(
      output.length,
      1,
      `report must precede the failure: ${failure}`,
    );
    assert.equal(fixtureClosed, true);
    assert.equal(removed, false);
    assert.equal(launchCalls, 1);
    if (!childUnavailable) assert.equal(failure.errors[0], primary);
    return {
      report: JSON.parse(output[0]),
      failure,
      cleanup,
      fixtureCleanup,
      fake,
    };
  }

  test("early startup report preserves original error, PID/exit and profile", async () => {
    const { report, fake } = await earlyFailureHarness({});
    assert.equal(report.primaryFailure, "Error: original startup failure");
    assert.equal(report.cleanupUnknown, false);
    const run = report.observations.find(
      (value) => value.kind === "config-fault-run",
    );
    assert.equal(run.failureStage, "first-window");
    assert.equal(run.profileCleanup, "retained");
    assert.equal(run.child.pid, 123);
    assert.equal(run.child.exit, 1);
    assert.equal(run.child.signal, null);
    assert.equal(fake.closeCalls(), 0);
  });

  test("report keeps primary and cleanup failure separate", async () => {
    const { report, failure, cleanup } = await earlyFailureHarness({
      closeFails: true,
    });
    assert.equal(report.primaryFailure, "Error: original startup failure");
    assert.deepEqual(report.cleanupFailures, [String(cleanup)]);
    assert.equal(failure.errors[1], cleanup);
    assert.equal(report.cleanupUnknown, false);
  });

  test("launch rejection reports missing child as unknown and retains profile", async () => {
    const { report } = await earlyFailureHarness({ launchRejects: true });
    assert.equal(report.primaryFailure, "Error: original startup failure");
    assert.equal(report.cleanupUnknown, true);
    assert.equal(report.observations[0].child, null);
    assert.equal(report.observations[0].profileCleanup, "retained");
  });

  test("missing dispatcher child is reported as unknown without a close", async () => {
    const { report, fake } = await earlyFailureHarness({
      childUnavailable: true,
    });
    assert.equal(
      report.primaryFailure,
      "Error: SETUP_CONFIG_FAULT_CHILD_UNAVAILABLE",
    );
    assert.equal(report.cleanupUnknown, true);
    assert.equal(report.observations[0].child, null);
    assert.equal(fake.closeCalls(), 0);
  });

  test("fixture cleanup failure cannot suppress the original fault report", async () => {
    const { report, cleanup, fixtureCleanup } = await earlyFailureHarness({
      closeFails: true,
      fixtureCloseFails: true,
    });
    assert.equal(report.primaryFailure, "Error: original startup failure");
    assert.deepEqual(report.cleanupFailures, [
      String(cleanup),
      String(fixtureCleanup),
    ]);
    assert.equal(report.cleanupUnknown, true);
  });
}
