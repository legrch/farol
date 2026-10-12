import { describe, expect, it, vi } from "vitest";
import {
  createUpdateAbortConnectorRecovery,
  shouldResumeComputerConnector,
  resumeComputerConnector,
} from "../../src/apps/desktop/connector-resume-policy";
import {
  ProductSettingsSchema,
  type ProductSettings,
  type ProductConfigurationSnapshot,
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
function withoutWorkspace(): ProductSettings {
  const settings = configured();
  settings.computer.workspaces = [];
  settings.setup.computer.reachable = "unknown";
  settings.setup.computer.verified = null;
  return settings;
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

describe("clean connector resume across builds", () => {
  function fixture(withWorkspace = true) {
    const settings = withWorkspace ? configured() : withoutWorkspace();
    const current = structuredClone(settings);
    const buildId = "d".repeat(64);
    const order: string[] = [];
    const input = {
      environment: "dev" as const,
      buildEnvironment: "dev" as const,
      previousRunClean: true,
      buildId,
      snapshot: { status: "ready" as const, settings },
    };
    const ports = {
      mayContinue: () => true,
      current: (): ProductConfigurationSnapshot => ({
        status: "ready",
        settings: current,
      }),
      verifyWorkspace: vi.fn(async (id: string) => {
        order.push(`verify:${id}`);
        current.revision++;
        current.setup.computer.verified!.buildId = buildId;
        current.computer.workspaces[0]!.accessCheck = {
          buildId,
          computerGeneration: current.computer.generation,
          verifiedAt: at,
          rootIdentity: current.computer.workspaces[0]!.rootIdentity!,
        };
        return { ok: true };
      }),
      start: vi.fn(async () => {
        order.push("start");
        return { ok: true };
      }),
    };
    return { input, ports, order, current };
  }
  it("refreshes the exact saved workspace before starting a new-build connection", async () => {
    const f = fixture();
    expect(await resumeComputerConnector(f.input, f.ports)).toBe("started");
    expect(f.order).toEqual([`verify:${workspaceId}`, "start"]);
    expect(f.input.snapshot.settings.setup.computer.verified!.buildId).toBe(
      "a".repeat(64),
    );
  });
  it.each(["same-build", "new-build", "update-drained"])(
    "starts an exactly empty workspace route after %s without file proof (injected start only)",
    async (mode) => {
      const f = fixture(false);
      if (mode === "same-build") f.input.buildId = "a".repeat(64);
      if (mode === "update-drained") {
        f.input.snapshot.settings.connectors.secureMcp.runtime!.state =
          "unreachable";
        f.input.snapshot.settings.setup.connect.unavailable =
          "CONNECTOR_UPDATE_DRAINED";
      }
      const before = structuredClone(f.input.snapshot.settings);
      expect(await resumeComputerConnector(f.input, f.ports)).toBe("started");
      expect(f.ports.verifyWorkspace).not.toHaveBeenCalled();
      expect(f.order).toEqual(["start"]);
      expect(f.input.snapshot.settings).toEqual(before);
      expect(f.input.snapshot.settings.setup.computer.verified).toBeNull();
    },
  );
  it("ignores an old file receipt when the configured workspace array is exactly empty", async () => {
    const f = fixture(false);
    f.input.snapshot.settings.setup.computer.verified =
      configured().setup.computer.verified;
    f.input.snapshot.settings.setup.computer.verified!.configRevision++;
    f.input.snapshot.settings.setup.computer.reachable = "unreachable";
    const before = structuredClone(f.input.snapshot.settings);
    expect(await resumeComputerConnector(f.input, f.ports)).toBe("started");
    expect(f.ports.verifyWorkspace).not.toHaveBeenCalled();
    expect(f.input.snapshot.settings).toEqual(before);
  });
  it("does not retry a refused or outcome-unknown empty-workspace start", async () => {
    const refused = fixture(false);
    refused.ports.start.mockResolvedValue({ ok: false });
    expect(await resumeComputerConnector(refused.input, refused.ports)).toBe(
      "start-refused",
    );
    expect(refused.ports.start).toHaveBeenCalledOnce();
    const unknown = fixture(false);
    unknown.ports.start.mockRejectedValue(new Error("LOST_START_REPLY"));
    await expect(
      resumeComputerConnector(unknown.input, unknown.ports),
    ).rejects.toThrow("LOST_START_REPLY");
    expect(unknown.ports.start).toHaveBeenCalledOnce();
    expect(unknown.ports.verifyWorkspace).not.toHaveBeenCalled();
  });
  it("keeps same-build resume on the existing start path", async () => {
    const f = fixture();
    f.input.buildId = "a".repeat(64);
    expect(await resumeComputerConnector(f.input, f.ports)).toBe("started");
    expect(f.ports.verifyWorkspace).not.toHaveBeenCalled();
  });
  it.each(["unclean", "unbound", "explicit-stop"])(
    "does not verify or start %s state",
    async (mode) => {
      const f = fixture();
      if (mode === "unclean") f.input.previousRunClean = false;
      if (mode === "unbound")
        delete f.input.snapshot.settings.computer.workspaces[0]!.rootIdentity;
      if (mode === "explicit-stop")
        f.input.snapshot.settings.connectors.secureMcp.runtime = null;
      expect(await resumeComputerConnector(f.input, f.ports)).toBe("skipped");
      expect(f.order).toEqual([]);
    },
  );
  it("does not upgrade a refused verification from complete-looking readback", async () => {
    const f = fixture();
    f.current.setup.computer.verified!.buildId = f.input.buildId;
    f.ports.verifyWorkspace.mockResolvedValue({ ok: false });
    expect(await resumeComputerConnector(f.input, f.ports)).toBe(
      "verification-refused",
    );
    expect(f.ports.start).not.toHaveBeenCalled();
  });
  it("honors a Stop intent even when it leaves settings unchanged", async () => {
    const f = fixture();
    let allowed = true;
    f.ports.mayContinue = () => allowed;
    const verify = f.ports.verifyWorkspace.getMockImplementation()!;
    f.ports.verifyWorkspace.mockImplementation(async (id) => {
      const result = await verify(id);
      allowed = false;
      return result;
    });
    expect(await resumeComputerConnector(f.input, f.ports)).toBe(
      "verification-refused",
    );
    expect(f.ports.start).not.toHaveBeenCalled();
  });
  it("does not start or repeat after a lost verification reply", async () => {
    const f = fixture();
    f.ports.verifyWorkspace.mockRejectedValue(new Error("LOST_REPLY"));
    await expect(resumeComputerConnector(f.input, f.ports)).rejects.toThrow(
      "LOST_REPLY",
    );
    expect(f.ports.verifyWorkspace).toHaveBeenCalledTimes(1);
    expect(f.ports.start).not.toHaveBeenCalled();
  });
  it.each([
    "old-build",
    "concurrent-write",
    "changed-root",
    "changed-tunnel",
    "changed-access",
    "changed-generation",
    "changed-workspace",
    "aligned-computer-generation",
    "aligned-connector-generation",
    "changed-runtime-generation",
    "changed-runtime-build",
    "removed-workspaces",
    "removed-verification",
    "pending-edit",
    "selected-host",
    "stopped",
    "unknown",
  ])("refuses %s after verification", async (mode) => {
    const f = fixture();
    f.ports.verifyWorkspace.mockImplementation(async () => {
      f.current.revision++;
      f.current.computer.workspaces[0]!.accessCheck = {
        buildId: f.input.buildId,
        computerGeneration: f.current.computer.generation,
        verifiedAt: at,
        rootIdentity: f.current.computer.workspaces[0]!.rootIdentity!,
      };
      if (mode === "concurrent-write") f.current.revision++;
      if (mode === "changed-root")
        f.current.computer.workspaces[0]!.root = "/other";
      if (mode === "changed-access")
        f.current.computer.workspaces[0]!.access = "write";
      if (mode === "changed-tunnel")
        f.current.connectors.secureMcp.tunnelId = "other";
      if (mode !== "old-build")
        f.current.setup.computer.verified!.buildId = f.input.buildId;
      if (mode === "changed-generation") f.current.computer.generation++;
      if (mode === "changed-workspace")
        f.current.setup.computer.verified!.workspaceId =
          "00000000-0000-4000-8000-000000000009";
      if (mode === "aligned-computer-generation") {
        f.current.computer.generation++;
        f.current.connectors.secureMcp.runtime!.computerGeneration++;
        f.current.setup.computer.verified!.configRevision++;
      }
      if (mode === "aligned-connector-generation") {
        f.current.connectors.secureMcp.generation++;
        f.current.connectors.secureMcp.runtime!.connectorGeneration++;
      }
      if (mode === "changed-runtime-generation")
        f.current.connectors.secureMcp.runtime!.runtimeGeneration = "e".repeat(
          64,
        );
      if (mode === "changed-runtime-build")
        f.current.connectors.secureMcp.runtime!.buildId = f.input.buildId;
      if (mode === "removed-workspaces") f.current.computer.workspaces = [];
      if (mode === "removed-verification")
        f.current.setup.computer.verified = null;
      if (mode === "pending-edit")
        f.current.computer.pendingEdit = pendingEdit();
      if (mode === "selected-host")
        f.current.nativeHosts.taskRoute = {} as NonNullable<
          ProductSettings["nativeHosts"]["taskRoute"]
        >;
      if (mode === "stopped") f.current.connectors.secureMcp.runtime = null;
      if (mode === "unknown") f.current.setup.computer.outcomeUnknown = true;
      return { ok: true };
    });
    expect(await resumeComputerConnector(f.input, f.ports)).toBe(
      "verification-refused",
    );
    expect(f.ports.start).not.toHaveBeenCalled();
  });
  it("refuses a configuration error after awaiting verification", async () => {
    const f = fixture();
    f.ports.current = () => ({
      status: "error",
      error: "CONFIG_RENAME_REQUIRED",
    });
    expect(await resumeComputerConnector(f.input, f.ports)).toBe(
      "verification-refused",
    );
    expect(f.ports.start).not.toHaveBeenCalled();
  });
  it("captures generations before awaiting even when the snapshot object is mutated", async () => {
    const f = fixture();
    f.input.snapshot.settings = f.current;
    f.ports.verifyWorkspace.mockImplementation(async () => {
      f.current.setup.computer.verified!.buildId = f.input.buildId;
      f.current.computer.generation++;
      f.current.connectors.secureMcp.runtime!.computerGeneration++;
      f.current.setup.computer.verified!.configRevision++;
      return { ok: true };
    });
    expect(await resumeComputerConnector(f.input, f.ports)).toBe(
      "verification-refused",
    );
    expect(f.ports.start).not.toHaveBeenCalled();
  });
});

function pendingEdit(): NonNullable<
  ProductSettings["computer"]["pendingEdit"]
> {
  return {
    operationId: "00000000-0000-4000-8000-000000000004",
    workspaceId,
    relativePath: "file.txt",
    computerGeneration: 7,
    submittedAt: at,
  };
}

// These policy fixtures do not execute a connector, native host, or filesystem check.
describe("exactly empty workspace connector resume", () => {
  it.each(["dev", "preview"] as const)(
    "preserves clean shutdown and %s identity gates",
    (environment) => {
      const settings = withoutWorkspace();
      expect(check(settings, true, environment)).toBe(true);
      expect(check(settings, false, environment)).toBe(false);
      expect(
        shouldResumeComputerConnector({
          environment,
          buildEnvironment: environment === "dev" ? "preview" : "dev",
          previousRunClean: true,
          snapshot: { status: "ready", settings },
        }),
      ).toBe(false);
    },
  );
  it.each<[string, (s: ProductSettings) => void]>([
    [
      "missing runtime",
      (s) => {
        s.connectors.secureMcp.runtime = null;
      },
    ],
    [
      "unknown runtime",
      (s) => {
        s.connectors.secureMcp.runtime!.state = "outcome_unknown";
      },
    ],
    [
      "unconfirmed drain",
      (s) => {
        s.connectors.secureMcp.runtime!.state = "unreachable";
      },
    ],
    [
      "changed connector generation",
      (s) => {
        s.connectors.secureMcp.generation++;
      },
    ],
    [
      "changed computer generation",
      (s) => {
        s.computer.generation++;
      },
    ],
    [
      "missing credential",
      (s) => {
        s.connectors.secureMcp.credential = "missing";
      },
    ],
    [
      "missing selected executable",
      (s) => {
        s.connectors.secureMcp.tunnelClient = null;
      },
    ],
    [
      "missing tunnel",
      (s) => {
        s.connectors.secureMcp.tunnelId = null;
      },
    ],
    [
      "unknown connector action",
      (s) => {
        s.setup.connect.outcomeUnknown = true;
      },
    ],
    [
      "unknown computer action",
      (s) => {
        s.setup.computer.outcomeUnknown = true;
      },
    ],
    [
      "pending edit",
      (s) => {
        s.computer.pendingEdit = pendingEdit();
      },
    ],
    [
      "selected task host",
      (s) => {
        s.nativeHosts.taskRoute = {} as NonNullable<
          ProductSettings["nativeHosts"]["taskRoute"]
        >;
      },
    ],
  ])("preserves %s admission with no workspaces", async (_name, alter) => {
    const settings = withoutWorkspace();
    alter(settings);
    const ports = {
      mayContinue: () => true,
      current: () => ({ status: "ready" as const, settings }),
      verifyWorkspace: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async () => ({ ok: true })),
    };
    expect(check(settings)).toBe(false);
    expect(
      await resumeComputerConnector(
        {
          environment: "preview",
          buildEnvironment: "preview",
          previousRunClean: true,
          buildId: "d".repeat(64),
          snapshot: { status: "ready", settings },
        },
        ports,
      ),
    ).toBe("skipped");
    expect(ports.verifyWorkspace).not.toHaveBeenCalled();
    expect(ports.start).not.toHaveBeenCalled();
  });
  it("does not reinterpret configured but unbound workspaces as an empty array", () => {
    const settings = withoutWorkspace();
    settings.computer.workspaces = configured().computer.workspaces;
    delete settings.computer.workspaces[0]!.rootIdentity;
    expect(check(settings)).toBe(false);
    settings.setup.computer.reachable = "reachable";
    settings.setup.computer.verified = configured().setup.computer.verified;
    expect(check(settings)).toBe(false);
  });
});
describe("configured Computer connector resume", () => {
  it.each(["preview", "dev"] as const)(
    "resumes a previously ready approved Computer-only %s route without changing settings",
    (environment) => {
      const settings = configured();
      const before = structuredClone(settings);
      expect(check(settings, true, environment)).toBe(true);
      expect(settings).toEqual(before);
    },
  );
  it("resumes a confirmed update drain without accepting the stopped runtime as live", () => {
    const settings = configured();
    settings.connectors.secureMcp.runtime!.state = "unreachable";
    settings.setup.connect.unavailable = "CONNECTOR_UPDATE_DRAINED";
    expect(check(settings)).toBe(true);
    expect(settings.connectors.secureMcp.runtime!.state).toBe("unreachable");
    expect(check(settings, false)).toBe(false);
    expect(check(settings, true, "dev")).toBe(true);
    settings.connectors.secureMcp.runtime = null;
    expect(check(settings)).toBe(false);
  });
  it.each(["preview", "dev"] as const)(
    "does not resume an unconfirmed prior %s run",
    (environment) => {
      expect(check(configured(), false, environment)).toBe(false);
    },
  );
  it("does not automatically resume a development build using the NEW profile", () => {
    const input = {
      environment: "preview" as const,
      buildEnvironment: "dev" as const,
      previousRunClean: true,
      snapshot: { status: "ready" as const, settings: configured() },
    };
    expect(shouldResumeComputerConnector(input)).toBe(false);
    expect(
      shouldResumeComputerConnector({
        ...input,
        environment: "dev",
        buildEnvironment: "preview",
      }),
    ).toBe(false);
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
      expect(check(settings, true, "dev")).toBe(false);
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
    expect(check(settings, true, "dev")).toBe(false);
  });
});

describe("confirmed same-session update abort recovery (injected connector, no live start)", () => {
  function recoveryFixture(wasRunning = true, withWorkspace = true) {
    const before = withWorkspace ? configured() : withoutWorkspace();
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
  it("resumes an empty workspace route after confirmed update admission releases without file verification", async () => {
    const f = recoveryFixture(true, false);
    const verifyWorkspace = vi.fn(async () => ({ ok: false }));
    const start = vi.fn(async () => {
      f.events.push("started");
      return { ok: true };
    });
    f.resume.mockImplementation(async () => {
      expect(
        await resumeComputerConnector(
          {
            environment: "preview",
            buildEnvironment: "preview",
            previousRunClean: true,
            buildId: "d".repeat(64),
            snapshot: { status: "ready", settings: f.stopped },
          },
          {
            mayContinue: () => true,
            current: () => ({ status: "ready", settings: f.stopped }),
            verifyWorkspace,
            start,
          },
        ),
      ).toBe("started");
    });
    const before = structuredClone(f.stopped);
    f.recovery.recordDrained({
      status: "ready",
      settings: structuredClone(f.stopped),
    });
    await f.recovery.release();
    expect(f.events).toEqual(["released", "started"]);
    expect(start).toHaveBeenCalledOnce();
    expect(verifyWorkspace).not.toHaveBeenCalled();
    expect(f.stopped).toEqual(before);
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
  it("never resumes a drained connector or retries release after a browser fence fails to release", async () => {
    const before = configured();
    const stopped = structuredClone(before);
    stopped.revision++;
    stopped.connectors.secureMcp.runtime!.state = "unreachable";
    stopped.setup.connect.unavailable = "CONNECTOR_UPDATE_DRAINED";
    const releaseAdmission = vi.fn(async () => {
      throw new Error("UPDATE_BROWSER_RELEASE_UNCONFIRMED");
    });
    const resumeConnector = vi.fn();
    const recovery = createUpdateAbortConnectorRecovery({
      before: { status: "ready", settings: before },
      wasRunning: true,
      current: () => ({ status: "ready", settings: stopped }),
      releaseAdmission,
      resumeConnector,
    });
    recovery.recordDrained({ status: "ready", settings: stopped });
    await expect(recovery.release()).rejects.toThrow(
      "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    );
    await expect(recovery.release()).rejects.toThrow(
      "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    );
    expect(releaseAdmission).toHaveBeenCalledOnce();
    expect(resumeConnector).not.toHaveBeenCalled();
  });
});
