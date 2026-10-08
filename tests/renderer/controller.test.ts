import { describe, it, expect, vi } from "vitest";
import { WindowController } from "../../src/ui/renderer/controller";
import { bootstrap, deferred, fixture, settings, task } from "./fixture";
import type { ConnectorSetupReceipt } from "../../src/pkg/product-settings/connector-setup-receipt";
function sectionIntent(section = "settings", sequence = 1, taskId = "") {
  return {
    action: "navigate-section",
    eventId: `11111111-1111-4111-8111-${sequence.toString(16).padStart(12, "0")}`,
    source: "section-shortcut-command",
    authWindowGeneration: null,
    section,
    taskId,
    sequence,
  };
}
// Transport fixtures only: no native credential save or provider connection.
describe("Save & connect original Intent", () => {
  const operationId = "66666666-6666-4666-8666-666666666666";
  const buildId = bootstrap().build.buildId;
  const intention = "settings:connector.save-and-connect";
  const command = {
    kind: "connector.save-and-connect" as const,
    operationId,
    buildId,
    tunnelId: "fixture-tunnel",
    runtimeKey: "fixture-secret-runtime-key-000000000",
  };
  const completed: ConnectorSetupReceipt = {
    kind: command.kind,
    operationId,
    buildId,
    state: "completed",
    stoppedAt: "complete",
    credentials: "saved",
    connection: "connected",
    code: null,
    externalVerification: "not-proven",
  };
  const unknown: ConnectorSetupReceipt = {
    ...completed,
    state: "unknown",
    stoppedAt: "connection",
    connection: "unknown",
    code: "SETTINGS_INPUT_INVALID",
    connectorAttempt: {
      method: "computer.connector.open",
      requestId: "77777777-7777-4777-8777-777777777777",
      operationId: "88888888-8888-4888-8888-888888888888",
      outcome: "unknown",
    },
  };
  const response = (
    connectorSetup: ConnectorSetupReceipt = completed,
    revision = 2,
  ) => ({
    ...(connectorSetup.state === "completed"
      ? { ok: true }
      : { ok: false, error: connectorSetup.code }),
    snapshot: { status: "ready", settings: settings(revision) },
    connectorSetup,
  });

  it("keeps a lost reply unknown across refresh/remount and never resubmits the key", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    vi.mocked(f.api.configure).mockRejectedValue(new Error(command.runtimeKey));
    const first = c.configure(command, intention);
    const duplicate = c.configure(command, intention);
    const result = await first;
    expect(await duplicate).toBe(result);
    expect(result).toEqual({
      id: intention,
      state: "unknown",
      code: "CONFIGURATION_OUTCOME_UNKNOWN",
    });
    const newer = bootstrap();
    newer.configuration.settings = settings(10);
    vi.mocked(f.api.bootstrap).mockResolvedValue(newer);
    await c.refresh();
    const unmount = c.subscribe(() => {});
    unmount();
    const remount = c.subscribe(() => {});
    expect(c.getSnapshot().intents[intention]).toBe(result);
    expect(await c.configure(command, intention)).toBe(result);
    expect(await c.configure(command, "remounted-label")).toBe(result);
    expect(
      (
        await c.configure(
          { ...command, operationId: "99999999-9999-4999-8999-999999999999" },
          intention,
        )
      ).code,
    ).toBe("INTENTION_PAYLOAD_CONFLICT");
    expect(f.api.configure).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(c.getSnapshot())).not.toContain(command.runtimeKey);
    const maps = c as unknown as {
      commands: Map<
        string,
        { fingerprint: Promise<string>; promise: Promise<unknown> }
      >;
      connectorSetupCommands: Map<
        string,
        { fingerprint: Promise<string>; promise: Promise<unknown> }
      >;
    };
    for (const retained of [
      maps.commands.get(intention)!,
      maps.connectorSetupCommands.get(operationId)!,
    ]) {
      expect(Object.keys(retained).sort()).toEqual(["fingerprint", "promise"]);
      expect(await retained.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(await retained.promise)).not.toContain(
        command.runtimeKey,
      );
    }
    remount();
    c.dispose();
  });

  it("retains pending admission after an undelivered reply without inventing a timeout or retry", async () => {
    const f = fixture();
    const reply = deferred<unknown>();
    vi.mocked(f.api.configure).mockReturnValue(reply.promise);
    const c = new WindowController(f.api);
    await c.start();
    const pending = c.configure(command, intention);
    await vi.waitFor(() => expect(f.api.configure).toHaveBeenCalledTimes(1));
    const duplicate = c.configure(command, intention);
    await c.refresh();
    expect(c.getSnapshot().intents[intention]?.state).toBe("pending");
    expect(c.getSnapshot().intents[intention]?.connectorSetup).toBeUndefined();
    expect(f.api.configure).toHaveBeenCalledTimes(1);
    reply.reject();
    expect((await pending).state).toBe("unknown");
    expect((await duplicate).state).toBe("unknown");
    c.dispose();
  });

  it.each([completed, unknown])(
    "preserves the original $state receipt after a newer refresh and component remount",
    async (receipt) => {
      const f = fixture();
      const reply = deferred<unknown>();
      vi.mocked(f.api.configure).mockReturnValue(reply.promise);
      const c = new WindowController(f.api);
      await c.start();
      const unmount = c.subscribe(() => {});
      const pending = c.configure(command, intention);
      await vi.waitFor(() => expect(f.api.configure).toHaveBeenCalledTimes(1));
      unmount();
      const newer = bootstrap();
      newer.configuration.settings = settings(10);
      vi.mocked(f.api.bootstrap).mockResolvedValue(newer);
      await c.refresh();
      const refreshConfiguration = c.getSnapshot().configuration;
      c.navigate({ area: "settings", page: "general" });
      reply.resolve(response(receipt, 2));
      const result = await pending;
      const remount = c.subscribe(() => {});
      expect(result.state).toBe(
        receipt.state === "completed" ? "applied" : "unknown",
      );
      expect(result.connectorSetup).toEqual(receipt);
      expect(Object.isFrozen(result.connectorSetup)).toBe(true);
      expect(c.getSnapshot().intents[intention]).toBe(result);
      expect(c.getSnapshot().configuration).toBe(refreshConfiguration);
      expect(c.getSnapshot().destination.page).toBe("general");
      await c.refresh();
      expect(c.getSnapshot().intents[intention]).toBe(result);
      expect(await c.configure(command, intention)).toBe(result);
      expect(await c.configure(command, "remounted-label")).toBe(result);
      expect(f.api.configure).toHaveBeenCalledTimes(1);
      remount();
      c.dispose();
    },
  );

  it.each([
    {
      label: "missing receipt",
      reply: { ok: true, snapshot: bootstrap().configuration },
    },
    {
      label: "failure missing receipt",
      reply: {
        ok: false,
        error: "CONNECTOR_START_FAILED",
        snapshot: bootstrap().configuration,
      },
    },
    {
      label: "malformed receipt",
      reply: response({ ...completed, stoppedAt: "credentials" }),
    },
    {
      label: "wrong operation",
      reply: response({
        ...completed,
        operationId: "99999999-9999-4999-8999-999999999999",
      }),
    },
    {
      label: "wrong build",
      reply: response({ ...completed, buildId: "b".repeat(64) }),
    },
    {
      label: "secret in receipt",
      reply: {
        ...response(),
        connectorSetup: { ...completed, runtimeKey: command.runtimeKey },
      },
    },
    {
      label: "nested unknown in success",
      reply: { ...response(unknown), ok: true, error: undefined },
    },
  ])(
    "keeps $label unknown, withholding both the receipt and global snapshot",
    async ({ reply }) => {
      const f = fixture();
      const c = new WindowController(f.api);
      await c.start();
      const originalConfiguration = c.getSnapshot().configuration;
      vi.mocked(f.api.configure).mockResolvedValue(reply);
      const result = await c.configure(command, intention);
      expect(result).toEqual({
        id: intention,
        state: "unknown",
        code: "CONFIGURATION_OUTCOME_UNKNOWN",
      });
      expect(c.getSnapshot().configuration).toBe(originalConfiguration);
      expect(await c.configure(command, intention)).toBe(result);
      expect(f.api.configure).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain(command.runtimeKey);
      c.dispose();
    },
  );

  it("refuses a command for another build before dispatch", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    expect(
      await c.configure({ ...command, buildId: "b".repeat(64) }, intention),
    ).toEqual({
      id: intention,
      state: "refused",
      code: "CONNECTOR_SETUP_BINDING_CHANGED",
    });
    expect(f.api.configure).not.toHaveBeenCalled();
    c.dispose();
  });

  it("does not accept a late receipt after refresh exposes another build", async () => {
    const f = fixture();
    const reply = deferred<unknown>();
    vi.mocked(f.api.configure).mockReturnValue(reply.promise);
    const c = new WindowController(f.api);
    await c.start();
    const pending = c.configure(command, intention);
    await vi.waitFor(() => expect(f.api.configure).toHaveBeenCalledTimes(1));
    const changed = bootstrap();
    changed.build.buildId = "b".repeat(64);
    vi.mocked(f.api.bootstrap).mockResolvedValue(changed);
    await c.refresh();
    expect(c.getSnapshot().status).toBe("incompatible");
    reply.resolve(response());
    expect((await pending).state).toBe("unknown");
    expect(c.getSnapshot().intents[intention]?.connectorSetup).toBeUndefined();
    expect(f.api.configure).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it("captures original command values before asynchronous dispatch", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    vi.mocked(f.api.configure).mockResolvedValue(response());
    const mutable = { ...command };
    const pending = c.configure(mutable, intention);
    mutable.operationId = "99999999-9999-4999-8999-999999999999";
    mutable.runtimeKey = "mutated-secret-key-000000000000000000";
    expect((await pending).state).toBe("applied");
    expect(f.api.configure).toHaveBeenCalledWith(command);
    expect(
      c.getSnapshot().intents[intention]?.connectorSetup?.operationId,
    ).toBe(operationId);
    expect(JSON.stringify(c.getSnapshot())).not.toContain(mutable.runtimeKey);
    c.dispose();
  });

  it("keeps a known partial save receipt and permits a fresh operation while preventing replay", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    const refused: ConnectorSetupReceipt = {
      ...completed,
      state: "refused",
      stoppedAt: "connection-admission",
      connection: "not-started",
      code: "CONNECTOR_SETUP_BINDING_CHANGED",
    };
    vi.mocked(f.api.configure).mockResolvedValue(response(refused));
    const result = await c.configure(command, intention);
    expect(result.state).toBe("refused");
    expect(result.connectorSetup).toEqual(refused);
    expect(await c.configure(command, intention)).toBe(result);
    expect(
      (
        await c.configure(
          { ...command, runtimeKey: "replacement-fixture-key-00000000000" },
          "remounted-label",
        )
      ).code,
    ).toBe("INTENTION_PAYLOAD_CONFLICT");
    expect(f.api.configure).toHaveBeenCalledTimes(1);
    const nextId = "99999999-9999-4999-8999-999999999999";
    vi.mocked(f.api.configure).mockResolvedValue(
      response({ ...completed, operationId: nextId }),
    );
    expect(
      (await c.configure({ ...command, operationId: nextId }, intention)).state,
    ).toBe("applied");
    expect(f.api.configure).toHaveBeenCalledTimes(2);
    c.dispose();
  });
});

it("Home local views and exact record identities survive Back and Forward without a command", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  c.navigate({ area: "home", homeView: "work", homeSelection: null });
  c.navigate({
    area: "home",
    homeView: "work",
    homeSelection: { kind: "task", id: "owned-task", turnId: "original-turn" },
  });
  const inspected = c.getSnapshot().destination;
  c.navigate({ area: "home", homeView: "activity" });
  expect(c.getSnapshot().destination.homeSelection).toBeNull();
  c.travel(-1);
  expect(c.getSnapshot().destination).toEqual(inspected);
  c.travel(1);
  expect(c.getSnapshot().destination).toMatchObject({
    area: "home",
    homeView: "activity",
    homeSelection: null,
  });
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
  c.dispose();
});
it("Setup is a separate history destination with the same Settings host surface and no automatic effects", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  c.navigate({ area: "setup" });
  expect(c.getSnapshot().destination).toMatchObject({
    area: "setup",
    setupStep: "overview",
    page: "general",
  });
  c.navigate({ area: "setup", setupStep: "folders" });
  c.navigate({ area: "setup", setupStep: "attachment" });
  c.travel(-1);
  expect(c.getSnapshot().destination).toMatchObject({
    area: "setup",
    setupStep: "folders",
    page: "folders",
  });
  expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.[0]).toBe("settings");
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
  c.dispose();
});
it.each(["home", "browser", "computer", "settings", "activity"] as const)(
  "a returning partial profile retains its task through Home, Setup and ChatGPT with %s launch preference",
  async (launch) => {
    const f = fixture();
    const data = bootstrap();
    data.configuration.settings.general.openAtLaunch = launch;
    data.configuration.settings.computer.workspaces = [
      {
        workspaceId: "22222222-2222-4222-8222-222222222222",
        root: "/tmp/partial-setup",
        label: "Partial",
        access: "read",
        excludedPaths: [],
        rootIdentity: { device: "1", inode: "2" },
      },
    ];
    // Parse the complete fixture through the production schema at bootstrap.
    vi.mocked(f.api.bootstrap).mockResolvedValue({
      ...data,
      taskRevision: 1,
      tasks: [task("other"), task("retained")],
      selectedTaskId: "retained",
    });
    for (let lifetime = 0; lifetime < 2; lifetime++) {
      const c = new WindowController(f.api);
      await c.start();
      expect(c.getSnapshot().status).toBe("current");
      expect(c.getSnapshot().destination).toMatchObject({
        area: "home",
        taskId: "retained",
      });
      expect(c.getSnapshot().back).toBe(false);
      expect(c.getSnapshot().forward).toBe(false);
      const home = c.getSnapshot().destination;
      c.travel(-1);
      expect(c.getSnapshot().destination).toBe(home);
      c.navigate({ area: "setup" });
      expect(c.getSnapshot().destination.setupStep).toBe("overview");
      expect(c.getSnapshot().destination.taskId).toBe("retained");
      c.navigate({ area: "chatgpt" });
      expect(c.getSnapshot().destination.taskId).toBe("retained");
      expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.slice(0, 2)).toEqual([
        "browser",
        "retained",
      ]);
      expect(data.configuration.settings.general.openAtLaunch).toBe(launch);
      expect(data.configuration.settings.setup.journey.dismissed).toBe(false);
      c.dispose();
    }
    expect(f.api.configure).not.toHaveBeenCalled();
    expect(f.api.task).not.toHaveBeenCalled();
  },
);
describe("F0 window owner", () => {
  it.each([
    { launch: "home", area: "home", page: "general" },
    { launch: "browser", area: "chatgpt", page: "general" },
    { launch: "computer", area: "settings", page: "computer" },
    { launch: "settings", area: "settings", page: "general" },
    { launch: "activity", area: "activity", page: "general" },
  ] as const)(
    "keeps the retained task independently of the chosen $launch destination",
    async ({ launch, area, page }) => {
      const f = fixture();
      const data = bootstrap();
      data.configuration.settings.setup.journey.dismissed = true;
      data.configuration.settings.general.openAtLaunch = launch;
      vi.mocked(f.api.bootstrap).mockResolvedValue({
        ...data,
        taskRevision: 1,
        tasks: [task("other"), task("retained")],
        selectedTaskId: "retained",
      });
      const c = new WindowController(f.api);
      await c.start();
      expect(c.getSnapshot().destination).toMatchObject({
        area,
        page,
        taskId: "retained",
      });
      for (const area of ["home", "setup", "chatgpt"] as const) {
        c.navigate({ area });
        expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.[1]).toBe("retained");
      }
      expect(f.api.task).not.toHaveBeenCalled();
      expect(f.api.configure).not.toHaveBeenCalled();
      c.dispose();
    },
  );
  it.each(["", "unknown", " retained", "retained ", "RETAINED"])(
    "does not substitute a task for an unmatched bootstrap selector %j",
    async (selectedTaskId) => {
      const f = fixture();
      const data = bootstrap();
      data.configuration.settings.setup.journey.dismissed = true;
      vi.mocked(f.api.bootstrap).mockResolvedValue({
        ...data,
        taskRevision: 1,
        tasks: [task("other"), task("retained")],
        selectedTaskId,
      });
      const c = new WindowController(f.api);
      await c.start();
      expect(c.getSnapshot().destination).toMatchObject({
        area: "chatgpt",
        taskId: "",
      });
      expect(f.api.task).not.toHaveBeenCalled();
      c.dispose();
    },
  );
  it("does not restore a bootstrap selector removed by a newer buffered task list", async () => {
    const f = fixture();
    const reply = deferred<unknown>();
    vi.mocked(f.api.bootstrap).mockReturnValue(reply.promise);
    const c = new WindowController(f.api);
    const started = c.start();
    f.emit("tasks", { revision: 2, tasks: [task("other")] });
    const data = bootstrap();
    data.configuration.settings.setup.journey.dismissed = true;
    reply.resolve({
      ...data,
      taskRevision: 1,
      tasks: [task("retained")],
      selectedTaskId: "retained",
    });
    await started;
    expect(c.getSnapshot().tasks).toEqual({
      revision: 2,
      tasks: [task("other")],
    });
    expect(c.getSnapshot().destination.taskId).toBe("");
    expect(f.api.task).not.toHaveBeenCalled();
    c.dispose();
  });
  it.each([
    "navigation",
    "task selection",
    "explicit empty selection",
    "pending navigation",
    "invalid pending navigation",
    "overlay",
    "sidebar",
  ])(
    "bootstrap selection preserves newer %s before bootstrap resolves",
    async (owner) => {
      const f = fixture();
      const reply = deferred<unknown>();
      vi.mocked(f.api.bootstrap).mockReturnValue(reply.promise);
      const c = new WindowController(f.api);
      const started = c.start();
      if (owner === "navigation") {
        c.navigate({ area: "setup", setupStep: "folders" });
        c.navigate({ area: "setup", setupStep: "attachment" });
        c.travel(-1);
      } else if (owner === "task selection")
        c.navigate({ area: "chatgpt", taskId: "newer" });
      else if (owner === "explicit empty selection") c.navigate({ taskId: "" });
      else if (owner === "pending navigation")
        f.emit("action", sectionIntent("computer", 1, "newer"));
      else if (owner === "invalid pending navigation")
        f.emit("action", sectionIntent("computer", 1, "unknown"));
      else if (owner === "overlay") c.overlay("search");
      else c.toggleSidebar(true);
      const before = c.getSnapshot();
      const data = bootstrap();
      data.configuration.settings.setup.journey.dismissed = true;
      reply.resolve({
        ...data,
        taskRevision: 1,
        tasks: [task("retained"), task("newer")],
        selectedTaskId: "retained",
      });
      await started;
      if (owner === "pending navigation")
        expect(c.getSnapshot().destination).toEqual({
          area: "settings",
          page: "computer",
          taskId: "newer",
        });
      else if (
        owner === "task selection" ||
        owner === "explicit empty selection"
      ) {
        expect(c.getSnapshot().destination).toEqual(before.destination);
        expect(c.getSnapshot().overlay).toBe(before.overlay);
        expect(c.getSnapshot().sidebar).toBe(before.sidebar);
      } else {
        expect(c.getSnapshot().destination).toEqual({
          ...before.destination,
          taskId: "retained",
        });
        expect(c.getSnapshot().overlay).toBe(before.overlay);
        expect(c.getSnapshot().sidebar).toBe(before.sidebar);
        expect(c.getSnapshot().back).toBe(before.back);
        expect(c.getSnapshot().forward).toBe(before.forward);
        if (owner === "navigation") {
          const setup = c.getSnapshot().destination;
          c.travel(-1);
          expect(c.getSnapshot().destination).toMatchObject({
            area: "home",
            taskId: "retained",
          });
          expect(c.getSnapshot().back).toBe(false);
          c.travel(1);
          expect(c.getSnapshot().destination).toEqual(setup);
          expect(c.getSnapshot().forward).toBe(true);
        }
        f.emit(
          "action",
          sectionIntent("browser", 2, c.getSnapshot().destination.taskId),
        );
        expect(c.getSnapshot().destination).toMatchObject({
          area: "chatgpt",
          taskId: "retained",
        });
        expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.slice(0, 2)).toEqual([
          "browser",
          "retained",
        ]);
      }
      if (
        owner === "task selection" ||
        owner === "explicit empty selection" ||
        owner === "pending navigation"
      )
        expect(
          vi
            .mocked(f.api.layout)
            .mock.calls.some(([, taskId]) => taskId === "retained"),
        ).toBe(false);
      expect(f.api.task).not.toHaveBeenCalled();
      expect(f.api.configure).not.toHaveBeenCalled();
      c.dispose();
    },
  );
  it("retains the bootstrap cursor through early Home to Setup, Back to Home and ChatGPT", async () => {
    const f = fixture();
    const reply = deferred<unknown>();
    vi.mocked(f.api.bootstrap).mockReturnValue(reply.promise);
    const c = new WindowController(f.api);
    const started = c.start();
    c.navigate({ area: "setup", setupStep: "folders" });
    reply.resolve({
      ...bootstrap(),
      taskRevision: 1,
      tasks: [task("other"), task("retained")],
      selectedTaskId: "retained",
    });
    await started;
    expect(c.getSnapshot().destination).toMatchObject({
      area: "setup",
      setupStep: "folders",
      taskId: "retained",
    });
    c.travel(-1);
    expect(c.getSnapshot().destination).toEqual({
      area: "home",
      page: "general",
      taskId: "retained",
    });
    expect(c.getSnapshot().back).toBe(false);
    expect(c.getSnapshot().forward).toBe(true);
    f.emit(
      "action",
      sectionIntent("browser", 1, c.getSnapshot().destination.taskId),
    );
    expect(c.getSnapshot().destination).toMatchObject({
      area: "chatgpt",
      taskId: "retained",
    });
    expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "browser",
      "retained",
    ]);
    expect(f.api.task).not.toHaveBeenCalled();
    expect(f.api.configure).not.toHaveBeenCalled();
    c.dispose();
  });
  it("R10 retains an unknown explicit account confirmation without another command", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    vi.mocked(f.api.configure).mockResolvedValue({
      ok: false,
      error: "CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED",
      snapshot: bootstrap().configuration,
    });
    const command = {
      kind: "chatgpt.approve-readonly-account" as const,
      operationId: "11111111-1111-4111-8111-111111111111",
      confirmationId: "22222222-2222-4222-8222-222222222222",
    };
    const first = await c.configure(command, "account:confirmation");
    expect(first.state).toBe("unknown");
    expect(await c.configure(command, "account:confirmation")).toEqual(first);
    expect(f.api.configure).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().intents["account:confirmation"]?.state).toBe(
      "unknown",
    );
    c.dispose();
  });
  it("R06 R08 conflicting buffered tasks cannot finish initial bootstrap as current", async () => {
    const f = fixture();
    const reply = deferred<unknown>();
    vi.mocked(f.api.bootstrap).mockReturnValue(reply.promise);
    const c = new WindowController(f.api);
    const statuses: string[] = [];
    const off = c.subscribe(() => statuses.push(c.getSnapshot().status));
    const started = c.start();
    f.emit("tasks", { revision: 1, tasks: [task("task-A")] });
    reply.resolve({ ...bootstrap(), taskRevision: 1, tasks: [task("task-B")] });
    await started;
    expect(c.getSnapshot().status).toBe("stale");
    expect(statuses).not.toContain("current");
    expect((await c.task({ kind: "task.create-chatgpt" }, "new")).code).toBe(
      "CURRENT_STATE_REQUIRED",
    );
    expect(
      (
        await c.configure(
          {
            kind: "general.update",
            openAtLaunch: "browser",
            sidebarDefault: "full",
            activityDetail: "summary",
          },
          "settings:navigation",
        )
      ).code,
    ).toBe("CURRENT_STATE_REQUIRED");
    expect(f.api.task).not.toHaveBeenCalled();
    expect(f.api.configure).not.toHaveBeenCalled();
    off();
    c.dispose();
  });
  it.each([
    {
      name: "identical revision and payload",
      bootstrapRevision: 1,
      bootstrapTask: "task-A",
      events: [{ revision: 1, id: "task-A" }],
      expectedRevision: 1,
      expectedTask: "task-A",
    },
    {
      name: "newer event before an older reordered event",
      bootstrapRevision: 1,
      bootstrapTask: "task-B",
      events: [
        { revision: 3, id: "task-A" },
        { revision: 2, id: "task-old" },
      ],
      expectedRevision: 3,
      expectedTask: "task-A",
    },
    {
      name: "buffered event older than bootstrap",
      bootstrapRevision: 2,
      bootstrapTask: "task-B",
      events: [{ revision: 1, id: "task-A" }],
      expectedRevision: 2,
      expectedTask: "task-B",
    },
  ])("R06 R08 accepts $name during initial bootstrap", async (scenario) => {
    const f = fixture();
    const reply = deferred<unknown>();
    vi.mocked(f.api.bootstrap).mockReturnValue(reply.promise);
    const c = new WindowController(f.api);
    const started = c.start();
    for (const event of scenario.events)
      f.emit("tasks", { revision: event.revision, tasks: [task(event.id)] });
    reply.resolve({
      ...bootstrap(),
      taskRevision: scenario.bootstrapRevision,
      tasks: [task(scenario.bootstrapTask)],
    });
    await started;
    expect(c.getSnapshot().status).toBe("current");
    expect(c.getSnapshot().tasks.revision).toBe(scenario.expectedRevision);
    expect(c.getSnapshot().tasks.tasks.map((item) => item.taskId)).toEqual([
      scenario.expectedTask,
    ]);
    expect(f.api.task).not.toHaveBeenCalled();
    expect(f.api.configure).not.toHaveBeenCalled();
    c.dispose();
  });
  it("R34 selecting the current search destination preserves both history directions", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    c.navigate({ area: "settings", page: "folders" });
    c.navigate({ page: "appearance" });
    c.travel(-1);
    c.overlay("search");
    c.navigate({ page: "folders" });
    expect(c.getSnapshot().overlay).toBe("none");
    expect(c.getSnapshot().back).toBe(true);
    expect(c.getSnapshot().forward).toBe(true);
    expect(f.api.layout).toHaveBeenLastCalledWith(
      "settings",
      "",
      false,
      false,
      "full",
      "none",
      180,
    );
    c.travel(1);
    expect(c.getSnapshot().destination.page).toBe("appearance");
    c.travel(-1);
    c.travel(-1);
    expect(c.getSnapshot().destination.area).toBe("home");
    expect(f.api.task).not.toHaveBeenCalled();
    expect(f.api.configure).not.toHaveBeenCalled();
    c.dispose();
  });
  it("R06 R08 subscribes before bootstrap, coalesces task revisions", async () => {
    const f = fixture();
    const wait = deferred<unknown>();
    vi.mocked(f.api.bootstrap).mockReturnValue(wait.promise);
    const c = new WindowController(f.api);
    const started = c.start();
    expect(f.listeners.size).toBe(10);
    f.emit("tasks", { revision: 3, tasks: [task()] });
    f.emit("tasks", { revision: 2, tasks: [] });
    wait.resolve(bootstrap());
    await started;
    expect(c.getSnapshot().tasks.revision).toBe(3);
    c.dispose();
    expect(f.listeners.size).toBe(0);
  });
  it("R10 R11 starts once and keeps snapshots stable", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    expect(c.start()).toBe(c.start());
    await c.start();
    const s = c.getSnapshot();
    expect(c.getSnapshot()).toBe(s);
    const notify = vi.fn();
    const off = c.subscribe(notify);
    off();
    off();
    f.emit("route", { state: "loaded" });
    expect(notify).not.toHaveBeenCalled();
    expect(f.api.bootstrap).toHaveBeenCalledTimes(1);
    c.dispose();
    c.dispose();
    expect(f.disposers.every((d) => vi.mocked(d).mock.calls.length === 1)).toBe(
      true,
    );
  });
  it("R15 R17 R18 installs synchronous latch and retains unknown intention", async () => {
    const f = fixture();
    const wait = deferred<unknown>();
    vi.mocked(f.api.configure).mockReturnValue(wait.promise);
    const c = new WindowController(f.api);
    await c.start();
    const cmd = { kind: "computer.choose-workspace" } as const;
    const a = c.configure(cmd, "pick");
    const b = c.configure(cmd, "pick");
    expect(c.getSnapshot().intents.pick?.state).toBe("pending");
    await vi.waitFor(() => expect(f.api.configure).toHaveBeenCalledTimes(1));
    wait.reject();
    expect((await a).state).toBe("unknown");
    expect((await b).state).toBe("unknown");
    expect((await c.configure(cmd, "pick")).state).toBe("unknown");
    expect(f.api.configure).toHaveBeenCalledTimes(1);
    expect(
      (await c.configure({ kind: "computer.add-workspace" }, "pick")).code,
    ).toBe("INTENTION_PAYLOAD_CONFLICT");
    c.dispose();
  });
  it("R07 rejects older settings and evidence", async () => {
    const f = fixture();
    const a = deferred<unknown>(),
      b = deferred<unknown>();
    vi.mocked(f.api.configure)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    const c = new WindowController(f.api);
    await c.start();
    const old = c.configure({ kind: "computer.choose-workspace" }, "old");
    const next = c.configure({ kind: "computer.add-workspace" }, "new");
    b.resolve({
      ok: true,
      snapshot: { status: "ready", settings: settings(3) },
    });
    await next;
    a.resolve({
      ok: true,
      snapshot: { status: "ready", settings: settings(2) },
    });
    await old;
    expect(c.getSnapshot().configuration).toMatchObject({
      settings: { revision: 3 },
    });
    c.dispose();
  });
  it("R13 R14 incompatible bootstrap and disconnected controls fail closed", async () => {
    const f = fixture();
    vi.mocked(f.api.bootstrap).mockResolvedValue({ schema: 99 });
    const c = new WindowController(f.api);
    await c.start();
    expect(c.getSnapshot().status).toBe("incompatible");
    expect((await c.task({ kind: "task.create-chatgpt" }, "new")).state).toBe(
      "refused",
    );
    expect(f.api.task).not.toHaveBeenCalled();
    c.dispose();
  });
  it("R21 R22 completion never steals a later destination and unmount never cancels", async () => {
    const f = fixture();
    const wait = deferred<unknown>();
    vi.mocked(f.api.task).mockReturnValue(wait.promise);
    const c = new WindowController(f.api);
    await c.start();
    const action = c.task({ kind: "task.create-chatgpt" }, "new");
    const off = c.subscribe(() => {});
    off();
    c.navigate({ area: "settings", page: "folders" });
    wait.resolve({
      ok: true,
      state: { revision: 1, tasks: [task()] },
      selectedTaskId: "task-1",
    });
    await action;
    expect(c.getSnapshot().destination.area).toBe("settings");
    expect(f.api.task).toHaveBeenCalledTimes(1);
    c.dispose();
  });
  it("R05 excludes transcript text and obsolete task activity", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    f.emit("tasks", { revision: 1, tasks: [task()] });
    const identity = {
      ownerId: "owner",
      sessionId: "task-1",
      taskId: "task-1",
      turnId: "task-1",
      generation: 1,
      at: 100,
    };
    f.emit("event", {
      ...identity,
      kind: "text.delta",
      sequence: 1,
      text: "private body",
    });
    f.emit("event", {
      ...identity,
      kind: "turn.terminal",
      phase: "outcome_unknown",
      code: "UNKNOWN",
    });
    expect(c.getSnapshot().activity).toHaveLength(1);
    expect(JSON.stringify(c.getSnapshot())).not.toContain("private body");
    f.emit("tasks", { revision: 2, tasks: [] });
    expect(c.getSnapshot().activity).toHaveLength(0);
    c.dispose();
  });
  it("R25 R26 ignores identical layout and stale overlay mirror", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    c.navigate({ area: "chatgpt", taskId: "task-1" });
    c.overlay("task");
    const state = c.getSnapshot();
    f.emit("layout", {
      section: "browser",
      taskId: "task-1",
      setupOpen: false,
      sidebar: "full",
      overlay: "none",
    });
    expect(c.getSnapshot()).toBe(state);
    expect(state.overlay).toBe("task");
    c.dispose();
  });
  // A shortcut is an explicit stamped command. An ordinary layout mirror
  // carries no navigation authority, even when it names the same section.
  it.each([
    {
      name: "General to Computer",
      start: { area: "settings", page: "general" },
      section: "computer",
      rail: false,
      expected: { area: "settings", page: "computer", taskId: "" },
    },
    {
      name: "Appearance to Settings General",
      start: { area: "settings", page: "appearance" },
      section: "settings",
      rail: true,
      expected: { area: "settings", page: "general", taskId: "" },
    },
    {
      name: "Home to Activity",
      start: { area: "home", page: "general" },
      section: "activity",
      rail: false,
      expected: { area: "activity", page: "general", taskId: "" },
    },
  ] as const)(
    "R35 native section shortcut navigates $name",
    async (scenario) => {
      const f = fixture();
      const c = new WindowController(f.api);
      await c.start();
      c.navigate(scenario.start);
      if (scenario.rail) c.toggleSidebar(false);
      try {
        f.emit("action", sectionIntent(scenario.section));
        expect(c.getSnapshot().destination).toEqual(scenario.expected);
        expect(f.api.task).not.toHaveBeenCalled();
        expect(f.api.configure).not.toHaveBeenCalled();
      } finally {
        c.dispose();
      }
    },
  );
  it.each([
    {
      name: "Settings Appearance",
      start: { area: "settings", page: "appearance" },
      section: "settings",
      rail: true,
    },
    {
      name: "Home",
      start: { area: "home", page: "general" },
      section: "activity",
      rail: false,
    },
  ] as const)(
    "R35 ordinary layout mirror preserves $name",
    async (scenario) => {
      const f = fixture();
      const c = new WindowController(f.api);
      await c.start();
      c.navigate(scenario.start);
      if (scenario.rail) c.toggleSidebar(false);
      const state = c.getSnapshot();
      const commands = vi.mocked(f.api.layout).mock.calls.length;
      try {
        const mirror = {
          section: scenario.section,
          taskId: "",
          setupOpen: false,
          checkFeedbackVisible: false,
          sidebar: "rail",
          overlay: "none",
        };
        f.emit("layout", mirror);
        f.emit("layout", mirror);
        expect(c.getSnapshot()).toBe(state);
        expect(f.api.layout).toHaveBeenCalledTimes(commands);
        expect(f.api.task).not.toHaveBeenCalled();
        expect(f.api.configure).not.toHaveBeenCalled();
      } finally {
        c.dispose();
      }
    },
  );
  it.each([
    { section: "browser", area: "chatgpt", page: "general" },
    { section: "computer", area: "settings", page: "computer" },
    { section: "activity", area: "activity", page: "general" },
    { section: "settings", area: "settings", page: "general" },
  ])(
    "R35 stamped $section intent retains the exact selected task",
    async (target) => {
      const f = fixture();
      const c = new WindowController(f.api);
      await c.start();
      f.emit("tasks", { revision: 1, tasks: [task("task-1"), task("task-2")] });
      c.navigate({ area: "chatgpt", taskId: "task-1" });
      c.overlay("task");
      c.toggleSidebar(true);
      const count = vi.mocked(f.api.layout).mock.calls.length;
      const action = sectionIntent(target.section, 1, "task-2");
      f.emit("action", action);
      expect(c.getSnapshot()).toMatchObject({
        destination: { area: target.area, page: target.page, taskId: "task-2" },
        overlay: "none",
        sidebar: "rail",
      });
      expect(f.api.layout).toHaveBeenCalledTimes(count + 1);
      const state = c.getSnapshot();
      f.emit("action", action);
      expect(c.getSnapshot()).toBe(state);
      expect(f.api.layout).toHaveBeenCalledTimes(count + 1);
      expect(f.api.task).not.toHaveBeenCalled();
      expect(f.api.configure).not.toHaveBeenCalled();
      c.dispose();
    },
  );
  it("R35 an intent for the current destination closes overlays once without history", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    c.navigate({ area: "settings", page: "general" });
    c.overlay("task");
    const count = vi.mocked(f.api.layout).mock.calls.length;
    const action = sectionIntent();
    f.emit("action", action);
    expect(c.getSnapshot().overlay).toBe("none");
    expect(f.api.layout).toHaveBeenCalledTimes(count + 1);
    const state = c.getSnapshot();
    f.emit("action", action);
    expect(c.getSnapshot()).toBe(state);
    c.travel(-1);
    expect(c.getSnapshot().destination.area).toBe("home");
    c.dispose();
  });
  it("R35 same-destination native intent fences an older task completion", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    c.navigate({ area: "settings", page: "general" });
    const reply = deferred<unknown>();
    vi.mocked(f.api.task).mockReturnValueOnce(reply.promise);
    const create = c.task({ kind: "task.create-chatgpt" }, "create");
    await vi.waitFor(() => expect(f.api.task).toHaveBeenCalledTimes(1));
    f.emit("action", sectionIntent());
    reply.resolve({
      ok: true,
      state: { revision: 1, tasks: [task()] },
      selectedTaskId: "task-1",
    });
    expect((await create).state).toBe("applied");
    expect(c.getSnapshot().destination).toEqual({
      area: "settings",
      page: "general",
      taskId: "",
    });
    c.dispose();
  });
  it("R35 reordered, duplicate and conflicting event IDs cannot replay navigation", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    f.emit("action", sectionIntent("computer", 2));
    const state = c.getSnapshot();
    const count = vi.mocked(f.api.layout).mock.calls.length;
    f.emit("action", sectionIntent("activity", 1));
    f.emit("action", {
      ...sectionIntent("activity", 2),
      eventId: "22222222-2222-4222-8222-222222222222",
    });
    f.emit("action", {
      ...sectionIntent("activity", 3),
      eventId: sectionIntent("computer", 2).eventId,
    });
    expect(c.getSnapshot()).toBe(state);
    expect(f.api.layout).toHaveBeenCalledTimes(count);
    f.emit("action", sectionIntent("activity", 4));
    expect(c.getSnapshot().destination.area).toBe("activity");
    c.dispose();
  });
  it("R35 all layout mirrors preserve destination, overlays, sidebar and history", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    f.emit("tasks", { revision: 1, tasks: [task()] });
    c.navigate({ area: "settings", page: "appearance", taskId: "task-1" });
    c.overlay("search");
    c.toggleSidebar(true);
    const state = c.getSnapshot();
    const count = vi.mocked(f.api.layout).mock.calls.length;
    for (const section of ["browser", "computer", "activity", "settings"])
      f.emit("layout", {
        section,
        taskId: "task-1",
        setupOpen: false,
        sidebar: "full",
        overlay: "none",
      });
    expect(c.getSnapshot()).toBe(state);
    expect(f.api.layout).toHaveBeenCalledTimes(count);
    c.overlay("none");
    const closed = c.getSnapshot();
    f.emit("layout", {
      section: "browser",
      taskId: "task-1",
      setupOpen: false,
      sidebar: "full",
      overlay: "none",
    });
    expect(c.getSnapshot()).toBe(closed);
    c.dispose();
  });
  it("R35 malformed intent cannot consume a valid sequence or trigger commands", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    const state = c.getSnapshot();
    for (const overrides of [
      { source: "auth-window-closed" },
      { authWindowGeneration: 1 },
      { section: "home" },
      { sequence: 0 },
      { sequence: Number.MAX_SAFE_INTEGER + 1 },
      { taskId: null },
      { extra: true },
    ])
      f.emit("action", { ...sectionIntent(), ...overrides });
    expect(c.getSnapshot()).toBe(state);
    f.emit("action", sectionIntent());
    expect(c.getSnapshot().destination).toEqual({
      area: "settings",
      page: "general",
      taskId: "",
    });
    expect(f.api.bootstrap).toHaveBeenCalledTimes(1);
    expect(f.api.task).not.toHaveBeenCalled();
    expect(f.api.configure).not.toHaveBeenCalled();
    c.dispose();
  });
  it("R35 removed or missing task targets are never adopted or retried", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    f.emit("tasks", { revision: 1, tasks: [task()] });
    c.navigate({ area: "chatgpt", taskId: "task-1" });
    const state = c.getSnapshot();
    f.emit("action", sectionIntent("browser", 1, "removed"));
    f.emit("action", sectionIntent("settings", 2));
    expect(c.getSnapshot()).toBe(state);
    f.emit("tasks", { revision: 2, tasks: [] });
    c.navigate({ area: "settings", page: "appearance", taskId: "" });
    const removed = c.getSnapshot();
    f.emit("action", sectionIntent("browser", 3, "task-1"));
    expect(c.getSnapshot()).toBe(removed);
    f.emit("tasks", { revision: 3, tasks: [task()] });
    f.emit("action", sectionIntent("browser", 3, "task-1"));
    expect(c.getSnapshot().destination).toEqual(removed.destination);
    f.emit("action", sectionIntent("browser", 4, "task-1"));
    expect(c.getSnapshot().destination.taskId).toBe("task-1");
    expect(f.api.task).not.toHaveBeenCalled();
    c.dispose();
  });
  it("R35 applying updates retain their overlay and consume rather than defer navigation", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    c.overlay("update");
    f.emit("update", { phase: "applying", version: "1.0" });
    const state = c.getSnapshot();
    const action = sectionIntent("computer");
    f.emit("action", action);
    expect(c.getSnapshot()).toBe(state);
    f.emit("update", { phase: "idle", checkedAt: null });
    const done = c.getSnapshot();
    f.emit("action", action);
    expect(c.getSnapshot()).toBe(done);
    f.emit("action", sectionIntent("computer", 2));
    expect(c.getSnapshot().destination.page).toBe("computer");
    c.dispose();
  });
  it("R35 stale state cannot navigate or replay the refused intent after recovery", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    f.emit("runtime", {
      state: "offline",
      error: null,
      identity: null,
      embeddedNode: null,
      embeddedElectron: null,
    });
    const state = c.getSnapshot();
    const action = sectionIntent("computer", 2);
    f.emit("action", action);
    expect(c.getSnapshot()).toBe(state);
    await c.refresh();
    expect(c.getSnapshot().status).toBe("current");
    const ready = c.getSnapshot();
    f.emit("action", action);
    f.emit("action", sectionIntent("activity", 1));
    expect(c.getSnapshot()).toBe(ready);
    c.dispose();
  });
  it("R35 latest bootstrap intent is validated against adopted tasks before launch defaults", async () => {
    const f = fixture();
    const reply = deferred<unknown>();
    vi.mocked(f.api.bootstrap).mockReturnValue(reply.promise);
    const c = new WindowController(f.api);
    const destinations: string[] = [];
    const off = c.subscribe(() =>
      destinations.push(c.getSnapshot().destination.area),
    );
    const started = c.start();
    f.emit("action", sectionIntent("browser", 1, "task-1"));
    f.emit("action", sectionIntent("computer", 2, "task-1"));
    f.emit("action", sectionIntent("activity", 1, "task-1"));
    expect(c.getSnapshot().destination.area).toBe("home");
    const configured = settings();
    configured.setup.journey.dismissed = true;
    configured.general.sidebarDefault = "rail";
    reply.resolve({
      ...bootstrap(),
      selectedTaskId: "task-2",
      taskRevision: 1,
      tasks: [task("task-1"), task("task-2")],
      configuration: { status: "ready", settings: configured },
    });
    await started;
    expect(c.getSnapshot().destination).toEqual({
      area: "settings",
      page: "computer",
      taskId: "task-1",
    });
    expect(c.getSnapshot().sidebar).toBe("rail");
    expect(destinations).not.toContain("chatgpt");
    expect(
      vi
        .mocked(f.api.layout)
        .mock.calls.filter(([section]) => section === "settings"),
    ).toHaveLength(1);
    expect(f.api.task).not.toHaveBeenCalled();
    off();
    c.dispose();
  });
  it.each(["navigation", "overlay", "sidebar"])(
    "R35 later owner %s supersedes a buffered bootstrap intent",
    async (owner) => {
      const f = fixture();
      const reply = deferred<unknown>();
      vi.mocked(f.api.bootstrap).mockReturnValue(reply.promise);
      const c = new WindowController(f.api);
      const started = c.start();
      f.emit("action", sectionIntent("computer"));
      if (owner === "navigation")
        c.navigate({ area: "settings", page: "appearance" });
      else if (owner === "overlay") c.overlay("search");
      else c.toggleSidebar(true);
      const state = c.getSnapshot();
      reply.resolve(bootstrap());
      await started;
      expect(c.getSnapshot().destination).toEqual(state.destination);
      expect(c.getSnapshot().overlay).toBe(state.overlay);
      expect(c.getSnapshot().sidebar).toBe(state.sidebar);
      c.dispose();
    },
  );
  it.each(["invalid", "contradictory"])(
    "R35 %s bootstrap discards pending navigation without recovery replay",
    async (cause) => {
      const f = fixture();
      const reply = deferred<unknown>();
      vi.mocked(f.api.bootstrap).mockReturnValueOnce(reply.promise);
      const c = new WindowController(f.api);
      const started = c.start();
      const action = sectionIntent("computer");
      f.emit("action", action);
      if (cause === "contradictory") {
        f.emit("tasks", { revision: 1, tasks: [task("task-A")] });
        reply.resolve({
          ...bootstrap(),
          taskRevision: 1,
          tasks: [task("task-B")],
        });
      } else reply.resolve({ schema: "invalid" });
      await started;
      expect(c.getSnapshot().destination.area).toBe("home");
      vi.mocked(f.api.bootstrap).mockResolvedValue(bootstrap());
      await c.refresh();
      f.emit("action", action);
      expect(c.getSnapshot().destination.area).toBe("home");
      c.dispose();
    },
  );
  it("R24 update Later never restarts, readiness comes from Release", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    expect((await c.update("restart")).state).toBe("refused");
    await c.update("later");
    expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "later" });
    expect(f.api.installedUpdate).not.toHaveBeenCalledWith({ kind: "restart" });
    c.dispose();
  });
  it("navigation maintains bounded back and forward history", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    c.navigate({ area: "settings", page: "folders" });
    c.navigate({ page: "appearance" });
    c.travel(-1);
    expect(c.getSnapshot().destination.page).toBe("folders");
    expect(c.getSnapshot().forward).toBe(true);
    c.travel(1);
    expect(c.getSnapshot().destination.page).toBe("appearance");
    c.toggleSidebar(false);
    c.appearance({ theme: "graphite", accent: "iris", font: "geist" });
    c.dispose();
  });
});
it("R06 retains runtime and native window pushes during bootstrap", async () => {
  const f = fixture();
  const wait = deferred<unknown>();
  vi.mocked(f.api.bootstrap).mockReturnValue(wait.promise);
  const c = new WindowController(f.api);
  const start = c.start();
  f.emit("runtime", {
    state: "offline",
    error: null,
    identity: null,
    embeddedNode: null,
    embeddedElectron: null,
  });
  f.emit("window", {
    focused: true,
    fullScreen: true,
    trafficLightPosition: null,
  });
  f.emit("route", { state: "failed" });
  wait.resolve(bootstrap());
  await start;
  expect(c.getSnapshot().runtime).toBe("offline");
  expect(c.getSnapshot().window.focused).toBe(true);
  expect(c.getSnapshot().route).toBe("failed");
  c.dispose();
});
it("R12 bounded startup event overflow observes state without mutation replay", async () => {
  const f = fixture();
  const wait = deferred<unknown>();
  vi.mocked(f.api.bootstrap)
    .mockReturnValueOnce(wait.promise)
    .mockResolvedValue({ ...bootstrap(), taskRevision: 1, tasks: [task()] });
  const c = new WindowController(f.api);
  const start = c.start();
  f.emit("configuration", null);
  for (let i = 0; i < 260; i++)
    f.emit("event", {
      ownerId: "o",
      sessionId: "task-1",
      taskId: "task-1",
      turnId: "task-1",
      generation: 1,
      at: i,
      kind: "turn.terminal",
      phase: "outcome_unknown",
      code: "UNKNOWN",
    });
  wait.resolve({ ...bootstrap(), taskRevision: 1, tasks: [task()] });
  await start;
  expect(c.getSnapshot().activity.length).toBeLessThanOrEqual(256);
  expect(f.api.bootstrap).toHaveBeenCalledTimes(2);
  expect(f.api.configure).not.toHaveBeenCalled();
  c.dispose();
});
it("R07 R09 R14 reconnect read rejects unverified build and stale read completion", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  const a = deferred<unknown>(),
    b = deferred<unknown>();
  vi.mocked(f.api.bootstrap)
    .mockReturnValueOnce(a.promise)
    .mockReturnValueOnce(b.promise);
  const old = c.refresh(),
    next = c.refresh();
  b.resolve({
    ...bootstrap(),
    configuration: { status: "ready", settings: settings(5) },
  });
  await next;
  a.resolve(bootstrap());
  await old;
  expect(c.getSnapshot().configuration).toMatchObject({
    settings: { revision: 5 },
  });
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    build: { ...bootstrap().build, buildId: "4".repeat(64) },
  });
  await c.refresh();
  expect(c.getSnapshot().status).toBe("incompatible");
  c.dispose();
});
it("R18 preserves valid refusal, unknown task result and distinct requested tasks", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  vi.mocked(f.api.configure).mockResolvedValueOnce({
    ok: false,
    error: "SETTINGS_INPUT_INVALID",
    snapshot: bootstrap().configuration,
  });
  expect(
    (await c.configure({ kind: "computer.choose-workspace" }, "pick")).state,
  ).toBe("refused");
  vi.mocked(f.api.task).mockResolvedValueOnce({
    ok: false,
    error: "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN",
    state: { revision: 1, tasks: [] },
  });
  expect((await c.task({ kind: "task.create-chatgpt" }, "new-a")).state).toBe(
    "unknown",
  );
  vi.mocked(f.api.task).mockResolvedValueOnce({
    ok: true,
    state: { revision: 2, tasks: [task()] },
    selectedTaskId: "task-1",
  });
  expect((await c.task({ kind: "task.create-chatgpt" }, "new-b")).state).toBe(
    "applied",
  );
  expect(c.getSnapshot().destination.taskId).toBe("task-1");
  c.dispose();
});
it("R23 malformed update and rejected reads remain classified", async () => {
  const f = fixture();
  vi.mocked(f.api.installedUpdate).mockRejectedValueOnce(
    new Error("secret detail"),
  );
  const c = new WindowController(f.api);
  await c.start();
  expect(c.getSnapshot().update.phase).toBe("unavailable");
  f.emit("update", {
    phase: "ready",
    version: "1.0",
    deferred: false,
    blockedBy: null,
  });
  vi.mocked(f.api.installedUpdate).mockResolvedValueOnce({});
  expect((await c.update("restart")).state).toBe("unknown");
  vi.mocked(f.api.bootstrap).mockRejectedValueOnce(
    new Error("private transport"),
  );
  await c.refresh();
  expect(c.getSnapshot().status).toBe("stale");
  expect(JSON.stringify(c.getSnapshot())).not.toContain("private transport");
  c.dispose();
});
it("R30 repeated native actions and background completion do not navigate", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  const action = {
    action: "open-settings",
    eventId: "11111111-1111-4111-8111-111111111111",
    source: "auth-window-closed",
    authWindowGeneration: 1,
  };
  f.emit("action", action);
  expect(c.getSnapshot().destination.area).toBe("home");
  f.emit("action", action);
  await Promise.resolve();
  expect(f.api.bootstrap).toHaveBeenCalledTimes(2);
  f.emit("action", {
    ...action,
    eventId: "22222222-2222-4222-8222-222222222222",
    source: "settings-command",
  });
  expect(c.getSnapshot().destination.page).toBe("connection");
  f.emit("action", {
    ...action,
    eventId: "33333333-3333-4333-8333-333333333333",
    action: "open-quick-switcher",
    source: "quick-switcher-command",
  });
  expect(c.getSnapshot().overlay).toBe("search");
  f.emit("action", {
    ...action,
    eventId: "44444444-4444-4444-8444-444444444444",
    action: "close-overlay",
    source: "overlay-dismissed",
  });
  expect(c.getSnapshot().overlay).toBe("none");
  c.toggleSidebar(true);
  expect(c.getSnapshot().sidebar).toBe("overlay");
  c.toggleSidebar(true);
  expect(c.getSnapshot().sidebar).toBe("rail");
  c.dispose();
});
it("R20 observes exact pending edit without sending an acknowledgement or new effect", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  await c.observeWorkspaceEdit("11111111-1111-4111-8111-111111111111");
  expect(f.api.configure).toHaveBeenCalledWith({
    kind: "computer.observe-workspace-edit",
    operationId: "11111111-1111-4111-8111-111111111111",
  });
  expect(f.api.configure).toHaveBeenCalledTimes(1);
  c.dispose();
});
it("R08 rejects removed/mismatched task events and lower task revisions", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  f.emit("tasks", { revision: 3, tasks: [task()] });
  const state = c.getSnapshot();
  f.emit("tasks", { revision: 2, tasks: [] });
  expect(c.getSnapshot()).toBe(state);
  f.emit("event", {
    ownerId: "o",
    sessionId: "task-1",
    taskId: "task-1",
    turnId: "old",
    generation: 1,
    at: 1,
    kind: "turn.phase",
    phase: "running",
  });
  expect(c.getSnapshot().activity).toHaveLength(0);
  f.emit("tasks", { bad: true });
  expect(c.getSnapshot().status).toBe("stale");
  c.dispose();
});
it("R10 freezes nested projections and rejects conflicting task revision without replacing current data", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  f.emit("tasks", { revision: 1, tasks: [task()] });
  const state = c.getSnapshot();
  expect(Object.isFrozen(state.tasks.tasks[0])).toBe(true);
  expect(() => {
    state.tasks.tasks[0]!.label = "changed";
  }).toThrow();
  f.emit("tasks", { revision: 1, tasks: [{ ...task(), label: "conflict" }] });
  expect(c.getSnapshot().tasks).toBe(state.tasks);
  expect(c.getSnapshot().status).toBe("stale");
  c.dispose();
});
it("R20 exact delivered result acknowledges only once by explicit owner action", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  const id = "11111111-1111-4111-8111-111111111111",
    workspaceId = "22222222-2222-4222-8222-222222222222";
  const value = settings(2);
  value.computer.pendingEdit = {
    operationId: id,
    workspaceId,
    relativePath: "file.txt",
    computerGeneration: 1,
    submittedAt: "2026-10-02T20:00:00.000Z",
  };
  vi.mocked(f.api.configure).mockResolvedValueOnce({
    ok: true,
    snapshot: { status: "ready", settings: value },
    evidence: {
      kind: "computer.workspace-mutation",
      operationId: id,
      workspaceId,
      relativePath: "file.txt",
      operation: "edit",
      bytes: 12,
      replacements: 1,
      beforeSha256: "1".repeat(64),
      afterSha256: "2".repeat(64),
      resultRetention: "durable",
      redelivered: true,
    },
  });
  await c.observeWorkspaceEdit(id);
  expect(c.getSnapshot().workspaceEditDelivery).toBe(id);
  expect(f.api.configure).toHaveBeenCalledTimes(1);
  expect(
    (await c.acknowledgeWorkspaceEdit("33333333-3333-4333-8333-333333333333"))
      .state,
  ).toBe("refused");
  const wait = deferred<unknown>();
  vi.mocked(f.api.configure).mockReturnValueOnce(wait.promise);
  const a = c.acknowledgeWorkspaceEdit(id),
    b = c.acknowledgeWorkspaceEdit(id);
  await vi.waitFor(() => expect(f.api.configure).toHaveBeenCalledTimes(2));
  wait.reject();
  expect((await a).state).toBe("unknown");
  expect((await b).state).toBe("unknown");
  await c.acknowledgeWorkspaceEdit(id);
  expect(f.api.configure).toHaveBeenCalledTimes(2);
  c.dispose();
});
it("R35 shortcut validation, accepted persistence and unknown latch are distinct", async () => {
  const f = fixture(),
    persist = vi.fn();
  const c = new WindowController(f.api, undefined, persist);
  await c.start();
  const value = {
    browser: 1,
    computer: 2,
    activity: 3,
    settings: 4,
    sidebar: "b",
  } as const;
  expect((await c.shortcuts({ ...value, computer: 1 })).state).toBe("refused");
  expect(f.api.setNavigationShortcuts).not.toHaveBeenCalled();
  await c.shortcuts(value);
  expect(c.getSnapshot().shortcuts.sidebar).toBe("b");
  expect(persist).toHaveBeenCalledExactlyOnceWith(value);
  vi.mocked(f.api.setNavigationShortcuts).mockResolvedValueOnce({ ok: false });
  expect((await c.shortcuts({ ...value, sidebar: "off" })).state).toBe(
    "refused",
  );
  vi.mocked(f.api.setNavigationShortcuts).mockRejectedValueOnce(
    new Error("private"),
  );
  expect((await c.shortcuts({ ...value, sidebar: "s" })).state).toBe("unknown");
  await c.shortcuts({ ...value, sidebar: "s" });
  expect(f.api.setNavigationShortcuts).toHaveBeenCalledTimes(3);
  c.dispose();
});
it("R24 unavailable/unknown release responses never imply applied completion", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  vi.mocked(f.api.installedUpdate).mockResolvedValueOnce({
    phase: "unavailable",
    code: "UPDATE_UNSUPPORTED",
  });
  expect((await c.update("check")).state).toBe("refused");
  vi.mocked(f.api.installedUpdate).mockResolvedValueOnce({
    phase: "failed",
    code: "UPDATE_OUTCOME_UNKNOWN",
    recoveryRequired: false,
    rollbackVersion: null,
  });
  expect((await c.update("check")).state).toBe("unknown");
  c.dispose();
});
it("R06 R35 configured launch preferences are lifecycle-owned while a new profile starts Home", async () => {
  const f = fixture();
  const data = bootstrap();
  data.configuration.settings.setup.journey.dismissed = true;
  data.configuration.settings.general.openAtLaunch = "computer";
  data.configuration.settings.general.sidebarDefault = "rail";
  vi.mocked(f.api.bootstrap).mockResolvedValue(data);
  const c = new WindowController(f.api);
  await c.start();
  expect(c.getSnapshot().destination).toMatchObject({
    area: "settings",
    page: "computer",
  });
  expect(c.getSnapshot().sidebar).toBe("rail");
  expect(f.api.configure).not.toHaveBeenCalled();
  c.dispose();
});
// Source-only regressions for the renderer/host applying-update admission seam.
// They prove no native updater, package, helper process or installed effect.
it.each([
  ["navigation", (c: WindowController) => c.navigate({ area: "home" })],
  ["history back", (c: WindowController) => c.travel(-1)],
  ["history forward", (c: WindowController) => c.travel(1)],
  ["compact sidebar", (c: WindowController) => c.toggleSidebar(true)],
  ["full sidebar", (c: WindowController) => c.toggleSidebar(false)],
  ["sidebar resize", (c: WindowController) => c.resizeSidebar(224, false)],
  ["search overlay", (c: WindowController) => c.overlay("search")],
  ["task overlay", (c: WindowController) => c.overlay("task")],
  ["dismiss overlay", (c: WindowController) => c.overlay("none")],
] as const)(
  "R24 applying update rejects %s without a native layout push",
  async (_name, act) => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    c.navigate({ area: "activity" });
    c.navigate({ area: "settings", page: "appearance" });
    c.travel(-1);
    c.overlay("update");
    f.emit("update", { phase: "applying", version: "1.0" });
    const before = c.getSnapshot();
    vi.mocked(f.api.layout).mockClear();
    try {
      act(c);
      expect(c.getSnapshot()).toBe(before);
      expect(c.getSnapshot().overlay).toBe("update");
      expect(f.api.layout).not.toHaveBeenCalled();
      // A newer settled update projection releases the presentation fence.
      f.emit("update", { phase: "idle", checkedAt: null });
      act(c);
      expect(f.api.layout).toHaveBeenCalled();
    } finally {
      c.dispose();
    }
  },
);
it("ends a drag during update admission without resuming native browser input", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  c.resizeSidebar(224, true);
  f.emit("update", { phase: "applying", version: "1.0" });
  vi.mocked(f.api.layout).mockClear();
  c.resizeSidebar(224, false);
  expect(c.getSnapshot().sidebarResizing).toBe(false);
  expect(f.api.layout).not.toHaveBeenCalled();
  f.emit("update", { phase: "failed", code: "UPDATE_ABORTED" });
  expect(f.api.layout).not.toHaveBeenCalled(); // Missing settlement fields are not an ACK.
  const held = c.getSnapshot().destination;
  c.navigate({ area: "settings", page: "diagnostics" });
  c.presentation();
  expect(c.getSnapshot().destination).toBe(held);
  expect(f.api.layout).not.toHaveBeenCalled();
  f.emit("update", {
    phase: "failed",
    code: "UPDATE_ABORTED",
    recoveryRequired: false,
  });
  expect(f.api.layout).toHaveBeenLastCalledWith(
    "activity",
    "",
    false,
    false,
    "full",
    "none",
    224,
  );
  vi.mocked(f.api.layout).mockClear();
  c.dispose();
  c.resizeSidebar(288, true);
  expect(c.getSnapshot().sidebarWidth).toBe(224);
  expect(f.api.layout).not.toHaveBeenCalled();
});

it.each([
  ["open-quick-switcher", "quick-switcher-command"],
  ["toggle-sidebar", "sidebar-command"],
  ["open-settings", "settings-command"],
] as const)(
  "R24 applying update consumes native %s without replacing presentation",
  async (action, source) => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    c.navigate({ area: "settings", page: "updates" });
    c.overlay("update");
    f.emit("update", { phase: "applying", version: "1.0" });
    const before = c.getSnapshot();
    vi.mocked(f.api.layout).mockClear();
    try {
      f.emit("action", {
        action,
        source,
        eventId: "11111111-1111-4111-8111-111111111111",
        authWindowGeneration: null,
      });
      expect(c.getSnapshot().destination).toEqual(before.destination);
      expect(c.getSnapshot().sidebar).toBe(before.sidebar);
      expect(c.getSnapshot().overlay).toBe("update");
      expect(f.api.layout).not.toHaveBeenCalled();
    } finally {
      c.dispose();
    }
  },
);
it("R24 Escape cannot dismiss applying and native update action uses the shared intention", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  f.emit("action", {
    action: "open-updates",
    source: "update-command",
    eventId: "11111111-1111-4111-8111-111111111111",
    authWindowGeneration: null,
  });
  await vi.waitFor(() =>
    expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "check" }),
  );
  f.emit("update", { phase: "applying", version: "1.0" });
  c.overlay("none");
  expect(c.getSnapshot().overlay).toBe("update");
  c.dispose();
});
it("R07 R13 an in-flight refresh cannot erase a newer offline lifecycle push", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  const reply = deferred<unknown>();
  vi.mocked(f.api.bootstrap).mockReturnValueOnce(reply.promise);
  const refresh = c.refresh();
  f.emit("runtime", {
    state: "offline",
    error: null,
    identity: null,
    embeddedNode: null,
    embeddedElectron: null,
  });
  reply.resolve(bootstrap());
  await refresh;
  expect(c.getSnapshot().runtime).toBe("offline");
  expect(c.getSnapshot().status).toBe("stale");
  expect((await c.task({ kind: "task.create-chatgpt" }, "new")).state).toBe(
    "refused",
  );
  expect(f.api.task).not.toHaveBeenCalled();
  c.dispose();
});
it("R08 a conflicting bootstrap task revision cannot clear its own stale fence", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  f.emit("tasks", { revision: 1, tasks: [task()] });
  vi.mocked(f.api.bootstrap).mockResolvedValueOnce({
    ...bootstrap(),
    taskRevision: 1,
    tasks: [{ ...task(), label: "contradiction" }],
  });
  await c.refresh();
  expect(c.getSnapshot().status).toBe("stale");
  expect(c.getSnapshot().tasks.tasks[0]?.label).toBe("Task 1");
  c.dispose();
});

it("R30 explicit Updates during bootstrap is dispatched once after readiness", async () => {
  const f = fixture();
  const waiting = deferred<unknown>();
  vi.mocked(f.api.bootstrap).mockReturnValue(waiting.promise);
  const c = new WindowController(f.api);
  const start = c.start();
  const event = {
    action: "open-updates",
    eventId: "0199c0de-0000-4000-8000-0000000000aa",
    source: "update-command",
    authWindowGeneration: null,
  };
  f.emit("action", event);
  f.emit("action", event);
  expect(f.api.installedUpdate).not.toHaveBeenCalledWith({ kind: "check" });
  waiting.resolve(bootstrap());
  await start;
  expect(f.api.installedUpdate).toHaveBeenCalledWith({ kind: "check" });
  expect(
    vi
      .mocked(f.api.installedUpdate)
      .mock.calls.filter(([v]) => v.kind === "check"),
  ).toHaveLength(1);
  c.dispose();
  await c.update("check");
  expect(
    vi
      .mocked(f.api.installedUpdate)
      .mock.calls.filter(([v]) => v.kind === "check"),
  ).toHaveLength(1);
});
it("R07 initial update observation cannot roll back a newer update event", async () => {
  const f = fixture();
  const waiting = deferred<unknown>();
  vi.mocked(f.api.installedUpdate).mockReturnValue(waiting.promise);
  const c = new WindowController(f.api);
  const start = c.start();
  await Promise.resolve();
  await Promise.resolve();
  const current = {
    phase: "ready",
    version: "1.0",
    deferred: false,
    blockedBy: null,
  };
  f.emit("update", current);
  waiting.resolve({ phase: "idle", checkedAt: null });
  await start;
  expect(c.getSnapshot().update).toEqual(current);
  c.dispose();
});

it("R13 latest failed configuration read cannot leave cached permissions current", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  const previous = c.getSnapshot().configuration;
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    configuration: { status: "error", error: "SETTINGS_READ_FAILED" },
  });
  await c.refresh();
  expect(c.getSnapshot().configuration).toBe(previous);
  expect(c.getSnapshot().status).toBe("stale");
  const result = await c.configure(
    { kind: "chatgpt.open-browser" },
    "settings:chatgpt.open-browser:",
  );
  expect(result.state).toBe("refused");
  expect(f.api.configure).not.toHaveBeenCalled();
  vi.mocked(f.api.bootstrap).mockResolvedValue(bootstrap());
  await c.refresh();
  expect(c.getSnapshot().status).toBe("current");
  expect(f.api.configure).not.toHaveBeenCalled();
  c.dispose();
});

it("R07 superseded malformed bootstrap cannot invalidate a newer valid refresh", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  const old = deferred<unknown>();
  const latest = deferred<unknown>();
  vi.mocked(f.api.bootstrap)
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(latest.promise);
  const first = c.refresh();
  const second = c.refresh();
  latest.resolve(bootstrap());
  await second;
  const snapshot = c.getSnapshot();
  old.resolve({ schema: "invalid" });
  await first;
  expect(c.getSnapshot()).toBe(snapshot);
  expect(snapshot.status).toBe("current");
  c.dispose();
});
it("R35 native sidebar actions use the single renderer owner and preserve compact overlays", async () => {
  for (const compact of [false, true]) {
    const f = fixture();
    const c = new WindowController(f.api, undefined, undefined, () => compact);
    await c.start();
    c.navigate({ area: "chatgpt" });
    const action = {
      action: "toggle-sidebar",
      eventId: "11111111-1111-4111-8111-111111111111",
      source: "sidebar-command",
      authWindowGeneration: null,
    };
    f.emit("action", action);
    f.emit("action", action);
    expect(c.getSnapshot().sidebar).toBe(compact ? "overlay" : "rail");
    f.emit("layout", {
      section: "browser",
      taskId: "",
      setupOpen: false,
      sidebar: "full",
      overlay: "none",
    });
    expect(c.getSnapshot().sidebar).toBe(compact ? "overlay" : "rail");
    c.dispose();
  }
});
it("R17 unknown connector intention retains only a digest rather than the runtime key", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  vi.mocked(f.api.configure).mockRejectedValue(new Error("reply lost"));
  const runtimeKey = "explicit-test-runtime-key-000000000000";
  const command = {
    kind: "connector.configure" as const,
    tunnelId: "owner-tunnel",
    runtimeKey,
  };
  const first = c.configure(command, "connector:save");
  const duplicate = c.configure(command, "connector:save");
  expect((await first).state).toBe("unknown");
  expect((await duplicate).state).toBe("unknown");
  expect(f.api.configure).toHaveBeenCalledTimes(1);
  const map = (
    c as unknown as { commands: Map<string, { fingerprint: Promise<string> }> }
  ).commands;
  const retained = map.get("connector:save")!;
  expect(await retained.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(retained)).not.toContain(runtimeKey);
  expect(
    (
      await c.configure(
        { ...command, runtimeKey: "different-test-key-0000000000000" },
        "connector:save",
      )
    ).code,
  ).toBe("INTENTION_PAYLOAD_CONFLICT");
  expect(f.api.configure).toHaveBeenCalledTimes(1);
  c.dispose();
});

it("R15 a missing payload digest refuses before transport admission", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  const digest = vi
    .spyOn(crypto.subtle, "digest")
    .mockRejectedValueOnce(new Error("unavailable"));
  expect(
    (await c.configure({ kind: "chatgpt.open-browser" }, "browser")).code,
  ).toBe("COMMAND_BINDING_UNAVAILABLE");
  expect(f.api.configure).not.toHaveBeenCalled();
  digest.mockRestore();
  c.dispose();
});

it("R11 R22 closed window settles bootstrap without further host reads or layout writes", async () => {
  const f = fixture();
  const waiting = deferred<unknown>();
  vi.mocked(f.api.bootstrap).mockReturnValue(waiting.promise);
  const c = new WindowController(f.api);
  const started = c.start();
  c.dispose();
  const atClose = c.getSnapshot();
  const layoutsAtClose = vi.mocked(f.api.layout).mock.calls.length;
  const refresh = c.refresh();
  waiting.resolve(bootstrap());
  await Promise.all([started, refresh]);
  expect(f.api.bootstrap).toHaveBeenCalledTimes(1);
  expect(c.getSnapshot()).toBe(atClose);
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
  expect(f.api.layout).toHaveBeenCalledTimes(layoutsAtClose);
  expect(f.listeners.size).toBe(0);
});

it("R22 window teardown leaves admitted task work alone and ignores its late navigation", async () => {
  const f = fixture();
  const waiting = deferred<unknown>();
  vi.mocked(f.api.task).mockReturnValue(waiting.promise);
  const c = new WindowController(f.api);
  await c.start();
  const admitted = c.task({ kind: "task.create-chatgpt" }, "new");
  await vi.waitFor(() => expect(f.api.task).toHaveBeenCalledTimes(1));
  c.dispose();
  const atClose = c.getSnapshot();
  const layoutsAtClose = vi.mocked(f.api.layout).mock.calls.length;
  waiting.resolve({
    ok: true,
    state: { revision: 1, tasks: [task()] },
    selectedTaskId: "task-1",
  });
  expect((await admitted).state).toBe("applied");
  expect(c.getSnapshot()).toBe(atClose);
  expect(f.api.task).toHaveBeenCalledTimes(1);
  expect(f.api.layout).toHaveBeenCalledTimes(layoutsAtClose);
  expect((await c.task({ kind: "task.create-chatgpt" }, "another")).code).toBe(
    "WINDOW_OBSERVATION_CLOSED",
  );
});

it("R22 shortcut completion after window teardown settles without preference persistence", async () => {
  const f = fixture();
  const waiting = deferred<unknown>();
  vi.mocked(f.api.setNavigationShortcuts).mockReturnValue(waiting.promise);
  const persist = vi.fn();
  const appearance = vi.fn();
  const c = new WindowController(f.api, appearance, persist);
  await c.start();
  const admitted = c.shortcuts(c.getSnapshot().shortcuts);
  await vi.waitFor(() =>
    expect(f.api.setNavigationShortcuts).toHaveBeenCalledTimes(1),
  );
  c.dispose();
  waiting.resolve({ ok: true });
  expect((await admitted).state).toBe("applied");
  expect(persist).not.toHaveBeenCalled();
  c.appearance({ theme: "light", accent: "iris", font: "geist" });
  c.presentation();
  expect(appearance).not.toHaveBeenCalled();
  expect(f.listeners.size).toBe(0);
});

it("R13 initial failed configuration never presents ready runtime as current permission", async () => {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    configuration: { status: "error", error: "SETTINGS_READ_FAILED" },
  });
  const c = new WindowController(f.api);
  await c.start();
  expect(c.getSnapshot()).toMatchObject({
    status: "stale",
    runtime: "ready",
    configuration: { status: "error" },
  });
  expect((await c.task({ kind: "task.create-chatgpt" }, "new")).code).toBe(
    "CURRENT_STATE_REQUIRED",
  );
  expect(f.api.task).not.toHaveBeenCalled();
  c.dispose();
});

// Injected transport only: these receipts prove renderer correlation, not a host write.
async function unknownGuardedEdit(
  retainPreview = true,
  ambientPreview = false,
) {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  const operationId = "44444444-4444-4444-8444-444444444444";
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const intention = `settings:computer.apply-workspace-edit:${operationId}`;
  const preview = {
    kind: "computer.workspace-edit-preview" as const,
    operationId,
    workspaceId,
    relativePath: "file.txt",
    bytes: 123,
    beforeSha256: "b".repeat(64),
    expiresAt: "2099-10-04T20:00:00.000Z",
  };
  if (retainPreview) {
    vi.mocked(f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: bootstrap().configuration,
      evidence: preview,
    });
    await c.configure(
      { kind: "computer.prepare-workspace-edit", workspaceId },
      "prepare",
    );
  }
  if (ambientPreview) {
    vi.mocked(f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: bootstrap().configuration,
      evidence: preview,
    });
    await c.configure({ kind: "support.export" }, "ambient-preview");
  }
  const command = {
    kind: "computer.apply-workspace-edit" as const,
    operationId,
    oldText: "old",
    newText: "new",
  };
  vi.mocked(f.api.configure).mockRejectedValueOnce(new Error("lost reply"));
  const original = await c.configure(command, intention);
  expect(original.state).toBe("unknown");
  const pending = { status: "ready" as const, settings: settings(2) };
  pending.settings.computer.pendingEdit = {
    operationId,
    workspaceId,
    relativePath: "file.txt",
    computerGeneration: 1,
    submittedAt: "2026-10-04T20:00:00.000Z",
  };
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    configuration: pending,
  });
  await c.refresh();
  const observation = {
    ok: true as const,
    snapshot: structuredClone(pending),
    evidence: {
      kind: "computer.workspace-mutation" as const,
      operationId,
      workspaceId,
      relativePath: "file.txt",
      operation: "edit" as "edit" | "write",
      bytes: 120,
      replacements: 1,
      beforeSha256: "b".repeat(64),
      afterSha256: "c".repeat(64),
      resultRetention: "durable",
      redelivered: true,
    },
  };
  const settled = structuredClone(pending);
  settled.settings.revision++;
  settled.settings.computer.pendingEdit = null;
  async function observe(result: unknown = observation) {
    vi.mocked(f.api.configure).mockResolvedValueOnce(result);
    return c.observeWorkspaceEdit(operationId);
  }
  async function ack(result: unknown = { ok: true, snapshot: settled }) {
    vi.mocked(f.api.configure).mockResolvedValueOnce(result);
    return c.acknowledgeWorkspaceEdit(operationId);
  }
  return {
    f,
    c,
    operationId,
    workspaceId,
    intention,
    original,
    command,
    preview,
    pending,
    observation,
    settled,
    observe,
    ack,
  };
}
it("settles only the exact unknown Apply after Observe and ACK while permanently consuming it", async () => {
  const h = await unknownGuardedEdit();
  await h.observe();
  expect(h.c.getSnapshot().intents[h.intention]).toBe(h.original);
  await h.ack();
  expect(h.c.getSnapshot().intents[h.intention]?.state).toBe("applied");
  const calls = vi.mocked(h.f.api.configure).mock.calls.length;
  expect(await h.c.configure(h.command, h.intention)).toBe(h.original);
  expect(
    (await h.c.configure({ ...h.command, newText: "changed" }, h.intention))
      .code,
  ).toBe("INTENTION_PAYLOAD_CONFLICT");
  expect((await h.c.configure(h.command, "another-apply-intention")).code).toBe(
    "WORKSPACE_EDIT_ALREADY_CONSUMED",
  );
  expect(h.f.api.configure).toHaveBeenCalledTimes(calls);
  // The old returned promise remains unknown; no reconciliation resubmits it.
  expect(h.original.state).toBe("unknown");
  expect(h.c.getSnapshot().intents[h.intention]?.state).toBe("applied");
  h.c.dispose();
});
it("settles an exact observed known refusal only after ACK", async () => {
  const h = await unknownGuardedEdit();
  await h.observe({
    ok: false,
    error: "WORKSPACE_EDIT_NO_MATCH",
    snapshot: h.pending,
  });
  expect(h.c.getSnapshot().intents[h.intention]).toBe(h.original);
  await h.ack();
  expect(h.c.getSnapshot().intents[h.intention]).toEqual({
    id: h.intention,
    state: "refused",
    code: "WORKSPACE_EDIT_NO_MATCH",
  });
  h.c.dispose();
});
it.each([
  "foreign-operation",
  "foreign-workspace",
  "foreign-path",
  "foreign-before-hash",
  "write-result",
  "pending-operation",
  "pending-workspace",
  "pending-path",
  "pending-generation",
  "current-generation",
  "current-computer",
  "missing-evidence",
  "unknown-outcome",
  "admission-refusal",
  "missing-preview",
  "ambient-preview",
])(
  "never settles the original Apply from incomplete or foreign Observe: %s",
  async (condition) => {
    const h = await unknownGuardedEdit(
      condition !== "missing-preview" && condition !== "ambient-preview",
      condition === "ambient-preview",
    );
    const observed = structuredClone(h.observation);
    const foreign = "33333333-3333-4333-8333-333333333333";
    const pending = observed.snapshot.settings.computer.pendingEdit!;
    if (condition === "foreign-operation")
      observed.evidence.operationId = foreign;
    if (condition === "foreign-workspace")
      observed.evidence.workspaceId = foreign;
    if (condition === "foreign-path")
      observed.evidence.relativePath = "other.txt";
    if (condition === "foreign-before-hash")
      observed.evidence.beforeSha256 = "d".repeat(64);
    if (condition === "write-result") observed.evidence.operation = "write";
    if (condition === "pending-operation") pending.operationId = foreign;
    if (condition === "pending-workspace") pending.workspaceId = foreign;
    if (condition === "pending-path") pending.relativePath = "other.txt";
    if (condition === "pending-generation") pending.computerGeneration++;
    if (condition === "current-generation")
      observed.snapshot.settings.computer.generation++;
    if (condition === "current-computer")
      observed.snapshot.settings.computer.computerId = foreign;
    await h.observe(
      condition === "missing-evidence"
        ? { ok: true, snapshot: h.pending }
        : condition === "unknown-outcome" || condition === "admission-refusal"
          ? {
              ok: false,
              error:
                condition === "unknown-outcome"
                  ? "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"
                  : "WORKSPACE_MUTATION_IN_PROGRESS",
              snapshot: h.pending,
            }
          : observed,
    );
    await h.ack();
    expect(h.c.getSnapshot().intents[h.intention]).toBe(h.original);
    h.c.dispose();
  },
);
it.each([
  "lost",
  "malformed",
  "refused",
  "still-pending",
  "foreign-pending",
  "generation",
  "computer",
  "revision",
])(
  "never settles an unknown Apply from an uncertain or mismatched ACK: %s",
  async (condition) => {
    const h = await unknownGuardedEdit();
    await h.observe();
    const settled = structuredClone(h.settled);
    if (condition === "generation") settled.settings.computer.generation++;
    if (condition === "computer")
      settled.settings.computer.computerId =
        "33333333-3333-4333-8333-333333333333";
    if (condition === "revision")
      settled.settings.revision = h.pending.settings.revision;
    if (condition === "foreign-pending")
      settled.settings.computer.pendingEdit = {
        ...h.pending.settings.computer.pendingEdit!,
        operationId: "33333333-3333-4333-8333-333333333333",
      };
    if (condition === "lost") {
      vi.mocked(h.f.api.configure).mockRejectedValueOnce(new Error("lost ACK"));
      await h.c.acknowledgeWorkspaceEdit(h.operationId);
      const calls = vi.mocked(h.f.api.configure).mock.calls.length;
      await h.c.acknowledgeWorkspaceEdit(h.operationId);
      expect(h.f.api.configure).toHaveBeenCalledTimes(calls);
    } else
      await h.ack(
        condition === "malformed"
          ? { ok: true }
          : condition === "refused"
            ? { ok: false, error: "SETTINGS_WRITE_FAILED", snapshot: settled }
            : {
                ok: true,
                snapshot: condition === "still-pending" ? h.pending : settled,
              },
      );
    expect(h.c.getSnapshot().intents[h.intention]).toBe(h.original);
    h.c.dispose();
  },
);
it.each([
  "refresh-only",
  "foreign-intention",
  "refresh-after-observe",
  "observe-race",
  "ack-race",
  "observation-gap",
  "ack-gap",
])(
  "never uses ambient, superseded or gap evidence to settle Apply: %s",
  async (condition) => {
    const h = await unknownGuardedEdit();
    if (condition === "refresh-only") {
      vi.mocked(h.f.api.bootstrap).mockResolvedValue({
        ...bootstrap(),
        configuration: h.settled,
      });
      await h.c.refresh();
    } else if (condition === "foreign-intention") {
      vi.mocked(h.f.api.configure).mockResolvedValueOnce(h.observation);
      expect(
        (await h.c.configure({ kind: "support.export" }, "foreign-intention"))
          .state,
      ).toBe("applied");
      await h.ack();
    } else if (condition === "refresh-after-observe") {
      await h.observe();
      await h.c.refresh();
      await h.ack();
    } else {
      if (condition === "ack-race" || condition === "ack-gap")
        await h.observe();
      const reply = deferred<unknown>();
      vi.mocked(h.f.api.configure).mockReturnValueOnce(reply.promise);
      const ack = condition === "ack-race" || condition === "ack-gap";
      const requested = ack
        ? h.c.acknowledgeWorkspaceEdit(h.operationId)
        : h.c.observeWorkspaceEdit(h.operationId);
      await vi.waitFor(() =>
        expect(h.f.api.configure).toHaveBeenCalledTimes(ack ? 4 : 3),
      );
      if (condition.endsWith("gap")) h.f.emit("tasks", { malformed: true });
      else await h.c.refresh();
      reply.resolve(ack ? { ok: true, snapshot: h.settled } : h.observation);
      await requested;
      if (!ack) await h.ack();
    }
    expect(h.c.getSnapshot().intents[h.intention]).toBe(h.original);
    h.c.dispose();
  },
);

it.each(["relativePath", "beforeSha256", "bytes", "expiresAt"] as const)(
  "retains preview identity even when refresh removes ambient evidence: %s",
  async (field) => {
    const h = await unknownGuardedEdit();
    const preview = {
      ...h.preview,
      operationId: "33333333-3333-4333-8333-333333333333",
    };
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.pending,
      evidence: preview,
    });
    expect(
      (
        await h.c.configure(
          {
            kind: "computer.prepare-workspace-edit",
            workspaceId: h.workspaceId,
          },
          "another-prepare",
        )
      ).state,
    ).toBe("applied");
    await h.c.refresh();
    const changed = {
      operationId: h.operationId,
      workspaceId: h.operationId,
      relativePath: "changed.txt",
      beforeSha256: "d".repeat(64),
      bytes: 125,
      expiresAt: "2099-10-05T20:00:00.000Z",
    };
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: true,
      snapshot: h.pending,
      evidence: { ...preview, [field]: changed[field] },
    });
    expect(
      (
        await h.c.configure(
          {
            kind: "computer.prepare-workspace-edit",
            workspaceId: h.workspaceId,
          },
          "another-prepare",
        )
      ).state,
    ).toBe("unknown");
    h.c.dispose();
  },
);
