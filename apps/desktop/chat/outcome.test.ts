import { describe, expect, it } from "vitest";
import {
  chatGptAdmissionReady,
  signInOutcomeRecorder,
  type SignInOutcomePorts,
} from "./outcome";

// The sign-in outcome recorder over recording owners: what it writes, what it
// never writes, and where it sends the owner afterwards.

function ports(log: unknown[], overrides: Partial<SignInOutcomePorts> = {}) {
  const owners: SignInOutcomePorts = {
    configuration: () => ({
      recordChatGptObservation: (...args: unknown[]) => {
        log.push(["record", ...args]);
        return Promise.resolve({ ok: true });
      },
    }),
    chatGptPartition: "persist:partition",
    buildId: "build-1",
    runtimeEnvironment: "production",
    setupOpen: () => false,
    section: () => "browser",
    publishShellAction: (...args) => void log.push(["publish", ...args]),
    ...overrides,
  } as SignInOutcomePorts;
  return owners;
}

describe("signInOutcomeRecorder", () => {
  it("records an authenticated page against this build and returns to Settings", async () => {
    const log: unknown[] = [];
    await signInOutcomeRecorder(ports(log))(4, "authenticated");
    expect(log).toEqual([
      [
        "record",
        {
          state: "authenticated",
          profile: "chatgpt.app-partition/1",
          runtimeGeneration: "persist:partition:build-1",
          buildId: "build-1",
          protocol: "chatgpt-page-readiness/1",
        },
        true,
      ],
      ["publish", "open-settings", "auth-window-closed", 4],
    ]);
  });

  it("records a signed-out page and writes nothing for unknown", async () => {
    const signedOut: unknown[] = [];
    await signInOutcomeRecorder(ports(signedOut))(null, "not_authenticated");
    expect(signedOut[0]).toEqual(["record", { state: "signed_out" }, true]);
    const unknown: unknown[] = [];
    await signInOutcomeRecorder(ports(unknown))(1, "unknown");
    expect(unknown).toEqual([
      ["publish", "open-settings", "auth-window-closed", 1],
    ]);
  });

  it("still publishes when the record fails or no configuration exists", async () => {
    const failed: unknown[] = [];
    await signInOutcomeRecorder(
      ports(failed, {
        configuration: () =>
          ({
            recordChatGptObservation: () => Promise.reject(new Error("x")),
          }) as never,
      }),
    )(2, "authenticated");
    expect(failed).toEqual([
      ["publish", "open-settings", "auth-window-closed", 2],
    ]);
    const absent: unknown[] = [];
    await signInOutcomeRecorder(ports(absent, { configuration: () => null }))(
      3,
      "authenticated",
    );
    expect(absent).toEqual([
      ["publish", "open-settings", "auth-window-closed", 3],
    ]);
  });

  it.each([
    ["dev", { runtimeEnvironment: "dev" }],
    ["open Setup", { setupOpen: () => true }],
    ["the computer section", { section: () => "computer" }],
  ])("returns into Setup in %s", async (_name, overrides) => {
    const log: unknown[] = [];
    await signInOutcomeRecorder(ports(log, overrides))(5, "unknown");
    expect(log).toEqual([
      ["publish", "sign-in-returned", "auth-window-closed", 5],
    ]);
  });
});

describe("chatGptAdmissionReady", () => {
  const ready = {
    status: "ready",
    settings: {
      setup: {
        chatgpt: {
          reachable: "reachable",
          configured: true,
          outcomeUnknown: false,
          verified: {},
        },
      },
    },
  };
  const owner = (value: unknown) => ({ snapshot: () => value }) as never;

  it("admits only a reachable, configured, known and verified setup", () => {
    expect(chatGptAdmissionReady(owner(ready))).toBe(true);
    expect(chatGptAdmissionReady(null)).toBe(false);
    expect(chatGptAdmissionReady(owner({ status: "unavailable" }))).toBe(false);
    const withChatgpt = (change: object) =>
      owner({
        ...ready,
        settings: {
          setup: { chatgpt: { ...ready.settings.setup.chatgpt, ...change } },
        },
      });
    for (const change of [
      { reachable: "unreachable" },
      { configured: false },
      { outcomeUnknown: true },
      { verified: null },
    ])
      expect(chatGptAdmissionReady(withChatgpt(change))).toBe(false);
  });
});
