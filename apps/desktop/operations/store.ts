import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  OperationEntrySchema,
  type OperationMetadata,
  type OperationEntry,
  type OperationsRecorder,
  type OperationsSnapshot,
} from "../renderer/operations-contract";

export const operationsLimits = {
  days: 30,
  bytes: 8 * 1024 * 1024,
  segmentBytes: 64 * 1024,
  entries: 20000,
} as const;
const segmentName = /^[0-9]{13}-[a-f0-9-]{36}\.jsonl$/u;
/** Appends immutable metadata, with per-writer segments to avoid cross-process
 * append/pruning races. Retention deletes complete segments, never edits rows.
 * A reader validates every line and never trusts an on-disk content field. */
export class OperationsStore implements OperationsRecorder {
  private segment = "";
  private writeFailures = 0;
  constructor(
    readonly directory: string,
    private readonly now = Date.now,
    private readonly limits: {
      days: number;
      bytes: number;
      segmentBytes: number;
      entries: number;
    } = operationsLimits,
  ) {}
  private prepare(): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw Error("OPERATIONS_DIRECTORY_UNSAFE");
  }
  private segments() {
    return fs
      .readdirSync(this.directory)
      .filter((name) => segmentName.test(name))
      .sort();
  }
  private open(file: string, flags: number) {
    const fd = fs.openSync(
      file,
      flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      0o600,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600
      )
        throw Error("OPERATIONS_FILE_UNSAFE");
      return { fd, stat };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  setWorkspaceLabels(
    workspaces: readonly { workspaceId: string; label: string }[],
  ): void {
    try {
      this.prepare();
      const labels = Object.fromEntries(
        workspaces.slice(0, 128).map((w) => [w.workspaceId, w.label]),
      );
      const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify(labels), {
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(
        temporary,
        path.join(this.directory, "workspace-labels.json"),
      );
    } catch {
      this.writeFailures++;
    }
  }
  private workspaceLabel(workspace: string | undefined): string | undefined {
    if (!workspace) return undefined;
    let fd: number | undefined;
    try {
      const opened = this.open(
        path.join(this.directory, "workspace-labels.json"),
        fs.constants.O_RDONLY,
      );
      fd = opened.fd;
      if (opened.stat.size > 65536) return workspace;
      const labels: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (
        labels &&
        typeof labels === "object" &&
        Object.hasOwn(labels, workspace)
      ) {
        const label: unknown = (labels as Record<string, unknown>)[workspace];
        if (
          typeof label === "string" &&
          label.length <= 160 &&
          !/[\x00-\x1f\x7f]/u.test(label)
        )
          return label;
      }
    } catch {
      /* An absent label never grants access or changes an outcome. */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return workspace;
  }
  begin(metadata: OperationMetadata) {
    const id = randomUUID();
    this.append(metadata, "pending", null, 0, { id, phase: "started" });
    let observed = false;
    return (
      outcome: OperationEntry["outcome"],
      code: string | null,
      durationMs: number,
    ) => {
      if (observed) return;
      observed = true;
      this.append(metadata, outcome, code, durationMs, {
        id,
        phase: "observed",
      });
    };
  }
  record(
    metadata: OperationMetadata,
    outcome: OperationEntry["outcome"],
    code: string | null,
    durationMs: number,
  ): void {
    this.append(metadata, outcome, code, durationMs);
  }
  private append(
    metadata: OperationMetadata,
    outcome: OperationEntry["outcome"],
    code: string | null,
    durationMs: number,
    lifecycle?: NonNullable<OperationEntry["lifecycle"]>,
  ): void {
    try {
      const workspace = this.workspaceLabel(metadata.target.workspace);
      const entry = OperationEntrySchema.parse({
        ...metadata,
        ...(lifecycle ? { lifecycle } : {}),
        target: { ...metadata.target, ...(workspace ? { workspace } : {}) },
        id: randomUUID(),
        at: this.now(),
        outcome,
        code,
        durationMs: Math.max(0, Math.round(durationMs)),
      });
      this.prepare();
      if (
        !this.segment ||
        !fs.existsSync(path.join(this.directory, this.segment)) ||
        fs.lstatSync(path.join(this.directory, this.segment)).size >=
          this.limits.segmentBytes
      )
        this.segment = `${String(this.now()).padStart(13, "0")}-${randomUUID()}.jsonl`;
      const { fd, stat } = this.open(
        path.join(this.directory, this.segment),
        fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT,
      );
      try {
        if (stat.size > 0) {
          const tail = Buffer.alloc(1);
          fs.readSync(fd, tail, 0, 1, stat.size - 1);
          if (tail[0] !== 10) fs.writeSync(fd, "\n");
        }
        fs.writeSync(fd, JSON.stringify(entry) + "\n");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.prune();
    } catch {
      this.writeFailures++;
    }
  }
  private prune(): void {
    const files = this.segments();
    let bytes = 0,
      entries = 0;
    for (const name of files.reverse()) {
      const file = path.join(this.directory, name);
      const stat = fs.lstatSync(file);
      // Whole segments only. Symlinks/foreign entries are never followed or removed.
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.())
        continue;
      const expired =
        Number(name.slice(0, 13)) < this.now() - this.limits.days * 86400000;
      bytes += stat.size;
      const count =
        stat.size > this.limits.segmentBytes + 16384
          ? this.limits.entries
          : fs.readFileSync(file, "utf8").split("\n").length - 1;
      entries += count;
      if (
        expired ||
        bytes > this.limits.bytes ||
        entries > this.limits.entries
      ) {
        fs.unlinkSync(file);
        if (name === this.segment) this.segment = "";
      }
    }
  }
  snapshot(): OperationsSnapshot {
    let corruptLines = 0;
    const entries: OperationEntry[] = [];
    try {
      this.prepare();
      this.prune();
      for (const name of this.segments()) {
        let fd: number | undefined;
        try {
          const opened = this.open(
            path.join(this.directory, name),
            fs.constants.O_RDONLY,
          );
          fd = opened.fd;
          if (opened.stat.size > this.limits.segmentBytes + 16384) {
            corruptLines++;
            continue;
          }
          for (const line of fs.readFileSync(fd, "utf8").split("\n")) {
            if (!line) continue;
            try {
              const parsed = OperationEntrySchema.safeParse(JSON.parse(line));
              if (parsed.success) entries.push(parsed.data);
              else corruptLines++;
            } catch {
              corruptLines++;
            }
          }
        } catch {
          corruptLines++;
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      }
    } catch {
      return {
        entries: [],
        corruptLines: corruptLines + 1,
        writeFailures: this.writeFailures,
      };
    }
    const observed = new Set(
      entries
        .filter((entry) => entry.lifecycle?.phase === "observed")
        .map((entry) => entry.lifecycle!.id),
    );
    return {
      // A started observation remains immutable on disk. It is visible while
      // unmatched; a separately appended observation supplies the actual result.
      // Explicit pending/unknown results are never replaced by later read-backs.
      entries: entries
        .filter(
          (entry) =>
            entry.lifecycle?.phase !== "started" ||
            !observed.has(entry.lifecycle.id),
        )
        .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
        .slice(-this.limits.entries),
      corruptLines,
      writeFailures: this.writeFailures,
    };
  }
}
