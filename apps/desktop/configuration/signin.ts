import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import type {
  ConfigurationChatgptPorts,
  ChatgptConfigurationCommand,
} from "./ports";

type SigninCommand = Extract<
  ChatgptConfigurationCommand,
  {
    kind:
      | "chatgpt.open-sign-in"
      | "chatgpt.observe-sign-in"
      | "chatgpt.verify"
      | "chatgpt.sign-in-return"
      | "chatgpt.verification-return";
  }
>;

export type SigninPorts = Pick<
  ConfigurationChatgptPorts,
  | "configuration"
  | "chatGptRoute"
  | "chatGptSignInGeneration"
  | "setChatGptSignInGeneration"
  | "setChatGptSignInOpenGeneration"
  | "setChatGptSignInOutcome"
  | "setSetupSignInCheck"
  | "desktopAdmission"
  | "chatGptSignInBlocked"
  | "buildIdentity"
  | "activeDesktopIdentity"
  | "SIGN_IN_WINDOW_TITLE"
  | "configurationFailure"
  | "embeddedBrowserEnabled"
  | "applyLayout"
>;

export function createChatgptSignin(ports: SigninPorts) {
  const {
    configuration,
    chatGptRoute,
    chatGptSignInGeneration,
    setChatGptSignInGeneration,
    setChatGptSignInOpenGeneration,
    setChatGptSignInOutcome,
    setSetupSignInCheck,
    desktopAdmission,
    chatGptSignInBlocked,
    buildIdentity,
    activeDesktopIdentity,
    SIGN_IN_WINDOW_TITLE,
    configurationFailure,
    embeddedBrowserEnabled,
    applyLayout,
  } = ports;

  async function configureSignin(
    command: SigninCommand,
  ): Promise<ProductConfigurationResult> {
    switch (command.kind) {
      case "chatgpt.open-sign-in": {
        if (!chatGptRoute()) {
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        }
        chatGptSignInBlocked.beginAttempt();
        setChatGptSignInOutcome(null);
        setChatGptSignInGeneration(chatGptSignInGeneration() + 1);
        setChatGptSignInOpenGeneration(chatGptSignInGeneration());
        if (embeddedBrowserEnabled()) {
          // Renderer presentation has already selected the home document.
          // Starting sign-in never changes that explicit selection.
          applyLayout();
        }
        let opened: Awaited<ReturnType<ChatGptRoute["open"]>>;
        try {
          opened = await chatGptRoute()!.openForSignIn(SIGN_IN_WINDOW_TITLE);
        } catch {
          opened = { status: "unreachable" };
        }
        const recorded =
          opened.status === "opened"
            ? await configuration()!.markSetupVisited("chatgpt")
            : await configuration()!.recordChatGptObservation({
                state: "unreachable",
              });
        return ProductConfigurationResultSchema.parse({
          ...recorded,
          ...(opened.status === "unreachable"
            ? {
                evidence: {
                  kind: "chatgpt.readiness",
                  state: "unreachable",
                  code: "CHATGPT_PAGE_UNREACHABLE",
                },
              }
            : {}),
        });
      }
      case "chatgpt.observe-sign-in": {
        const original = chatGptRoute();
        let observation: Awaited<
          ReturnType<ChatGptRoute["observeSignInStatus"]>
        > = { state: "unknown", binding: null };
        if (original && command.buildId === buildIdentity.buildId) {
          try {
            observation = await original.observeSignInStatus();
            if (
              desktopAdmission.closed() ||
              chatGptRoute() !== original ||
              !original.isCurrentSignInStatus(observation)
            )
              observation = { state: "unknown", binding: null };
          } catch {
            observation = { state: "unknown", binding: null };
          }
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
          evidence: {
            kind: "chatgpt.sign-in-status",
            observationId: command.observationId,
            buildId: command.buildId,
            ...observation,
          },
        });
      }
      case "chatgpt.verify": {
        setSetupSignInCheck(null);
        if (!chatGptRoute()) {
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        }
        const route = chatGptRoute()!;
        const observed = await route.observe();
        const recorded = await configuration()!.recordChatGptObservation(
          observed.state === "authenticated"
            ? {
                state: "authenticated",
                profile: "chatgpt.app-partition/1",
                runtimeGeneration: `${activeDesktopIdentity.chatGptPartition}:${buildIdentity.buildId}`,
                buildId: buildIdentity.buildId,
                protocol: "chatgpt-page-readiness/1",
              }
            : { state: observed.state },
        );
        if (recorded.ok && observed.state === "authenticated") {
          const observation = await route.observeSignInStatus();
          if (
            chatGptRoute() === route &&
            route.isCurrentSignInStatus(observation) &&
            observation.state === "authenticated" &&
            observation.binding !== null
          )
            setSetupSignInCheck({
              buildId: buildIdentity.buildId,
              binding: observation.binding,
            });
        }
        return ProductConfigurationResultSchema.parse({
          ...recorded,
          evidence: { kind: "chatgpt.readiness", ...observed },
        });
      }
      case "chatgpt.sign-in-return":
      case "chatgpt.verification-return": {
        if (embeddedBrowserEnabled()) {
          // This ends observation only. Renderer navigation conceals the retained
          // view; a later read or popup outcome cannot change that destination.
          const observingSignIn = chatGptRoute()?.returnFromSignIn() ?? false;
          // Readonly checks may already have ended sign-in mode. Explicit Return
          // still retires that observation generation without restoring layout.
          if (!observingSignIn) setChatGptSignInOpenGeneration(null);
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
        });
      }
    }
  }

  return Object.freeze({ configureSignin });
}
