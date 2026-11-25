import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProductConfigurationCommand,
  ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import type { OperationsStore } from "../operations/store";
import {
  createConfigurationDispatch,
  type ConfigurationDispatchPorts,
} from "./dispatch";

function failure(error: string): ProductConfigurationResult {
  return {
    ok: false,
    error,
    snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
  } as unknown as ProductConfigurationResult;
}

function command(
  kind: string,
  extra: Record<string, unknown> = {},
): ProductConfigurationCommand {
  return { kind, ...extra } as unknown as ProductConfigurationCommand;
}

const SIGN_IN = {
  kind: "chatgpt.observe-sign-in",
  buildId: "3".repeat(64),
  observationId: "11111111-1111-4111-8111-111111111111",
};

type Route = { route: string; args: unknown[] };

// Each accessor lends one spy per method it is asked for, each answering with
// its own name, so a command that reached the wrong owner is visible by name.
function accessor(name: string, methods: readonly string[]) {
  const spies = Object.fromEntries(
    methods.map((method) => [
      method,
      vi.fn(async (...args: unknown[]) => ({
        route: `${name}.${method}`,
        args,
      })),
    ]),
  );
  return { spies, get: vi.fn(() => spies) };
}

function build(overrides: Partial<ConfigurationDispatchPorts> = {}) {
  const owners = {
    connectorCheck: accessor("connectorCheck", ["testConnectionCommand"]),
    configurationDeep: accessor("configurationDeep", [
      "runManualDeepTest",
      "deepTestStatus",
      "acknowledgeDeepTest",
    ]),
    configurationComputer: accessor("configurationComputer", [
      "configureAdmittedComputer",
    ]),
    configurationChatgpt: accessor("configurationChatgpt", [
      "configureAdmittedChatgpt",
    ]),
    configurationSupport: accessor("configurationSupport", [
      "configureAdmittedSupport",
    ]),
    configurationConnector: accessor("configurationConnector", [
      "configureAdmittedConnector",
    ]),
    devProof: accessor("devProof", ["prepare", "run"]),
    configurationHost: accessor("configurationHost", ["configureAdmittedHost"]),
    configurationModel: accessor("configurationModel", [
      "configureAdmittedModel",
    ]),
  };
  const settings = { current: {} as object | null };
  const finish = vi.fn();
  const store = {
    begin: vi.fn(() => finish),
    record: vi.fn(),
    setWorkspaceLabels: vi.fn(),
  };
  const configurationFailure = vi.fn((error: string) => failure(error));
  const configureProductObserved = vi.fn(
    async (value: unknown): Promise<ProductConfigurationResult> =>
      failure(`OBSERVED:${JSON.stringify(value)}`),
  );
  const operationsStore = vi.fn(() => store as unknown as OperationsStore);
  const configurationReplyFault = vi.fn(
    (): "deliver" | "drop" => "deliver" as const,
  );
  const ports = {
    configuration: vi.fn(() => settings.current),
    configurationFailure,
    configureProductObserved,
    operationsStore,
    configurationReplyFault,
    connectorCheck: owners.connectorCheck.get,
    configurationDeep: owners.configurationDeep.get,
    configurationComputer: owners.configurationComputer.get,
    configurationChatgpt: owners.configurationChatgpt.get,
    configurationSupport: owners.configurationSupport.get,
    configurationConnector: owners.configurationConnector.get,
    devProof: owners.devProof.get,
    configurationHost: owners.configurationHost.get,
    configurationModel: owners.configurationModel.get,
    ...overrides,
  } as unknown as ConfigurationDispatchPorts;
  return {
    ports,
    owners,
    settings,
    store,
    finish,
    configurationFailure,
    configureProductObserved,
    operationsStore,
    configurationReplyFault,
    dispatch: createConfigurationDispatch(ports),
  };
}

function untouched(f: ReturnType<typeof build>): void {
  for (const owner of Object.values(f.owners)) {
    expect(owner.get).not.toHaveBeenCalled();
  }
}

afterEach(() => vi.restoreAllMocks());

describe("configuration dispatch", () => {
  it("reads nothing at construction, only when a command arrives", () => {
    const f = build();
    expect(f.ports.configuration).not.toHaveBeenCalled();
    expect(f.operationsStore).not.toHaveBeenCalled();
    untouched(f);
  });

  describe("configureProduct", () => {
    it("hands input that does not parse straight to the observed route, unobserved", async () => {
      const f = build();
      const value = { kind: "not-a-command" };
      const result = await f.dispatch.configureProduct(value);
      expect(f.configureProductObserved).toHaveBeenCalledExactlyOnceWith(value);
      expect(result).toEqual(failure(`OBSERVED:${JSON.stringify(value)}`));
      expect(f.operationsStore).not.toHaveBeenCalled();
      expect(f.store.begin).not.toHaveBeenCalled();
    });

    it("hands the bounded sign-in query on with its parsed data, journaling nothing", async () => {
      const f = build();
      await f.dispatch.configureProduct(SIGN_IN);
      expect(f.configureProductObserved).toHaveBeenCalledExactlyOnceWith(
        SIGN_IN,
      );
      expect(f.operationsStore).not.toHaveBeenCalled();
      expect(f.store.begin).not.toHaveBeenCalled();
    });

    it("observes a parsed command and runs it on the raw value", async () => {
      const f = build();
      const value = { kind: "model.status" };
      const result = await f.dispatch.configureProduct(value);
      expect(f.store.begin).toHaveBeenCalledExactlyOnceWith({
        source: "Codex",
        kind: "model.status",
        target: {},
      });
      expect(f.configureProductObserved).toHaveBeenCalledExactlyOnceWith(value);
      expect(f.finish).toHaveBeenCalledOnce();
      expect(result).toEqual(failure(`OBSERVED:${JSON.stringify(value)}`));
    });

    it("labels workspaces and widens the target from a ready snapshot, nothing else", async () => {
      const workspaces = [{ workspaceId: "ws-1", label: "one" }];
      const ready = {
        ok: true,
        snapshot: { status: "ready", settings: { computer: { workspaces } } },
        evidence: { kind: "computer.check-folder", workspaceId: "ws-1" },
      } as unknown as ProductConfigurationResult;
      const f = build();
      f.configureProductObserved.mockResolvedValueOnce(ready);
      const metadataSeen: unknown[] = [];
      f.store.begin.mockImplementationOnce(((metadata: unknown) => {
        metadataSeen.push(metadata);
        return f.finish;
      }) as never);
      expect(
        await f.dispatch.configureProduct({ kind: "connector.stop" }),
      ).toBe(ready);
      await Promise.resolve();
      expect(f.store.setWorkspaceLabels).toHaveBeenCalledExactlyOnceWith(
        workspaces,
      );
      expect(metadataSeen[0]).toMatchObject({ target: { workspace: "ws-1" } });

      const g = build();
      await g.dispatch.configureProduct({ kind: "connector.stop" });
      expect(g.store.setWorkspaceLabels).not.toHaveBeenCalled();
    });

    it("lets optional labels fail without replacing the result", async () => {
      const ready = {
        ok: true,
        snapshot: {
          status: "ready",
          settings: { computer: { workspaces: [] } },
        },
      } as unknown as ProductConfigurationResult;
      const f = build();
      f.configureProductObserved.mockResolvedValueOnce(ready);
      f.store.setWorkspaceLabels.mockImplementation(() => {
        throw new Error("labels unavailable");
      });
      await expect(
        f.dispatch.configureProduct({ kind: "connector.stop" }),
      ).resolves.toBe(ready);
    });

    it("passes a rejected command through, still observed", async () => {
      const f = build();
      const failureReason = new Error("command failed");
      f.configureProductObserved.mockRejectedValueOnce(failureReason);
      await expect(
        f.dispatch.configureProduct({ kind: "connector.stop" }),
      ).rejects.toBe(failureReason);
      expect(f.store.begin).toHaveBeenCalledOnce();
      expect(f.finish).toHaveBeenCalledOnce();
    });
  });

  describe("deliverConfigurationReply", () => {
    function stderr() {
      return vi
        .spyOn(process.stderr, "write")
        .mockImplementation((() => true) as never);
    }
    const result = failure("SETTINGS_UNAVAILABLE");

    it("returns the production result untouched when the fault says deliver", () => {
      const write = stderr();
      const f = build();
      expect(
        f.dispatch.deliverConfigurationReply("computer.rename", result),
      ).toBe(result);
      expect(f.configurationReplyFault).toHaveBeenCalledExactlyOnceWith(
        "computer.rename",
        result,
      );
      expect(write).not.toHaveBeenCalled();
    });

    it("drops the reply when the fault says drop: logs it and never settles", async () => {
      const write = stderr();
      const f = build();
      f.configurationReplyFault.mockReturnValue("drop");
      const settled = vi.fn();
      const reply = f.dispatch.deliverConfigurationReply(
        "computer.apply-workspace-edit",
        result,
      );
      expect(reply).toBeInstanceOf(Promise);
      void (reply as Promise<unknown>).then(settled, settled);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledExactlyOnceWith(
        "farol-e2e:reply-dropped computer.apply-workspace-edit unknown\n",
      );
    });

    it("names the workspace-mutation operation in the dropped-reply line", () => {
      const write = stderr();
      const f = build();
      f.configurationReplyFault.mockReturnValue("drop");
      const mutation = {
        ok: true,
        snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
        evidence: {
          kind: "computer.workspace-mutation",
          operationId: "op-7",
        },
      } as unknown as ProductConfigurationResult;
      void f.dispatch.deliverConfigurationReply(
        "computer.apply-workspace-edit",
        mutation,
      );
      expect(write).toHaveBeenCalledExactlyOnceWith(
        "farol-e2e:reply-dropped computer.apply-workspace-edit op-7\n",
      );
    });
  });

  describe("configureAdmittedProduct", () => {
    it("fails first when settings are unavailable, before any refusal or route", async () => {
      const f = build();
      f.settings.current = null;
      for (const kind of [
        "host.run-codex-smoke",
        "connector.test-connection",
        "chatgpt.deep-test-status",
        "computer.rename",
        "model.status",
        "unknown.kind",
      ]) {
        await expect(
          f.dispatch.configureAdmittedProduct(command(kind)),
        ).resolves.toEqual(failure("SETTINGS_UNAVAILABLE"));
      }
      expect(f.configurationFailure).toHaveBeenCalledTimes(6);
      expect(f.configurationFailure).toHaveBeenCalledWith(
        "SETTINGS_UNAVAILABLE",
      );
      untouched(f);
    });

    it.each(["host.run-codex-smoke", "host.run-codex-agent-check"])(
      "refuses the retired %s before any host owner is reached",
      async (kind) => {
        const f = build();
        await expect(
          f.dispatch.configureAdmittedProduct(command(kind)),
        ).resolves.toEqual(failure("CODEX_HOST_MODEL_UNAVAILABLE"));
        expect(f.configurationFailure).toHaveBeenCalledExactlyOnceWith(
          "CODEX_HOST_MODEL_UNAVAILABLE",
        );
        untouched(f);
      },
    );

    it("routes the explicit connection check to the connector check, not the connector", async () => {
      const f = build();
      const cmd = command("connector.test-connection");
      await expect(f.dispatch.configureAdmittedProduct(cmd)).resolves.toEqual({
        route: "connectorCheck.testConnectionCommand",
        args: [cmd],
      });
      expect(f.owners.configurationConnector.get).not.toHaveBeenCalled();
    });

    it("runs a manual deep test with its ids, defaulting the test to deep", async () => {
      const f = build();
      await expect(
        f.dispatch.configureAdmittedProduct(
          command("chatgpt.run-deep-test", { operationId: "op", taskId: "t" }),
        ),
      ).resolves.toEqual({
        route: "configurationDeep.runManualDeepTest",
        args: ["op", "t", "deep"],
      });
      await expect(
        f.dispatch.configureAdmittedProduct(
          command("chatgpt.run-deep-test", {
            operationId: "op",
            taskId: "t",
            test: "connection",
          }),
        ),
      ).resolves.toEqual({
        route: "configurationDeep.runManualDeepTest",
        args: ["op", "t", "connection"],
      });
      expect(f.owners.configurationChatgpt.get).not.toHaveBeenCalled();
    });

    it("answers the deep-test status and acknowledgement from the deep owner", async () => {
      const f = build();
      await expect(
        f.dispatch.configureAdmittedProduct(
          command("chatgpt.deep-test-status"),
        ),
      ).resolves.toEqual({
        route: "configurationDeep.deepTestStatus",
        args: [],
      });
      await expect(
        f.dispatch.configureAdmittedProduct(
          command("chatgpt.ack-deep-test", { operationId: "op-2" }),
        ),
      ).resolves.toEqual({
        route: "configurationDeep.acknowledgeDeepTest",
        args: ["op-2"],
      });
    });

    it("sends every computer.-prefixed command, unchanged, to the computer owner", async () => {
      const f = build();
      for (const kind of ["computer.rename", "computer.anything-else"]) {
        const cmd = command(kind);
        const result = (await f.dispatch.configureAdmittedProduct(
          cmd,
        )) as unknown as Route;
        expect(result.route).toBe(
          "configurationComputer.configureAdmittedComputer",
        );
        expect(result.args[0]).toBe(cmd);
      }
      // The prefix is exact: a look-alike falls through to the final refusal.
      await expect(
        f.dispatch.configureAdmittedProduct(command("computers.rename")),
      ).resolves.toEqual(failure("SETTINGS_INPUT_INVALID"));
    });

    const chatgptLabels = [
      "chatgpt.inspect-chat-account",
      "chatgpt.start-conversation",
      "chatgpt.observe-readonly-conversation",
      "chatgpt.ack-readonly-conversation",
      "chatgpt.follow-readonly-conversation",
      "chatgpt.recover-task-result",
      "chatgpt.reset-conversation",
      "chatgpt.ack-task-result",
      "chatgpt.open-sign-in",
      "chatgpt.observe-sign-in",
      "chatgpt.present-browser",
      "chatgpt.open-browser",
      "chatgpt.toggle-sidebar",
      "chatgpt.verify",
      "chatgpt.sign-in-return",
      "chatgpt.verification-return",
      "chatgpt.prepare-attachment-task",
      "chatgpt.submit-attachment-task",
      "chatgpt.cancel-attachment-task",
      "chatgpt.prepare-readonly-task",
      "chatgpt.inspect-readonly-account",
      "chatgpt.approve-readonly-account",
      "chatgpt.submit-readonly-task",
      "chatgpt.cancel-readonly-task",
    ];
    const supportLabels = [
      "onboarding.open-help",
      "support.export",
      "general.update",
      "setup.progress",
    ];
    const connectorLabels = [
      "connector.select-client",
      "connector.discover-client",
      "connector.select-discovered-client",
      "connector.save-and-connect",
      "connector.configure",
      "connector.select-chatgpt-app",
      "connector.start",
      "connector.repair",
      "connector.check-health",
      "connector.check-attachment",
      "connector.verify-app",
      "connector.verify-separate-app",
      "connector.stop",
    ];
    // The two retired Codex checks are refused before the switch, so they are
    // not routable labels even though the host case still names them.
    const hostLabels = [
      "host.select-codex",
      "host.discover-codex",
      "host.select-discovered-codex",
      "host.verify-codex",
      "host.refresh-codex-task-models",
      "host.configure-codex-tasks",
      "host.clear-codex-tasks",
      "host.run-route-b-check",
      "host.remove-codex",
    ];
    const modelLabels = [
      "model.status",
      "model.preview",
      "model.apply",
      "model.rollback",
      "model.rotate-token",
    ];
    const routes: ReadonlyArray<readonly [string, string, readonly string[]]> =
      [
        [
          "configurationChatgpt.configureAdmittedChatgpt",
          "chatgpt",
          chatgptLabels,
        ],
        [
          "configurationSupport.configureAdmittedSupport",
          "support",
          supportLabels,
        ],
        [
          "configurationConnector.configureAdmittedConnector",
          "connector",
          connectorLabels,
        ],
        ["configurationHost.configureAdmittedHost", "host", hostLabels],
        ["configurationModel.configureAdmittedModel", "model", modelLabels],
      ];

    it.each(
      routes.flatMap(([route, , labels]) =>
        labels.map((label) => [label, route] as const),
      ),
    )(
      "routes the case %s to %s with the command unchanged",
      async (label, route) => {
        const f = build();
        const cmd = command(label);
        const result = (await f.dispatch.configureAdmittedProduct(
          cmd,
        )) as unknown as Route;
        expect(result.route).toBe(route);
        expect(result.args).toHaveLength(1);
        expect(result.args[0]).toBe(cmd);
        // Exactly one owner was consulted, and only the one that owns the label.
        const [owner] = route.split(".");
        for (const [name, entry] of Object.entries(f.owners)) {
          if (name === owner) expect(entry.get).toHaveBeenCalledOnce();
          else expect(entry.get).not.toHaveBeenCalled();
        }
      },
    );

    it("routes the dev proof commands to prepare and run, without arguments", async () => {
      const f = build();
      await expect(
        f.dispatch.configureAdmittedProduct(command("dev-proof.prepare")),
      ).resolves.toEqual({ route: "devProof.prepare", args: [] });
      await expect(
        f.dispatch.configureAdmittedProduct(command("dev-proof.run")),
      ).resolves.toEqual({ route: "devProof.run", args: [] });
    });

    it("covers every case label the switch names, each once", async () => {
      const source = await readFile(
        path.resolve(import.meta.dirname, "dispatch.ts"),
        "utf8",
      );
      const body = source.slice(source.indexOf("switch (command.kind)"));
      const named = [...body.matchAll(/case "([^"]+)":/gu)].map(
        (match) => match[1],
      );
      const routed = routes.flatMap(([, , labels]) => labels);
      expect(new Set(routed).size).toBe(routed.length);
      expect([...named].sort()).toEqual(
        [
          ...routed,
          "dev-proof.prepare",
          "dev-proof.run",
          "host.run-codex-smoke",
          "host.run-codex-agent-check",
        ].sort(),
      );
    });

    it("yields the original refusal for a kind no case names", async () => {
      const f = build();
      await expect(
        f.dispatch.configureAdmittedProduct(command("nothing.known")),
      ).resolves.toEqual(failure("SETTINGS_INPUT_INVALID"));
      expect(f.configurationFailure).toHaveBeenCalledExactlyOnceWith(
        "SETTINGS_INPUT_INVALID",
      );
      untouched(f);
    });

    it("reads each owner afresh for every command, never a cached copy", async () => {
      const f = build();
      await f.dispatch.configureAdmittedProduct(command("model.status"));
      await f.dispatch.configureAdmittedProduct(command("model.apply"));
      expect(f.owners.configurationModel.get).toHaveBeenCalledTimes(2);
      expect(f.ports.configuration).toHaveBeenCalledTimes(2);
    });
  });
});
