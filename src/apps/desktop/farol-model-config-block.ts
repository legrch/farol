import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// The managed-config-block lifecycle for an ordinary Codex `config.toml`.
// See Decisions.md N04, item 3-4. This module never parses the file into a
// TOML document and re-serializes it — that would risk reformatting
// sections Farol did not write. Instead it does text surgery on one marked
// region, so every byte outside that region is untouched, by construction.

const BEGIN_MARKER = "# BEGIN FAROL MANAGED BLOCK — do not edit by hand";
const END_MARKER = "# END FAROL MANAGED BLOCK";
const BACKUP_SUFFIX = ".farol-backup";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

export type FarolModelProviderSpec = Readonly<{
  /** The `model_providers.<name>` table name Farol owns. */
  providerName: string;
  /** The `profiles.<name>` table name Farol owns, selecting the provider. */
  profileName: string;
  displayName: string;
  baseUrl: string;
  envKeyName: string;
  model: string;
  wireApi: "responses";
}>;

export type FarolModelConfigConflict = Readonly<{
  table: string;
  line: string;
}>;

export type FarolModelConfigPreview =
  | Readonly<{ status: "install" | "update"; diff: string; desired: string }>
  | Readonly<{ status: "noop" }>
  | Readonly<{
      status: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>;

export type FarolModelConfigApplyResult =
  | Readonly<{ status: "applied" | "noop" }>
  | Readonly<{
      status: "conflict";
      conflicts: readonly FarolModelConfigConflict[];
    }>;

export type FarolModelConfigRollbackResult =
  Readonly<{ status: "restored" }> | Readonly<{ status: "no_backup" }>;

function buildBlockBody(spec: FarolModelProviderSpec): string {
  const lines = [
    BEGIN_MARKER,
    `[model_providers.${spec.providerName}]`,
    `name = ${JSON.stringify(spec.displayName)}`,
    `base_url = ${JSON.stringify(spec.baseUrl)}`,
    `env_key = ${JSON.stringify(spec.envKeyName)}`,
    `wire_api = ${JSON.stringify(spec.wireApi)}`,
    "",
    `[profiles.${spec.profileName}]`,
    `model_provider = ${JSON.stringify(spec.providerName)}`,
    `model = ${JSON.stringify(spec.model)}`,
    END_MARKER,
  ];
  return lines.join("\n");
}

type MarkedRegion = Readonly<{ start: number; end: number; text: string }>;

/** Locates the single Farol-managed region, if present. */
function findManagedRegion(contents: string): MarkedRegion | undefined {
  const beginIndex = contents.indexOf(BEGIN_MARKER);
  if (beginIndex === -1) return undefined;
  const endMarkerIndex = contents.indexOf(END_MARKER, beginIndex);
  if (endMarkerIndex === -1) {
    throw new Error("FAROL_MODEL_CONFIG_BLOCK_MALFORMED");
  }
  const end = endMarkerIndex + END_MARKER.length;
  return { start: beginIndex, end, text: contents.slice(beginIndex, end) };
}

const TABLE_HEADER = /^\s*\[([^\]]+)\]\s*$/u;

function findForeignConflicts(
  contentsWithoutManagedBlock: string,
  spec: FarolModelProviderSpec,
): FarolModelConfigConflict[] {
  const watched = new Set([
    `model_providers.${spec.providerName}`,
    `profiles.${spec.profileName}`,
  ]);
  const conflicts: FarolModelConfigConflict[] = [];
  for (const line of contentsWithoutManagedBlock.split("\n")) {
    const match = TABLE_HEADER.exec(line);
    if (!match) continue;
    const table = (match[1] ?? "").trim();
    if (watched.has(table)) {
      conflicts.push({ table, line });
    }
  }
  return conflicts;
}

function withoutRegion(
  contents: string,
  region: MarkedRegion | undefined,
): string {
  if (!region) return contents;
  return contents.slice(0, region.start) + contents.slice(region.end);
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

function composeWithBlock(withoutBlock: string, block: string): string {
  const trimmed = withoutBlock.replace(/\s+$/u, "");
  if (trimmed.length === 0) return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}

/**
 * Computes what applying `spec` to `configPath` would do, without writing
 * anything. A foreign entry of the same name Farol did not write is a
 * conflict, reported and never overwritten.
 */
export async function previewFarolModelConfigBlock(
  configPath: string,
  spec: FarolModelProviderSpec,
): Promise<FarolModelConfigPreview> {
  const { contents } = await readConfig(configPath);
  const region = findManagedRegion(contents);
  const withoutBlock = withoutRegion(contents, region);
  const conflicts = findForeignConflicts(withoutBlock, spec);
  if (conflicts.length > 0) return { status: "conflict", conflicts };

  const desiredBlock = buildBlockBody(spec);
  const desired = composeWithBlock(withoutBlock, desiredBlock);
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
 * mode, and keeps exactly one backup that `rollbackFarolModelConfigBlock`
 * restores. A second apply of the same desired state is a no-op — it never
 * touches the backup, so rollback still restores the state from before the
 * first apply.
 */
export async function applyFarolModelConfigBlock(
  configPath: string,
  spec: FarolModelProviderSpec,
): Promise<FarolModelConfigApplyResult> {
  const { contents, mode } = await readConfig(configPath);
  const region = findManagedRegion(contents);
  const withoutBlock = withoutRegion(contents, region);
  const conflicts = findForeignConflicts(withoutBlock, spec);
  if (conflicts.length > 0) return { status: "conflict", conflicts };

  const desiredBlock = buildBlockBody(spec);
  const desired = composeWithBlock(withoutBlock, desiredBlock);
  if (desired === contents) return { status: "noop" };

  const effectiveMode = mode ?? 0o644;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(`${configPath}${BACKUP_SUFFIX}`, contents, {
    mode: 0o600,
  });
  await fs.writeFile(
    `${configPath}${BACKUP_SUFFIX}.mode`,
    String(effectiveMode),
    {
      mode: 0o600,
    },
  );
  await atomicReplace(configPath, desired, effectiveMode);
  return { status: "applied" };
}

/** Restores the exact bytes and mode `configPath` had before the last apply. */
export async function rollbackFarolModelConfigBlock(
  configPath: string,
): Promise<FarolModelConfigRollbackResult> {
  const backupPath = `${configPath}${BACKUP_SUFFIX}`;
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
