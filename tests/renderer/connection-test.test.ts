import { expect, it, vi } from "vitest";
import { runFreshConnectionTest } from "../../apps/desktop/renderer/connection-test";
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
it("a second explicit test uses new identities rather than repeating a consumed challenge", async () => {
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
    ).toHaveLength(2);
  } finally {
    h.cleanup();
  }
});
it("two simultaneous controls admit at most one preparation and one test", async () => {
  const h = await setup();
  try {
    const wait = deferred<void>(),
      original = h.configure.getMockImplementation()!;
    h.configure.mockImplementation(async (c, id) => {
      if (c.kind === "connector.repair") await wait.promise;
      return original(c, id);
    });
    const first = runFreshConnectionTest(h.facade),
      second = await runFreshConnectionTest(h.facade);
    expect(second.code).toBe("CONNECTION_TEST_IN_PROGRESS");
    wait.resolve();
    expect((await first).state).toBe("applied");
    expect(h.configure).toHaveBeenCalledTimes(2);
  } finally {
    h.cleanup();
  }
});
it.each(["lost-ack", "same-binding", "changed-owner", "stale"])(
  "does not send after %s preparation",
  async (mode) => {
    const h = await setup();
    try {
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
