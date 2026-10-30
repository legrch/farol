import { expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  ConnectionTestButton,
  runFreshConnectionTest,
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
it.each([
  ["refused", "Check sign-in and connection in Setup."],
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
      ).toBe("Test in ChatGPT");
      expect(h.configure).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      h.cleanup();
    }
  },
);
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
it("scoped unknown remains unknown and reading notifications cannot release another writer fence", async () => {
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
