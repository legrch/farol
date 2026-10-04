import assert from "node:assert/strict";

// Independent observations of native Go JSON, not DTO inputs, boot authority,
// journal replay or an import of a production adapter. Zero values below follow
// modules/chat/{domain/turn,app/port}; a changed raw schema fails closed.
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const id = (value) =>
  assert.ok(
    typeof value === "string" && value.length > 0 && value.length <= 120,
    "READ_ID_UNKNOWN",
  );
const zeroIdentity = () => ({
  ProfileID: "",
  OwnerID: "",
  SessionID: "",
  TaskID: "",
  TurnID: "",
  OperationID: "",
  Generation: 0,
});
const reservation = () => ({
  Identity: zeroIdentity(),
  Ordinal: 0,
  Generation: 0,
  BackendGeneration: "",
});
const browser = () => ({
  Reservation: reservation(),
  Document: {
    ProviderState: "",
    ViewID: "",
    ViewGeneration: 0,
    DocumentGeneration: 0,
    ConversationID: "",
  },
});
const result = () => ({ ID: "", Outcome: "", Code: "" });
const quiescence = () => ({
  Binding: browser(),
  ResultID: "",
  Sequence: 0,
  Confirmed: false,
});
const disposal = () => ({
  Reservation: reservation(),
  ResultID: "",
  Confirmed: false,
});
function snapshot(identity = zeroIdentity()) {
  return {
    Identity: identity,
    Phase: "",
    Reserved: false,
    Reservation: reservation(),
    Bound: false,
    Binding: browser(),
    SendIntent: false,
    Accepted: false,
    DeltaCount: 0,
    LastSequence: 0,
    OutstandingCallID: "",
    HasResult: false,
    Result: result(),
    DeliveryAcknowledged: false,
    LifecycleSettled: false,
  };
}
export const readCanary = Object.freeze({
  relativePath: "read-preview-canary.txt",
  text: "Farol disposable read canary: café / Ελληνικά / 日本語 / 🧭\nSecond line: e\u0301.\n",
});

export function previewWitness(preview, workspace) {
  assert.deepEqual(
    Object.keys(preview).sort(),
    [
      "kind",
      "operationId",
      "workspaceId",
      "workspaceLabel",
      "relativePath",
      "bytes",
      "contextCharacters",
      "contextLimit",
      "contextTruncated",
      "excludedPaths",
      "expiresAt",
    ].sort(),
    "READ_PREVIEW_SCHEMA_CHANGED",
  );
  assert.equal(preview.kind, "chatgpt.readonly-task-preview");
  assert.match(preview.operationId, uuid);
  assert.equal(
    preview.workspaceId,
    workspace.workspaceId,
    "READ_PREVIEW_WORKSPACE_CROSSED",
  );
  assert.equal(preview.workspaceLabel, workspace.label);
  assert.equal(
    preview.relativePath,
    readCanary.relativePath,
    "READ_PREVIEW_PATH_CROSSED",
  );
  assert.ok(Buffer.byteLength(readCanary.text) > readCanary.text.length);
  assert.equal(
    preview.bytes,
    Buffer.byteLength(readCanary.text),
    "READ_PREVIEW_BYTES_CHANGED",
  );
  assert.equal(
    preview.contextCharacters,
    readCanary.text.length,
    "READ_PREVIEW_CHARACTERS_CHANGED",
  );
  assert.equal(preview.contextLimit, 24000);
  assert.equal(preview.contextTruncated, false);
  assert.deepEqual(
    preview.excludedPaths,
    workspace.excludedPaths.map((value) =>
      value.slice(workspace.root.length + 1),
    ),
  );
  assert.equal(new Date(preview.expiresAt).toISOString(), preview.expiresAt);
}

function expectedWrites(scope, binding, digest) {
  const identity = {
    ProfileID: binding.ProfileID,
    OwnerID: binding.OwnerID,
    SessionID: binding.SessionID,
    TaskID: binding.TaskID,
    TurnID: binding.TurnID,
    OperationID: binding.OperationID,
    Generation: binding.TurnGeneration,
  };
  const admitted = { ...snapshot(identity), Phase: "admitted" };
  const cancelled = {
    ...admitted,
    Phase: "cancelled",
    HasResult: true,
    LifecycleSettled: true,
    Result: {
      ID: binding.OperationID,
      Outcome: "cancelled",
      Code: "NOT_DISPATCHED",
    },
  };
  const acknowledged = { ...cancelled, DeliveryAcknowledged: true };
  return [
    ["admit", snapshot(), admitted],
    ["cancel", admitted, cancelled],
    ["acknowledge", cancelled, acknowledged],
  ].map(([Kind, Before, After], index) => ({
    Scope: scope,
    PreviousRevision: index,
    Revision: index + 1,
    Entry: {
      Binding: binding,
      Kind,
      Before,
      After,
      IntentDigest: index === 0 ? digest : "",
      CallID: "",
      Effect: "",
      Closed: index > 0,
      Quiescence: quiescence(),
      Disposal: disposal(),
    },
  }));
}
export function readJournalWitness(
  journal,
  initial,
  preview,
  stage,
  originalBinding,
) {
  assert.deepEqual(initial.writes, [], "READ_BASELINE_NOT_EMPTY");
  assert.equal(initial.retirement, null);
  assert.ok(["preview", "discarded", "retired"].includes(stage));
  const binding = journal.writes?.[0]?.Entry?.Binding;
  assert.ok(binding, "READ_ADMISSION_MISSING");
  assert.deepEqual(
    Object.keys(binding).sort(),
    [
      "ProfileID",
      "BackendGeneration",
      "OwnerID",
      "SessionID",
      "TaskID",
      "TaskEpoch",
      "ParticipantID",
      "TurnID",
      "OperationID",
      "TurnGeneration",
    ].sort(),
  );
  assert.equal(binding.ProfileID, initial.scope.ProfileID);
  assert.equal(
    binding.BackendGeneration,
    initial.scope.BackendGeneration,
    "READ_OWNER_GENERATION_CHANGED",
  );
  assert.equal(binding.OwnerID, "owner-desktop");
  assert.equal(
    binding.TaskID,
    preview.operationId,
    "READ_PREVIEW_TASK_CROSSED",
  );
  for (const key of ["SessionID", "ParticipantID", "TurnID", "OperationID"])
    id(binding[key]);
  assert.notEqual(
    binding.OperationID,
    preview.operationId,
    "READ_TRANSPORT_ID_USED_AS_PREVIEW",
  );
  assert.equal(binding.TaskEpoch, 1);
  assert.equal(binding.TurnGeneration, 1);
  if (originalBinding)
    assert.deepEqual(binding, originalBinding, "READ_ORIGINAL_OWNER_CHANGED");
  const digest = journal.writes[0].Entry.IntentDigest;
  assert.match(digest, /^[a-f0-9]{64}$/u);
  const writes = expectedWrites(initial.scope, binding, digest);
  const retirement =
    stage === "retired"
      ? {
          Scope: initial.scope,
          Root: initial.root,
          PreviousRevision: 3,
          Revision: 4,
          Turns: [
            {
              Binding: binding,
              Snapshot: writes[2].Entry.After,
              AcknowledgedRevision: 3,
              SettledRevision: 0,
              ReleasedRevision: 0,
              Quiescence: quiescence(),
              Disposal: disposal(),
            },
          ],
        }
      : null;
  assert.deepEqual(
    journal,
    {
      ...initial,
      writes: stage === "preview" ? writes.slice(0, 1) : writes,
      retirement,
    },
    "READ_JOURNAL_TRANSITIONS_CHANGED",
  );
  return binding;
}

export function approvedSettingsWitness(
  settings,
  workspaceRoot,
  physical,
  buildId,
) {
  assert.equal(
    settings.computer.workspaces.length,
    1,
    "READ_WORKSPACE_COUNT_CHANGED",
  );
  const workspace = settings.computer.workspaces[0];
  assert.equal(workspace.root, workspaceRoot, "READ_WORKSPACE_ROOT_CHANGED");
  assert.equal(workspace.access, "read");
  assert.deepEqual(
    workspace.rootIdentity,
    { device: physical.Device, inode: physical.Inode },
    "READ_WORKSPACE_PHYSICAL_CHANGED",
  );
  assert.deepEqual(workspace.excludedPaths, []);
  assert.notEqual(workspace.gitHistoryApproved, true);
  assert.equal(settings.computer.commands, "none");
  assert.equal(workspace.gitMetadata, undefined);
  const verification = settings.setup.computer.verified;
  assert.equal(verification?.workspaceId, workspace.workspaceId);
  assert.equal(verification?.configRevision, settings.computer.generation);
  assert.equal(verification?.buildId, buildId);
  assert.equal(verification?.protocol, "readonly-workspace/1");
  const readiness = settings.setup.chatgpt.verified;
  assert.equal(readiness?.buildId, buildId);
  assert.equal(readiness?.protocol, "chatgpt-page-readiness/1");
  assert.equal(readiness?.profile, "chatgpt.next-partition/1");
  for (const key of ["computer", "chatgpt"])
    assert.equal(settings.setup[key].outcomeUnknown, false);
  return workspace;
}

export function readAccessWitness(profile, access, settings, binding) {
  assert.deepEqual(Object.keys(profile).sort(), [
    "computerId",
    "profileId",
    "schema",
  ]);
  assert.deepEqual(Object.keys(access).sort(), [
    "approval",
    "computerId",
    "generation",
    "ownerId",
    "participants",
    "profileId",
    "revision",
    "schema",
    "seenApproval",
  ]);
  assert.equal(profile.schema, "farol-native-profile/1");
  assert.equal(profile.computerId, settings.computer.computerId);
  assert.equal(profile.profileId, binding.ProfileID);
  assert.equal(access.schema, 1);
  assert.equal(access.profileId, profile.profileId);
  assert.equal(access.ownerId, binding.OwnerID);
  assert.equal(access.computerId, profile.computerId);
  assert.match(access.revision, /^[1-9][0-9]*$/u);
  assert.equal(access.generation, String(settings.computer.generation));
  assert.equal(access.seenApproval, true);
  const approval = access.approval;
  assert.ok(approval, "READ_APPROVAL_MISSING");
  assert.deepEqual(
    Object.keys(approval).sort(),
    [
      "ownerId",
      "computerId",
      "generation",
      "workspaces",
      "excludedPaths",
      "capabilities",
      "network",
      "commands",
      "expiresAt",
    ].sort(),
  );
  assert.equal(approval.ownerId, binding.OwnerID);
  assert.equal(approval.computerId, profile.computerId);
  assert.equal(approval.generation, access.generation);
  assert.equal(approval.workspaces.length, 1);
  const workspace = settings.computer.workspaces[0];
  assert.deepEqual(approval.workspaces[0], {
    workspaceId: workspace.workspaceId,
    root: workspace.root,
    access: "read",
    rootIdentity: workspace.rootIdentity,
    gitHistoryApproved: false,
    shellVerified: false,
  });
  assert.deepEqual(
    approval.excludedPaths,
    workspace.excludedPaths.map((path) => ({
      workspaceId: workspace.workspaceId,
      path,
      restrictionSource: "computer-approval",
    })),
  );
  assert.equal(approval.network, "none");
  assert.equal(approval.commands, settings.computer.commands);
  assert.deepEqual(approval.capabilities, [
    "workspace.list",
    "workspace.read",
    "workspace.search",
    ...(settings.computer.commands === "none" ? [] : ["verification.run"]),
  ]);
  assert.ok(Number.isSafeInteger(approval.expiresAt) && approval.expiresAt > 0);
  assert.deepEqual(
    Object.keys(access.participants),
    [binding.ParticipantID],
    "READ_EXTRA_PARTICIPANT",
  );
  const participant = access.participants[binding.ParticipantID];
  assert.deepEqual(
    Object.keys(participant).sort(),
    [
      "participantId",
      "parentParticipantId",
      "role",
      "mutationOwnership",
      "authorityId",
      "ownerId",
      "sessionId",
      "taskId",
      "taskEpoch",
      "computerId",
      "computerGeneration",
      "policy",
      "revoked",
    ].sort(),
  );
  for (const [key, value] of Object.entries({
    participantId: binding.ParticipantID,
    ownerId: binding.OwnerID,
    sessionId: binding.SessionID,
    taskId: binding.TaskID,
    taskEpoch: "1",
    computerId: profile.computerId,
    computerGeneration: access.generation,
    parentParticipantId: "",
    role: "main",
    mutationOwnership: "none",
    revoked: false,
  }))
    assert.equal(participant[key], value, "READ_PARTICIPANT_CROSSED");
  id(participant.authorityId);
  assert.deepEqual(participant.policy, {
    workspaces: [
      {
        workspaceId: workspace.workspaceId,
        root: workspace.root,
        mode: "subtree",
        paths: null,
        access: "read",
        restrictionSource: "task-grant",
      },
    ],
    excludedPaths: approval.excludedPaths,
    capabilities: ["workspace.list", "workspace.read"],
    network: "none",
    commands: "none",
    expiresAt: participant.policy.expiresAt,
  });
  assert.ok(
    Number.isSafeInteger(participant.policy.expiresAt) &&
      participant.policy.expiresAt > 0 &&
      participant.policy.expiresAt <= approval.expiresAt,
  );
}

export function legacyPreviewWitness(record, operationId, phase) {
  assert.deepEqual(
    Object.keys(record).sort(),
    [
      "schema",
      "operationId",
      "kind",
      "phase",
      "createdAt",
      "updatedAt",
      "result",
    ].sort(),
  );
  assert.equal(record.schema, 1);
  assert.equal(record.operationId, operationId, "READ_LEGACY_ID_CROSSED");
  assert.equal(record.kind, "readonly");
  assert.equal(record.phase, phase);
  assert.equal(record.result, null, "READ_PROVIDER_RESULT_PERSISTED");
  for (const key of ["createdAt", "updatedAt"])
    assert.equal(new Date(record[key]).toISOString(), record[key]);
  assert.ok(Date.parse(record.updatedAt) >= Date.parse(record.createdAt));
}

export function retainedApprovedSettings(current, previous) {
  assert.deepEqual(current, previous, "READ_REOPEN_SETTINGS_CHANGED");
}

export function consumedReadHandoffWitness(current, original) {
  assert.equal(original.Stage, "CHILD_TERMINATED");
  assert.ok(current.Consumption, "READ_HANDOFF_CONSUMPTION_MISSING");
  assert.deepEqual(
    current,
    {
      ...original,
      Stage: "SUCCESSOR_CONSUMED",
      Consumption: current.Consumption,
    },
    "READ_HANDOFF_ORIGINAL_CHANGED",
  );
}

export function readWitnessSelfTest(pass, reject) {
  const initial = {
    version: 2,
    root: { Device: 1, Inode: 2, OwnerUID: 501 },
    scope: { ProfileID: "profile", BackendGeneration: "original" },
    incarnations: ["original"],
    writes: [],
    retirement: null,
  };
  const workspace = {
    workspaceId: "workspace",
    label: "Synthetic workspace",
    root: "/synthetic/workspace",
    access: "read",
    rootIdentity: { device: "1", inode: "2" },
    excludedPaths: [],
  };
  const preview = {
    kind: "chatgpt.readonly-task-preview",
    operationId: "12345678-1234-4234-8234-123456789abc",
    workspaceId: workspace.workspaceId,
    workspaceLabel: workspace.label,
    relativePath: readCanary.relativePath,
    bytes: Buffer.byteLength(readCanary.text),
    contextCharacters: readCanary.text.length,
    contextLimit: 24000,
    contextTruncated: false,
    excludedPaths: [],
    expiresAt: "2026-10-04T12:00:00.000Z",
  };
  pass(() => previewWitness(preview, workspace));
  for (const mutation of [
    { workspaceId: "crossed" },
    { relativePath: "other.txt" },
    { bytes: readCanary.text.length },
    { contextCharacters: Buffer.byteLength(readCanary.text) },
    { contextTruncated: true },
    { bodySHA256: "a".repeat(64) },
  ])
    reject(() => previewWitness({ ...preview, ...mutation }, workspace));
  const binding = {
    ...initial.scope,
    OwnerID: "owner-desktop",
    SessionID: "session",
    TaskID: preview.operationId,
    TaskEpoch: 1,
    ParticipantID: "participant",
    TurnID: "turn",
    OperationID: "admission",
    TurnGeneration: 1,
  };
  const writes = expectedWrites(initial.scope, binding, "a".repeat(64));
  const journal = { ...initial, writes };
  const retirement = {
    Scope: initial.scope,
    Root: initial.root,
    PreviousRevision: 3,
    Revision: 4,
    Turns: [
      {
        Binding: binding,
        Snapshot: writes[2].Entry.After,
        AcknowledgedRevision: 3,
        SettledRevision: 0,
        ReleasedRevision: 0,
        Quiescence: quiescence(),
        Disposal: disposal(),
      },
    ],
  };
  pass(() =>
    readJournalWitness(
      { ...initial, writes: writes.slice(0, 1) },
      initial,
      preview,
      "preview",
    ),
  );
  pass(() =>
    readJournalWitness(journal, initial, preview, "discarded", binding),
  );
  pass(() =>
    readJournalWitness(
      { ...journal, retirement },
      initial,
      preview,
      "retired",
      binding,
    ),
  );
  // Mutate every native leaf: IDs, revisions, ACK absence, reservation fields,
  // provider/document identity, Send, outstanding calls and cleanup witnesses.
  const leaves = (value, prefix = []) =>
    Object.entries(value).flatMap(([key, item]) =>
      item && typeof item === "object"
        ? leaves(item, [...prefix, key])
        : [[...prefix, key]],
    );
  for (const keys of leaves({ ...journal, retirement })) {
    const changed = structuredClone({ ...journal, retirement });
    let target = changed;
    for (const key of keys.slice(0, -1)) target = target[key];
    const key = keys.at(-1),
      value = target[key];
    target[key] =
      typeof value === "boolean"
        ? !value
        : typeof value === "number"
          ? value + 1
          : `${value}-crossed`;
    reject(() =>
      readJournalWitness(changed, initial, preview, "retired", binding),
    );
  }
  for (const mutation of [
    { writes: writes.slice(0, 2) },
    { writes: [...writes, writes[2]] },
    { writes: [] },
    { retirement },
  ])
    reject(() =>
      readJournalWitness(
        { ...journal, ...mutation },
        initial,
        preview,
        "discarded",
        binding,
      ),
    );
  reject(() =>
    readJournalWitness(
      {
        ...journal,
        scope: { ...initial.scope, BackendGeneration: "successor" },
      },
      initial,
      preview,
      "discarded",
      binding,
    ),
  );
  pass(() =>
    retainedApprovedSettings(
      { computer: { workspaces: [workspace] } },
      { computer: { workspaces: [workspace] } },
    ),
  );
  reject(() =>
    retainedApprovedSettings(
      { computer: { workspaces: [] } },
      { computer: { workspaces: [workspace] } },
    ),
  );
  const settings = {
    computer: {
      computerId: "computer",
      generation: 3,
      commands: "none",
      workspaces: [workspace],
    },
    setup: {
      computer: {
        verified: {
          workspaceId: workspace.workspaceId,
          configRevision: 3,
          buildId: "build",
          protocol: "readonly-workspace/1",
        },
        outcomeUnknown: false,
      },
      chatgpt: {
        verified: {
          buildId: "build",
          protocol: "chatgpt-page-readiness/1",
          profile: "chatgpt.next-partition/1",
        },
        outcomeUnknown: false,
      },
    },
  };
  const physical = { Device: "1", Inode: "2" };
  pass(() =>
    approvedSettingsWitness(settings, workspace.root, physical, "build"),
  );
  for (const mutation of [
    { root: "/crossed" },
    { rootIdentity: { device: "1", inode: "3" } },
    { access: "write" },
    { gitHistoryApproved: true },
    { excludedPaths: ["/synthetic/workspace/denied"] },
  ])
    reject(() =>
      approvedSettingsWitness(
        {
          ...settings,
          computer: {
            ...settings.computer,
            workspaces: [{ ...workspace, ...mutation }],
          },
        },
        workspace.root,
        physical,
        "build",
      ),
    );
  const profile = {
    schema: "farol-native-profile/1",
    profileId: binding.ProfileID,
    computerId: "computer",
  };
  const approval = {
    ownerId: binding.OwnerID,
    computerId: "computer",
    generation: "3",
    workspaces: [
      {
        workspaceId: workspace.workspaceId,
        root: workspace.root,
        access: "read",
        rootIdentity: workspace.rootIdentity,
        gitHistoryApproved: false,
        shellVerified: false,
      },
    ],
    excludedPaths: [],
    capabilities: ["workspace.list", "workspace.read", "workspace.search"],
    network: "none",
    commands: "none",
    expiresAt: 100000,
  };
  const participant = {
    participantId: binding.ParticipantID,
    parentParticipantId: "",
    role: "main",
    mutationOwnership: "none",
    authorityId: "authority",
    ownerId: binding.OwnerID,
    sessionId: binding.SessionID,
    taskId: binding.TaskID,
    taskEpoch: "1",
    computerId: "computer",
    computerGeneration: "3",
    revoked: false,
    policy: {
      workspaces: [
        {
          workspaceId: workspace.workspaceId,
          root: workspace.root,
          mode: "subtree",
          paths: null,
          access: "read",
          restrictionSource: "task-grant",
        },
      ],
      excludedPaths: [],
      capabilities: ["workspace.list", "workspace.read"],
      network: "none",
      commands: "none",
      expiresAt: 100000,
    },
  };
  const access = {
    schema: 1,
    profileId: binding.ProfileID,
    computerId: "computer",
    ownerId: binding.OwnerID,
    revision: "4",
    generation: "3",
    seenApproval: true,
    approval,
    participants: { [binding.ParticipantID]: participant },
  };
  pass(() => readAccessWitness(profile, access, settings, binding));
  for (const mutation of [
    { profileId: "crossed" },
    { generation: "4" },
    { revision: "0" },
    { approval: null },
    { participants: {} },
    { participants: { ...access.participants, extra: participant } },
  ])
    reject(() =>
      readAccessWitness(profile, { ...access, ...mutation }, settings, binding),
    );
  for (const mutation of [
    { taskId: "crossed" },
    { computerGeneration: "2" },
    { mutationOwnership: "task" },
    { revoked: true },
    { policy: { ...participant.policy, commands: "workspace" } },
    { policy: { ...participant.policy, network: "approved" } },
    {
      policy: {
        ...participant.policy,
        capabilities: ["workspace.read", "workspace.write"],
      },
    },
    { policy: { ...participant.policy, workspaces: [] } },
  ])
    reject(() =>
      readAccessWitness(
        profile,
        {
          ...access,
          participants: {
            [binding.ParticipantID]: { ...participant, ...mutation },
          },
        },
        settings,
        binding,
      ),
    );
  const legacy = {
    schema: 1,
    operationId: preview.operationId,
    kind: "readonly",
    phase: "prepared",
    createdAt: "2026-10-04T12:00:00.000Z",
    updatedAt: "2026-10-04T12:00:00.000Z",
    result: null,
  };
  pass(() => legacyPreviewWitness(legacy, preview.operationId, "prepared"));
  pass(() =>
    legacyPreviewWitness(
      { ...legacy, phase: "delivery_acknowledged" },
      preview.operationId,
      "delivery_acknowledged",
    ),
  );
  for (const mutation of [
    { operationId: "crossed" },
    { phase: "dispatch_intent" },
    { result: { state: "completed" } },
    { kind: "attachment" },
  ])
    reject(() =>
      legacyPreviewWitness(
        { ...legacy, ...mutation },
        preview.operationId,
        "prepared",
      ),
    );
  const original = {
    Stage: "CHILD_TERMINATED",
    Publication: { Binding: binding },
    Receipt: { Write: retirement },
    ACK: { Publication: binding },
    Terminal: { KnownACKDigest: [1], Kind: "NORMAL_EXIT" },
    Consumption: null,
  };
  const consumed = {
    ...original,
    Stage: "SUCCESSOR_CONSUMED",
    Consumption: { Next: { BackendGeneration: "next" } },
  };
  pass(() => consumedReadHandoffWitness(consumed, original));
  for (const mutation of [
    { ACK: null },
    { Terminal: { ...original.Terminal, KnownACKDigest: [2] } },
    { Receipt: { Write: { ...retirement, Turns: [] } } },
    { Publication: { Binding: { ...binding, TaskID: "crossed" } } },
    { Consumption: null },
  ])
    reject(() =>
      consumedReadHandoffWitness({ ...consumed, ...mutation }, original),
    );
}
