import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ProductConfigurationSnapshotSchema,
  ProductGeneralSettingsSchema,
  ProductSettingsSchema,
  SetupStepIdSchema,
  type ProductConfigurationSnapshot,
  type ProductSettings,
  type SetupStepId,
} from "../../pkg/product-settings/contract";

const FILE_NAME = "product-settings.json";
const MAXIMUM_BYTES = 256 * 1024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

type StoreHooks = Readonly<{
  beforeCommit?: () => Promise<void>;
}>;

export type ProductSettingsStoreOptions = Readonly<{ root: string }>;

export type ProductConfigurationDependencies = Readonly<{
  now?: () => string;
  id?: () => string;
}>;

type MutationResult = Readonly<
  | {
      ok: true;
      snapshot: ProductConfigurationSnapshot;
    }
  | {
      ok: false;
      error:
        | "SETTINGS_UNAVAILABLE"
        | "SETTINGS_INPUT_INVALID"
        | "SETTINGS_WRITE_FAILED"
        | "WORKSPACE_NOT_FOUND";
      snapshot: ProductConfigurationSnapshot;
    }
>;

const workspaceInputSchema = z.strictObject({
  root: z.string(),
  label: z.string().trim().min(1).max(120),
});

const verificationInputSchema = z.strictObject({
  profile: z.string().min(1).max(160),
  runtimeGeneration: z.string().min(1).max(160),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
  protocol: z.string().min(1).max(160),
});

function settingsError(error: unknown): ProductConfigurationSnapshot {
  const message = error instanceof Error ? error.message : "";
  if (message === "SETTINGS_CORRUPT") {
    return { status: "error", error: "SETTINGS_CORRUPT" };
  }
  if (message === "SETTINGS_UNSAFE") {
    return { status: "error", error: "SETTINGS_UNSAFE" };
  }
  return { status: "error", error: "SETTINGS_READ_FAILED" };
}

function readiness(needsAction: string): ProductSettings["setup"][SetupStepId] {
  return {
    visited: false,
    skipped: false,
    configured: false,
    reachable: "unknown",
    verified: null,
    needsAction,
    unavailable: null,
    outcomeUnknown: false,
  };
}

function defaultSettings(id: () => string): ProductSettings {
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: id(),
      generation: 1,
      name: "This Mac",
      workspaces: [],
    },
    setup: {
      chatgpt: readiness("Sign in to the isolated Farol Next browser."),
      computer: readiness("Add a read-only workspace."),
      connect: readiness("Configure the Next-only Computer connection."),
      hosts: readiness("Review one scoped native host integration."),
      verify: readiness("Run each configured capability check."),
    },
  });
}

export class ProductSettingsStore {
  constructor(
    private readonly options: ProductSettingsStoreOptions,
    private readonly hooks: StoreHooks = {},
  ) {
    if (!path.isAbsolute(options.root)) {
      throw new Error("SETTINGS_STATE_ROOT_NOT_ABSOLUTE");
    }
  }

  async load(): Promise<ProductSettings | null> {
    await this.ensureRoot();
    const target = path.join(this.options.root, FILE_NAME);
    let handle;
    try {
      handle = await fs.open(
        target,
        fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error("SETTINGS_UNSAFE");
      }
      throw error;
    }
    try {
      const info = await handle.stat();
      this.assertPrivateFile(info);
      if (info.size > MAXIMUM_BYTES) throw new Error("SETTINGS_CORRUPT");
      const parsed = ProductSettingsSchema.safeParse(
        JSON.parse(await handle.readFile("utf8")) as unknown,
      );
      if (!parsed.success) throw new Error("SETTINGS_CORRUPT");
      return parsed.data;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("SETTINGS_CORRUPT");
      throw error;
    } finally {
      await handle.close();
    }
  }

  async save(settings: ProductSettings): Promise<void> {
    const validated = ProductSettingsSchema.parse(settings);
    await this.ensureRoot();
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAXIMUM_BYTES) {
      throw new Error("SETTINGS_TOO_LARGE");
    }
    const target = path.join(this.options.root, FILE_NAME);
    await this.assertReplaceableTarget(target);
    const temporary = path.join(
      this.options.root,
      `.${FILE_NAME}.${randomUUID()}.tmp`,
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
        0o600,
      );
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.hooks.beforeCommit?.();
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
      await this.syncRoot();
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.options.root);
    const effectiveUser = process.geteuid?.();
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (effectiveUser !== undefined && info.uid !== effectiveUser)
    ) {
      throw new Error("SETTINGS_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await fs.chmod(this.options.root, 0o700);
  }

  private assertPrivateFile(info: Stats): void {
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (effectiveUser !== undefined && info.uid !== effectiveUser) ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error("SETTINGS_UNSAFE");
    }
  }

  private async assertReplaceableTarget(target: string): Promise<void> {
    try {
      this.assertPrivateFile(await fs.lstat(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async syncRoot(): Promise<void> {
    const directory = await fs.open(
      this.options.root,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

export class ProductConfigurationService {
  private readonly now: () => string;
  private readonly id: () => string;
  private current: ProductSettings | null = null;
  private currentError: ProductConfigurationSnapshot | null = null;

  constructor(
    private readonly store: ProductSettingsStore,
    dependencies: ProductConfigurationDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.id = dependencies.id ?? randomUUID;
  }

  async initialize(): Promise<void> {
    try {
      let loaded = await this.store.load();
      if (loaded === null) {
        await this.store.save(defaultSettings(this.id));
        loaded = await this.store.load();
      }
      if (loaded === null) throw new Error("SETTINGS_READ_BACK_FAILED");
      this.current = loaded;
      this.currentError = null;
    } catch (error) {
      this.current = null;
      this.currentError = settingsError(error);
    }
  }

  snapshot(): ProductConfigurationSnapshot {
    const snapshot =
      this.current === null
        ? (this.currentError ?? {
            status: "error" as const,
            error: "SETTINGS_READ_FAILED" as const,
          })
        : { status: "ready" as const, settings: structuredClone(this.current) };
    return ProductConfigurationSnapshotSchema.parse(snapshot);
  }

  async updateGeneral(input: unknown): Promise<MutationResult> {
    const parsed = ProductGeneralSettingsSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      general: parsed.data,
    }));
  }

  async addReadonlyWorkspace(input: unknown): Promise<MutationResult> {
    const parsed = workspaceInputSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => {
      if (
        settings.computer.workspaces.some(
          (workspace) => workspace.root === parsed.data.root,
        )
      ) {
        return settings;
      }
      const workspaces = [
        ...settings.computer.workspaces,
        {
          workspaceId: this.id(),
          root: parsed.data.root,
          label: parsed.data.label,
          access: "read" as const,
          excludedPaths: [],
        },
      ];
      return {
        ...settings,
        revision: settings.revision + 1,
        computer: {
          ...settings.computer,
          generation: settings.computer.generation + 1,
          workspaces,
        },
        setup: {
          ...settings.setup,
          computer: {
            ...settings.setup.computer,
            configured: true,
            reachable: "unknown" as const,
            verified: null,
            needsAction: "Verify read access to this workspace.",
            outcomeUnknown: false,
          },
        },
      };
    });
  }

  async removeWorkspace(workspaceId: string): Promise<MutationResult> {
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    if (
      !this.current.computer.workspaces.some(
        (workspace) => workspace.workspaceId === workspaceId,
      )
    ) {
      return this.failure("WORKSPACE_NOT_FOUND");
    }
    return this.mutate((settings) => {
      const workspaces = settings.computer.workspaces.filter(
        (workspace) => workspace.workspaceId !== workspaceId,
      );
      const configured = workspaces.length > 0;
      return {
        ...settings,
        revision: settings.revision + 1,
        computer: {
          ...settings.computer,
          generation: settings.computer.generation + 1,
          workspaces,
        },
        setup: {
          ...settings.setup,
          computer: {
            ...settings.setup.computer,
            configured,
            reachable: "unknown" as const,
            verified: null,
            needsAction: configured
              ? "Verify read access to an approved workspace."
              : "Add a read-only workspace.",
            outcomeUnknown: false,
          },
        },
      };
    });
  }

  async recordComputerVerification(
    workspaceId: string,
    input: unknown,
  ): Promise<MutationResult> {
    const parsed = verificationInputSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    if (
      !this.current.computer.workspaces.some(
        (workspace) => workspace.workspaceId === workspaceId,
      )
    ) {
      return this.failure("WORKSPACE_NOT_FOUND");
    }
    return this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      setup: {
        ...settings.setup,
        computer: {
          ...settings.setup.computer,
          configured: true,
          reachable: "reachable",
          verified: {
            ...parsed.data,
            configRevision: settings.computer.generation,
            workspaceId,
            verifiedAt: this.now(),
          },
          needsAction: null,
          unavailable: null,
          outcomeUnknown: false,
        },
      },
    }));
  }

  async markSetupVisited(step: unknown): Promise<MutationResult> {
    const parsed = SetupStepIdSchema.safeParse(step);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      setup: {
        ...settings.setup,
        [parsed.data]: { ...settings.setup[parsed.data], visited: true },
      },
    }));
  }

  private async mutate(
    transform: (settings: ProductSettings) => ProductSettings,
  ): Promise<MutationResult> {
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    const before = structuredClone(this.current);
    let candidate: ProductSettings;
    try {
      candidate = ProductSettingsSchema.parse(transform(before));
    } catch {
      return this.failure("SETTINGS_INPUT_INVALID");
    }
    try {
      await this.store.save(candidate);
      const readBack = await this.store.load();
      if (
        readBack === null ||
        JSON.stringify(readBack) !== JSON.stringify(candidate)
      ) {
        throw new Error("SETTINGS_READ_BACK_FAILED");
      }
      this.current = readBack;
      this.currentError = null;
      return { ok: true, snapshot: this.snapshot() };
    } catch {
      this.current = before;
      return this.failure("SETTINGS_WRITE_FAILED");
    }
  }

  private failure(
    error: Extract<MutationResult, { ok: false }>["error"],
  ): MutationResult {
    return { ok: false, error, snapshot: this.snapshot() };
  }
}
