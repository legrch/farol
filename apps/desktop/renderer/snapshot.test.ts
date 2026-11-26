import { describe, expect, it } from "vitest";
import type {
  Intent,
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import { bootstrap } from "../../../tests/renderer/fixture";
import {
  BootstrapProjectionSchema,
  canSetInstallOnQuitPreference,
  home,
  initial,
  installOnQuitPreferenceEligible,
} from "./snapshot";
import { defaultSidebarPreference } from "./sidebar-presentation";

const confirmedPreference = {
  status: "confirmed" as const,
  scope: "install-on-normal-quit" as const,
  enabled: false,
};
function eligible(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    ...initial,
    environment: "preview",
    status: "current",
    runtime: "ready",
    buildId: "3".repeat(64),
    update: {
      phase: "idle",
      checkedAt: null,
      installOnQuitPreference: confirmedPreference,
    },
    ...overrides,
  };
}
const applied: Intent = {
  id: "update-install-on-quit",
  state: "applied",
  code: null,
};
const capable: RendererFacade = Object.assign(Object.create(null), {
  setInstallOnQuitPreference: async (): Promise<Intent> => applied,
});
const observationOnly: RendererFacade = Object.create(null);

describe("BootstrapProjectionSchema", () => {
  it("accepts the renderer-safe projection and defaults the selected task", () => {
    const parsed = BootstrapProjectionSchema.safeParse(bootstrap());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.selectedTaskId).toBe("");
    expect(parsed.data.schema).toBe(3);
    expect(parsed.data.independentSession).toBeUndefined();
  });
  it("accepts every environment and keeps optional context", () => {
    for (const environment of ["preview", "dev", "owner-preview"] as const) {
      const parsed = BootstrapProjectionSchema.safeParse({
        ...bootstrap(),
        environment,
        independentSession: true,
        selectedTaskId: "task-1",
        chatHistoryContext: null,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.environment).toBe(environment);
        expect(parsed.data.selectedTaskId).toBe("task-1");
        expect(parsed.data.independentSession).toBe(true);
        expect(parsed.data.chatHistoryContext).toBeNull();
      }
    }
  });
  it("carries the retained credential recovery as an optional pair", () => {
    for (const credentialRecovery of [
      undefined,
      null,
      { generation: 3, revision: 5, tunnelId: "replacement-7" },
      { generation: 3, revision: 5, tunnelId: null },
    ]) {
      const parsed = BootstrapProjectionSchema.safeParse({
        ...bootstrap(),
        credentialRecovery,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success)
        expect(parsed.data.credentialRecovery).toEqual(credentialRecovery);
    }
  });
  it("never retains keys outside the projection", () => {
    const parsed = BootstrapProjectionSchema.safeParse({
      ...bootstrap(),
      secretToken: "must-not-survive",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("secretToken" in parsed.data).toBe(false);
  });
  it.each([
    ["wrong schema revision", { schema: 2 }],
    ["unknown environment", { environment: "production" }],
    ["unknown runtime state", { runtimeState: "paused" }],
    ["negative task revision", { taskRevision: -1 }],
    ["fractional task revision", { taskRevision: 1.5 }],
    ["non-string selected task", { selectedTaskId: 7 }],
    ["missing build identity", { build: undefined }],
    ["missing window state", { windowState: undefined }],
    [
      "recovery without a generation",
      { credentialRecovery: { revision: 2, tunnelId: null } },
    ],
    [
      "recovery without a tunnel field",
      { credentialRecovery: { generation: 1, revision: 2 } },
    ],
    [
      "recovery with a tunnel that is not an identifier",
      { credentialRecovery: { generation: 1, revision: 2, tunnelId: "a b" } },
    ],
    [
      "recovery with a zero revision",
      { credentialRecovery: { generation: 1, revision: 0, tunnelId: null } },
    ],
    [
      "recovery with an extra key",
      {
        credentialRecovery: {
          generation: 1,
          revision: 2,
          tunnelId: null,
          key: "x",
        },
      },
    ],
  ])("rejects %s", (_name, change) => {
    expect(
      BootstrapProjectionSchema.safeParse({ ...bootstrap(), ...change })
        .success,
    ).toBe(false);
  });
  it.each([null, undefined, "bootstrap", 3, []])(
    "rejects the non-object value %j",
    (value) => {
      expect(BootstrapProjectionSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("initial snapshot", () => {
  it("starts blank at Home with no history and no evidence", () => {
    expect(home).toEqual({ area: "home", page: "general", taskId: "" });
    expect(initial.destination).toBe(home);
    expect(initial).toMatchObject({
      status: "starting",
      environment: "preview",
      runtime: "starting",
      route: "loading",
      back: false,
      forward: false,
      overlay: "none",
      sidebar: defaultSidebarPreference,
      buildId: null,
      configuration: null,
      evidence: null,
      tasks: { revision: 0, tasks: [] },
      activity: [],
      intents: {},
      chatHistoryEpoch: 0,
    });
  });
  it("starts without any optional authority capability", () => {
    expect(initial.capabilities).toEqual({
      incarnation: false,
      sequence: false,
      operationQuery: "workspace-edit-only",
      overlayAcknowledgement: false,
    });
    expect(initial.update).toEqual({
      phase: "unavailable",
      code: "UPDATE_STATUS_PENDING",
    });
  });
});

describe("install-on-quit eligibility", () => {
  it("is eligible only for a current ready preview with a confirmed preference", () => {
    expect(installOnQuitPreferenceEligible(eligible())).toBe(true);
  });
  it.each([
    ["dev environment", { environment: "dev" as const }],
    ["owner preview", { environment: "owner-preview" as const }],
    ["stale status", { status: "stale" as const }],
    ["offline runtime", { runtime: "offline" as const }],
    ["no build", { buildId: null }],
    [
      "unconfirmed preference",
      {
        update: {
          phase: "idle" as const,
          checkedAt: null,
          installOnQuitPreference: {
            status: "unknown" as const,
            enabled: false as const,
            code: "UNKNOWN",
          },
        },
      },
    ],
    [
      "unknown own intent",
      {
        intents: {
          "update-install-on-quit": {
            id: "x",
            state: "unknown" as const,
            code: null,
          },
        },
      },
    ],
    [
      "pending automatic downloads",
      {
        intents: {
          "update-automatic-downloads": {
            id: "x",
            state: "pending" as const,
            code: null,
          },
        },
      },
    ],
    [
      "pending update",
      {
        intents: { update: { id: "x", state: "pending" as const, code: null } },
      },
    ],
    [
      "unknown update",
      {
        intents: { update: { id: "x", state: "unknown" as const, code: null } },
      },
    ],
    [
      "applying phase",
      {
        update: {
          phase: "applying" as const,
          version: "0.1.8",
          installOnQuitPreference: confirmedPreference,
        },
      },
    ],
    [
      "failed with recovery required",
      {
        update: {
          phase: "failed" as const,
          code: "UPDATE_CHECKSUM_MISMATCH",
          recoveryRequired: true,
          installOnQuitPreference: confirmedPreference,
        },
      },
    ],
    [
      "failed with an unknown code",
      {
        update: {
          phase: "failed" as const,
          code: "UPDATE_OUTCOME_UNKNOWN",
          recoveryRequired: false,
          installOnQuitPreference: confirmedPreference,
        },
      },
    ],
  ])("refuses %s", (_name, overrides) => {
    expect(installOnQuitPreferenceEligible(eligible(overrides))).toBe(false);
  });
  it("accepts a recoverable failure with a known code", () => {
    expect(
      installOnQuitPreferenceEligible(
        eligible({
          update: {
            phase: "failed",
            code: "UPDATE_DOWNLOAD_FAILED",
            recoveryRequired: false,
            installOnQuitPreference: confirmedPreference,
          },
        }),
      ),
    ).toBe(true);
  });
});

describe("canSetInstallOnQuitPreference", () => {
  it("requires the optional facade method and an eligible snapshot", () => {
    expect(canSetInstallOnQuitPreference(eligible(), capable)).toBe(true);
    expect(canSetInstallOnQuitPreference(eligible(), observationOnly)).toBe(
      false,
    );
    expect(
      canSetInstallOnQuitPreference(eligible({ status: "stale" }), capable),
    ).toBe(false);
  });
  it("refuses while its own intent is pending", () => {
    expect(
      canSetInstallOnQuitPreference(
        eligible({
          intents: {
            "update-install-on-quit": {
              id: "x",
              state: "pending",
              code: null,
            },
          },
        }),
        capable,
      ),
    ).toBe(false);
  });
});
