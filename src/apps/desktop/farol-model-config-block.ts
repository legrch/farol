import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// The managed-config-block lifecycle for an ordinary Codex `config.toml`.
// See Decisions.md N04, item 3-4, and the N04 addendum. This module never
// parses the file into a TOML document and re-serializes it — that would
// risk reformatting sections Farol did not write. Instead it does text
// surgery on marked regions, so every byte outside those regions is
// untouched, by construction.
//
// Two independent regions, each with its own marker pair, backup, and
// consent:
//   1. The provider block — `[model_providers.<name>]` only. Never a
//      `[profiles.<name>]` table: the addendum found that legacy on this
//      host version, and codex-cli 0.153.4 refuses `--profile` against a
//      config that carries one. Selecting the provider is a separate act.
//   2. The provider selection — a single top-level `model_provider = "…"`
//      line. TOML requires a root-table key to precede every `[table]`
//      header in the file, so this region is inserted before the first
//      table header (which is usually the provider block itself, appended
//      at the end), never appended blindly.

const BLOCK_BEGIN_MARKER = "# BEGIN FAROL MANAGED BLOCK — do not edit by hand";
const BLOCK_END_MARKER = "# END FAROL MANAGED BLOCK";
const BLOCK_BACKUP_SUFFIX = ".farol-backup";

const SELECTION_BEGIN_MARKER =
  "# BEGIN FAROL MANAGED MODEL_PROVIDER SELECTION — do not edit by hand";
const SELECTION_END_MARKER = "# END FAROL MANAGED MODEL_PROVIDER SELECTION";
const SELECTION_BACKUP_SUFFIX = ".farol-selection-backup";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

/**
 * How the bearer credential reaches Codex. `env-key` names an environment
 * variable Codex reads once at process start — Farol uses this when it
 * starts the host itself, so the literal token never touches disk. A GUI
 * Codex the owner starts themselves has no shell to receive an environment
 * variable from, so that case carries the token literal in the file
 * (`experimental_bearer_token`, the only credential field codex-cli 0.153.4
 * accepts besides `env_key`) — gated on the file not being group- or
 * other-readable.
 */
export type FarolModelDelivery =
  | Readonly<{ mode: "env-key"; envKeyName: string }>
  | Readonly<{ mode: "bearer-token"; token: string }>;

export type FarolModelProviderSpec = Readonly<{
  /** The `model_providers.<name>` table name Farol owns. */
  providerName: string;
  displayName: string;
  baseUrl: string;
  model: string;
  wireApi: "responses";
  delivery: FarolModelDelivery;
}>;

export type FarolModelConfigConflict = Readonly<{
  table: string;
  line: string;
}>;

export type FarolModelConfigInsecurePermissions = Readonly<{
  status: "insecure_permissions";
  mode: number;
}>;

export type FarolModelConfigPreview =
  | Readonly<{ status: "install" | "update"; diff: string; desired: string }>
  | Readonly<{ status: "noop" }>
  | Readonly<{
      status: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>
  | FarolModelConfigInsecurePermissions;

export type FarolModelConfigApplyResult =
  | Readonly<{ status: "applied" | "noop" }>
  | Readonly<{
      status: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>
  | FarolModelConfigInsecurePermissions;

export type FarolModelConfigRollbackResult =
  Readonly<{ status: "restored" }> | Readonly<{ status: "no_backup" }>;

export type FarolModelSelectionPreview =
  | Readonly<{ status: "install"; diff: string; desired: string }>
  | Readonly<{ status: "noop" }>
  | Readonly<{
      status: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>;

export type FarolModelSelectionApplyResult =
  | Readonly<{ status: "applied" | "noop" }>
  | Readonly<{
      status: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>;

function buildProviderBlockBody(spec: FarolModelProviderSpec): string {
  const lines = [
    BLOCK_BEGIN_MARKER,
    `[model_providers.${spec.providerName}]`,
    `name = ${JSON.stringify(spec.displayName)}`,
    `base_url = ${JSON.stringify(spec.baseUrl)}`,
    spec.delivery.mode === "env-key"
      ? `env_key = ${JSON.stringify(spec.delivery.envKeyName)}`
      : `experimental_bearer_token = ${JSON.stringify(spec.delivery.token)}`,
    `wire_api = ${JSON.stringify(spec.wireApi)}`,
    BLOCK_END_MARKER,
  ];
  return lines.join("\n");
}

function buildSelectionBody(providerName: string): string {
  return [
    SELECTION_BEGIN_MARKER,
    `model_provider = ${JSON.stringify(providerName)}`,
    SELECTION_END_MARKER,
  ].join("\n");
}

type MarkedRegion = Readonly<{ start: number; end: number }>;

/** Locates a single marked region delimited by `begin`/`end`, if present. */
function findMarkedRegion(
  contents: string,
  begin: string,
  end: string,
): MarkedRegion | undefined {
  const beginIndex = contents.indexOf(begin);
  if (beginIndex === -1) return undefined;
  const endMarkerIndex = contents.indexOf(end, beginIndex);
  if (endMarkerIndex === -1) {
    throw new Error("FAROL_MODEL_CONFIG_BLOCK_MALFORMED");
  }
  return { start: beginIndex, end: endMarkerIndex + end.length };
}

function withoutRegion(
  contents: string,
  region: MarkedRegion | undefined,
): string {
  if (!region) return contents;
  return contents.slice(0, region.start) + contents.slice(region.end);
}

const TABLE_HEADER = /^\s*\[([^\]]+)\]\s*$/u;
const TOP_LEVEL_KEY = /^\s*([A-Za-z0-9_-]+)\s*=/u;

function findForeignProviderConflicts(
  contentsWithoutManagedBlock: string,
  providerName: string,
): FarolModelConfigConflict[] {
  const watched = `model_providers.${providerName}`;
  const conflicts: FarolModelConfigConflict[] = [];
  for (const line of contentsWithoutManagedBlock.split("\n")) {
    const match = TABLE_HEADER.exec(line);
    if (!match) continue;
    if ((match[1] ?? "").trim() === watched)
      conflicts.push({ table: watched, line });
  }
  return conflicts;
}

/**
 * A `model_provider = …` line is only a genuine root-table key before the
 * first `[table]` header in the document — TOML has no other way to write
 * a root-table key after any table has started. A foreign one there,
 * Farol did not write, is a conflict.
 */
function findForeignSelectionConflicts(
  contentsWithoutManagedSelection: string,
): FarolModelConfigConflict[] {
  const conflicts: FarolModelConfigConflict[] = [];
  for (const line of contentsWithoutManagedSelection.split("\n")) {
    if (TABLE_HEADER.test(line)) break;
    const match = TOP_LEVEL_KEY.exec(line);
    if (match && match[1] === "model_provider") {
      conflicts.push({ table: "(top-level)", line });
    }
  }
  return conflicts;
}

function unifiedDiff(before: string, after: string): string {
  if (before === after) return "";
  const beforeLines = before.length === 0 ? [] : before.split("\n");
  const afterLines = after.length === 0 ? [] : after.split("\n");
  const removed = beforeLines.map((line) => `-${line}`);
  const added = afterLines.map((line) => `+${line}`);
  return [...removed, ...added].join("\n");
}

async function readConfig(
  configPath: string,
): Promise<Readonly<{ contents: string; mode: number | undefined }>> {
  try {
    const [contents, stat] = await Promise.all([
      fs.readFile(configPath, "utf8"),
      fs.stat(configPath),
    ]);
    return { contents, mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { contents: "", mode: undefined };
    }
    throw error;
  }
}

/** Appends `block` at the end of the file — used by the provider block. */
function appendBlock(withoutBlock: string, block: string): string {
  const trimmed = withoutBlock.replace(/\s+$/u, "");
  if (trimmed.length === 0) return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}

/**
 * Inserts `block` immediately before the first `[table]` header in the
 * file — used by the provider selection, which must land in the root
 * table. With no table anywhere, it falls back to appending at the end.
 */
function insertBeforeFirstTable(
  withoutSelection: string,
  block: string,
): string {
  if (withoutSelection.length === 0) return `${block}\n`;
  const lines = withoutSelection.split("\n");
  const tableIndex = lines.findIndex((line) => TABLE_HEADER.test(line));
  if (tableIndex === -1) return appendBlock(withoutSelection, block);
  const before = lines.slice(0, tableIndex).join("\n").replace(/\s+$/u, "");
  const after = lines.slice(tableIndex).join("\n");
  const prefix = before.length === 0 ? "" : `${before}\n\n`;
  return `${prefix}${block}\n\n${after}`;
}

function insecurePermissionsRefusal(
  delivery: FarolModelDelivery,
  mode: number | undefined,
): FarolModelConfigInsecurePermissions | undefined {
  // Only the literal-token delivery writes a secret into the file. A newly
  // created file is written 0600 by this module (see `defaultModeFor`), so
  // only an EXISTING file's current mode can trigger this refusal.
  if (delivery.mode !== "bearer-token" || mode === undefined) return undefined;
  if ((mode & 0o077) !== 0) return { status: "insecure_permissions", mode };
  return undefined;
}

function defaultModeFor(delivery: FarolModelDelivery): number {
  return delivery.mode === "bearer-token" ? 0o600 : 0o644;
}

/**
 * Computes what applying `spec` to `configPath` would do, without writing
 * anything. A foreign entry of the same name Farol did not write is a
 * conflict, reported and never overwritten. A literal-token delivery
 * against a group- or other-readable existing file is refused before any
 * diff is computed.
 */
export async function previewFarolModelConfigBlock(
  configPath: string,
  spec: FarolModelProviderSpec,
): Promise<FarolModelConfigPreview> {
  const { contents, mode } = await readConfig(configPath);
  const insecure = insecurePermissionsRefusal(spec.delivery, mode);
  if (insecure) return insecure;

  const region = findMarkedRegion(
    contents,
    BLOCK_BEGIN_MARKER,
    BLOCK_END_MARKER,
  );
  const withoutBlock = withoutRegion(contents, region);
  const conflicts = findForeignProviderConflicts(
    withoutBlock,
    spec.providerName,
  );
  if (conflicts.length > 0) return { status: "conflict", conflicts };

  const desired = appendBlock(withoutBlock, buildProviderBlockBody(spec));
  if (desired === contents) return { status: "noop" };
  return {
    status: region ? "update" : "install",
    diff: unifiedDiff(contents, desired),
    desired,
  };
}

async function atomicReplace(
  configPath: string,
  contents: string,
  mode: number,
): Promise<void> {
  const directory = path.dirname(configPath);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(configPath)}.${randomUUID()}.tmp`,
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
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, configPath);
    await fs.chmod(configPath, mode);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Applies `spec` to `configPath`: preview → consent is the caller's job
 * (call `previewFarolModelConfigBlock` first and get the owner's yes). This
 * writes atomically (temp file, fsync, rename), preserves the original
 * mode (or creates the file 0600 for a literal-token delivery, 0644
 * otherwise), and keeps exactly one backup that
 * `rollbackFarolModelConfigBlock` restores. A second apply of the same
 * desired state is a no-op — it never touches the backup.
 */
export async function applyFarolModelConfigBlock(
  configPath: string,
  spec: FarolModelProviderSpec,
): Promise<FarolModelConfigApplyResult> {
  const { contents, mode } = await readConfig(configPath);
  const insecure = insecurePermissionsRefusal(spec.delivery, mode);
  if (insecure) return insecure;

  const region = findMarkedRegion(
    contents,
    BLOCK_BEGIN_MARKER,
    BLOCK_END_MARKER,
  );
  const withoutBlock = withoutRegion(contents, region);
  const conflicts = findForeignProviderConflicts(
    withoutBlock,
    spec.providerName,
  );
  if (conflicts.length > 0) return { status: "conflict", conflicts };

  const desired = appendBlock(withoutBlock, buildProviderBlockBody(spec));
  if (desired === contents) return { status: "noop" };

  const effectiveMode = mode ?? defaultModeFor(spec.delivery);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(`${configPath}${BLOCK_BACKUP_SUFFIX}`, contents, {
    mode: 0o600,
  });
  await fs.writeFile(
    `${configPath}${BLOCK_BACKUP_SUFFIX}.mode`,
    String(effectiveMode),
    { mode: 0o600 },
  );
  await atomicReplace(configPath, desired, effectiveMode);
  return { status: "applied" };
}

/** Restores the exact bytes and mode `configPath` had before the last provider-block apply. */
export async function rollbackFarolModelConfigBlock(
  configPath: string,
): Promise<FarolModelConfigRollbackResult> {
  return restoreBackup(configPath, BLOCK_BACKUP_SUFFIX);
}

/**
 * Computes what consenting to select Farol as the default `model_provider`
 * would do — a separate, separately consented act from installing the
 * provider block itself (Decisions.md N04 addendum, item 2). A foreign
 * top-level `model_provider = …` line Farol did not write is a conflict.
 */
export async function previewFarolModelProviderSelection(
  configPath: string,
  providerName: string,
): Promise<FarolModelSelectionPreview> {
  const { contents } = await readConfig(configPath);
  const region = findMarkedRegion(
    contents,
    SELECTION_BEGIN_MARKER,
    SELECTION_END_MARKER,
  );
  const withoutSelection = withoutRegion(contents, region);
  const conflicts = findForeignSelectionConflicts(withoutSelection);
  if (conflicts.length > 0) return { status: "conflict", conflicts };

  const desired = insertBeforeFirstTable(
    withoutSelection,
    buildSelectionBody(providerName),
  );
  if (desired === contents) return { status: "noop" };
  return { status: "install", diff: unifiedDiff(contents, desired), desired };
}

/** Applies the provider selection. See `previewFarolModelProviderSelection`. */
export async function applyFarolModelProviderSelection(
  configPath: string,
  providerName: string,
): Promise<FarolModelSelectionApplyResult> {
  const { contents, mode } = await readConfig(configPath);
  const region = findMarkedRegion(
    contents,
    SELECTION_BEGIN_MARKER,
    SELECTION_END_MARKER,
  );
  const withoutSelection = withoutRegion(contents, region);
  const conflicts = findForeignSelectionConflicts(withoutSelection);
  if (conflicts.length > 0) return { status: "conflict", conflicts };

  const desired = insertBeforeFirstTable(
    withoutSelection,
    buildSelectionBody(providerName),
  );
  if (desired === contents) return { status: "noop" };

  const effectiveMode = mode ?? 0o644;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(`${configPath}${SELECTION_BACKUP_SUFFIX}`, contents, {
    mode: 0o600,
  });
  await fs.writeFile(
    `${configPath}${SELECTION_BACKUP_SUFFIX}.mode`,
    String(effectiveMode),
    { mode: 0o600 },
  );
  await atomicReplace(configPath, desired, effectiveMode);
  return { status: "applied" };
}

/** Restores the exact bytes and mode `configPath` had before the last selection apply. */
export async function rollbackFarolModelProviderSelection(
  configPath: string,
): Promise<FarolModelConfigRollbackResult> {
  return restoreBackup(configPath, SELECTION_BACKUP_SUFFIX);
}

async function restoreBackup(
  configPath: string,
  backupSuffix: string,
): Promise<FarolModelConfigRollbackResult> {
  const backupPath = `${configPath}${backupSuffix}`;
  const modePath = `${backupPath}.mode`;
  let backupContents: string;
  let backupMode: number;
  try {
    backupContents = await fs.readFile(backupPath, "utf8");
    backupMode = Number.parseInt(await fs.readFile(modePath, "utf8"), 10);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "no_backup" };
    }
    throw error;
  }
  if (backupContents.length === 0) {
    await fs.rm(configPath, { force: true });
  } else {
    await atomicReplace(configPath, backupContents, backupMode || 0o644);
  }
  await fs.rm(backupPath, { force: true });
  await fs.rm(modePath, { force: true });
  return { status: "restored" };
}
