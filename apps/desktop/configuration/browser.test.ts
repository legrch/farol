import { describe, expect, it, vi } from "vitest";
import { scriptedChatgptPorts } from "../../../tests/support/chatgpt-configuration-ports";
import {
  failureOf,
  sliceScene,
} from "../../../tests/support/chatgpt-configuration-slice";
import { createChatgptBrowser } from "./browser";

// Command routing and effect order only; no real ChatGPT page is involved.
function scene() {
  const base = sliceScene();
  const state = {
    route: null as unknown,
    embedded: true,
    openGeneration: null as number | null,
    taskId: "",
    homeOpen: false,
    liveRoutes: new Map<string, unknown>(),
  };
  const route = {
    open: vi.fn(async (): Promise<{ status: string }> => {
      base.events.push("open");
      return { status: "opened" };
    }),
    retryFailedOpen: vi.fn(async (): Promise<{ status: string }> => {
      base.events.push("retryFailedOpen");
      return { status: "opened" };
    }),
    toggleSidebar: vi.fn(async () => true),
  };
  state.route = route;
  const ports = scriptedChatgptPorts({
    configuration: () => base.configuration as never,
    chatGptRoute: () => state.route as never,
    chatGptSignInOpenGeneration: () => state.openGeneration,
    selectedTaskId: () => state.taskId,
    browserHomeSurfaceOpen: () => state.homeOpen,
    setBrowserHomeSurfaceOpen: (value) => {
      state.homeOpen = value;
      base.events.push(`home:${value}`);
    },
    desktopAdmission: base.admission,
    liveTaskRoutes: state.liveRoutes as never,
    configurationFailure: base.failure,
    embeddedBrowserEnabled: () => state.embedded,
    applyLayout: () => {
      base.events.push("applyLayout");
    },
  });
  return { ...base, state, route, handler: createChatgptBrowser(ports) };
}

describe("browser slice", () => {
  it("applies the layout, then refuses an occupied chat lane on present", async () => {
    const s = scene();
    const lane = s.admission.reserveAdmitted("chatgpt-task");
    const result = await s.handler.configureBrowser({
      kind: "chatgpt.present-browser",
    });
    lane.release();
    expect(failureOf(result)).toBe("CHATGPT_TASK_IN_PROGRESS");
    expect(s.events).toEqual(["applyLayout"]);
  });

  it("reveals a retained sign-in surface without opening the home route", async () => {
    const s = scene();
    s.state.openGeneration = 2;
    const result = await s.handler.configureBrowser({
      kind: "chatgpt.present-browser",
    });
    expect(result).toMatchObject({ ok: true });
    expect(s.route.open).not.toHaveBeenCalled();
  });

  it("opens once on present and reports an unreachable page", async () => {
    const s = scene();
    s.route.open.mockResolvedValue({ status: "unreachable" });
    const result = await s.handler.configureBrowser({
      kind: "chatgpt.present-browser",
    });
    expect(failureOf(result)).toBe("CHATGPT_PAGE_UNREACHABLE");
    expect(s.route.open).toHaveBeenCalledTimes(1);
    expect(s.events).toEqual(["applyLayout", "applyLayout"]);
  });

  it("refuses open-browser during an open sign-in before checking the lanes", async () => {
    const s = scene();
    s.state.openGeneration = 1;
    const result = await s.handler.configureBrowser({
      kind: "chatgpt.open-browser",
    });
    expect(failureOf(result)).toBe("CHATGPT_SIGN_IN_IN_PROGRESS");
  });

  it("selects the home surface, applies the layout and retries the failed open once", async () => {
    const s = scene();
    await s.handler.configureBrowser({ kind: "chatgpt.open-browser" });
    expect(s.events).toEqual(["home:true", "applyLayout", "retryFailedOpen"]);
  });

  it("toggles the live route of the selected task", async () => {
    const s = scene();
    const live = { toggleSidebar: vi.fn(async () => false) };
    s.state.taskId = "task-1";
    s.state.liveRoutes.set("task-1", live);
    const result = await s.handler.configureBrowser({
      kind: "chatgpt.toggle-sidebar",
    });
    expect(failureOf(result)).toBe("CHATGPT_PAGE_UNREACHABLE");
    expect(s.route.toggleSidebar).not.toHaveBeenCalled();
  });

  it("toggles the home route while the home surface is open without a task", async () => {
    const s = scene();
    s.state.homeOpen = true;
    const result = await s.handler.configureBrowser({
      kind: "chatgpt.toggle-sidebar",
    });
    expect(result).toMatchObject({ ok: true });
    expect(s.route.toggleSidebar).toHaveBeenCalledTimes(1);
  });
});
