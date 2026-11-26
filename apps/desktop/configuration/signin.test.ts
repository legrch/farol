import { describe, expect, it, vi } from "vitest";
import { scriptedChatgptPorts } from "../../../tests/support/chatgpt-configuration-ports";
import {
  failureOf,
  sliceScene,
} from "../../../tests/support/chatgpt-configuration-slice";
import { createChatgptSignin } from "./signin";

// Command routing and effect order only; no real ChatGPT page is involved.
const buildId = "a".repeat(64);

function scene() {
  const base = sliceScene();
  const state = {
    route: null as unknown,
    generation: 4,
    openGeneration: null as number | null,
    embedded: true,
    check: "unset" as unknown,
  };
  const route = {
    openForSignIn: vi.fn(async (title: string): Promise<{ status: string }> => {
      base.events.push(`openForSignIn:${title}`);
      return { status: "opened" };
    }),
    observe: vi.fn(async () => ({ state: "authenticated", code: null })),
    observeSignInStatus: vi.fn(async () => ({
      state: "authenticated",
      binding: { documentGeneration: 7, sequence: 2 },
    })),
    isCurrentSignInStatus: vi.fn((_observation: unknown) => true),
    returnFromSignIn: vi.fn(() => false),
  };
  state.route = route;
  const ports = scriptedChatgptPorts({
    configuration: () => base.configuration as never,
    chatGptRoute: () => state.route as never,
    chatGptSignInGeneration: () => state.generation,
    setChatGptSignInGeneration: (value) => {
      state.generation = value;
      base.events.push(`generation:${value}`);
    },
    setChatGptSignInOpenGeneration: (value) => {
      state.openGeneration = value;
      base.events.push(`openGeneration:${value}`);
    },
    setChatGptSignInOutcome: () => {
      base.events.push("outcome:null");
    },
    setSetupSignInCheck: (value) => {
      state.check = value;
    },
    desktopAdmission: base.admission,
    chatGptSignInBlocked: {
      beginAttempt: () => {
        base.events.push("beginAttempt");
      },
    },
    buildIdentity: { buildId },
    activeDesktopIdentity: { chatGptPartition: "partition" },
    SIGN_IN_WINDOW_TITLE: "Sign in",
    configurationFailure: base.failure,
    embeddedBrowserEnabled: () => state.embedded,
    applyLayout: () => {
      base.events.push("applyLayout");
    },
  });
  return { ...base, state, route, handler: createChatgptSignin(ports) };
}

describe("signin slice", () => {
  it("refuses open-sign-in without a route before beginning an attempt", async () => {
    const s = scene();
    s.state.route = null;
    const result = await s.handler.configureSignin({
      kind: "chatgpt.open-sign-in",
    });
    expect(failureOf(result)).toBe("CHATGPT_ROUTE_UNAVAILABLE");
    expect(s.events).toEqual([]);
  });

  it("begins one attempt, opens the window and marks Setup visited", async () => {
    const s = scene();
    await s.handler.configureSignin({ kind: "chatgpt.open-sign-in" });
    expect(s.events).toEqual([
      "beginAttempt",
      "outcome:null",
      "generation:5",
      "openGeneration:5",
      "applyLayout",
      "openForSignIn:Sign in",
      "markSetupVisited:chatgpt",
    ]);
  });

  it("records an unreachable observation when the window cannot open", async () => {
    const s = scene();
    s.route.openForSignIn.mockRejectedValue(new Error("lost"));
    const result = await s.handler.configureSignin({
      kind: "chatgpt.open-sign-in",
    });
    expect(result).toMatchObject({
      ok: true,
      evidence: { state: "unreachable", code: "CHATGPT_PAGE_UNREACHABLE" },
    });
    expect(s.configuration.markSetupVisited).not.toHaveBeenCalled();
  });

  it("observes nothing for another build", async () => {
    const s = scene();
    const result = await s.handler.configureSignin({
      kind: "chatgpt.observe-sign-in",
      observationId: "00000000-0000-4000-8000-000000000001",
      buildId: "b".repeat(64),
    });
    expect(result).toMatchObject({
      ok: true,
      evidence: { state: "unknown", binding: null },
    });
    expect(s.route.observeSignInStatus).not.toHaveBeenCalled();
  });

  it("clears the Setup sign-in check even when the route is missing", async () => {
    const s = scene();
    s.state.route = null;
    const result = await s.handler.configureSignin({ kind: "chatgpt.verify" });
    expect(failureOf(result)).toBe("CHATGPT_ROUTE_UNAVAILABLE");
    expect(s.state.check).toBeNull();
  });

  it("retains the current sign-in binding after a recorded authenticated read", async () => {
    const s = scene();
    await s.handler.configureSignin({ kind: "chatgpt.verify" });
    expect(s.state.check).toEqual({
      buildId,
      binding: { documentGeneration: 7, sequence: 2 },
    });
  });

  it("retires the open generation when no observation is running", async () => {
    const s = scene();
    s.state.openGeneration = 3;
    await s.handler.configureSignin({ kind: "chatgpt.sign-in-return" });
    expect(s.state.openGeneration).toBeNull();
  });
});
