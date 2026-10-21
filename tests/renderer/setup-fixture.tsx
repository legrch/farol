import { StrictMode, act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, vi } from "vitest";
import { Setup } from "../../src/ui/renderer/setup";
import { Settings } from "../../src/ui/renderer/settings";
import { Shell } from "../../src/ui/renderer/shell";
import { Services } from "../../src/ui/renderer/services";
import { WindowController } from "../../src/ui/renderer/controller";
import {
  ProductSettingsSchema,
  type ProductSettings,
  type ProductConfigurationCommand,
} from "../../src/pkg/product-settings/contract";
import type { SetupStep, SettingsPage } from "../../src/ui/renderer/contract";
import { bootstrap, fixture, settings, signInReply } from "./fixture";

// Scripted renderer/IPC evidence only: no native filesystem, account or tunnel.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
export const workspaceId = "22222222-2222-4222-8222-222222222222";
export const selectionId = "33333333-3333-4333-8333-333333333333";
export const buildId = "3".repeat(64);
export function readySettings(attachment = false) {
  const value = settings();
  const runtimeGeneration = "a".repeat(64);
  const verifiedAt = "2026-10-02T20:00:00.000Z";
  const rootIdentity = { device: "1", inode: "2" };
  value.computer.workspaces = [
    {
      workspaceId,
      root: "/approved/project",
      label: "Project",
      access: "read",
      excludedPaths: [],
      rootIdentity,
      accessCheck: { buildId, computerGeneration: 1, verifiedAt, rootIdentity },
    },
  ];
  const witness = {
    profile: "farol",
    configRevision: 1,
    workspaceId,
    runtimeGeneration,
    buildId,
    protocol: "secure-mcp",
    verifiedAt,
  };
  value.setup.computer.verified = witness;
  value.setup.computer.reachable = "reachable";
  value.setup.chatgpt.verified = witness;
  value.setup.chatgpt.reachable = "reachable";
  value.setup.chatgpt.configured = true;
  Object.assign(value.connectors.secureMcp, {
    tunnelId: "synthetic-tunnel",
    credential: "stored",
    tunnelClient: {
      executablePath: "/approved/tunnel",
      executableSha256: "b".repeat(64),
      version: "1.0.0",
      protocol: "openai-tunnel-client/v1",
      verifiedAt,
    },
    runtime: {
      state: "ready",
      connectorGeneration: 1,
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      observedAt: verifiedAt,
    },
    challenge: {
      value: selectionId,
      challengeSha256: "c".repeat(64),
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      preparedAt: verifiedAt,
    },
  });
  if (attachment) {
    value.setup.connect.verified = witness;
    value.setup.connect.reachable = "reachable";
    value.connectors.secureMcp.attachment = {
      tunnelId: "synthetic-tunnel",
      workspaceId,
      connectorGeneration: 1,
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      challengeSha256: "c".repeat(64),
      receiptSha256: "d".repeat(64),
      verifiedAt,
    };
    value.connectors.secureMcp.challenge = null;
  }
  return ProductSettingsSchema.parse(value);
}
export async function mount({
  step = "overview",
  page,
  value = settings(),
  shell = false,
  signIn = "signed_out",
}: {
  step?: SetupStep;
  page?: SettingsPage;
  value?: ProductSettings;
  shell?: boolean;
  signIn?: "authenticated" | "signed_out" | "unknown";
} = {}) {
  const f = fixture();
  let saved = value;
  const configuration = () => ({ status: "ready" as const, settings: saved });
  vi.mocked(f.api.bootstrap).mockImplementation(async () => ({
    ...bootstrap(),
    configuration: configuration(),
  }));
  vi.mocked(f.api.configure).mockImplementation(async (command) =>
    command.kind === "chatgpt.observe-sign-in"
      ? signInReply(command, signIn, configuration())
      : { ok: true, snapshot: configuration() },
  );
  const c = new WindowController(f.api);
  await c.start();
  c.navigate(
    page ? { area: "settings", page } : { area: "setup", setupStep: step },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function View() {
    const snapshot = useSyncExternalStore(c.subscribe, c.getSnapshot);
    return shell ? (
      <Services value={c}>
        <Shell />
      </Services>
    ) : snapshot.destination.area === "setup" ? (
      <Setup snapshot={snapshot} facade={c} />
    ) : (
      <Settings snapshot={snapshot} facade={c} />
    );
  }
  async function render() {
    await act(async () =>
      root.render(
        <StrictMode>
          <View />
        </StrictMode>,
      ),
    );
  }
  await render();
  cleanup.push(async () => {
    await act(async () => root.unmount());
    c.dispose();
  });
  const visible = (element: Element) => !element.closest("[hidden]");
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (e) =>
        visible(e) &&
        (e.textContent?.trim() === label ||
          e.getAttribute("aria-label") === label),
    );
  async function click(label: string) {
    const target = button(label);
    expect(target, `button ${label}`).toBeTruthy();
    await act(async () => target!.click());
  }
  async function navigate(step: SetupStep) {
    await act(async () => c.navigate({ area: "setup", setupStep: step }));
  }
  async function publish(value: ProductSettings) {
    saved = ProductSettingsSchema.parse(value);
    await act(async () => f.emit("configuration", configuration()));
  }
  function reply(
    handler: (
      command: ProductConfigurationCommand,
    ) => unknown | Promise<unknown>,
  ) {
    vi.mocked(f.api.configure).mockImplementation(async (command) =>
      command.kind === "chatgpt.observe-sign-in"
        ? signInReply(command, signIn, configuration())
        : handler(command),
    );
  }
  async function remount() {
    await act(async () => root.render(null));
    await render();
  }
  return {
    f,
    c,
    host,
    button,
    click,
    navigate,
    publish,
    reply,
    remount,
    visible,
    configuration,
  };
}
export async function change(
  field: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      field instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(field, value);
    field.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
