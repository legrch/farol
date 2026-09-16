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

const chatGptObservationSchema = z.discriminatedUnion("state", [
  verificationInputSchema.extend({ state: z.literal("authenticated") }),
  z.strictObject({ state: z.literal("signed_out") }),
  z.strictObject({ state: z.literal("unreachable") }),
  z.strictObject({ state: z.literal("unsupported") }),
  z.strictObject({ state: z.literal("outcome_unknown") }),
]);

const codexHostInputSchema = z.strictObject({
  executablePath: z.string(),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u),
  protocol: z.literal("codex-app-server/v2"),
  schemaSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
});

const codexHostFailureSchema = z.enum(["unreachable", "unsupported"]);

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
    nativeHosts: { generation: 1, codex: null },
    setup: {
      journey: { currentStep: "chatgpt", dismissed: false },
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

  async renameComputer(input: unknown): Promise<MutationResult> {
    const parsed = z.string().trim().min(1).max(80).safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      computer: {
        ...settings.computer,
        generation: settings.computer.generation + 1,
        name: parsed.data,
      },
      setup: {
        ...settings.setup,
        computer: {
          ...settings.setup.computer,
          reachable: "unknown",
          verified: null,
          needsAction:
            settings.computer.workspaces.length > 0
              ? "Verify read access after changing This Mac."
              : "Add a read-only workspace.",
          outcomeUnknown: false,
        },
      },
    }));
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

  async updateWorkspaceExclusions(
    workspaceId: string,
    input: unknown,
  ): Promise<MutationResult> {
    const parsed = z.array(z.string()).max(32).safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    if (
      !this.current.computer.workspaces.some(
        (workspace) => workspace.workspaceId === workspaceId,
      )
    ) {
      return this.failure("WORKSPACE_NOT_FOUND");
    }
    return this.mutate((settings) => {
      const current = settings.computer.workspaces.find(
        (workspace) => workspace.workspaceId === workspaceId,
      );
      if (
        current &&
        JSON.stringify(current.excludedPaths) === JSON.stringify(parsed.data)
      ) {
        return settings;
      }
      return {
        ...settings,
        revision: settings.revision + 1,
        computer: {
          ...settings.computer,
          generation: settings.computer.generation + 1,
          workspaces: settings.computer.workspaces.map((workspace) =>
            workspace.workspaceId === workspaceId
              ? { ...workspace, excludedPaths: parsed.data }
              : workspace,
          ),
        },
        setup: {
          ...settings.setup,
          computer: {
            ...settings.setup.computer,
            configured: true,
            reachable: "unknown" as const,
            verified: null,
            needsAction: "Verify read access after changing exclusions.",
            unavailable: null,
            outcomeUnknown: false,
          },
        },
      };
    });
  }

  async updateWorkspaceAccess(
    workspaceId: string,
    access: "read" | "write",
  ): Promise<MutationResult> {
    if (this.current === null) return this.failure("SETTINGS_UNAVAILABLE");
    const current = this.current.computer.workspaces.find(
      (workspace) => workspace.workspaceId === workspaceId,
    );
    if (!current) return this.failure("WORKSPACE_NOT_FOUND");
    if (current.access === access) {
      return { ok: true, snapshot: this.snapshot() };
    }
    return this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      computer: {
        ...settings.computer,
        generation: settings.computer.generation + 1,
        workspaces: settings.computer.workspaces.map((workspace) =>
          workspace.workspaceId === workspaceId
            ? { ...workspace, access }
            : workspace,
        ),
      },
      setup: {
        ...settings.setup,
        computer: {
          ...settings.setup.computer,
          configured: true,
          reachable: "unknown",
          verified: null,
          needsAction: `Verify ${access} access after changing workspace access.`,
          unavailable: null,
          outcomeUnknown: false,
        },
      },
    }));
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

  async recordComputerMutationOutcomeUnknown(
    workspaceId: string,
  ): Promise<MutationResult> {
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
          reachable: "unknown",
          verified: null,
          needsAction:
            "Inspect the selected file, then verify workspace access again.",
          unavailable: null,
          outcomeUnknown: true,
        },
      },
    }));
  }

  async recordChatGptObservation(input: unknown): Promise<MutationResult> {
    const parsed = chatGptObservationSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => {
      const revision = settings.revision + 1;
      const common = {
        ...settings.setup.chatgpt,
        visited: true,
        skipped: false,
        outcomeUnknown: false,
      };
      let chatgpt: ProductSettings["setup"]["chatgpt"];
      switch (parsed.data.state) {
        case "authenticated":
          chatgpt = {
            ...common,
            configured: true,
            reachable: "reachable",
            verified: {
              profile: parsed.data.profile,
              configRevision: 1,
              workspaceId: null,
              runtimeGeneration: parsed.data.runtimeGeneration,
              buildId: parsed.data.buildId,
              protocol: parsed.data.protocol,
              verifiedAt: this.now(),
            },
            needsAction: null,
            unavailable: null,
          };
          break;
        case "signed_out":
          chatgpt = {
            ...common,
            configured: false,
            reachable: "reachable",
            verified: null,
            needsAction: "Sign in to ChatGPT in the isolated Next window.",
            unavailable: null,
          };
          break;
        case "unreachable":
          chatgpt = {
            ...common,
            configured: false,
            reachable: "unreachable",
            verified: null,
            needsAction:
              "Open the isolated ChatGPT window and check network access.",
            unavailable: null,
          };
          break;
        case "unsupported":
          chatgpt = {
            ...common,
            configured: false,
            reachable: "reachable",
            verified: null,
            needsAction: null,
            unavailable:
              "The ChatGPT page loaded, but this build could not verify its composer.",
          };
          break;
        case "outcome_unknown":
          chatgpt = {
            ...common,
            configured: true,
            reachable: "unknown",
            verified: null,
            needsAction:
              "Inspect the isolated ChatGPT window before starting another task.",
            unavailable: null,
            outcomeUnknown: true,
          };
          break;
      }
      return {
        ...settings,
        revision,
        setup: { ...settings.setup, chatgpt },
      };
    });
  }

  async recordCodexHost(input: unknown): Promise<MutationResult> {
    const parsed = codexHostInputSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => {
      const generation = settings.nativeHosts.generation + 1;
      const verifiedAt = this.now();
      return {
        ...settings,
        revision: settings.revision + 1,
        nativeHosts: {
          generation,
          codex: {
            executablePath: parsed.data.executablePath,
            executableSha256: parsed.data.executableSha256,
            version: parsed.data.version,
            protocol: parsed.data.protocol,
            schemaSha256: parsed.data.schemaSha256,
            verifiedAt,
          },
        },
        setup: {
          ...settings.setup,
          hosts: {
            ...settings.setup.hosts,
            visited: true,
            skipped: false,
            configured: true,
            reachable: "reachable",
            verified: {
              profile: "codex.app-server/2",
              configRevision: generation,
              workspaceId: null,
              runtimeGeneration: parsed.data.executableSha256,
              buildId: parsed.data.buildId,
              protocol: parsed.data.protocol,
              verifiedAt,
            },
            needsAction: null,
            unavailable: null,
            outcomeUnknown: false,
          },
        },
      };
    });
  }

  async recordCodexHostFailure(input: unknown): Promise<MutationResult> {
    const parsed = codexHostFailureSchema.safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      setup: {
        ...settings.setup,
        hosts: {
          ...settings.setup.hosts,
          visited: true,
          skipped: false,
          configured: settings.nativeHosts.codex !== null,
          reachable:
            parsed.data === "unreachable" ? "unreachable" : "reachable",
          verified: null,
          needsAction:
            parsed.data === "unreachable"
              ? "Choose the Codex executable again or restore it, then recheck."
              : null,
          unavailable:
            parsed.data === "unsupported"
              ? "This Codex build does not expose the required bounded App Server contract."
              : null,
          outcomeUnknown: false,
        },
      },
    }));
  }

  async clearCodexHost(): Promise<MutationResult> {
    return this.mutate((settings) => {
      if (settings.nativeHosts.codex === null) return settings;
      return {
        ...settings,
        revision: settings.revision + 1,
        nativeHosts: {
          generation: settings.nativeHosts.generation + 1,
          codex: null,
        },
        setup: {
          ...settings.setup,
          hosts: {
            ...settings.setup.hosts,
            visited: true,
            skipped: false,
            configured: false,
            reachable: "unknown",
            verified: null,
            needsAction: "Choose a Codex executable to verify.",
            unavailable: null,
            outcomeUnknown: false,
          },
        },
      };
    });
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

  async setSetupJourney(input: unknown): Promise<MutationResult> {
    const parsed = z
      .strictObject({
        currentStep: SetupStepIdSchema,
        dismissed: z.boolean(),
      })
      .safeParse(input);
    if (!parsed.success) return this.failure("SETTINGS_INPUT_INVALID");
    return this.mutate((settings) => ({
      ...settings,
      revision: settings.revision + 1,
      setup: {
        ...settings.setup,
        [settings.setup.journey.currentStep]: {
          ...settings.setup[settings.setup.journey.currentStep],
          visited: true,
        },
        journey: parsed.data,
        [parsed.data.currentStep]: {
          ...settings.setup[parsed.data.currentStep],
          visited: true,
        },
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
