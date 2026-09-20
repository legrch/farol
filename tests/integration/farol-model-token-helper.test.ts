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
  new URL("../../resources/farol-model-token-helper.mjs", import.meta.url),
);

type HelperModule = Readonly<{
  privateFileProblem: (
    info: Readonly<{
      isFile: () => boolean;
      isSymbolicLink: () => boolean;
      nlink: number;
      uid: number;
      mode: number;
    }>,
    expectedUid: number | undefined,
  ) => string | null;
}>;

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

async function runningState(root: string): Promise<string> {
  const state = new FarolModelRuntimeState(root);
  const token = await state.ensureToken();
  await state.markLive({
    pid: process.pid,
    port: 12345,
    startedAtIso: new Date().toISOString(),
  });
  return token;
}

describe("Farol Model token helper", () => {
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
    const token = await runningState(root);

    const result = await runHelper(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(token);
  });

  it("never reads the token from the environment", async () => {
    const root = await stateRoot();
    const token = await runningState(root);

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

  it("prints nothing for an empty or malformed token file", async () => {
    const root = await stateRoot();
    await runningState(root);
    for (const damaged of ["", "not a token\n"]) {
      await fs.writeFile(path.join(root, "model-endpoint-token"), damaged, {
        mode: 0o600,
      });
      const result = await runHelper(root);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/no usable token/u);
    }
  });

  it("refuses a token file that is not private", async () => {
    const root = await stateRoot();
    await runningState(root);
    await fs.chmod(path.join(root, "model-endpoint-token"), 0o640);
    const result = await runHelper(root);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/file is not private/u);
  });

  it("checks the owner as well as the mode (the decision, with a file no unprivileged test can create)", async () => {
    const { privateFileProblem } = (await import(helperPath)) as HelperModule;
    const plain = {
      isFile: () => true,
      isSymbolicLink: () => false,
      nlink: 1,
      uid: 501,
      mode: 0o100600,
    };
    expect(privateFileProblem(plain, 501)).toBeNull();
    expect(privateFileProblem(plain, 502)).toBe(
      "file is not owned by the current user",
    );
    expect(privateFileProblem({ ...plain, mode: 0o100640 }, 501)).toBe(
      "file is not private",
    );
    expect(privateFileProblem({ ...plain, nlink: 2 }, 501)).toBe("unsafe file");
    expect(
      privateFileProblem({ ...plain, isSymbolicLink: () => true }, 501),
    ).toBe("unsafe file");
    // The owner check comes before the mode check, so a foreign 0600 file
    // is named for what it is.
    expect(privateFileProblem({ ...plain, uid: 0 }, 501)).toBe(
      "file is not owned by the current user",
    );
  });

  it("requires an absolute --state-root", async () => {
    const result = await execFileAsync(
      process.execPath,
      [helperPath, "--state-root", "relative/path"],
      { timeout: 5000 },
    ).catch((error) => error as { code: number; stderr: string });
    expect((result as { code: number }).code).not.toBe(0);
    expect((result as { stderr: string }).stderr).toMatch(/--state-root/u);
    expect((result as { stderr: string }).stderr).toMatch(
      /farol-model-token-helper/u,
    );
  });
});
