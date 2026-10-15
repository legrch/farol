// Shared synthetic f892 source/projection vectors. No provider/native authority.
import { TaskExecutionSettingsSchema } from "../../src/pkg/owner-config/contract.ts";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract.ts";

const now = Date.parse("2026-10-04T10:00:00.000Z");
const approvedAt = "2026-10-04T09:50:00.000Z";
const verifiedAt = "2026-10-04T09:00:00.000Z";
const workspaceId = "10000000-0000-4000-8000-000000000001";
const projectId = "10000000-0000-4000-8000-000000000002";
const sha = (letter: string) => letter.repeat(64);
export function currentTaskSettingsFixture(): ProductSettings {
  const readiness = {
    visited: true,
    skipped: false,
    configured: true,
    reachable: "reachable",
    verified: null,
    needsAction: null,
    unavailable: null,
    outcomeUnknown: false,
  };
  const outer = {
    executablePath: "/fixture/bin/codex",
    executableSha256: sha("a"),
    baseSchemaSha256: sha("b"),
  };
  const localVerification = {
    executableSha256: sha("a"),
    schemaSha256: sha("b"),
    buildId: sha("e"),
    verifiedAt,
  };
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    tasks: {
      defaultHarness: "other",
      harnesses: {
        other: {
          defaultModel: "other",
          models: { other: { model: "unimplemented-model" } },
        },
        codex: {
          defaultModel: "preferred",
          models: {
            preferred: { model: "fixture-model-v4", defaultEffort: "high" },
            spare: { model: "fixture-spare" },
          },
        },
      },
    },
    computer: {
      computerId: "10000000-0000-4000-8000-000000000003",
      generation: 11,
      name: "Fixture",
      commands: "workspace",
      workspaces: [
        {
          workspaceId,
          root: "/fixture/writer",
          label: "Writer",
          access: "write",
          excludedPaths: [],
          gitHistoryApproved: true,
          rootIdentity: {
            device: "18446744073709551615",
            inode: "9007199254740993",
          },
          gitMetadata: {
            gitDirectory: "/fixture/project/.git/worktrees/writer",
            commonDirectory: "/fixture/project/.git",
          },
        },
      ],
    },
    nativeHosts: {
      generation: 7,
      codex: {
        executablePath: outer.executablePath,
        executableSha256: outer.executableSha256,
        version: "1.2.3",
        protocol: "codex-app-server/v2",
        schemaSha256: outer.baseSchemaSha256,
        verifiedAt,
        localVerification,
        taskSource: {
          hostGeneration: 7,
          localVerification: { ...localVerification },
          evidence: {
            handoff: {
              ...outer,
              status: "supported",
              contract: {
                version: "1.2.3",
                protocol: "codex-app-server/v2",
                schemaSha256: sha("c"),
                projectBoundCreateStatus: true,
              },
            },
            followup: {
              ...outer,
              status: "supported",
              contract: {
                kind: "codex-followup-schema/v1",
                protocol: "codex-app-server/v2",
                baseSchemaSha256: sha("c"),
                schemaSha256: sha("d"),
              },
            },
          },
        },
      },
      taskRoute: {
        transport: "codex-shared-proxy/v1",
        harness: "codex",
        workspaceId,
        projectId,
        socketPath: "/fixture/proxy.sock",
        expectedCodexHome: "/fixture/codex-home",
        projectRoot: "/fixture/project",
        projectIdentity: { device: "1", inode: "100" },
        gitCommonDirectory: "/fixture/project/.git",
        execution: { sandbox: "workspace-write", approvalPolicy: "on-request" },
        hostGeneration: 7,
        computerGeneration: 11,
        approvedAt,
        expiresAt: now + 50 * 60 * 1000,
      },
    },
    setup: {
      chatgpt: readiness,
      connect: readiness,
      hosts: readiness,
      verify: readiness,
      computer: {
        ...readiness,
        verified: {
          profile: "distinct-desktop-profile",
          configRevision: 11,
          workspaceId,
          runtimeGeneration: "desktop-runtime",
          buildId: sha("f"),
          protocol: "desktop-computer-fixture",
          verifiedAt,
        },
      },
    },
  });
}
const host = (s: ProductSettings) => s.nativeHosts.codex!;
const route = (s: ProductSettings) => s.nativeHosts.taskRoute!;
const workspace = (s: ProductSettings) => s.computer.workspaces[0]!;
const record = (s: ProductSettings) => host(s).taskSource!;
const policy = (s: ProductSettings) =>
  TaskExecutionSettingsSchema.parse(s.tasks);
type Edit = (s: ProductSettings) => void;
export const taskSettingsChanges: Array<[string, Edit]> = [
  [
    "global task policy",
    (s) => {
      const p = policy(s);
      p.defaultHarness = "codex";
      s.tasks = p;
    },
  ],
  [
    "unselected alias",
    (s) => {
      const p = policy(s);
      p.harnesses.codex!.models.spare!.model = "changed-spare";
      s.tasks = p;
    },
  ],
  [
    "other harness",
    (s) => {
      const p = policy(s);
      p.harnesses.other!.models.other!.model = "changed-other";
      s.tasks = p;
    },
  ],
  [
    "host generation",
    (s) => {
      s.nativeHosts.generation++;
    },
  ],
  [
    "computer generation",
    (s) => {
      s.computer.generation++;
    },
  ],
  [
    "route optional observation",
    (s) => {
      route(s).observeThreadId = projectId;
    },
  ],
  [
    "route exact observation turn",
    (s) => {
      route(s).observeThreadId = projectId;
      route(s).observeTurnId = "turn-exact";
    },
  ],
  [
    "route original approval",
    (s) => {
      route(s).approvedAt = verifiedAt;
    },
  ],
  [
    "route original expiry",
    (s) => {
      route(s).expiresAt++;
    },
  ],
  [
    "route transport metadata",
    (s) => {
      route(s).socketPath = "/fixture/new-proxy.sock";
    },
  ],
  [
    "selected host executable",
    (s) => {
      host(s).executablePath = "/fixture/new-codex";
    },
  ],
  [
    "source withdrawal",
    (s) => {
      host(s).taskSource = null;
    },
  ],
  [
    "local verification build",
    (s) => {
      host(s).localVerification!.buildId = sha("f");
    },
  ],
  [
    "record source provenance",
    (s) => {
      record(s).localVerification.verifiedAt = approvedAt;
    },
  ],
  [
    "writer physical identity",
    (s) => {
      workspace(s).rootIdentity!.inode = "9007199254740994";
    },
  ],
  [
    "linked Git directory",
    (s) => {
      workspace(s).gitMetadata!.gitDirectory =
        "/fixture/project/.git/worktrees/other";
    },
  ],
  [
    "writer access",
    (s) => {
      workspace(s).access = "read";
    },
  ],
  [
    "exclusions",
    (s) => {
      workspace(s).excludedPaths = ["/fixture/writer/private"];
    },
  ],
  [
    "Git restriction",
    (s) => {
      workspace(s).gitHistoryApproved = false;
    },
  ],
  [
    "missing selected workspace",
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
    "setup profile provenance",
    (s) => {
      s.setup.computer.verified!.profile = "changed-profile";
    },
  ],
  [
    "setup runtime provenance",
    (s) => {
      s.setup.computer.verified!.runtimeGeneration = "changed-runtime";
    },
  ],
  [
    "setup protocol provenance",
    (s) => {
      s.setup.computer.verified!.protocol = "changed-protocol";
    },
  ],
  [
    "setup build provenance",
    (s) => {
      s.setup.computer.verified!.buildId = sha("e");
    },
  ],
  [
    "setup time provenance",
    (s) => {
      s.setup.computer.verified!.verifiedAt = approvedAt;
    },
  ],
  [
    "setup reachability",
    (s) => {
      s.setup.computer.reachable = "unknown";
    },
  ],
  [
    "setup unknown outcome",
    (s) => {
      s.setup.computer.outcomeUnknown = true;
    },
  ],
];
