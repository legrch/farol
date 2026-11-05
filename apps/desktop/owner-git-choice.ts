import { randomBytes } from "node:crypto";
import {
  accessSync,
  openSync,
  readFileSync,
  renameSync,
  closeSync,
  fsyncSync,
  lstatSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  constants,
} from "node:fs";
import path from "node:path";
import {
  captureOwnerGitEnvironment,
  type OwnerGitEnvironment,
} from "./owner-git-environment.ts";

type Preference = Readonly<{
  schema: 1;
  enabled: boolean;
  override: string | null;
}>;
const defaultPreference: Preference = {
  schema: 1,
  enabled: false,
  override: null,
};

export class OwnerGitChoice {
  private readonly file: string;
  private preference: Preference;
  private environment: OwnerGitEnvironment | null = null;
  private failure: string | null = null;
  private generation = 0;
  private pendingRestart = false;
  private uncertainCapture: string | null = null;

  constructor(
    userData: string,
    private readonly capturePath: typeof captureOwnerGitEnvironment = captureOwnerGitEnvironment,
  ) {
    this.file = path.join(userData, "owner-git-choice.json");
    this.preference = this.readPreference();
  }

  private readPreference(): Preference {
    try {
      const stat = lstatSync(this.file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o022
      )
        return defaultPreference;
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as Preference).schema !== 1 ||
        typeof (parsed as Preference).enabled !== "boolean" ||
        ((parsed as Preference).override !== null &&
          (typeof (parsed as Preference).override !== "string" ||
            !path.isAbsolute((parsed as Preference).override!) ||
            path.basename((parsed as Preference).override!) !== "git"))
      )
        return defaultPreference;
      return parsed as Preference;
    } catch {
      return defaultPreference;
    }
  }

  private save(next: Preference): void {
    const temporary = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, JSON.stringify(next));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.file);
      const dir = openSync(path.dirname(this.file), constants.O_RDONLY);
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
      this.preference = next;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch {
        /* rename completed or no file */
      }
    }
  }

  private selectedOverride(file: string): OwnerGitEnvironment {
    if (
      !path.isAbsolute(file) ||
      path.normalize(file) !== file ||
      path.basename(file) !== "git" ||
      /[\u0000-\u001f\u007f:]/u.test(file)
    )
      throw new Error("GIT_SHIM_UNSUPPORTED");
    return {
      path: path.dirname(file),
      source: "owner-override",
      capturedAt: new Date().toISOString(),
      generation: ++this.generation,
    };
  }

  async prepareStartup(): Promise<void> {
    if (!this.preference.enabled) return;
    // Startup never executes the account's shell. Older preferences with no
    // explicit path wait for a fresh owner click in Settings.
    if (!this.preference.override) {
      this.environment = null;
      this.failure = "GIT_CHOICE_UNAVAILABLE";
      return;
    }
    try {
      this.environment = this.selectedOverride(this.preference.override);
      this.failure = null;
    } catch (error) {
      this.environment = null;
      this.failure =
        error instanceof Error ? error.message : "SHELL_ENV_OUTCOME_UNKNOWN";
      // An invalid saved selection remains visible until the owner changes it.
    }
  }

  async refreshFromOwner(): Promise<void> {
    if (this.pendingRestart) throw new Error("GIT_RESTART_REQUIRED");
    if (this.uncertainCapture) throw new Error(this.uncertainCapture);
    const previous = this.environment;
    let captured: OwnerGitEnvironment;
    try {
      captured = await this.capturePath(++this.generation);
    } catch (error) {
      const code =
        error instanceof Error ? error.message : "SHELL_ENV_OUTCOME_UNKNOWN";
      this.failure = code;
      if (code === "SHELL_ENV_TIMEOUT" || code === "SHELL_ENV_OUTCOME_UNKNOWN")
        this.uncertainCapture = code;
      throw error;
    }
    this.environment = captured;
    const selected = this.status().gitAlias;
    if (!selected) {
      this.environment = previous;
      throw new Error("GIT_NOT_FOUND");
    }
    this.save({ schema: 1, enabled: true, override: selected });
    this.failure = null;
    this.pendingRestart = true;
  }

  selectOverrideFromOwner(file: string): void {
    this.environment = this.selectedOverride(file);
    this.save({ schema: 1, enabled: true, override: file });
    this.failure = null;
    this.pendingRestart = true;
  }

  launchEnvironment(): OwnerGitEnvironment | undefined {
    return this.environment ?? undefined;
  }

  status(): Readonly<{
    enabled: boolean;
    gitAlias: string | null;
    gitPhysical: string | null;
    source: string | null;
    failure: string | null;
    pendingRestart: boolean;
  }> {
    let gitAlias: string | null = null;
    let gitPhysical: string | null = null;
    for (const dir of this.environment?.path.split(":") ?? []) {
      const candidate = path.join(dir, "git");
      try {
        lstatSync(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        gitAlias = candidate;
        break;
      }
      gitAlias = candidate;
      try {
        const physical = realpathSync(candidate);
        const stat = statSync(physical);
        if (!stat.isFile()) {
          gitAlias = null;
          continue;
        }
        try {
          accessSync(physical, constants.X_OK);
        } catch (error) {
          if (
            ["EACCES", "EPERM"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          ) {
            gitAlias = null;
            continue;
          }
          throw error;
        }
        gitPhysical = physical;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          gitAlias = null;
          continue;
        }
        // An existing but unreadable first candidate is a refusal, never a
        // reason to display another Git farther down the PATH.
        break;
      }
    }
    return {
      enabled: this.preference.enabled,
      gitAlias,
      gitPhysical,
      source: this.environment?.source ?? null,
      failure: this.failure,
      pendingRestart: this.pendingRestart,
    };
  }
}
