import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  ProductConfigurationCommandSchema,
  type ProductConfigurationCommand,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import { changesComputerAuthority } from "../../../src/apps/desktop/configuration-admission";
import { ConnectorSetupReplies } from "../connector-setup-host";
import type { ReadAccountCommands } from "../read-account-commands";

export type DirectChatStart = Readonly<{
  operationId: string;
  inspection: Promise<ProductConfigurationResult>;
  start?: {
    command: Extract<
      ProductConfigurationCommand,
      { kind: "chatgpt.start-conversation" }
    >;
    promise: Promise<ProductConfigurationResult>;
  };
}>;

export type GoReadonlyConversation = Readonly<{
  pending: { operationId: string } | null;
  start: Promise<ProductConfigurationResult>;
}>;

export type ConfigurationObservedPorts = Readonly<{
  deepTestAcknowledgements: Map<string, Promise<ProductConfigurationResult>>;
  deepTestRequests: Map<
    string,
    {
      taskId: string;
      test: "connection" | "deep";
      promise: Promise<ProductConfigurationResult>;
    }
  >;
  configureNewProductRequest: (
    value: unknown,
  ) => Promise<ProductConfigurationResult>;
  configurationFailure: (
    error: Extract<ProductConfigurationResult, { ok: false }>["error"],
    connectorAttempt?: Extract<
      ProductConfigurationResult,
      { ok: false }
    >["connectorAttempt"],
  ) => ProductConfigurationResult;
  cancelStartupConnectorResume: () => void;
  suppressConnectorTransportCurrent: () => void;
  invalidateConnectorTransport: () => void;
  connectorSetupReplies: ConnectorSetupReplies;
  configureSaveAndConnect: (
    command: Extract<
      ProductConfigurationCommand,
      { kind: "connector.save-and-connect" }
    >,
  ) => Promise<ProductConfigurationResult>;
  connectorSetupRefusal: (
    command: Extract<
      ProductConfigurationCommand,
      { kind: "connector.save-and-connect" }
    >,
    code: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ) => Promise<ProductConfigurationResult>;
  directChatStart: () => DirectChatStart | null;
  goReadonlyConversation: () => GoReadonlyConversation | null;
  readonlyAccountCommands: Pick<ReadAccountCommands, "run">;
}>;

export function createConfigurationObserved(
  ports: ConfigurationObservedPorts,
): Readonly<{
  configureProductObserved: (
    value: unknown,
  ) => Promise<ProductConfigurationResult>;
}> {
  const {
    deepTestAcknowledgements,
    deepTestRequests,
    configureNewProductRequest,
    configurationFailure,
    cancelStartupConnectorResume,
    suppressConnectorTransportCurrent,
    invalidateConnectorTransport,
    connectorSetupReplies,
    configureSaveAndConnect,
    connectorSetupRefusal,
    directChatStart,
    goReadonlyConversation,
    readonlyAccountCommands,
  } = ports;

  async function configureProductObserved(
    value: unknown,
  ): Promise<ProductConfigurationResult> {
    const parsed = ProductConfigurationCommandSchema.safeParse(value);
    if (parsed.success && parsed.data.kind === "chatgpt.ack-deep-test") {
      const id = parsed.data.operationId;
      const existing = deepTestAcknowledgements.get(id);
      if (existing) return existing;
      const attempt = Promise.resolve().then(() =>
        configureNewProductRequest(parsed.data),
      );
      deepTestAcknowledgements.set(id, attempt);
      void attempt.then(
        (result) => {
          if (
            !result.ok &&
            result.error !== "CHATGPT_CONVERSATION_UNCONFIRMED" &&
            deepTestAcknowledgements.get(id) === attempt
          )
            deepTestAcknowledgements.delete(id);
        },
        () => {},
      );
      return attempt;
    }
    if (parsed.success && parsed.data.kind === "chatgpt.run-deep-test") {
      const id = parsed.data.operationId;
      const existing = deepTestRequests.get(id);
      if (existing)
        return existing.taskId === parsed.data.taskId &&
          existing.test === (parsed.data.test ?? "deep")
          ? existing.promise
          : configurationFailure("CHATGPT_CONVERSATION_REFUSED");
      const attempt = Promise.resolve().then(() =>
        configureNewProductRequest(parsed.data),
      );
      deepTestRequests.set(id, {
        taskId: parsed.data.taskId,
        test: parsed.data.test ?? "deep",
        promise: attempt,
      });
      return attempt;
    }
    if (
      parsed.success &&
      [
        "connector.stop",
        "connector.start",
        "connector.repair",
        "connector.save-and-connect",
      ].includes(parsed.data.kind)
    )
      cancelStartupConnectorResume();
    if (
      parsed.success &&
      (changesComputerAuthority(parsed.data.kind) ||
        parsed.data.kind === "connector.stop")
    )
      suppressConnectorTransportCurrent();
    else if (
      parsed.success &&
      (parsed.data.kind === "connector.start" ||
        parsed.data.kind === "connector.repair")
    )
      invalidateConnectorTransport();
    if (parsed.success && parsed.data.kind === "connector.save-and-connect") {
      const command = parsed.data;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(command))
        .digest("hex");
      return connectorSetupReplies.run(
        command.operationId,
        fingerprint,
        () => configureSaveAndConnect(command),
        (code) => connectorSetupRefusal(command, code),
      );
    }
    if (parsed.success && directChatStart()) {
      const start = directChatStart()!;
      const command = parsed.data;
      if (command.kind === "chatgpt.inspect-chat-account")
        return command.operationId === start.operationId
          ? start.inspection
          : configurationFailure("CHATGPT_CONVERSATION_REFUSED");
      if (command.kind === "chatgpt.start-conversation" && start.start)
        return isDeepStrictEqual(command, start.start.command)
          ? start.start.promise
          : configurationFailure("CHATGPT_CONVERSATION_REFUSED");
    }
    if (
      parsed.success &&
      parsed.data.kind === "chatgpt.submit-readonly-task" &&
      goReadonlyConversation()?.pending?.operationId === parsed.data.operationId
    )
      return goReadonlyConversation()!.start;
    if (
      parsed.success &&
      (parsed.data.kind === "chatgpt.inspect-readonly-account" ||
        parsed.data.kind === "chatgpt.approve-readonly-account")
    ) {
      return readonlyAccountCommands.run(
        parsed.data as Extract<
          ProductConfigurationCommand,
          {
            kind:
              | "chatgpt.inspect-readonly-account"
              | "chatgpt.approve-readonly-account";
          }
        >,
        () => configureNewProductRequest(parsed.data),
        configurationFailure,
      );
    }
    return configureNewProductRequest(value);
  }

  return Object.freeze({ configureProductObserved });
}
