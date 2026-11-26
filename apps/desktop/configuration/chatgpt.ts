import type { ProductConfigurationResult } from "../../../src/pkg/product-settings/contract";
import { createChatgptSignin } from "./signin";
import { createChatgptBrowser } from "./browser";
import { createChatgptConversation } from "./conversation";
import { createChatgptAttachment } from "./attachment";
import { createChatgptReadonly } from "./readonly";
import type {
  ChatgptConfigurationCommand,
  ConfigurationChatgptPorts,
} from "./ports";

export type {
  ChatgptConfigurationCommand,
  ConfigurationChatgptPorts,
  DirectChatStart,
  GoReadonlyConversation,
  PendingChatGptAttachmentTask,
  PendingChatGptReadonlyTask,
} from "./ports";

export function createConfigurationChatgpt(ports: ConfigurationChatgptPorts) {
  const signin = createChatgptSignin(ports);

  const browser = createChatgptBrowser(ports);

  const conversation = createChatgptConversation(ports);

  const attachment = createChatgptAttachment(ports);

  const readonly = createChatgptReadonly(ports);

  // Main retains parsed-command admission, its settings-availability guard and
  // the deep-test commands.
  async function configureAdmittedChatgpt(
    command: ChatgptConfigurationCommand,
  ): Promise<ProductConfigurationResult> {
    switch (command.kind) {
      case "chatgpt.inspect-chat-account":
      case "chatgpt.start-conversation":
      case "chatgpt.observe-readonly-conversation":
      case "chatgpt.ack-readonly-conversation":
      case "chatgpt.follow-readonly-conversation":
      case "chatgpt.recover-task-result":
      case "chatgpt.reset-conversation":
      case "chatgpt.ack-task-result":
        return conversation.configureConversation(command);
      case "chatgpt.open-sign-in":
      case "chatgpt.observe-sign-in":
      case "chatgpt.verify":
      case "chatgpt.sign-in-return":
      case "chatgpt.verification-return":
        return signin.configureSignin(command);
      case "chatgpt.present-browser":
      case "chatgpt.open-browser":
      case "chatgpt.toggle-sidebar":
        return browser.configureBrowser(command);
      case "chatgpt.prepare-attachment-task":
      case "chatgpt.submit-attachment-task":
      case "chatgpt.cancel-attachment-task":
        return attachment.configureAttachment(command);
      case "chatgpt.prepare-readonly-task":
      case "chatgpt.inspect-readonly-account":
      case "chatgpt.approve-readonly-account":
      case "chatgpt.submit-readonly-task":
      case "chatgpt.cancel-readonly-task":
        return readonly.configureReadonly(command);
    }
  }

  return Object.freeze({ configureAdmittedChatgpt });
}
