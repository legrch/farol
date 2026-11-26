import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import type {
  ConfigurationChatgptPorts,
  ChatgptConfigurationCommand,
} from "./ports";

type BrowserCommand = Extract<
  ChatgptConfigurationCommand,
  {
    kind:
      | "chatgpt.present-browser"
      | "chatgpt.open-browser"
      | "chatgpt.toggle-sidebar";
  }
>;

export type BrowserPorts = Pick<
  ConfigurationChatgptPorts,
  | "configuration"
  | "chatGptRoute"
  | "chatGptSignInOpenGeneration"
  | "selectedTaskId"
  | "browserHomeSurfaceOpen"
  | "setBrowserHomeSurfaceOpen"
  | "desktopAdmission"
  | "liveTaskRoutes"
  | "configurationFailure"
  | "embeddedBrowserEnabled"
  | "applyLayout"
>;

export function createChatgptBrowser(ports: BrowserPorts) {
  const {
    configuration,
    chatGptRoute,
    chatGptSignInOpenGeneration,
    selectedTaskId,
    browserHomeSurfaceOpen,
    setBrowserHomeSurfaceOpen,
    desktopAdmission,
    liveTaskRoutes,
    configurationFailure,
    embeddedBrowserEnabled,
    applyLayout,
  } = ports;

  async function configureBrowser(
    command: BrowserCommand,
  ): Promise<ProductConfigurationResult> {
    switch (command.kind) {
      case "chatgpt.present-browser": {
        if (!embeddedBrowserEnabled() || !chatGptRoute())
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        applyLayout();
        if (desktopAdmission.occupied("chatgpt-task"))
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        // Task and sign-in surfaces already have their own retained identities.
        // Navigation must reveal them, never replace them with the home route.
        if (chatGptSignInOpenGeneration() !== null || selectedTaskId() !== "")
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration()!.snapshot(),
          });
        let opened: Awaited<ReturnType<ChatGptRoute["open"]>>;
        try {
          // open() joins an in-flight open or retains the existing document. It
          // creates only an absent surface and never discards a failed one.
          opened = await chatGptRoute()!.open();
        } catch {
          opened = { status: "unreachable" };
        }
        // Route failure may conceal its page. Reapply current shell ownership so
        // a retained failed home document remains accessible without retrying it.
        applyLayout();
        if (opened.status !== "opened")
          return configurationFailure("CHATGPT_PAGE_UNREACHABLE");
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
        });
      }
      case "chatgpt.open-browser": {
        if (!embeddedBrowserEnabled() || !chatGptRoute()) {
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        }
        if (chatGptSignInOpenGeneration() !== null) {
          return configurationFailure("CHATGPT_SIGN_IN_IN_PROGRESS");
        }
        if (
          desktopAdmission.occupied("chatgpt-task") ||
          desktopAdmission.occupied("connector-task")
        ) {
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        }
        setBrowserHomeSurfaceOpen(true);
        applyLayout();
        let opened: Awaited<ReturnType<ChatGptRoute["open"]>>;
        try {
          opened = await chatGptRoute()!.retryFailedOpen();
        } catch {
          opened = { status: "unreachable" };
        }
        if (opened.status !== "opened") {
          applyLayout();
          return configurationFailure("CHATGPT_PAGE_UNREACHABLE");
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
        });
      }
      case "chatgpt.toggle-sidebar": {
        const visibleRoute =
          browserHomeSurfaceOpen() && selectedTaskId() === ""
            ? chatGptRoute()
            : liveTaskRoutes.get(selectedTaskId());
        if (!embeddedBrowserEnabled() || !visibleRoute) {
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        }
        if (!(await visibleRoute.toggleSidebar())) {
          return configurationFailure("CHATGPT_PAGE_UNREACHABLE");
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
        });
      }
    }
  }

  return Object.freeze({ configureBrowser });
}
