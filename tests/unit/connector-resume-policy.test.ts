import { describe, expect, it } from "vitest";
import { shouldResumeComputerConnector } from "../../src/apps/desktop/connector-resume-policy";
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
