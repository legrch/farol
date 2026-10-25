import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { originalPredecessorSettingsReadable } from "../../src/apps/desktop/beta3-state-readability";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";

const source = {
  version: "0.2.0-owner.beta.3",
  sourceCommit: "24cc7c32f12f2633156efef40c91ea0817109a4c",
};

// Synthetic stored-document shape, not a live profile, credential, native host
// or filesystem witness. Paths, IDs and digests are inert fixture values.
function fixture() {
  const readiness = {
    visited: true,
    skipped: false,
    configured: true,
    reachable: "unknown",
    verified: {
      profile: "fixture-profile",
      configRevision: 4,
      workspaceId: "00000000-0000-4000-8000-000000000002",
      runtimeGeneration: "fixture-runtime",
      buildId: "b".repeat(64),
      protocol: "fixture/v1",
      verifiedAt: "2026-10-08T09:00:00.000Z",
    },
    needsAction: "Retained verification required",
    unavailable: null,
    outcomeUnknown: true,
    recovery: "rejoin_agent",
  };
  return {
    schema: 1,
    revision: 7,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "rail",
      activityDetail: "technical",
    },
    tasks: {
      defaultHarness: "fixture",
      harnesses: {
        fixture: {
          defaultModel: "default",
          models: {
            default: { model: "fixture-model", defaultEffort: "high" },
          },
        },
      },
    },
    computer: {
      computerId: "00000000-0000-4000-8000-000000000001",
      generation: 3,
      name: "Fixture Computer",
      commands: "workspace",
      filePolicy: "approved-roots-v1",
      workspaces: [
        {
          workspaceId: "00000000-0000-4000-8000-000000000002",
          root: "/fixture/workspace",
          label: "Fixture workspace",
          access: "write",
          excludedPaths: ["/fixture/workspace/private"],
          rootIdentity: { device: "1", inode: "2" },
          gitMetadata: {
            gitDirectory: "/fixture/workspace/.git",
            commonDirectory: "/fixture/workspace/.git",
          },
          gitHistoryApproved: false,
          accessCheck: {
            buildId: "b".repeat(64),
            computerGeneration: 3,
            verifiedAt: "2026-10-08T09:00:00.000Z",
            rootIdentity: { device: "1", inode: "2" },
          },
        },
      ],
      pendingEdit: {
        operationId: "00000000-0000-4000-8000-000000000003",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        relativePath: "retained.txt",
        computerGeneration: 3,
        submittedAt: "2026-10-08T09:00:00.000Z",
      },
    },
    nativeHosts: {
      generation: 2,
      codex: {
        executablePath: "/fixture/bin/codex",
        executableSha256: "a".repeat(64),
        version: "1.2.3",
        protocol: "codex-app-server/v2",
        schemaSha256: "b".repeat(64),
        verifiedAt: "2026-10-08T09:00:00.000Z",
      },
      taskRoute: {
        transport: "codex-shared-proxy/v1",
        socketPath: "/fixture/proxy.sock",
        expectedCodexHome: "/fixture/codex-home",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        projectId: "00000000-0000-4000-8000-000000000004",
        observeThreadId: "00000000-0000-4000-8000-000000000005",
        projectRoot: "/fixture/workspace",
        projectIdentity: { device: "1", inode: "2" },
        gitCommonDirectory: "/fixture/workspace/.git",
        execution: { sandbox: "read-only", approvalPolicy: "on-request" },
        harness: "codex",
        computerGeneration: 3,
        hostGeneration: 2,
        approvedAt: "2026-10-08T09:00:00.000Z",
        expiresAt: 1_791_453_600_000,
      },
    },
    connectors: {
      secureMcp: {
        generation: 2,
        profile: "farol",
        tunnelId: "fixture-tunnel",
        tunnelClient: {
          executablePath: "/fixture/bin/tunnel-client",
          executableSha256: "c".repeat(64),
          version: "1.2.3",
          protocol: "openai-tunnel-client/v1",
          verifiedAt: "2026-10-08T09:00:00.000Z",
        },
        // Only a status enum; no runtime key, token or credential material.
        credential: "stored",
        chatgptApp: {
          name: "Fixture App",
          tunnelId: "fixture-tunnel",
          connectorGeneration: 2,
        },
        runtime: {
          state: "outcome_unknown",
          connectorGeneration: 2,
          runtimeGeneration: "c".repeat(64),
          computerGeneration: 3,
          buildId: "b".repeat(64),
          observedAt: "2026-10-08T09:00:00.000Z",
        },
        attachment: null,
      },
    },
    setup: {
      chatgpt: { ...readiness },
      computer: { ...readiness },
      connect: { ...readiness },
      hosts: { ...readiness },
      verify: { ...readiness },
    },
  };
}

describe("originalPredecessorSettingsReadable", () => {
  it("pins the complete audited stored-schema closure and parser dependency", () => {
    // Every validator/default reachable by ProductSettingsSchema is inline in
    // this prefix. Its imports are included so extraction cannot hide a move.
    // ON TOUCH: compare the complete closure against the exact beta3 commit;
    // update the predicate and negative/default tests before renewing this hash.
    // A hash refresh alone is not a compatibility audit.
    // 2026-10-22 re-audit: only the host ping literal and connector profile
    // literal/default changed. Earlier beta identity compatibility is no longer
    // promised; the retained shape below uses the current identity names.
    // 2026-10-25 complete beta3 comparison: appVerificationPending is a new
    // stored optional boolean; refuse every presence, including false. All
    // other reachable expansions remain guarded below. Separate verification
    // scope is command-only and is outside this stored-schema prefix.
    const contract = readFileSync(
      new URL("../../src/pkg/product-settings/contract.ts", import.meta.url),
      "utf8",
    );
    const sections = contract.split(
      "export const ProductConfigurationSnapshotSchema",
    );
    expect(sections).toHaveLength(2);
    expect(createHash("sha256").update(sections[0]!).digest("hex")).toBe(
      "6ed0f9778d3775877598d940f0419631f68b2232f6086a8dcbe0040381944250",
    );
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(packageJson.dependencies.zod).toBe("4.6.5");
    const packageLock = JSON.parse(
      readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
    );
    expect(packageLock.packages["node_modules/zod"]).toMatchObject({
      version: "4.6.5",
      resolved: "https://registry.npmjs.org/zod/-/zod-4.6.5.tgz",
      integrity:
        "sha512-v5l/aFXZQeai4awLbOpSoHecE9UiMrnfx75tEXLjNonXVARxQ5mOeipTjROUchszUNCqnE+hqAMujRsRHsut2Q==",
    });
  });

  it.each(["browser", "computer", "activity", "settings"])(
    "accepts the retained settings shape with current names and %s without mutation",
    (choice) => {
      const value = fixture();
      value.general.openAtLaunch = choice;
      const before = structuredClone(value);
      expect(ProductSettingsSchema.safeParse(value).success).toBe(true);
      expect(originalPredecessorSettingsReadable(source, value)).toBe(true);
      expect(value).toStrictEqual(before);
    },
  );

  it.each([true, false, null, undefined, "pending"])(
    "refuses every appVerificationPending presence without altering it: %j",
    (appVerificationPending) => {
      const value = fixture();
      Object.assign(value.connectors.secureMcp, { appVerificationPending });
      const before = structuredClone(value);
      if (typeof appVerificationPending === "boolean")
        expect(ProductSettingsSchema.safeParse(value).success).toBe(true);
      expect(originalPredecessorSettingsReadable(source, value)).toBe(false);
      expect(value).toStrictEqual(before);
    },
  );
  it("retains the absent external-check flag without inserting a default", () => {
    const value = fixture();
    const before = structuredClone(value);
    expect(
      ProductSettingsSchema.parse(value).connectors.secureMcp,
    ).not.toHaveProperty("appVerificationPending");
    expect(originalPredecessorSettingsReadable(source, value)).toBe(true);
    expect(value).toStrictEqual(before);
  });

  it.each(["attachment", "lastVerifiedAttachment"] as const)(
    "refuses retained %s with a null workspace without stripping proof",
    (field) => {
      const value = fixture();
      Object.assign(value.connectors.secureMcp, {
        [field]: {
          tunnelId: "fixture-tunnel",
          workspaceId: null,
          connectorGeneration: 2,
          runtimeGeneration: "c".repeat(64),
          computerGeneration: 3,
          buildId: "b".repeat(64),
          challengeSha256: "d".repeat(64),
          receiptSha256: "e".repeat(64),
          verifiedAt: "2026-10-08T09:00:00.000Z",
        },
      });
      const before = structuredClone(value);
      expect(ProductSettingsSchema.safeParse(value).success).toBe(true);
      expect(originalPredecessorSettingsReadable(source, value)).toBe(false);
      expect(value).toStrictEqual(before);
    },
  );

  it.each(["attachment", "lastVerifiedAttachment"] as const)(
    "accepts the original workspace-bound retained %s unchanged",
    (field) => {
      const value = fixture();
      Object.assign(value.connectors.secureMcp, {
        [field]: {
          tunnelId: "fixture-tunnel",
          workspaceId: "00000000-0000-4000-8000-000000000002",
          connectorGeneration: 2,
          runtimeGeneration: "c".repeat(64),
          computerGeneration: 3,
          buildId: "b".repeat(64),
          challengeSha256: "d".repeat(64),
          receiptSha256: "e".repeat(64),
          verifiedAt: "2026-10-08T09:00:00.000Z",
        },
      });
      const before = structuredClone(value);
      expect(originalPredecessorSettingsReadable(source, value)).toBe(true);
      expect(value).toStrictEqual(before);
    },
  );

  it.each(["absent", "null"])(
    "retains the original %s historical attachment default without mutation",
    (kind) => {
      const value = fixture();
      if (kind === "null")
        Object.assign(value.connectors.secureMcp, {
          lastVerifiedAttachment: null,
        });
      const before = structuredClone(value);
      const parsed = ProductSettingsSchema.parse(value);
      expect(parsed.connectors.secureMcp.attachment).toBeNull();
      expect(parsed.connectors.secureMcp.lastVerifiedAttachment).toBeNull();
      expect(originalPredecessorSettingsReadable(source, value)).toBe(true);
      expect(value).toStrictEqual(before);
      if (kind === "absent")
        expect(value.connectors.secureMcp).not.toHaveProperty(
          "lastVerifiedAttachment",
        );
    },
  );

  it("refuses a missing required current attachment without inserting it", () => {
    const value = fixture();
    Reflect.deleteProperty(value.connectors.secureMcp, "attachment");
    const before = structuredClone(value);
    expect(ProductSettingsSchema.safeParse(value).success).toBe(false);
    expect(originalPredecessorSettingsReadable(source, value)).toBe(false);
    expect(value).toStrictEqual(before);
  });

  it("refuses Home although the current owner parser accepts it", () => {
    const value = fixture();
    value.general.openAtLaunch = "home";
    const before = structuredClone(value);
    expect(ProductSettingsSchema.safeParse(value).success).toBe(true);
    expect(originalPredecessorSettingsReadable(source, value)).toBe(false);
    expect(value).toStrictEqual(before);
  });

  it.each(["turn-exact_1", "", null, undefined])(
    "refuses any stored observeTurnId presence: %s",
    (observeTurnId) => {
      const value = fixture();
      Object.assign(value.nativeHosts.taskRoute, { observeTurnId });
      const before = structuredClone(value);
      if (observeTurnId === "turn-exact_1" || observeTurnId === undefined)
        expect(ProductSettingsSchema.safeParse(value).success).toBe(true);
      expect(originalPredecessorSettingsReadable(source, value)).toBe(false);
      expect(value).toStrictEqual(before);
    },
  );

  it.each([
    "00000000-0000-4000-8000-000000000006",
    "",
    null,
    undefined,
    false,
    {},
  ])("refuses any stored accessCheck.checkId presence: %j", (checkId) => {
    const value = fixture();
    Object.assign(value.computer.workspaces[0]!.accessCheck, { checkId });
    const before = structuredClone(value);
    if (typeof checkId === "string" && checkId.length > 0)
      expect(ProductSettingsSchema.safeParse(value).success).toBe(true);
    expect(originalPredecessorSettingsReadable(source, value)).toBe(false);
    expect(value).toStrictEqual(before);
  });

  it("refuses an issued-check witness on a later workspace without mutating either", () => {
    const value = fixture();
    const later = structuredClone(value.computer.workspaces[0]!);
    later.workspaceId = "00000000-0000-4000-8000-000000000007";
    Object.assign(later.accessCheck, {
      checkId: "00000000-0000-4000-8000-000000000006",
    });
    value.computer.workspaces.push(later);
    const before = structuredClone(value);
    expect(ProductSettingsSchema.safeParse(value).success).toBe(true);
    expect(originalPredecessorSettingsReadable(source, value)).toBe(false);
    expect(value).toStrictEqual(before);
  });

  it.each(["absent", "null", "legacy"] as const)(
    "retains the old %s accessCheck state without inserting a checkId default",
    (kind) => {
      const value = fixture();
      const workspace = value.computer.workspaces[0]!;
      if (kind === "absent") Reflect.deleteProperty(workspace, "accessCheck");
      if (kind === "null") Object.assign(workspace, { accessCheck: null });
      const before = structuredClone(value);
      const parsed = ProductSettingsSchema.parse(value).computer.workspaces[0]!;
      if (kind === "absent") expect(parsed).not.toHaveProperty("accessCheck");
      if (kind === "null") expect(parsed.accessCheck).toBeNull();
      if (kind === "legacy") {
        expect(parsed.accessCheck).toStrictEqual(workspace.accessCheck);
        expect(parsed.accessCheck).not.toHaveProperty("checkId");
      }
      expect(originalPredecessorSettingsReadable(source, value)).toBe(true);
      expect(value).toStrictEqual(before);
    },
  );

  it.each([
    null,
    "unclassified task policy",
    42,
    [true],
    { unknown: { home: true, observeTurnId: "unrelated-task-policy" } },
  ])("allows the old reader's unknown tasks subsection: %j", (tasks) => {
    const value = { ...fixture(), tasks };
    expect(originalPredecessorSettingsReadable(source, value)).toBe(true);
  });

  it("retains the old missing-field defaults without normalizing the document", () => {
    const complete = fixture();
    const {
      commands: _commands,
      pendingEdit: _pendingEdit,
      ...computer
    } = complete.computer;
    const {
      nativeHosts: _hosts,
      connectors: _connectors,
      tasks: _tasks,
      ...remaining
    } = complete;
    const value = { ...remaining, computer };
    const before = structuredClone(value);
    const parsed = ProductSettingsSchema.parse(value);
    expect(parsed.computer.commands).toBe("none");
    expect(parsed.computer.pendingEdit).toBeNull();
    expect(parsed.computer.filePolicy).toBe("approved-roots-v1");
    expect(parsed.nativeHosts).toStrictEqual({
      generation: 1,
      codex: null,
      taskRoute: null,
    });
    expect(parsed.connectors.secureMcp).toStrictEqual({
      generation: 1,
      profile: "farol",
      tunnelId: null,
      tunnelClient: null,
      credential: "missing",
      runtime: null,
      challenge: null,
      attachment: null,
      lastVerifiedAttachment: null,
    });
    expect(parsed.setup.journey).toStrictEqual({
      currentStep: "chatgpt",
      dismissed: false,
    });
    expect(originalPredecessorSettingsReadable(source, value)).toBe(true);
    expect(value).toStrictEqual(before);
    expect(value).not.toHaveProperty("nativeHosts");
    expect(value.computer).not.toHaveProperty("commands");
  });

  it("retains nested host and connector defaults and optional field absence", () => {
    const value = fixture();
    const parsed = ProductSettingsSchema.parse(value);
    expect(parsed.nativeHosts.codex).toMatchObject({
      localVerification: null,
      taskSource: null,
      liveVerification: null,
      agentVerification: null,
    });
    expect(parsed.connectors.secureMcp.challenge).toBeNull();
    expect(parsed.connectors.secureMcp.lastVerifiedAttachment).toBeNull();
    const { taskRoute: _route, ...hosts } = value.nativeHosts;
    const { filePolicy: _policy, ...computer } = value.computer;
    const { chatgptApp: _app, ...secureMcp } = value.connectors.secureMcp;
    const missing = {
      ...value,
      computer,
      nativeHosts: hosts,
      connectors: { secureMcp },
    };
    const defaults = ProductSettingsSchema.parse(missing);
    expect(defaults.nativeHosts.taskRoute).toBeNull();
    expect(defaults.computer).not.toHaveProperty("filePolicy");
    expect(defaults.connectors.secureMcp).not.toHaveProperty("chatgptApp");
    expect(originalPredecessorSettingsReadable(source, missing)).toBe(true);
  });

  it("accepts both old pending-edit formats without treating them as recovery authority", () => {
    const value = fixture();
    Object.assign(value.computer.pendingEdit, {
      backend: "go-owner-v2",
      profileId: "00000000-0000-4000-8000-000000000006",
      beforeSha256: "d".repeat(64),
    });
    expect(originalPredecessorSettingsReadable(source, value)).toBe(true);
    const noPending = {
      ...value,
      computer: { ...value.computer, pendingEdit: null },
      nativeHosts: { ...value.nativeHosts, taskRoute: null },
    };
    expect(originalPredecessorSettingsReadable(source, noPending)).toBe(true);
  });

  it("keeps the old trim semantics confined to validation", () => {
    const value = fixture();
    value.computer.name = "  Fixture Computer  ";
    value.computer.workspaces[0]!.label = "  Fixture workspace  ";
    const before = structuredClone(value);
    expect(ProductSettingsSchema.parse(value).computer.name).toBe(
      "Fixture Computer",
    );
    expect(originalPredecessorSettingsReadable(source, value)).toBe(true);
    expect(value).toStrictEqual(before);
  });

  it.each([
    { ...source, version: "0.2.0-owner.beta.4" },
    { ...source, version: "0.2.0-owner.beta.2" },
    { ...source, sourceCommit: "27c091e5a2870f3a6b21ff95b29ec564e6bb9d05" },
    { ...source, sourceCommit: "24cc7c32" },
    { ...source, sourceCommit: source.sourceCommit.toUpperCase() },
    { ...source, version: `${source.version} ` },
    { ...source, extra: true },
    {},
    null,
    undefined,
    "beta3",
    [],
  ])("refuses unsupported or malformed source pins: %j", (candidate) => {
    const getter = vi.fn(() => {
      throw new Error("Settings must not be examined");
    });
    const value = Object.defineProperty({}, "schema", {
      enumerable: true,
      get: getter,
    });
    expect(
      originalPredecessorSettingsReadable(candidate as typeof source, value),
    ).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(
      originalPredecessorSettingsReadable(
        candidate as typeof source,
        fixture(),
      ),
    ).toBe(false);
  });

  it.each([
    [
      "top-level extra",
      (v: ReturnType<typeof fixture>) =>
        Object.assign(v, { futureSettings: true }),
    ],
    [
      "general extra",
      (v: ReturnType<typeof fixture>) =>
        Object.assign(v.general, { futureChoice: true }),
    ],
    [
      "route extra",
      (v: ReturnType<typeof fixture>) =>
        Object.assign(v.nativeHosts.taskRoute, { futureRoute: true }),
    ],
    [
      "host extra",
      (v: ReturnType<typeof fixture>) =>
        Object.assign(v.nativeHosts.codex, { futureHost: true }),
    ],
    [
      "connector extra",
      (v: ReturnType<typeof fixture>) =>
        Object.assign(v.connectors.secureMcp, { futureConnector: true }),
    ],
    [
      "readiness extra",
      (v: ReturnType<typeof fixture>) =>
        Object.assign(v.setup.verify, { futureReadiness: true }),
    ],
    [
      "negative revision",
      (v: ReturnType<typeof fixture>) => {
        v.revision = -1;
      },
    ],
    [
      "zero generation",
      (v: ReturnType<typeof fixture>) => {
        v.computer.generation = 0;
      },
    ],
    [
      "negative expiration",
      (v: ReturnType<typeof fixture>) => {
        v.nativeHosts.taskRoute.expiresAt = -1;
      },
    ],
    [
      "malformed path",
      (v: ReturnType<typeof fixture>) => {
        v.nativeHosts.taskRoute.socketPath = "/fixture/../proxy.sock";
      },
    ],
    [
      "escaping exclusion",
      (v: ReturnType<typeof fixture>) => {
        v.computer.workspaces[0]!.excludedPaths = ["/outside/private"];
      },
    ],
    [
      "malformed timestamp",
      (v: ReturnType<typeof fixture>) => {
        v.nativeHosts.codex.verifiedAt = "yesterday";
      },
    ],
    [
      "missing general",
      (v: ReturnType<typeof fixture>) => {
        Reflect.deleteProperty(v, "general");
      },
    ],
    [
      "missing codex",
      (v: ReturnType<typeof fixture>) => {
        Reflect.deleteProperty(v.nativeHosts, "codex");
      },
    ],
    [
      "invalid schema",
      (v: ReturnType<typeof fixture>) => {
        v.schema = 2;
      },
    ],
  ] as const)("refuses malformed stored Settings: %s", (_name, change) => {
    const value = fixture();
    change(value);
    expect(originalPredecessorSettingsReadable(source, value)).toBe(false);
  });

  it.each([null, undefined, {}, [], "settings", 1, NaN, Infinity])(
    "refuses unclassified document input: %s",
    (value) =>
      expect(originalPredecessorSettingsReadable(source, value)).toBe(false),
  );

  it.each([
    undefined,
    NaN,
    Infinity,
    1n,
    Symbol("fixture"),
    () => {},
    new Date(),
    new Map(),
  ])("refuses non-JSON values even inside unknown tasks: %s", (tasks) =>
    expect(
      originalPredecessorSettingsReadable(source, { ...fixture(), tasks }),
    ).toBe(false),
  );

  it("refuses getters, inherited data, symbols, hidden extras, cycles and sparse arrays", () => {
    const getter = vi.fn(() => "browser");
    const accessor = fixture();
    Object.defineProperty(accessor.general, "openAtLaunch", {
      enumerable: true,
      get: getter,
    });
    expect(originalPredecessorSettingsReadable(source, accessor)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    const sourceGetter = vi.fn(() => source.version);
    const accessorSource = Object.defineProperty({ ...source }, "version", {
      enumerable: true,
      get: sourceGetter,
    });
    expect(originalPredecessorSettingsReadable(accessorSource, fixture())).toBe(
      false,
    );
    expect(sourceGetter).not.toHaveBeenCalled();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const symbolic = { [Symbol("extra")]: true };
    const hidden = Object.defineProperty({}, "extra", { value: true });
    const inherited = Object.create({ extra: true });
    const sparse = new Array(1);
    const extraArray = Object.assign([true], { extra: true });
    for (const tasks of [
      cyclic,
      symbolic,
      hidden,
      inherited,
      sparse,
      extraArray,
    ])
      expect(
        originalPredecessorSettingsReadable(source, { ...fixture(), tasks }),
      ).toBe(false);
  });

  it("fails closed when boundary inspection throws", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(originalPredecessorSettingsReadable(source, revoked.proxy)).toBe(
      false,
    );
    expect(
      originalPredecessorSettingsReadable(
        revoked.proxy as typeof source,
        fixture(),
      ),
    ).toBe(false);
  });
});
