import { lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

import type { ReadonlyWorkspace } from "../../app/port/readonly-workspace";
import {
  createParticipantAuthority,
  delegateParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type DelegationAdmission,
  type ParticipantAuthority,
  type TaskAdmission,
} from "../../domain/execution-authority";
import {
  DevMcpProofPreparationSchema,
  type DevMcpProofPreparation,
} from "./dev-mcp-proof";
import type { ReadonlyComputerMcpBinding } from "./create-readonly-computer-mcp";
import {
  CodexCallerRelayEndpointSchema,
  type CodexCallerRelayEndpoint,
} from "../../../../pkg/caller-relay/protocol";

export const READONLY_COMPUTER_LAUNCH_BASENAME = "computer-launch.json";

const IdentifierSchema = z.string().min(1).max(120);
const OwnerIdentifierSchema = z.string().min(1).max(80);
const ReadonlyCapabilitySchema = z.enum([
  "workspace.list",
  "workspace.read",
  "workspace.search",
  "verification.run",
]);
const MutableCapabilitySchema = z.enum([
  "workspace.list",
  "workspace.read",
  "workspace.search",
  "verification.run",
  "workspace.write",
]);
const CommandAuthoritySchema = z.enum(["none", "verification"]);

function canonicalAbsolutePath(value: string): boolean {
  return (
    value.length > 1 &&
    value.length <= 4_096 &&
    value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value
      .split("/")
      .slice(1)
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          Buffer.byteLength(part, "utf8") <= 255,
      )
  );
}

const AbsolutePathSchema = z.string().refine(canonicalAbsolutePath);
const RootIdentitySchema = z.strictObject({
  device: z.string().regex(/^[0-9]{1,20}$/u),
  inode: z.string().regex(/^[0-9]{1,20}$/u),
});
const GitMetadataSchema = z.strictObject({
  gitDirectory: AbsolutePathSchema,
  commonDirectory: AbsolutePathSchema,
});
const ReadonlyApprovedWorkspaceSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  root: AbsolutePathSchema,
  access: z.literal("read"),
  rootIdentity: RootIdentitySchema,
  gitMetadata: GitMetadataSchema.optional(),
});
const ReadonlySubtreeScopeSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  mode: z.literal("subtree"),
  root: AbsolutePathSchema,
  access: z.literal("read"),
});
const ReadonlyExactScopeSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  mode: z.literal("exact"),
  root: AbsolutePathSchema,
  paths: z.array(AbsolutePathSchema).min(1).max(500),
  access: z.literal("read"),
});
const ReadonlyWorkspaceScopeSchema = z.discriminatedUnion("mode", [
  ReadonlySubtreeScopeSchema,
  ReadonlyExactScopeSchema,
]);
const MutableApprovedWorkspaceSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  root: AbsolutePathSchema,
  access: z.enum(["read", "write"]),
  rootIdentity: RootIdentitySchema,
  gitMetadata: GitMetadataSchema.optional(),
});
const MutableSubtreeScopeSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  mode: z.literal("subtree"),
  root: AbsolutePathSchema,
  access: z.enum(["read", "write"]),
});
const MutableExactScopeSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  mode: z.literal("exact"),
  root: AbsolutePathSchema,
  paths: z.array(AbsolutePathSchema).min(1).max(500),
  access: z.enum(["read", "write"]),
});
const MutableWorkspaceScopeSchema = z.discriminatedUnion("mode", [
  MutableSubtreeScopeSchema,
  MutableExactScopeSchema,
]);
const WorkspaceExclusionSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  path: AbsolutePathSchema,
});
const ReadonlyComputerApprovalSchema = z.strictObject({
  ownerId: OwnerIdentifierSchema,
  computerId: IdentifierSchema,
  generation: z.number().int().nonnegative(),
  workspaces: z.array(ReadonlyApprovedWorkspaceSchema).min(1).max(32),
  excludedPaths: z.array(WorkspaceExclusionSchema).max(32).optional(),
  capabilities: z.array(ReadonlyCapabilitySchema).min(1).max(5),
  network: z.literal("none"),
  commands: CommandAuthoritySchema,
  expiresAt: z.number().int().positive().safe(),
});
const ReadonlyTaskAdmissionSchema = z.strictObject({
  authorityId: IdentifierSchema,
  ownerId: OwnerIdentifierSchema,
  sessionId: IdentifierSchema,
  taskId: IdentifierSchema,
  taskEpoch: z.number().int().nonnegative(),
  computerId: IdentifierSchema,
  computerGeneration: z.number().int().nonnegative(),
  workspaces: z.array(ReadonlyWorkspaceScopeSchema).min(1).max(32),
  excludedPaths: z.array(WorkspaceExclusionSchema).max(32).optional(),
  capabilities: z.array(ReadonlyCapabilitySchema).min(1).max(5),
  network: z.literal("none"),
  commands: CommandAuthoritySchema,
  expiresAt: z.number().int().positive().safe(),
});
const ReadonlyAuthorityNarrowingSchema = z.strictObject({
  workspaces: z.array(ReadonlyWorkspaceScopeSchema).min(1).max(32),
  excludedPaths: z.array(WorkspaceExclusionSchema).max(32).optional(),
  capabilities: z.array(ReadonlyCapabilitySchema).min(1).max(5),
  network: z.literal("none"),
  commands: CommandAuthoritySchema,
});
const ReadonlyParticipantSchema = z.strictObject({
  participantId: IdentifierSchema,
  role: z.enum(["main", "agent", "critic"]),
  mutationOwnership: z.literal("none"),
  narrowing: ReadonlyAuthorityNarrowingSchema.optional(),
});
const MutableComputerApprovalSchema = z.strictObject({
  ownerId: OwnerIdentifierSchema,
  computerId: IdentifierSchema,
  generation: z.number().int().nonnegative(),
  workspaces: z.array(MutableApprovedWorkspaceSchema).min(1).max(32),
  excludedPaths: z.array(WorkspaceExclusionSchema).max(32).optional(),
  capabilities: z.array(MutableCapabilitySchema).min(1).max(5),
  network: z.literal("none"),
  commands: CommandAuthoritySchema,
  expiresAt: z.number().int().positive().safe(),
});
const MutableTaskAdmissionSchema = z.strictObject({
  authorityId: IdentifierSchema,
  ownerId: OwnerIdentifierSchema,
  sessionId: IdentifierSchema,
  taskId: IdentifierSchema,
  taskEpoch: z.number().int().nonnegative(),
  computerId: IdentifierSchema,
  computerGeneration: z.number().int().nonnegative(),
  workspaces: z.array(MutableWorkspaceScopeSchema).min(1).max(32),
  excludedPaths: z.array(WorkspaceExclusionSchema).max(32).optional(),
  capabilities: z.array(MutableCapabilitySchema).min(1).max(5),
  network: z.literal("none"),
  commands: CommandAuthoritySchema,
  expiresAt: z.number().int().positive().safe(),
});
const MutableAuthorityNarrowingSchema = z.strictObject({
  workspaces: z.array(MutableWorkspaceScopeSchema).min(1).max(32),
  excludedPaths: z.array(WorkspaceExclusionSchema).max(32).optional(),
  capabilities: z.array(MutableCapabilitySchema).min(1).max(5),
  network: z.literal("none"),
  commands: CommandAuthoritySchema,
});
const MutableParticipantSchema = z.strictObject({
  participantId: IdentifierSchema,
  role: z.enum(["main", "agent", "critic"]),
  mutationOwnership: z.enum(["none", "task"]),
  narrowing: MutableAuthorityNarrowingSchema.optional(),
});
const BindingSchema = z.strictObject({
  participantId: IdentifierSchema,
  turnId: IdentifierSchema,
  generation: z.number().int().nonnegative(),
});
const ConnectorVerificationSchema = z.strictObject({
  challengeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const CallerRelayEndpointSchema = CodexCallerRelayEndpointSchema.refine(
  (value) => canonicalAbsolutePath(value.socketPath),
);
export const CodexTaskRouteLaunchSchema = z.strictObject({
  transport: z.literal("codex-shared-proxy/v1"),
  host: z.strictObject({
    executablePath: AbsolutePathSchema,
    executableSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    socketPath: AbsolutePathSchema,
    expectedCodexHome: AbsolutePathSchema,
  }),
  grant: z.strictObject({
    workspaceId: IdentifierSchema,
    writerRoot: AbsolutePathSchema,
    writerIdentity: RootIdentitySchema,
    projectId: IdentifierSchema,
    projectRoot: AbsolutePathSchema,
    projectIdentity: RootIdentitySchema,
    gitCommonDirectory: AbsolutePathSchema,
    execution: z.strictObject({
      sandbox: z.enum(["read-only", "workspace-write"]),
      approvalPolicy: z.enum(["untrusted", "on-request"]),
    }),
    model: z.string().regex(/^[A-Za-z0-9_.\/-]{1,120}$/u),
    reasoningEffort: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/u),
    expiresAt: z.number().int().positive().safe(),
  }),
});
export type CodexTaskRouteLaunch = z.infer<typeof CodexTaskRouteLaunchSchema>;

function validateChain(
  value: Readonly<{
    delegationChain: readonly Readonly<{
      participantId: string;
      role: "agent" | "critic" | "main";
      narrowing?: unknown;
    }>[];
    binding: Readonly<{ participantId: string }>;
    codexTasks?: z.infer<typeof CodexTaskRouteLaunchSchema> | undefined;
    approval: Readonly<{
      expiresAt: number;
      workspaces: readonly Readonly<{
        workspaceId: string;
        root: string;
        access: "read" | "write";
        rootIdentity: Readonly<{ device: string; inode: string }>;
        gitMetadata?: Readonly<{ commonDirectory: string }> | undefined;
      }>[];
    }>;
  }>,
  context: z.RefinementCtx,
): void {
  const first = value.delegationChain[0];
  const last = value.delegationChain.at(-1);
  if (first?.role !== "main" || first.narrowing !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["delegationChain", 0],
      message:
        "The delegation chain must begin with an unrestricted main participant.",
    });
  }
  if (last?.participantId !== value.binding.participantId) {
    context.addIssue({
      code: "custom",
      path: ["binding", "participantId"],
      message: "The MCP binding must target the final delegated participant.",
    });
  }
  const participants = value.delegationChain.map(
    (participant) => participant.participantId,
  );
  if (new Set(participants).size !== participants.length) {
    context.addIssue({
      code: "custom",
      path: ["delegationChain"],
      message: "Participant identifiers must be unique.",
    });
  }
  const task = value.codexTasks?.grant;
  if (task) {
    const workspace = value.approval.workspaces.find(
      (entry) => entry.workspaceId === task.workspaceId,
    );
    if (
      !workspace ||
      workspace.root !== task.writerRoot ||
      workspace.rootIdentity.device !== task.writerIdentity.device ||
      workspace.rootIdentity.inode !== task.writerIdentity.inode ||
      workspace.gitMetadata?.commonDirectory !== task.gitCommonDirectory ||
      (task.execution.sandbox === "workspace-write" &&
        workspace.access !== "write") ||
      task.expiresAt > value.approval.expiresAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["codexTasks", "grant"],
        message: "Codex task admission must match one approved Git workspace.",
      });
    }
  }
}

const ReadonlyLaunchContractSchema = z
  .strictObject({
    schema: z.literal(1),
    approval: ReadonlyComputerApprovalSchema,
    admission: ReadonlyTaskAdmissionSchema,
    delegationChain: z.array(ReadonlyParticipantSchema).min(1).max(16),
    binding: BindingSchema,
    connectorVerification: ConnectorVerificationSchema.optional(),
    devMcpProof: DevMcpProofPreparationSchema.optional(),
    callerRelay: CallerRelayEndpointSchema.optional(),
    codexTasks: CodexTaskRouteLaunchSchema.optional(),
  })
  .superRefine(validateChain);

const MutableLaunchContractSchema = z
  .strictObject({
    schema: z.literal(2),
    approval: MutableComputerApprovalSchema,
    admission: MutableTaskAdmissionSchema,
    delegationChain: z.array(MutableParticipantSchema).min(1).max(16),
    binding: BindingSchema,
    connectorVerification: ConnectorVerificationSchema.optional(),
    devMcpProof: DevMcpProofPreparationSchema.optional(),
    callerRelay: CallerRelayEndpointSchema.optional(),
    codexTasks: CodexTaskRouteLaunchSchema.optional(),
  })
  .superRefine(validateChain);

export const ReadonlyComputerLaunchContractSchema = z.union([
  ReadonlyLaunchContractSchema,
  MutableLaunchContractSchema,
]);

export type ReadonlyComputerLaunchContract = z.infer<
  typeof ReadonlyComputerLaunchContractSchema
>;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical(
            (value as Readonly<Record<string, JsonValue>>)[key] as JsonValue,
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function serializeReadonlyComputerLaunchContract(
  value: ReadonlyComputerLaunchContract,
): string {
  const parsed = ReadonlyComputerLaunchContractSchema.parse(value);
  return `${canonical(parsed as JsonValue)}\n`;
}

export function parseReadonlyComputerLaunchContract(
  text: string,
): ReadonlyComputerLaunchContract {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("COMPUTER_LAUNCH_JSON_INVALID");
  }
  const parsed = ReadonlyComputerLaunchContractSchema.safeParse(value);
  if (!parsed.success) throw new Error("COMPUTER_LAUNCH_SCHEMA_INVALID");
  if (text !== `${canonical(parsed.data as JsonValue)}\n`) {
    throw new Error("COMPUTER_LAUNCH_CANONICAL_INVALID");
  }
  return parsed.data;
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: typeof left) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export async function loadReadonlyComputerLaunchContract(
  file: string,
  workspace: ReadonlyWorkspace,
): Promise<ReadonlyComputerLaunchContract> {
  if (
    !canonicalAbsolutePath(file) ||
    path.basename(file) !== READONLY_COMPUTER_LAUNCH_BASENAME
  ) {
    throw new Error("COMPUTER_LAUNCH_PATH_INVALID");
  }
  const expectedUid = process.getuid?.();
  if (expectedUid === undefined)
    throw new Error("COMPUTER_LAUNCH_HOST_INVALID");
  const before = await lstat(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== expectedUid ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    before.size <= 0 ||
    before.size > 256 * 1_024
  ) {
    throw new Error("COMPUTER_LAUNCH_FILE_UNTRUSTED");
  }
  // The launch directory is Farol's own private state; the helper is bound to
  // the directory object measured here, like every other helper read.
  const directory = await lstat(path.dirname(file), { bigint: true });
  if (!directory.isDirectory())
    throw new Error("COMPUTER_LAUNCH_FILE_UNTRUSTED");
  const result = await workspace.execute({
    workspace: {
      workspaceId: "farol-next-computer-launch",
      root: path.dirname(file),
      deniedPaths: [],
      approvedRoot: {
        path: path.dirname(file),
        device: String(directory.dev),
        inode: String(directory.ino),
      },
    },
    operation: {
      kind: "workspace.read",
      relativePath: READONLY_COMPUTER_LAUNCH_BASENAME,
    },
  });
  if (!result.ok || result.value.kind !== "workspace.text") {
    throw new Error("COMPUTER_LAUNCH_READ_REFUSED");
  }
  const after = await lstat(file);
  if (!sameFile(before, after)) {
    throw new Error("COMPUTER_LAUNCH_RACE_DETECTED");
  }
  return parseReadonlyComputerLaunchContract(result.value.text);
}

export type MaterializedReadonlyComputerLaunch = Readonly<{
  approval: ComputerApproval;
  participants: readonly ParticipantAuthority[];
  binding: ReadonlyComputerMcpBinding;
  mutationEnabled: boolean;
  connectorVerification: Readonly<{ challengeSha256: string }> | null;
  devMcpProof: DevMcpProofPreparation | null;
  callerRelay: CodexCallerRelayEndpoint | null;
  codexTasks: z.infer<typeof CodexTaskRouteLaunchSchema> | null;
}>;

export function materializeReadonlyComputerLaunch(
  launch: ReadonlyComputerLaunchContract,
  now: number,
): MaterializedReadonlyComputerLaunch {
  const approval: ComputerApproval = launch.approval;
  const admission: TaskAdmission = launch.admission;
  const grant = deriveTaskGrant(approval, admission, now);
  if (!grant.ok) throw new Error(`COMPUTER_LAUNCH_${grant.error.code}`);

  const [root, ...delegates] = launch.delegationChain;
  if (root === undefined) throw new Error("COMPUTER_LAUNCH_CHAIN_INVALID");
  const main = createParticipantAuthority(grant.value, {
    participantId: root.participantId,
    role: root.role,
    mutationOwnership: root.mutationOwnership,
  });
  if (!main.ok) throw new Error(`COMPUTER_LAUNCH_${main.error.code}`);

  const participants: ParticipantAuthority[] = [main.value];
  let parent = main.value;
  for (const delegate of delegates) {
    const delegation: DelegationAdmission = {
      participantId: delegate.participantId,
      role: delegate.role,
      mutationOwnership: delegate.mutationOwnership,
      ...(delegate.narrowing === undefined
        ? {}
        : { narrowing: delegate.narrowing }),
    };
    const delegated = delegateParticipantAuthority(parent, delegation);
    if (!delegated.ok) {
      throw new Error(`COMPUTER_LAUNCH_${delegated.error.code}`);
    }
    participants.push(delegated.value);
    parent = delegated.value;
  }
  if (parent.participantId !== launch.binding.participantId) {
    throw new Error("COMPUTER_LAUNCH_BINDING_INVALID");
  }
  return {
    approval,
    participants,
    mutationEnabled:
      launch.schema === 2 &&
      approval.capabilities.includes("workspace.write") &&
      parent.mutationOwnership === "task" &&
      parent.grant.workspaces.some((workspace) => workspace.access === "write"),
    binding: {
      ownerId: admission.ownerId,
      sessionId: admission.sessionId,
      taskId: admission.taskId,
      taskEpoch: admission.taskEpoch,
      participantId: launch.binding.participantId,
      turnId: launch.binding.turnId,
      generation: launch.binding.generation,
    },
    connectorVerification: launch.connectorVerification ?? null,
    devMcpProof: launch.devMcpProof ?? null,
    callerRelay: launch.callerRelay ?? null,
    codexTasks: launch.codexTasks ?? null,
  };
}
