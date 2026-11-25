import { BridgeError } from "../bridge/client";
import type { BrowserDriver } from "../bridge/browser";
import type { Context } from "../bridge/wire";
import type { createDesktopChatBrowser } from "../go-chat-host";
import type { GoChatBrowserDependencies } from "../go-chat-browser";
import {
  chatWorkerInitialUrl,
  type captureChatStartupProfile,
} from "../go-chat-startup-profile";
import type { DesktopBrowserConnection } from "../go-core-host";
import type { OperationsRecorder } from "../renderer/operations-contract";
import type {
  ChatGptRoute,
  ChatGptRouteOptions,
} from "../../../src/apps/desktop/chatgpt-route";

// The chat browser the Go core is started with: one physical assignment table
// per core connection, each worker view a dedicated hidden managed ChatGPT
// route for the exact Go-assigned target. Public control profiles still
// require native qualification before a production model may be admitted. The
// normal host owns this adapter: a missing profile cannot select the legacy
// browser executor instead. Main keeps every owner and the start call itself;
// the operations store, the startup profile, the ChatGPT home and the E2E
// origin are late getters read when a driver or a worker view is created,
// never copied. A route that does not confirm its open is unknown, never
// retried and never replaced by another route.

export type CoreBrowserPorts = Readonly<{
  createBrowser: typeof createDesktopChatBrowser;
  createDriver: (dependencies: GoChatBrowserDependencies) => BrowserDriver;
  partition: Parameters<typeof createDesktopChatBrowser>[0]["partition"];
  operationsStore: () => OperationsRecorder;
  startupProfile: () => ReturnType<typeof captureChatStartupProfile>;
  homeUrl: () => string;
  e2eOrigin: () => string | null;
  createRoute: (
    options: ChatGptRouteOptions,
  ) => Pick<ChatGptRoute, "open" | "chatPhysical">;
  displayProductName: string;
}>;

export function createCoreBrowser(
  ports: CoreBrowserPorts,
): (context: Readonly<Context>) => DesktopBrowserConnection {
  return (context) =>
    ports.createBrowser({
      context,
      partition: ports.partition,
      driver: (lookup) => {
        const profile = ports.startupProfile();
        return ports.createDriver({
          operations: ports.operationsStore(),
          lookup,
          translations: profile?.snapshot.translations ?? [],
          ...(profile ? { e2eOrigin: profile.origin } : {}),
        });
      },
      create: async (input) => {
        const initialUrl = chatWorkerInitialUrl(
          ports.homeUrl(),
          input.target.mode === "owned-saved"
            ? input.target.conversationId
            : undefined,
        );
        const route = ports.createRoute({
          ...(ports.startupProfile()?.route ?? {}),
          homeUrl: ports.homeUrl(),
          initialUrl,
          e2eOrigin: ports.e2eOrigin(),
          parent: () => null,
          windowPresentation: { mode: "hidden" },
          title: `ChatGPT · ${ports.displayProductName}`,
        });
        const opened = await route.open();
        if (opened.status !== "opened")
          throw new BridgeError(
            "unknown",
            "host_chat_browser_open_unconfirmed",
          );
        return route.chatPhysical();
      },
    });
}
