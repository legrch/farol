import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { DeferredGate } from "../pkg/async/deferred-gate";
import { EventStream } from "../pkg/sse/event-stream";
import { SystemClock } from "../pkg/kernel/infra/system-clock";
import { ComputerService } from "../modules/computer/app/service/computer-service";
import { ComputerContractHandler } from "../modules/computer/infra/contract-handler";
import { FixtureComputer } from "../modules/computer/infra/repo/fixture-computer";
import type { ClientEvent } from "../modules/chat/app/port/event-publisher";
import { RunTurn } from "../modules/chat/app/service/run-turn";
import {
  ScriptedProvider,
  type FixtureScenario,
} from "../modules/chat/infra/client/scripted-provider";
import { ActivityLog } from "../modules/chat/infra/repo/activity-log";
import { ComputerPeer } from "../modules/chat/infra/peer/computer-peer";
import { InMemoryTurns } from "../modules/chat/infra/repo/in-memory-turns";
import { taskPage } from "../ui/task-page";

export type PreviewScenario = FixtureScenario;

export type PreviewTask = Readonly<{
  taskId: string;
  sessionId: string;
  turnId: string;
  label: string;
  hasComputer: boolean;
}>;

export type PreviewRuntime = Readonly<{
  identity: "farol-next-preview-runtime";
  port: number;
  token: string;
  tasks: readonly PreviewTask[];
  close(): Promise<void>;
}>;

const tasks: readonly PreviewTask[] = [
  {
    taskId: "task-atlantic",
    sessionId: "session-atlantic",
    turnId: "turn-atlantic-1",
    label: "Atlantic workspace check",
    hasComputer: true,
  },
  {
    taskId: "task-harbor",
    sessionId: "session-harbor",
    turnId: "turn-harbor-1",
    label: "Harbor research stream",
    hasComputer: false,
  },
];

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

export async function startPreviewRuntime(
  scenario: PreviewScenario = "normal",
): Promise<PreviewRuntime> {
  const token = randomBytes(32).toString("base64url");
  const ownerId = "owner-local-preview";
  const generation = 1;
  const events = new EventStream<ClientEvent>(128);
  const activity = new ActivityLog(256);
  const turns = new InMemoryTurns();
  const controls = new Map<
    string,
    Readonly<{ computer: DeferredGate; completion: DeferredGate }>
  >();
  const executions: Promise<unknown>[] = [];

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
    if (!authorized(request, token)) {
      json(response, 401, { error: "RUNTIME_UNAUTHORIZED" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/manifest") {
      json(response, 200, {
        schema: 1,
        identity: "farol-next-preview-runtime",
        scenario,
        tasks,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/snapshot") {
      const taskStates = await Promise.all(
        tasks.map(async (task) => {
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
    const eventMatch = /^\/events\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && eventMatch?.[1]) {
      const taskId = decodeURIComponent(eventMatch[1]);
      if (!tasks.some((task) => task.taskId === taskId)) {
        json(response, 404, { error: "TASK_NOT_FOUND" });
        return;
      }
      events.subscribe(taskId, response);
      return;
    }
    const pageMatch = /^\/task\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && pageMatch?.[1]) {
      const taskId = decodeURIComponent(pageMatch[1]);
      const task = tasks.find((candidate) => candidate.taskId === taskId);
      if (!task) {
        json(response, 404, { error: "TASK_NOT_FOUND" });
        return;
      }
      const body = taskPage(task.taskId, task.label, token);
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
      const gate =
        controlMatch[2] === "release-tool"
          ? taskControls.computer
          : taskControls.completion;
      if (!gate.release()) {
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

  for (const task of tasks) {
    const computerGate = new DeferredGate(`${task.taskId}:computer`);
    const completionGate = new DeferredGate(`${task.taskId}:completion`);
    controls.set(task.taskId, {
      computer: computerGate,
      completion: completionGate,
    });
    if (!task.hasComputer) computerGate.release();
    const computerClock = new SystemClock();
    const chatClock = new SystemClock();
    const computer = new ComputerService(
      {
        ownerId,
        sessionId: task.sessionId,
        taskId: task.taskId,
        generation,
        capability: "fixture.inspect",
        expiresAt: computerClock.now() + 3_600_000,
      },
      new FixtureComputer(computerGate),
      computerClock,
    );
    const runner = new RunTurn(
      new ScriptedProvider(
        scenario,
        { completion: completionGate },
        task.hasComputer,
      ),
      new ComputerPeer(new ComputerContractHandler(computer)),
      turns,
      { publish: (event) => events.publish(event) },
      activity,
      chatClock,
    );
    executions.push(
      runner.execute({
        ownerId,
        sessionId: task.sessionId,
        taskId: task.taskId,
        turnId: task.turnId,
        generation,
        prompt: "Synthetic local preview fixture",
      }),
    );
  }

  return {
    identity: "farol-next-preview-runtime",
    port: address.port,
    token,
    tasks,
    async close() {
      for (const taskControls of controls.values()) {
        taskControls.computer.release();
        taskControls.completion.release();
      }
      events.close();
      await Promise.allSettled(executions);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
