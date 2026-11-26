import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductSettingsSchema,
  type ProductConfigurationCommand,
} from "../../../src/pkg/product-settings/contract";
import type { RendererFacade } from "../../../src/ui/renderer/contract";
import { Connection } from "./connection";
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
const tunnelClient = {
  executablePath: "/approved/tunnel",
  executableSha256: "b".repeat(64),
  version: "1.0.0",
  protocol: "openai-tunnel-client/v1",
  verifiedAt: "2026-10-02T20:00:00.000Z",
} as const;
function setup({
  step = "connection" as PageProps["setupStep"],
  tunnelId = null as string | null,
  stored = false,
  client = true,
  allowed = true,
} = {}) {
  const value = settings();
  Object.assign(value.connectors.secureMcp, {
    tunnelId,
    credential: stored ? "stored" : "absent",
    tunnelClient: client ? tunnelClient : null,
  });
  const snapshot = {
    environment: "preview",
    status: "current",
    runtime: "ready",
    buildId,
    destination: { area: "setup", setupStep: step },
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
  const run = vi.fn(async (command: ProductConfigurationCommand) => ({
    id: `scripted:${command.kind}`,
    state: "applied" as const,
  }));
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
  const inputsChanged = vi.fn();
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(Connection, {
        snapshot,
        facade,
        settings: value,
        actions,
        setupStep: step,
        onSetupInputsChange: inputsChanged,
      } as unknown as PageProps),
    ),
  );
  hosts.push({ unmount: () => root.unmount(), host });
  return { host, run, inputsChanged };
}
const button = (host: ParentNode, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text);
const inputs = (host: HTMLElement) =>
  host.querySelectorAll<HTMLInputElement>(".connection-credentials input");
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const kinds = (run: ReturnType<typeof setup>["run"]) =>
  run.mock.calls.map(([command]) => command.kind);

describe("Connection", () => {
  it("renders the page for the selected setup step", () => {
    expect(setup().host.querySelector("h3")?.textContent).toBe(
      "1. Create a tunnel and a key",
    );
    expect(
      setup({ step: "signin" }).host.querySelector(
        'section[aria-label="ChatGPT sign-in"]',
      ),
    ).toBeTruthy();
    expect(
      setup({
        step: "attachment",
        tunnelId: "synthetic-tunnel",
      }).host.querySelector("h3")?.textContent,
    ).toBe("1. Add your app in ChatGPT");
  });
  it("opens the OpenAI Tunnels help page", async () => {
    const { host, run } = setup();
    await act(async () => button(host, "Open OpenAI Tunnels")!.click());
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual({
      kind: "onboarding.open-help",
      destination: "tunnels",
    });
  });
  it("keeps Connect disabled and explains an invalid tunnel ID", async () => {
    const { host, run, inputsChanged } = setup();
    expect(button(host, "Connect")!.disabled).toBe(true);
    await type(inputs(host)[0]!, "bad tunnel");
    expect(inputsChanged).toHaveBeenLastCalledWith(true);
    expect(host.textContent).toContain(
      "Copy the complete tunnel ID from OpenAI Tunnels, without spaces.",
    );
    expect(button(host, "Connect")!.disabled).toBe(true);
    await act(async () => button(host, "Connect")!.click());
    expect(run).not.toHaveBeenCalled();
  });
  it("saves the key, connects and checks health, then clears the key", async () => {
    const { host, run } = setup();
    await type(inputs(host)[0]!, "synthetic-tunnel");
    await type(inputs(host)[1]!, "synthetic-key-do-not-retain");
    await act(async () => button(host, "Connect")!.click());
    expect(kinds(run)).toEqual([
      "connector.save-and-connect",
      "connector.check-health",
    ]);
    expect(run.mock.calls[0]![0]).toMatchObject({
      kind: "connector.save-and-connect",
      buildId,
      tunnelId: "synthetic-tunnel",
      runtimeKey: "synthetic-key-do-not-retain",
    });
    expect(inputs(host)[1]!.value).toBe("");
  });
  it("discovers the helper first when none is saved", async () => {
    const { host, run } = setup({ client: false });
    await type(inputs(host)[0]!, "synthetic-tunnel");
    await type(inputs(host)[1]!, "synthetic-key-do-not-retain");
    await act(async () => button(host, "Connect")!.click());
    expect(kinds(run)).toEqual(["connector.discover-client"]);
  });
  it("starts a stored connection and then checks its health", async () => {
    const { host, run } = setup({ tunnelId: "synthetic-tunnel", stored: true });
    expect(inputs(host)[0]!.value).toBe("synthetic-tunnel");
    await act(async () => button(host, "Connect")!.click());
    expect(kinds(run)).toEqual(["connector.start", "connector.check-health"]);
  });
  it("stops after a command that is not applied", async () => {
    const { host, run } = setup({ tunnelId: "synthetic-tunnel", stored: true });
    run.mockResolvedValueOnce({ id: "scripted", state: "refused" as never });
    await act(async () => button(host, "Connect")!.click());
    expect(kinds(run)).toEqual(["connector.start"]);
  });
  it("offers Open ChatGPT when the sign-in status is unknown", async () => {
    const { host, run } = setup({ step: "signin" });
    expect(host.textContent).toContain(
      "Sign in to your ChatGPT account, then return here.",
    );
    await act(async () => button(host, "Open ChatGPT")!.click());
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual({ kind: "chatgpt.open-browser" });
  });
});
