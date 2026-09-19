import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { FarolModelRuntimeState } from "../../src/apps/desktop/farol-model-runtime-state";

const execFileAsync = promisify(execFile);
const helperPath = fileURLToPath(
  new URL("../../resources/farol-model-credential-helper.mjs", import.meta.url),
);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function stateRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-model-helper-"));
  roots.push(root);
  return path.join(root, "private", "model-endpoint");
}

async function runHelper(
  root: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [helperPath, "--state-root", root],
      { timeout: 5000 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("Farol Model credential helper", () => {
  it("fails with a readable one-line reason when Farol is not running", async () => {
    const root = await stateRoot();
    const result = await runHelper(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Farol is not running/u);
    expect(result.stdout).toBe("");
  });

  it("fails when the liveness marker names a process that is not alive", async () => {
    const root = await stateRoot();
    const state = new FarolModelRuntimeState(root);
    await state.ensureToken();
    await state.markLive({
      pid: 999_999,
      port: 12345,
      startedAtIso: new Date().toISOString(),
    });
    const result = await runHelper(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Farol is not running/u);
  });

  it("prints the current token and exits 0 when Farol is running", async () => {
    const root = await stateRoot();
    const state = new FarolModelRuntimeState(root);
    const token = await state.ensureToken();
    await state.markLive({
      pid: process.pid,
      port: 12345,
      startedAtIso: new Date().toISOString(),
    });

    const result = await runHelper(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(token);
  });

  it("never reads the token from the environment", async () => {
    const root = await stateRoot();
    const state = new FarolModelRuntimeState(root);
    const token = await state.ensureToken();
    await state.markLive({
      pid: process.pid,
      port: 12345,
      startedAtIso: new Date().toISOString(),
    });

    const { stdout } = await execFileAsync(
      process.execPath,
      [helperPath, "--state-root", root],
      {
        timeout: 5000,
        env: { ...process.env, FAROL_MODEL_TOKEN: "environment-value" },
      },
    );
    expect(stdout).toBe(token);
    expect(stdout).not.toBe("environment-value");
  });

  it("requires an absolute --state-root", async () => {
    const result = await execFileAsync(
      process.execPath,
      [helperPath, "--state-root", "relative/path"],
      { timeout: 5000 },
    ).catch((error) => error as { code: number; stderr: string });
    expect((result as { code: number }).code).not.toBe(0);
    expect((result as { stderr: string }).stderr).toMatch(/--state-root/u);
  });
});
