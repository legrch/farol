import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductSettingsSchema,
  type ProductConfigurationCommand,
} from "../../../src/pkg/product-settings/contract";
import { Folders, folderSetupByWindow } from "./folders";
import type { RendererFacade } from "../../../src/ui/renderer/contract";
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
const rootIdentity = { device: "1", inode: "2" };
function workspace(
  id: string,
  root: string,
  over: Record<string, unknown> = {},
) {
  return {
    workspaceId: id,
    root,
    label: root,
    access: "read" as const,
    excludedPaths: [],
    rootIdentity,
    accessCheck: {
      buildId,
      computerGeneration: 1,
      verifiedAt: "2026-10-02T20:00:00.000Z",
      rootIdentity,
    },
    ...over,
  };
}
const projectId = "22222222-2222-4222-8222-222222222222";
const scratchId = "44444444-4444-4444-8444-444444444444";
function setup({
  workspaces = [
    workspace(projectId, "/approved/project"),
    workspace(scratchId, "/approved/scratch", {
      accessCheck: null,
    }),
  ],
  allowed = true,
  pauseReason = null as string | null,
  commands,
}: {
  workspaces?: ReturnType<typeof workspace>[];
  allowed?: boolean;
  pauseReason?: string | null;
  commands?: Record<string, unknown>;
} = {}) {
  const value = settings();
  Object.assign(value.computer, { workspaces, ...commands });
  const snapshot = {
    environment: "preview",
    status: "current",
    runtime: "ready",
    buildId,
    destination: { area: "setup", setupStep: "folders" },
    evidence: null,
    intents: {},
    configuration: { status: "ready", settings: value },
  };
  const facade = {
    getSnapshot: () => snapshot,
  } as unknown as RendererFacade;
  const run = vi.fn(async (_command: ProductConfigurationCommand) => null);
  const runClassified = vi.fn(
    async (_command: ProductConfigurationCommand) => ({
      state: "not-sent" as const,
    }),
  );
  const actions = {
    allowed: () => allowed,
    run,
    runClassified,
    computerPauseReason: pauseReason,
    refresh: async () => null,
    disabled: false,
  } as unknown as Actions;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(Folders, {
        snapshot,
        facade,
        settings: value,
        actions,
      } as unknown as PageProps),
    ),
  );
  hosts.push({ unmount: () => root.unmount(), host });
  return { host, facade, run, runClassified };
}
const button = (host: ParentNode, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
const row = (host: HTMLElement, name: string) =>
  host.querySelector<HTMLElement>(`article[aria-label="Workspace ${name}"]`)!;

describe("Folders", () => {
  it("renders each approved folder with its saved check", () => {
    const { host } = setup();
    expect(
      host.querySelector(".setup-workspaces")?.getAttribute("aria-label"),
    ).toBe("Approved workspaces");
    const project = row(host, "project");
    expect(project.querySelector("strong")?.textContent).toBe("project");
    expect(project.querySelector("p")?.textContent).toBe("/approved/project");
    expect(project.querySelector(".setup-success")?.textContent).toBe(
      "✓ Works",
    );
    expect(button(project, "Re-check")).toBeTruthy();
    const scratch = row(host, "scratch");
    expect(scratch.querySelector(".setup-success")).toBeNull();
    expect(scratch.textContent).toContain(
      "Workspace access has not passed its check.",
    );
    expect(button(scratch, "Check access")).toBeTruthy();
    expect(button(host, "+ Add workspace").className).toBe("subtle");
  });
  it("shows the empty state with a primary add button", () => {
    const { host } = setup({ workspaces: [] });
    expect(host.querySelectorAll("article")).toHaveLength(0);
    expect(button(host, "+ Add workspace").className).toBe("primary");
    expect(host.textContent).toContain("Add a workspace to continue.");
  });
  it("shows the writable-by-others note only on a checked folder", () => {
    const flagged = workspace(projectId, "/approved/project");
    Object.assign(flagged.accessCheck!, { writableByOthers: true });
    const stale = workspace(scratchId, "/approved/scratch", {
      accessCheck: { ...flagged.accessCheck!, buildId: "9".repeat(64) },
    });
    const { host } = setup({ workspaces: [flagged, stale] });
    expect(
      row(host, "project").querySelector('p[role="note"]')?.textContent,
    ).toBe("Other users of this Mac can change files in this folder.");
    expect(row(host, "scratch").querySelector('[role="note"]')).toBeNull();
  });
  it("replaces the checks with the pause reason", () => {
    const { host } = setup({
      pauseReason: "Wait for the current check to finish.",
    });
    expect(host.textContent).not.toContain("✓ Works");
    expect(host.textContent).toContain("Wait for the current check to finish.");
    expect(button(row(host, "project"), "Check access")).toBeTruthy();
  });
  it("disables every control while the actions are not allowed", () => {
    const { host } = setup({ allowed: false });
    for (const control of host.querySelectorAll<
      HTMLButtonElement | HTMLSelectElement | HTMLInputElement
    >("button, select, input"))
      expect(control.disabled).toBe(true);
  });
  it("explains the command state of the profile", () => {
    const { host } = setup({
      commands: { commands: "verification" },
    });
    expect(host.textContent).toContain(
      "This profile currently allows Git checks only.",
    );
  });
  it("sends the folder picker, remove and verify commands", async () => {
    const { host, run, runClassified } = setup();
    await act(async () => button(host, "+ Add workspace").click());
    expect(run).toHaveBeenLastCalledWith({ kind: "computer.choose-workspace" });
    run.mockClear();
    await act(async () => button(host, "Remove scratch").click());
    expect(run).toHaveBeenCalledWith({
      kind: "computer.remove-workspace",
      workspaceId: scratchId,
    });
    await act(async () => button(row(host, "project"), "Re-check").click());
    expect(runClassified.mock.calls[0]![0]).toMatchObject({
      kind: "computer.verify-workspace",
      workspaceId: projectId,
    });
  });
  it("keeps one guided flow per window", () => {
    const { facade } = setup();
    const flow = folderSetupByWindow.get(facade);
    expect(flow?.busy).toBe(false);
    expect(flow?.access.requiresReadback()).toBe(false);
  });
});
