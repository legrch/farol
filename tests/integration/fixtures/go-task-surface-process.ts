// Controlled CPU integration only: real Client/TaskBridge and Go TaskSurface,
// with an in-memory journal/host and scripted Codex socket. No native activation,
// Electron, installed profile, live provider or delivery acceptance is proved.
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "../../../apps/desktop/bridge/client.ts";
import { parseJSON } from "../../../apps/desktop/bridge/frame.ts";
import { TaskBridge } from "../../../apps/desktop/bridge/task.ts";
import {
  validate,
  type TaskHandle,
} from "../../../apps/desktop/bridge/wire.ts";

const scenarios = ["followup", "provider-lost-reply"] as const;
export type TaskSurfaceScenario = (typeof scenarios)[number];
// This dependency belongs to Root. Read its exact bytes; never copy or replace
// Go source to make an incomplete writer appear to be an integrated checkout.
const goFixtureSHA256 =
  "68f4b8a953efa0565f560bc43bb61784048a6dc1120d4792d5c3821674d9f8fc";
const byteBudget = 65536;
const lineBudget = 4096;
const count = z.number().int().nonnegative().max(10000);
const countersSchema = z.strictObject({
  launches: count,
  threadStart: count,
  turnStart: count,
  threadRead: count,
});
export type TaskSurfaceCounters = z.infer<typeof countersSchema>;
const handleSchema = z
  .strictObject({ handleId: z.string() })
  .refine((value) => validate("TaskHandle", value));
const readySchema = z.strictObject({
  kind: z.literal("ready"),
  buildId: z.literal("task-bridge-cpu"),
  profileId: z.literal("profile"),
  backendGeneration: z.literal("backend"),
  handle: handleSchema,
});
const replySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    kind: z.literal("reply"),
    id: z.string().refine((id) => validate("id", id)),
    ok: z.literal(true),
    handle: handleSchema.optional(),
    stats: countersSchema.optional(),
    serverClosed: z.literal(true).optional(),
    profileClosed: z.literal(true).optional(),
  }),
  z.strictObject({
    kind: z.literal("reply"),
    id: z.string().refine((id) => validate("id", id)),
    ok: z.literal(false),
    code: z.literal("fixture_control_refused"),
  }),
]);
type Reply = Extract<z.infer<typeof replySchema>, { ok: true }>;
type Control =
  | { command: "complete"; turnId: "turn-1" | "turn-2" }
  | { command: "follow" | "stats" | "close" };
export interface TaskSurfaceCloseProof {
  classification: "controlled-go-task-surface-cpu";
  scenario: TaskSurfaceScenario;
  originalPid: number;
  exitCode: 0;
  signal: null;
  serverClosed: true;
  profileClosed: true;
  runnerPassed: true;
  stats: TaskSurfaceCounters;
}
export interface TaskSurfaceFixture {
  client: Client;
  task: TaskBridge;
  handle: TaskHandle;
  complete(turnId: "turn-1" | "turn-2"): Promise<void>;
  follow(): Promise<TaskHandle>;
  stats(): Promise<TaskSurfaceCounters>;
  close(): Promise<TaskSurfaceCloseProof>;
}

type OriginalClose = {
  code: number | null;
  signal: NodeJS.Signals | null;
};
type DiagnosticCapture = {
  observedBytes: number;
  truncated: boolean;
  redacted: string;
};
interface CloseFailureEvidence {
  classification: "controlled-go-task-surface-cpu-close-failure";
  scenario: TaskSurfaceScenario;
  originalPid: number | null;
  originalClose: OriginalClose | null;
  closeControlIssued: boolean;
  requestEOFIssued: boolean;
  closeAckReceived: boolean;
  serverClosed: boolean;
  profileClosed: boolean;
  runnerPassed: boolean;
  firstFailureCode: string | null;
  parserCause: string | null;
  cleanupFailureCode: string | null;
  stdout: DiagnosticCapture;
  stderr: DiagnosticCapture;
}
export class TaskSurfaceCloseError extends Error {
  constructor(readonly evidence: CloseFailureEvidence) {
    // The report is bounded and deterministically redacted before rendering.
    super(`fixture_original_close_unknown ${JSON.stringify(evidence)}`);
    this.name = "TaskSurfaceCloseError";
  }
}

const fixtureMessages = new Set([
  "fixture scenario refused",
  "fixture inherited pipes unavailable",
  "fixture close repeated",
  "fixture original server terminal unknown",
  "fixture control write failed",
  "fixture control invalid",
  "fixture control trailing value",
  "fixture next trusted selection failed",
  "fixture control read failed",
]);
// Fail-closed diagnostics: only known fixture messages and runner markers can
// survive as text. Control values, paths, unknown logs and potential private
// bodies become byte-count/hash summaries; no raw stderr/stdout is persisted.
function diagnosticCapture() {
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  let observedBytes = 0;
  let truncated = false;
  return {
    push(chunk: Buffer): void {
      observedBytes = Math.min(byteBudget + 1, observedBytes + chunk.length);
      const remaining = byteBudget - retainedBytes;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) {
        const saved = Buffer.from(chunk.subarray(0, remaining));
        chunks.push(saved);
        retainedBytes += saved.length;
      }
    },
    snapshot(): DiagnosticCapture {
      const lines = Buffer.concat(chunks, retainedBytes)
        .toString("utf8")
        .split("\n");
      const redacted = lines
        .slice(0, 64)
        .map((line) => {
          if (
            /^(PASS|FAIL|--- (FAIL|PASS): TestTaskBridgeCPUFixture \([0-9.]+s\)|panic: test timed out after [0-9.]+[a-z]+)$/u.test(
              line,
            )
          )
            return line;
          const fixture =
            /^\s*taskbridgefixture_test\.go:([0-9]+): (.+)$/u.exec(line);
          if (fixture && fixtureMessages.has(fixture[2]!))
            return `taskbridgefixture_test.go:${fixture[1]}: ${fixture[2]}`;
          if (line === "") return "";
          return `[redacted bytes=${Buffer.byteLength(line)} sha256=${createHash("sha256").update(line).digest("hex")}]`;
        })
        .join("\n");
      return {
        observedBytes,
        truncated:
          truncated || lines.length > 64 || Buffer.byteLength(redacted) > 8192,
        redacted: redacted.slice(0, 8192),
      };
    },
  };
}

const parserMessages = new Set([
  "runner_line_unexpected",
  "control_after_close",
  "ready_repeated_or_late",
  "ready_missing",
  "control_reply_uncorrelated",
  "control_reply_shape_crossed",
  "line_budget",
  "invalid Unicode string",
  "invalid JSON string",
  "JSON depth exceeded",
  "invalid JSON key",
  "duplicate JSON key",
  "invalid JSON object",
  "invalid JSON container",
  "truncated JSON",
  "invalid JSON value",
  "trailing JSON",
]);
function parserFailureCode(error: unknown): string {
  if (error instanceof z.ZodError) {
    const fields = new Set([
      "kind",
      "id",
      "ok",
      "handle",
      "handleId",
      "stats",
      "launches",
      "threadStart",
      "turnStart",
      "threadRead",
      "serverClosed",
      "profileClosed",
    ]);
    return `schema:${error.issues
      .slice(0, 8)
      .map(
        (issue) =>
          `${issue.code}@${issue.path.every((part) => typeof part === "string" && fields.has(part)) ? issue.path.join(".") : "redacted_path"}`,
      )
      .join(",")}`;
  }
  if (error instanceof Error && parserMessages.has(error.message))
    return error.message;
  return "utf8_or_unclassified_parse_failure";
}

function bounded<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function startGoTaskSurfaceFixture(
  scenario: TaskSurfaceScenario,
): Promise<TaskSurfaceFixture> {
  if (!scenarios.includes(scenario))
    throw new Error("fixture_scenario_invalid");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const source = await readFile(
    path.join(root, "boot/taskbridgefixture_test.go"),
  );
  if (createHash("sha256").update(source).digest("hex") !== goFixtureSHA256)
    throw new Error("fixture_go_source_mismatch");
  const directory = await mkdtemp(
    path.join(tmpdir(), "farol-task-surface-cpu-"),
  );
  const executable = path.join(directory, "task-peer.test");
  const buildEnv: NodeJS.ProcessEnv = {
    GOTOOLCHAIN: "local",
    GOPROXY: "off",
    GOSUMDB: "off",
  };
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "GOCACHE",
    "GOPATH",
    "GOMODCACHE",
  ] as const) {
    if (process.env[key] !== undefined) buildEnv[key] = process.env[key];
  }
  try {
    // One controlled test-binary compilation, no production package or probes.
    execFileSync(
      process.env.FAROL_TEST_GO ?? "go",
      ["test", "-c", "-o", executable, "./boot"],
      {
        cwd: root,
        env: buildEnv,
        timeout: 60000,
        maxBuffer: byteBudget,
        stdio: "pipe",
      },
    );
  } catch {
    // Preserve the disposable build on failure; do not choose another compiler.
    throw new Error("fixture_build_failed_or_unknown");
  }
  const child = spawn(
    executable,
    ["-test.run=^TestTaskBridgeCPUFixture$", "-test.timeout=20s"],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH ?? "",
        FAROL_TASK_BRIDGE_CPU_SCENARIO: scenario,
      },
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  // Only the ORIGINAL child's close event proves terminal state. An error or
  // exit notification alone never substitutes for exact process/pipe closure.
  let spawnFailed = false;
  let originalClose: OriginalClose | undefined;
  const terminal = new Promise<OriginalClose>((resolve) => {
    child.once("close", (code, signal) => {
      originalClose = { code, signal };
      resolve(originalClose);
    });
  });
  const requestPipe = child.stdio[3];
  const responsePipe = child.stdio[4];
  if (
    !child.stdin ||
    !child.stdout ||
    !child.stderr ||
    !(requestPipe instanceof Duplex) ||
    !(responsePipe instanceof Duplex)
  ) {
    child.once("error", () => {
      spawnFailed = true;
    });
    child.stdin?.end();
    if (requestPipe instanceof Duplex) requestPipe.end();
    await bounded(terminal, 5000, "fixture_original_terminal_unknown");
    throw new Error("fixture_descriptors_unavailable");
  }
  const input = child.stdin;
  const output = child.stdout;
  const diagnostics = child.stderr;
  // Descriptor/lifecycle projection only, with the actual pipe objects. There
  // is no fake Client, framing shim, kill method or replacement child.
  const projected = new EventEmitter();
  // The original process may emit an error after Client detaches during close.
  projected.on("error", () => undefined);
  Object.defineProperties(projected, {
    stdin: { value: requestPipe },
    stdout: { value: responsePipe },
    stderr: { value: diagnostics },
    pid: { get: () => child.pid },
    exitCode: { get: () => child.exitCode },
    signalCode: { get: () => child.signalCode },
  });
  const client = new Client(projected as ChildProcessWithoutNullStreams, false);
  let failure: Error | undefined;
  let parserCause: string | undefined;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutCapture = diagnosticCapture();
  const stderrCapture = diagnosticCapture();
  let carry = Buffer.alloc(0);
  let readySeen = false;
  let runnerPassed = false;
  let closeReply: Reply | undefined;
  let closing: Promise<TaskSurfaceCloseProof> | undefined;
  let closeControlIssued = false;
  let requestEOFIssued = false;
  let issued = 0;
  type Pending = {
    command: Control["command"];
    resolve: (reply: Reply) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const pending = new Map<string, Pending>();
  let acceptReady!: (value: z.infer<typeof readySchema>) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<z.infer<typeof readySchema>>((resolve, reject) => {
    acceptReady = resolve;
    rejectReady = reject;
  });
  // Setup can fail before ready is awaited, but still retains that same error.
  void ready.catch(() => undefined);
  const fail = (code: string): void => {
    failure ??= new Error(code);
    rejectReady(failure);
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(failure);
    }
    pending.clear();
  };
  child.on("error", (error) => {
    spawnFailed = true;
    projected.emit("error", error);
    fail("fixture_child_error");
  });
  child.once("close", (code, signal) => {
    projected.emit("close", code, signal);
    if (!closeReply) fail("fixture_original_closed_without_ack");
  });
  input.on("error", () => fail("fixture_control_write_unknown"));
  requestPipe.on("error", () => fail("fixture_request_pipe_unknown"));
  responsePipe.on("error", () => fail("fixture_response_pipe_unknown"));
  output.on("error", () => fail("fixture_control_read_unknown"));
  diagnostics.on("error", () => fail("fixture_diagnostics_unknown"));
  diagnostics.on("data", (chunk: Buffer) => {
    stderrCapture.push(chunk);
    if (chunk.length > byteBudget - stderrBytes) {
      fail("fixture_diagnostics_budget");
      return;
    }
    stderrBytes += chunk.length;
  });
  const acceptLine = (raw: Buffer): void => {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (text === "PASS") {
      if (!closeReply || runnerPassed || pending.size !== 0)
        throw new Error("runner_line_unexpected");
      runnerPassed = true;
      return;
    }
    if (runnerPassed || closeReply) throw new Error("control_after_close");
    const value = parseJSON(text);
    const hello = readySchema.safeParse(value);
    if (hello.success) {
      if (readySeen || issued !== 0) throw new Error("ready_repeated_or_late");
      readySeen = true;
      acceptReady(hello.data);
      return;
    }
    if (!readySeen) throw new Error("ready_missing");
    const reply = replySchema.parse(value);
    const p = pending.get(reply.id);
    if (!p) throw new Error("control_reply_uncorrelated");
    if (!reply.ok) {
      fail(reply.code);
      return;
    }
    const keys = Object.keys(reply).sort().join(",");
    const expected =
      p.command === "complete"
        ? "id,kind,ok"
        : p.command === "follow"
          ? "handle,id,kind,ok"
          : p.command === "stats"
            ? "id,kind,ok,stats"
            : "id,kind,ok,profileClosed,serverClosed,stats";
    if (keys !== expected) throw new Error("control_reply_shape_crossed");
    if (p.command === "close") closeReply = reply;
    pending.delete(reply.id);
    clearTimeout(p.timer);
    p.resolve(reply);
  };
  output.on("data", (chunk: Buffer) => {
    stdoutCapture.push(chunk);
    if (failure) return; // Keep draining, without retaining unbounded bytes.
    if (chunk.length > byteBudget - stdoutBytes) {
      fail("fixture_control_output_budget");
      return;
    }
    stdoutBytes += chunk.length;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        if (end - offset > lineBudget - carry.length)
          throw new Error("line_budget");
        carry = Buffer.concat([carry, chunk.subarray(offset, end)]);
        offset = newline === -1 ? chunk.length : end + 1;
        if (newline !== -1) {
          const line = carry;
          carry = Buffer.alloc(0);
          acceptLine(line);
        }
      }
    } catch (error) {
      parserCause ??= parserFailureCode(error);
      fail("fixture_control_protocol_unknown");
    }
  });
  output.on("end", () => {
    if (carry.length !== 0 || !runnerPassed || !closeReply)
      fail("fixture_control_eof_unknown");
  });
  const control = (value: Control): Promise<Reply> => {
    if (failure) return Promise.reject(failure);
    if (
      !readySeen ||
      closeReply ||
      (closing !== undefined && value.command !== "close") ||
      issued >= 32 ||
      pending.size >= 32
    )
      return Promise.reject(new Error("fixture_control_refused"));
    const id = randomUUID();
    const bytes = Buffer.from(JSON.stringify({ id, ...value }) + "\n");
    if (bytes.length > lineBudget)
      return Promise.reject(new Error("fixture_control_input_budget"));
    issued++;
    if (value.command === "close") closeControlIssued = true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => fail("fixture_control_reply_unknown"),
        5000,
      );
      pending.set(id, { command: value.command, resolve, reject, timer });
      try {
        input.write(bytes, (error) => {
          if (error) fail("fixture_control_write_unknown");
        });
      } catch {
        fail("fixture_control_write_unknown");
      }
    });
  };
  const close = (): Promise<TaskSurfaceCloseProof> =>
    (closing ??= (async () => {
      let ack: Reply | undefined;
      let cleanupFailureCode: string | undefined;
      const unknownClose = (): TaskSurfaceCloseError =>
        new TaskSurfaceCloseError({
          classification: "controlled-go-task-surface-cpu-close-failure",
          scenario,
          originalPid: child.pid ?? null,
          originalClose: originalClose ?? null,
          closeControlIssued,
          requestEOFIssued,
          closeAckReceived: closeReply !== undefined,
          serverClosed: closeReply?.serverClosed === true,
          profileClosed: closeReply?.profileClosed === true,
          runnerPassed,
          firstFailureCode: failure?.message ?? null,
          parserCause: parserCause ?? null,
          cleanupFailureCode: cleanupFailureCode ?? null,
          stdout: stdoutCapture.snapshot(),
          stderr: stderrCapture.snapshot(),
        });
      // Go emits its ACK only after Server exits. An inherited blocking fd3
      // read needs the original writer's EOF; waiting for ACK before EOF creates
      // a cycle. Send ONE control, detach the unowned Client, then end fd3 BEFORE
      // awaiting ACK. Keep the independent JSONL control input open until ACK.
      const ackPromise = control({ command: "close" });
      void ackPromise.catch(() => undefined);
      try {
        await client.close();
      } catch {
        cleanupFailureCode ??= "fixture_client_close_failed";
      }
      try {
        requestPipe.end();
        requestEOFIssued = true;
      } catch {
        cleanupFailureCode ??= "fixture_request_eof_failed";
      }
      responsePipe.resume();
      try {
        ack = await ackPromise;
      } catch {
        cleanupFailureCode ??= "fixture_close_ack_unknown";
      }
      // On a lost close ACK this is one graceful EOF on the same child, never
      // another control, kill, replacement process or provider operation.
      try {
        input.end();
      } catch {
        cleanupFailureCode ??= "fixture_control_eof_failed";
      }
      let ended: OriginalClose;
      try {
        ended = await bounded(
          terminal,
          5000,
          "fixture_original_terminal_unknown",
        );
      } catch {
        cleanupFailureCode ??= "fixture_original_terminal_unknown";
        throw unknownClose();
      }
      if (
        cleanupFailureCode ||
        failure ||
        spawnFailed ||
        !ack?.stats ||
        !ack.serverClosed ||
        !ack.profileClosed ||
        !runnerPassed ||
        carry.length !== 0 ||
        ended.code !== 0 ||
        ended.signal !== null ||
        child.pid === undefined
      )
        throw unknownClose();
      await rm(directory, { recursive: true });
      return {
        classification: "controlled-go-task-surface-cpu",
        scenario,
        originalPid: child.pid,
        exitCode: 0,
        signal: null,
        serverClosed: true,
        profileClosed: true,
        runnerPassed: true,
        stats: ack.stats,
      };
    })());
  try {
    const hello = await bounded(ready, 5000, "fixture_ready_unknown").catch(
      (error: unknown) => {
        fail("fixture_ready_unknown");
        throw error;
      },
    );
    await client.handshake(
      {
        protocolMajor: 1,
        protocolMinor: 0,
        buildId: hello.buildId,
        profileId: hello.profileId,
      },
      3000,
    );
    if (client.verifiedContext.backendGeneration !== hello.backendGeneration)
      throw new Error("fixture_context_crossed");
    return {
      client,
      task: new TaskBridge(client, hello.handle),
      handle: hello.handle,
      complete: async (turnId) => {
        await control({ command: "complete", turnId });
      },
      follow: async () => (await control({ command: "follow" })).handle!,
      stats: async () => (await control({ command: "stats" })).stats!,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "fixture_setup_and_original_cleanup_failed",
        { cause: error },
      );
    }
    throw error;
  }
}
