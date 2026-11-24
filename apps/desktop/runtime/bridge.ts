import { lstat, mkdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow, MessageBoxOptions } from "electron";
import type { ChatGptRouteOptions } from "../../../src/apps/desktop/chatgpt-route";
import { canonicalChatGptConversationUrl } from "../../../src/apps/desktop/chatgpt-page-policy";
import type {
  CodexCallerRelayRuntime,
  startCodexCallerRelay,
} from "../../../src/apps/desktop/codex-caller-relay";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import {
  SavedChatBrowser,
  type SavedChatRouteFactory,
} from "../../../src/apps/desktop/saved-chat-browser";
import type { startSavedChatBridge } from "../../../src/apps/desktop/saved-chat-bridge";
import { savedChatPreviewQualified } from "../../../src/apps/desktop/saved-chat-preview-admission";
import { createCell } from "../host/cell";

// The caller relay and the saved-chat bridge: the two local endpoints main
// starts once the context is ready. Each handle, and the relay's directory
// witness, is read or written by main as well (Quit closes both, Route B reads
// the relay, the connector stop clears the bridge), so the owner exposes them
// as cells and main reads and writes through them at the same places it always
// did. Main keeps every other owner; each `let` there is a late getter here.
// Neither start retries: a failed start leaves the endpoint absent for this run.

export type CallerRelayDirectoryWitness = ReturnType<
  CodexCallerRelayRuntime["directoryWitness"]
>;

export type SavedChatBridgeRuntime = Awaited<
  ReturnType<typeof startSavedChatBridge>
>;

export type SavedChatApproval = (
  request: Readonly<{ key: string; title: string; firstMessage: string }>,
  requestDigest: string,
) => Promise<boolean>;

export type BridgePorts = Readonly<{
  statePaths: () => Readonly<{
    callerRelay: string;
    savedChatHandoff: string;
  }>;
  isolatedE2EHome: string | undefined;
  runtimeEnvironment: string;
  activeDesktopIdentity: Readonly<{
    chatGptPartition: NonNullable<ChatGptRouteOptions["partition"]>;
    displayName: string;
  }>;
  buildIdentity: Readonly<{ buildId: string }>;
  env: Readonly<Record<string, string | undefined>>;
  configuration: () => Pick<ProductConfigurationService, "snapshot"> | null;
  summaryExecutionFence: () => Readonly<{
    acquireAdmission: () => ReturnType<
      Parameters<typeof startSavedChatBridge>[1]
    >;
  }> | null;
  window: () => BrowserWindow | null;
  chatGptHomeUrl: () => string;
  chatGptE2eOrigin: () => string | null;
  createManagedChatGptRoute: SavedChatRouteFactory;
  showMessageBox: (
    window: BrowserWindow,
    options: MessageBoxOptions,
  ) => Promise<Readonly<{ response: number }>>;
  startCodexCallerRelay: typeof startCodexCallerRelay;
  startSavedChatBridge: typeof startSavedChatBridge;
  createSavedChatHandoff: (
    root: string,
    canonical: (url: string) => string | null,
    browser: SavedChatBrowser,
    approve: SavedChatApproval,
  ) => Parameters<typeof startSavedChatBridge>[0];
}>;

export function createBridge(ports: BridgePorts) {
  const {
    statePaths,
    isolatedE2EHome,
    runtimeEnvironment,
    activeDesktopIdentity,
    buildIdentity,
    env,
    configuration,
    summaryExecutionFence,
    window,
    chatGptHomeUrl,
    chatGptE2eOrigin,
    createManagedChatGptRoute,
    showMessageBox,
    startCodexCallerRelay,
    startSavedChatBridge,
    createSavedChatHandoff,
  } = ports;

  const relay = createCell<CodexCallerRelayRuntime | null>(null);
  const directoryWitness = createCell<CallerRelayDirectoryWitness | null>(null);
  const saved = createCell<SavedChatBridgeRuntime | null>(null);

  // The single-instance lock is held here, so a relay socket left in the
  // profile's short temporary directory belongs to a previous run of this same
  // profile.
  async function initializeCallerRelay(): Promise<void> {
    if (relay.get()) return;
    const root = statePaths().callerRelay;
    try {
      const stale = await lstat(path.join(root, "caller-relay.sock"));
      if (stale.isSocket() && stale.uid === process.getuid?.()) {
        await unlink(path.join(root, "caller-relay.sock"));
      }
    } catch {
      // No previous socket.
    }
    try {
      relay.set(
        await startCodexCallerRelay({
          root,
          ...(isolatedE2EHome !== undefined
            ? {
                onDirectoryPrepared: (witness) => {
                  directoryWitness.set(witness);
                },
              }
            : {}),
        }),
      );
    } catch {
      // Without the relay, Route B turns that offer host tools are refused.
      relay.set(null);
    }
  }

  async function initializeSavedChatBridge(): Promise<void> {
    if (saved.get()) return;
    // This opt-in is set by the owner when launching the disposable Dev preview.
    // Normal builds never advertise an account-writing MCP tool by default.
    const fence = summaryExecutionFence();
    if (!fence) return;
    const qualified = () => {
      const snapshot = configuration()?.snapshot();
      if (snapshot?.status !== "ready") return false;
      return savedChatPreviewQualified({
        environment: runtimeEnvironment,
        ownerOptIn: env.FAROL_SAVED_CHAT_PREVIEW,
        outcomeUnknown: snapshot.settings.setup.chatgpt.outcomeUnknown,
        verification: snapshot.settings.setup.chatgpt.verified,
        partition: activeDesktopIdentity.chatGptPartition,
        buildId: buildIdentity.buildId,
      });
    };
    if (!qualified()) return;
    const root = statePaths().savedChatHandoff;
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const info = await lstat(root);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        (await realpath(root)) !== path.resolve(root)
      )
        return;
      const canonical = (url: string) =>
        canonicalChatGptConversationUrl(url, chatGptE2eOrigin());
      const browser = new SavedChatBrowser(
        chatGptHomeUrl(),
        chatGptE2eOrigin(),
        createManagedChatGptRoute,
        {
          partition: activeDesktopIdentity.chatGptPartition,
          ...(runtimeEnvironment === "dev"
            ? { requiredAppName: activeDesktopIdentity.displayName }
            : {}),
        },
        Date.now,
        undefined,
        qualified,
      );
      saved.set(
        await startSavedChatBridge(
          createSavedChatHandoff(
            root,
            canonical,
            browser,
            async (request, requestDigest) => {
              if (!qualified()) return false;
              const owner = window();
              if (!owner || owner.isDestroyed()) return false;
              const { response } = await showMessageBox(owner, {
                type: "warning",
                buttons: ["Do not send", "Account checked — send once"],
                defaultId: 0,
                cancelId: 0,
                message: "Send this first message through Farol Browser?",
                detail: `Check the signed-in account in Farol Browser before approving. Farol cannot identify that account from this receipt.\n\nTitle: ${request.title}\nKey: ${request.key}\nDigest: ${requestDigest}\n\n${request.firstMessage}`,
              });
              return response === 1 && qualified();
            },
          ),
          () => fence.acquireAdmission(),
        ),
      );
    } catch {
      // The connector remains usable for Computer without Browser handoff.
      saved.set(null);
    }
  }

  return {
    relay,
    directoryWitness,
    saved,
    initializeCallerRelay,
    initializeSavedChatBridge,
  };
}
