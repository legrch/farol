import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FarolModelRuntimeState } from "../../src/apps/desktop/farol-model-runtime-state";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function stateRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-model-state-"));
  roots.push(root);
  return path.join(root, "private", "model-endpoint");
}

describe("Farol Model runtime state", () => {
  it("mints a token on first use and keeps it stable, privately", async () => {
    const root = await stateRoot();
    const state = new FarolModelRuntimeState(root);

    expect(await state.currentToken()).toBeUndefined();
    const minted = await state.ensureToken();
    expect(minted.length).toBeGreaterThan(20);
    expect(await state.ensureToken()).toBe(minted);
    expect(await state.currentToken()).toBe(minted);

    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(path.join(root, "model-endpoint-token"))).mode & 0o777,
    ).toBe(0o600);
  });

  it("rotates the token so the previous one stops working", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    const first = await state.ensureToken();
    const rotated = await state.rotateToken();
    expect(rotated).not.toBe(first);
    expect(await state.currentToken()).toBe(rotated);
  });

  it("persists a port once and reports it back across instances", async () => {
    const root = await stateRoot();
    const state = new FarolModelRuntimeState(root);
    expect(await state.persistedPort()).toBeUndefined();
    await state.persistPort(54217);
    expect(await state.persistedPort()).toBe(54217);
    expect(await new FarolModelRuntimeState(root).persistedPort()).toBe(54217);
  });

  it("rejects an invalid port", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    await expect(state.persistPort(0)).rejects.toThrow(
      "FAROL_MODEL_STATE_PORT_INVALID",
    );
    await expect(state.persistPort(70000)).rejects.toThrow(
      "FAROL_MODEL_STATE_PORT_INVALID",
    );
  });

  it("reports liveness only while the recorded process is alive", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    expect(await state.readLiveness()).toBeUndefined();

    await state.markLive({
      pid: process.pid,
      port: 54217,
      startedAtIso: new Date().toISOString(),
    });
    const live = await state.readLiveness();
    expect(live?.pid).toBe(process.pid);
    expect(live?.port).toBe(54217);

    await state.clearLiveness();
    expect(await state.readLiveness()).toBeUndefined();
  });

  it("treats a liveness marker for a dead process as not running", async () => {
    const state = new FarolModelRuntimeState(await stateRoot());
    // A pid vanishingly unlikely to be alive on this machine.
    await state.markLive({
      pid: 999_999,
      port: 1,
      startedAtIso: new Date().toISOString(),
    });
    expect(await state.readLiveness()).toBeUndefined();
  });

  it("refuses a relative state root", () => {
    expect(() => new FarolModelRuntimeState("relative/path")).toThrow(
      "FAROL_MODEL_STATE_ROOT_NOT_ABSOLUTE",
    );
  });
});
