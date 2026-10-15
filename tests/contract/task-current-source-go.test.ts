// CPU-only parity of synthetic saved values. No native/profile/provider evidence.
import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  currentTaskSettingsFixture as fixture,
  taskSettingsChanges,
} from "../fixtures/task-settings-cases.ts";
import {
  codexTaskCurrentSource,
  codexTaskReadCurrentSource,
} from "../fixtures/task-current-source-oracle.ts";
import { startTaskSourceFixture } from "../fixtures/task-source/process.ts";
import { taskSettingsFacts } from "../../apps/desktop/bridge/task-current-settings.ts";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract.ts";

const now = Date.parse("2026-10-04T10:00:00.000Z");
const thread = "10000000-0000-4000-8000-000000000004";
const host = (s: ProductSettings) => s.nativeHosts.codex!;
const route = (s: ProductSettings) => s.nativeHosts.taskRoute!;
const workspace = (s: ProductSettings) => s.computer.workspaces[0]!;
const record = (s: ProductSettings) => host(s).taskSource!;
const handoff = (s: ProductSettings) => {
  const w = record(s).evidence.handoff;
  if (w.status !== "supported") throw new Error("fixture_handoff_required");
  return w;
};
const followup = (s: ProductSettings) => {
  const w = record(s).evidence.followup;
  if (w.status !== "supported") throw new Error("fixture_followup_required");
  return w;
};
function selected() {
  const s = fixture();
  route(s).observeThreadId = thread;
  route(s).observeTurnId = "turn-exact";
  return s;
}
type Edit = (s: ProductSettings) => void;
function at(s: ProductSettings, path: string, value: unknown) {
  const keys = path.split(".");
  let parent: Record<string, unknown> = s as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1))
    parent = parent[key] as Record<string, unknown>;
  if (value === undefined) delete parent[keys.at(-1)!];
  else parent[keys.at(-1)!] = value;
}
let processFixture: Awaited<ReturnType<typeof startTaskSourceFixture>>;
beforeAll(async () => {
  processFixture = await startTaskSourceFixture();
}, 40000);
afterAll(async () => {
  await processFixture?.close();
});
async function parity(s: ProductSettings, clock = now, available?: boolean) {
  const original = structuredClone(s);
  const source = codexTaskCurrentSource(s, clock),
    read = codexTaskReadCurrentSource(s, clock);
  if (available !== undefined) expect(source !== undefined).toBe(available);
  const reply = await processFixture.resolve(
    JSON.stringify(taskSettingsFacts(s)),
    clock,
  );
  expect(reply).toEqual(
    source === undefined
      ? { status: "absent" }
      : {
          status: "available",
          source,
          ...(read === undefined ? {} : { read: read.reference }),
        },
  );
  expect(s).toEqual(original);
  return source;
}

it("preserves the exact baseline producer with only its bridge import and origin comment adjusted", () => {
  const preserved = readFileSync(
    new URL("../fixtures/task-current-source-oracle.ts", import.meta.url),
    "utf8",
  )
    .split("\n")
    .slice(2)
    .join("\n");
  const original = preserved.replace(
    'from "../../apps/desktop/bridge/wire.ts"',
    'from "./bridge/wire.ts"',
  );
  expect(createHash("sha256").update(original).digest("hex")).toBe(
    "536d9ff6ef93c7e3cb03fc0c37c6b94c440746bb4d91a6f7b5390eb87d882bac",
  );
});
it("compares every positive DTO field and exact read reference, with large identity strings", async () => {
  const source = await parity(selected(), now, true);
  expect(source).toMatchObject({
    modelAlias: "preferred",
    model: "fixture-model-v4",
    effort: "high",
    writer: { device: "18446744073709551615", inode: "9007199254740993" },
    hostGeneration: "7",
    computerGeneration: "11",
    followup: { schemaSha256: "d".repeat(64) },
  });
});
it.each(taskSettingsChanges)(
  "compares independent saved metadata change: %s",
  async (_name, edit) => {
    const s = selected();
    edit(s);
    await parity(s);
  },
);

const refused: Array<[string, Edit]> = [
  ["missing tasks", (s) => delete s.tasks],
  ["invalid policy", (s) => (s.tasks = { defaultHarness: "missing" })],
  ["route", (s) => (s.nativeHosts.taskRoute = null)],
  ["host", (s) => (s.nativeHosts.codex = null)],
  ["record", (s) => (host(s).taskSource = null)],
  ["local verification", (s) => (host(s).localVerification = null)],
  ["workspace identity", (s) => delete workspace(s).rootIdentity],
  ["git metadata", (s) => delete workspace(s).gitMetadata],
  ["verified setup", (s) => (s.setup.computer.verified = null)],
  ["selected workspace", (s) => (s.computer.workspaces = [])],
  [
    "duplicate selected workspace",
    (s) => s.computer.workspaces.push(structuredClone(workspace(s))),
  ],
  ["write confinement", (s) => (workspace(s).access = "read")],
  [
    "exclusion",
    (s) => (workspace(s).excludedPaths = ["/fixture/writer/private"]),
  ],
  ["restricted Git", (s) => (workspace(s).gitHistoryApproved = false)],
  ["missing Git permission", (s) => delete workspace(s).gitHistoryApproved],
  [
    "crossed Git",
    (s) => (workspace(s).gitMetadata!.commonDirectory = "/other/.git"),
  ],
  ["handoff version", (s) => (handoff(s).contract.version = "1.2.4")],
  [
    "handoff base digest",
    (s) => (handoff(s).contract.schemaSha256 = "b".repeat(64)),
  ],
  [
    "followup wrong base",
    (s) => (followup(s).contract.baseSchemaSha256 = "b".repeat(64)),
  ],
  [
    "followup handoff digest",
    (s) => (followup(s).contract.schemaSha256 = "c".repeat(64)),
  ],
  [
    "followup host digest",
    (s) => (followup(s).contract.schemaSha256 = "b".repeat(64)),
  ],
  ["unrepresentable expiry", (s) => (route(s).expiresAt = 8640000000000001)],
  [
    "noncanonical timestamp",
    (s) => (route(s).approvedAt = "2026-10-04T09:50:00Z"),
  ],
  [
    "overlong original grant",
    (s) => (route(s).approvedAt = "2026-10-03T22:00:00.000Z"),
  ],
];
for (const path of [
  "nativeHosts.generation",
  "computer.generation",
  "nativeHosts.taskRoute.hostGeneration",
  "nativeHosts.taskRoute.computerGeneration",
  "nativeHosts.codex.taskSource.hostGeneration",
  "setup.computer.verified.configRevision",
]) {
  for (const value of [0, -1, Number.MAX_SAFE_INTEGER + 1, 12])
    refused.push([`${path}=${value}`, (s) => at(s, path, value)]);
}
for (const path of [
  "nativeHosts.codex.localVerification.executableSha256",
  "nativeHosts.codex.localVerification.schemaSha256",
  "nativeHosts.codex.taskSource.localVerification.executableSha256",
  "nativeHosts.codex.taskSource.localVerification.schemaSha256",
  "nativeHosts.codex.taskSource.localVerification.buildId",
  "nativeHosts.codex.taskSource.evidence.handoff.executableSha256",
  "nativeHosts.codex.taskSource.evidence.followup.baseSchemaSha256",
])
  refused.push([`crossed ${path}`, (s) => at(s, path, "f".repeat(64))]);
for (const path of [
  "nativeHosts.codex.taskSource.localVerification.verifiedAt",
  "setup.computer.verified.workspaceId",
])
  refused.push([
    `crossed ${path}`,
    (s) =>
      at(
        s,
        path,
        path.endsWith("workspaceId") ? thread : "2026-10-04T09:50:00.000Z",
      ),
  ]);
for (const path of [
  "nativeHosts.taskRoute.socketPath",
  "nativeHosts.taskRoute.expectedCodexHome",
  "nativeHosts.taskRoute.projectRoot",
  "nativeHosts.taskRoute.gitCommonDirectory",
  "computer.workspaces.0.root",
  "computer.workspaces.0.gitMetadata.gitDirectory",
])
  for (const value of [
    "/",
    "relative",
    "/fixture/../escape",
    "/fixture//double",
    "/fixture/trailing/",
  ])
    refused.push([`${path} noncanonical ${value}`, (s) => at(s, path, value)]);
for (const path of [
  "nativeHosts.codex.taskSource.evidence.handoff.contract.projectBoundCreateStatus",
  "nativeHosts.codex.taskSource.evidence.followup.contract.kind",
  "nativeHosts.codex.taskSource.evidence.followup.contract.unexpectedAuthority",
])
  refused.push([
    `malformed closed witness ${path}`,
    (s) =>
      at(
        s,
        path,
        path.endsWith("projectBoundCreateStatus") ? false : "unexpected",
      ),
  ]);
it.each(refused)("keeps prerequisite unavailable: %s", async (_name, edit) => {
  const s = selected();
  edit(s);
  await parity(s, now, false);
});

it.each([
  "CODEX_HOST_SCHEMA_UNSAFE",
  "CODEX_HOST_SCHEMA_INVALID",
  "CODEX_HOST_HANDOFF_UNAVAILABLE",
  "CODEX_HOST_FOLLOWUP_UNAVAILABLE",
  "CODEX_HOST_TASK_SOURCE_CHANGED",
  "CODEX_HOST_TASK_SOURCE_UNCONFIRMED",
] as const)(
  "preserves full-schema negative followup evidence %s",
  async (code) => {
    const s = selected(),
      before = followup(s);
    record(s).evidence.followup = {
      executablePath: before.executablePath,
      executableSha256: before.executableSha256,
      baseSchemaSha256: before.baseSchemaSha256,
      status: "unavailable",
      code,
    };
    expect(ProductSettingsSchema.safeParse(s).success).toBe(
      code !== "CODEX_HOST_TASK_SOURCE_CHANGED",
    );
    const out = await parity(s, now, code !== "CODEX_HOST_TASK_SOURCE_CHANGED");
    if (out !== undefined) expect(out).not.toHaveProperty("followup");
  },
);
it("refuses unavailable handoff and paired changed witnesses", async () => {
  for (const code of [
    "CODEX_HOST_HANDOFF_UNAVAILABLE",
    "CODEX_HOST_TASK_SOURCE_CHANGED",
  ] as const) {
    const s = selected();
    for (const key of ["handoff", "followup"] as const) {
      const old = record(s).evidence[key];
      record(s).evidence[key] = {
        executablePath: old.executablePath,
        executableSha256: old.executableSha256,
        baseSchemaSha256: old.baseSchemaSha256,
        status: "unavailable",
        code,
      };
    }
    await parity(s, now, false);
  }
});
it("keeps optional effort absent and binds the selected model plus the whole policy digest", async () => {
  const s = selected();
  const p = s.tasks as {
    harnesses: {
      codex: {
        defaultModel: string;
        models: Record<string, { model: string; defaultEffort?: string }>;
      };
      other: { models: { other: { model: string } } };
    };
  };
  delete p.harnesses.codex.models.preferred!.defaultEffort;
  expect(await parity(s, now, true)).not.toHaveProperty("effort");
  const original = await parity(s, now, true);
  p.harnesses.codex.defaultModel = "spare";
  expect(await parity(s, now, true)).toMatchObject({
    modelAlias: "spare",
    model: "fixture-spare",
  });
  p.harnesses.codex.defaultModel = "preferred";
  p.harnesses.other.models.other.model = "different-other";
  const changed = await parity(s, now, true);
  expect(changed?.model).toBe(original?.model);
  expect(changed?.configDigest).not.toBe(original?.configDigest);
});
it("retains read-only scope and permits unrelated selected workspace order", async () => {
  const s = selected();
  route(s).execution.sandbox = "read-only";
  workspace(s).access = "read";
  s.computer.workspaces.unshift({
    ...structuredClone(workspace(s)),
    workspaceId: thread,
    root: "/unselected",
  });
  await parity(s, now, true);
});
it("preserves inclusive start, exclusive end, and maximum 12h interval", async () => {
  const s = selected(),
    start = Date.parse(route(s).approvedAt),
    end = route(s).expiresAt;
  for (const [clock, available] of [
    [start - 1, false],
    [start, true],
    [end - 1, true],
    [end, false],
  ] as const)
    await parity(s, clock, available);
  route(s).expiresAt = start + 12 * 60 * 60 * 1000;
  await parity(s, now, true);
  route(s).expiresAt++;
  await parity(s, now, false);
});
it.each([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "10000000-0000-4AbC-8Def-000000000004",
  "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
  "ffffffff-ffff-ffff-ffff-fffffffffffF",
])("matches pinned UUID special cases %s", async (id) => {
  const s = selected();
  route(s).observeThreadId = id;
  const valid = ProductSettingsSchema.safeParse(s).success;
  expect(valid).toBe(!id.includes("F"));
  await parity(s, now, valid);
});
it.each(["unknown", "unreachable"] as const)(
  "keeps source while withholding exact read for %s",
  async (reachable) => {
    const s = selected();
    s.setup.computer.reachable = reachable;
    await parity(s, now, true);
    expect(codexTaskReadCurrentSource(s, now)).toBeUndefined();
  },
);
it("withholds exact read for unknown outcome, absent selection and thread-only selection", async () => {
  for (const edit of [
    (s: ProductSettings) => (s.setup.computer.outcomeUnknown = true),
    (s: ProductSettings) => {
      delete route(s).observeThreadId;
      delete route(s).observeTurnId;
    },
    (s: ProductSettings) => delete route(s).observeTurnId,
  ]) {
    const s = selected();
    edit(s);
    await parity(s, now, true);
    expect(codexTaskReadCurrentSource(s, now)).toBeUndefined();
  }
});
it.each([
  { observeThreadId: undefined, observeTurnId: "turn-exact" },
  { observeThreadId: "not-a-thread", observeTurnId: "turn-exact" },
  { observeThreadId: thread, observeTurnId: "" },
  { observeThreadId: thread, observeTurnId: "latest turn" },
  { observeThreadId: thread, observeTurnId: "foreign/path" },
  { observeThreadId: thread, observeTurnId: null },
])("rejects malformed exact read %j", async (reference) => {
  const s = selected();
  Object.assign(route(s), reference);
  await parity(s, now, false);
});
it.each([
  "general.openAtLaunch",
  "setup.chatgpt.visited",
  "computer.name",
  "unexpectedAuthority",
])(
  "preserves full ProductSettings-invalid sentinel for unrelated %s",
  async (path) => {
    const s = selected();
    at(s, path, path === "unexpectedAuthority" ? true : 123);
    expect(ProductSettingsSchema.safeParse(s).success).toBe(false);
    expect(taskSettingsFacts(s)).toEqual({ status: "settings-invalid" });
    await parity(s, now, false);
  },
);
it("keeps malformed raw facts and invalid explicit clocks as errors, separate from old producer absence", async () => {
  for (const raw of [
    "{",
    '{"status":"parsed","status":"settings-invalid"}',
    '{"status":"settings-invalid","authority":true}',
    " ".repeat((1 << 20) + 1),
  ])
    expect(await processFixture.resolve(raw, now)).toEqual({
      error: "TASK_CURRENT_SOURCE_INVALID",
    });
  const s = selected();
  for (const clock of [Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, now + 0.5]) {
    expect(codexTaskCurrentSource(s, clock)).toBeUndefined();
    expect(
      await processFixture.resolve(JSON.stringify(taskSettingsFacts(s)), clock),
    ).toEqual({ error: "TASK_CURRENT_SOURCE_INVALID" });
  }
});

it.each([
  ["missing configured Codex harness", "tasks.harnesses.codex", undefined],
  ["wrong route harness", "nativeHosts.taskRoute.harness", "other"],
  [
    "missing selected model alias",
    "tasks.harnesses.codex.defaultModel",
    "missing",
  ],
  ["host protocol", "nativeHosts.codex.protocol", "codex-app-server/v3"],
  [
    "changed handoff protocol",
    "nativeHosts.codex.taskSource.evidence.handoff.contract.protocol",
    "codex-app-server/v3",
  ],
  [
    "changed followup protocol",
    "nativeHosts.codex.taskSource.evidence.followup.contract.protocol",
    "codex-app-server/v3",
  ],
  [
    "malformed digest",
    "nativeHosts.codex.taskSource.evidence.handoff.contract.schemaSha256",
    "A".repeat(64),
  ],
  ["zero expiry", "nativeHosts.taskRoute.expiresAt", 0],
  [
    "empty interval",
    "nativeHosts.taskRoute.expiresAt",
    Date.parse("2026-10-04T09:50:00.000Z"),
  ],
] as const)("refuses %s", async (_name, path, value) => {
  const s = selected();
  at(s, path, value);
  await parity(s, now, false);
});
it("checks all shared physical roots without accidentally aliasing the writer and project", async () => {
  for (const target of ["executable", "git"] as const) {
    const s = selected();
    if (target === "executable") {
      host(s).executablePath = "/";
      record(s).evidence.handoff.executablePath = "/";
      record(s).evidence.followup.executablePath = "/";
    } else {
      route(s).gitCommonDirectory = "/";
      workspace(s).gitMetadata!.commonDirectory = "/";
    }
    await parity(s, now, false);
  }
});
it("matches transport normalization without assuming a parsed facts payload certifies full settings", async () => {
  const s = selected();
  const raw = JSON.stringify(taskSettingsFacts(s));
  // The trusted adapter emits integer tokens; manually forged exponent facts
  // are outside that boundary, even when JS parsing would normalize the value.
  const exponent = raw.replace('"hostGeneration":7', '"hostGeneration":7e0');
  expect(await processFixture.resolve(exponent, now)).toEqual({
    error: "TASK_CURRENT_SOURCE_INVALID",
  });
  const normalized = JSON.stringify(JSON.parse(exponent));
  expect(normalized).toBe(raw);
  expect(await processFixture.resolve(normalized, now)).toEqual(
    await processFixture.resolve(raw, now),
  );
  for (const raw of [
    '{"status":"settings-invalid"} trailing',
    '{"status":"settings-invalid","x":"\\ud800"}',
  ])
    expect(await processFixture.resolve(raw, now)).toEqual({
      error: "TASK_CURRENT_SOURCE_INVALID",
    });
});
it("enforces the final wire model and year constraints after valid saved settings", async () => {
  for (const model of ["_starts-with-underscore", "/leading-slash"]) {
    const s = selected();
    at(s, "tasks.harnesses.codex.models.preferred.model", model);
    expect(ProductSettingsSchema.safeParse(s).success).toBe(true);
    await parity(s, now, false);
  }
  for (const start of [
    "0000-01-01T00:00:00.000Z",
    "+010000-01-01T00:00:00.000Z",
  ]) {
    const s = selected();
    route(s).approvedAt = start;
    route(s).expiresAt = Date.parse(start) + 3600000;
    await parity(s, Date.parse(start), false);
  }
});
it("preserves positive coherent generation changes and leading zero identity strings", async () => {
  const s = selected();
  s.nativeHosts.generation = Number.MAX_SAFE_INTEGER;
  route(s).hostGeneration = Number.MAX_SAFE_INTEGER;
  record(s).hostGeneration = Number.MAX_SAFE_INTEGER;
  s.computer.generation = Number.MAX_SAFE_INTEGER;
  route(s).computerGeneration = Number.MAX_SAFE_INTEGER;
  s.setup.computer.verified!.configRevision = Number.MAX_SAFE_INTEGER;
  route(s).projectIdentity.device = "0001";
  workspace(s).rootIdentity!.inode = "00000000000000000000";
  await parity(s, now, true);
});
it("supports both approval policies and never infers a default effort from the catalogue", async () => {
  const s = selected();
  route(s).execution.approvalPolicy = "untrusted";
  const p = s.tasks as {
    harnesses: { codex: { models: { preferred: { defaultEffort?: string } } } };
  };
  p.harnesses.codex.models.preferred.defaultEffort = "xhigh";
  await parity(s, now, true);
});

it("normalizes policy object insertion order while binding changed exact read references", async () => {
  const s = selected(),
    before = await parity(s, now, true);
  const p = s.tasks as {
    harnesses: Record<
      string,
      { models: Record<string, { model: string; defaultEffort?: string }> }
    >;
  };
  p.harnesses = { codex: p.harnesses.codex!, other: p.harnesses.other! };
  p.harnesses.codex!.models = {
    spare: p.harnesses.codex!.models.spare!,
    preferred: p.harnesses.codex!.models.preferred!,
  };
  expect(await parity(s, now, true)).toEqual(before);
  route(s).observeThreadId = route(s).projectId;
  route(s).observeTurnId = "turn-later";
  expect(await parity(s, now, true)).toEqual(before);
});
it.each([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "10000000-0000-4AbC-8Def-000000000004",
])(
  "keeps source identifiers subject to their final wire contract: %s",
  async (id) => {
    const s = selected();
    route(s).workspaceId = id;
    workspace(s).workspaceId = id;
    s.setup.computer.verified!.workspaceId = id;
    route(s).projectId = id;
    await parity(s, now, false);
  },
);
