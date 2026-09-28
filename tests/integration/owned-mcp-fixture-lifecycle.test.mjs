import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { expect, it } from "vitest";
import {
  ownedFixtureTransport,
  requireOwnedFixtureExit,
  closeOwnedFixture,
  preserveFixtureFailure,
} from "../e2e/owned-mcp-fixture-lifecycle.mjs";
let nextPid = 100;
class FakeTransport {
  async start() {
    this._process = new EventEmitter();
    Object.assign(this._process, {
      pid: ++nextPid,
      exitCode: null,
      signalCode: null,
    });
  }
  async close() {
    if (!this._process) return;
    this._process.exitCode = 0;
    this._process.emit("exit", 0, null);
  }
}
it("failed second handshake cannot inherit previous child's completed receipt", async () => {
  const first = ownedFixtureTransport(FakeTransport, {});
  await first.start();
  await first.close();
  expect(await requireOwnedFixtureExit(first, 10)).toMatchObject({ code: 0 });
  const second = ownedFixtureTransport(FakeTransport, {});
  const primary = new assert.AssertionError({ message: "HANDSHAKE_FAILURE" });
  await expect(
    (async () => {
      await second.start();
      throw primary;
    })(),
  ).rejects.toBe(primary);
  expect(second.ownedPid).not.toBe(first.ownedPid);
  await expect(requireOwnedFixtureExit(second, 10)).rejects.toThrow(
    "MCP_GRACEFUL_ACTUAL_EXIT_REQUIRED",
  );
  await closeOwnedFixture({ async close() {} }, second);
  expect(await requireOwnedFixtureExit(second, 10)).toMatchObject({
    pid: second.ownedPid,
    code: 0,
  });
});
it("afterStart and startup failures retain exact primary error with current child", async () => {
  const primary = new Error("PRIMARY_START");
  const transport = ownedFixtureTransport(FakeTransport, {}, () => {
    throw primary;
  });
  await expect(transport.start()).rejects.toBe(primary);
  expect(transport.ownedPid).toBeGreaterThan(1);
  await transport.close();
  expect(await requireOwnedFixtureExit(transport, 10)).toMatchObject({
    code: 0,
  });
  class Broken extends FakeTransport {
    async start() {
      await super.start();
      throw primary;
    }
  }
  const broken = ownedFixtureTransport(Broken, {});
  await expect(broken.start()).rejects.toBe(primary);
  expect(broken.ownedPid).toBeGreaterThan(1);
  await broken.close();
  await requireOwnedFixtureExit(broken, 10);
});
it("no owned child or forced exit never proves graceful cleanup", async () => {
  class NoChild {
    async start() {
      throw Error("NO_CHILD");
    }
  }
  const missing = ownedFixtureTransport(NoChild, {});
  await expect(missing.start()).rejects.toThrow("NO_CHILD");
  await expect(requireOwnedFixtureExit(missing, 10)).rejects.toThrow(
    "UNVERIFIED",
  );
  const forced = ownedFixtureTransport(FakeTransport, {});
  await forced.start();
  forced._process.emit("exit", null, "SIGTERM");
  await expect(requireOwnedFixtureExit(forced, 10)).rejects.toThrow(
    "GRACEFUL_ACTUAL_EXIT_REQUIRED",
  );
  await forced.close();
});
it("cleanup failure never masks primary assertion or cancellation", async () => {
  const primary = new assert.AssertionError({ message: "PRIMARY_ASSERTION" });
  const secondary = new Error("CLEANUP");
  let reported;
  await expect(
    preserveFixtureFailure(
      async () => {
        throw primary;
      },
      async () => {
        throw secondary;
      },
      (value) => {
        reported = value;
      },
    ),
  ).rejects.toBe(primary);
  expect(reported).toBe(secondary);
  await expect(
    preserveFixtureFailure(
      async () => {
        throw primary;
      },
      async () => {
        throw secondary;
      },
      () => {
        throw Error("REPORT");
      },
    ),
  ).rejects.toBe(primary);
  await expect(
    preserveFixtureFailure(
      async () => {},
      async () => {
        throw secondary;
      },
    ),
  ).rejects.toBe(secondary);
  expect(
    await preserveFixtureFailure(
      async () => "ok",
      async () => {},
    ),
  ).toBe("ok");
});
it("transport cannot be reused and close errors do not skip current exit check", async () => {
  const transport = ownedFixtureTransport(FakeTransport, {});
  await transport.start();
  await expect(transport.start()).rejects.toThrow("CANNOT_BE_REUSED");
  const primary = new Error("CLOSE_FAILURE");
  await expect(
    closeOwnedFixture(
      {
        async close() {
          throw primary;
        },
      },
      transport,
    ),
  ).rejects.toBe(primary);
  expect(await requireOwnedFixtureExit(transport, 10)).toMatchObject({
    code: 0,
  });
});
