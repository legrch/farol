import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { snapshotAuthorityWitness } from "./settings-snapshot-witness.mjs";
import { readCanary } from "../fixtures/go-read-discard-witness.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export const mutationText = Object.freeze({
  oldText: "Farol disposable read canary",
  newText: "Farol disposable edited canary",
});
export const mutationLimits = Object.freeze([
  "Actual React Prepare/Old text/New text/Apply once; normal preload configuration supplies workspace write/Verify and exact retained Observe/ACK",
  "Go Apply/Observe origin is bound to exact packaged production inputs, not an independent Go RPC or transient admission counter",
  "ACK and pending delivery policy remain temporary TypeScript; this is not Go ACK acceptance",
  "Independent raw file bytes and strict content-free owner-v2 journal show one retained effect; no claim about every transient filesystem operation",
  "Source/browser-free self-tests are synthetic expectations only; app, native, package, provider, install and full migration acceptance require Lead's separate execution",
]);

function keys(value, expected) {
  assert.ok(value && typeof value === "object");
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}
export function mutationProfileWitness(profile) {
  keys(profile, ["schema", "profileId", "computerId"]);
  assert.equal(
    profile.schema,
    "farol-native-profile/2",
    "MUTATION_REQUIRES_SCHEMA_2_NO_MIGRATION",
  );
  assert.match(profile.profileId, /^[a-f0-9-]{36}$/u);
  assert.ok(
    typeof profile.computerId === "string" && profile.computerId.length > 0,
  );
}
export function mutationAuthorityWitness(observed, previous) {
  mutationProfileWitness(observed.profile.value);
  // Validate the existing authority witness without treating a TS delivery
  // record as an authority. The original independent config is checked below.
  const authority = structuredClone(observed);
  authority.settings.computer.pendingEdit = null;
  authority.configuration.value.computer.pendingEdit = null;
  const baseline = previous ? structuredClone(previous) : undefined;
  if (baseline) {
    baseline.settings.computer.pendingEdit = null;
    baseline.configuration.value.computer.pendingEdit = null;
  }
  const result = snapshotAuthorityWitness(authority, baseline, "write");
  assert.deepEqual(observed.configuration.value, observed.settings);
  assert.equal(
    observed.settings.setup.computer.verified?.protocol,
    "mutable-workspace/1",
  );
  assert.equal(
    observed.settings.setup.computer.verified?.configRevision,
    observed.settings.computer.generation,
  );
  if (previous) {
    const current = structuredClone(observed.settings);
    const before = structuredClone(previous.settings);
    for (const value of [current, before]) {
      delete value.revision;
      value.computer.pendingEdit = null;
    }
    assert.deepEqual(current, before, "MUTATION_CHANGED_UNRELATED_SETTINGS");
  }
  return result;
}
export function mutationKey(identity) {
  return (
    hash(
      JSON.stringify([
        "owner-settings-v2",
        identity.operationId,
        identity.ownerId,
        identity.profileId,
        identity.computerId,
      ]),
    ) + ".json"
  );
}
function expectedReceipt(original, changed, relativePath) {
  assert.ok(Buffer.isBuffer(original) && Buffer.isBuffer(changed));
  assert.ok(original.length <= 256 * 1024 && changed.length <= 256 * 1024);
  const text = original.toString("utf8");
  assert.deepEqual(Buffer.from(text), original, "MUTATION_NOT_UTF8");
  assert.equal(
    text.split(mutationText.oldText).length,
    2,
    "MUTATION_NOT_UNIQUE",
  );
  assert.deepEqual(
    changed,
    Buffer.from(text.replace(mutationText.oldText, mutationText.newText)),
    "MUTATION_FILE_BYTES_MISMATCH",
  );
  return {
    kind: "workspace.mutation",
    operation: "edit",
    relativePath,
    bytes: changed.length,
    replacements: 1,
    beforeSha256: hash(original),
    afterSha256: hash(changed),
  };
}
export function mutationEffectWitness(
  observed,
  pending,
  original,
  changed,
  relativePath,
  acknowledged = false,
) {
  mutationAuthorityWitness(observed);
  const profile = observed.profile.value;
  keys(pending, [
    "operationId",
    "workspaceId",
    "relativePath",
    "computerGeneration",
    "submittedAt",
    "backend",
    "profileId",
    "beforeSha256",
  ]);
  assert.match(pending.operationId, uuid);
  assert.equal(pending.backend, "go-owner-v2");
  assert.equal(pending.profileId, profile.profileId);
  assert.equal(
    pending.workspaceId,
    observed.settings.computer.workspaces[0].workspaceId,
  );
  assert.equal(
    pending.computerGeneration,
    observed.settings.computer.generation,
  );
  assert.equal(pending.relativePath, relativePath);
  assert.equal(pending.beforeSha256, hash(original));
  assert.equal(
    new Date(pending.submittedAt).toISOString(),
    pending.submittedAt,
  );
  assert.deepEqual(
    observed.settings.computer.pendingEdit,
    acknowledged ? null : pending,
    "MUTATION_PENDING_IDENTITY_CROSSED_OR_MISSING",
  );
  const identity = {
    scope: "owner-settings",
    operationId: pending.operationId,
    ownerId: "owner-desktop",
    profileId: profile.profileId,
    computerId: profile.computerId,
  };
  const key = mutationKey(identity);
  assert.deepEqual(
    observed.mutationNames,
    [key],
    "MUTATION_MISSING_OR_EXTRA_EFFECT_RECORD",
  );
  assert.deepEqual(observed.tsMutationNames, [], "MUTATION_ACTIVE_TS_RECORD");
  const receipt = expectedReceipt(original, changed, relativePath);
  const expected = {
    schemaVersion: 2,
    kind: "workspace_owner_mutation",
    record: {
      identity,
      computerGeneration: pending.computerGeneration,
      workspaceId: pending.workspaceId,
      relativePath,
      requestDigest: hash(
        JSON.stringify([
          pending.workspaceId,
          "workspace.edit",
          relativePath,
          hash(original),
          [[mutationText.oldText, mutationText.newText]],
        ]),
      ),
      phase: "completed",
      outcome: { receipt },
    },
  };
  assert.deepEqual(
    observed.mutation.value,
    expected,
    "MUTATION_JOURNAL_FALSE_METADATA",
  );
  assert.equal(
    observed.mutation.sha256,
    hash(JSON.stringify(expected) + "\n"),
    "MUTATION_JOURNAL_NONCANONICAL_BYTES",
  );
  return {
    key,
    identity,
    computerGeneration: pending.computerGeneration,
    workspaceId: pending.workspaceId,
    receipt,
    journalSHA256: observed.mutation.sha256,
  };
}
export function mutationReplyWitness(reply, pending, effect, settings) {
  keys(reply, ["ok", "snapshot", "evidence"]);
  assert.equal(reply.ok, true, "MUTATION_OBSERVE_NOT_CONFIRMED");
  assert.equal(reply.snapshot.status, "ready");
  assert.deepEqual(reply.snapshot.settings.computer.pendingEdit, pending);
  assert.deepEqual(
    reply.snapshot.settings,
    settings,
    "MUTATION_REPLY_CONFIG_CROSSED",
  );
  const { kind: _kind, ...receipt } = effect.receipt;
  assert.deepEqual(
    reply.evidence,
    {
      kind: "computer.workspace-mutation",
      operationId: pending.operationId,
      workspaceId: pending.workspaceId,
      ...receipt,
      resultRetention: "durable",
      redelivered: true,
    },
    "MUTATION_OBSERVE_CROSSED_OR_FALSE_RECEIPT",
  );
}
export function mutationDuplicateWitness(reply, settings) {
  keys(reply, ["ok", "snapshot", "error"]);
  assert.equal(reply.ok, false);
  assert.equal(reply.error, "WORKSPACE_MUTATION_PREVIEW_NOT_FOUND");
  assert.equal(reply.snapshot.status, "ready");
  assert.deepEqual(reply.snapshot.settings, settings);
}
export function mutationAckWitness(command, reply, pending, settings) {
  assert.deepEqual(command, {
    kind: "computer.ack-workspace-edit",
    operationId: pending.operationId,
  });
  keys(reply, ["ok", "snapshot"]);
  assert.equal(reply.ok, true, "MUTATION_ACK_UNCONFIRMED");
  assert.equal(reply.snapshot.status, "ready");
  const expected = structuredClone(settings);
  expected.revision++;
  expected.computer.pendingEdit = null;
  assert.deepEqual(
    reply.snapshot.settings,
    expected,
    "MUTATION_ACK_CHANGED_UNRELATED_SETTINGS",
  );
}

// All IO is independent reads of the existing guarded disposable roots.
// No production imports, fabricated task, backend invocation or journal writes.
export async function readMutationState(io) {
  const { stateRoot, workspaceRoot, regular, document, physicalDirectory } = io;
  const coreRoot = path.join(stateRoot, "go-core");
  const computerRoot = path.join(coreRoot, "computer");
  const physical = {};
  for (const [name, root] of Object.entries({
    coreRoot,
    computerRoot,
    chatRoot: path.join(coreRoot, "chat"),
    workspaceRoot,
  }))
    physical[name] = await physicalDirectory(root);
  const configuration = await document(
    path.join(stateRoot, "config.json"),
    256 * 1024,
  );
  const profile = await document(path.join(coreRoot, "profile.json"), 4096);
  mutationProfileWitness(profile.value);
  const mutationRoot = path.join(computerRoot, "mutations");
  const mutationPhysical = await physicalDirectory(mutationRoot);
  const mutationNames = (await fs.readdir(mutationRoot)).sort();
  assert.ok(mutationNames.length <= 1, "MUTATION_EXTRA_EFFECT_RECORD");
  for (const name of mutationNames) assert.match(name, /^[a-f0-9]{64}\.json$/u);
  const tsRoot = path.join(stateRoot, "workspace-mutations");
  const tsExists = await fs.lstat(tsRoot).then(
    () => true,
    (error) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    },
  );
  let tsMutationNames = [];
  if (tsExists) {
    await physicalDirectory(tsRoot);
    tsMutationNames = await fs.readdir(tsRoot);
  }
  assert.deepEqual(tsMutationNames, [], "MUTATION_ACTIVE_TS_RECORD");
  return {
    profile,
    configuration,
    settings: configuration.value,
    physical,
    mutationPhysical,
    mutationNames,
    tsMutationNames,
    access: await document(
      path.join(computerRoot, "computer-access.json"),
      1024 * 1024,
    ),
    chat: await document(
      path.join(coreRoot, "chat/chat-lifecycle.json"),
      1024 * 1024,
    ),
    mutation: mutationNames.length
      ? await document(path.join(mutationRoot, mutationNames[0]), 65536)
      : null,
    fileBytes: await regular(
      path.join(workspaceRoot, readCanary.relativePath),
      256 * 1024,
    ),
  };
}
export function mutationTerminalWitness(
  observed,
  retained,
  pending,
  cleanup,
  acknowledged,
) {
  for (const [key, expected] of Object.entries({
    launchResolved: true,
    closeRequested: true,
    exitObserved: true,
    exitCode: 0,
    signal: null,
    drained: true,
    runMarkerRemoved: true,
  }))
    assert.equal(cleanup[key], expected, `MUTATION_TERMINAL_UNKNOWN:${key}`);
  for (const key of [
    "profile",
    "physical",
    "mutationPhysical",
    "mutation",
    "mutationNames",
    "tsMutationNames",
    "file",
  ])
    assert.deepEqual(
      observed[key],
      retained[key],
      `MUTATION_TERMINAL_EXTRA_EFFECT:${key}`,
    );
  const expected = structuredClone(retained.settings);
  if (acknowledged) {
    expected.revision++;
    expected.computer.pendingEdit = null;
  }
  assert.deepEqual(
    observed.settings,
    expected,
    "MUTATION_TERMINAL_PENDING_CHANGED",
  );
  assert.deepEqual(observed.configuration.value, expected);
  assert.deepEqual(
    observed.settings.computer.pendingEdit,
    acknowledged ? null : pending,
  );
}
export async function terminalMutationWitness(io) {
  const observed = contentFree(await readMutationState(io));
  mutationTerminalWitness(
    observed,
    io.report.retained,
    io.report.pending,
    io.cleanup,
    io.acknowledged,
  );
  return {
    ...observed,
    acknowledged: io.acknowledged,
    cleanup: { ...io.cleanup },
  };
}

function contentFree(observed) {
  const { fileBytes, ...safe } = observed;
  return {
    ...safe,
    file: { bytes: fileBytes.length, sha256: hash(fileBytes) },
  };
}
async function page(window, name) {
  await window
    .getByRole("button", { name: "Settings", exact: true })
    .click({ timeout: 5000 });
  await window
    .locator(".contextual-sidebar")
    .getByRole("button", { name, exact: true })
    .click({ timeout: 5000 });
  await window
    .getByRole("heading", { name, exact: true, level: 2 })
    .waitFor({ timeout: 5000 });
}
async function current(window, observed) {
  const bootstrap = await window.evaluate(() => window.farolNext.bootstrap());
  assert.equal(bootstrap.configuration.status, "ready");
  assert.deepEqual(
    bootstrap.configuration.settings,
    observed.settings,
    "MUTATION_BOOTSTRAP_CONFIG_CROSSED",
  );
}
export async function applyMutationJourney(io) {
  const {
    window,
    workspaceId,
    configure,
    hidden,
    active,
    ledger,
    save,
    report,
    buildId,
  } = io;
  report.limits = mutationLimits;
  report.controlPath =
    "Actual React Prepare edit… / Old text / New text / Apply edit; normal preload Observe/ACK; no synthetic task";
  report.observations = [];
  report.commands = [];
  const command = async (value) => {
    const reply = await configure(value);
    report.commands.push({ command: value, reply });
    await save();
    assert.equal(reply.ok, true, "MUTATION_SETUP_NOT_CONFIRMED");
    return reply;
  };
  await command({
    kind: "computer.update-access",
    workspaceId,
    access: "write",
  });
  await command({ kind: "computer.verify-workspace", workspaceId });
  const before = await readMutationState(io);
  report.observations.push(contentFree(before));
  await save();
  mutationAuthorityWitness(before);
  assert.deepEqual(
    before.profile,
    io.goProfile,
    "MUTATION_INITIAL_PROFILE_CROSSED",
  );
  assert.deepEqual(
    before.physical.coreRoot,
    io.launchPhysical.coreRoot,
    "MUTATION_INITIAL_CORE_ROOT_CROSSED",
  );
  assert.deepEqual(
    before.physical.chatRoot,
    io.launchPhysical.chatRoot,
    "MUTATION_INITIAL_CHAT_ROOT_CROSSED",
  );
  assert.deepEqual(
    before.physical.workspaceRoot,
    io.workspacePhysical,
    "MUTATION_INITIAL_WORKSPACE_ROOT_CROSSED",
  );
  assert.equal(before.settings.setup.computer.verified.buildId, buildId);
  assert.equal(before.settings.computer.pendingEdit, null);
  assert.deepEqual(before.mutationNames, [], "MUTATION_JOURNAL_NOT_FRESH");
  assert.deepEqual(before.fileBytes, Buffer.from(readCanary.text));
  report.originalFile = {
    bytes: before.fileBytes.length,
    sha256: hash(before.fileBytes),
  };
  await page(window, "Diagnostics");
  await window
    .getByRole("button", { name: "Refresh status", exact: true })
    .click({ timeout: 5000 });
  await page(window, "Folders");
  const section = window.locator('section[aria-label^="Guarded edit for "]');
  assert.equal(await section.count(), 1, "MUTATION_REACT_ROOT_AMBIGUOUS");
  await hidden();
  active();
  ledger();
  await section
    .getByRole("button", { name: "Prepare edit…", exact: true })
    .click({ timeout: 5000 });
  await section
    .getByText(
      `Selected file: ${readCanary.relativePath} · ${before.fileBytes.length} bytes.`,
      { exact: true },
    )
    .waitFor({ timeout: 20000 });
  const details = await section.locator("details p").textContent();
  const match = /^SHA-256: ([a-f0-9]{64})\. Expires: (.+)\.$/u.exec(details);
  assert.ok(match, "MUTATION_REACT_PREVIEW_MISSING");
  assert.equal(
    match[1],
    hash(before.fileBytes),
    "MUTATION_REACT_PREVIEW_HASH_CROSSED",
  );
  assert.equal(new Date(match[2]).toISOString(), match[2]);
  assert.ok(Date.parse(match[2]) > Date.now());
  const prepared = await readMutationState(io);
  mutationAuthorityWitness(prepared, before);
  assert.deepEqual(
    prepared.mutationPhysical,
    before.mutationPhysical,
    "MUTATION_PREPARE_JOURNAL_ROOT_CHANGED",
  );
  assert.deepEqual(prepared.fileBytes, before.fileBytes);
  assert.deepEqual(prepared.mutationNames, []);
  assert.equal(prepared.settings.computer.pendingEdit, null);
  report.reactPreview = {
    relativePath: readCanary.relativePath,
    bytes: before.fileBytes.length,
    beforeSha256: match[1],
    expiresAt: match[2],
  };
  report.observations.push(contentFree(prepared));
  await save();
  await section
    .getByLabel("Old text", { exact: true })
    .fill(mutationText.oldText);
  await section
    .getByLabel("New text", { exact: true })
    .fill(mutationText.newText);
  await hidden();
  active();
  ledger();
  // Exactly one click. Any failure/unknown below ends the journey; no replay.
  report.applyAttempted = true;
  await save();
  await section
    .getByRole("button", { name: "Apply edit", exact: true })
    .click({ timeout: 5000 });
  await window.locator(".delivery-notice").waitFor({ timeout: 20000 });
  const applied = await readMutationState(io);
  report.observations.push(contentFree(applied));
  await save();
  await current(window, applied);
  mutationAuthorityWitness(applied, before);
  assert.deepEqual(
    applied.mutationPhysical,
    before.mutationPhysical,
    "MUTATION_APPLY_JOURNAL_ROOT_CHANGED",
  );
  report.reactApply = {
    deliveryText: await window.locator(".delivery-notice").textContent(),
    applyClicks: 1,
  };
  report.pending = applied.settings.computer.pendingEdit;
  report.effect = mutationEffectWitness(
    applied,
    report.pending,
    before.fileBytes,
    applied.fileBytes,
    readCanary.relativePath,
  );
  report.retained = contentFree(applied);
  const observed = await configure({
    kind: "computer.observe-workspace-edit",
    operationId: report.pending.operationId,
  });
  mutationReplyWitness(
    observed,
    report.pending,
    report.effect,
    applied.settings,
  );
  report.commands.push({
    command: {
      kind: "computer.observe-workspace-edit",
      operationId: report.pending.operationId,
    },
    reply: observed,
  });
  await save();
  const duplicate = {
    kind: "computer.apply-workspace-edit",
    operationId: report.pending.operationId,
    ...mutationText,
  };
  // Known same-operation duplicate only after file, journal and normal receipt
  // independently confirm success. This is never a resend of unknown work.
  const refused = await configure(duplicate);
  mutationDuplicateWitness(refused, applied.settings);
  report.commands.push({ command: duplicate, reply: refused });
  const after = await readMutationState(io);
  mutationAuthorityWitness(after, applied);
  assert.deepEqual(
    contentFree(after),
    contentFree(applied),
    "MUTATION_DUPLICATE_EXTRA_EFFECT",
  );
  report.observations.push(contentFree(after));
  report.firstResultUnacknowledged = true;
  ledger();
  await hidden();
  await save();
  return applied.settings;
}
export async function reopenMutationJourney(io) {
  const { window, configure, report, ledger, hidden, active, save } = io;
  const before = await readMutationState(io);
  const original = Buffer.from(readCanary.text);
  assert.deepEqual(
    { bytes: original.length, sha256: hash(original) },
    report.originalFile,
  );
  mutationEffectWitness(
    before,
    report.pending,
    original,
    before.fileBytes,
    readCanary.relativePath,
  );
  for (const key of [
    "profile",
    "physical",
    "mutationPhysical",
    "mutation",
    "mutationNames",
    "tsMutationNames",
    "configuration",
  ])
    assert.deepEqual(
      before[key],
      report.retained[key],
      `MUTATION_REOPEN_CHANGED:${key}`,
    );
  await current(window, before);
  report.observations.push(contentFree(before));
  await save();
  await page(window, "Diagnostics");
  await hidden();
  active();
  ledger();
  // Actual UI Observe is followed by a content-free normal read of the exact
  // result. Neither command executes an edit or acknowledges its delivery.
  await window
    .getByRole("button", { name: "Observe existing edit", exact: true })
    .click({ timeout: 5000 });
  await window.locator(".delivery-notice").waitFor({ timeout: 20000 });
  const command = {
    kind: "computer.observe-workspace-edit",
    operationId: report.pending.operationId,
  };
  const observed = await configure(command);
  mutationReplyWitness(
    observed,
    report.pending,
    report.effect,
    before.settings,
  );
  report.commands.push({ command, reply: observed });
  const afterObserve = await readMutationState(io);
  mutationAuthorityWitness(afterObserve, before);
  assert.deepEqual(
    contentFree(afterObserve),
    contentFree(before),
    "MUTATION_OBSERVE_EXTRA_EFFECT",
  );
  await save();
  // Restart has no in-memory submitted React intention. ACK uses the existing
  // preload command after exact independent observation, not fabricated state.
  const ack = {
    kind: "computer.ack-workspace-edit",
    operationId: report.pending.operationId,
  };
  const reply = await configure(ack);
  mutationAckWitness(ack, reply, report.pending, afterObserve.settings);
  report.commands.push({
    command: ack,
    reply,
    policy: "temporary-ts-pending-delivery-not-go-ack",
  });
  const after = await readMutationState(io);
  await current(window, after);
  mutationAuthorityWitness(after, before);
  mutationEffectWitness(
    after,
    report.pending,
    original,
    after.fileBytes,
    readCanary.relativePath,
    true,
  );
  for (const key of [
    "mutation",
    "mutationNames",
    "mutationPhysical",
    "tsMutationNames",
    "fileBytes",
  ])
    assert.deepEqual(
      after[key],
      before[key],
      `MUTATION_ACK_EXTRA_EFFECT:${key}`,
    );
  report.observations.push(contentFree(after));
  report.ackPolicy = "temporary-ts-pending-delivery-not-go-ack";
  report.passed = true;
  ledger();
  await hidden();
  await save();
  return after.settings;
}

export function mutationWitnessSelfTest(pass, reject) {
  // Expected answers live only here. They never enter a production adapter.
  const original = Buffer.from(readCanary.text);
  const changed = Buffer.from(
    readCanary.text.replace(mutationText.oldText, mutationText.newText),
  );
  const profile = {
    schema: "farol-native-profile/2",
    profileId: "12345678-1234-4234-8234-123456789abc",
    computerId: "computer",
  };
  pass(() => mutationProfileWitness(profile));
  reject(() =>
    mutationProfileWitness({ ...profile, schema: "farol-native-profile/1" }),
  );
  const pending = {
    operationId: "87654321-1234-4234-8234-123456789abc",
    workspaceId: "folder",
    relativePath: readCanary.relativePath,
    computerGeneration: 3,
    submittedAt: "2026-10-04T12:00:00.000Z",
    backend: "go-owner-v2",
    profileId: profile.profileId,
    beforeSha256: hash(original),
  };
  const workspace = {
    workspaceId: "folder",
    root: "/fixture/workspace",
    access: "write",
    rootIdentity: { device: "1", inode: "2" },
    excludedPaths: [],
  };
  const settings = {
    revision: 2,
    computer: {
      computerId: "computer",
      generation: 3,
      commands: "none",
      pendingEdit: pending,
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
  const identity = {
    scope: "owner-settings",
    operationId: pending.operationId,
    ownerId: "owner-desktop",
    profileId: profile.profileId,
    computerId: "computer",
  };
  const value = {
    schemaVersion: 2,
    kind: "workspace_owner_mutation",
    record: {
      identity,
      computerGeneration: 3,
      workspaceId: "folder",
      relativePath: readCanary.relativePath,
      requestDigest: hash(
        JSON.stringify([
          "folder",
          "workspace.edit",
          readCanary.relativePath,
          hash(original),
          [[mutationText.oldText, mutationText.newText]],
        ]),
      ),
      phase: "completed",
      outcome: {
        receipt: expectedReceipt(original, changed, readCanary.relativePath),
      },
    },
  };
  const observed = {
    profile: { value: profile },
    settings,
    configuration: { value: structuredClone(settings) },
    physical: {
      workspaceRoot: { path: workspace.root, Device: "1", Inode: "2" },
    },
    access: {
      value: {
        schema: 1,
        profileId: profile.profileId,
        ownerId: "owner-desktop",
        computerId: "computer",
        revision: "4",
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
        scope: { ProfileID: profile.profileId, BackendGeneration: "backend" },
        writes: [],
        retirement: null,
      },
    },
    mutationNames: [mutationKey(identity)],
    tsMutationNames: [],
    mutation: { value, sha256: hash(JSON.stringify(value) + "\n") },
  };
  const check = (v = observed, bytes = changed) =>
    mutationEffectWitness(v, pending, original, bytes, readCanary.relativePath);
  let effect;
  pass(() => {
    effect = check();
  });
  pass(() => mutationAuthorityWitness(observed, observed));
  for (const mutate of [
    (v) => {
      v.profile.value.schema = "farol-native-profile/1";
    },
    (v) => {
      v.settings.computer.pendingEdit = null;
    },
    (v) => {
      v.settings.computer.pendingEdit.operationId = "crossed";
    },
    (v) => {
      v.settings.computer.pendingEdit.backend = "ts";
    },
    (v) => {
      v.settings.computer.pendingEdit.profileId = "crossed";
    },
    (v) => {
      v.settings.computer.pendingEdit.beforeSha256 = "a".repeat(64);
    },
    (v) => {
      v.access.value.participants.fake = {};
    },
    (v) => {
      v.chat.value.writes.push({ Entry: { Kind: "admit" } });
    },
    (v) => {
      v.mutationNames = [];
    },
    (v) => {
      v.mutationNames.push(v.mutationNames[0]);
    },
    (v) => {
      v.mutationNames = ["crossed.json"];
    },
    (v) => {
      v.tsMutationNames = ["synthetic-task.json"];
    },
    (v) => {
      v.mutation = null;
    },
    (v) => {
      v.mutation.value.schemaVersion = 1;
    },
    (v) => {
      v.mutation.value.record.identity.taskId = "synthetic";
    },
    (v) => {
      v.mutation.value.record.identity.profileId = "crossed";
    },
    (v) => {
      v.mutation.value.record.identity.computerId = "crossed";
    },
    (v) => {
      v.mutation.value.record.identity.ownerId = "crossed";
    },
    (v) => {
      v.mutation.value.record.identity.operationId = "crossed";
    },
    (v) => {
      v.mutation.value.record.computerGeneration++;
    },
    (v) => {
      v.mutation.value.record.relativePath = "crossed";
    },
    (v) => {
      v.mutation.value.record.workspaceId = "crossed";
    },
    (v) => {
      v.mutation.value.record.requestDigest = "a".repeat(64);
    },
    (v) => {
      v.mutation.value.record.phase = "outcome_unknown";
    },
    (v) => {
      v.mutation.value.record.outcome.receipt.afterSha256 = "a".repeat(64);
    },
    (v) => {
      v.mutation.value.record.outcome.receipt.beforeSha256 = "a".repeat(64);
    },
    (v) => {
      v.mutation.value.record.outcome.receipt.bytes++;
    },
    (v) => {
      v.mutation.value.record.outcome.receipt.replacements++;
    },
    (v) => {
      v.mutation.value.record.outcome.receipt.content = "private";
    },
    (v) => {
      v.mutation.sha256 = "a".repeat(64);
    },
  ]) {
    const v = structuredClone(observed);
    mutate(v);
    reject(() => check(v));
  }
  reject(() => check(observed, original));
  reject(() => check(observed, Buffer.concat([changed, changed])));
  const { kind: _kind, ...receipt } = effect.receipt;
  const reply = {
    ok: true,
    snapshot: { status: "ready", settings },
    evidence: {
      kind: "computer.workspace-mutation",
      operationId: pending.operationId,
      workspaceId: "folder",
      ...receipt,
      resultRetention: "durable",
      redelivered: true,
    },
  };
  pass(() => mutationReplyWitness(reply, pending, effect, settings));
  for (const change of [
    { operationId: "crossed" },
    { workspaceId: "crossed" },
    { afterSha256: "a".repeat(64) },
    { redelivered: false },
    { resultRetention: "memory-only" },
  ])
    reject(() =>
      mutationReplyWitness(
        { ...reply, evidence: { ...reply.evidence, ...change } },
        pending,
        effect,
        settings,
      ),
    );
  reject(() =>
    mutationReplyWitness({ ...reply, ok: false }, pending, effect, settings),
  );
  const crossedReply = structuredClone(reply);
  crossedReply.snapshot.settings.computer.generation++;
  reject(() => mutationReplyWitness(crossedReply, pending, effect, settings));
  reject(() =>
    mutationReplyWitness(
      { ...reply, evidence: null },
      pending,
      effect,
      settings,
    ),
  );
  const ack = {
    kind: "computer.ack-workspace-edit",
    operationId: pending.operationId,
  };
  const ackSettings = structuredClone(settings);
  ackSettings.revision++;
  ackSettings.computer.pendingEdit = null;
  const ackReply = {
    ok: true,
    snapshot: { status: "ready", settings: ackSettings },
  };
  pass(() => mutationAckWitness(ack, ackReply, pending, settings));
  reject(() =>
    mutationAckWitness(
      { ...ack, operationId: "crossed" },
      ackReply,
      pending,
      settings,
    ),
  );
  reject(() =>
    mutationAckWitness(ack, { ...ackReply, ok: false }, pending, settings),
  );
  reject(() =>
    mutationAckWitness(
      ack,
      { ok: true, snapshot: { status: "ready", settings } },
      pending,
      settings,
    ),
  );
  const cleared = structuredClone(observed);
  cleared.settings = ackSettings;
  cleared.configuration.value = structuredClone(ackSettings);
  pass(() =>
    mutationEffectWitness(
      cleared,
      pending,
      original,
      changed,
      readCanary.relativePath,
      true,
    ),
  );
  reject(() => check(cleared));
  const refused = {
    ok: false,
    snapshot: { status: "ready", settings },
    error: "WORKSPACE_MUTATION_PREVIEW_NOT_FOUND",
  };
  pass(() => mutationDuplicateWitness(refused, settings));
  reject(() => mutationDuplicateWitness({ ...refused, ok: true }, settings));
  reject(() =>
    mutationDuplicateWitness(
      { ...refused, error: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" },
      settings,
    ),
  );
  const terminal = {
    ...structuredClone(observed),
    file: { bytes: changed.length, sha256: hash(changed) },
  };
  const cleanup = {
    launchResolved: true,
    closeRequested: true,
    exitObserved: true,
    exitCode: 0,
    signal: null,
    drained: true,
    runMarkerRemoved: true,
  };
  pass(() =>
    mutationTerminalWitness(terminal, terminal, pending, cleanup, false),
  );
  const ackTerminal = structuredClone(terminal);
  ackTerminal.settings = ackSettings;
  ackTerminal.configuration.value = structuredClone(ackSettings);
  pass(() =>
    mutationTerminalWitness(ackTerminal, terminal, pending, cleanup, true),
  );
  for (const key of Object.keys(cleanup)) {
    const unknown = { ...cleanup };
    delete unknown[key];
    reject(() =>
      mutationTerminalWitness(terminal, terminal, pending, unknown, false),
    );
  }
  for (const change of [
    { exitCode: 1 },
    { signal: "SIGTERM" },
    { drained: false },
    { runMarkerRemoved: false },
  ])
    reject(() =>
      mutationTerminalWitness(
        terminal,
        terminal,
        pending,
        { ...cleanup, ...change },
        false,
      ),
    );
  for (const mutate of [
    (v) => {
      v.file.sha256 = "a".repeat(64);
    },
    (v) => {
      v.mutation.sha256 = "a".repeat(64);
    },
    (v) => {
      v.mutationNames.push(v.mutationNames[0]);
    },
    (v) => {
      v.settings.computer.pendingEdit = null;
    },
    (v) => {
      v.settings.computer.pendingEdit.operationId = "crossed";
    },
    (v) => {
      v.tsMutationNames = ["extra.json"];
    },
  ]) {
    const v = structuredClone(terminal);
    mutate(v);
    reject(() => mutationTerminalWitness(v, terminal, pending, cleanup, false));
  }
}
