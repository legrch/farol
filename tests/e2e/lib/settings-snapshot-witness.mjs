import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const snapshotLimits = Object.freeze([
  "Content-free Settings preview: raw-byte count and SHA-256 checked against an independent bounded file read; no returned file body",
  "Executor origin is bound to normal packaged production source, not independently instrumented Go RPC counts",
  "Retained profile/root/generation, participant map and Chat journal observations do not count transient admissions",
  "Prepare and exact Cancel only; Apply, observe, ACK, shell, provider Send, real accounts and full Computer acceptance are excluded",
  "Existing UTF-8 canary unchanged; BOM, denial, revocation, conflicts and the 256 KiB boundary remain native NOT_RUN",
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
function decimal(value) {
  assert.equal(typeof value, "string");
  assert.match(value, /^(0|[1-9][0-9]*)$/u);
  const number = BigInt(value);
  assert.ok(number <= 18446744073709551615n);
  return number;
}

// Independent retained documents only. No production DTO, approval injection,
// participant creation, journal writes or direct backend invocation.
export function snapshotAuthorityWitness(observed, baseline, expectedAccess) {
  const { profile, access, chat, configuration, settings, physical } = observed;
  const identity = profile.value,
    current = access.value;
  assert.deepEqual(Object.keys(identity).sort(), [
    "computerId",
    "profileId",
    "schema",
  ]);
  assert.match(identity.schema, /^farol-native-profile\/[12]$/u);
  assert.equal(identity.computerId, settings.computer.computerId);
  assert.deepEqual(Object.keys(current).sort(), [
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
  assert.equal(current.schema, 1);
  assert.equal(current.profileId, identity.profileId);
  assert.equal(current.computerId, identity.computerId);
  assert.equal(current.ownerId, "owner-desktop");
  assert.ok(decimal(current.revision) > 0n);
  assert.equal(
    decimal(current.generation),
    BigInt(settings.computer.generation),
  );
  assert.equal(current.seenApproval, true);
  assert.deepEqual(current.participants, {}, "SNAPSHOT_CREATED_PARTICIPANT");
  assert.equal(settings.computer.workspaces.length, 1);
  assert.ok(["read", "write"].includes(expectedAccess));
  const workspace = settings.computer.workspaces[0];
  assert.equal(workspace.access, expectedAccess);
  assert.equal(workspace.root, physical.workspaceRoot.path);
  assert.deepEqual(workspace.rootIdentity, {
    device: physical.workspaceRoot.Device,
    inode: physical.workspaceRoot.Inode,
  });
  assert.deepEqual(workspace.excludedPaths, []);
  assert.notEqual(workspace.gitHistoryApproved, true);
  assert.equal(workspace.gitMetadata, undefined);
  assert.equal(settings.computer.commands, "none");
  assert.equal(
    settings.computer.pendingEdit,
    null,
    "SNAPSHOT_MUTATION_PERSISTED",
  );
  const approval = current.approval;
  assert.ok(
    approval &&
      Number.isSafeInteger(approval.expiresAt) &&
      approval.expiresAt > 0,
  );
  assert.deepEqual(approval, {
    ownerId: current.ownerId,
    computerId: identity.computerId,
    generation: current.generation,
    workspaces: [
      {
        workspaceId: workspace.workspaceId,
        root: workspace.root,
        access: expectedAccess,
        rootIdentity: workspace.rootIdentity,
        gitHistoryApproved: false,
        shellVerified: false,
      },
    ],
    excludedPaths: [],
    capabilities: [
      "workspace.list",
      "workspace.read",
      "workspace.search",
      ...(expectedAccess === "write" ? ["workspace.write"] : []),
    ],
    network: "none",
    commands: "none",
    expiresAt: approval.expiresAt,
  });
  assert.equal(chat.value.scope.ProfileID, identity.profileId);
  assert.ok(
    typeof chat.value.scope.BackendGeneration === "string" &&
      chat.value.scope.BackendGeneration.length > 0,
  );
  assert.deepEqual(chat.value.writes, [], "SNAPSHOT_CREATED_CHAT_TURN");
  assert.equal(chat.value.retirement, null);
  assert.deepEqual(
    configuration.value,
    settings,
    "SNAPSHOT_SETTINGS_NOT_RETAINED",
  );
  if (baseline) {
    assert.deepEqual(profile, baseline.profile, "SNAPSHOT_PROFILE_CHANGED");
    assert.deepEqual(physical, baseline.physical, "SNAPSHOT_ROOT_CHANGED");
    assert.deepEqual(chat, baseline.chat, "SNAPSHOT_CHAT_CHANGED");
    assert.deepEqual(
      settings.setup.chatgpt,
      baseline.settings.setup.chatgpt,
      "SNAPSHOT_CHAT_SETTINGS_CHANGED",
    );
    assert.equal(
      workspace.workspaceId,
      baseline.settings.computer.workspaces[0].workspaceId,
    );
    const changedGrant =
      workspace.access !== baseline.settings.computer.workspaces[0].access;
    assert.equal(
      decimal(current.generation),
      decimal(baseline.access.value.generation) + (changedGrant ? 1n : 0n),
    );
    assert.ok(
      decimal(current.revision) >= decimal(baseline.access.value.revision),
    );
  }
  return {
    profileId: identity.profileId,
    computerId: identity.computerId,
    generation: current.generation,
    backendGeneration: chat.value.scope.BackendGeneration,
    root: workspace.root,
    rootIdentity: workspace.rootIdentity,
    participantCount: 0,
    retainedChatWriteCount: 0,
  };
}

export function snapshotUnchangedWitness(
  before,
  after,
  originalBytes,
  currentBytes,
) {
  assert.ok(Buffer.isBuffer(originalBytes) && Buffer.isBuffer(currentBytes));
  assert.ok(originalBytes.length <= 256 * 1024);
  assert.deepEqual(currentBytes, originalBytes, "SNAPSHOT_FILE_CHANGED");
  snapshotAuthorityWitness(after, before, "write");
  assert.deepEqual(
    after.settings,
    before.settings,
    "SNAPSHOT_CONFIGURATION_CHANGED",
  );
  assert.deepEqual(
    after.configuration,
    before.configuration,
    "SNAPSHOT_CONFIG_BYTES_CHANGED",
  );
}

export function settingsSnapshotWitness(
  preview,
  before,
  after,
  originalBytes,
  currentBytes,
  relativePath,
) {
  snapshotAuthorityWitness(before, undefined, "write");
  snapshotUnchangedWitness(before, after, originalBytes, currentBytes);
  assert.deepEqual(Object.keys(preview).sort(), [
    "beforeSha256",
    "bytes",
    "expiresAt",
    "kind",
    "operationId",
    "relativePath",
    "workspaceId",
  ]);
  assert.equal(preview.kind, "computer.workspace-edit-preview");
  assert.match(preview.operationId, uuid);
  assert.equal(
    preview.workspaceId,
    before.settings.computer.workspaces[0].workspaceId,
  );
  assert.equal(preview.relativePath, relativePath);
  assert.ok(
    Number.isSafeInteger(preview.bytes) &&
      preview.bytes >= 0 &&
      preview.bytes <= 256 * 1024,
  );
  assert.equal(
    preview.bytes,
    originalBytes.length,
    "SNAPSHOT_BYTE_COUNT_MISMATCH",
  );
  assert.match(preview.beforeSha256, /^[a-f0-9]{64}$/u);
  assert.equal(
    preview.beforeSha256,
    sha256(originalBytes),
    "SNAPSHOT_HASH_MISMATCH",
  );
  assert.equal(new Date(preview.expiresAt).toISOString(), preview.expiresAt);
  const verification = before.settings.setup.computer.verified;
  assert.equal(verification?.workspaceId, preview.workspaceId);
  assert.equal(
    verification?.configRevision,
    before.settings.computer.generation,
  );
  assert.equal(verification?.protocol, "mutable-workspace/1");
  return { bytes: originalBytes.length, rawSHA256: sha256(originalBytes) };
}

export function snapshotCancelWitness(command, reply, preview, settings) {
  assert.deepEqual(command, {
    kind: "computer.cancel-workspace-edit",
    operationId: preview.operationId,
  });
  assert.deepEqual(Object.keys(reply).sort(), ["ok", "snapshot"]);
  assert.equal(reply.ok, true, "SNAPSHOT_CANCEL_FAILED");
  assert.equal(reply.snapshot.status, "ready");
  assert.deepEqual(reply.snapshot.settings, settings);
}

export function snapshotWitnessSelfTest(pass, reject) {
  // Synthetic BOM/non-ASCII bytes test raw hashing without changing the native
  // canary, compiling a package or invoking any host/provider boundary.
  const bytes = Buffer.from("\ufeffcafé / 日本語 / 🧭\n", "utf8");
  const workspace = {
    workspaceId: "folder",
    root: "/fixture/workspace",
    access: "write",
    rootIdentity: { device: "1", inode: "2" },
    excludedPaths: [],
  };
  const settings = {
    computer: {
      computerId: "computer",
      generation: 3,
      commands: "none",
      pendingEdit: null,
      workspaces: [workspace],
    },
    setup: {
      computer: {
        verified: {
          workspaceId: "folder",
          configRevision: 3,
          protocol: "mutable-workspace/1",
        },
      },
      chatgpt: { verified: null },
    },
  };
  const observed = {
    profile: {
      value: {
        schema: "farol-native-profile/2",
        profileId: "profile",
        computerId: "computer",
      },
      sha256: "profile-bytes",
    },
    access: {
      value: {
        schema: 1,
        profileId: "profile",
        ownerId: "owner-desktop",
        computerId: "computer",
        revision: "9007199254740993",
        generation: "3",
        seenApproval: true,
        participants: {},
        approval: {
          ownerId: "owner-desktop",
          computerId: "computer",
          generation: "3",
          workspaces: [
            {
              workspaceId: "folder",
              root: workspace.root,
              access: "write",
              rootIdentity: workspace.rootIdentity,
              gitHistoryApproved: false,
              shellVerified: false,
            },
          ],
          excludedPaths: [],
          capabilities: [
            "workspace.list",
            "workspace.read",
            "workspace.search",
            "workspace.write",
          ],
          network: "none",
          commands: "none",
          expiresAt: 1000,
        },
      },
    },
    chat: {
      value: {
        scope: { ProfileID: "profile", BackendGeneration: "backend" },
        writes: [],
        retirement: null,
      },
      sha256: "chat-bytes",
    },
    configuration: { value: settings, sha256: "config-bytes" },
    settings,
    physical: {
      workspaceRoot: { path: workspace.root, Device: "1", Inode: "2" },
    },
  };
  const preview = {
    kind: "computer.workspace-edit-preview",
    operationId: "12345678-1234-4234-8234-123456789abc",
    workspaceId: "folder",
    relativePath: "canary.txt",
    bytes: bytes.length,
    beforeSha256: sha256(bytes),
    expiresAt: "2026-10-04T12:00:00.000Z",
  };
  const check = (
    value = preview,
    after = observed,
    raw = bytes,
    current = bytes,
  ) =>
    settingsSnapshotWitness(value, observed, after, raw, current, "canary.txt");
  pass(() => check());
  for (const change of [
    { kind: "crossed" },
    { operationId: "invalid" },
    { workspaceId: "crossed" },
    { relativePath: "crossed.txt" },
    { bytes: bytes.toString("utf8").length },
    { bytes: -1 },
    { bytes: 262145 },
    { bytes: 1.5 },
    { bytes: "1" },
    { beforeSha256: "a".repeat(64) },
    { beforeSha256: sha256(bytes.subarray(3)) },
    { beforeSha256: "invalid" },
    { expiresAt: "invalid" },
    { expiresAt: "2026-10-04" },
    { root: {} },
    { profileId: "fabricated" },
    { generation: "3" },
  ])
    reject(() => check({ ...preview, ...change }));
  reject(() => check(null));
  reject(() => check(preview, observed, bytes, Buffer.from("changed")));
  reject(() => check(preview, observed, bytes.toString("utf8")));
  reject(() => check(preview, observed, Buffer.alloc(262145)));
  const wrongVerification = structuredClone(observed);
  wrongVerification.settings.setup.computer.verified.protocol =
    "readonly-workspace/1";
  reject(() =>
    settingsSnapshotWitness(
      preview,
      wrongVerification,
      wrongVerification,
      bytes,
      bytes,
      "canary.txt",
    ),
  );
  for (const mutate of [
    (v) => {
      v.profile.value.profileId = "crossed";
    },
    (v) => {
      v.profile.sha256 = "changed";
    },
    (v) => {
      v.access.value.profileId = "crossed";
    },
    (v) => {
      v.access.value.computerId = "crossed";
    },
    (v) => {
      v.access.value.generation = "4";
    },
    (v) => {
      v.access.value.generation = 3;
    },
    (v) => {
      v.access.value.revision = "01";
    },
    (v) => {
      v.access.value.revision = "18446744073709551616";
    },
    (v) => {
      v.access.value.revision = "1";
    },
    (v) => {
      v.access.value.approval = null;
    },
    (v) => {
      v.access.value.approval.workspaces[0].rootIdentity.inode = "3";
    },
    (v) => {
      v.access.value.approval.workspaces[0].root = "/crossed";
    },
    (v) => {
      v.access.value.approval.capabilities.push("workspace.shell");
    },
    (v) => {
      v.access.value.participants.fake = {};
    },
    (v) => {
      v.chat.value.scope.BackendGeneration = "crossed";
    },
    (v) => {
      v.chat.value.scope.ProfileID = "crossed";
    },
    (v) => {
      v.chat.value.writes.push({ Entry: { Kind: "admit" } });
    },
    (v) => {
      v.chat.sha256 = "changed";
    },
    (v) => {
      v.physical.workspaceRoot.Inode = "3";
    },
    (v) => {
      v.settings.computer.generation++;
    },
    (v) => {
      v.settings.computer.pendingEdit = {};
    },
    (v) => {
      v.settings.setup.computer.verified.configRevision++;
    },
    (v) => {
      v.settings.setup.chatgpt.verified = {};
    },
    (v) => {
      v.configuration.sha256 = "changed";
    },
  ]) {
    const changed = structuredClone(observed);
    mutate(changed);
    reject(() => check(preview, changed));
  }
  const renewed = structuredClone(observed);
  renewed.access.value.revision = "9007199254740994";
  renewed.access.value.approval.expiresAt++;
  pass(() => check(preview, renewed));
  const restored = structuredClone(observed);
  restored.settings.computer.generation++;
  restored.settings.computer.workspaces[0].access = "read";
  restored.settings.setup.computer.verified.configRevision++;
  restored.settings.setup.computer.verified.protocol = "readonly-workspace/1";
  restored.access.value.generation = "4";
  restored.access.value.revision = "9007199254740994";
  restored.access.value.approval.generation = "4";
  restored.access.value.approval.workspaces[0].access = "read";
  restored.access.value.approval.capabilities.pop();
  pass(() => snapshotAuthorityWitness(restored, observed, "read"));
  const writeGranted = structuredClone(restored);
  writeGranted.settings.computer.generation++;
  writeGranted.settings.computer.workspaces[0].access = "write";
  writeGranted.access.value.generation = "5";
  writeGranted.access.value.approval.generation = "5";
  writeGranted.access.value.approval.workspaces[0].access = "write";
  writeGranted.access.value.approval.capabilities.push("workspace.write");
  pass(() => snapshotAuthorityWitness(writeGranted, restored, "write"));
  reject(() => snapshotAuthorityWitness(restored, observed, "write"));
  for (const mutate of [
    (v) => {
      v.access.value.approval.capabilities.push("workspace.write");
    },
    (v) => {
      v.settings.computer.generation++;
      v.access.value.generation = "5";
      v.access.value.approval.generation = "5";
    },
    (v) => {
      v.settings.setup.chatgpt.verified = {};
    },
  ]) {
    const changed = structuredClone(restored);
    mutate(changed);
    reject(() => snapshotAuthorityWitness(changed, observed, "read"));
  }
  const command = {
    kind: "computer.cancel-workspace-edit",
    operationId: preview.operationId,
  };
  const reply = { ok: true, snapshot: { status: "ready", settings } };
  pass(() => snapshotCancelWitness(command, reply, preview, settings));
  reject(() =>
    snapshotCancelWitness(
      { ...command, operationId: "crossed" },
      reply,
      preview,
      settings,
    ),
  );
  reject(() =>
    snapshotCancelWitness(command, { ...reply, ok: false }, preview, settings),
  );
  reject(() =>
    snapshotCancelWitness(
      command,
      { ...reply, evidence: preview },
      preview,
      settings,
    ),
  );
  reject(() =>
    snapshotCancelWitness(
      command,
      { ok: true, snapshot: { status: "unavailable" } },
      preview,
      settings,
    ),
  );
}
