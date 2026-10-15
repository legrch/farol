// One retained CPU-only Go child; this proves contract parity only.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type Reply = { view: unknown } | { error: string };

export async function startGoTaskCatalogueFixture() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const go = process.env.FAROL_TEST_GO ?? "go";
  const env = {
    ...process.env,
    GOTOOLCHAIN: "local",
    GOPROXY: "off",
    GOSUMDB: "off",
  };
  try {
    if (
      !execFileSync(go, ["version"], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 5000,
      }).startsWith("go version go1.26.2 ")
    )
      throw new Error("fixture_go_toolchain_mismatch");
  } catch (error) {
    if (
      !process.env.FAROL_TEST_GO &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      throw new Error("fixture_go_compiler_unavailable");
    throw error;
  }

  const directory = await mkdtemp(path.join(tmpdir(), "farol-task-catalogue-"));
  const executable = path.join(directory, "task-catalogue");
  try {
    execFileSync(
      go,
      [
        "build",
        "-buildvcs=false",
        "-o",
        executable,
        "./tests/fixtures/go-task-catalogue-fixture",
      ],
      { cwd: root, env, timeout: 30000, stdio: "pipe" },
    );
  } catch (error) {
    await rm(directory, { recursive: true });
    throw error;
  }

  const child = spawn(executable, [], {
    cwd: directory,
    env: { PATH: process.env.PATH ?? "" },
    stdio: "pipe",
  });
  let diagnostic = "";
  let overflow = false;
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(diagnostic) + chunk.length > 65536) overflow = true;
    else diagnostic += chunk.toString("utf8");
  });
  let pending:
    { resolve(value: Reply): void; reject(error: Error): void } | undefined;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const waiter = pending;
    pending = undefined;
    if (!waiter) {
      overflow = true;
      return;
    }
    try {
      if (Buffer.byteLength(line, "utf8") > 2 << 20)
        throw new Error("fixture_reply_too_large");
      const value = JSON.parse(line) as Reply;
      if (
        !value ||
        typeof value !== "object" ||
        ("error" in value
          ? Object.keys(value).length !== 1 || typeof value.error !== "string"
          : Object.keys(value).length !== 1 || !("view" in value))
      )
        throw new Error("fixture_reply_invalid");
      waiter.resolve(value);
    } catch (error) {
      waiter.reject(
        error instanceof Error ? error : new Error("fixture_reply_invalid"),
      );
    }
  });
  const terminal = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      pending?.reject(new Error("fixture_exited_pending_reply"));
      pending = undefined;
      resolve({ code, signal });
    });
  });
  let closing: Promise<void> | undefined;
  return {
    async describe(
      config: string,
      harness: string,
      catalogue: string,
    ): Promise<Reply> {
      if (pending || closing)
        throw new Error("fixture_request_lifecycle_invalid");
      const request = JSON.stringify({ config, harness, catalogue }) + "\n";
      if (Buffer.byteLength(request, "utf8") > 2 << 20)
        throw new Error("fixture_request_too_large");
      return new Promise<Reply>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = undefined;
          reject(new Error("fixture_reply_timeout"));
        }, 5000);
        pending = {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        child.stdin.write(request, (error) => {
          if (error) pending?.reject(error);
        });
      });
    },
    close(): Promise<void> {
      return (closing ??= (async () => {
        child.stdin.end();
        const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
        try {
          const ended = await terminal;
          if (
            ended.code !== 0 ||
            ended.signal !== null ||
            diagnostic !== "" ||
            overflow
          )
            throw new Error("fixture_original_terminal_not_clean");
        } finally {
          clearTimeout(kill);
          lines.close();
          await rm(directory, { recursive: true });
        }
      })());
    },
  };
}
