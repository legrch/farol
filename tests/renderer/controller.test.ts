import { readySettings } from "./setup-fixture";
import { computerSetup } from "../../src/ui/renderer/computer-setup";
import { workspaceReadbackBinding } from "../../src/ui/guided-workspace-access";
import { describe, it, expect, vi } from "vitest";
import {
  canSetInstallOnQuitPreference,
  WindowController,
} from "../../src/ui/renderer/controller";
import type { WindowSnapshot } from "../../src/ui/renderer/contract";
import {
  bootstrap,
  deferred,
  fixture,
  settings,
  task,
  signInReply,
} from "./fixture";
import { signInPresentation } from "../../src/ui/renderer/sign-in-presentation";
import { setupChecklist } from "../../src/ui/renderer/setup-navigation";
import { commandAllowed } from "../../src/ui/renderer/command-eligibility";
import { ProductConfigurationCommandSchema } from "../../src/pkg/product-settings/contract";
import type { ConnectorSetupReceipt } from "../../src/pkg/product-settings/connector-setup-receipt";

describe("Goal17 explicit ChatGPT presentation", () => {
  // Projection-only: this fixture proves neither native placement nor provider state.
  it.each(["loading", "loaded", "failed"] as const)(
    "presents the retained %s route and returns to Setup without opening or selecting another task",
    async (route) => {
      const f = fixture();
      const data = bootstrap();
      vi.mocked(f.api.bootstrap).mockResolvedValue({
        ...data,
        taskRevision: 1,
        tasks: [task("retained")],
        selectedTaskId: "retained",
      });
      const c = new WindowController(f.api);
      await c.start();
      f.emit("route", { state: route });
      c.navigate({ area: "setup", setupStep: "folders" });
      const configuration = c.getSnapshot().configuration;
      for (let entry = 0; entry < 2; entry++) {
        c.navigate({ area: "chatgpt" });
        expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.slice(0, 3)).toEqual([
          "browser",
          "retained",
          false,
        ]);
        expect(c.getSnapshot().route).toBe(route);
        c.travel(-1);
        expect(c.getSnapshot().destination).toMatchObject({
          area: "setup",
          setupStep: "folders",
          taskId: "retained",
        });
        expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.[0]).toBe("settings");
        c.travel(1);
        expect(c.getSnapshot().destination.area).toBe("chatgpt");
        c.navigate({ area: "setup", setupStep: "folders" });
      }
      expect(c.getSnapshot().configuration).toBe(configuration);
      expect(f.api.configure).not.toHaveBeenCalled();
      expect(f.api.task).not.toHaveBeenCalled();
      c.dispose();
    },
  );

  it("asks the host to present loading without inferring absence from an invalid route event", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    expect(c.getSnapshot().route).toBe("loading");
    f.emit("route", { state: "absent" });
    c.navigate({ area: "chatgpt" });
    expect(c.getSnapshot().route).toBe("loading");
    await c.configure(
      { kind: "chatgpt.present-browser" },
      "settings:chatgpt.present-browser:",
    );
    expect(f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "chatgpt.present-browser",
    });
    expect(f.api.task).not.toHaveBeenCalled();
    c.dispose();
  });

  it("keeps update admission while presenting ChatGPT independently of offline Computer state", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    c.navigate({ area: "setup", setupStep: "folders" });
    f.emit("update", { phase: "applying", version: "1.0" });
    const held = c.getSnapshot();
    vi.mocked(f.api.layout).mockClear();
    c.navigate({ area: "chatgpt" });
    expect(c.getSnapshot()).toBe(held);
    expect(f.api.layout).not.toHaveBeenCalled();
    f.emit("update", { phase: "idle", checkedAt: null });
    f.emit("runtime", {
      state: "offline",
      error: null,
      identity: null,
      embeddedNode: null,
      embeddedElectron: null,
    });
    c.navigate({ area: "chatgpt" });
    expect(c.getSnapshot().status).toBe("stale");
    expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.slice(0, 3)).toEqual([
      "browser",
      "",
      false,
    ]);
    await c.configure(
      { kind: "chatgpt.present-browser" },
      "settings:chatgpt.present-browser:",
    );
    expect(f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "chatgpt.present-browser",
    });
    expect(c.getSnapshot().status).toBe("stale");
    expect(c.getSnapshot().runtime).toBe("offline");
    expect(f.api.task).not.toHaveBeenCalled();
    c.dispose();
  });
});

describe("Goal18 explicit ChatGPT host presentation", () => {
  const intention = "settings:chatgpt.present-browser:";
  const command = { kind: "chatgpt.present-browser" } as const;
  // Renderer transport fixtures only; the host owns absence and native identity.
  it.each(["applied", "refused", "unknown"] as const)(
    "retains one %s intention across duplicate clicks, refresh, travel and late replies",
    async (state) => {
      const f = fixture();
      const waiting = deferred<unknown>();
      const entered = deferred<void>();
      vi.mocked(f.api.configure).mockImplementationOnce(() => {
        entered.resolve();
        return waiting.promise;
      });
      const c = new WindowController(f.api);
      await c.start();
      expect(f.api.configure).not.toHaveBeenCalled();
      c.navigate({ area: "setup", setupStep: "folders" });
      c.conversationDraft.capture("conversation", "Unsent draft", 1, 4);
      const draft = c.conversationDraft.read("conversation");
      const historyEpoch = c.getSnapshot().chatHistoryEpoch;
      c.navigate({ area: "chatgpt" });
      expect(c.getSnapshot().intents[intention]?.state).toBe("pending");
      c.navigate({ area: "chatgpt" });
      const result = c.configure(command, intention);
      await entered.promise;
      expect(f.api.configure).toHaveBeenCalledExactlyOnceWith(command);
      c.travel(-1);
      const destination = c.getSnapshot().destination;
      await c.refresh();
      const stop = c.subscribe(() => {});
      stop();
      if (state === "unknown") waiting.reject(new Error("reply lost"));
      else
        waiting.resolve({
          ok: state === "applied",
          ...(state === "refused" ? { error: "CHATGPT_PAGE_UNREACHABLE" } : {}),
          snapshot: bootstrap().configuration,
        });
      const settled = await result;
      expect(settled.state).toBe(state);
      expect(c.getSnapshot().destination).toBe(destination);
      expect(c.getSnapshot().intents[intention]).toBe(settled);
      c.travel(1);
      c.navigate({ area: "home" });
      c.travel(-1);
      expect(await c.configure(command, "remounted-label")).toBe(settled);
      expect(c.conversationDraft.read("conversation")).toBe(draft);
      expect(c.getSnapshot().chatHistoryEpoch).toBe(historyEpoch);
      expect(c.getSnapshot().destination.taskId).toBe("");
      expect(f.api.configure).toHaveBeenCalledExactlyOnceWith(command);
      expect(f.api.task).not.toHaveBeenCalled();
      c.dispose();
    },
  );

  it.each(["loaded", "task"] as const)(
    "reveals the retained %s surface without issuing Open or presentation",
    async (surface) => {
      const f = fixture();
      const c = new WindowController(f.api);
      await c.start();
      if (surface === "loaded") f.emit("route", { state: "loaded" });
      else f.emit("tasks", { revision: 1, tasks: [task("retained")] });
      c.navigate({ area: "setup", setupStep: "folders" });
      c.overlay("search");
      c.navigate({
        area: "chatgpt",
        ...(surface === "task" ? { taskId: "retained" } : {}),
      });
      expect(c.getSnapshot().overlay).toBe("none");
      expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.slice(0, 3)).toEqual([
        "browser",
        surface === "task" ? "retained" : "",
        false,
      ]);
      c.travel(-1);
      c.travel(1);
      expect(f.api.configure).not.toHaveBeenCalled();
      expect(f.api.task).not.toHaveBeenCalled();
      c.dispose();
    },
  );

  it("does not open at startup, refresh, or presentation, including browser launch preference", async () => {
    const f = fixture();
    const data = bootstrap();
    data.configuration.settings.setup.journey.dismissed = true;
    vi.mocked(f.api.bootstrap).mockResolvedValue(data);
    const c = new WindowController(f.api);
    await c.start();
    expect(c.getSnapshot().destination.area).toBe("chatgpt");
    c.presentation();
    await c.refresh();
    expect(f.api.configure).not.toHaveBeenCalled();
    c.navigate({ area: "chatgpt" });
    await c.configure(command, intention);
    expect(f.api.configure).toHaveBeenCalledExactlyOnceWith(command);
    c.dispose();
  });

  it("presents once from an explicit browser shortcut, including a duplicate event", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    const action = sectionIntent("browser");
    f.emit("action", action);
    f.emit("action", action);
    f.emit("action", sectionIntent("browser", 2));
    await c.configure(command, intention);
    expect(c.getSnapshot().destination.area).toBe("chatgpt");
    expect(f.api.configure).toHaveBeenCalledExactlyOnceWith(command);
    c.dispose();
  });

  it("can request its first presentation on Back after a retained route becomes loading", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    f.emit("route", { state: "loaded" });
    c.navigate({ area: "chatgpt" });
    c.navigate({ area: "setup", setupStep: "folders" });
    f.emit("route", { state: "loading" });
    expect(f.api.configure).not.toHaveBeenCalled();
    c.travel(-1);
    await c.configure(command, intention);
    c.travel(1);
    c.travel(-1);
    expect(f.api.configure).toHaveBeenCalledExactlyOnceWith(command);
    c.dispose();
  });

  it("keeps a malformed presentation reply unknown despite a later loaded projection", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    vi.mocked(f.api.configure).mockResolvedValueOnce({ ok: true });
    c.navigate({ area: "chatgpt" });
    const result = await c.configure(command, intention);
    expect(result.state).toBe("unknown");
    f.emit("route", { state: "loaded" });
    await c.refresh();
    c.navigate({ area: "setup" });
    c.travel(-1);
    expect(await c.configure(command, intention)).toBe(result);
    expect(f.api.configure).toHaveBeenCalledExactlyOnceWith(command);
    c.dispose();
  });

  it("presents an explicitly selected home without selecting an unselected retained task", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    f.emit("tasks", { revision: 1, tasks: [task("retained")] });
    c.navigate({ area: "chatgpt" });
    expect(c.getSnapshot().destination.taskId).toBe("");
    await c.configure(command, intention);
    expect(f.api.configure).toHaveBeenCalledExactlyOnceWith(command);
    c.navigate({ taskId: "retained" });
    f.emit("tasks", { revision: 2, tasks: [] });
    c.navigate({ area: "setup" });
    c.travel(-1);
    expect(c.getSnapshot().destination.taskId).toBe("retained");
    expect(f.api.configure).toHaveBeenCalledTimes(1);
    expect(f.api.task).not.toHaveBeenCalled();
    c.dispose();
  });

  it.each(["incompatible", "applying"] as const)(
    "does not admit presentation from %s state",
    async (fence) => {
      const f = fixture();
      const c = new WindowController(f.api);
      await c.start();
      if (fence === "incompatible") {
        vi.mocked(f.api.bootstrap).mockResolvedValue({});
        await c.refresh();
      }
      if (fence === "applying")
        f.emit("update", { phase: "applying", version: "1.0" });
      c.navigate({ area: "chatgpt" });
      c.travel(-1);
      c.travel(1);
      f.emit("action", sectionIntent("browser"));
      expect(c.getSnapshot().intents[intention]).toBeUndefined();
      expect(f.api.configure).not.toHaveBeenCalled();
      c.dispose();
    },
  );

  it.each(["applying", "incompatible", "navigate", "loaded", "task"] as const)(
    "rechecks the %s fence after the pending latch and before the host effect",
    async (fence) => {
      const f = fixture();
      const c = new WindowController(f.api);
      await c.start();
      const digest = deferred<ArrayBuffer>();
      const binding = vi
        .spyOn(crypto.subtle, "digest")
        .mockReturnValue(digest.promise);
      try {
        c.navigate({ area: "chatgpt" });
        if (fence === "applying")
          f.emit("update", { phase: "applying", version: "1.0" });
        if (fence === "incompatible") {
          vi.mocked(f.api.bootstrap).mockResolvedValue({});
          await c.refresh();
        }
        if (fence === "navigate")
          c.navigate({ area: "setup", setupStep: "folders" });
        if (fence === "loaded") f.emit("route", { state: "loaded" });
        if (fence === "task") {
          f.emit("tasks", { revision: 1, tasks: [task()] });
          c.navigate({ taskId: task().taskId });
        }
        digest.resolve(new ArrayBuffer(32));
        const result = await c.configure(command, intention);
        expect(result.state).toBe(
          fence === "loaded" || fence === "task" ? "applied" : "refused",
        );
        expect(f.api.configure).not.toHaveBeenCalled();
      } finally {
        binding.mockRestore();
        c.dispose();
      }
    },
  );

  it.each(["pending", "refused", "unknown"] as const)(
    "does not add presentation to an existing %s Connection Open",
    async (state) => {
      const f = fixture();
      const c = new WindowController(f.api);
      await c.start();
      const waiting = deferred<unknown>();
      vi.mocked(f.api.configure).mockReturnValueOnce(waiting.promise);
      const original = c.configure(
        { kind: "chatgpt.open-browser" },
        "settings:chatgpt.open-browser:",
      );
      if (state === "unknown") waiting.reject(new Error("lost reply"));
      if (state === "refused")
        waiting.resolve({
          ok: false,
          error: "CHATGPT_PAGE_UNREACHABLE",
          snapshot: bootstrap().configuration,
        });
      if (state !== "pending") await original;
      c.navigate({ area: "chatgpt" });
      if (state === "pending") {
        waiting.resolve({ ok: true, snapshot: bootstrap().configuration });
        await original;
      }
      expect(c.getSnapshot().intents[intention]).toBeUndefined();
      expect(f.api.configure).toHaveBeenCalledExactlyOnceWith({
        kind: "chatgpt.open-browser",
      });
      c.dispose();
    },
  );
});

describe("normal Quit preference command provenance", () => {
  const off: WindowSnapshot["update"] = {
    phase: "idle",
    checkedAt: null,
    installOnQuitPreference: {
      status: "confirmed",
      scope: "install-on-normal-quit",
      enabled: false,
    },
    automaticUpdatePreference: { status: "confirmed", enabled: false },
  };
  const on: WindowSnapshot["update"] = {
    ...off,
    installOnQuitPreference: {
      status: "confirmed",
      scope: "install-on-normal-quit",
      enabled: true,
    },
  };
  async function controller() {
    const f = fixture();
    vi.mocked(f.api.installedUpdate).mockResolvedValue(off);
    const c = new WindowController(f.api);
    await c.start();
    vi.mocked(f.api.installedUpdate).mockClear();
    return { f, c };
  }
  it.each([
    {
      view: {},
      state: "unknown",
      code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
    },
    {
      view: { phase: "idle", checkedAt: null },
      state: "unknown",
      code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
    },
    {
      view: off,
      state: "unknown",
      code: "UPDATE_QUIT_PREFERENCE_ACK_MISMATCH",
    },
    {
      view: {
        ...off,
        installOnQuitPreference: { status: "confirmed", enabled: true },
      },
      state: "unknown",
      code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
    },
    {
      view: {
        ...off,
        installOnQuitPreference: {
          status: "confirmed",
          scope: "install-on-crash",
          enabled: true,
        },
      },
      state: "unknown",
      code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
    },
    {
      view: {
        ...off,
        installOnQuitPreference: {
          status: "unknown",
          enabled: false,
          code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
        },
      },
      state: "unknown",
      code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
    },
    {
      view: {
        ...off,
        installOnQuitPreference: {
          status: "blocked",
          enabled: false,
          code: "UPDATE_QUIT_PREFERENCE_UNREADABLE",
        },
      },
      state: "refused",
      code: "UPDATE_QUIT_PREFERENCE_UNREADABLE",
    },
  ])(
    "classifies exact quit preference acknowledgement $code ($state)",
    async ({ view, state, code }) => {
      const { f, c } = await controller();
      vi.mocked(f.api.installedUpdate).mockResolvedValueOnce(view);
      const result = await c.setInstallOnQuitPreference(true);
      expect(result).toEqual({ id: "update-install-on-quit", state, code });
      expect(c.getSnapshot().intents["update-install-on-quit"]).toBe(result);
      if (state === "unknown") {
        f.emit("update", on);
        await c.refresh();
        expect(await c.setInstallOnQuitPreference(false)).toBe(result);
        expect(c.getSnapshot().intents["update-install-on-quit"]).toBe(result);
      }
      expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
        kind: "set-install-on-quit-preference",
        enabled: true,
      });
      c.dispose();
    },
  );

  it("keeps a newer observed choice when an older command acknowledgement arrives", async () => {
    const { f, c } = await controller();
    const waiting = deferred<unknown>();
    vi.mocked(f.api.installedUpdate).mockReturnValueOnce(waiting.promise);
    const result = c.setInstallOnQuitPreference(true);
    await vi.waitFor(() =>
      expect(f.api.installedUpdate).toHaveBeenCalledTimes(1),
    );
    f.emit("update", { ...off, checkedAt: 10 });
    waiting.resolve(on);
    expect((await result).state).toBe("applied");
    expect(c.getSnapshot().update).toEqual({ ...off, checkedAt: 10 });
    c.dispose();
  });

  it.each<WindowSnapshot["update"]>([
    { phase: "unavailable", code: "UPDATE_NOT_INSTALLED" },
    {
      phase: "idle",
      checkedAt: null,
      blockedBy: "UPDATE_BROWSER_STATE_UNKNOWN",
    },
    { phase: "checking" },
    { phase: "downloading" },
    { phase: "applying", version: "0.2.1" },
    { phase: "recovery", version: "0.2.1", blockedBy: null },
    {
      phase: "ready",
      version: "0.2.1",
      deferred: false,
      blockedBy: "UPDATE_BROWSER_STATE_UNKNOWN",
    },
    {
      phase: "failed",
      code: "UPDATE_HANDOFF_UNKNOWN",
      recoveryRequired: false,
    },
    {
      phase: "failed",
      code: "UPDATE_CHECKSUM_MISMATCH",
      recoveryRequired: true,
    },
  ])(
    "refuses quit changes during unsafe update phase $phase",
    async (update) => {
      const { f, c } = await controller();
      f.emit("update", {
        ...update,
        installOnQuitPreference: off.installOnQuitPreference,
      });
      expect(canSetInstallOnQuitPreference(c.getSnapshot(), c)).toBe(false);
      expect((await c.setInstallOnQuitPreference(true)).state).toBe("refused");
      expect(f.api.installedUpdate).not.toHaveBeenCalled();
      c.dispose();
    },
  );

  it.each<WindowSnapshot["update"]>([
    {
      phase: "applying",
      version: "0.2.1",
      installOnQuitPreference: {
        status: "confirmed",
        scope: "install-on-normal-quit",
        enabled: false,
      },
    },
    { ...off, blockedBy: "UPDATE_BROWSER_STATE_UNKNOWN" },
    {
      ...off,
      installOnQuitPreference: {
        status: "blocked",
        enabled: false,
        code: "UPDATE_QUIT_PREFERENCE_UNREADABLE",
      },
    },
    {
      ...off,
      installOnQuitPreference: {
        status: "unknown",
        enabled: false,
        code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
      },
    },
  ])(
    "refuses a new admission fence during digest before any quit preference effect: %j",
    async (update) => {
      const { f, c } = await controller();
      const digest = deferred<ArrayBuffer>();
      const binding = vi
        .spyOn(crypto.subtle, "digest")
        .mockReturnValueOnce(digest.promise);
      try {
        const original = c.setInstallOnQuitPreference(true);
        expect(c.getSnapshot().intents["update-install-on-quit"]?.state).toBe(
          "pending",
        );
        f.emit("update", update);
        digest.resolve(new ArrayBuffer(32));
        expect(await original).toEqual({
          id: "update-install-on-quit",
          state: "refused",
          code: "UPDATE_QUIT_PREFERENCE_UNAVAILABLE",
        });
        expect(f.api.installedUpdate).not.toHaveBeenCalled();
        expect(c.getSnapshot().update).toEqual(update);
      } finally {
        binding.mockRestore();
        c.dispose();
      }
    },
  );

  it("keeps observation available but fences combined update consent after an unknown quit write", async () => {
    const { f, c } = await controller();
    vi.mocked(f.api.installedUpdate).mockRejectedValueOnce(
      new Error("reply lost"),
    );
    const original = await c.setInstallOnQuitPreference(true);
    expect(original.state).toBe("unknown");
    f.emit("update", off);
    vi.mocked(f.api.installedUpdate).mockResolvedValueOnce({
      ...off,
      automaticUpdatePreference: { status: "confirmed", enabled: true },
    });
    expect((await c.setAutomaticDownloads(true)).state).toBe("refused");
    expect(c.getSnapshot().intents["update-install-on-quit"]).toBe(original);
    expect(c.getSnapshot().update.installOnQuitPreference).toEqual(
      off.installOnQuitPreference,
    );
    expect(f.api.installedUpdate).toHaveBeenCalledTimes(1);
    expect(f.api.installedUpdate).not.toHaveBeenCalledWith({ kind: "restart" });
    c.dispose();
  });
});
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

it("Home and Activity preserve exact history without a command", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  c.navigate({ area: "home", homeView: "overview" });
  const home = c.getSnapshot().destination;
  c.navigate({ area: "activity", activityId: "event" });
  const activity = c.getSnapshot().destination;
  c.travel(-1);
  expect(c.getSnapshot().destination).toBe(home);
  c.travel(1);
  expect(c.getSnapshot().destination).toBe(activity);
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
  c.dispose();
});
it("workspace presentation identity belongs to the exact Setup history entry and generic entry clears it", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  const configuration = c.getSnapshot().configuration;
  c.navigate({
    area: "home",
    homeView: "overview",
    homeSelection: { kind: "attention", id: "folder:second" },
  });
  const home = c.getSnapshot().destination;
  c.navigate({ area: "setup", setupStep: "folders", workspaceId: "second" });
  expect(c.getSnapshot().destination.workspaceId).toBe("second");
  c.travel(-1);
  expect(c.getSnapshot().destination).toEqual(home);
  c.travel(1);
  expect(c.getSnapshot().destination.workspaceId).toBe("second");
  c.navigate({ area: "home" });
  c.navigate({ area: "setup", setupStep: "folders" });
  expect(c.getSnapshot().destination.workspaceId).toBeUndefined();
  c.travel(-1);
  c.travel(-1);
  expect(c.getSnapshot().destination.workspaceId).toBe("second");
  expect(c.getSnapshot().configuration).toBe(configuration);
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
  expect(f.api.snapshot).not.toHaveBeenCalled();
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
    page: "general",
  });
  expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.[0]).toBe("settings");
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
  c.dispose();
});
it.each(["home", "browser", "computer", "settings", "activity"] as const)(
  "a returning partial profile starts at Welcome and retains its task with %s launch preference",
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
        area: "setup",
        setupStep: "overview",
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
it("a fresh profile starts at Setup Welcome without applying its launch preference", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  expect(c.getSnapshot().destination).toMatchObject({
    area: "setup",
    setupStep: "overview",
  });
  expect(c.getSnapshot().back).toBe(false);
  expect(c.getSnapshot().forward).toBe(false);
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
  c.dispose();
});
it("completed setup defaults to Home even when its current runtime needs reconnection", async () => {
  const f = fixture();
  const data = bootstrap();
  data.configuration.settings.setup.journey.dismissed = true;
  data.configuration.settings.general.openAtLaunch = "home";
  vi.mocked(f.api.bootstrap).mockResolvedValue(data);
  const c = new WindowController(f.api);
  await c.start();
  expect(c.getSnapshot().destination.area).toBe("home");
  expect(f.api.configure).not.toHaveBeenCalled();
  c.dispose();
});
it("opens completed Setup on Home twice while live checks change without granting attachment", async () => {
  const f = fixture();
  const data = bootstrap();
  data.configuration.settings.setup.journey.dismissed = true;
  data.configuration.settings.general.openAtLaunch = "home";
  data.configuration.settings.connectors.secureMcp.attachment = null;
  for (const state of ["ready", "unreachable"] as const) {
    const saved = structuredClone(data);
    if (saved.configuration.settings.connectors.secureMcp.runtime)
      saved.configuration.settings.connectors.secureMcp.runtime.state = state;
    vi.mocked(f.api.bootstrap).mockResolvedValue(saved);
    const c = new WindowController(f.api);
    await c.start();
    expect(c.getSnapshot().destination.area).toBe("home");
    expect(c.getSnapshot().configuration).toMatchObject({
      settings: { setup: { journey: { dismissed: true } } },
    });
    expect(computerSetup(c.getSnapshot()).externalAccessVerified).toBe(false);
    c.dispose();
  }
  expect(f.api.configure).not.toHaveBeenCalled();
});
it("a verified attachment without finished Setup still opens Welcome", async () => {
  const f = fixture();
  const data = bootstrap();
  data.configuration.settings.general.openAtLaunch = "home";
  data.configuration.settings.connectors.secureMcp.lastVerifiedAttachment = {
    tunnelId: "fixture-tunnel",
    workspaceId: null,
    connectorGeneration: 1,
    runtimeGeneration: "a".repeat(64),
    computerGeneration: 1,
    buildId: "3".repeat(64),
    challengeSha256: "b".repeat(64),
    receiptSha256: "c".repeat(64),
    verifiedAt: "2026-10-02T20:00:00.000Z",
  };
  vi.mocked(f.api.bootstrap).mockResolvedValue(data);
  const c = new WindowController(f.api);
  await c.start();
  expect(c.getSnapshot().destination).toMatchObject({
    area: "setup",
    setupStep: "overview",
  });
  expect(computerSetup(c.getSnapshot()).ready).toBe(false);
  expect(f.api.configure).not.toHaveBeenCalled();
  c.dispose();
});
describe("F0 window owner", () => {
  it.each([
    { launch: "home", area: "home", page: "general" },
    { launch: "browser", area: "chatgpt", page: "general" },
    { launch: "computer", area: "setup", page: "general" },
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
        ...(launch === "computer" ? { setupStep: "folders" } : {}),
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
          area: "setup",
          page: "general",
          taskId: "newer",
          setupStep: "folders",
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
    c.navigate({ area: "setup", setupStep: "folders" });
    c.navigate({ page: "appearance" });
    c.travel(-1);
    c.overlay("search");
    c.navigate({ area: "setup", setupStep: "folders" });
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
      152,
    );
    c.travel(1);
    expect(c.getSnapshot().destination.page).toBe("appearance");
    c.travel(-1);
    c.travel(-1);
    expect(c.getSnapshot().destination.area).toBe("setup");
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
    c.navigate({ area: "setup", setupStep: "folders" });
    wait.resolve({
      ok: true,
      state: { revision: 1, tasks: [task()] },
      selectedTaskId: "task-1",
    });
    await action;
    expect(c.getSnapshot().destination.area).toBe("setup");
    expect(f.api.task).toHaveBeenCalledTimes(1);
    c.dispose();
  });
  it.each([
    {
      name: "turn reuse",
      tasks: [
        { ...task(), turnId: "replacement-turn", label: "Different work" },
      ],
    },
    { name: "task removal", tasks: [] },
    { name: "task replacement", tasks: [task("replacement-task")] },
  ])(
    "retains admitted Activity metadata after $name while rejecting late obsolete events",
    async (replacement) => {
      const f = fixture();
      const c = new WindowController(f.api);
      await c.start();
      f.emit("tasks", {
        revision: 1,
        tasks: [{ ...task(), label: "Original work" }],
      });
      const identity = {
        ownerId: "private-owner",
        sessionId: "private-session",
        taskId: "task-1",
        turnId: "task-1",
        generation: 1,
        at: 100,
      };
      f.emit("event", {
        ...identity,
        kind: "turn.terminal",
        phase: "outcome_unknown",
        code: "UNKNOWN",
      });
      const admitted = c.getSnapshot().activity[0]!;
      expect(admitted).toEqual({
        id: "task-1:task-1:1:1",
        taskId: "task-1",
        turnId: "task-1",
        generation: 1,
        label: "Original work",
        kind: "turn.terminal",
        at: 100,
        phase: "outcome_unknown",
        operation: null,
        code: "UNKNOWN",
      });
      c.navigate({ area: "activity", activityId: admitted.id });
      f.emit("tasks", { revision: 2, tasks: replacement.tasks });
      expect(c.getSnapshot().activity).toEqual([admitted]);
      expect(c.getSnapshot().activity[0]).toBe(admitted);
      expect(c.getSnapshot().destination.activityId).toBe(admitted.id);
      for (const late of [
        {
          ...identity,
          at: 101,
          kind: "turn.terminal",
          phase: "completed",
          code: "COMPLETED",
        },
        {
          ...identity,
          taskId: "never-admitted",
          turnId: "unknown-turn",
          at: 102,
          kind: "turn.terminal",
          phase: "failed",
          code: "FAILED",
        },
        {
          ...identity,
          at: 103,
          kind: "text.delta",
          sequence: 1,
          text: "private transcript",
        },
      ])
        f.emit("event", late);
      expect(c.getSnapshot().activity).toEqual([admitted]);
      expect(c.getSnapshot().status).toBe("current");
      const metadata = JSON.stringify(c.getSnapshot().activity);
      for (const privateValue of [
        "private-owner",
        "private-session",
        "private transcript",
      ])
        expect(metadata).not.toContain(privateValue);
      expect(f.api.configure).not.toHaveBeenCalled();
      expect(f.api.task).not.toHaveBeenCalled();
      expect(f.api.snapshot).not.toHaveBeenCalled();
      c.dispose();
    },
  );
  it("evicts retained historical Activity only at the existing 256-record bound", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    const emit = (id: string, at: number) =>
      f.emit("event", {
        ownerId: "owner",
        sessionId: id,
        taskId: id,
        turnId: id,
        generation: 1,
        at,
        kind: "turn.terminal",
        phase: "outcome_unknown",
        code: "UNKNOWN",
      });
    f.emit("tasks", { revision: 1, tasks: [task()] });
    for (let at = 0; at < 4; at++) emit("task-1", at);
    const historical = c.getSnapshot().activity;
    f.emit("tasks", { revision: 2, tasks: [] });
    expect(c.getSnapshot().activity).toEqual(historical);
    f.emit("tasks", { revision: 3, tasks: [task("current-task")] });
    for (let index = 0; index < 300; index++)
      emit("current-task", 1000 + index);
    const retained = c.getSnapshot().activity;
    expect(retained).toHaveLength(256);
    expect(retained[0]?.at).toBe(1044);
    expect(retained.at(-1)?.at).toBe(1299);
    expect(retained.every((event) => event.taskId === "current-task")).toBe(
      true,
    );
    expect(new Set(retained.map((event) => event.id)).size).toBe(256);
    expect(f.api.configure).not.toHaveBeenCalled();
    expect(f.api.task).not.toHaveBeenCalled();
    c.dispose();
  });
  it("keeps bootstrap Activity filtering bound to the final admitted task and turn", async () => {
    const f = fixture();
    const wait = deferred<unknown>();
    vi.mocked(f.api.bootstrap).mockReturnValueOnce(wait.promise);
    const c = new WindowController(f.api);
    const started = c.start();
    const identity = {
      ownerId: "owner",
      sessionId: "task-1",
      taskId: "task-1",
      generation: 1,
      kind: "turn.terminal",
      phase: "outcome_unknown",
      code: "UNKNOWN",
    };
    f.emit("event", { ...identity, turnId: "obsolete-turn", at: 1 });
    const current = {
      ...task(),
      turnId: "current-turn",
      label: "Current work",
    };
    f.emit("tasks", { revision: 1, tasks: [current] });
    f.emit("event", { ...identity, turnId: current.turnId, at: 2 });
    wait.resolve({ ...bootstrap(), taskRevision: 1, tasks: [current] });
    await started;
    expect(c.getSnapshot().status).toBe("current");
    expect(c.getSnapshot().activity).toHaveLength(1);
    expect(c.getSnapshot().activity[0]).toMatchObject({
      taskId: current.taskId,
      turnId: current.turnId,
      label: "Task",
      at: 2,
    });
    expect(f.api.configure).not.toHaveBeenCalled();
    expect(f.api.task).not.toHaveBeenCalled();
    c.dispose();
  });
  it("R05 excludes transcript text and newly arriving obsolete task activity", async () => {
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
    const admitted = c.getSnapshot().activity;
    expect(JSON.stringify(c.getSnapshot())).not.toContain("private body");
    f.emit("tasks", { revision: 2, tasks: [] });
    // The selected design retains admitted metadata; obsolete arrivals stay ignored.
    expect(c.getSnapshot().activity).toEqual(admitted);
    f.emit("event", {
      ...identity,
      at: 101,
      kind: "turn.terminal",
      phase: "completed",
      code: "COMPLETED",
    });
    expect(c.getSnapshot().activity).toEqual(admitted);
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
      expected: {
        area: "setup",
        page: "general",
        setupStep: "folders",
        taskId: "",
      },
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
    {
      section: "computer",
      area: "setup",
      page: "general",
      setupStep: "folders",
    },
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
    expect(c.getSnapshot().destination.area).toBe("setup");
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
  it("R35 removed or unrecognized nonempty task targets are never adopted or retried", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    f.emit("tasks", { revision: 1, tasks: [task()] });
    c.navigate({ area: "chatgpt", taskId: "task-1" });
    const state = c.getSnapshot();
    f.emit("action", sectionIntent("browser", 1, "removed"));
    f.emit("action", sectionIntent("settings", 2, "unrecognized"));
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
    expect(c.getSnapshot().destination.setupStep).toBe("folders");
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
      area: "setup",
      page: "general",
      taskId: "task-1",
      setupStep: "folders",
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
    c.navigate({ area: "setup", setupStep: "folders" });
    c.navigate({ page: "appearance" });
    c.travel(-1);
    expect(c.getSnapshot().destination.setupStep).toBe("folders");
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
  expect(c.getSnapshot().destination.area).toBe("setup");
  f.emit("action", action);
  await Promise.resolve();
  expect(f.api.bootstrap).toHaveBeenCalledTimes(2);
  f.emit("action", {
    ...action,
    eventId: "22222222-2222-4222-8222-222222222222",
    source: "settings-command",
  });
  expect(c.getSnapshot().destination).toMatchObject({
    area: "setup",
    page: "general",
    setupStep: "connection",
  });
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
  expect(c.getSnapshot().sidebar).toBe("rail");
  c.toggleSidebar(true);
  expect(c.getSnapshot().sidebar).toBe("full");
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
    area: "setup",
    page: "general",
    setupStep: "folders",
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
    c.overlay("unresolved-actions");
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
it("R35 native sidebar actions use the single renderer owner and collapse without compact overlays", async () => {
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
    expect(c.getSnapshot().sidebar).toBe("rail");
    f.emit("layout", {
      section: "browser",
      taskId: "",
      setupOpen: false,
      sidebar: "full",
      overlay: "none",
    });
    expect(c.getSnapshot().sidebar).toBe("rail");
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

// Content-free renderer/IPC doubles only. No native account/provider evidence.
describe("bounded Setup sign-in observation", () => {
  function savedReady() {
    const data = bootstrap();
    const step = data.configuration.settings.setup.chatgpt;
    Object.assign(step, {
      visited: true,
      configured: true,
      reachable: "reachable",
      verified: {
        profile: "chatgpt",
        configRevision: 1,
        workspaceId: null,
        runtimeGeneration: "existing-document",
        buildId: data.build.buildId,
        protocol: "chatgpt-page-readiness/1",
        verifiedAt: "2026-10-09T00:00:00.000Z",
      },
    });
    return data;
  }
  function observationCommand(f: ReturnType<typeof fixture>, index = 0) {
    const raw = vi
      .mocked(f.api.configure)
      .mock.calls.filter(
        ([command]) => command.kind === "chatgpt.observe-sign-in",
      )[index]?.[0];
    const command = ProductConfigurationCommandSchema.parse(raw);
    if (command.kind !== "chatgpt.observe-sign-in")
      throw new Error("Expected observation");
    return command;
  }
  function returned(generation = 1, eventId = crypto.randomUUID()) {
    return {
      action: "sign-in-returned",
      source: "auth-window-closed",
      authWindowGeneration: generation,
      eventId,
    };
  }
  async function pending() {
    const f = fixture();
    const data = savedReady();
    vi.mocked(f.api.bootstrap).mockResolvedValue(data);
    const wait = deferred<unknown>();
    vi.mocked(f.api.configure).mockReturnValue(wait.promise);
    const c = new WindowController(f.api);
    await c.start();
    c.navigate({ area: "setup", setupStep: "signin" });
    return { f, c, wait, data, command: observationCommand(f) };
  }
  it.each(["authenticated", "signed_out", "unknown"] as const)(
    "keeps current %s observation distinct from saved Setup evidence without changing publication or eligibility",
    async (state) => {
      const h = await pending();
      try {
        const before = h.c.getSnapshot();
        const eligible = commandAllowed(before, "chatgpt.open-sign-in");
        h.wait.resolve(
          signInReply(h.command, state, {
            status: "ready",
            settings: settings(99),
          }),
        );
        await Promise.resolve();
        const after = h.c.getSnapshot();
        expect(after.configuration).toBe(before.configuration);
        expect(after.evidence).toBe(before.evidence);
        expect(after.intents).toBe(before.intents);
        expect(commandAllowed(after, "chatgpt.open-sign-in")).toBe(eligible);
        expect(signInPresentation(after).label).toBe(
          state === "authenticated"
            ? "Signed in"
            : state === "signed_out"
              ? "Signed out"
              : "Sign-in not checked",
        );
        expect(setupChecklist(after).entries[0]?.status).toBe(
          state === "signed_out"
            ? "Signed out"
            : state === "authenticated"
              ? "Signed in"
              : "Sign-in not checked",
        );
        expect(after.route).toBe("loading");
      } finally {
        h.c.dispose();
      }
    },
  );
  it("observes only explicit Sign in entry; same entry, subscription/remount, refresh and Settings never resubmit", async () => {
    const f = fixture();
    vi.mocked(f.api.bootstrap).mockResolvedValue(savedReady());
    const c = new WindowController(f.api);
    try {
      await c.start();
      c.navigate({ area: "setup", setupStep: "overview" });
      c.navigate({ area: "setup", setupStep: "folders" });
      c.navigate({ area: "setup", setupStep: "connection" });
      await c.refresh();
      expect(f.api.configure).not.toHaveBeenCalled();
      c.navigate({ area: "setup", setupStep: "signin" });
      c.navigate({ area: "setup", setupStep: "signin" });
      const off = c.subscribe(() => {});
      off();
      c.subscribe(() => {})();
      await c.refresh();
      expect(f.api.configure).toHaveBeenCalledTimes(1);
      expect(observationCommand(f).observationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      c.navigate({ area: "setup", setupStep: "overview" });
      expect(c.getSnapshot().signInObservation?.state).toBe("unknown");
      c.travel(-1);
      expect(f.api.configure).toHaveBeenCalledTimes(2);
    } finally {
      c.dispose();
    }
  });
  it.each([
    "lost",
    "malformed",
    "wrong-id",
    "wrong-build",
    "missing-binding",
    "negative-document",
    "zero-sequence",
    "extra-content",
    "refused",
  ])(
    "keeps %s observation honest and separate from effect receipts",
    async (failure) => {
      const h = await pending();
      try {
        const before = h.c.getSnapshot();
        const response = signInReply(h.command, "authenticated");
        if (failure === "lost") h.wait.reject(new Error("private read error"));
        else {
          if (failure === "wrong-id")
            response.evidence.observationId = crypto.randomUUID();
          if (failure === "wrong-build")
            response.evidence.buildId = "a".repeat(64);
          if (failure === "missing-binding") response.evidence.binding = null;
          if (failure === "negative-document")
            response.evidence.binding!.documentGeneration = -1;
          if (failure === "zero-sequence")
            response.evidence.binding!.sequence = 0;
          if (failure === "extra-content")
            Object.assign(response.evidence, { text: "excluded" });
          h.wait.resolve(
            failure === "malformed"
              ? {}
              : failure === "refused"
                ? {
                    ok: false,
                    error: "CHATGPT_PAGE_UNREACHABLE",
                    snapshot: response.snapshot,
                  }
                : response,
          );
        }
        await Promise.resolve();
        expect(h.c.getSnapshot().signInObservation).toMatchObject({
          pending: false,
          state: "unknown",
          binding: null,
        });
        expect(h.c.getSnapshot().intents).toBe(before.intents);
        expect(h.c.getSnapshot().configuration).toBe(before.configuration);
        expect(JSON.stringify(h.c.getSnapshot())).not.toContain(
          "private read error",
        );
      } finally {
        h.c.dispose();
      }
    },
  );
  it.each([2_600, 2_601, 0, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a sign-in reply at monotonic time %s before an overdue timer callback runs",
    async (now) => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(100);
      const h = await pending();
      try {
        clock.mockReturnValue(now);
        h.wait.resolve(signInReply(h.command, "authenticated"));
        await Promise.resolve();
        expect(h.c.getSnapshot().signInObservation).toMatchObject({
          pending: false,
          state: "unknown",
          binding: null,
        });
        expect(signInPresentation(h.c.getSnapshot()).signedIn).toBe(false);
        expect(h.f.api.configure).toHaveBeenCalledTimes(1);
      } finally {
        h.c.dispose();
        clock.mockRestore();
      }
    },
  );
  it("expires a lost read and ignores its late authenticated result without retry", async () => {
    vi.useFakeTimers();
    const h = await pending();
    try {
      await vi.advanceTimersByTimeAsync(2_500);
      const unknown = h.c.getSnapshot().signInObservation;
      expect(unknown).toMatchObject({ pending: false, state: "unknown" });
      h.wait.resolve(signInReply(h.command, "authenticated"));
      await Promise.resolve();
      expect(h.c.getSnapshot().signInObservation).toBe(unknown);
      await h.c.refresh();
      h.c.navigate({ area: "setup", setupStep: "signin" });
      expect(h.c.getSnapshot().signInObservation).toBe(unknown);
      expect(h.f.api.configure).toHaveBeenCalledTimes(1);
    } finally {
      h.c.dispose();
      vi.useRealTimers();
    }
  });
  it.each([
    "navigation",
    "route",
    "document",
    "runtime",
    "malformed-runtime",
    "stale",
    "incarnation",
    "applying",
    "dispose",
  ])(
    "invalidates pending reads on %s and ignores late delivery",
    async (reason) => {
      const h = await pending();
      try {
        if (reason === "navigation")
          h.c.navigate({ area: "setup", setupStep: "folders" });
        if (reason === "route") h.f.emit("route", { state: "loaded" });
        if (reason === "document") h.f.emit("route", { state: "loading" });
        if (reason === "runtime")
          h.f.emit("runtime", {
            state: "ready",
            identity: "new",
            error: null,
            embeddedNode: null,
            embeddedElectron: null,
          });
        if (reason === "malformed-runtime") h.f.emit("runtime", {});
        if (reason === "stale") h.f.emit("tasks", {});
        if (reason === "applying")
          h.f.emit("update", { phase: "applying", version: "1.0" });
        if (reason === "incarnation") {
          vi.mocked(h.f.api.bootstrap).mockResolvedValue({
            ...h.data,
            chatHistoryContext: {
              profileId: "profile",
              backendGeneration: "new",
            },
          });
          await h.c.refresh();
        }
        if (reason === "dispose") h.c.dispose();
        const after = h.c.getSnapshot();
        h.wait.resolve(signInReply(h.command, "authenticated"));
        await Promise.resolve();
        if (reason === "route") {
          const newer = h.c.getSnapshot().signInObservation;
          expect(newer?.observationId).not.toBe(h.command.observationId);
          expect(newer?.state).toBe("unknown"); // The crossed old reply cannot answer the fresh read.
          expect(h.f.api.configure).toHaveBeenCalledTimes(2);
        } else {
          expect(h.c.getSnapshot()).toBe(after);
          expect(after.signInObservation).toBeNull();
          expect(h.f.api.configure).toHaveBeenCalledTimes(1);
        }
        expect(signInPresentation(h.c.getSnapshot()).signedIn).toBe(false);
      } finally {
        h.c.dispose();
      }
    },
  );
  it("ignores a crossed late reply from an earlier entry after a newer entry has won", async () => {
    const h = await pending();
    try {
      h.c.navigate({ area: "setup", setupStep: "folders" });
      vi.mocked(h.f.api.configure).mockImplementation(async (command) =>
        command.kind === "chatgpt.observe-sign-in"
          ? signInReply(command, "signed_out")
          : {},
      );
      h.c.navigate({ area: "setup", setupStep: "signin" });
      await Promise.resolve();
      const current = h.c.getSnapshot().signInObservation;
      expect(current?.state).toBe("signed_out");
      expect(current?.observationId).not.toBe(h.command.observationId);
      h.wait.resolve(signInReply(h.command, "authenticated"));
      await Promise.resolve();
      expect(h.c.getSnapshot().signInObservation).toBe(current);
    } finally {
      h.c.dispose();
    }
  });
  it("native returned event observes once without navigation and dedupes event/generation while refresh wins publication", async () => {
    const h = await pending();
    try {
      const second = deferred<unknown>();
      vi.mocked(h.f.api.configure).mockReturnValue(second.promise);
      const destination = h.c.getSnapshot().destination;
      const event = returned();
      h.f.emit("action", event);
      h.f.emit("action", event);
      h.f.emit("action", returned(1));
      h.f.emit("action", returned(0));
      expect(h.c.getSnapshot().destination).toBe(destination);
      expect(h.f.api.configure).toHaveBeenCalledTimes(2);
      const command = observationCommand(h.f, 1);
      vi.mocked(h.f.api.bootstrap).mockResolvedValue({
        ...h.data,
        configuration: { status: "ready", settings: settings(10) },
      });
      await h.c.refresh();
      const publication = h.c.getSnapshot().configuration;
      second.resolve(signInReply(command, "signed_out"));
      h.wait.resolve(signInReply(h.command, "authenticated"));
      await Promise.resolve();
      expect(h.c.getSnapshot().configuration).toBe(publication);
      expect(h.c.getSnapshot().signInObservation?.state).toBe("signed_out");
      expect(h.c.getSnapshot().intents).toEqual({});
      h.c.navigate({ area: "setup", setupStep: "connection" });
      h.f.emit("action", returned(2));
      expect(h.f.api.configure).toHaveBeenCalledTimes(2);
    } finally {
      h.c.dispose();
    }
  });
  it.each(["pending", "unknown"] as const)(
    "safe observation never settles original shared writer %s",
    async (state) => {
      const f = fixture();
      const wait = deferred<unknown>();
      vi.mocked(f.api.configure).mockReturnValueOnce(wait.promise);
      const c = new WindowController(f.api);
      try {
        await c.start();
        const result = c.configure(
          { kind: "chatgpt.open-sign-in" },
          "settings:chatgpt.open-sign-in:",
        );
        await Promise.resolve();
        await Promise.resolve();
        if (state === "unknown") {
          wait.reject(new Error("reply lost"));
          await result;
        }
        const original =
          c.getSnapshot().intents["settings:chatgpt.open-sign-in:"];
        expect(original?.state).toBe(state);
        vi.mocked(f.api.configure).mockImplementation(async (command) =>
          command.kind === "chatgpt.observe-sign-in"
            ? signInReply(command, "authenticated")
            : {},
        );
        c.navigate({ area: "setup", setupStep: "signin" });
        await Promise.resolve();
        expect(c.getSnapshot().signInObservation?.state).toBe("authenticated");
        expect(c.getSnapshot().intents[original!.id]).toBe(original);
        f.emit("route", { state: "loaded" });
        await Promise.resolve();
        expect(c.getSnapshot().intents[original!.id]).toBe(original);
        expect(signInPresentation(c.getSnapshot()).signedIn).toBe(false);
        expect(commandAllowed(c.getSnapshot(), "chatgpt.open-sign-in")).toBe(
          false,
        );
        expect(signInPresentation(c.getSnapshot()).signedIn).toBe(false);
        if (state === "pending") {
          wait.resolve({
            ok: false,
            error: "CHATGPT_PAGE_UNREACHABLE",
            snapshot: bootstrap().configuration,
          });
          await result;
        }
      } finally {
        c.dispose();
      }
    },
  );
  it("withdraws authenticated presentation after document loss and saved-ready refresh cannot promote it", async () => {
    const f = fixture();
    vi.mocked(f.api.bootstrap).mockResolvedValue(savedReady());
    vi.mocked(f.api.configure).mockImplementation(async (command) =>
      command.kind === "chatgpt.observe-sign-in"
        ? signInReply(command, "authenticated")
        : {},
    );
    const c = new WindowController(f.api);
    try {
      await c.start();
      c.navigate({ area: "setup", setupStep: "signin" });
      await Promise.resolve();
      expect(signInPresentation(c.getSnapshot()).signedIn).toBe(true);
      f.emit("route", { state: "loading" });
      expect(c.getSnapshot().route).toBe("loading");
      expect(signInPresentation(c.getSnapshot()).signedIn).toBe(false);
      await c.refresh();
      expect(c.getSnapshot().configuration?.status).toBe("ready");
      expect(signInPresentation(c.getSnapshot()).label).toBe(
        "Sign-in not checked",
      );
      expect(f.api.configure).toHaveBeenCalledTimes(1);
    } finally {
      c.dispose();
    }
  });
  it("ignores uncorrelated returns and prevents observation from entering effect dispatch", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    try {
      await c.start();
      c.navigate({ area: "setup", setupStep: "signin" });
      await Promise.resolve();
      vi.mocked(f.api.configure).mockClear();
      const before = c.getSnapshot();
      for (const event of [
        { ...returned(), eventId: "invalid" },
        { ...returned(), authWindowGeneration: null },
        { ...returned(), source: "verification-completed" },
        { ...returned(), authWindowGeneration: -1 },
        { ...returned(), extra: true },
      ])
        f.emit("action", event);
      await c.refresh();
      expect(f.api.configure).not.toHaveBeenCalled();
      const result = await c.configure(
        {
          kind: "chatgpt.observe-sign-in",
          observationId: crypto.randomUUID(),
          buildId: "3".repeat(64),
        },
        "effect-attempt",
      );
      expect(result.state).toBe("refused");
      expect(c.getSnapshot().intents).toBe(before.intents);
      expect(f.api.configure).not.toHaveBeenCalled();
    } finally {
      c.dispose();
    }
  });
  it("build mismatch and failed general reads withdraw a pending observation without effect UNKNOWN", async () => {
    for (const failure of ["build", "read"] as const) {
      const h = await pending();
      try {
        if (failure === "read")
          vi.mocked(h.f.api.bootstrap).mockRejectedValue(
            new Error("read lost"),
          );
        else
          vi.mocked(h.f.api.bootstrap).mockResolvedValue({
            ...h.data,
            build: { ...h.data.build, buildId: "a".repeat(64) },
          });
        await h.c.refresh();
        expect(h.c.getSnapshot().status).toBe(
          failure === "build" ? "incompatible" : "stale",
        );
        const snapshot = h.c.getSnapshot();
        h.wait.resolve(signInReply(h.command, "authenticated"));
        await Promise.resolve();
        expect(h.c.getSnapshot()).toBe(snapshot);
        expect(snapshot.signInObservation).toBeNull();
        expect(snapshot.intents).toEqual({});
      } finally {
        h.c.dispose();
      }
    }
  });
  it.each(["authenticated", "signed_out", "unknown"] as const)(
    "retains settled %s across navigation and rereads unconfirmed sign-in on explicit entry",
    async (state) => {
      const h = await pending();
      try {
        h.wait.resolve(signInReply(h.command, state));
        await Promise.resolve();
        const sample = h.c.getSnapshot().signInObservation;
        const label = signInPresentation(h.c.getSnapshot()).label;
        h.c.navigate({ area: "setup", setupStep: "folders" });
        h.c.navigate({ area: "setup", setupStep: "overview" });
        expect(h.c.getSnapshot().signInObservation).toBe(sample);
        expect(setupChecklist(h.c.getSnapshot()).entries[0]?.status).toBe(
          state === "signed_out"
            ? "Signed out"
            : state === "authenticated"
              ? "Signed in"
              : "Sign-in not checked",
        );
        h.c.navigate({ area: "setup", setupStep: "connection" });
        expect(h.c.getSnapshot().signInObservation).toBe(sample);
        expect(signInPresentation(h.c.getSnapshot()).label).toBe(label);
        await h.c.refresh();
        expect(h.c.getSnapshot().signInObservation).toBe(sample);
        expect(h.f.api.configure).toHaveBeenCalledTimes(1);
        vi.mocked(h.f.api.configure).mockImplementation(async (command) =>
          command.kind === "chatgpt.observe-sign-in"
            ? signInReply(command, "signed_out")
            : {},
        );
        h.c.navigate({ area: "setup", setupStep: "signin" });
        await Promise.resolve();
        if (state === "authenticated") {
          expect(h.f.api.configure).toHaveBeenCalledTimes(1);
          expect(h.c.getSnapshot().signInObservation).toBe(sample);
          expect(signInPresentation(h.c.getSnapshot()).signedIn).toBe(true);
        } else {
          expect(h.f.api.configure).toHaveBeenCalledTimes(2);
          expect(h.c.getSnapshot().signInObservation?.observationId).not.toBe(
            sample?.observationId,
          );
          expect(signInPresentation(h.c.getSnapshot()).signedIn).toBe(false);
        }
      } finally {
        h.c.dispose();
      }
    },
  );
});

describe("request-owned native workspace readback", () => {
  // Parsed adapter fixtures only; no native host or filesystem qualification.
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const buildId = "3".repeat(64);
  const issuedCheckId = "44444444-4444-4444-8444-444444444444";
  const priorCheckId = "55555555-5555-4555-8555-555555555555";
  function workspace(checked = false, checkId = issuedCheckId) {
    const value = settings();
    value.computer.workspaces = [
      {
        workspaceId,
        root: "/approved/project",
        label: "Project",
        access: "write",
        excludedPaths: [],
        rootIdentity: { device: "1", inode: "2" },
      },
    ];
    if (checked) {
      value.computer.workspaces[0]!.accessCheck = {
        checkId,
        rootIdentity: { device: "1", inode: "2" },
        buildId,
        computerGeneration: value.computer.generation,
        verifiedAt: "2026-10-02T20:00:00.000Z",
      };
      value.setup.computer.reachable = "reachable";
      value.setup.computer.verified = {
        profile: "farol",
        configRevision: value.computer.generation,
        workspaceId,
        runtimeGeneration: "a".repeat(64),
        buildId,
        protocol: "secure-mcp",
        verifiedAt: "2026-10-02T20:00:00.000Z",
      };
    }
    return value;
  }
  it.each([
    "superseded",
    "disposed",
    "malformed",
    "transport-unknown",
  ] as const)("does not qualify a %s native read", async (reason) => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    const late = deferred<unknown>();
    vi.mocked(f.api.bootstrap).mockReturnValueOnce(late.promise);
    const read = c.refreshReadback();
    if (reason === "superseded") await c.refresh();
    if (reason === "disposed") c.dispose();
    if (reason === "transport-unknown") late.reject(new Error("reply lost"));
    else late.resolve(reason === "malformed" ? {} : bootstrap());
    expect(await read).toEqual({ status: "unqualified", reason });
    c.dispose();
  });
  it.each([
    "matching",
    "unchanged-prior",
    "other-result",
    "reused-id",
    "unidentified",
    "previous-runtime",
    "wrong-target",
    "wrong-build",
    "wrong-generation",
    "wrong-scope",
    "wrong-connection",
    "backend-unknown",
    "forged",
    "late",
    "disposed",
  ] as const)(
    "resolves only an exact check from %s evidence, preserving an unrelated unknown",
    async (condition) => {
      const f = fixture();
      const initial = ["unchanged-prior", "other-result", "reused-id"].includes(
        condition,
      )
        ? workspace(true, priorCheckId)
        : workspace();
      vi.mocked(f.api.bootstrap).mockResolvedValue({
        ...bootstrap(),
        configuration: { status: "ready", settings: initial },
      });
      const c = new WindowController(f.api);
      await c.start();
      const command = {
        kind: "computer.verify-workspace",
        workspaceId,
        ...(condition === "unidentified"
          ? {}
          : {
              checkId: condition === "reused-id" ? priorCheckId : issuedCheckId,
            }),
      } as const;
      const id = `settings:${command.kind}:${workspaceId}`;
      let pending = workspaceReadbackBinding(initial, buildId, command);
      if (condition === "previous-runtime")
        pending = { ...pending, previousRuntimeGeneration: "a".repeat(64) };
      vi.mocked(f.api.configure).mockRejectedValue(new Error("reply lost"));
      const original = await c.configure(command, id);
      const unrelated = await c.configure(
        { kind: "model.rotate-token" },
        "settings:model.rotate-token:",
      );
      const checked = workspace(
        true,
        condition === "unchanged-prior" || condition === "reused-id"
          ? priorCheckId
          : condition === "other-result"
            ? "66666666-6666-4666-8666-666666666666"
            : issuedCheckId,
      );
      if (condition === "wrong-generation") checked.computer.generation++;
      if (condition === "wrong-scope")
        checked.computer.workspaces[0]!.rootIdentity = {
          device: "1",
          inode: "999",
        };
      if (condition === "wrong-connection")
        checked.connectors.secureMcp.generation++;
      if (condition === "backend-unknown")
        checked.setup.computer.outcomeUnknown = true;
      vi.mocked(f.api.bootstrap).mockResolvedValue({
        ...bootstrap(),
        configuration: { status: "ready", settings: checked },
      });
      const receipt = await c.refreshReadback();
      expect(receipt.status).toBe("adopted");
      if (condition === "late") await c.refresh();
      if (condition === "disposed") c.dispose();
      const result = c.reconcileWorkspaceReadback(
        condition === "forged" ? { ...receipt } : receipt,
        id,
        condition === "wrong-target"
          ? {
              ...pending,
              command: {
                ...command,
                workspaceId: "33333333-3333-4333-8333-333333333333",
              },
            }
          : condition === "wrong-build"
            ? { ...pending, buildId: "f".repeat(64) }
            : pending,
      );
      expect(result !== null).toBe(
        condition === "matching" || condition === "previous-runtime",
      );
      expect(c.getSnapshot().intents[unrelated.id]).toBe(unrelated);
      expect(original.state).toBe("unknown");
      if (condition === "matching" || condition === "previous-runtime") {
        expect(result).toMatchObject({
          state: "applied",
          code: "WORKSPACE_READBACK_CONFIRMED",
          workspaceReadback: { originalCode: original.code },
        });
        expect(c.reconcileWorkspaceReadback(receipt, id, pending)).toBeNull();
      } else expect(c.getSnapshot().intents[id]).toBe(original);
      expect(f.api.configure).toHaveBeenCalledTimes(2);
      c.dispose();
    },
  );
  it.each(["computer.verify-workspace", "computer.check-folder"] as const)(
    "retains typed backend write uncertainty for %s despite an exact visible check",
    async (kind) => {
      const f = fixture();
      const initial = workspace();
      vi.mocked(f.api.bootstrap).mockResolvedValue({
        ...bootstrap(),
        configuration: { status: "ready", settings: initial },
      });
      const c = new WindowController(f.api);
      await c.start();
      const command = { kind, workspaceId, checkId: issuedCheckId };
      const id = `settings:${kind}:${workspaceId}`;
      const pending = workspaceReadbackBinding(initial, buildId, command);
      const checked = workspace(true, issuedCheckId);
      expect(checked.setup.computer.outcomeUnknown).toBe(false);
      vi.mocked(f.api.configure).mockResolvedValueOnce({
        ok: false,
        error: "SETTINGS_WRITE_FAILED",
        snapshot: { status: "ready", settings: checked },
      });
      const original = await c.configure(command, id);
      expect(original).toMatchObject({
        state: "unknown",
        code: "SETTINGS_WRITE_FAILED",
      });
      vi.mocked(f.api.bootstrap).mockResolvedValue({
        ...bootstrap(),
        configuration: { status: "ready", settings: checked },
      });
      const receipt = await c.refreshReadback();
      expect(receipt.status).toBe("adopted");
      expect(c.reconcileWorkspaceReadback(receipt, id, pending)).toBeNull();
      expect(c.getSnapshot().intents[id]).toBe(original);
      expect(await c.configure(command, id)).toBe(original);
      expect(f.api.configure).toHaveBeenCalledTimes(1);
      c.dispose();
    },
  );
});

it("samples a newly loaded ChatGPT page while Sign in is open without publishing saved readiness", async () => {
  const f = fixture();
  let reads = 0;
  vi.mocked(f.api.configure).mockImplementation(async (command) => {
    if (command.kind !== "chatgpt.observe-sign-in")
      throw Error("Unexpected writer");
    return signInReply(command, ++reads === 1 ? "unknown" : "authenticated");
  });
  const c = new WindowController(f.api);
  await c.start();
  try {
    const configuration = c.getSnapshot().configuration;
    c.navigate({ area: "setup", setupStep: "signin" });
    await Promise.resolve();
    expect(signInPresentation(c.getSnapshot()).signedIn).toBe(false);
    const first = c.getSnapshot().signInObservation;
    f.emit("route", { state: "loaded" });
    await Promise.resolve();
    expect(signInPresentation(c.getSnapshot()).signedIn).toBe(true);
    expect(c.getSnapshot().signInObservation?.observationId).not.toBe(
      first?.observationId,
    );
    expect(c.getSnapshot().configuration).toBe(configuration);
    expect(c.getSnapshot().intents).toEqual({});
    expect(f.api.task).not.toHaveBeenCalled();
    expect(reads).toBe(2);
  } finally {
    c.dispose();
  }
});
it("new loaded-page observation ignores the previous document's late reply", async () => {
  const f = fixture();
  const older = deferred<unknown>();
  let firstCommand:
    ReturnType<typeof ProductConfigurationCommandSchema.parse> | undefined;
  vi.mocked(f.api.configure).mockImplementation((command) => {
    if (command.kind !== "chatgpt.observe-sign-in")
      throw Error("Unexpected writer");
    if (!firstCommand) {
      firstCommand = command;
      return older.promise;
    }
    return Promise.resolve(signInReply(command, "authenticated"));
  });
  const c = new WindowController(f.api);
  await c.start();
  try {
    c.navigate({ area: "setup", setupStep: "signin" });
    f.emit("route", { state: "loaded" });
    await Promise.resolve();
    expect(signInPresentation(c.getSnapshot()).signedIn).toBe(true);
    const fresh = c.getSnapshot().signInObservation;
    if (!firstCommand || firstCommand.kind !== "chatgpt.observe-sign-in")
      throw Error("Missing original read");
    older.resolve(signInReply(firstCommand, "signed_out"));
    await Promise.resolve();
    expect(c.getSnapshot().signInObservation).toBe(fresh);
    expect(signInPresentation(c.getSnapshot()).signedIn).toBe(true);
    expect(c.getSnapshot().intents).toEqual({});
  } finally {
    c.dispose();
  }
});
it("an ordinary unobserved sign-in has a neutral checklist marker, unlike an unknown effect", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  try {
    expect(setupChecklist(c.getSnapshot()).entries[0]?.state).toBe("needed");
    expect(setupChecklist(c.getSnapshot()).entries[0]?.status).toBe(
      "Sign-in not checked",
    );
    f.emit("route", { state: "loaded" });
    expect(f.api.configure).not.toHaveBeenCalled();
    expect(c.getSnapshot().signInObservation).toBeNull();
  } finally {
    c.dispose();
  }
});

// Shell/transport doubles only; native geometry and provider login are root gates.
describe("Setup sign-in browser continuity", () => {
  it("presents ChatGPT before transport and only explicitly returns to the saved Sign in step", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    c.navigate({ area: "setup", setupStep: "signin" });
    const saved = c.getSnapshot().destination;
    const waiting = deferred<unknown>();
    const entered = deferred<void>();
    vi.mocked(f.api.configure).mockImplementation((command) => {
      if (command.kind === "chatgpt.open-sign-in") {
        entered.resolve();
        return waiting.promise;
      }
      return Promise.resolve({ ok: true, snapshot: bootstrap().configuration });
    });
    const opening = c.configure(
      { kind: "chatgpt.open-sign-in" },
      "settings:chatgpt.open-sign-in:",
    );
    await entered.promise;
    expect(c.getSnapshot().destination.area).toBe("chatgpt");
    expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.[0]).toBe("browser");
    expect(c.getSnapshot().setupSignInReturn).toEqual(saved);
    const destination = c.getSnapshot().destination;
    for (const state of ["loading", "loaded", "failed"] as const) {
      f.emit("route", { state });
      f.emit("action", {
        action: "sign-in-returned",
        source: "auth-window-closed",
        authWindowGeneration: 1,
        eventId: crypto.randomUUID(),
      });
      await c.refresh();
      expect(c.getSnapshot().destination).toBe(destination);
      expect(c.getSnapshot().setupSignInCheck).toBeFalsy();
    }
    c.navigate({ area: "activity" });
    waiting.resolve({ ok: true, snapshot: bootstrap().configuration });
    await opening;
    expect(c.getSnapshot().destination.area).toBe("activity");
    c.navigate({ area: "chatgpt" });
    c.returnToSetup();
    await vi.waitFor(() =>
      expect(f.api.configure).toHaveBeenCalledWith({
        kind: "chatgpt.sign-in-return",
      }),
    );
    expect(c.getSnapshot().destination).toEqual(saved);
    expect(c.getSnapshot().setupSignInReturn).toBeNull();
    f.emit("action", {
      action: "sign-in-returned",
      source: "sign-in-return-command",
      authWindowGeneration: 1,
      eventId: crypto.randomUUID(),
    });
    expect(c.getSnapshot().destination).toEqual(saved);
    expect(
      vi
        .mocked(f.api.configure)
        .mock.calls.filter(
          ([command]) => command.kind === "chatgpt.open-sign-in",
        ),
    ).toHaveLength(1);
    expect(
      vi
        .mocked(f.api.configure)
        .mock.calls.filter(
          ([command]) => command.kind === "chatgpt.sign-in-return",
        ),
    ).toHaveLength(1);
    expect(f.api.task).not.toHaveBeenCalled();
    c.dispose();
  });
});

it.each(["chatgpt.open-sign-in", "chatgpt.open-browser"] as const)(
  "%s from Sign in retains its own context without late navigation or effect replay",
  async (kind) => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    c.navigate({ area: "setup", setupStep: "signin" });
    const saved = c.getSnapshot().destination;
    const waiting = deferred<unknown>();
    vi.mocked(f.api.configure).mockImplementation((command) =>
      command.kind === kind
        ? waiting.promise
        : Promise.resolve({ ok: true, snapshot: bootstrap().configuration }),
    );
    const opening = c.configure({ kind }, `settings:${kind}:`);
    // Explicit navigation while the command digest is pending must win.
    c.navigate({ area: "activity" });
    await vi.waitFor(() =>
      expect(f.api.configure).toHaveBeenCalledWith({ kind }),
    );
    expect(c.getSnapshot().destination.area).toBe("activity");
    waiting.reject(new Error("fixture lost reply"));
    expect((await opening).state).toBe("unknown");
    const latch = c.getSnapshot().intents[`settings:${kind}:`];
    expect(c.getSnapshot().setupSignInReturn).toEqual(saved);
    c.navigate({ area: "chatgpt" });
    f.emit("runtime", {
      state: "offline",
      error: null,
      identity: null,
      embeddedNode: null,
      embeddedElectron: null,
    });
    c.returnToSetup();
    expect(c.getSnapshot().destination).toEqual(saved);
    expect(c.getSnapshot().intents[`settings:${kind}:`]).toBe(latch);
    expect(c.getSnapshot().setupSignInCheck).toBeFalsy();
    await c.refresh();
    expect(
      vi
        .mocked(f.api.configure)
        .mock.calls.filter(([command]) => command.kind === kind),
    ).toHaveLength(1);
    c.dispose();
  },
);

// A retained task is not the home/sign-in document even when both share a rail.
it.each(["chatgpt.open-sign-in", "chatgpt.open-browser"] as const)(
  "%s explicitly selects the home document while retaining task return context",
  async (kind) => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    f.emit("tasks", { revision: 1, tasks: [task("retained")] });
    c.navigate({ area: "chatgpt", taskId: "retained" });
    c.navigate({ area: "setup", setupStep: "signin" });
    const previous = c.getSnapshot().destination;
    await c.configure({ kind }, `settings:${kind}:`);
    expect(c.getSnapshot().destination).toMatchObject({
      area: "chatgpt",
      taskId: "",
    });
    expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "browser",
      "",
    ]);
    expect(c.getSnapshot().setupSignInReturn).toEqual(previous);
    c.returnToSetup();
    expect(c.getSnapshot().destination).toEqual(previous);
    c.navigate({ area: "chatgpt", taskId: "retained" });
    expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "browser",
      "retained",
    ]);
    c.dispose();
  },
);

it.each(["chatgpt.open-sign-in", "chatgpt.open-browser"] as const)(
  "%s keeps native section shortcuts usable with a home document and retained tasks",
  async (kind) => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    f.emit("tasks", { revision: 1, tasks: [task("retained")] });
    c.navigate({ area: "setup", setupStep: "signin" });
    await c.configure({ kind }, `settings:${kind}:`);
    expect(c.getSnapshot().destination.taskId).toBe("");
    const targets = [
      ["activity", "activity"],
      ["settings", "settings"],
      ["computer", "setup"],
      ["browser", "chatgpt"],
    ];
    for (const [index, [section, area]] of targets.entries()) {
      const count = vi.mocked(f.api.layout).mock.calls.length;
      f.emit("action", sectionIntent(section, index + 1, ""));
      expect(c.getSnapshot().destination).toMatchObject({ area, taskId: "" });
      expect(f.api.layout).toHaveBeenCalledTimes(count + 1);
    }
    const selected = c.getSnapshot().destination;
    f.emit("action", sectionIntent("activity", 5, "unrecognized"));
    expect(c.getSnapshot().destination).toBe(selected);
    expect(f.api.task).not.toHaveBeenCalled();
    c.dispose();
  },
);

// Source/transport regressions only; these do not exercise an owner session.
describe("retained browser independent of Computer readiness", () => {
  it.each(["starting", "offline", "failed"] as const)(
    "explicitly presents once while the Mac runtime is %s without publishing readiness",
    async (runtime) => {
      const f = fixture();
      const c = new WindowController(f.api);
      await c.start();
      f.emit("runtime", {
        state: runtime,
        error: null,
        identity: null,
        embeddedNode: null,
        embeddedElectron: null,
      });
      const before = c.getSnapshot();
      // A newer Settings snapshot in the transport must not gain publication.
      vi.mocked(f.api.configure).mockResolvedValue({
        ok: true,
        snapshot: { status: "ready", settings: settings(99) },
      });
      c.navigate({ area: "chatgpt" });
      await c.configure({ kind: "chatgpt.present-browser" }, "another-label");
      const after = c.getSnapshot();
      expect(after.configuration).toBe(before.configuration);
      expect(after.runtime).toBe(runtime);
      expect(after.status).toBe(before.status);
      expect(after.setupSignInCheck).toBeFalsy();
      expect(after.signInObservation).toBeFalsy();
      expect(after.route).toBe("loading");
      expect(commandAllowed(after, "connector.start")).toBe(false);
      expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.slice(0, 3)).toEqual([
        "browser",
        "",
        false,
      ]);
      c.navigate({ area: "home" });
      c.travel(-1);
      c.travel(1);
      await c.refresh();
      expect(f.api.configure).toHaveBeenCalledExactlyOnceWith({
        kind: "chatgpt.present-browser",
      });
      expect(f.api.task).not.toHaveBeenCalled();
      c.dispose();
    },
  );

  it.each(["chatgpt.open-browser", "chatgpt.open-sign-in"] as const)(
    "an applied %s receipt cannot permanently veto later browser presentation",
    async (kind) => {
      const f = fixture();
      const c = new WindowController(f.api);
      await c.start();
      c.navigate({ area: "setup", setupStep: "signin" });
      const saved = c.getSnapshot().destination;
      await c.configure({ kind }, `settings:${kind}:`);
      f.emit("runtime", {
        state: "offline",
        error: null,
        identity: null,
        embeddedNode: null,
        embeddedElectron: null,
      });
      const configuration = c.getSnapshot().configuration;
      c.navigate({ area: "home" });
      c.navigate({ area: "chatgpt" });
      await c.configure(
        { kind: "chatgpt.present-browser" },
        "settings:chatgpt.present-browser:",
      );
      expect(
        vi.mocked(f.api.configure).mock.calls.map(([command]) => command.kind),
      ).toEqual(["chatgpt.observe-sign-in", kind, "chatgpt.present-browser"]);
      expect(c.getSnapshot().configuration).toBe(configuration);
      expect(c.getSnapshot().setupSignInCheck).toBeFalsy();
      c.returnToSetup();
      expect(c.getSnapshot().destination).toEqual(saved);
      expect(f.api.task).not.toHaveBeenCalled();
      c.dispose();
    },
  );

  it("keeps an unknown shared write and its permission fences while presenting the browser", async () => {
    const f = fixture();
    const c = new WindowController(f.api);
    await c.start();
    vi.mocked(f.api.configure).mockRejectedValueOnce(
      new Error("lost acknowledgement"),
    );
    const original = await c.configure(
      { kind: "computer.rename", name: "This Mac" },
      "settings:computer.rename:",
    );
    expect(original.state).toBe("unknown");
    expect(commandAllowed(c.getSnapshot(), "connector.start")).toBe(false);
    expect(commandAllowed(c.getSnapshot(), "chatgpt.present-browser")).toBe(
      true,
    );
    c.navigate({ area: "chatgpt" });
    await c.configure(
      { kind: "chatgpt.present-browser" },
      "settings:chatgpt.present-browser:",
    );
    expect(c.getSnapshot().intents[original.id]).toBe(original);
    expect(commandAllowed(c.getSnapshot(), "connector.start")).toBe(false);
    expect(f.api.configure).toHaveBeenCalledTimes(2);
    expect(f.api.task).not.toHaveBeenCalled();
    c.dispose();
  });
});

it.each(["checking", "reconnecting", "unavailable", "stopped"] as const)(
  "keeps signed-out browser presentation independent of connector %s",
  async (connection) => {
    const f = fixture();
    let observe!: (value: unknown) => void;
    const c = new WindowController({
      ...f.api,
      onConnectionStatus: (listener) => {
        observe = listener;
        return () => {};
      },
    });
    await c.start();
    observe({
      revision: 1,
      state: connection,
      marker: "?",
      label: "Connection not confirmed",
      detail: "Fixture only",
      delivery: "Unconfirmed",
      attention: true,
      validUntilMillis: null,
    });
    c.navigate({ area: "chatgpt" });
    await c.configure(
      { kind: "chatgpt.present-browser" },
      "settings:chatgpt.present-browser:",
    );
    expect(c.getSnapshot().connectionStatus?.state).toBe(connection);
    expect(c.getSnapshot().setupSignInCheck).toBeFalsy();
    const configuration = c.getSnapshot().configuration;
    expect(
      configuration?.status === "ready" &&
        configuration.settings.setup.chatgpt.verified,
    ).toBeNull();
    expect(vi.mocked(f.api.layout).mock.calls.at(-1)?.slice(0, 3)).toEqual([
      "browser",
      "",
      false,
    ]);
    expect(f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "chatgpt.present-browser",
    });
    expect(f.api.task).not.toHaveBeenCalled();
    c.dispose();
  },
);

it("can present despite a failed Settings read without adopting its reply snapshot", async () => {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    configuration: { status: "error", error: "SETTINGS_READ_FAILED" },
  });
  const c = new WindowController(f.api);
  await c.start();
  const before = c.getSnapshot();
  expect(before.status).toBe("stale");
  c.navigate({ area: "chatgpt" });
  await c.configure(
    { kind: "chatgpt.present-browser" },
    "settings:chatgpt.present-browser:",
  );
  expect(c.getSnapshot().configuration).toBe(before.configuration);
  expect(c.getSnapshot().status).toBe("stale");
  expect(commandAllowed(c.getSnapshot(), "chatgpt.verify")).toBe(false);
  expect((await c.task({ kind: "task.create-chatgpt" }, "new")).state).toBe(
    "refused",
  );
  expect(f.api.task).not.toHaveBeenCalled();
  c.dispose();
});

describe("automatic Setup sign-in after the owner login flow", () => {
  it.each([false, true])(
    "confirms the authenticated page while the owner stays in ChatGPT; uncertain=%s",
    async (uncertain) => {
      const f = fixture();
      const data = bootstrap();
      let authenticated = false;
      let checks = 0;
      vi.mocked(f.api.configure).mockImplementation(async (command) => {
        if (command.kind === "chatgpt.observe-sign-in")
          return signInReply(
            command,
            authenticated ? "authenticated" : "signed_out",
          );
        if (command.kind === "chatgpt.verify") {
          checks++;
          if (uncertain) throw Error("fixture lost verifier reply");
          return {
            ok: true,
            snapshot: { status: "ready", settings: readySettings() },
            evidence: {
              kind: "chatgpt.readiness",
              state: "authenticated",
              code: null,
            },
          };
        }
        return { ok: true, snapshot: data.configuration };
      });
      const c = new WindowController(f.api);
      await c.start();
      try {
        c.navigate({ area: "setup", setupStep: "signin" });
        await c.configure(
          { kind: "chatgpt.open-sign-in" },
          "settings:chatgpt.open-sign-in:",
        );
        expect(c.getSnapshot().destination.area).toBe("chatgpt");
        authenticated = true;
        f.emit("route", { state: "loading" });
        f.emit("route", { state: "loaded" });
        await vi.waitFor(() => expect(checks).toBe(1));
        await vi.waitFor(() =>
          expect(
            c.getSnapshot().intents["settings:chatgpt.verify:"]?.state,
          ).toBe(uncertain ? "unknown" : "applied"),
        );
        expect(c.getSnapshot().destination.area).toBe("chatgpt");
        f.emit("route", { state: "loaded" });
        await vi.waitFor(() =>
          expect(c.getSnapshot().signInObservation?.pending).toBe(false),
        );
        expect(checks).toBe(1);
        expect(f.api.task).not.toHaveBeenCalled();
      } finally {
        c.dispose();
      }
    },
  );
  it.each([false, true])(
    "confirms once and preserves an uncertain verifier: %s",
    async (uncertain) => {
      const f = fixture();
      const data = bootstrap();
      const ready = settings();
      Object.assign(ready.setup.chatgpt, {
        visited: true,
        configured: true,
        reachable: "reachable",
        verified: {
          profile: "chatgpt",
          configRevision: 1,
          workspaceId: null,
          runtimeGeneration: "fixture-session",
          buildId: data.build.buildId,
          protocol: "chatgpt-page-readiness/1",
          verifiedAt: "2026-10-23T00:00:00.000Z",
        },
      });
      let checks = 0;
      vi.mocked(f.api.configure).mockImplementation(async (command) => {
        if (command.kind === "chatgpt.observe-sign-in")
          return signInReply(command, "authenticated");
        if (command.kind === "chatgpt.verify") {
          checks++;
          if (uncertain) throw Error("fixture lost writer reply");
          return {
            ok: true,
            snapshot: { status: "ready", settings: ready },
            evidence: {
              kind: "chatgpt.readiness",
              state: "authenticated",
              code: null,
            },
          };
        }
        return { ok: true, snapshot: data.configuration };
      });
      const c = new WindowController(f.api);
      await c.start();
      try {
        c.navigate({ area: "setup", setupStep: "signin" });
        await c.configure(
          { kind: "chatgpt.open-sign-in" },
          "settings:chatgpt.open-sign-in:",
        );
        f.emit("route", { state: "loaded" });
        c.navigate({ area: "setup", setupStep: "signin" });
        await vi.waitFor(() =>
          expect(
            c.getSnapshot().intents["settings:chatgpt.verify:"]?.state,
          ).toBe(uncertain ? "unknown" : "applied"),
        );
        if (!uncertain)
          await vi.waitFor(() =>
            expect(c.getSnapshot().signInObservation?.pending).toBe(false),
          );
        expect(checks).toBe(1);
        const original = c.getSnapshot().intents["settings:chatgpt.verify:"];
        c.navigate({ area: "setup", setupStep: "folders" });
        c.navigate({ area: "setup", setupStep: "signin" });
        await vi.waitFor(() =>
          expect(c.getSnapshot().signInObservation?.pending).toBe(false),
        );
        expect(checks).toBe(1);
        expect(c.getSnapshot().intents["settings:chatgpt.verify:"]).toBe(
          original,
        );
        expect(setupChecklist(c.getSnapshot()).entries[0]?.state).toBe(
          uncertain ? "unknown" : "verified",
        );
        expect(f.api.task).not.toHaveBeenCalled();
      } finally {
        c.dispose();
      }
    },
  );
});

it("rechecks sign-in after a challenge-scoped connector check outlasts the passive-read budget", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const data = bootstrap();
  data.configuration.settings = readySettings();
  vi.mocked(f.api.bootstrap).mockResolvedValue(data);
  const pending = deferred<unknown>();
  let checking = false;
  let after = false;
  let readsAfter = 0;
  let sends = 0;
  vi.mocked(f.api.configure).mockImplementation(async (command) => {
    if (command.kind === "chatgpt.observe-sign-in") {
      const status =
        checking || (after && ++readsAfter === 1) ? "unknown" : "authenticated";
      const reply = signInReply(command, status, {
        status: "ready",
        settings: data.configuration.settings,
      });
      return {
        ...reply,
        evidence: {
          ...reply.evidence,
          binding: {
            documentGeneration: checking || after ? 2 : 1,
            sequence: 3,
          },
        },
      };
    }
    if (command.kind === "chatgpt.verify")
      return {
        ok: true,
        snapshot: data.configuration,
        evidence: {
          kind: "chatgpt.readiness",
          state: "authenticated",
          code: null,
        },
      };
    if (command.kind === "connector.verify-app") {
      sends++;
      checking = true;
      f.emit("route", { state: "loading" });
      f.emit("route", { state: "loaded" });
      await pending.promise;
      checking = false;
      after = true;
      return { ok: true, snapshot: data.configuration };
    }
    throw Error("unexpected effect");
  });
  const c = new WindowController(f.api);
  try {
    await c.start();
    f.emit("route", { state: "loaded" });
    await vi.advanceTimersByTimeAsync(0);
    const check = c.configure(
      { kind: "connector.verify-app" },
      `settings:connector.verify-app:${"a".repeat(64)}`,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.getSnapshot().signInObservation?.state).toBe("unknown");
    pending.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    await check;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(c.getSnapshot().signInObservation?.state).toBe("authenticated");
    expect(setupChecklist(c.getSnapshot()).entries[0]?.state).toBe("verified");
    expect(readsAfter).toBeGreaterThanOrEqual(2);
    expect(sends).toBe(1);
  } finally {
    c.dispose();
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "reconsiders login after the actual return command settles, retaining unknown=%s",
  async (unknown) => {
    const f = fixture(),
      c = new WindowController(f.api),
      returned = deferred<unknown>();
    const data = bootstrap();
    let checks = 0;
    vi.mocked(f.api.configure).mockImplementation(async (command) => {
      if (command.kind === "chatgpt.observe-sign-in")
        return signInReply(command, "authenticated");
      if (command.kind === "chatgpt.sign-in-return") return returned.promise;
      if (command.kind === "chatgpt.verify") {
        checks++;
        return {
          ok: true,
          snapshot: { status: "ready", settings: readySettings() },
          evidence: {
            kind: "chatgpt.readiness",
            state: "authenticated",
            code: null,
          },
        };
      }
      return { ok: true, snapshot: data.configuration };
    });
    await c.start();
    try {
      c.navigate({ area: "setup", setupStep: "signin" });
      await c.configure(
        { kind: "chatgpt.open-browser" },
        "settings:chatgpt.open-browser:",
      );
      f.emit("route", { state: "loaded" });
      c.returnToSetup();
      await vi.waitFor(() =>
        expect(c.getSnapshot().signInObservation?.state).toBe("authenticated"),
      );
      expect(checks).toBe(0);
      if (unknown) returned.reject(Error("fixture lost return reply"));
      else returned.resolve({ ok: true, snapshot: data.configuration });
      await vi.waitFor(() =>
        expect(
          c.getSnapshot().intents["settings:chatgpt.sign-in-return:"]?.state,
        ).toBe(unknown ? "unknown" : "applied"),
      );
      if (!unknown)
        await vi.waitFor(() =>
          expect(setupChecklist(c.getSnapshot()).entries[0]?.state).toBe(
            "verified",
          ),
        );
      expect(checks).toBe(unknown ? 0 : 1);
      if (unknown)
        expect(commandAllowed(c.getSnapshot(), "chatgpt.verify")).toBe(false);
    } finally {
      c.dispose();
    }
  },
);

it("renews sign-in on the final Setup step after a connector check navigates its browser", async () => {
  const f = fixture();
  let checking = false;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let documentGeneration = 1,
    checks = 0,
    sends = 0,
    attached = false;
  const current = () => ({
    status: "ready" as const,
    settings: readySettings(attached),
  });
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    configuration: current(),
  });
  vi.mocked(f.api.configure).mockImplementation(async (command) => {
    if (command.kind === "chatgpt.observe-sign-in") {
      const reply = signInReply(
        command,
        checking ? "unknown" : "authenticated",
      );
      return {
        ...reply,
        evidence: {
          ...reply.evidence,
          binding: { documentGeneration, sequence: documentGeneration + 1 },
        },
      };
    }
    if (command.kind === "chatgpt.verify") {
      checks++;
      return {
        ok: true,
        snapshot: current(),
        evidence: {
          kind: "chatgpt.readiness",
          state: "authenticated",
          code: null,
        },
      };
    }
    if (command.kind === "connector.verify-app") {
      sends++;
      checking = true;
      documentGeneration++;
      f.emit("route", { state: "loading" });
      f.emit("route", { state: "loaded" });
      await pending;
      checking = false;
      attached = true;
      return { ok: true, snapshot: current() };
    }
    return { ok: true, snapshot: current() };
  });
  const c = new WindowController(f.api);
  await c.start();
  try {
    f.emit("route", { state: "loaded" });
    c.navigate({ area: "setup", setupStep: "signin" });
    await vi.waitFor(() =>
      expect(setupChecklist(c.getSnapshot()).entries[0]?.state).toBe(
        "verified",
      ),
    );
    expect(checks).toBe(1);
    c.navigate({ area: "chatgpt", connectionCheckReturn: true });
    const check = c.configure(
      { kind: "connector.verify-app" },
      "settings:connector.verify-app:",
    );
    c.navigate({ area: "setup", setupStep: "attachment" });
    await vi.waitFor(() => expect(sends).toBe(1));
    await vi.waitFor(() =>
      expect(c.getSnapshot().signInObservation?.state).toBe("unknown"),
    );
    finish();
    await check;
    await vi.waitFor(() =>
      expect(setupChecklist(c.getSnapshot()).ready).toBe(true),
    );
    expect(checks).toBe(2);
    expect(sends).toBe(1);
    expect(c.getSnapshot().destination.setupStep).toBe("attachment");
  } finally {
    c.dispose();
  }
});

it.each([false, true])(
  "rechecks a hydrating session without a click or Send (same build: %s)",
  async (sameBuild) => {
    vi.useFakeTimers();
    const f = fixture();
    const data = bootstrap();
    data.configuration.settings = readySettings();
    if (!sameBuild)
      data.configuration.settings.setup.chatgpt.verified!.buildId = "4".repeat(
        64,
      );
    vi.mocked(f.api.bootstrap).mockResolvedValue(data);
    let observations = 0;
    vi.mocked(f.api.configure).mockImplementation(async (command) => {
      if (command.kind === "chatgpt.observe-sign-in")
        return signInReply(
          command,
          ++observations === 1 ? "unknown" : "authenticated",
          { status: "ready", settings: data.configuration.settings },
        );
      if (command.kind === "chatgpt.verify") {
        const settings = structuredClone(data.configuration.settings);
        settings.revision++;
        settings.setup.chatgpt.verified!.buildId = data.build.buildId;
        return {
          ok: true,
          snapshot: { status: "ready", settings },
          evidence: {
            kind: "chatgpt.readiness",
            state: "authenticated",
            code: null,
          },
        };
      }
      throw Error("unexpected effect");
    });
    const c = new WindowController(f.api);
    try {
      await c.start();
      f.emit("route", { state: "loaded" });
      await vi.advanceTimersByTimeAsync(600);
      expect(c.getSnapshot().setupSignInCheck).toBeTruthy();
      expect(setupChecklist(c.getSnapshot()).entries[0]?.state).toBe(
        "verified",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(
        vi
          .mocked(f.api.configure)
          .mock.calls.filter(([command]) => command.kind === "chatgpt.verify"),
      ).toHaveLength(1);
      expect(
        vi
          .mocked(f.api.configure)
          .mock.calls.some(
            ([command]) => command.kind === "connector.verify-app",
          ),
      ).toBe(false);
    } finally {
      c.dispose();
      vi.useRealTimers();
    }
  },
);

it("recovers browser load state from bootstrap when its event preceded renderer startup", async () => {
  const f = fixture();
  const data = bootstrap();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...data,
    browserRouteState: { state: "loaded" },
  });
  const c = new WindowController(f.api);
  try {
    await c.start();
    expect(c.getSnapshot().route).toBe("loaded");
    expect(c.getSnapshot().setupSignInCheck).toBeFalsy();
    const wait = deferred<unknown>();
    vi.mocked(f.api.bootstrap).mockReturnValue(wait.promise);
    const refresh = c.refresh();
    f.emit("route", { state: "failed" });
    wait.resolve({ ...data, browserRouteState: { state: "loaded" } });
    await refresh;
    expect(c.getSnapshot().route).toBe("failed");
  } finally {
    c.dispose();
  }
});

it("retains a confirmed document across Setup and browser navigation without a new read", async () => {
  const f = fixture();
  const data = bootstrap();
  data.configuration.settings = readySettings();
  vi.mocked(f.api.bootstrap).mockResolvedValue(data);
  vi.mocked(f.api.configure).mockImplementation(async (command) => {
    if (command.kind === "chatgpt.observe-sign-in")
      return signInReply(command, "authenticated", {
        status: "ready",
        settings: data.configuration.settings,
      });
    if (command.kind === "chatgpt.verify")
      return {
        ok: true,
        snapshot: data.configuration,
        evidence: {
          kind: "chatgpt.readiness",
          state: "authenticated",
          code: null,
        },
      };
    throw Error("unexpected effect");
  });
  const c = new WindowController(f.api);
  try {
    await c.start();
    f.emit("route", { state: "loaded" });
    await vi.waitFor(() =>
      expect(setupChecklist(c.getSnapshot()).entries[0]?.state).toBe(
        "verified",
      ),
    );
    const confirmed = c.getSnapshot().signInObservation;
    const calls = vi.mocked(f.api.configure).mock.calls.length;
    for (const setupStep of [
      "overview",
      "folders",
      "connection",
      "attachment",
      "signin",
    ] as const) {
      c.navigate({ area: "setup", setupStep });
      c.navigate({ area: "chatgpt" });
      c.travel(-1);
      c.travel(1);
      expect(c.getSnapshot().signInObservation).toBe(confirmed);
      expect(setupChecklist(c.getSnapshot()).entries[0]?.state).toBe(
        "verified",
      );
    }
    expect(f.api.configure).toHaveBeenCalledTimes(calls);
    expect(f.api.task).not.toHaveBeenCalled();
    // An actual document event still invalidates the old sample.
    f.emit("route", { state: "loading" });
    expect(c.getSnapshot().signInObservation).toBeNull();
    expect(setupChecklist(c.getSnapshot()).entries[0]?.state).not.toBe(
      "verified",
    );
  } finally {
    c.dispose();
  }
});

it.each(["unknown", "signed_out"] as const)(
  "bounds passive hydration reads per document and stops at %s without effects",
  async (answer) => {
    vi.useFakeTimers();
    const f = fixture();
    const data = bootstrap();
    data.configuration.settings = readySettings();
    data.configuration.settings.setup.connect.outcomeUnknown = true;
    data.configuration.settings.connectors.secureMcp.appVerificationPending = true;
    vi.mocked(f.api.bootstrap).mockResolvedValue(data);
    vi.mocked(f.api.configure).mockImplementation(async (command) => {
      if (command.kind === "chatgpt.observe-sign-in")
        return signInReply(command, answer, {
          status: "ready",
          settings: data.configuration.settings,
        });
      throw Error("unexpected effect");
    });
    const c = new WindowController(f.api);
    try {
      await c.start();
      f.emit("route", { state: "loaded" });
      await vi.advanceTimersByTimeAsync(20_000);
      const perDocument = answer === "unknown" ? 4 : 1;
      expect(f.api.configure).toHaveBeenCalledTimes(perDocument);
      const checks = setupChecklist(c.getSnapshot());
      expect(checks.entries[0]?.state).not.toBe("verified");
      expect(checks.entries[1]?.state).toBe("verified");
      expect(checks.entries[2]?.state).toBe("verified");
      expect(checks.entries[3]?.state).not.toBe("verified");
      expect(checks.ready).toBe(false);
      f.emit("route", { state: "loading" });
      f.emit("route", { state: "loaded" });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.api.configure).toHaveBeenCalledTimes(perDocument * 2);
      expect(c.getSnapshot().configuration).toMatchObject({
        settings: { setup: { connect: { outcomeUnknown: true } } },
      });
      expect(f.api.task).not.toHaveBeenCalled();
      c.dispose();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.api.configure).toHaveBeenCalledTimes(perDocument * 2);
    } finally {
      c.dispose();
      vi.useRealTimers();
    }
  },
);

it.each(["runtime-event", "configuration-refresh"] as const)(
  "reconciles a loaded saved session when readiness arrives via %s",
  async (boundary) => {
    const f = fixture();
    const data = {
      ...bootstrap(),
      browserRouteState: { state: "loaded" as const },
    };
    data.configuration.settings = readySettings();
    if (boundary === "configuration-refresh") data.runtimeState = "offline";
    vi.mocked(f.api.bootstrap).mockResolvedValue(data);
    vi.mocked(f.api.configure).mockImplementation(async (command) => {
      if (command.kind === "chatgpt.observe-sign-in")
        return signInReply(command, "authenticated", {
          status: "ready",
          settings: data.configuration.settings,
        });
      if (command.kind === "chatgpt.verify")
        return {
          ok: true,
          snapshot: data.configuration,
          evidence: {
            kind: "chatgpt.readiness",
            state: "authenticated",
            code: null,
          },
        };
      throw Error("unexpected effect");
    });
    const c = new WindowController(f.api);
    try {
      await c.start();
      if (boundary === "runtime-event") {
        await vi.waitFor(() =>
          expect(setupChecklist(c.getSnapshot()).entries[0]?.state).toBe(
            "verified",
          ),
        );
        f.emit("runtime", {
          state: "ready",
          error: null,
          identity: null,
          embeddedNode: null,
          embeddedElectron: null,
        });
      } else {
        vi.mocked(f.api.bootstrap).mockResolvedValue({
          ...data,
          runtimeState: "ready",
        });
        await c.refresh();
      }
      await vi.waitFor(() =>
        expect(setupChecklist(c.getSnapshot()).entries[0]?.state).toBe(
          "verified",
        ),
      );
      expect(c.getSnapshot().destination.area).not.toBe("chatgpt");
      expect(f.api.task).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(f.api.configure)
          .mock.calls.every(([command]) =>
            ["chatgpt.observe-sign-in", "chatgpt.verify"].includes(
              command.kind,
            ),
          ),
      ).toBe(true);
    } finally {
      c.dispose();
    }
  },
);
