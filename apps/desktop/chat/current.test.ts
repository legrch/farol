import { describe, expect, it } from "vitest";
import { readonlyAccountCurrent, type ReadonlyAccountPorts } from "./current";

// The pending read-only task's currency check over plain owners: it holds only
// while the same pending task, route and core are current, admission has not
// expired and the settings still carry the same verification and workspace.

const verification = { buildId: "build-1", verified: "same" };
const pending = {
  goAdmission: {},
  workspaceId: "workspace-1",
  computerGeneration: 3,
  expiresAt: 2_000,
  chatGptVerification: verification,
} as never;
const route = {} as never;
const core = {} as never;

function settings(change: Record<string, unknown> = {}) {
  return {
    status: "ready",
    settings: {
      setup: {
        chatgpt: { outcomeUnknown: false, verified: verification },
        computer: {
          verified: { workspaceId: "workspace-1", configRevision: 3 },
        },
      },
      computer: {
        generation: 3,
        workspaces: [{ workspaceId: "workspace-1" }],
      },
      ...change,
    },
  };
}

function check(overrides: Partial<ReadonlyAccountPorts> = {}) {
  return readonlyAccountCurrent({
    configuration: () => ({ snapshot: () => settings() }) as never,
    pendingTask: () => pending,
    chatGptRoute: () => route,
    desktopGoCore: () => core,
    buildId: "build-1",
    now: () => 1_000,
    ...overrides,
  })(pending, route, core);
}

describe("readonlyAccountCurrent", () => {
  it("holds while everything still matches", () => {
    expect(check()).toBe(true);
  });

  it.each([
    ["another pending task", { pendingTask: () => ({}) as never }],
    ["another route", { chatGptRoute: () => ({}) as never }],
    ["another core", { desktopGoCore: () => ({}) as never }],
    ["an expired admission", { now: () => 2_000 }],
    ["another build", { buildId: "build-2" }],
    ["no configuration", { configuration: () => null }],
    [
      "unavailable settings",
      { configuration: () => ({ snapshot: () => ({ status: "x" }) }) as never },
    ],
  ])("fails for %s", (_name, overrides) => {
    expect(check(overrides)).toBe(false);
  });

  it("fails when the settings moved on", () => {
    const owner = (value: unknown) => ({
      configuration: () => ({ snapshot: () => value }) as never,
    });
    expect(
      check(
        owner(
          settings({
            computer: {
              generation: 4,
              workspaces: [{ workspaceId: "workspace-1" }],
            },
          }),
        ),
      ),
    ).toBe(false);
    expect(
      check(owner(settings({ computer: { generation: 3, workspaces: [] } }))),
    ).toBe(false);
  });

  it("fails without a Go admission", () => {
    expect(
      readonlyAccountCurrent({
        configuration: () => ({ snapshot: () => settings() }) as never,
        pendingTask: () =>
          ({ ...(pending as object), goAdmission: undefined }) as never,
        chatGptRoute: () => route,
        desktopGoCore: () => core,
        buildId: "build-1",
        now: () => 1_000,
      })(
        { ...(pending as object), goAdmission: undefined } as never,
        route,
        core,
      ),
    ).toBe(false);
  });
});
