// One retained CPU-only Go fixture process; no native host or provider activity.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  validate,
  type TaskCodexSource,
} from "../../../apps/desktop/bridge/wire.ts";

type Reply =
  | {
      status: "available" | "absent";
      source?: TaskCodexSource;
      read?: { threadId: string; turnId: string };
    }
  | { error: string };
export async function startTaskSourceFixture() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const go = process.env.FAROL_TEST_GO ?? "go";
  const env = {
    ...process.env,
    GOTOOLCHAIN: "local",
    GOPROXY: "off",
    GOSUMDB: "off",
  };
  if (
    !execFileSync(go, ["version"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 5000,
    }).startsWith("go version go1.26.2 ")
  )
    throw new Error("fixture_go_toolchain_mismatch");
  const directory = await mkdtemp(
    path.join(tmpdir(), "farol-task-source-cpu-"),
  );
  const executable = path.join(directory, "task-source");
  try {
    execFileSync(
      go,
      [
        "build",
        "-buildvcs=false",
        "-o",
        executable,
        "./tests/fixtures/task-source",
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
  let diagnostic = "",
    overflow = false;
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
      const out = JSON.parse(line) as Reply;
      if ("error" in out) {
        if (
          Object.keys(out).length !== 1 ||
          ![
            "TASK_CURRENT_SOURCE_INVALID",
            "TASK_CURRENT_SOURCE_UNAVAILABLE",
          ].includes(out.error)
        )
          throw new Error("fixture_error_invalid");
      } else {
        if (
          !["available", "absent"].includes(out.status) ||
          Object.keys(out).some(
            (k) => !["status", "source", "read"].includes(k),
          ) ||
          (out.status === "available") !== (out.source !== undefined) ||
          (out.source !== undefined &&
            !validate("TaskCodexSource", out.source)) ||
          (out.status === "absent" && out.read !== undefined)
        )
          throw new Error("fixture_reply_invalid");
      }
      waiter.resolve(out);
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
    async resolve(settings: string, nowMillis: number): Promise<Reply> {
      if (pending || closing)
        throw new Error("fixture_request_lifecycle_invalid");
      return new Promise<Reply>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = undefined;
          reject(new Error("fixture_reply_timeout"));
        }, 5000);
        pending = {
          resolve: (out) => {
            clearTimeout(timer);
            resolve(out);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        child.stdin.write(
          JSON.stringify({ settings, nowMillis }) + "\n",
          (error) => {
            if (error) pending?.reject(error);
          },
        );
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
