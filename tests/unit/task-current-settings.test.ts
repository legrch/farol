import {
  currentTaskSettingsFixture as fixture,
  taskSettingsChanges as projectedChanges,
} from "../fixtures/task-settings-cases.ts";
import { taskSettingsProjection } from "../fixtures/task-settings-projection.ts";
import { describe, expect, it, vi } from "vitest";
import {
  codexTaskCurrentSource,
  codexTaskReadCurrentSource,
} from "../../apps/desktop/task-current-settings.ts";
import { validate } from "../../apps/desktop/bridge/wire.ts";
import { resolveOwnerTaskModel } from "../../src/apps/desktop/owner-config.ts";
import { TaskExecutionSettingsSchema } from "../../src/pkg/owner-config/contract.ts";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract.ts";

// CPU value mapping only. These saved witnesses are synthetic; no filesystem,
// provider, account, catalogue, permission, publication or native qualification.
const now = Date.parse("2026-10-04T10:00:00.000Z");
const approvedAt = "2026-10-04T09:50:00.000Z";
const workspaceId = "10000000-0000-4000-8000-000000000001";
const projectId = "10000000-0000-4000-8000-000000000002";
const sha = (letter: string) => letter.repeat(64);
const host = (s: ProductSettings) => s.nativeHosts.codex!;
const route = (s: ProductSettings) => s.nativeHosts.taskRoute!;
const workspace = (s: ProductSettings) => s.computer.workspaces[0]!;
const record = (s: ProductSettings) => host(s).taskSource!;
function handoff(s: ProductSettings) {
  const witness = record(s).evidence.handoff;
  if (witness.status !== "supported")
    throw new Error("fixture_handoff_required");
  return witness;
}
function followup(s: ProductSettings) {
  const witness = record(s).evidence.followup;
  if (witness.status !== "supported")
    throw new Error("fixture_followup_required");
  return witness;
}
const policy = (s: ProductSettings) =>
  TaskExecutionSettingsSchema.parse(s.tasks);
type Edit = (s: ProductSettings) => void;
const refused: Array<[string, Edit]> = [
  [
    "missing policy",
    (s) => {
      delete s.tasks;
    },
  ],
  [
    "invalid policy",
    (s) => {
      s.tasks = { defaultHarness: "missing" };
    },
  ],
  [
    "missing Codex policy without fallback",
    (s) => {
      const p = policy(s);
      delete p.harnesses.codex;
      s.tasks = p;
    },
  ],
  [
    "missing route",
    (s) => {
      s.nativeHosts.taskRoute = null;
    },
  ],
  [
    "missing host",
    (s) => {
      s.nativeHosts.codex = null;
    },
  ],
  [
    "missing record",
    (s) => {
      host(s).taskSource = null;
    },
  ],
  [
    "missing local verification",
    (s) => {
      host(s).localVerification = null;
    },
  ],
  [
    "missing workspace identity",
    (s) => {
      delete workspace(s).rootIdentity;
    },
  ],
  [
    "missing Git metadata",
    (s) => {
      delete workspace(s).gitMetadata;
    },
  ],
  [
    "missing verified setup",
    (s) => {
      s.setup.computer.verified = null;
    },
  ],
  [
    "missing workspace",
    (s) => {
      s.computer.workspaces = [];
    },
  ],
  [
    "duplicate selected workspace",
    (s) => {
      s.computer.workspaces.push(structuredClone(workspace(s)));
    },
  ],
  [
    "host route generation",
    (s) => {
      route(s).hostGeneration++;
    },
  ],
  [
    "computer route generation",
    (s) => {
      route(s).computerGeneration++;
    },
  ],
  [
    "record generation",
    (s) => {
      record(s).hostGeneration++;
    },
  ],
  [
    "unsafe current generation",
    (s) => {
      s.nativeHosts.generation = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "unsafe verified generation",
    (s) => {
      s.setup.computer.verified!.configRevision = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "wrong verified generation",
    (s) => {
      s.setup.computer.verified!.configRevision++;
    },
  ],
  [
    "wrong verified workspace",
    (s) => {
      s.setup.computer.verified!.workspaceId = projectId;
    },
  ],
  [
    "crossed Git common directory",
    (s) => {
      workspace(s).gitMetadata!.commonDirectory = "/fixture/other/.git";
    },
  ],
  [
    "write route with read workspace",
    (s) => {
      workspace(s).access = "read";
    },
  ],
  [
    "excluded path cannot be enforced by Selection",
    (s) => {
      workspace(s).excludedPaths = ["/fixture/writer/private"];
    },
  ],
  [
    "restricted Git cannot be enforced by Selection",
    (s) => {
      workspace(s).gitHistoryApproved = false;
    },
  ],
  [
    "absent full-Git permission",
    (s) => {
      delete workspace(s).gitHistoryApproved;
    },
  ],
  [
    "changed local executable SHA",
    (s) => {
      host(s).localVerification!.executableSha256 = sha("f");
    },
  ],
  [
    "changed local base SHA",
    (s) => {
      host(s).localVerification!.schemaSha256 = sha("f");
    },
  ],
  [
    "crossed record local executable SHA",
    (s) => {
      record(s).localVerification.executableSha256 = sha("f");
    },
  ],
  [
    "crossed record local base SHA",
    (s) => {
      record(s).localVerification.schemaSha256 = sha("f");
    },
  ],
  [
    "crossed record local build",
    (s) => {
      record(s).localVerification.buildId = sha("f");
    },
  ],
  [
    "crossed record local timestamp",
    (s) => {
      record(s).localVerification.verifiedAt = approvedAt;
    },
  ],
  [
    "changed executable path",
    (s) => {
      host(s).executablePath = "/fixture/other-codex";
    },
  ],
  [
    "handoff version mismatch",
    (s) => {
      handoff(s).contract.version = "1.2.4";
    },
  ],
  [
    "handoff digest is not base digest",
    (s) => {
      handoff(s).contract.schemaSha256 = sha("b");
    },
  ],
  [
    "followup must extend handoff",
    (s) => {
      followup(s).contract.baseSchemaSha256 = sha("b");
    },
  ],
  [
    "followup must have independent digest",
    (s) => {
      followup(s).contract.schemaSha256 = sha("c");
    },
  ],
  [
    "followup must differ from host base",
    (s) => {
      followup(s).contract.schemaSha256 = sha("b");
    },
  ],
  [
    "future original grant",
    (s) => {
      route(s).approvedAt = "2026-10-04T10:00:00.001Z";
    },
  ],
  [
    "expired original grant",
    (s) => {
      route(s).expiresAt = now;
    },
  ],
  [
    "zero grant interval",
    (s) => {
      route(s).expiresAt = Date.parse(approvedAt);
    },
  ],
  [
    "original interval over 12h even when remaining time is short",
    (s) => {
      route(s).approvedAt = "2026-10-03T22:00:00.000Z";
    },
  ],
  [
    "unrepresentable expiry",
    (s) => {
      route(s).expiresAt = 8640000000000001;
    },
  ],
  [
    "noncanonical timestamp",
    (s) => {
      route(s).approvedAt = "2026-10-04T09:50:00Z";
    },
  ],
];
for (const field of [
  "executablePath",
  "executableSha256",
  "baseSchemaSha256",
] as const) {
  refused.push([
    `outer source ${field} must match host`,
    (s) => {
      const value =
        field === "executablePath" ? "/fixture/foreign-codex" : sha("f");
      record(s).evidence.handoff[field] = value;
      record(s).evidence.followup[field] = value;
    },
  ]);
}
const rootPaths: Array<[string, Edit]> = [
  [
    "executable",
    (s) => {
      host(s).executablePath = "/";
      record(s).evidence.handoff.executablePath = "/";
      record(s).evidence.followup.executablePath = "/";
    },
  ],
  [
    "socket",
    (s) => {
      route(s).socketPath = "/";
    },
  ],
  [
    "Codex HOME",
    (s) => {
      route(s).expectedCodexHome = "/";
    },
  ],
  [
    "project",
    (s) => {
      route(s).projectRoot = "/";
    },
  ],
  [
    "writer",
    (s) => {
      workspace(s).root = "/";
    },
  ],
  [
    "Git common",
    (s) => {
      route(s).gitCommonDirectory = "/";
      workspace(s).gitMetadata!.commonDirectory = "/";
    },
  ],
  [
    "Git directory",
    (s) => {
      workspace(s).gitMetadata!.gitDirectory = "/";
    },
  ],
];
refused.push(
  ...rootPaths.map(([name, edit]): [string, Edit] => [
    `non-root ${name} required`,
    edit,
  ]),
);

describe("current saved Task Codex source", () => {
  it("maps the explicit Codex default and exact original evidence without issuing Root values", () => {
    const s = fixture();
    const resolved = resolveOwnerTaskModel(s, { harness: "codex" });
    if (resolved.status !== "ready") throw new Error("fixture_model_required");
    const out = codexTaskCurrentSource(s, now)!;
    expect(validate("TaskCodexSource", out)).toBe(true);
    expect(out).toMatchObject({
      projectId,
      workspaceId,
      modelAlias: "preferred",
      model: "fixture-model-v4",
      effort: "high",
      configDigest: resolved.configSha256,
      executablePath: host(s).executablePath,
      executableSha256: sha("a"),
      baseSchemaSha256: sha("b"),
      handoffSchemaSha256: sha("c"),
      project: {
        path: "/fixture/project",
        device: "1",
        inode: "100",
        gitCommonDirectory: "/fixture/project/.git",
      },
      writer: {
        path: "/fixture/writer",
        device: "18446744073709551615",
        inode: "9007199254740993",
        gitCommonDirectory: "/fixture/project/.git",
      },
      grantedAt: approvedAt,
      expiresAt: "2026-10-04T10:50:00.000Z",
      hostGeneration: "7",
      computerGeneration: "11",
      grantHostGeneration: "7",
      grantComputerGeneration: "11",
      verifiedWorkspaceId: workspaceId,
      verifiedComputerGeneration: "11",
      access: "write",
      projectBoundCreateStatus: true,
      followup: {
        kind: "codex-followup-schema/v1",
        protocol: "codex-app-server/v2",
        baseSchemaSha256: sha("c"),
        schemaSha256: sha("d"),
      },
    });
    for (const key of [
      "profileId",
      "hostId",
      "scratchRoot",
      "accountId",
      "parent",
      "taskEpoch",
      "observeThreadId",
      "buildId",
    ])
      expect(out).not.toHaveProperty(key);
  });
  it.each(refused)("keeps %s unavailable", (_name, edit) => {
    const s = fixture();
    edit(s);
    expect(codexTaskCurrentSource(s, now)).toBeUndefined();
  });
  it("requires explicit project-bound create/status and runtime closed witness contracts", () => {
    const s = fixture();
    const invalid = structuredClone(s) as unknown as {
      nativeHosts: {
        codex: {
          taskSource: {
            evidence: {
              handoff: { contract: { projectBoundCreateStatus: boolean } };
            };
          };
        };
      };
    };
    invalid.nativeHosts.codex.taskSource.evidence.handoff.contract.projectBoundCreateStatus = false;
    expect(
      codexTaskCurrentSource(invalid as unknown as ProductSettings, now),
    ).toBeUndefined();
    expect(
      codexTaskCurrentSource(
        { ...s, unexpectedAuthority: true } as ProductSettings,
        now,
      ),
    ).toBeUndefined();
  });
  it("omits unavailable followup without qualifying baseline from unsupported handoff", () => {
    const s = fixture();
    const supported = followup(s);
    record(s).evidence.followup = {
      executablePath: supported.executablePath,
      executableSha256: supported.executableSha256,
      baseSchemaSha256: supported.baseSchemaSha256,
      status: "unavailable",
      code: "CODEX_HOST_FOLLOWUP_UNAVAILABLE",
    };
    const out = codexTaskCurrentSource(s, now);
    expect(out).toBeDefined();
    expect(out).not.toHaveProperty("followup");
    const first = handoff(s);
    record(s).evidence.handoff = {
      executablePath: first.executablePath,
      executableSha256: first.executableSha256,
      baseSchemaSha256: first.baseSchemaSha256,
      status: "unavailable",
      code: "CODEX_HOST_HANDOFF_UNAVAILABLE",
    };
    expect(codexTaskCurrentSource(s, now)).toBeUndefined();
  });
  it("omits absent effort without catalogue/default-effort inference", () => {
    const s = fixture();
    const p = policy(s);
    delete p.harnesses.codex!.models.preferred!.defaultEffort;
    s.tasks = p;
    expect(codexTaskCurrentSource(s, now)).toBeDefined();
    expect(codexTaskCurrentSource(s, now)).not.toHaveProperty("effort");
  });
  it("keeps read access read-only without widening", () => {
    const s = fixture();
    workspace(s).access = "read";
    route(s).execution.sandbox = "read-only";
    expect(codexTaskCurrentSource(s, now)).toMatchObject({
      access: "read",
      sandbox: "read-only",
    });
  });
  it("uses an inclusive original grant start and exclusive expiry with no grant renewal", () => {
    const s = fixture();
    const grant = Date.parse(approvedAt);
    expect(codexTaskCurrentSource(s, grant)).toBeDefined();
    expect(codexTaskCurrentSource(s, grant - 1)).toBeUndefined();
    expect(codexTaskCurrentSource(s, route(s).expiresAt - 1)).toBeDefined();
    expect(codexTaskCurrentSource(s, route(s).expiresAt)).toBeUndefined();
    for (const clock of [NaN, Infinity, now + 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(codexTaskCurrentSource(s, clock)).toBeUndefined();
  });
});

describe("clock-free Task pre-write metadata", () => {
  it.each(projectedChanges)(
    "notices %s before save even when the positive DTO is unavailable",
    (_name, edit) => {
      const before = fixture(),
        after = structuredClone(before);
      edit(after);
      expect(taskSettingsProjection(after)).not.toEqual(
        taskSettingsProjection(before),
      );
    },
  );
  it("keeps Task metadata changes visible while both inputs are unavailable", () => {
    const before = fixture();
    host(before).taskSource = null;
    const after = structuredClone(before);
    route(after).socketPath = "/fixture/changed.sock";
    expect(codexTaskCurrentSource(before, now)).toBeUndefined();
    expect(codexTaskCurrentSource(after, now)).toBeUndefined();
    expect(taskSettingsProjection(after)).not.toEqual(
      taskSettingsProjection(before),
    );
  });
  it("ignores revision/UI labels and clock, normalizes insertion order and exclusion order", () => {
    const before = fixture(),
      after = structuredClone(before);
    after.revision++;
    after.general.activityDetail = "technical";
    after.computer.name = "Renamed";
    workspace(after).label = "Renamed writer";
    after.setup.computer.needsAction = "Changed UI wording";
    after.setup.computer.visited = false;
    expect(taskSettingsProjection(after)).toEqual(
      taskSettingsProjection(before),
    );
    const p = policy(after);
    p.harnesses = { codex: p.harnesses.codex!, other: p.harnesses.other! };
    p.harnesses.codex!.models = {
      spare: p.harnesses.codex!.models.spare!,
      preferred: p.harnesses.codex!.models.preferred!,
    };
    after.tasks = p;
    expect(taskSettingsProjection(after)).toEqual(
      taskSettingsProjection(before),
    );
    workspace(before).excludedPaths = [
      "/fixture/writer/z",
      "/fixture/writer/a",
    ];
    workspace(after).excludedPaths = ["/fixture/writer/a", "/fixture/writer/z"];
    expect(taskSettingsProjection(after)).toEqual(
      taskSettingsProjection(before),
    );
  });
  it("does not read ambient time, mutate inputs or alias returned snapshots", () => {
    const s = fixture(),
      original = structuredClone(s);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("ambient_clock_forbidden");
    });
    try {
      const projection = taskSettingsProjection(s),
        snapshot = structuredClone(projection);
      const source = codexTaskCurrentSource(s, now),
        sourceCopy = structuredClone(source);
      expect(s).toEqual(original);
      route(s).projectIdentity.inode = "200";
      followup(s).contract.schemaSha256 = sha("f");
      expect(projection).toEqual(snapshot);
      expect(source).toEqual(sourceCopy);
    } finally {
      clock.mockRestore();
    }
  });
  it("marks invalid settings and preserves absence rather than inventing a positive snapshot", () => {
    const s = fixture();
    s.nativeHosts.taskRoute = null;
    s.nativeHosts.codex = null;
    expect(taskSettingsProjection(s)).toMatchObject({
      nativeHosts: { route: null, host: null },
      computer: { unique: false, selectedWorkspaceId: null, workspaces: [] },
    });
    expect(taskSettingsProjection(null as unknown as ProductSettings)).toEqual({
      status: "settings-invalid",
    });
  });
});

describe("exact Codex read current source", () => {
  const threadId = "10000000-0000-4000-8000-000000000004";
  function selected(): ProductSettings {
    const s = fixture();
    route(s).observeThreadId = threadId;
    route(s).observeTurnId = "turn-exact";
    return s;
  }

  it("binds the exact reference to the existing current source and policy metadata", () => {
    const s = selected();
    route(s).execution.sandbox = "read-only";
    workspace(s).access = "read";
    const out = codexTaskReadCurrentSource(s, now);
    expect(out).toEqual({
      reference: { threadId, turnId: "turn-exact" },
      source: codexTaskCurrentSource(s, now),
    });
    expect(out?.source).toMatchObject({
      sandbox: "read-only",
      access: "read",
      model: "fixture-model-v4",
      effort: "high",
      hostGeneration: "7",
      computerGeneration: "11",
    });
    for (const key of [
      "lifecycle",
      "retained",
      "resultEvidence",
      "profileId",
      "hostId",
    ])
      expect(out).not.toHaveProperty(key);
  });

  it.each(refused)(
    "refuses existing current-source failure: %s",
    (_name, edit) => {
      const s = selected();
      edit(s);
      expect(codexTaskReadCurrentSource(s, now)).toBeUndefined();
    },
  );

  it("keeps legacy absent/thread-only selection readable without inventing an exact turn", () => {
    const s = fixture();
    expect(ProductSettingsSchema.safeParse(s).success).toBe(true);
    expect(codexTaskCurrentSource(s, now)).toBeDefined();
    expect(codexTaskReadCurrentSource(s, now)).toBeUndefined();
    route(s).observeThreadId = threadId;
    expect(ProductSettingsSchema.safeParse(s).success).toBe(true);
    expect(codexTaskCurrentSource(s, now)).toBeDefined();
    expect(codexTaskReadCurrentSource(s, now)).toBeUndefined();
  });

  it.each([
    { observeThreadId: undefined, observeTurnId: "turn-exact" },
    { observeThreadId: "not-a-thread", observeTurnId: "turn-exact" },
    { observeThreadId: threadId, observeTurnId: "" },
    { observeThreadId: threadId, observeTurnId: "latest turn" },
    { observeThreadId: threadId, observeTurnId: "foreign/path" },
    { observeThreadId: threadId, observeTurnId: null },
  ])("refuses malformed/partial saved reference %j", (reference) => {
    const s = selected();
    Object.assign(route(s), reference);
    expect(codexTaskReadCurrentSource(s, now)).toBeUndefined();
  });

  it.each(["unknown", "unreachable"] as const)(
    "refuses %s current reachability",
    (reachable) => {
      const s = selected();
      s.setup.computer.reachable = reachable;
      expect(codexTaskReadCurrentSource(s, now)).toBeUndefined();
    },
  );

  it("refuses unknown outcome, expired grant and invalid clocks", () => {
    const s = selected();
    s.setup.computer.outcomeUnknown = true;
    expect(codexTaskReadCurrentSource(s, now)).toBeUndefined();
    s.setup.computer.outcomeUnknown = false;
    for (const clock of [route(s).expiresAt, NaN, Infinity, now + 0.5])
      expect(codexTaskReadCurrentSource(s, clock)).toBeUndefined();
  });

  it.each(["observeThreadId", "observeTurnId"] as const)(
    "detects changed %s without changing the old snapshot",
    (key) => {
      const before = selected();
      const snapshot = codexTaskReadCurrentSource(before, now);
      const after = structuredClone(before);
      route(after)[key] = key === "observeThreadId" ? projectId : "turn-later";
      expect(codexTaskCurrentSource(after, now)).toEqual(
        codexTaskCurrentSource(before, now),
      );
      expect(taskSettingsProjection(after)).not.toEqual(
        taskSettingsProjection(before),
      );
      expect(codexTaskReadCurrentSource(after, now)).not.toEqual(snapshot);
      expect(snapshot?.reference).toEqual({ threadId, turnId: "turn-exact" });
    },
  );

  it("keeps changed exact selection visible while both current sources are unavailable", () => {
    const before = selected();
    host(before).taskSource = null;
    const after = structuredClone(before);
    route(after).observeTurnId = "turn-later";
    expect(codexTaskReadCurrentSource(before, now)).toBeUndefined();
    expect(codexTaskReadCurrentSource(after, now)).toBeUndefined();
    expect(taskSettingsProjection(after)).not.toEqual(
      taskSettingsProjection(before),
    );
  });

  it("binds policy changes and never reads ambient time, mutates or aliases settings", () => {
    const s = selected();
    const original = structuredClone(s);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("ambient_clock_forbidden");
    });
    try {
      const out = codexTaskReadCurrentSource(s, now);
      const copy = structuredClone(out);
      expect(s).toEqual(original);
      const p = policy(s);
      p.harnesses.codex!.models.preferred!.model = "changed-model";
      s.tasks = p;
      expect(out).toEqual(copy);
      expect(codexTaskReadCurrentSource(s, now)).not.toEqual(out);
      expect(
        codexTaskReadCurrentSource(s, now)?.source.configDigest,
      ).not.toEqual(out?.source.configDigest);
    } finally {
      clock.mockRestore();
    }
  });
});
