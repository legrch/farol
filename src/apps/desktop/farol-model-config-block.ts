import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  buildProviderBlockBody,
  buildSelectionBody,
  type FarolModelProviderSelection,
  type FarolModelProviderSpec,
} from "../../../apps/desktop/model/build";
import { lineDiff } from "../../../apps/desktop/model/diff";
import { hasUnterminatedMultilineString } from "../../../apps/desktop/model/lex";
import {
  defaultModeFor,
  insecurePermissionsRefusal,
  type FarolModelConfigInsecurePermissions,
} from "../../../apps/desktop/model/mode";
import {
  newRedactionRegistry,
  redactBearerTokenLiterals,
  redactConfigText,
} from "../../../apps/desktop/model/redact";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  bytesOf,
  insertAt,
  locateRegion,
  nestedInside,
  regionText,
  removalSpan,
  removeRegion,
  replaceRegion,
  SELECTION_BEGIN,
  SELECTION_END,
  textOf,
  type Bytes,
} from "../../../apps/desktop/model/region";
import {
  findForeignProviderConflicts,
  findForeignSelectionConflicts,
  firstForeignHeaderOffset,
  type FarolModelConfigConflict,
} from "../../../apps/desktop/model/scan";

export { FAROL_MODEL_HOST_TUNING } from "../../../apps/desktop/model/build";
export type {
  FarolModelDelivery,
  FarolModelProviderSelection,
  FarolModelProviderSpec,
} from "../../../apps/desktop/model/build";
export type { FarolModelConfigInsecurePermissions } from "../../../apps/desktop/model/mode";
export { FAROL_MODEL_TOKEN_PLACEHOLDER } from "../../../apps/desktop/model/redact";
export type { FarolModelConfigConflict } from "../../../apps/desktop/model/scan";

// The managed-config-block lifecycle for an ordinary Codex `config.toml`.
// See Decisions.md N04, item 3-4, and the N04 addendum. This module never
// parses the file into a TOML document and re-serializes it — that would
// risk reformatting sections Farol did not write. Instead it does byte
// surgery on marked regions, so every byte outside those regions is
// untouched, by construction.
//
// Two independent regions, each with its own marker pair, backup, and
// consent:
//   1. The provider block — `[model_providers.<name>]` only. Never a
//      `[profiles.<name>]` table: the addendum found that legacy on this
//      host version, and codex-cli 0.153.4 refuses `--profile` against a
//      config that carries one. Selecting the provider is a separate act.
//   2. The provider selection — the root-table `model_provider = "…"` and
//      `model = "…"` pair. TOML requires a root-table key to precede every
//      `[table]` header in the file, so this region is inserted before the
//      first table header (or before the provider block itself, whichever
//      comes first), never appended blindly.
//
// Exact-bytes invariant. A region is written as
//   <one "\n" when anything precedes it> BEGIN-marker … END-marker "\n"
// and nothing else: no trimming of what was there, no extra blank lines.
// Rollback therefore needs nothing but the current file: it removes the
// region plus the one separator Farol placed before it (only where that
// separator is provably Farol's, so two owner lines are never joined), and every other
// byte — including whatever the owner added after the apply — stays where
// it was. The backups this module keeps are secondary evidence for the
// owner; they are never the rollback source. The file's bytes travel as a
// latin1 string so the surgery is binary-safe (no UTF-8 re-encoding).

const BLOCK_BACKUP_SUFFIX = ".farol-backup";

const SELECTION_BACKUP_SUFFIX = ".farol-selection-backup";

/**
 * Marks a `config.toml` that did not exist before Farol's first apply, so a
 * rollback that leaves no bytes at all removes the file instead of leaving
 * an empty one. It is the one fact the current bytes cannot carry.
 */
const CREATED_MARKER_SUFFIX = ".farol-created";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

/**
 * Closed refusals shared by every operation: `symlink` — the path is a
 * symbolic link, which this module never reads through or renames over;
 * `malformed` — a Farol marker is present but missing, duplicated, moved
 * off its own line, or its partner is gone, so the region's extent is not
 * knowable and nothing is written; or the config holds a multi-line string
 * that never closes, so anything written after it would be string content.
 */
export type FarolModelConfigRefusal =
  Readonly<{ status: "symlink" }> | Readonly<{ status: "malformed" }>;

export type FarolModelConfigPreview =
  | Readonly<{
      status: "install" | "update";
      /** Line diff of the whole change; bearer-token literals are redacted. */
      diff: string;
      /** True when the diff carried at least one redacted token literal. */
      tokenRedacted: boolean;
    }>
  | Readonly<{ status: "noop" }>
  | Readonly<{
      status: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>
  | FarolModelConfigInsecurePermissions
  | FarolModelConfigRefusal;

export type FarolModelConfigApplyResult =
  | Readonly<{ status: "applied" | "noop" }>
  | Readonly<{
      status: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>
  | FarolModelConfigInsecurePermissions
  | FarolModelConfigRefusal;

export type FarolModelConfigRollbackResult =
  | Readonly<{ status: "restored" }>
  | Readonly<{ status: "not_present" }>
  | FarolModelConfigRefusal;

export type FarolModelSelectionPreview =
  | Readonly<{ status: "install" | "update"; diff: string }>
  | Readonly<{ status: "noop" }>
  | Readonly<{
      status: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>
  | FarolModelConfigRefusal;

export type FarolModelSelectionApplyResult =
  | Readonly<{ status: "applied" | "noop" }>
  | Readonly<{
      status: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>
  | FarolModelConfigRefusal;

// Filesystem.

type ConfigRead =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "symlink" }>
  | Readonly<{ kind: "file"; bytes: Bytes; mode: number }>;

/**
 * Reads the file without ever following a symbolic link: an `lstat` first
 * for a clear answer, then `O_NOFOLLOW` on the open itself so a link
 * planted between the two calls is still refused.
 */
async function readConfig(configPath: string): Promise<ConfigRead> {
  try {
    if ((await fs.lstat(configPath)).isSymbolicLink())
      return { kind: "symlink" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }
  let handle;
  try {
    handle = await fs.open(
      configPath,
      fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP") return { kind: "symlink" };
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("FAROL_MODEL_CONFIG_NOT_A_FILE");
    const buffer = await handle.readFile();
    return {
      kind: "file",
      bytes: buffer.toString("latin1"),
      mode: info.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Writes `bytes` to `target` atomically: an exclusive, no-follow temporary
 * file in the same directory, fsync, mode set on the open descriptor, then
 * rename. A symbolic link sitting at `target` is replaced by the rename,
 * never written through.
 */
async function atomicWriteNoFollow(
  target: string,
  bytes: Bytes,
  mode: number,
): Promise<void> {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
      mode,
    );
    await handle.writeFile(Buffer.from(bytes, "latin1"));
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Plans: preview and apply share one computation, so what the owner
// consented to is exactly what gets written.

type WritePlan = Readonly<{
  kind: "write";
  before: Bytes;
  desired: Bytes;
  /** The existing file's mode, or undefined when the file does not exist. */
  mode: number | undefined;
  update: boolean;
  /** True when the file already carried neither managed region. */
  pristine: boolean;
}>;

type BlockPlan =
  | WritePlan
  | Readonly<{ kind: "noop" }>
  | Readonly<{
      kind: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>
  | Readonly<{ kind: "insecure_permissions"; mode: number }>
  | Readonly<{ kind: "symlink" }>
  | Readonly<{ kind: "malformed" }>;

/**
 * The one redaction boundary: every string that leaves this module as
 * evidence is built from text already redacted as a whole, before any diff
 * folds lines away. Diffs compare redacted old against redacted new;
 * conflict lines come from the redacted copy of the scanned text.
 */
function evidenceDiff(
  before: Bytes,
  desired: Bytes,
  literal?: string,
): Readonly<{ text: string; redacted: boolean }> {
  const registry = newRedactionRegistry();
  const old = redactBearerTokenLiterals(textOf(before), literal, registry);
  const next = redactBearerTokenLiterals(textOf(desired), literal, registry);
  return {
    text: lineDiff(old.text, next.text),
    redacted: old.redacted || next.redacted,
  };
}

/**
 * Conflict evidence comes only from the redacted copy of the scanned text:
 * both the table and the line. When the redacted copy does not reproduce the
 * same conflicts, nothing from the original is returned.
 */
function evidenceConflicts(
  conflicts: readonly FarolModelConfigConflict[],
  scan: Bytes,
  find: (text: Bytes) => FarolModelConfigConflict[],
): readonly FarolModelConfigConflict[] {
  const redacted = find(redactConfigText(scan).text);
  if (redacted.length === conflicts.length) return redacted;
  return conflicts.map(() => ({
    table: "<withheld>",
    line: "<line withheld>",
  }));
}

async function planProviderBlock(
  configPath: string,
  spec: FarolModelProviderSpec,
): Promise<BlockPlan> {
  const read = await readConfig(configPath);
  if (read.kind === "symlink") return { kind: "symlink" };
  const before = read.kind === "file" ? read.bytes : "";
  const mode = read.kind === "file" ? read.mode : undefined;
  const insecure = insecurePermissionsRefusal(spec.delivery, mode);
  if (insecure) return { kind: "insecure_permissions", mode: insecure.mode };

  // A multi-line string that never closes would swallow the block.
  if (hasUnterminatedMultilineString(before)) return { kind: "malformed" };
  const block = locateRegion(before, BLOCK_BEGIN, BLOCK_END);
  const selection = locateRegion(before, SELECTION_BEGIN, SELECTION_END);
  if (!block.ok || !selection.ok) return { kind: "malformed" };

  const scan = block.region ? removeRegion(before, block.region) : before;
  const conflicts = findForeignProviderConflicts(scan, spec.providerName);
  if (conflicts.length > 0) {
    return {
      kind: "conflict",
      conflicts: evidenceConflicts(conflicts, scan, (text) =>
        findForeignProviderConflicts(text, spec.providerName),
      ),
    };
  }

  const body = bytesOf(buildProviderBlockBody(spec));
  let desired: Bytes;
  if (!block.region) {
    desired = insertAt(before, before.length, body);
  } else if (selection.region && nestedInside(selection.region, block.region)) {
    // A layout an earlier build produced: the selection was inserted before
    // the block's own table header, inside the block. Lift it out in front
    // of the rewritten block so each region stays independently removable.
    const lifted = regionText(before, selection.region);
    desired = insertAt(
      replaceRegion(before, block.region, body),
      block.region.start - block.region.leading,
      lifted,
    );
  } else {
    desired = replaceRegion(before, block.region, body);
  }
  if (read.kind === "file" && desired === before) return { kind: "noop" };
  return {
    kind: "write",
    before,
    desired,
    mode,
    update: block.region !== undefined,
    pristine: block.region === undefined && selection.region === undefined,
  };
}

type SelectionPlan =
  | WritePlan
  | Readonly<{ kind: "noop" }>
  | Readonly<{
      kind: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>
  | Readonly<{ kind: "symlink" }>
  | Readonly<{ kind: "malformed" }>;

async function planSelection(
  configPath: string,
  selection: FarolModelProviderSelection,
): Promise<SelectionPlan> {
  const read = await readConfig(configPath);
  if (read.kind === "symlink") return { kind: "symlink" };
  const before = read.kind === "file" ? read.bytes : "";
  const mode = read.kind === "file" ? read.mode : undefined;

  // A multi-line string that never closes would swallow the selection.
  if (hasUnterminatedMultilineString(before)) return { kind: "malformed" };
  const existing = locateRegion(before, SELECTION_BEGIN, SELECTION_END);
  if (!existing.ok || !locateRegion(before, BLOCK_BEGIN, BLOCK_END).ok) {
    return { kind: "malformed" };
  }
  const base = existing.region ? removeRegion(before, existing.region) : before;
  // Re-locate the block in `base`: removing the selection shifts offsets.
  const block = locateRegion(base, BLOCK_BEGIN, BLOCK_END);
  if (!block.ok) return { kind: "malformed" };

  const conflicts = findForeignSelectionConflicts(base);
  if (conflicts.length > 0) {
    return {
      kind: "conflict",
      conflicts: evidenceConflicts(
        conflicts,
        base,
        findForeignSelectionConflicts,
      ),
    };
  }

  const candidates = [
    firstForeignHeaderOffset(base, block.region),
    block.region ? block.region.start - block.region.leading : undefined,
  ].filter((offset): offset is number => offset !== undefined);
  const offset = candidates.length > 0 ? Math.min(...candidates) : base.length;
  const desired = insertAt(
    base,
    offset,
    bytesOf(buildSelectionBody(selection)),
  );
  if (read.kind === "file" && desired === before) return { kind: "noop" };
  return {
    kind: "write",
    before,
    desired,
    mode,
    update: existing.region !== undefined,
    pristine: existing.region === undefined && block.region === undefined,
  };
}

async function executePlan(
  configPath: string,
  plan: WritePlan,
  backupSuffix: string,
  createdMode: number,
): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  // Secondary evidence only: the bytes as they stood before this write.
  await atomicWriteNoFollow(`${configPath}${backupSuffix}`, plan.before, 0o600);
  const createdMarker = `${configPath}${CREATED_MARKER_SUFFIX}`;
  if (plan.mode === undefined) {
    await atomicWriteNoFollow(createdMarker, "", 0o600);
  } else if (plan.pristine) {
    // The owner has a file of their own here now; a stale marker from an
    // earlier, fully rolled-back apply must not delete it later.
    await fs.rm(createdMarker, { force: true });
  }
  await atomicWriteNoFollow(configPath, plan.desired, plan.mode ?? createdMode);
}

async function removeManagedRegion(
  configPath: string,
  begin: Bytes,
  end: Bytes,
  lift: Readonly<{ begin: Bytes; end: Bytes }> | undefined,
): Promise<FarolModelConfigRollbackResult> {
  const read = await readConfig(configPath);
  if (read.kind === "missing") return { status: "not_present" };
  if (read.kind === "symlink") return { status: "symlink" };
  const located = locateRegion(read.bytes, begin, end);
  if (!located.ok) return { status: "malformed" };
  if (!located.region) return { status: "not_present" };
  const region = located.region;

  let remaining = removeRegion(read.bytes, region);
  if (lift) {
    const inner = locateRegion(read.bytes, lift.begin, lift.end);
    if (!inner.ok) return { status: "malformed" };
    if (inner.region && nestedInside(inner.region, region)) {
      // Legacy nesting (see `planProviderBlock`): keep the inner region,
      // now standing where the outer one began.
      const keep = regionText(read.bytes, inner.region);
      const { from, to } = removalSpan(read.bytes, region);
      const head = read.bytes.slice(0, from);
      const tail = read.bytes.slice(to);
      // When the cut kept the owner's own line terminator, the lifted region
      // starts a fresh line and needs no separator of its own.
      remaining =
        from > 0 && head.endsWith("\n") && from === region.start
          ? `${head}${keep}\n${tail}`
          : insertAt(`${head}${tail}`, from, keep);
    }
  }

  const createdMarker = `${configPath}${CREATED_MARKER_SUFFIX}`;
  if (remaining.length === 0 && (await pathExists(createdMarker))) {
    await fs.rm(configPath, { force: true });
    await fs.rm(createdMarker, { force: true });
  } else {
    await atomicWriteNoFollow(configPath, remaining, read.mode);
  }
  return { status: "restored" };
}

// ---------------------------------------------------------------------------
// Public surface.

/**
 * Computes what applying `spec` to `configPath` would do, without writing
 * anything. A foreign entry of the same name Farol did not write is a
 * conflict, reported and never overwritten. A literal-token delivery
 * against a group- or other-readable existing file is refused before any
 * diff is computed. The diff never carries a bearer-token literal.
 */
export async function previewFarolModelConfigBlock(
  configPath: string,
  spec: FarolModelProviderSpec,
): Promise<FarolModelConfigPreview> {
  const plan = await planProviderBlock(configPath, spec);
  if (plan.kind === "write") {
    const literal =
      spec.delivery.mode === "bearer-token" ? spec.delivery.token : undefined;
    const { text, redacted } = evidenceDiff(plan.before, plan.desired, literal);
    return {
      status: plan.update ? "update" : "install",
      diff: text,
      tokenRedacted: redacted,
    };
  }
  if (plan.kind === "insecure_permissions") {
    return { status: "insecure_permissions", mode: plan.mode };
  }
  if (plan.kind === "conflict") {
    return { status: "conflict", conflicts: plan.conflicts };
  }
  return { status: plan.kind };
}

/**
 * Applies `spec` to `configPath`: preview → consent is the caller's job
 * (call `previewFarolModelConfigBlock` first and get the owner's yes). This
 * writes atomically (temp file, fsync, rename), preserves the original
 * mode (or creates the file 0600 for a literal-token delivery, 0644
 * otherwise), rewrites an existing block in place, and keeps the pre-write
 * bytes as a 0600 backup. A second apply of the same desired state is a
 * no-op — it never touches the backup.
 */
export async function applyFarolModelConfigBlock(
  configPath: string,
  spec: FarolModelProviderSpec,
): Promise<FarolModelConfigApplyResult> {
  const plan = await planProviderBlock(configPath, spec);
  if (plan.kind === "write") {
    await executePlan(
      configPath,
      plan,
      BLOCK_BACKUP_SUFFIX,
      defaultModeFor(spec.delivery),
    );
    return { status: "applied" };
  }
  if (plan.kind === "insecure_permissions") {
    return { status: "insecure_permissions", mode: plan.mode };
  }
  if (plan.kind === "conflict") {
    return { status: "conflict", conflicts: plan.conflicts };
  }
  return { status: plan.kind };
}

/**
 * Removes exactly the managed provider block from the file's current bytes
 * — the region and the one separator Farol placed before it, never an owner
 * line terminator (see `removalSpan`) — and leaves
 * every other byte, including anything the owner added since, untouched.
 * A file Farol created that has nothing left in it is removed. Never
 * restores a backup: a torn or moved marker is refused as `malformed`.
 */
export async function rollbackFarolModelConfigBlock(
  configPath: string,
): Promise<FarolModelConfigRollbackResult> {
  return removeManagedRegion(configPath, BLOCK_BEGIN, BLOCK_END, {
    begin: SELECTION_BEGIN,
    end: SELECTION_END,
  });
}

/**
 * Computes what consenting to select Farol as the default provider would
 * do — a separate, separately consented act from installing the provider
 * block itself (Decisions.md N04 addendum, item 2). The region carries both
 * root keys the host needs, `model_provider` and `model`; a foreign
 * root-table `model_provider` or `model` key Farol did not write is a
 * conflict.
 */
export async function previewFarolModelProviderSelection(
  configPath: string,
  selection: FarolModelProviderSelection,
): Promise<FarolModelSelectionPreview> {
  const plan = await planSelection(configPath, selection);
  if (plan.kind === "write") {
    return {
      status: plan.update ? "update" : "install",
      diff: evidenceDiff(plan.before, plan.desired).text,
    };
  }
  if (plan.kind === "conflict") {
    return { status: "conflict", conflicts: plan.conflicts };
  }
  return { status: plan.kind };
}

/** Applies the provider selection. See `previewFarolModelProviderSelection`. */
export async function applyFarolModelProviderSelection(
  configPath: string,
  selection: FarolModelProviderSelection,
): Promise<FarolModelSelectionApplyResult> {
  const plan = await planSelection(configPath, selection);
  if (plan.kind === "write") {
    await executePlan(configPath, plan, SELECTION_BACKUP_SUFFIX, 0o644);
    return { status: "applied" };
  }
  if (plan.kind === "conflict") {
    return { status: "conflict", conflicts: plan.conflicts };
  }
  return { status: plan.kind };
}

/** Removes exactly the managed selection region. See `rollbackFarolModelConfigBlock`. */
export async function rollbackFarolModelProviderSelection(
  configPath: string,
): Promise<FarolModelConfigRollbackResult> {
  return removeManagedRegion(
    configPath,
    SELECTION_BEGIN,
    SELECTION_END,
    undefined,
  );
}
