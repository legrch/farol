import { describe, expect, it, vi } from "vitest";
import {
  createUpdateAbortConnectorRecovery,
  shouldResumeComputerConnector,
} from "../../src/apps/desktop/connector-resume-policy";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract";

const workspaceId = "00000000-0000-4000-8000-000000000002";
const at = "2026-10-01T01:00:00.000Z";
function configured(): ProductSettings {
  const pending = {
    visited: true,
    skipped: false,
    configured: true,
    reachable: "unknown",
    verified: null,
    needsAction: "Pending",
    unavailable: null,
    outcomeUnknown: false,
  };
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 9,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: "00000000-0000-4000-8000-000000000001",
      generation: 7,
      name: "Fixture Mac",
      commands: "verification",
      workspaces: [
        {
          workspaceId,
          root: "/approved/workspace",
          label: "Approved",
          access: "read",
          excludedPaths: [],
          rootIdentity: { device: "5", inode: "98" },
        },
      ],
    },
    setup: {
      chatgpt: pending,
      connect: pending,
      hosts: pending,
      verify: pending,
      computer: {
        ...pending,
        reachable: "reachable",
        verified: {
          profile: "preview",
          configRevision: 7,
          workspaceId,
          runtimeGeneration: "fixture",
          buildId: "a".repeat(64),
          protocol: "workspace/v1",
          verifiedAt: at,
        },
      },
    },
    connectors: {
      secureMcp: {
        generation: 3,
        profile: "farol-next",
        credential: "stored",
        tunnelId: "tunnel_fixture",
        tunnelClient: {
          executablePath: "/selected/tunnel-client",
          executableSha256: "b".repeat(64),
          version: "1.0.0",
          protocol: "openai-tunnel-client/v1",
          verifiedAt: at,
        },
        runtime: {
          state: "ready",
          connectorGeneration: 3,
          computerGeneration: 7,
          runtimeGeneration: "c".repeat(64),
          buildId: "a".repeat(64),
          observedAt: at,
        },
        attachment: null,
      },
    },
  });
}
function check(
  settings = configured(),
  previousRunClean = true,
  environment: "preview" | "dev" = "preview",
) {
  return shouldResumeComputerConnector({
    environment,
    buildEnvironment: environment,
    previousRunClean,
    snapshot: { status: "ready", settings },
  });
}
describe("configured Computer connector resume", () => {
  it("resumes a previously ready approved Computer-only route without changing settings", () => {
    const settings = configured();
    const before = structuredClone(settings);
    expect(check(settings)).toBe(true);
    expect(settings).toEqual(before);
  });
  it("resumes a confirmed update drain without accepting the stopped runtime as live", () => {
    const settings = configured();
    settings.connectors.secureMcp.runtime!.state = "unreachable";
    settings.setup.connect.unavailable = "CONNECTOR_UPDATE_DRAINED";
    expect(check(settings)).toBe(true);
    expect(settings.connectors.secureMcp.runtime!.state).toBe("unreachable");
    expect(check(settings, false)).toBe(false);
    expect(check(settings, true, "dev")).toBe(false);
    settings.connectors.secureMcp.runtime = null;
    expect(check(settings)).toBe(false);
  });
  it("does not resume Dev or an unconfirmed prior run", () => {
    expect(check(configured(), false)).toBe(false);
    expect(check(configured(), true, "dev")).toBe(false);
  });
  it("does not automatically resume a development build using the NEW profile", () => {
    const input = {
      environment: "preview" as const,
      buildEnvironment: "dev" as const,
      previousRunClean: true,
      snapshot: { status: "ready" as const, settings: configured() },
    };
    expect(shouldResumeComputerConnector(input)).toBe(false);
  });
  it("does not turn a configuration error into an automatic repair", () => {
    expect(
      shouldResumeComputerConnector({
        environment: "preview",
        buildEnvironment: "preview",
        previousRunClean: true,
        snapshot: { status: "error", error: "CONFIG_RENAME_REQUIRED" },
      }),
    ).toBe(false);
  });
  for (const [name, alter] of [
    [
      "explicit Stop or first launch",
      (s: ProductSettings) => {
        s.connectors.secureMcp.runtime = null;
      },
    ],
    [
      "unknown readiness",
      (s: ProductSettings) => {
        s.connectors.secureMcp.runtime!.state = "outcome_unknown";
      },
    ],
    [
      "unreachable runtime",
      (s: ProductSettings) => {
        s.connectors.secureMcp.runtime!.state = "unreachable";
      },
    ],
    [
      "changed connector",
      (s: ProductSettings) => {
        s.connectors.secureMcp.generation++;
      },
    ],
    [
      "changed workspace grant",
      (s: ProductSettings) => {
        s.computer.generation++;
      },
    ],
    [
      "missing credential",
      (s: ProductSettings) => {
        s.connectors.secureMcp.credential = "missing";
      },
    ],
    [
      "missing selected executable",
      (s: ProductSettings) => {
        s.connectors.secureMcp.tunnelClient = null;
      },
    ],
    [
      "missing tunnel",
      (s: ProductSettings) => {
        s.connectors.secureMcp.tunnelId = null;
      },
    ],
    [
      "unbound folder",
      (s: ProductSettings) => {
        delete s.computer.workspaces[0]!.rootIdentity;
      },
    ],
    [
      "missing verification",
      (s: ProductSettings) => {
        s.setup.computer.verified = null;
      },
    ],
    [
      "stale verification",
      (s: ProductSettings) => {
        s.setup.computer.verified!.configRevision++;
      },
    ],
    [
      "different verified folder",
      (s: ProductSettings) => {
        s.setup.computer.verified!.workspaceId =
          "00000000-0000-4000-8000-000000000003";
      },
    ],
    [
      "folder needs attention",
      (s: ProductSettings) => {
        s.setup.computer.reachable = "unreachable";
      },
    ],
    [
      "unknown connector action",
      (s: ProductSettings) => {
        s.setup.connect.outcomeUnknown = true;
      },
    ],
    [
      "unknown workspace check",
      (s: ProductSettings) => {
        s.setup.computer.outcomeUnknown = true;
      },
    ],
    [
      "pending edit delivery",
      (s: ProductSettings) => {
        s.computer.pendingEdit = {
          operationId: "00000000-0000-4000-8000-000000000004",
          workspaceId,
          relativePath: "file.txt",
          computerGeneration: 7,
          submittedAt: at,
        };
      },
    ],
  ] as const) {
    it(`keeps ${name} under explicit admission`, () => {
      const settings = configured();
      alter(settings);
      expect(check(settings)).toBe(false);
    });
  }
  it("never starts a selected Codex task route as a side effect of Computer resume", () => {
    const settings = configured();
    // Deliberately opaque: eligibility only tests selection presence and must
    // never probe/parse a selected endpoint or create a replacement route.
    settings.nativeHosts.taskRoute = {} as NonNullable<
      ProductSettings["nativeHosts"]["taskRoute"]
    >;
    expect(check(settings)).toBe(false);
  });
});

describe("confirmed same-session update abort recovery (injected connector, no live start)", () => {
  function recoveryFixture(wasRunning = true) {
    const before = configured();
    const stopped = structuredClone(before);
    stopped.revision++;
    stopped.connectors.secureMcp.runtime!.state = "unreachable";
    stopped.setup.connect.unavailable = "CONNECTOR_UPDATE_DRAINED";
    const events: string[] = [];
    const resume = vi.fn(async () => {
      events.push("resumed");
    });
    const recovery = createUpdateAbortConnectorRecovery({
      before: { status: "ready", settings: before },
      wasRunning,
      current: () => ({ status: "ready", settings: stopped }),
      releaseAdmission: async () => {
        events.push("released");
      },
      resumeConnector: resume,
    });
    return { before, stopped, events, resume, recovery };
  }

  it("restores a confirmed running connector once, after releasing all update admission", async () => {
    const f = recoveryFixture();
    f.recovery.recordDrained({ status: "ready", settings: f.stopped });
    const first = f.recovery.release();
    const second = f.recovery.release();
    expect(first).toBe(second);
    await first;
    expect(f.events).toEqual(["released", "resumed"]);
    expect(f.resume).toHaveBeenCalledOnce();
    expect(f.stopped.connectors.secureMcp.runtime!.state).toBe("unreachable");
  });
  it("does not start a previously idle process or an unconfirmed drain", async () => {
    const idle = recoveryFixture(false);
    idle.recovery.recordDrained({ status: "ready", settings: idle.stopped });
    await idle.recovery.release();
    expect(idle.resume).not.toHaveBeenCalled();
    const unconfirmed = recoveryFixture();
    await unconfirmed.recovery.release();
    expect(unconfirmed.resume).not.toHaveBeenCalled();
  });
  it.each(["revision", "runtime", "explicit-stop", "unknown"])(
    "preserves %s state instead of repairing it implicitly",
    async (change) => {
      const f = recoveryFixture();
      f.recovery.recordDrained({
        status: "ready",
        settings: structuredClone(f.stopped),
      });
      if (change === "revision") f.stopped.revision++;
      else if (change === "runtime")
        f.stopped.connectors.secureMcp.runtime!.runtimeGeneration = "d".repeat(
          64,
        );
      else if (change === "explicit-stop")
        f.stopped.connectors.secureMcp.runtime = null;
      else f.stopped.setup.connect.outcomeUnknown = true;
      await f.recovery.release();
      expect(f.events).toEqual(["released"]);
      expect(f.resume).not.toHaveBeenCalled();
    },
  );
  it("does not retry a refused recovery start", async () => {
    const f = recoveryFixture();
    f.recovery.recordDrained({ status: "ready", settings: f.stopped });
    f.resume.mockRejectedValueOnce(new Error("fixture start refused"));
    await expect(f.recovery.release()).rejects.toThrow("fixture start refused");
    await expect(f.recovery.release()).rejects.toThrow("fixture start refused");
    expect(f.resume).toHaveBeenCalledOnce();
  });
});
