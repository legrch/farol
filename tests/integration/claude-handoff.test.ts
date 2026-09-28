import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrivateExecutionFence } from "../../src/modules/computer/infra/mcp/execution-fence";
import type { HandoffMutationGate } from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { expect, it } from "vitest";
import { PersistentClaudeHandoff } from "../../src/modules/chat/app/service/persistent-claude-handoff";
import type {
  ClaudeIntent,
  ClaudeTerminal,
} from "../../src/modules/chat/app/port/claude-handoff";

const key = "019b0000-0000-4000-8000-000000000020";
const workspace = {
  root: "/fixture/writer",
  device: "1",
  inode: "2",
  gitCommonDirectory: "/fixture/project/.git",
  project: {
    root: "/fixture/project",
    device: "1",
    inode: "3",
    gitCommonDirectory: "/fixture/project/.git",
  },
  execution: {
    sandbox: "read-only" as const,
    approvalPolicy: "on-request" as const,
  },
};
const binding = {
  selection: {
    harness: "claude-code",
    modelAlias: "small",
    model: "fixture-model",
    effort: "medium",
  },
  configSha256: "a".repeat(64),
};
const request = {
  key,
  workspaceId: "selected",
  projectId: "saved",
  message: "Read the fixture",
  modelBinding: binding,
};
function fixture(gate?: HandoffMutationGate) {
  let now = 1;
  let allowed = true;
  let fault = "";
  let calls = 0;
  let resolveCalls = 0;
  let refuseResolveAt = 0;
  let gateReleased = 0;
  let gateQuarantined = 0;
  let gateReturnAction: (() => void) | null = null;
  let effectStage = "before-intent";
  let expireAtStage = "";
  const intents = new Map<string, ClaudeIntent>();
  const terminal = new Map<string, ClaudeTerminal>();
  let snapshot = {
    state: "running" as "running" | "exited",
    stdout: "",
    exitCode: null as number | null,
    exitSignal: null as string | null,
    groupCleanup: "pending" as "pending" | "confirmed" | "unverified",
    truncated: false,
    interrupted: false,
  };
  const journal = {
    async read(id: string) {
      if (fault === "read") throw Error("read");
      return intents.get(id) ?? null;
    },
    async claim(id: string, record: ClaudeIntent) {
      if (fault === "claim") {
        intents.set(id, record);
        throw Error("lost publication");
      }
      if (intents.has(id)) return false;
      intents.set(id, record);
      effectStage = "intent";
      return true;
    },
    async terminal(id: string) {
      if (fault === "terminal") throw Error("read terminal");
      return terminal.get(id) ?? null;
    },
    async finish(id: string, value: ClaudeTerminal) {
      if (fault === "finish") throw Error("lost terminal");
      if (!terminal.has(id)) terminal.set(id, value);
      return terminal.get(id)!;
    },
  };
  const service = new PersistentClaudeHandoff(
    {
      async resolve() {
        resolveCalls++;
        const result =
          allowed && resolveCalls !== refuseResolveAt ? workspace : null;
        if (expireAtStage === effectStage) {
          expireAtStage = "";
          // Expire after authorized() has produced its snapshot, but before
          // its caller resumes. Stage arming avoids numeric call-count coupling.
          queueMicrotask(() =>
            queueMicrotask(() => {
              now = 100;
            }),
          );
        }
        return result;
      },
    },
    {
      async supports() {
        if (fault === "capability") now = 100;
        return fault !== "unsupported";
      },
      async start() {
        calls++;
        effectStage = "started";
        if (fault === "expire-start") now = 100;
        if (fault === "spawn") throw Error("lost start");
        return "owned-handle";
      },
      async read() {
        if (fault === "snapshot") throw Error("lost read");
        effectStage = "read";
        return snapshot;
      },
    },
    journal,
    {
      digest(value: unknown) {
        return JSON.stringify(value);
      },
    },
    { workspaceId: "selected", projectId: "saved", expiresAt: 100 },
    gate ??
      ({
        async run(
          preflight: () => Promise<void>,
          effect: () => Promise<unknown>,
          safe: (error: unknown) => boolean,
        ) {
          try {
            await preflight();
            const result = await effect();
            gateReleased++;
            gateReturnAction?.();
            return result;
          } catch (error) {
            if (safe(error)) gateReleased++;
            else gateQuarantined++;
            throw error;
          }
        },
      } as never),
    () => now,
  );
  const init = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: key,
    cwd: workspace.root,
    model: binding.selection.model,
    permissionMode: "default",
  });
  const result = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: key,
    result: "Exact fixture result",
    permission_denials: [],
  });
  return {
    service,
    expireAfterSnapshot(stage: "intent" | "started" | "read") {
      expireAtStage = stage;
    },
    get gateReleased() {
      return gateReleased;
    },
    get gateQuarantined() {
      return gateQuarantined;
    },
    onGateReturn(action: () => void) {
      gateReturnAction = action;
    },
    journal,
    intents,
    terminal,
    init,
    result,
    get calls() {
      return calls;
    },
    setFault(value: string) {
      fault = value;
    },
    refuseAt(value: number) {
      refuseResolveAt = value;
    },
    get resolveCalls() {
      return resolveCalls;
    },
    revoke() {
      allowed = false;
    },
    expire() {
      now = 100;
    },
    setSnapshot(value: Partial<typeof snapshot>) {
      snapshot = { ...snapshot, ...value };
    },
    request,
  };
}
it("claims one durable intent before one process dispatch; concurrent repeat cannot spawn", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.service.create(request),
    f.service.create(request),
  ]);
  expect(f.calls).toBe(1);
  expect(results.some((r) => r.status === "dispatched")).toBe(true);
  expect(f.intents.get(key)?.modelBinding).toEqual(binding);
});
it.each(["unsupported", "capability"])(
  "%s refuses before durable claim or process",
  async (fault) => {
    const f = fixture();
    f.setFault(fault);
    expect((await f.service.create(request)).status).toBe("refused");
    expect(f.calls).toBe(0);
    expect(f.intents.size).toBe(0);
  },
);
it.each(["claim", "spawn"])(
  "%s lost acknowledgement is unknown and never retried",
  async (fault) => {
    const f = fixture();
    f.setFault(fault);
    expect((await f.service.create(request)).status).toBe("outcome_unknown");
    f.setFault("");
    expect((await f.service.create(request)).status).toBe("outcome_unknown");
    expect(f.calls).toBe(fault === "spawn" ? 1 : 0);
  },
);
it("startup is not terminal; exact init then final event AND exit are required", async () => {
  const f = fixture();
  await f.service.create(request);
  expect((await f.service.status(key)).status).toBe("outcome_unknown");
  f.setSnapshot({ stdout: f.init + "\n" });
  expect(await f.service.status(key)).toMatchObject({
    status: "known",
    lifecycle: "running",
  });
  f.setSnapshot({ stdout: f.init + "\n" + f.result + "\n" });
  expect(await f.service.status(key)).toMatchObject({ lifecycle: "running" });
  f.setSnapshot({ state: "exited", exitCode: 0, groupCleanup: "confirmed" });
  expect(await f.service.status(key)).toMatchObject({
    status: "known",
    lifecycle: "completed",
    text: "Exact fixture result",
    proof: "recorded-terminal",
  });
});
it.each([false, true])(
  "startup preludes preserve terminal semantics and replay (denied=%s)",
  async (denied) => {
    const f = fixture();
    await f.service.create(request);
    const startup =
      ["plugin_install", "hook_started", "hook_progress", "hook_response"]
        .map((subtype) =>
          JSON.stringify({
            type: "system",
            subtype,
            session_id: key,
            stdout: "Startup payload is not the task result",
          }),
        )
        .join("\n") + "\n";
    f.setSnapshot({ stdout: startup });
    expect((await f.service.status(key)).status).toBe("outcome_unknown");
    expect(f.terminal.size).toBe(0);
    const final = {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: key,
      result: "Exact fixture result",
      permission_denials: denied ? [{ tool_name: "Bash" }] : [],
    };
    f.setSnapshot({
      stdout: startup + f.init + "\n" + JSON.stringify(final) + "\n",
    });
    expect(await f.service.status(key)).toMatchObject({ lifecycle: "running" });
    expect(f.terminal.size).toBe(0);
    f.setSnapshot({ state: "exited", exitCode: 0, groupCleanup: "confirmed" });
    const terminal = await f.service.status(key);
    expect(terminal).toMatchObject({
      status: "known",
      lifecycle: denied ? "needs_input" : "completed",
      text: "Exact fixture result",
      proof: "recorded-terminal",
    });
    expect(await f.service.status(key)).toEqual(terminal);
    await f.service.create(request);
    expect(f.calls).toBe(1);
  },
);
it.each([
  "session",
  "cwd",
  "model",
  "permission",
  "missing",
  "duplicate",
  "trailing",
  "malformed",
  "exit",
  "cleanup",
  "truncated",
])("%s cannot produce terminal success", async (fault) => {
  const f = fixture();
  await f.service.create(request);
  let stdout = f.init + "\n" + f.result + "\n";
  if (fault === "session")
    stdout = stdout.replaceAll(key, "019b0000-0000-4000-8000-000000000021");
  if (fault === "cwd") stdout = stdout.replace(workspace.root, "/foreign");
  if (fault === "model")
    stdout = stdout.replace(binding.selection.model, "foreign");
  if (fault === "permission")
    stdout = stdout.replace("default", "bypassPermissions");
  if (fault === "missing") stdout = f.init + "\n";
  if (fault === "duplicate") stdout += f.result + "\n";
  if (fault === "trailing") stdout += '{"type":"assistant"}\n';
  if (fault === "malformed") stdout += "bad\n";
  f.setSnapshot({
    stdout,
    state: "exited",
    exitCode: fault === "exit" ? 1 : 0,
    groupCleanup: fault === "cleanup" ? "unverified" : "confirmed",
    truncated: fault === "truncated",
  });
  expect((await f.service.status(key)).status).toBe("outcome_unknown");
  expect(f.terminal.size).toBe(0);
});
it("permission denial is terminal needs-input, never automatic approval/resume", async () => {
  const f = fixture();
  await f.service.create(request);
  f.setSnapshot({
    stdout:
      f.init +
      "\n" +
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: key,
        result: "Blocked",
        permission_denials: [{ tool_name: "Bash" }],
      }) +
      "\n",
    state: "exited",
    exitCode: 0,
    groupCleanup: "confirmed",
  });
  expect(await f.service.status(key)).toMatchObject({
    status: "known",
    lifecycle: "needs_input",
  });
  expect(f.calls).toBe(1);
});
it("revocation/expiry blocks status and replay without spawn or receipt disclosure", async () => {
  const f = fixture();
  await f.service.create(request);
  f.revoke();
  expect((await f.service.status(key)).status).toBe("refused");
  expect((await f.service.create(request)).status).toBe("refused");
  expect(f.calls).toBe(1);
  const expired = fixture();
  expired.expire();
  expect((await expired.service.create(request)).status).toBe("refused");
  expect((await expired.service.status(key)).status).toBe("refused");
});
it("terminal publication failure stays unknown; known receipt replays without restart", async () => {
  const f = fixture();
  await f.service.create(request);
  f.setSnapshot({
    stdout: f.init + "\n" + f.result + "\n",
    state: "exited",
    exitCode: 0,
    groupCleanup: "confirmed",
  });
  f.setFault("finish");
  expect((await f.service.status(key)).status).toBe("outcome_unknown");
  f.setFault("");
  await f.service.status(key);
  const restarted = new PersistentClaudeHandoff(
    {
      async resolve() {
        return workspace;
      },
    },
    {
      async supports() {
        throw Error("not needed");
      },
      async start() {
        throw Error("no restart");
      },
      async read() {
        throw Error("not needed");
      },
    },
    f.journal,
    {
      digest(value: unknown) {
        return JSON.stringify(value);
      },
    },
    { workspaceId: "selected", projectId: "saved", expiresAt: 100 },
    {
      async run(
        preflight: () => Promise<void>,
        effect: () => Promise<unknown>,
      ) {
        await preflight();
        return effect();
      },
    } as never,
    () => 1,
  );
  expect(await restarted.status(key)).toMatchObject({ lifecycle: "completed" });
  expect((await restarted.create(request)).status).toBe("outcome_unknown");
  expect(f.calls).toBe(1);
});

it.each([
  { key: "bad" },
  { workspaceId: "foreign" },
  { projectId: "foreign" },
  { message: " " },
  { message: "\0" },
  { message: "🧭".repeat(2049) },
  {
    modelBinding: {
      ...binding,
      selection: { ...binding.selection, harness: "codex" },
    },
  },
])("closed admission refuses %j before effects", async (change) => {
  const f = fixture();
  expect((await f.service.create({ ...request, ...change })).status).toBe(
    "refused",
  );
  expect(f.calls).toBe(0);
});
it("conflicting key, invalid status and absent dispatch are honest", async () => {
  const f = fixture();
  await f.service.create(request);
  expect(
    await f.service.create({ ...request, message: "Different" }),
  ).toMatchObject({ status: "refused", code: "CLAUDE_DISPATCH_CONFLICT" });
  expect((await f.service.status("bad")).status).toBe("refused");
  expect(
    (await f.service.status("019b0000-0000-4000-8000-000000000021")).status,
  ).toBe("unknown");
});
it.each(["read", "terminal", "snapshot", "expire-start"])(
  "%s fault does not invent no-effects success",
  async (fault) => {
    const f = fixture();
    if (fault === "read" || fault === "expire-start") f.setFault(fault);
    const result = await f.service.create(request);
    if (fault === "read") expect(result.status).toBe("outcome_unknown");
    else {
      if (fault === "expire-start")
        expect(result.status).toBe("outcome_unknown");
      f.setFault(fault);
      expect(["outcome_unknown", "refused"]).toContain(
        (await f.service.status(key)).status,
      );
    }
  },
);
it.each([3, 4, 5])(
  "late create physical refusal at check %i cannot submit again",
  async (check) => {
    const f = fixture();
    f.refuseAt(check);
    const result = await f.service.create(request);
    expect(result.status).toBe(check === 3 ? "refused" : "outcome_unknown");
    expect(f.calls).toBe(check === 5 ? 1 : 0);
  },
);
it.each([2, 3, 4, 5, 6])(
  "status physical refusal at relative check %i cannot disclose terminal/running proof",
  async (check) => {
    const f = fixture();
    await f.service.create(request);
    f.setSnapshot({
      stdout: f.init + "\n" + f.result + "\n",
      state: "exited",
      exitCode: 0,
      groupCleanup: "confirmed",
    });
    f.refuseAt(f.resolveCalls + check);
    expect(["refused", "outcome_unknown"]).toContain(
      (await f.service.status(key)).status,
    );
  },
);
it("running late physical refusal and corrupt terminal stay fail closed", async () => {
  const f = fixture();
  await f.service.create(request);
  f.setSnapshot({ stdout: f.init + "\n" });
  f.refuseAt(f.resolveCalls + 3);
  expect((await f.service.status(key)).status).toBe("refused");
  f.refuseAt(0);
  f.terminal.set(key, {
    lifecycle: "completed",
    sessionId: key,
    actualModel: "foreign",
    exitCode: 0,
    text: "Private",
  });
  expect((await f.service.status(key)).status).toBe("outcome_unknown");
});
it("explicit final failure is recorded only after the failed process exit", async () => {
  const f = fixture();
  await f.service.create(request);
  f.setSnapshot({
    stdout:
      f.init +
      "\n" +
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: key,
        permission_denials: [],
      }) +
      "\n",
    state: "exited",
    exitCode: 1,
    groupCleanup: "confirmed",
  });
  expect(await f.service.status(key)).toMatchObject({
    lifecycle: "failed",
    exitCode: 1,
    text: "",
  });
});
it.each([{ interrupted: true }, { exitSignal: "SIGTERM" }])(
  "interruption %j cannot become terminal success",
  async (change) => {
    const f = fixture();
    await f.service.create(request);
    f.setSnapshot({
      stdout: f.init + "\n" + f.result + "\n",
      state: "exited",
      exitCode: 0,
      groupCleanup: "confirmed",
      ...change,
    });
    expect((await f.service.status(key)).status).toBe("outcome_unknown");
  },
);

it("unreadable intent after previous dispatch remains outcome-unknown", async () => {
  const f = fixture();
  await f.service.create(request);
  f.setFault("read");
  expect(await f.service.create(request)).toEqual({
    status: "outcome_unknown",
    dispatchId: key,
  });
  expect(f.calls).toBe(1);
});

it.each(["claim", "expire-start", "after-claim-authority"])(
  "%s unknown publication retains the mutation gate instead of declaring safe completion",
  async (fault) => {
    const f = fixture();
    if (fault === "after-claim-authority") f.refuseAt(4);
    else f.setFault(fault);
    expect(await f.service.create(request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(f.gateReleased).toBe(0);
    expect(f.gateQuarantined).toBe(1);
    expect(f.calls).toBe(fault === "expire-start" ? 1 : 0);
  },
);
it.each(["revoke", "expire"] as const)(
  "%s while the gate returns cannot disclose a successful dispatch",
  async (change) => {
    const f = fixture();
    f.onGateReturn(() => f[change]());
    expect(await f.service.create(request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(f.calls).toBe(1);
    expect((await f.service.status(key)).status).toBe("refused");
  },
);

it.each(["expire-start", "after-claim-authority"])(
  "%s retains the actual filesystem mutation lock",
  async (fault) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-claude-gate-")),
    );
    try {
      const f = fixture(new PrivateExecutionFence({ root }));
      if (fault === "after-claim-authority") f.refuseAt(4);
      else f.setFault(fault);
      expect((await f.service.create(request)).status).toBe("outcome_unknown");
      const lock = await fs.lstat(
        path.join(root, "execution-fence-mutation.lock"),
      );
      expect(lock.isDirectory()).toBe(true);
      expect(lock.mode & 0o077).toBe(0);
      expect(f.calls).toBe(fault === "expire-start" ? 1 : 0);
      // This proves only the gate's own retained lock, not process-tree cleanup.
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
it.each(["intent", "started"] as const)(
  "expiry after the %s authority snapshot cannot escape the gate",
  async (stage) => {
    const f = fixture();
    f.expireAfterSnapshot(stage);
    expect((await f.service.create(request)).status).toBe("outcome_unknown");
    expect(f.gateReleased).toBe(0);
    expect(f.gateQuarantined).toBe(1);
    expect(f.calls).toBe(stage === "started" ? 1 : 0);
  },
);
it("expiry after a running status authority snapshot cannot disclose it", async () => {
  const f = fixture();
  await f.service.create(request);
  f.setSnapshot({ stdout: f.init + "\n" });
  f.expireAfterSnapshot("read");
  expect((await f.service.status(key)).status).toBe("refused");
});
