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
it("sends the toolbar test as one manual chat request without repair or setup verification", async () => {
  const h = await setup();
  try {
    h.set({
      ...h.snapshot,
      destination: { ...h.snapshot.destination, area: "chatgpt", taskId: "" },
    });
    expect((await runManualConnectionPrompt(h.facade)).state).toBe("applied");
    expect(h.configure).toHaveBeenCalledTimes(2);
    expect(h.configure.mock.calls[0]![0]).toMatchObject({
      kind: "chatgpt.run-deep-test",
      test: "connection",
      taskId: "",
    });
    expect(h.configure.mock.calls[1]![0]).toEqual({
      kind: "chatgpt.ack-deep-test",
      operationId: (h.configure.mock.calls[0]![0] as { operationId: string })
        .operationId,
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
    "This test was refused before Send because Farol could not confirm all current app, tunnel, runtime and Computer prerequisites. Setup can be complete while a current attachment is missing. Review the connection and original result in Activity; do not repeat an unresolved attempt.",
  ],
  [
    "unknown",
    "The test has no confirmed result. Its original record stays in Activity.",
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
      ).toBe("Test connection");
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
        .querySelector<HTMLButtonElement>(
          '[aria-label="More connection tests"]',
        )!
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
it("repeated checks use fresh observation identities without repairing a healthy connection", async () => {
  const h = await setup();
  try {
    expect((await runFreshConnectionTest(h.facade)).state).toBe("applied");
    expect((await runFreshConnectionTest(h.facade)).state).toBe("applied");
    const verifies = h.configure.mock.calls.filter(
      ([c]) => c.kind === "connector.verify-app",
    );
    expect(verifies).toHaveLength(2);
    expect(verifies[0]![1]).not.toBe(verifies[1]![1]);
    expect(
      h.configure.mock.calls.filter(([c]) => c.kind === "connector.repair"),
    ).toHaveLength(0);
    expect(
      h.snapshot.configuration?.status === "ready" &&
        h.snapshot.configuration.settings.connectors.secureMcp.attachment,
    ).not.toBeNull();
  } finally {
    h.cleanup();
  }
});
it("rebinds an existing app selection to the current generation on the same tunnel before verification", async () => {
  const h = await setup();
  try {
    h.settings.connectors.secureMcp.chatgptApp!.connectorGeneration -= 1;
    const original = h.configure.getMockImplementation()!;
    h.configure.mockImplementation(async (command, id) => {
      if (command.kind === "connector.select-chatgpt-app") {
        if (h.snapshot.configuration?.status !== "ready")
          throw Error("fixture");
        h.snapshot.configuration.settings.connectors.secureMcp.chatgptApp = {
          name: command.name,
          tunnelId: command.tunnelId,
          connectorGeneration: command.connectorGeneration,
        };
        return { id, state: "applied", code: null };
      }
      return original(command, id);
    });
    expect((await runFreshConnectionTest(h.facade)).state).toBe("applied");
    expect(h.configure.mock.calls.map(([c]) => c.kind)).toEqual([
      "connector.repair",
      "connector.select-chatgpt-app",
      "connector.verify-app",
    ]);
  } finally {
    h.cleanup();
  }
});
it("does not carry an app selection to a different tunnel", async () => {
  const h = await setup();
  try {
    h.settings.connectors.secureMcp.chatgptApp!.tunnelId = "other-tunnel";
    expect((await runFreshConnectionTest(h.facade)).state).toBe("refused");
    expect(h.configure).not.toHaveBeenCalled();
  } finally {
    h.cleanup();
  }
});
it.each(["selection-refused", "binding-changed"])(
  "does not verify after %s during app rebind",
  async (mode) => {
    const h = await setup();
    try {
      h.settings.connectors.secureMcp.chatgptApp!.connectorGeneration -= 1;
      const original = h.configure.getMockImplementation()!;
      h.configure.mockImplementation(async (command, id) => {
        if (command.kind !== "connector.select-chatgpt-app")
          return original(command, id);
        if (mode === "selection-refused")
          return { id, state: "refused", code: "SETTINGS_UNAVAILABLE" };
        if (h.snapshot.configuration?.status !== "ready")
          throw Error("fixture");
        const connector =
          h.snapshot.configuration.settings.connectors.secureMcp;
        connector.chatgptApp = {
          name: command.name,
          tunnelId: command.tunnelId,
          connectorGeneration: command.connectorGeneration,
        };
        connector.challenge!.challengeSha256 = "9".repeat(64);
        return { id, state: "applied", code: null };
      });
      expect((await runFreshConnectionTest(h.facade)).state).toBe("refused");
      expect(
        h.configure.mock.calls.filter(([command]) =>
          command.kind.startsWith("connector.verify"),
        ),
      ).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  },
);
it("two simultaneous controls admit at most one status check", async () => {
  const h = await setup();
  try {
    const wait = deferred<void>(),
      original = h.configure.getMockImplementation()!;
    h.configure.mockImplementation(async (c, id) => {
      if (c.kind === "connector.verify-app") await wait.promise;
      return original(c, id);
    });
    const first = runFreshConnectionTest(h.facade),
      second = await runFreshConnectionTest(h.facade);
    expect(second.code).toBe("CONNECTION_TEST_IN_PROGRESS");
    wait.resolve();
    expect((await first).state).toBe("applied");
    expect(h.configure).toHaveBeenCalledTimes(1);
  } finally {
    h.cleanup();
  }
});
it.each(["lost-ack", "same-binding", "changed-owner", "stale"])(
  "does not send after %s preparation",
  async (mode) => {
    const h = await setup();
    try {
      h.settings.connectors.secureMcp.runtime!.state = "unreachable";
      const original = h.configure.getMockImplementation()!;
      h.configure.mockImplementation(async (c, id) => {
        const result =
          mode === "same-binding"
            ? { id, state: "applied" as const, code: null }
            : await original(c, id);
        if (c.kind === "connector.repair") {
          if (mode === "lost-ack")
            return {
              id,
              state: "unknown",
              code: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
            };
          if (mode === "stale") h.set({ ...h.snapshot, status: "stale" });
          if (
            mode === "changed-owner" &&
            h.snapshot.configuration?.status === "ready"
          )
            h.snapshot.configuration.settings.computer.computerId =
              "different-owner";
        }
        return result;
      });
      expect((await runFreshConnectionTest(h.facade)).state).not.toBe(
        "applied",
      );
      expect(
        h.configure.mock.calls.filter(([c]) =>
          c.kind.startsWith("connector.verify"),
        ),
      ).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  },
);
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
  {
    title:
      "NOT_READY identifies missing current prerequisites, not a specific completed Setup step",
    intentState: "refused" as const,
    code: "CONNECTOR_APP_VERIFICATION_NOT_READY",
    expected: "all current app, tunnel, runtime and Computer prerequisites",
    forbidden: "Check sign-in and connection in Setup",
  },
  {
    title: "signed-out current page reports a known pre-dispatch refusal",
    intentState: "applied" as const,
    code: "CHATGPT_SIGN_IN_REQUIRED",
    expected: "current ChatGPT page needs sign-in",
    forbidden: "Send requested",
  },
  {
    title: "unrecognized page does not guess a model or app",
    intentState: "applied" as const,
    code: "CHATGPT_UI_UNRECOGNIZED",
    expected: "without guessing an app or model",
    forbidden: "Send requested",
  },
  {
    title: "navigation before submit is not mistaken for Send",
    intentState: "applied" as const,
    code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
    expected: "navigated away before Send",
    forbidden: "Send requested",
  },
  {
    title: "known draft failure preserves the typed pre-submit remedy",
    intentState: "applied" as const,
    code: "CHATGPT_COMPOSER_DRAFT_PRESENT",
    expected: "Your draft was preserved",
    forbidden: "Send requested",
  },
  {
    title:
      "known app-selection conflict is not misreported as a successful Send",
    intentState: "applied" as const,
    code: "CHATGPT_APP_SELECTION_CONFLICT",
    expected: "Message blocked before send",
    forbidden: "Send requested",
  },
  {
    title:
      "unknown outcome with a pre-submit-looking code keeps original uncertainty",
    intentState: "unknown" as const,
    code: "CHATGPT_APP_SELECTION_CONFLICT",
    expected: "Could not confirm whether the request was sent",
    forbidden: "Message blocked before send",
  },
  {
    title: "an applied but unclassified error is not presented as Send",
    intentState: "applied" as const,
    code: "CHATGPT_TASK_ERROR",
    expected: "Send was not confirmed",
    forbidden: "Send requested",
  },
  {
    title: "unclassified refusal does not prove not-sent",
    intentState: "refused" as const,
    code: "CHATGPT_CONVERSATION_UNCONFIRMED",
    expected: "does not prove whether Send occurred",
    forbidden: "was not sent",
  },
])(
  "manual diagnostic: $title",
  async ({ intentState, code, expected, forbidden }) => {
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
      await act(async () => {
        root.render(
          createElement(ConnectionTestButton, {
            facade: h.facade,
            toolbar: true,
          }),
        );
      });
      await act(async () => {
        await runManualConnectionPrompt(h.facade);
      });
      const message = host.querySelector('[role="status"]')?.textContent ?? "";
      expect(message).toContain(expected);
      expect(message).not.toContain(forbidden);
      expect(h.configure.mock.calls[0]![0].kind).toBe("chatgpt.run-deep-test");
      expect(
        h.configure.mock.calls.filter(
          ([command]) =>
            command.kind === "chatgpt.run-deep-test" ||
            command.kind === "connector.repair" ||
            command.kind === "connector.verify-app",
        ),
      ).toHaveLength(1);
      // Applied host results may acknowledge delivery, but never retry Send.
      expect(h.configure).toHaveBeenCalledTimes(
        intentState === "applied" ? 2 : 1,
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
      h.cleanup();
    }
  },
);

it("keeps a contradictory applied result with an error unconfirmed and does not resend", async () => {
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
    expect(h.configure).toHaveBeenCalledTimes(1);
  } finally {
    h.cleanup();
  }
});
