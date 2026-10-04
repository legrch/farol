import assert from "node:assert/strict";

// Observations of retained production roots only. These values are never used
// to issue approval, manufacture an admission or invoke a backend directly.
export const settingsExcludedCanaries = Object.freeze({
  directory: ".ssh",
  child: "omitted-settings-canary.txt",
  file: ".env",
  text: "Synthetic Settings exclusion canary; no credentials.\n",
});

function decimal(value) {
  assert.match(value, /^(0|[1-9][0-9]*)$/u, "SETTINGS_COUNTER_UNKNOWN");
  const parsed = BigInt(value);
  assert.ok(parsed <= 18446744073709551615n, "SETTINGS_COUNTER_OVERFLOW");
  return parsed;
}

function approvalSemantics(approval) {
  const { expiresAt, ...semantics } = approval;
  assert.ok(
    Number.isSafeInteger(expiresAt) && expiresAt > 0,
    "SETTINGS_APPROVAL_EXPIRY_UNKNOWN",
  );
  return semantics;
}

export function settingsAuthorityWitness(observed, baseline) {
  const { profile, access, chat, settings, physical } = observed;
  const identity = profile.value;
  const current = access.value;
  assert.deepEqual(Object.keys(identity).sort(), [
    "computerId",
    "profileId",
    "schema",
  ]);
  assert.match(identity.schema, /^farol-native-profile\/[12]$/u);
  assert.equal(identity.computerId, settings.computer.computerId);
  assert.equal(current.schema, 1);
  assert.deepEqual(
    Object.keys(current).sort(),
    [
      "schema",
      "profileId",
      "ownerId",
      "computerId",
      "revision",
      "generation",
      "seenApproval",
      "approval",
      "participants",
    ].sort(),
    "SETTINGS_ACCESS_SCHEMA_CHANGED",
  );
  assert.equal(current.profileId, identity.profileId);
  assert.equal(current.ownerId, "owner-desktop");
  assert.equal(current.computerId, identity.computerId);
  assert.ok(decimal(current.revision) > 0n);
  decimal(current.generation);
  assert.equal(current.generation, String(settings.computer.generation));
  assert.equal(current.seenApproval, true);
  assert.deepEqual(current.participants, {}, "SETTINGS_CREATED_PARTICIPANT");
  assert.equal(settings.computer.workspaces.length, 1);
  const workspace = settings.computer.workspaces[0];
  assert.equal(workspace.root, physical.workspaceRoot.path);
  assert.deepEqual(workspace.rootIdentity, {
    device: physical.workspaceRoot.Device,
    inode: physical.workspaceRoot.Inode,
  });
  assert.equal(workspace.access, "read");
  assert.deepEqual(workspace.excludedPaths, []);
  assert.notEqual(workspace.gitHistoryApproved, true);
  assert.equal(workspace.gitMetadata, undefined);
  assert.equal(settings.computer.commands, "none");
  assert.ok(current.approval, "SETTINGS_APPROVAL_MISSING");
  const semantics = approvalSemantics(current.approval);
  assert.deepEqual(
    semantics,
    {
      ownerId: current.ownerId,
      computerId: identity.computerId,
      generation: current.generation,
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
    },
    "SETTINGS_APPROVAL_SEMANTICS_CHANGED",
  );
  assert.equal(chat.value.scope.ProfileID, identity.profileId);
  assert.deepEqual(chat.value.writes, [], "SETTINGS_CREATED_CHAT_TURN");
  assert.equal(chat.value.retirement, null);
  if (baseline) {
    assert.deepEqual(profile, baseline.profile, "SETTINGS_PROFILE_CHANGED");
    assert.deepEqual(
      physical,
      baseline.physical,
      "SETTINGS_PHYSICAL_ROOT_CHANGED",
    );
    assert.deepEqual(chat, baseline.chat, "SETTINGS_CHAT_JOURNAL_CHANGED");
    assert.equal(current.generation, baseline.access.value.generation);
    assert.deepEqual(
      semantics,
      approvalSemantics(baseline.access.value.approval),
    );
    assert.ok(
      decimal(current.revision) >= decimal(baseline.access.value.revision),
      "SETTINGS_APPROVAL_REVISION_REGRESSED",
    );
    // Evidence generation may republish the same approval with a fresh expiry;
    // neither that timestamp nor store revision is an admission counter.
    const {
      revision: _revision,
      approval: _approval,
      ...protectedAccess
    } = current;
    const {
      revision: _previousRevision,
      approval: _previousApproval,
      ...previousAccess
    } = baseline.access.value;
    assert.deepEqual(
      protectedAccess,
      previousAccess,
      "SETTINGS_ACCESS_IDENTITIES_CHANGED",
    );
  }
  return {
    approvalRevision: current.revision,
    approvalGeneration: current.generation,
    approvalExpiresAt: current.approval.expiresAt,
    participantCount: Object.keys(current.participants).length,
    chatWriteCount: chat.value.writes.length,
    retainedChatAdmissionWriteCount: chat.value.writes.filter(
      (write) => write.Entry?.Kind === "admit",
    ).length,
    protectedIdentities: {
      profileId: identity.profileId,
      ownerId: current.ownerId,
      computerId: identity.computerId,
      backendGeneration: chat.value.scope.BackendGeneration,
      workspaceId: workspace.workspaceId,
      workspaceRootIdentity: workspace.rootIdentity,
    },
    approvalSemantics: semantics,
  };
}

export function settingsListWitness(
  evidence,
  workspaceId,
  relativePath,
  canary,
) {
  assert.deepEqual(Object.keys(evidence).sort(), [
    "entries",
    "kind",
    "relativePath",
    "truncated",
    "workspaceId",
  ]);
  assert.equal(evidence.kind, "computer.workspace-list");
  assert.equal(evidence.workspaceId, workspaceId);
  assert.equal(evidence.relativePath, relativePath);
  assert.equal(evidence.truncated, false, "SETTINGS_LIST_TRUNCATED");
  for (const name of [
    settingsExcludedCanaries.directory,
    settingsExcludedCanaries.file,
  ])
    assert.ok(
      !evidence.entries.includes(name) &&
        !evidence.entries.includes(`${name}/`),
      "SETTINGS_EXCLUDED_NAME_DISCLOSED",
    );
  assert.deepEqual(evidence.entries, [canary], "SETTINGS_LIST_CANARY_CHANGED");
  return {
    entries: [...evidence.entries],
    canaryIncluded: canary,
    excludedNamesOmitted: [
      settingsExcludedCanaries.directory,
      settingsExcludedCanaries.file,
    ],
    exclusionPolicy:
      "Built-in denied paths; no custom owner exclusion mutation",
  };
}

export function settingsWitnessSelfTest(pass, reject, canary) {
  // Pure synthetic documents only: no filesystem, app, process or provider.
  const workspaceRoot = {
    path: "/fixture/read-workspace",
    Device: "1",
    Inode: "2",
    OwnerUID: "501",
  };
  const rootIdentity = { device: "1", inode: "2" };
  const settings = {
    computer: {
      computerId: "fixture-computer",
      generation: 3,
      commands: "none",
      workspaces: [
        {
          workspaceId: "fixture-workspace",
          root: workspaceRoot.path,
          rootIdentity,
          access: "read",
          excludedPaths: [],
        },
      ],
    },
  };
  const profile = {
    value: {
      schema: "farol-native-profile/2",
      profileId: "fixture-profile",
      computerId: "fixture-computer",
    },
    sha256: "profile-bytes",
  };
  const access = {
    value: {
      schema: 1,
      profileId: "fixture-profile",
      ownerId: "owner-desktop",
      computerId: "fixture-computer",
      revision: "9007199254740993",
      generation: "3",
      seenApproval: true,
      participants: {},
      approval: {
        ownerId: "owner-desktop",
        computerId: "fixture-computer",
        generation: "3",
        workspaces: [
          {
            workspaceId: "fixture-workspace",
            root: workspaceRoot.path,
            access: "read",
            rootIdentity,
            gitHistoryApproved: false,
            shellVerified: false,
          },
        ],
        excludedPaths: [],
        capabilities: ["workspace.list", "workspace.read", "workspace.search"],
        network: "none",
        commands: "none",
        expiresAt: 1000,
      },
    },
    sha256: "access-bytes",
  };
  const chat = {
    value: {
      scope: {
        ProfileID: "fixture-profile",
        BackendGeneration: "fixture-backend",
      },
      writes: [],
      retirement: null,
    },
    sha256: "chat-bytes",
  };
  const observed = {
    profile,
    access,
    chat,
    settings,
    physical: { workspaceRoot },
  };
  pass(() => settingsAuthorityWitness(observed));
  pass(() => settingsAuthorityWitness(observed, observed));
  const advanced = structuredClone(observed);
  advanced.access.value.revision = "9007199254740994";
  advanced.access.value.approval.expiresAt++;
  advanced.access.sha256 = "republished-access-bytes";
  pass(() => settingsAuthorityWitness(advanced, observed));
  for (const mutate of [
    (v) => {
      v.access.value.participants.fake = { revoked: true };
    },
    (v) => {
      v.chat.value.writes.push({ Entry: { Kind: "admit" } });
    },
    (v) => {
      v.chat.sha256 = "changed-chat-bytes";
    },
    (v) => {
      v.profile.sha256 = "changed-profile-bytes";
    },
    (v) => {
      v.physical.workspaceRoot.Inode = "3";
    },
    (v) => {
      v.access.value.revision = "9007199254740992";
    },
    (v) => {
      v.access.value.revision = "01";
    },
    (v) => {
      v.access.value.revision = "18446744073709551616";
    },
    (v) => {
      v.access.value.generation = "4";
    },
    (v) => {
      v.access.value.profileId = "other";
    },
    (v) => {
      v.access.value.approval = null;
    },
    (v) => {
      v.access.value.approval.network = "allowed";
    },
    (v) => {
      v.access.value.approval.workspaces[0].rootIdentity.inode = "3";
    },
    (v) => {
      v.access.value.approval.workspaces[0].access = "write";
    },
    (v) => {
      v.access.value.approval.capabilities.push("verification.run");
    },
    (v) => {
      v.access.value.approval.expiresAt = 0;
    },
  ]) {
    const changed = structuredClone(observed);
    mutate(changed);
    reject(() => settingsAuthorityWitness(changed, observed));
  }
  const evidence = {
    kind: "computer.workspace-list",
    workspaceId: "fixture-workspace",
    relativePath: ".",
    entries: [canary],
    truncated: false,
  };
  const checkList = (value) =>
    settingsListWitness(value, "fixture-workspace", ".", canary);
  pass(() => checkList(evidence));
  for (const change of [
    { entries: [] },
    { entries: [canary, ".env"] },
    { entries: [canary, ".ssh/"] },
    { truncated: true },
    { workspaceId: "other" },
    { relativePath: "other" },
    { entries: [canary, canary] },
    { unexpected: true },
  ])
    reject(() => checkList({ ...evidence, ...change }));
}
