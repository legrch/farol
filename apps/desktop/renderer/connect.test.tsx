import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductSettingsSchema,
  type ProductConfigurationCommand,
} from "../../../src/pkg/product-settings/contract";
import type { RendererFacade } from "../../../src/ui/renderer/contract";
import { AddToChatGPT } from "./connect";
import type { Actions, PageProps } from "./page";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const hosts: { unmount(): void; host: HTMLElement }[] = [];
afterEach(() => {
  for (const m of hosts.splice(0)) {
    act(() => m.unmount());
    m.host.remove();
  }
});
const readiness = {
  visited: false,
  skipped: false,
  configured: false,
  reachable: "unknown",
  verified: null,
  needsAction: null,
  unavailable: null,
  outcomeUnknown: false,
};
const settings = () =>
  structuredClone(
    ProductSettingsSchema.parse({
      schema: 1,
      revision: 1,
      general: {
        openAtLaunch: "browser",
        sidebarDefault: "full",
        activityDetail: "summary",
      },
      computer: {
        computerId: "11111111-1111-4111-8111-111111111111",
        generation: 1,
        name: "This Mac",
        workspaces: [],
      },
      setup: {
        chatgpt: readiness,
        computer: readiness,
        connect: readiness,
        hosts: readiness,
        verify: readiness,
      },
    }),
  );
const buildId = "3".repeat(64);
function setup({
  environment = "preview",
  tunnelId = "synthetic-tunnel" as string | null,
  appName = null as string | null,
  dismissed = false,
  allowed = true,
  testHost = false,
}: {
  environment?: "preview" | "dev" | "owner-preview";
  tunnelId?: string | null;
  appName?: string | null;
  dismissed?: boolean;
  allowed?: boolean;
  testHost?: boolean;
} = {}) {
  const value = settings();
  value.connectors.secureMcp.tunnelId = tunnelId;
  if (appName && tunnelId)
    value.connectors.secureMcp.chatgptApp = {
      name: appName,
      tunnelId,
      connectorGeneration: 1,
    };
  value.setup.journey.dismissed = dismissed;
  const snapshot = {
    environment,
    status: "current",
    runtime: "ready",
    buildId,
    destination: { area: "setup", setupStep: "attachment" },
    evidence: null,
    activity: [],
    update: { phase: "idle" },
    intents: {},
    configuration: { status: "ready", settings: value },
  };
  const facade = {
    getSnapshot: () => snapshot,
    navigate: vi.fn(),
  } as unknown as RendererFacade;
  const run = vi.fn(async (_command: ProductConfigurationCommand) => null);
  const actions = {
    allowed: () => allowed,
    run,
    runClassified: vi.fn(),
    computerPauseReason: null,
    refresh: async () => null,
    disabled: false,
  } as unknown as Actions;
  const host = document.createElement("div");
  document.body.append(host);
  const testActionHost = document.createElement("div");
  document.body.append(testActionHost);
  const inputsChanged = vi.fn();
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(AddToChatGPT, {
        snapshot,
        facade,
        settings: value,
        actions,
        setupStep: "attachment",
        setupTestActionHost: testHost ? testActionHost : null,
        onSetupInputsChange: inputsChanged,
      } as unknown as PageProps),
    ),
  );
  hosts.push({
    unmount: () => root.unmount(),
    host: Object.assign(host, { remove: () => testActionHost.remove() }),
  });
  return { host, testActionHost, run, inputsChanged };
}
const button = (host: ParentNode, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text);
const field = (host: HTMLElement) =>
  host.querySelector<HTMLInputElement>('[aria-label="ChatGPT app name"]')!;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AddToChatGPT", () => {
  it("names the app and its tunnel", () => {
    const { host } = setup();
    expect(field(host).value).toBe("Farol");
    expect(host.querySelector("dl.setup-app-values")?.textContent).toContain(
      "Tunnel · synthetic-tunnel",
    );
    expect(host.querySelector("h3")?.textContent).toBe(
      "1. Add your app in ChatGPT",
    );
  });
  it.each([
    ["dev", "Farol Dev"],
    ["owner-preview", "Farol Preview"],
  ] as const)("defaults the %s environment to %s", (environment, name) => {
    expect(field(setup({ environment }).host).value).toBe(name);
  });
  it("keeps the selected app name", () => {
    expect(field(setup({ appName: "Farol Dev" }).host).value).toBe("Farol Dev");
  });
  it("reports an edited name and sends the selection from Save app name", async () => {
    const { host, run, inputsChanged } = setup();
    expect(button(host, "Save app name")).toBeUndefined();
    await type(field(host), "Farol Dev");
    expect(inputsChanged).toHaveBeenLastCalledWith(true);
    await act(async () => button(host, "Save app name")!.click());
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual({
      kind: "connector.select-chatgpt-app",
      name: "Farol Dev",
      tunnelId: "synthetic-tunnel",
      connectorGeneration: 1,
    });
  });
  it("refuses to save an invalid name", async () => {
    const { host, run } = setup();
    await type(field(host), "-bad");
    expect(host.textContent).toContain(
      "Enter 1–64 letters, numbers, spaces, periods, underscores or hyphens.",
    );
    expect(button(host, "Save app name")!.disabled).toBe(true);
    await act(async () => button(host, "Save app name")!.click());
    expect(run).not.toHaveBeenCalled();
  });
  it("opens the ChatGPT Apps help page", async () => {
    const { host, run } = setup();
    await act(async () => button(host, "Open ChatGPT Apps")!.click());
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual({
      kind: "onboarding.open-help",
      destination: "chatgpt",
    });
  });
  it("places the Test action in the setup footer host", () => {
    const { host, testActionHost } = setup({ testHost: true });
    expect(button(testActionHost, "Test in ChatGPT")?.className).toBe(
      "primary",
    );
    expect(button(host, "Test in ChatGPT")).toBeUndefined();
  });
  it("blocks the Test action and the name field while commands are not allowed", () => {
    const { host, testActionHost } = setup({ allowed: false, testHost: true });
    expect(field(host).disabled).toBe(true);
    expect(button(testActionHost, "Test in ChatGPT")!.disabled).toBe(true);
  });
  it("shows the saved-setup headings once Setup is completed", () => {
    const { host } = setup({ dismissed: true, appName: "Farol" });
    expect([...host.querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
      "Your ChatGPT app",
      "Connection test",
    ]);
  });
});
