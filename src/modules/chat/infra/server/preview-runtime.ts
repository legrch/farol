import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import { DeferredGate } from "../../../../pkg/async/deferred-gate";
import type { Clock } from "../../../../pkg/kernel/app/clock";
import { EventStream } from "../../../../pkg/sse/event-stream";
import type { ComputerCapability } from "../../app/port/computer-capability";
import type { ClientEvent } from "../../app/port/event-publisher";
import { RunTurn } from "../../app/service/run-turn";
import {
  ScriptedProvider,
  type FixtureScenario,
} from "../client/scripted-provider";
import { ActivityLog } from "../repo/activity-log";
import { InMemoryTurns } from "../repo/in-memory-turns";

export type PreviewScenario = FixtureScenario | "stream-failure";

export type PreviewTask = Readonly<{
  ownerId: string;
  taskId: string;
  sessionId: string;
  turnId: string;
  generation: number;
  label: string;
  hasComputer: boolean;
  readToken: string;
}>;

export type PreviewRuntime = Readonly<{
  identity: "farol-next-preview-runtime";
  port: number;
  token: string;
  tasks: readonly PreviewTask[];
  close(): Promise<PreviewCloseReceipt>;
}>;

export type PreviewCloseReceipt = Readonly<{
  tasks: readonly Readonly<{
    taskId: string;
    phase: string | null;
    terminal: boolean | null;
  }>[];
  activityKinds: readonly string[];
}>;

export type PreviewRuntimeDependencies = Readonly<{
  createClock(): Clock;
  createComputer(task: PreviewTask, approval: DeferredGate): ComputerCapability;
  renderTaskPage(task: PreviewTask, readToken: string): string;
}>;

const tasks: readonly PreviewTask[] = [
  {
    ownerId: "owner-local-preview",
    taskId: "task-atlantic",
    sessionId: "session-atlantic",
    turnId: "turn-atlantic-1",
    generation: 1,
    label: "Atlantic workspace check",
    hasComputer: true,
    readToken: "",
  },
  {
    ownerId: "owner-local-preview",
    taskId: "task-harbor",
    sessionId: "session-harbor",
    turnId: "turn-harbor-1",
    generation: 1,
    label: "Harbor research stream",
    hasComputer: false,
    readToken: "",
  },
];

const turnIdentitySchema = z.strictObject({
  ownerId: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  turnId: z.string().min(1),
  generation: z.number().int().nonnegative(),
});

const correlationSchema = turnIdentitySchema.extend({
  callId: z.string().min(1).nullable(),
});

type ControlCorrelation = z.infer<typeof correlationSchema>;

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function noContent(response: ServerResponse): void {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

async function requestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length;
    if (length > 4_096) throw new Error("RUNTIME_BODY_TOO_LARGE");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sameCorrelation(
  received: ControlCorrelation,
  expected: ControlCorrelation,
): boolean {
  return (
    received.ownerId === expected.ownerId &&
    received.sessionId === expected.sessionId &&
    received.taskId === expected.taskId &&
    received.turnId === expected.turnId &&
    received.generation === expected.generation &&
    received.callId === expected.callId
  );
}

function sameTurnIdentity(
  received: z.infer<typeof turnIdentitySchema>,
  expected: PreviewTask,
): boolean {
  return (
    received.ownerId === expected.ownerId &&
    received.sessionId === expected.sessionId &&
    received.taskId === expected.taskId &&
    received.turnId === expected.turnId &&
    received.generation === expected.generation
  );
}

export async function startPreviewRuntime(
  scenario: PreviewScenario,
  dependencies: PreviewRuntimeDependencies,
): Promise<PreviewRuntime> {
  const token = randomBytes(32).toString("base64url");
  const runtimeTasks = tasks.map((task) => ({
    ...task,
    readToken: randomBytes(32).toString("base64url"),
  }));
  const events = new EventStream<ClientEvent>(128);
  const activity = new ActivityLog(256);
  const turns = new InMemoryTurns();
  const runtimeClock = dependencies.createClock();
  const controls = new Map<
    string,
    Readonly<{
      computer: Readonly<{
        gate: DeferredGate;
        correlation: ControlCorrelation;
      }>;
      completion: Readonly<{
        gate: DeferredGate;
        correlation: ControlCorrelation;
      }>;
    }>
  >();
  const executions: Promise<unknown>[] = [];
  let closing: Promise<PreviewCloseReceipt> | null = null;

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent)
        json(response, 500, { error: "RUNTIME_REQUEST_FAILED" });
      else response.destroy();
    });
  });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const eventMatch = /^\/events\/([^/]+)$/u.exec(url.pathname);
    const pageMatch = /^\/task\/([^/]+)$/u.exec(url.pathname);
    const acknowledgementMatch = /^\/ack\/([^/]+)\/([1-9]\d*)$/u.exec(
      url.pathname,
    );
    const scopedMatch = eventMatch ?? pageMatch ?? acknowledgementMatch;
    if (scopedMatch?.[1]) {
      const taskId = decodeURIComponent(scopedMatch[1]);
      const task = runtimeTasks.find(
        (candidate) => candidate.taskId === taskId,
      );
      if (!task) {
        json(response, 404, { error: "TASK_NOT_FOUND" });
        return;
      }
      if (!authorized(request, task.readToken)) {
        json(response, 401, { error: "RUNTIME_UNAUTHORIZED" });
        return;
      }
    } else if (!authorized(request, token)) {
      json(response, 401, { error: "RUNTIME_UNAUTHORIZED" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/manifest") {
      json(response, 200, {
        schema: 1,
        identity: "farol-next-preview-runtime",
        scenario,
        tasks: runtimeTasks.map(({ readToken: _readToken, ...task }) => task),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/snapshot") {
      const taskStates = await Promise.all(
        runtimeTasks.map(async (task) => {
          const turn = await turns.get(task.taskId);
          return {
            taskId: task.taskId,
            turn: turn
              ? {
                  phase: turn.phase,
                  terminal: turn.terminal,
                  deltaCount: turn.deltaCount,
                  lastSequence: turn.lastSequence,
                  outstandingCallId: turn.outstandingCallId,
                }
              : null,
          };
        }),
      );
      json(response, 200, {
        schema: 1,
        identity: "farol-next-preview-runtime",
        scenario,
        tasks: taskStates,
        activity: activity.snapshot(),
      });
      return;
    }
    if (request.method === "GET" && eventMatch?.[1]) {
      const taskId = decodeURIComponent(eventMatch[1]);
      events.subscribe(taskId, response);
      return;
    }
    if (request.method === "GET" && pageMatch?.[1]) {
      const taskId = decodeURIComponent(pageMatch[1]);
      const task = runtimeTasks.find(
        (candidate) => candidate.taskId === taskId,
      );
      if (!task) {
        json(response, 404, { error: "TASK_NOT_FOUND" });
        return;
      }
      const body = dependencies.renderTaskPage(task, task.readToken);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src http://127.0.0.1:*",
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
      return;
    }
    if (
      request.method === "POST" &&
      acknowledgementMatch?.[1] &&
      acknowledgementMatch[2]
    ) {
      const taskId = decodeURIComponent(acknowledgementMatch[1]);
      const task = runtimeTasks.find(
        (candidate) => candidate.taskId === taskId,
      );
      const eventId = Number(acknowledgementMatch[2]);
      const parsed = turnIdentitySchema.safeParse(await requestJson(request));
      if (
        !task ||
        !Number.isSafeInteger(eventId) ||
        !parsed.success ||
        !sameTurnIdentity(parsed.data, task)
      ) {
        json(response, 409, { error: "DELIVERY_CORRELATION_MISMATCH" });
        return;
      }
      const acknowledgement = events.acknowledge(taskId, eventId);
      if (acknowledgement.status === "missing") {
        json(response, 409, { error: "DELIVERY_EVENT_MISSING" });
        return;
      }
      if (acknowledgement.status === "acknowledged") {
        const turn = await turns.get(taskId);
        if (turn) {
          const acknowledgedAt = runtimeClock.now();
          const sequence =
            acknowledgement.event.kind === "text.delta"
              ? acknowledgement.event.sequence
              : null;
          try {
            await activity.record({
              taskId: turn.identity.taskId,
              turnId: turn.identity.turnId,
              generation: turn.identity.generation,
              at: acknowledgedAt,
              kind: "client_delivery_acknowledged",
              phase: turn.phase,
              sequence,
              capability: null,
            });
          } catch {
            // The ACK is already known; evidence failure must not invite replay.
          }
          if (acknowledgement.event.kind !== "client.delivery_acknowledged") {
            await events.publish({
              ...turn.identity,
              at: acknowledgedAt,
              kind: "client.delivery_acknowledged",
              deliveryId: eventId,
              deliveredKind: acknowledgement.event.kind,
              phase: turn.phase,
              sequence,
            });
          }
        }
      }
      noContent(response);
      return;
    }
    const controlMatch =
      /^\/control\/([^/]+)\/(release-tool|release-completion)$/u.exec(
        url.pathname,
      );
    if (request.method === "POST" && controlMatch?.[1] && controlMatch[2]) {
      const taskId = decodeURIComponent(controlMatch[1]);
      const taskControls = controls.get(taskId);
      if (!taskControls) {
        json(response, 404, { error: "TASK_NOT_FOUND" });
        return;
      }
      const selected =
        controlMatch[2] === "release-tool"
          ? taskControls.computer
          : taskControls.completion;
      const parsed = correlationSchema.safeParse(await requestJson(request));
      if (
        !parsed.success ||
        !sameCorrelation(parsed.data, selected.correlation)
      ) {
        json(response, 409, { error: "CONTROL_CORRELATION_MISMATCH" });
        return;
      }
      if (!selected.gate.release()) {
        json(response, 409, { error: "CONTROL_ALREADY_RELEASED" });
        return;
      }
      noContent(response);
      return;
    }
    json(response, 404, { error: "RUNTIME_ROUTE_NOT_FOUND" });
  }

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("RUNTIME_ADDRESS_UNAVAILABLE");
  }

  for (const task of runtimeTasks) {
    const computerGate = new DeferredGate(`${task.taskId}:computer`);
    const completionGate = new DeferredGate(`${task.taskId}:completion`);
    controls.set(task.taskId, {
      computer: {
        gate: computerGate,
        correlation: {
          ownerId: task.ownerId,
          sessionId: task.sessionId,
          taskId: task.taskId,
          turnId: task.turnId,
          generation: task.generation,
          callId: `${task.turnId}-computer-1`,
        },
      },
      completion: {
        gate: completionGate,
        correlation: {
          ownerId: task.ownerId,
          sessionId: task.sessionId,
          taskId: task.taskId,
          turnId: task.turnId,
          generation: task.generation,
          callId: null,
        },
      },
    });
    if (!task.hasComputer) computerGate.release();
    const chatClock = dependencies.createClock();
    const computer = dependencies.createComputer(task, computerGate);
    let streamFaultInjected = false;
    const runner = new RunTurn(
      new ScriptedProvider(
        scenario === "stream-failure" ? "normal" : scenario,
        { completion: completionGate },
        task.hasComputer,
      ),
      computer,
      turns,
      {
        async publish(event) {
          await events.publish(event);
          if (
            scenario === "stream-failure" &&
            task.taskId === "task-atlantic" &&
            event.kind === "computer.requested" &&
            !streamFaultInjected
          ) {
            streamFaultInjected = true;
            events.fail(task.taskId, "PREVIEW_STREAM_FAULT");
          }
        },
      },
      activity,
      chatClock,
    );
    executions.push(
      runner.execute({
        ownerId: task.ownerId,
        sessionId: task.sessionId,
        taskId: task.taskId,
        turnId: task.turnId,
        generation: task.generation,
        prompt: "Synthetic local preview fixture",
      }),
    );
  }

  async function closeRuntime(): Promise<PreviewCloseReceipt> {
    for (const taskControls of controls.values()) {
      taskControls.computer.gate.cancel();
      taskControls.completion.gate.cancel();
    }
    events.close();
    await Promise.allSettled(executions);
    const closedTasks = await Promise.all(
      runtimeTasks.map(async (task) => {
        const turn = await turns.get(task.taskId);
        return {
          taskId: task.taskId,
          phase: turn?.phase ?? null,
          terminal: turn?.terminal ?? null,
        };
      }),
    );
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    return {
      tasks: closedTasks,
      activityKinds: activity.snapshot().map((record) => record.kind),
    };
  }

  return {
    identity: "farol-next-preview-runtime",
    port: address.port,
    token,
    tasks: runtimeTasks,
    close() {
      closing ??= closeRuntime();
      return closing;
    },
  };
}
