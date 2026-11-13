import { expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  ConnectionTestButton,
  runFreshConnectionTest,
  runManualConnectionPrompt,
} from "../../apps/desktop/renderer/connection-test";
import { commandAllowed } from "../../src/ui/renderer/command-eligibility";
import { WindowController } from "../../src/ui/renderer/controller";
import type {
  RendererFacade,
  WindowSnapshot,
} from "../../src/ui/renderer/contract";
import { fixture, deferred } from "./fixture";
import { readySettings } from "./setup-fixture";

// Orchestration only. Fake host replies cannot prove native confirmation/Go Send.
async function setup() {
  const f = fixture(),
    controller = new WindowController(f.api);
  await controller.start();
  const settings = readySettings(true);
  settings.setup.journey.dismissed = true;
  settings.connectors.secureMcp.chatgptApp = {
    name: "Farol",
    tunnelId: settings.connectors.secureMcp.tunnelId!,
    connectorGeneration: settings.connectors.secureMcp.generation,
  };
  let snapshot: WindowSnapshot = {
    ...controller.getSnapshot(),
    configuration: { status: "ready", settings },
  };
  let count = 0;
  const configure = vi.fn<RendererFacade["configure"]>(async (command, id) => {
    if (command.kind === "connector.repair") {
      const next = structuredClone(settings),
        runtime = next.connectors.secureMcp.runtime!;
      runtime.state = "ready";
      runtime.runtimeGeneration = (++count % 2 ? "f" : "a").repeat(64);
      next.connectors.secureMcp.challenge = {
        ...readySettings(false).connectors.secureMcp.challenge!,
        runtimeGeneration: runtime.runtimeGeneration,
      };
      next.connectors.secureMcp.challenge!.challengeSha256 = (
        count % 2 ? "f" : "a"
      ).repeat(64);
      next.connectors.secureMcp.attachment = null;
      next.setup.connect.verified = null;
      snapshot = {
        ...snapshot,
        configuration: { status: "ready", settings: next },
      };
    }
    return { id, state: "applied", code: null };
  });
  const facade = {
    getSnapshot: () => snapshot,
    configure,
    navigate: vi.fn(),
  } as unknown as RendererFacade;
  return {
    facade,
    controller,
    configure,
    settings,
    get snapshot() {
      return snapshot;
    },
    set: (next: WindowSnapshot) => {
      snapshot = next;
    },
    cleanup: () => controller.dispose(),
  };
}
it("routes the toolbar test through one original connection-check command", async () => {
  const h = await setup();
  try {
    h.set({
      ...h.snapshot,
      destination: { ...h.snapshot.destination, area: "chatgpt", taskId: "" },
    });
    expect((await runManualConnectionPrompt(h.facade)).state).toBe("applied");
    expect(h.configure).toHaveBeenCalledTimes(1);
    expect(h.configure.mock.calls[0]![0]).toMatchObject({
      kind: "connector.test-connection",
      taskId: "",
      operationId: expect.any(String),
    });
  } finally {
    h.cleanup();
  }
});
it("does not acknowledge an ambiguous manual send", async () => {
  const h = await setup();
  try {
    h.set({
      ...h.snapshot,
      destination: { ...h.snapshot.destination, area: "chatgpt", taskId: "" },
    });
    h.configure.mockResolvedValue({
      id: "check",
      state: "unknown",
      code: null,
    });
    expect((await runManualConnectionPrompt(h.facade)).state).toBe("unknown");
    expect(h.configure).toHaveBeenCalledTimes(1);
  } finally {
    h.cleanup();
  }
});
it.each([
  [
    "refused",
    "This test was refused before Send because Farol could not confirm all current app, tunnel, runtime and Computer prerequisites. Setup can be complete while a current attachment is missing. Nothing was sent. Check the connection, then try again.",
  ],
  [
    "unknown",
    "Could not confirm that ChatGPT reached this Mac. You can ping again.",
  ],
] as const)(
  "keeps %s visible in the toolbar without repeating the check",
  async (state, message) => {
    const h = await setup();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    h.configure.mockResolvedValue({
      id: "check",
      state,
      code: "CONNECTOR_APP_VERIFICATION_NOT_READY",
    });
    try {
      await act(async () => {
        root.render(
          createElement(ConnectionTestButton, {
            facade: h.facade,
            toolbar: true,
          }),
        );
      });
      await act(async () => {
        await runFreshConnectionTest(h.facade);
      });
      const toolbar = host.querySelector(
        ".connection-test-control[data-toolbar]",
      );
      expect(toolbar?.querySelector('[role="status"]')?.textContent).toBe(
        message,
      );
      expect(
        toolbar?.querySelector('[role="status"]')?.nextElementSibling
          ?.textContent,
      ).toBe("Ping");
      expect(h.configure).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      h.cleanup();
    }
  },
);
it("publishes the toolbar menu through the host presentation owner without starting a test", async () => {
  const h = await setup();
  const overlay = vi.fn();
  const facade = { ...h.facade, overlay } as RendererFacade;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(ConnectionTestButton, { facade, toolbar: true }),
      ),
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="More checks"]')!
        .click(),
    );
    expect(overlay).toHaveBeenCalledExactlyOnceWith("connection-tests");
    expect(h.configure).not.toHaveBeenCalled();
    expect(host.querySelector("dialog")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    h.cleanup();
  }
});
it("uses fresh original identities for completed explicit checks without repair", async () => {
  const h = await setup();
  try {
    expect((await runFreshConnectionTest(h.facade)).state).toBe("applied");
    expect((await runFreshConnectionTest(h.facade)).state).toBe("applied");
    expect(h.configure).toHaveBeenCalledTimes(2);
    const first = h.configure.mock.calls[0]![0];
    const second = h.configure.mock.calls[1]![0];
    expect(first.kind).toBe("connector.test-connection");
    expect(second.kind).toBe("connector.test-connection");
    if (
      first.kind !== "connector.test-connection" ||
      second.kind !== "connector.test-connection"
    )
      throw Error("fixture");
    expect(first.operationId).not.toBe(second.operationId);
  } finally {
    h.cleanup();
  }
});
it("does not repair or rebind an old app selection before asking the host", async () => {
  const h = await setup();
  try {
    h.settings.connectors.secureMcp.chatgptApp!.connectorGeneration -= 1;
    h.configure.mockResolvedValue({
      id: "check",
      state: "refused",
      code: "CONNECTION_CHECK_OWNER_CHANGED",
    });
    expect((await runFreshConnectionTest(h.facade)).state).toBe("refused");
    expect(h.configure).toHaveBeenCalledTimes(1);
    expect(h.configure.mock.calls[0]![0].kind).toBe(
      "connector.test-connection",
    );
  } finally {
    h.cleanup();
  }
});
it("two simultaneous controls admit at most one original check", async () => {
  const h = await setup();
  try {
    const wait = deferred<void>();
    const original = h.configure.getMockImplementation()!;
    h.configure.mockImplementation(async (command, id) => {
      await wait.promise;
      return original(command, id);
    });
    const first = runFreshConnectionTest(h.facade);
    const second = await runFreshConnectionTest(h.facade);
    expect(second.code).toBe("CONNECTION_TEST_IN_PROGRESS");
    wait.resolve();
    expect((await first).state).toBe("applied");
    expect(h.configure).toHaveBeenCalledTimes(1);
  } finally {
    h.cleanup();
  }
});
it("scoped unknown cannot release another writer fence", async () => {
  const h = await setup();
  try {
    const key = `settings:connector.verify-app:${"c".repeat(64)}`;
    if (h.snapshot.configuration?.status !== "ready") throw Error("fixture");
    h.snapshot.configuration.settings.connectors.secureMcp.appVerificationPending = true;
    h.snapshot.configuration.settings.setup.connect.outcomeUnknown = true;
    h.set({
      ...h.snapshot,
      intents: {
        [key]: {
          id: key,
          state: "unknown",
          code: "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
        },
        "unknown-writer": {
          id: "unknown-writer",
          state: "unknown",
          code: "SETTINGS_WRITE_FAILED",
        },
      },
    });
    expect(commandAllowed(h.snapshot, "connector.repair")).toBe(false);
    expect((await runFreshConnectionTest(h.facade)).state).toBe("refused");
    expect(h.configure).not.toHaveBeenCalled();
    expect(h.snapshot.intents[key]!.state).toBe("unknown");
  } finally {
    h.cleanup();
  }
});

it.each([
  [
    "refused",
    "CONNECTOR_APP_VERIFICATION_NOT_READY",
    "all current app, tunnel, runtime and Computer prerequisites",
  ],
  ["refused", "CHATGPT_COMPOSER_DRAFT_PRESENT", "Your draft was preserved"],
  ["refused", "CHATGPT_APP_SELECTION_CONFLICT", "Message blocked before send"],
  ["refused", "CHATGPT_CONVERSATION_UNCONFIRMED", "The ping was not sent"],
  ["unknown", "CHATGPT_APP_SELECTION_CONFLICT", "You can ping again"],
] as const)(
  "shows %s / %s without another send",
  async (intentState, code, expected) => {
    const h = await setup();
    h.set({
      ...h.snapshot,
      destination: { ...h.snapshot.destination, area: "chatgpt", taskId: "" },
    });
    h.configure.mockResolvedValue({ id: "check", state: intentState, code });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          createElement(ConnectionTestButton, {
            facade: h.facade,
            toolbar: true,
          }),
        ),
      );
      await act(async () => {
        await runManualConnectionPrompt(h.facade);
      });
      expect(host.querySelector('[role="status"]')?.textContent).toContain(
        expected,
      );
      expect(h.configure).toHaveBeenCalledTimes(1);
      expect(h.configure.mock.calls[0]![0].kind).toBe(
        "connector.test-connection",
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
      h.cleanup();
    }
  },
);

it("keeps a contradictory applied result with an error unconfirmed and lets the owner ping again", async () => {
  const h = await setup();
  try {
    h.configure.mockResolvedValue({
      id: "check",
      state: "applied",
      code: "CHATGPT_TASK_ERROR",
    });
    const first = await runFreshConnectionTest(h.facade);
    const second = await runFreshConnectionTest(h.facade);
    expect(first.state).toBe("unknown");
    expect(second.state).toBe("unknown");
    // Each click is a fresh operation; the first one is never re-sent.
    expect(h.configure).toHaveBeenCalledTimes(2);
    const ids = h.configure.mock.calls.map(
      ([command]) => (command as { operationId?: string }).operationId,
    );
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  } finally {
    h.cleanup();
  }
});

it("retains the selected task when testing from completed Setup", async () => {
  const h = await setup();
  try {
    h.controller.navigate({ area: "chatgpt", taskId: "selected-task" });
    h.controller.navigate({ area: "setup", setupStep: "attachment" });
    const destination = h.controller.getSnapshot().destination;
    expect(destination).toMatchObject({
      area: "setup",
      taskId: "selected-task",
    });
    h.set({ ...h.snapshot, destination });
    expect((await runFreshConnectionTest(h.facade)).state).toBe("applied");
    expect(h.configure).toHaveBeenCalledTimes(1);
    expect(h.configure.mock.calls[0]![0]).toMatchObject({
      kind: "connector.test-connection",
      taskId: "selected-task",
    });
  } finally {
    h.cleanup();
  }
});
