import {
  ProductConfigurationCommandSchema,
  type ProductConfigurationCommand,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import type { createConnectorCheck } from "../connector/check";
import type { createDevProof } from "../dev/proof";
import {
  configurationOperation,
  configurationResultTarget,
} from "../operations/configuration";
import { observeOperation } from "../operations/observe";
import type { OperationsStore } from "../operations/store";
import type { createConfigurationChatgpt } from "./chatgpt";
import type {
  ComputerConfigurationCommand,
  createConfigurationComputer,
} from "./computer";
import type { createConfigurationConnector } from "./connector";
import type { createConfigurationDeep } from "./deep";
import type { createConfigurationHost } from "./host";
import type { createConfigurationModel } from "./model";
import type { createConfigurationSupport } from "./support";

// The product configuration command dispatch: how one Settings command is
// parsed, observed, refused or routed to the factory that owns its kind. It
// owns no state and builds no authority. Main keeps every owner: each
// `configuration*` accessor and each other helper reaches this file as a
// function port, read at the moment a command arrives and never when this is
// built, and the E2E reply fault is the one main-built decision lent by
// reference, because its dropped-reply count is one process-wide budget.

export type ConfigurationDispatchPorts = Readonly<{
  configuration: () => object | null;
  configurationFailure: (
    error: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ) => ProductConfigurationResult;
  configureProductObserved: (
    value: unknown,
  ) => Promise<ProductConfigurationResult>;
  operationsStore: () => OperationsStore;
  configurationReplyFault: (
    commandKind: string,
    result: ProductConfigurationResult,
  ) => "deliver" | "drop";
  connectorCheck: () => Pick<
    ReturnType<typeof createConnectorCheck>,
    "testConnectionCommand"
  >;
  configurationDeep: () => Pick<
    ReturnType<typeof createConfigurationDeep>,
    "runManualDeepTest" | "deepTestStatus" | "acknowledgeDeepTest"
  >;
  configurationComputer: () => Pick<
    ReturnType<typeof createConfigurationComputer>,
    "configureAdmittedComputer"
  >;
  configurationChatgpt: () => Pick<
    ReturnType<typeof createConfigurationChatgpt>,
    "configureAdmittedChatgpt"
  >;
  configurationSupport: () => Pick<
    ReturnType<typeof createConfigurationSupport>,
    "configureAdmittedSupport"
  >;
  configurationConnector: () => Pick<
    ReturnType<typeof createConfigurationConnector>,
    "configureAdmittedConnector"
  >;
  devProof: () => Pick<ReturnType<typeof createDevProof>, "prepare" | "run">;
  configurationHost: () => Pick<
    ReturnType<typeof createConfigurationHost>,
    "configureAdmittedHost"
  >;
  configurationModel: () => Pick<
    ReturnType<typeof createConfigurationModel>,
    "configureAdmittedModel"
  >;
}>;

// The `computer.` prefix is the whole of what makes a command a computer
// command, so the narrowing is the prefix test itself rather than an assertion
// beside it.
function isComputerCommand(
  command: ProductConfigurationCommand,
): command is ComputerConfigurationCommand {
  return command.kind.startsWith("computer.");
}

export function createConfigurationDispatch(ports: ConfigurationDispatchPorts) {
  const {
    configuration,
    configurationFailure,
    configureProductObserved,
    operationsStore,
    configurationReplyFault,
    connectorCheck,
    configurationDeep,
    configurationComputer,
    configurationChatgpt,
    configurationSupport,
    configurationConnector,
    devProof,
    configurationHost,
    configurationModel,
  } = ports;

  function configureProduct(
    value: unknown,
  ): Promise<ProductConfigurationResult> {
    const parsed = ProductConfigurationCommandSchema.safeParse(value);
    if (!parsed.success) return configureProductObserved(value);
    // This bounded page query has no effect to reconcile. Inconclusive status
    // remains a diagnostic, never a durable unresolved operation.
    if (parsed.data.kind === "chatgpt.observe-sign-in")
      return configureProductObserved(parsed.data);
    const metadata = configurationOperation(parsed.data);
    return observeOperation(operationsStore(), metadata, () => {
      const original = configureProductObserved(value);
      void original.then(
        (result) => {
          try {
            if (result.snapshot.status === "ready") {
              const workspaces = result.snapshot.settings.computer.workspaces;
              operationsStore().setWorkspaceLabels(workspaces);
              Object.assign(metadata.target, configurationResultTarget(result));
            }
          } catch {
            // Optional labels cannot replace the configuration result or notification.
          }
        },
        () => undefined,
      );
      return original;
    });
  }

  // The reply's last step before Electron carries it to the renderer. The
  // command itself has fully completed here — its edit, receipt and durable
  // pending record are already on disk — so a dropped reply is a reply lost in
  // transit and nothing else. Outside the E2E lane the decision is always
  // "deliver" and the production result is returned untouched.
  function deliverConfigurationReply(
    commandKind: string,
    result: ProductConfigurationResult,
  ): ProductConfigurationResult | Promise<ProductConfigurationResult> {
    if (configurationReplyFault(commandKind, result) === "deliver")
      return result;
    const operationId =
      result.ok && result.evidence?.kind === "computer.workspace-mutation"
        ? result.evidence.operationId
        : "unknown";
    process.stderr.write(
      `farol-e2e:reply-dropped ${commandKind} ${operationId}\n`,
    );
    // Never settles: the renderer's `ipcRenderer.invoke` receives nothing at
    // all, which is the state the durable pending-edit record exists for.
    return new Promise<ProductConfigurationResult>(() => {});
  }

  async function configureAdmittedProduct(
    command: ProductConfigurationCommand,
  ): Promise<ProductConfigurationResult> {
    if (!configuration()) return configurationFailure("SETTINGS_UNAVAILABLE");
    // These legacy checks hard-code a model the owner no longer permits.
    // Refuse before starting a host or changing verification evidence; retain
    // the old reader and the separate cleanup route for existing assignments.
    if (
      new Set<string>([
        "host.run-codex-smoke",
        "host.run-codex-agent-check",
      ]).has(command.kind)
    )
      return configurationFailure("CODEX_HOST_MODEL_UNAVAILABLE");
    if (command.kind === "connector.test-connection")
      return connectorCheck().testConnectionCommand(command);
    if (command.kind === "chatgpt.run-deep-test")
      return configurationDeep().runManualDeepTest(
        command.operationId,
        command.taskId,
        command.test ?? "deep",
      );
    if (command.kind === "chatgpt.deep-test-status")
      return configurationDeep().deepTestStatus();
    if (command.kind === "chatgpt.ack-deep-test")
      return configurationDeep().acknowledgeDeepTest(command.operationId);
    if (isComputerCommand(command)) {
      return configurationComputer().configureAdmittedComputer(command);
    }
    switch (command.kind) {
      case "chatgpt.inspect-chat-account":
      case "chatgpt.start-conversation":
      case "chatgpt.observe-readonly-conversation":
      case "chatgpt.ack-readonly-conversation":
      case "chatgpt.follow-readonly-conversation":
      case "chatgpt.recover-task-result":
      case "chatgpt.reset-conversation":
      case "chatgpt.ack-task-result":
      case "chatgpt.open-sign-in":
      case "chatgpt.observe-sign-in":
      case "chatgpt.present-browser":
      case "chatgpt.open-browser":
      case "chatgpt.toggle-sidebar":
      case "chatgpt.verify":
      case "chatgpt.sign-in-return":
      case "chatgpt.verification-return":
      case "chatgpt.prepare-attachment-task":
      case "chatgpt.submit-attachment-task":
      case "chatgpt.cancel-attachment-task":
      case "chatgpt.prepare-readonly-task":
      case "chatgpt.inspect-readonly-account":
      case "chatgpt.approve-readonly-account":
      case "chatgpt.submit-readonly-task":
      case "chatgpt.cancel-readonly-task":
        return configurationChatgpt().configureAdmittedChatgpt(command);
      case "onboarding.open-help":
      case "support.export":
      case "general.update":
      case "setup.progress":
        return configurationSupport().configureAdmittedSupport(command);
      case "connector.select-client":
      case "connector.discover-client":
      case "connector.select-discovered-client":
      case "connector.save-and-connect":
      case "connector.configure":
      case "connector.select-chatgpt-app":
      case "connector.start":
      case "connector.repair":
      case "connector.check-health":
      case "connector.check-attachment":
      case "connector.verify-app":
      case "connector.verify-separate-app":
      case "connector.stop":
        return configurationConnector().configureAdmittedConnector(command);

      case "dev-proof.prepare":
        return devProof().prepare();
      case "dev-proof.run":
        return devProof().run();

      case "host.select-codex":
      case "host.discover-codex":
      case "host.select-discovered-codex":
      case "host.verify-codex":
      case "host.refresh-codex-task-models":
      case "host.configure-codex-tasks":
      case "host.clear-codex-tasks":
      case "host.run-route-b-check":
      case "host.run-codex-smoke":
      case "host.run-codex-agent-check":
      case "host.remove-codex":
        return configurationHost().configureAdmittedHost(command);
      case "model.status":
      case "model.preview":
      case "model.apply":
      case "model.rollback":
      case "model.rotate-token":
        return configurationModel().configureAdmittedModel(command);
    }
    return configurationFailure("SETTINGS_INPUT_INVALID");
  }

  return {
    configureProduct,
    deliverConfigurationReply,
    configureAdmittedProduct,
  };
}
