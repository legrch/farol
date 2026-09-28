import assert from "node:assert/strict";
/** Capture this transport's owned child before the protocol handshake. */
export function ownedFixtureTransport(Base, parameters, afterStart = () => {}) {
  return new (class extends Base {
    ownedPid = null;
    ownedExit = null;
    attempted = false;
    async start() {
      assert.equal(this.attempted, false, "FIXTURE_TRANSPORT_CANNOT_BE_REUSED");
      this.attempted = true;
      let failed = false;
      let primary;
      try {
        await super.start();
      } catch (error) {
        failed = true;
        primary = error;
      }
      try {
        const child = this._process;
        assert.ok(
          Number.isSafeInteger(child?.pid) && child.pid > 1,
          "OWNED_MCP_CHILD_REQUIRED",
        );
        this.ownedPid = child.pid;
        this.ownedExit = new Promise((resolve) => {
          child.once("exit", (code, signal) => resolve({ code, signal }));
          if (child.exitCode !== null || child.signalCode !== null)
            resolve({ code: child.exitCode, signal: child.signalCode });
        });
      } catch (error) {
        if (failed) throw primary;
        throw error;
      }
      if (failed) throw primary;
      await afterStart(this);
    }
  })(parameters);
}
export async function requireOwnedFixtureExit(transport, timeoutMs = 3000) {
  assert.ok(
    transport?.ownedPid > 1 && transport.ownedExit,
    "MCP_CURRENT_CHILD_EXIT_UNVERIFIED",
  );
  let timer;
  try {
    const value = await Promise.race([
      transport.ownedExit,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    assert.deepEqual(
      value,
      { code: 0, signal: null },
      "MCP_GRACEFUL_ACTUAL_EXIT_REQUIRED",
    );
    return { pid: transport.ownedPid, ...value };
  } finally {
    clearTimeout(timer);
  }
}
export async function closeOwnedFixture(client, transport) {
  let failed = false;
  let primary;
  for (const effect of [
    () => client.close(),
    () => transport.close(),
    () => requireOwnedFixtureExit(transport),
  ]) {
    try {
      await effect();
    } catch (error) {
      if (!failed) {
        failed = true;
        primary = error;
      }
    }
  }
  if (failed) throw primary;
}
export async function preserveFixtureFailure(
  run,
  cleanup,
  reportSecondary = () => {},
) {
  let failed = false;
  let primary;
  let value;
  try {
    value = await run();
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (!failed) throw error;
    try {
      reportSecondary(error);
    } catch {}
  }
  if (failed) throw primary;
  return value;
}
